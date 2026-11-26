#!/usr/bin/env node
/*
 * Shopee order report
 *
 * Opens a real browser window, lets you log in to Shopee yourself, then walks
 * your purchase history and writes a monthly report:
 *   - every order with its items and total
 *   - orders paid in the same checkout grouped together
 *   - payment method, and the masked card (e.g. VISA *1234) when Shopee shows it
 *
 * The script never sees your password: you type it into Shopee's own page.
 * It only reads the pages/API responses that Shopee's own website loads.
 *
 * Usage:  node shopee-report.js [--since 2025-01] [--out output] [--report-only]
 *         node shopee-report.js --help
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- options

const HELP = `
Usage: node shopee-report.js [options]

  --since YYYY-MM        only orders from this month onwards (default: everything)
  --out DIR              where to write the report and cache (default: ./output)
  --profile DIR          browser profile folder that keeps you logged in (default: ./.shopee-profile)
  --base-url URL         Shopee site (default: https://shopee.co.th)
  --report-only          don't open the browser; rebuild the report from the cache
  --refresh              re-download orders that are already in the cache
  --include-cancelled    count cancelled orders in the totals
  --group-window SEC     orders placed within SEC seconds with the same payment are
                         treated as one checkout when Shopee gives no checkout id (default: 120)
  --max-orders N         stop after N orders (useful for a quick test)
  --delay MS             pause between order pages (default: 1200)
  --headless             run the browser hidden (only works if you are already logged in)
`;

function parseArgs(argv) {
  const o = {
    since: null, out: 'output', profile: '.shopee-profile', baseUrl: 'https://shopee.co.th',
    reportOnly: false, refresh: false, includeCancelled: false, groupWindow: 120,
    maxOrders: Infinity, delay: 1200, headless: false, loginTimeoutMin: 15,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) die(`missing value for ${a}`); return v; };
    switch (a) {
      case '--since': o.since = val(); if (!/^\d{4}-\d{2}$/.test(o.since)) die('--since must look like 2025-01'); break;
      case '--out': o.out = val(); break;
      case '--profile': o.profile = val(); break;
      case '--base-url': o.baseUrl = val().replace(/\/+$/, ''); break;
      case '--report-only': o.reportOnly = true; break;
      case '--refresh': o.refresh = true; break;
      case '--include-cancelled': o.includeCancelled = true; break;
      case '--group-window': o.groupWindow = Number(val()); break;
      case '--max-orders': o.maxOrders = Number(val()); break;
      case '--delay': o.delay = Number(val()); break;
      case '--headless': o.headless = true; break;
      case '--login-timeout': o.loginTimeoutMin = Number(val()); break;
      case '-h': case '--help': console.log(HELP); process.exit(0);
      default: die(`unknown option ${a}\n${HELP}`);
    }
  }
  return o;
}

function die(msg) { console.error(msg); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- generic JSON helpers
// Shopee's internal API is undocumented and changes, so parsing is deliberately
// structural: look for well-known key names anywhere in the response instead of
// relying on one exact path.

function walk(node, fn, keyPath = []) {
  if (node && typeof node === 'object') {
    fn(node, keyPath);
    for (const [k, v] of Object.entries(node)) walk(v, fn, keyPath.concat(k));
  }
}

function findValues(node, keyRe, accept = () => true) {
  const out = [];
  walk(node, (obj, kp) => {
    for (const [k, v] of Object.entries(obj)) {
      if (keyRe.test(k) && (v === null || typeof v !== 'object') && accept(v, k, kp)) out.push({ k, v, kp });
    }
  });
  return out;
}

const NOW_S = Date.now() / 1000;
const isTs = (v) => typeof v === 'number' && v > 1.3e9 && v < NOW_S + 86400 * 30;
const toNum = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
const PRICE_SCALE = 100000; // Shopee v4 API stores money as baht * 100000

function idOf(v) {
  if (typeof v === 'number' && v > 0) return String(v);
  if (typeof v === 'string' && /^\d{5,}$/.test(v)) return v;
  return null;
}

// ---------------------------------------------------------------- list parsing

/** Every order id mentioned in an order-list response, newest first, with what the card shows. */
function ordersFromList(json) {
  const found = new Map();
  walk(json, (obj) => {
    const id = idOf(obj.order_id);
    if (!id) return;
    const info = found.get(id) || { orderId: id };
    const co = idOf(obj.checkout_id);
    if (co) info.checkoutId = co;
    const shop = obj.shop_info && (obj.shop_info.shop_name || obj.shop_info.username);
    if (shop) info.shopName = shop;
    if (typeof obj.final_total === 'number') info.listTotal = obj.final_total / PRICE_SCALE;
    const items = itemsFrom(obj);
    if (items.length) info.listItems = items;
    found.set(id, info);
  });
  // Checkout cards that hold several orders: the checkout id sits on the parent.
  walk(json, (obj) => {
    const co = idOf(obj.checkout_id);
    if (!co) return;
    walk(obj, (inner) => {
      const id = idOf(inner.order_id);
      if (id && found.has(id) && !found.get(id).checkoutId) found.get(id).checkoutId = co;
    });
  });
  return [...found.values()];
}

function itemsFrom(node) {
  const items = [];
  const seen = new Set();
  walk(node, (obj) => {
    if (typeof obj.name !== 'string' || !obj.name.trim()) return;
    const hasQty = typeof obj.amount === 'number' || typeof obj.quantity === 'number';
    const hasPrice = typeof obj.item_price === 'number' || typeof obj.order_price === 'number' || typeof obj.price === 'number';
    if (!hasQty || !hasPrice) return;
    const qty = obj.amount ?? obj.quantity ?? 1;
    let unit = null;
    if (typeof obj.item_price === 'number') unit = obj.item_price / PRICE_SCALE;
    else if (typeof obj.order_price === 'number') unit = obj.order_price / PRICE_SCALE / (qty || 1);
    else unit = obj.price / PRICE_SCALE;
    const key = [obj.item_id, obj.model_id, obj.name, obj.model_name, qty].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ name: obj.name.trim(), variant: (obj.model_name || '').trim(), qty, unitPrice: unit });
  });
  return items;
}

// ---------------------------------------------------------------- detail parsing

const CARD_RE = /(visa|master\s?card|jcb|amex|american express|unionpay|ttb|kbank|scb|ktc|krungsri|uob|citi|bangkok bank|กสิกร|ไทยพาณิชย์|กรุงเทพ|กรุงศรี|กรุงไทย)?[^\d*\n]{0,15}(?:[*xX•·]{2,}[\s-]*){1,4}(\d{4})\b/gi;
const BRAND_RE = /\b(visa|master\s?card|jcb|amex|american express|unionpay)\b/i;

function cardFrom(texts) {
  for (const t of texts) {
    if (!t) continue;
    CARD_RE.lastIndex = 0;
    let m;
    while ((m = CARD_RE.exec(t))) {
      const around = t.slice(Math.max(0, m.index - 40), m.index + m[0].length);
      const brand = (around.match(BRAND_RE) || [])[1];
      return `${brand ? brand.toUpperCase().replace(/\s/g, '') + ' ' : ''}*${m[2]}`;
    }
  }
  return null;
}

/** "label → value" pairs from Shopee's info rows (e.g. order time, payment method). */
function infoRows(json) {
  const rows = [];
  walk(json, (obj) => {
    const labelObj = obj.info_label || obj.label || obj.title;
    const valueObj = obj.info_value || obj.value || obj.content;
    if (!labelObj || valueObj === undefined) return;
    const label = typeof labelObj === 'string' ? labelObj : labelObj.text || labelObj.key || '';
    const value = valueObj && typeof valueObj === 'object' ? (valueObj.value ?? valueObj.text) : valueObj;
    if (label) rows.push({ label: String(label), value });
  });
  return rows;
}

const THAI_DATE_RE = /(\d{2})[-/](\d{2})[-/](\d{4})\s+(\d{2}):(\d{2})/;
function parseShownDate(s) {
  const m = s && s.match(THAI_DATE_RE);
  if (!m) return null;
  let year = Number(m[3]);
  if (year > 2400) year -= 543; // Buddhist era
  // Times on the page are Thai time (UTC+7).
  return Date.UTC(year, Number(m[2]) - 1, Number(m[1]), Number(m[4]) - 7, Number(m[5])) / 1000;
}

function textAfter(text, labels) {
  if (!text) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    for (const lab of labels) {
      if (lines[i].toLowerCase().startsWith(lab.toLowerCase())) {
        const rest = lines[i].slice(lab.length).replace(/^[\s:]+/, '');
        return rest || lines[i + 1] || null;
      }
    }
  }
  return null;
}

function parseOrder({ orderId, detail, domText, listInfo = {} }) {
  const data = (detail && (detail.data || detail)) || {};
  const rows = infoRows(data);
  const rowVal = (re) => { const r = rows.find((x) => re.test(x.label)); return r ? r.value : undefined; };

  // --- time
  let orderTime = null;
  const tsByKey = (re) => findValues(data, re, isTs).sort((a, b) => a.kp.length - b.kp.length)[0];
  const byRow = rowVal(/order_?time|เวลาที่สั่งซื้อ|order time/i);
  if (isTs(toNum(byRow))) orderTime = toNum(byRow);
  if (!orderTime) { const f = tsByKey(/^(create_time|order_time|ctime)$/); if (f) orderTime = f.v; }
  if (!orderTime) orderTime = parseShownDate(textAfter(domText, ['เวลาที่สั่งซื้อ', 'Order Time']));
  let payTime = null;
  const payRow = rowVal(/pay(ment)?_?time|เวลาชำระเงิน|payment time/i);
  if (isTs(toNum(payRow))) payTime = toNum(payRow);
  if (!payTime) { const f = tsByKey(/^(pay_time|paid_time|payment_time)$/); if (f) payTime = f.v; }
  if (!payTime) payTime = parseShownDate(textAfter(domText, ['เวลาชำระเงิน', 'Payment Time']));
  if (!orderTime) orderTime = payTime;
  if (!orderTime) {
    const all = findValues(data, /time/i, isTs).map((x) => x.v);
    if (all.length) orderTime = Math.min(...all);
  }

  // --- payment
  let payment = null;
  const pRow = rowVal(/payment_?method|วิธีการชำระเงิน|payment method/i);
  if (typeof pRow === 'string' && pRow.trim()) payment = pRow.trim();
  if (!payment) {
    const f = findValues(data, /^(payment_method_name|payment_channel_name|channel_name|payment_method_text|payment_method)$/,
      (v) => typeof v === 'string' && v.trim() && !/^\d+$/.test(v))[0];
    if (f) payment = f.v.trim();
  }
  if (!payment) payment = textAfter(domText, ['วิธีการชำระเงิน', 'Payment Method']);
  // Only look where payment info lives: a masked phone number elsewhere looks just like a masked card.
  const payPath = /payment|card|bank|channel/i;
  const card = cardFrom([
    ...findValues(data, /./, (v, k, kp) => typeof v === 'string' && [...kp, k].some((x) => payPath.test(x))).map((x) => x.v),
    paymentBlock(domText),
  ]);

  // --- money
  let total = null;
  const ft = findValues(data, /^final_total$/, (v) => typeof v === 'number').sort((a, b) => a.kp.length - b.kp.length)[0];
  if (ft) total = ft.v / PRICE_SCALE;
  if (total === null && typeof listInfo.listTotal === 'number') total = listInfo.listTotal;
  if (total === null) {
    const s = textAfter(domText, ['ยอดคำสั่งซื้อทั้งหมด', 'Order Total']);
    const m = s && s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    if (m) total = Number(m[1]);
  }

  // --- the rest
  const checkoutId = (findValues(data, /^checkout_id$/, (v) => !!idOf(v))[0] || {}).v || listInfo.checkoutId || null;
  const shopName = (findValues(data, /^(shop_name|username)$/, (v) => typeof v === 'string' && v)[0] || {}).v
    || listInfo.shopName || '';
  let items = itemsFrom(data);
  if (!items.length && listInfo.listItems) items = listInfo.listItems;
  const statusTexts = [];
  walk(data, (obj, kp) => {
    if (!kp.some((k) => /status/i.test(k)) || kp.some((k) => /button|action/i.test(k))) return;
    for (const v of Object.values(obj)) if (typeof v === 'string') statusTexts.push(v);
  });
  const head = (domText || '').slice(0, 1500);
  const cancelled = statusTexts.some((t) => /cancel|ยกเลิก/i.test(t))
    || /คำสั่งซื้อถูกยกเลิก|ยกเลิกแล้ว|order cancelled|\bcancelled\b/i.test(head);

  return {
    orderId: String(orderId),
    checkoutId: checkoutId ? String(checkoutId) : null,
    orderTime, payTime, shopName, items, total,
    payment: payment || null, card, cancelled,
  };
}

/** The part of the order page right after "Payment method", where the card is shown. */
function paymentBlock(text) {
  if (!text) return '';
  const i = text.search(/วิธีการชำระเงิน|payment method/i);
  return i < 0 ? '' : text.slice(i, i + 300);
}

// ---------------------------------------------------------------- grouping & dates

function groupOrders(orders, windowSec) {
  const groups = new Map();
  const loose = [];
  for (const o of orders) {
    if (o.checkoutId) {
      const k = `co:${o.checkoutId}`;
      if (!groups.has(k)) groups.set(k, { id: o.checkoutId, byCheckout: true, orders: [] });
      groups.get(k).orders.push(o);
    } else loose.push(o);
  }
  // No checkout id: orders created within a short window and paid the same way
  // were almost certainly one checkout.
  loose.sort((a, b) => (a.orderTime || 0) - (b.orderTime || 0));
  let cur = null;
  for (const o of loose) {
    const same = cur && o.orderTime && cur.lastTime && o.orderTime - cur.lastTime <= windowSec
      && (o.payment || '') === (cur.orders[0].payment || '') && (o.card || '') === (cur.orders[0].card || '')
      && o.cancelled === cur.orders[0].cancelled;
    if (!same) {
      cur = { id: o.orderId, byCheckout: false, orders: [] };
      groups.set(`t:${o.orderId}`, cur);
    }
    cur.orders.push(o);
    cur.lastTime = o.orderTime;
  }
  const list = [...groups.values()].map((g) => {
    g.orders.sort((a, b) => (a.orderTime || 0) - (b.orderTime || 0));
    const first = g.orders[0];
    return {
      id: g.id, byCheckout: g.byCheckout, orders: g.orders,
      time: Math.min(...g.orders.map((o) => o.orderTime || Infinity)),
      total: sum(g.orders.map((o) => o.total || 0)),
      payment: first.payment, card: first.card,
      cancelled: g.orders.every((o) => o.cancelled),
    };
  });
  return list.sort((a, b) => b.time - a.time);
}

const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
const TZ = 'Asia/Bangkok';
function monthKey(ts) {
  if (!ts || !isFinite(ts)) return 'unknown';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date(ts * 1000));
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}
function monthLabel(key) {
  if (key === 'unknown') return 'ไม่ทราบวันที่';
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('th-TH', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 15)));
}
function fmtTime(ts) {
  if (!ts || !isFinite(ts)) return '-';
  return new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
}
function isoTime(ts) {
  if (!ts || !isFinite(ts)) return '';
  return new Date((ts + 7 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16);
}
const baht = (n) => (n === null || n === undefined ? '-' : '฿' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const payLabel = (o) => [o.payment, o.card].filter(Boolean).join(' · ') || 'ไม่ทราบ';

// ---------------------------------------------------------------- report

function buildReport(orders, opt) {
  const groups = groupOrders(orders, opt.groupWindow);
  const months = new Map();
  for (const g of groups) {
    const k = monthKey(g.time);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(g);
  }
  const keys = [...months.keys()].sort().reverse();
  const counted = (g) => opt.includeCancelled || !g.cancelled;
  const monthSummary = keys.map((k) => {
    const gs = months.get(k);
    const byPay = new Map();
    for (const g of gs) for (const o of g.orders) {
      if (!opt.includeCancelled && o.cancelled) continue;
      const l = payLabel(o);
      byPay.set(l, sum([(byPay.get(l) || 0), o.total || 0]));
    }
    const live = gs.flatMap((g) => g.orders).filter((o) => opt.includeCancelled || !o.cancelled);
    return { key: k, groups: gs, total: sum(live.map((o) => o.total || 0)), orderCount: live.length, byPay };
  });
  return { groups, months: monthSummary, counted };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHtml(rep, opt) {
  const grand = sum(rep.months.map((m) => m.total));
  const monthRows = rep.months.map((m) => `<tr><td><a href="#m-${m.key}">${esc(monthLabel(m.key))}</a></td><td class="n">${m.orderCount}</td><td class="n">${baht(m.total)}</td></tr>`).join('');
  const sections = rep.months.map((m) => {
    const chips = [...m.byPay.entries()].sort((a, b) => b[1] - a[1])
      .map(([l, v]) => `<span class="chip">${esc(l)} <b>${baht(v)}</b></span>`).join('');
    const groups = m.groups.map((g) => renderGroup(g, opt)).join('');
    return `<section id="m-${m.key}"><h2>${esc(monthLabel(m.key))}<span class="mt">${baht(m.total)} · ${m.orderCount} คำสั่งซื้อ</span></h2>
<div class="chips">${chips}</div>${groups}</section>`;
  }).join('');
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shopee รายจ่ายรายเดือน</title><style>
:root{--bg:#f6f6f4;--card:#fff;--fg:#1d1d1b;--mute:#6b6b66;--line:#e4e3df;--acc:#ee4d2d;--accbg:#fdeeea;--x:#a0a09a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--fg:#ececea;--mute:#9a9a94;--line:#33332f;--acc:#ff7a5c;--accbg:#3a221c;--x:#6a6a65}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,"Noto Sans Thai",sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 20px}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
h2{font-size:19px;margin:36px 0 8px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;border-bottom:2px solid var(--acc);padding-bottom:6px}
.mt{font-size:15px;color:var(--mute);font-weight:500}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip{background:var(--accbg);border-radius:999px;padding:2px 10px;font-size:13px}
.gh{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:14px;color:var(--mute)}.gh b{color:var(--fg);font-size:16px}
.tag{display:inline-block;background:var(--acc);color:#fff;border-radius:4px;padding:0 6px;font-size:12px;margin-right:6px}
.order{border-top:1px dashed var(--line);margin-top:8px;padding-top:8px}.order:first-of-type{border-top:0}
.oh{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.shop{font-weight:600}.oid{color:var(--mute);font-size:12px}
.items td{border:0;padding:2px 0 2px 12px;font-size:14px}.items td:first-child{width:100%;padding-left:0}.var{color:var(--mute);font-size:12px}
.cancel{opacity:.55}.cancel .shop::after{content:" (ยกเลิก)";color:var(--acc)}
a{color:var(--acc)}
</style></head><body><main>
<h1>Shopee รายจ่ายรายเดือน</h1>
<p class="sub">${rep.groups.reduce((a, g) => a + g.orders.length, 0)} คำสั่งซื้อ · รวม ${baht(grand)}${opt.includeCancelled ? '' : ' (ไม่นับที่ยกเลิก)'} · สร้างเมื่อ ${esc(fmtTime(Date.now() / 1000))}</p>
<div class="box"><table><tr><th>เดือน</th><th class="n">คำสั่งซื้อ</th><th class="n">ยอด</th></tr>${monthRows}</table></div>
${sections}
<p class="sub" style="margin-top:32px">กลุ่มที่มีป้าย "จ่ายพร้อมกัน" คือคำสั่งซื้อที่ชำระในครั้งเดียวกัน (checkout เดียวกัน) · "น่าจะจ่ายพร้อมกัน" = Shopee ไม่ได้บอก checkout id จึงเดาจากเวลาที่สั่งใกล้กันและวิธีจ่ายเดียวกัน · เลขบัตรแสดงได้เฉพาะ 4 หลักท้ายตามที่ Shopee แสดง</p>
</main></body></html>`;
}

function renderGroup(g, opt) {
  const multi = g.orders.length > 1;
  const tag = multi ? `<span class="tag">${g.byCheckout ? 'จ่ายพร้อมกัน' : 'น่าจะจ่ายพร้อมกัน'} ${g.orders.length} ร้าน</span>` : '';
  const orders = g.orders.map((o) => {
    const items = o.items.map((it) => `<tr><td>${esc(it.name)}${it.variant ? ` <span class="var">${esc(it.variant)}</span>` : ''}</td><td class="n">×${it.qty}</td><td class="n">${baht(it.unitPrice === null ? null : it.unitPrice * it.qty)}</td></tr>`).join('');
    return `<div class="order${o.cancelled ? ' cancel' : ''}"><div class="oh"><span><span class="shop">${esc(o.shopName || 'ร้านค้า')}</span> <span class="oid">#${esc(o.orderId)}</span></span><span class="n">${baht(o.total)}</span></div>
${items ? `<table class="items">${items}</table>` : ''}${multi && payLabel(o) !== payLabel(g) ? `<div class="var">จ่ายด้วย ${esc(payLabel(o))}</div>` : ''}</div>`;
  }).join('');
  return `<div class="box${g.cancelled ? ' cancel' : ''}"><div class="gh"><span>${tag}${esc(fmtTime(g.time))} · ${esc(payLabel(g))}</span><b class="n">${baht(g.total)}</b></div>${orders}</div>`;
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function writeCsv(file, header, rows) {
  fs.writeFileSync(file, '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n'));
}

function writeOutputs(orders, opt) {
  let use = orders;
  if (opt.since) use = use.filter((o) => monthKey(o.orderTime) >= opt.since || monthKey(o.orderTime) === 'unknown');
  const rep = buildReport(use, opt);
  fs.writeFileSync(path.join(opt.out, 'report.html'), renderHtml(rep, opt));
  const orderRows = [];
  const itemRows = [];
  for (const g of rep.groups) {
    const groupLabel = g.orders.length > 1 ? `${g.byCheckout ? 'checkout' : 'time'}:${g.id}` : '';
    for (const o of g.orders) {
      orderRows.push([monthKey(g.time), groupLabel, isoTime(o.orderTime), o.orderId, o.shopName,
        o.items.map((i) => `${i.name}${i.variant ? ` (${i.variant})` : ''} x${i.qty}`).join('; '),
        o.total, g.orders.length > 1 ? g.total : '', o.payment, o.card, o.cancelled ? 'ยกเลิก' : '']);
      for (const i of o.items) itemRows.push([monthKey(g.time), groupLabel, isoTime(o.orderTime), o.orderId, o.shopName, i.name, i.variant, i.qty, i.unitPrice, o.payment, o.card]);
    }
  }
  writeCsv(path.join(opt.out, 'orders.csv'),
    ['เดือน', 'กลุ่มจ่ายพร้อมกัน', 'เวลาสั่งซื้อ', 'order_id', 'ร้าน', 'สินค้า', 'ยอดคำสั่งซื้อ', 'ยอดรวมทั้งกลุ่ม', 'วิธีชำระเงิน', 'บัตร', 'สถานะ'], orderRows);
  writeCsv(path.join(opt.out, 'items.csv'),
    ['เดือน', 'กลุ่มจ่ายพร้อมกัน', 'เวลาสั่งซื้อ', 'order_id', 'ร้าน', 'สินค้า', 'ตัวเลือก', 'จำนวน', 'ราคาต่อชิ้น', 'วิธีชำระเงิน', 'บัตร'], itemRows);
  writeCsv(path.join(opt.out, 'monthly.csv'), ['เดือน', 'จำนวนคำสั่งซื้อ', 'ยอดรวม', 'แยกตามวิธีจ่าย'],
    rep.months.map((m) => [m.key, m.orderCount, m.total, [...m.byPay.entries()].map(([l, v]) => `${l}: ${v}`).join(' | ')]));
  return rep;
}

// ---------------------------------------------------------------- cache

function cachePaths(opt) {
  const raw = path.join(opt.out, 'raw');
  fs.mkdirSync(raw, { recursive: true });
  return { raw, lists: path.join(raw, 'lists'), details: path.join(raw, 'details') };
}

function loadCache(opt) {
  const p = cachePaths(opt);
  fs.mkdirSync(p.lists, { recursive: true });
  fs.mkdirSync(p.details, { recursive: true });
  const listInfo = new Map();
  const listOrder = [];
  const listFiles = fs.readdirSync(p.lists).filter((f) => f.endsWith('.json')).sort();
  for (const f of listFiles) {
    for (const info of ordersFromList(JSON.parse(fs.readFileSync(path.join(p.lists, f), 'utf8')))) {
      if (!listInfo.has(info.orderId)) listOrder.push(info.orderId);
      listInfo.set(info.orderId, { ...(listInfo.get(info.orderId) || {}), ...info });
    }
  }
  const details = new Map();
  for (const f of fs.readdirSync(p.details)) {
    const m = f.match(/^(\d+)\.(json|txt)$/);
    if (!m) continue;
    const d = details.get(m[1]) || {};
    const body = fs.readFileSync(path.join(p.details, f), 'utf8');
    if (m[2] === 'json') d.detail = JSON.parse(body); else d.domText = body;
    details.set(m[1], d);
  }
  return { paths: p, listInfo, listOrder, details };
}

function parseAll(cache) {
  const ids = new Set([...cache.listOrder, ...cache.details.keys()]);
  return [...ids].map((id) => parseOrder({ orderId: id, ...(cache.details.get(id) || {}), listInfo: cache.listInfo.get(id) || {} }));
}

// ---------------------------------------------------------------- browser

async function openBrowser(opt) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    die('Playwright is not installed. Run:  npm install   (then)   npx playwright install chromium');
  }
  const base = {
    headless: opt.headless, viewport: { width: 1280, height: 900 }, locale: 'th-TH', timezoneId: TZ,
    ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'],
  };
  // Prefer the real Google Chrome: Shopee's bot checks are less suspicious of it.
  for (const channel of ['chrome', 'msedge', undefined]) {
    try { return await chromium.launchPersistentContext(path.resolve(opt.profile), { ...base, channel }); } catch (e) {
      if (channel === undefined) throw e;
    }
  }
}

const API_RE = /\/api\/v\d+\/order\//;
const isLoginUrl = (u) => /\/buyer\/login|\/login\b|\/verify\/|captcha|\/signup/i.test(u);

async function waitUntil(page, cond, timeoutMs, onWait) {
  const end = Date.now() + timeoutMs;
  let told = false;
  while (Date.now() < end) {
    if (await cond()) return true;
    if (!told && onWait) { onWait(); told = true; }
    await sleep(1000);
  }
  return false;
}

async function ensureLoggedIn(page, opt) {
  const purchase = `${opt.baseUrl}/user/purchase/`;
  await page.goto(purchase, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(2500);
  if (!isLoginUrl(page.url()) && page.url().includes('/user/purchase')) return;
  if (!isLoginUrl(page.url())) {
    await page.goto(`${opt.baseUrl}/buyer/login?next=${encodeURIComponent(purchase)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  if (opt.headless) die('Not logged in. Run once without --headless and log in in the browser window.');
  log('\n>>> กรุณา login Shopee ในหน้าต่างเบราว์เซอร์ที่เปิดขึ้นมา (รวมถึง OTP / ยืนยันตัวตน ถ้ามี)');
  log('>>> Please log in to Shopee in the browser window. The script continues by itself afterwards.\n');
  const ok = await waitUntil(page, async () => {
    const u = page.url();
    if (u.includes('/user/purchase') && !isLoginUrl(u)) return true;
    // Logged in but Shopee sent us to the home page instead of back to purchases.
    if (!isLoginUrl(u)) {
      const cookies = await page.context().cookies();
      if (cookies.some((c) => c.name === 'SPC_U' && c.value && c.value !== '-')) {
        await page.goto(purchase, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(2000);
        return page.url().includes('/user/purchase');
      }
    }
    return false;
  }, opt.loginTimeoutMin * 60000);
  if (!ok) die('Timed out waiting for login.');
  log('Logged in.');
}

async function waitIfBlocked(page) {
  if (!isLoginUrl(page.url())) return;
  log('\n>>> Shopee ขอยืนยันตัวตน/captcha — ทำในหน้าต่างเบราว์เซอร์ได้เลย แล้วสคริปต์จะทำงานต่อเอง');
  await waitUntil(page, async () => !isLoginUrl(page.url()), 15 * 60000);
}

async function collectOrderIds(page, opt, cache, stamp) {
  const ids = new Set();
  const found = [];
  let n = 0;
  const onResp = async (res) => {
    if (!API_RE.test(res.url()) || /detail/i.test(res.url())) return;
    let json;
    try { json = await res.json(); } catch { return; }
    const infos = ordersFromList(json);
    if (!infos.length) return;
    fs.writeFileSync(path.join(cache.paths.lists, `${stamp}-${String(++n).padStart(4, '0')}.json`), JSON.stringify(json));
    for (const info of infos) {
      cache.listInfo.set(info.orderId, { ...(cache.listInfo.get(info.orderId) || {}), ...info });
      if (!ids.has(info.orderId)) { ids.add(info.orderId); found.push(info.orderId); }
    }
  };
  page.on('response', onResp);
  await page.goto(`${opt.baseUrl}/user/purchase/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitIfBlocked(page);
  await sleep(2500);
  let stable = 0;
  let last = -1;
  // Scroll the "All" tab until no more orders load. Stop early once we reach
  // orders that are already cached (unless --refresh) or older than --since.
  while (stable < 5 && found.length < opt.maxOrders) {
    const domIds = await page.$$eval('a[href*="/user/purchase/order/"]', (as) => as.map((a) => (a.href.match(/order\/(\d+)/) || [])[1]).filter(Boolean)).catch(() => []);
    for (const id of domIds) if (!ids.has(id)) { ids.add(id); found.push(id); }
    process.stdout.write(`\rพบคำสั่งซื้อ ${found.length} รายการ...`);
    if (found.length === last) stable++; else { stable = 0; last = found.length; }
    if (!opt.refresh && found.length >= 10) {
      const tail = found.slice(-10);
      if (tail.every((id) => cache.details.has(id))) { log('\n(reached orders already downloaded earlier)'); break; }
    }
    if (opt.since) {
      const tail = found.slice(-5).map((id) => cache.details.get(id)).filter(Boolean)
        .map((d) => parseOrder({ orderId: '0', ...d }).orderTime).filter(Boolean);
      if (tail.length === 5 && tail.every((t) => monthKey(t) < opt.since)) break;
    }
    await page.mouse.wheel(0, 3000).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(1500);
  }
  page.off('response', onResp);
  log('');
  return found.slice(0, opt.maxOrders);
}

async function fetchDetail(page, id, opt, cache) {
  let detail = null;
  const onResp = async (res) => {
    if (!API_RE.test(res.url()) || !/detail/i.test(res.url())) return;
    try { const j = await res.json(); if (JSON.stringify(j).includes(id)) detail = j; } catch { /* ignore */ }
  };
  page.on('response', onResp);
  try {
    await page.goto(`${opt.baseUrl}/user/purchase/order/${id}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitIfBlocked(page);
    if (isLoginUrl(page.url()) === false && !page.url().includes(id)) {
      await page.goto(`${opt.baseUrl}/user/purchase/order/${id}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await waitUntil(page, async () => detail !== null, 15000);
    // Give the page a moment to render the payment section.
    await waitUntil(page, async () => /วิธีการชำระเงิน|payment method/i.test(await page.innerText('body').catch(() => '')), 6000);
    const domText = await page.innerText('body').catch(() => '');
    if (detail) fs.writeFileSync(path.join(cache.paths.details, `${id}.json`), JSON.stringify(detail));
    fs.writeFileSync(path.join(cache.paths.details, `${id}.txt`), domText);
    cache.details.set(id, { detail, domText });
    return parseOrder({ orderId: id, detail, domText, listInfo: cache.listInfo.get(id) || {} });
  } finally {
    page.off('response', onResp);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opt.out, { recursive: true });
  const cache = loadCache(opt);

  if (!opt.reportOnly) {
    const ctx = await openBrowser(opt);
    const page = ctx.pages()[0] || await ctx.newPage();
    try {
      await ensureLoggedIn(page, opt);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ids = await collectOrderIds(page, opt, cache, stamp);
      const todo = ids.filter((id) => opt.refresh || !cache.details.has(id));
      log(`ต้องเปิดดูรายละเอียดใหม่ ${todo.length} คำสั่งซื้อ (จากที่พบ ${ids.length})`);
      let older = 0;
      for (let i = 0; i < todo.length; i++) {
        const o = await fetchDetail(page, todo[i], opt, cache);
        log(`[${i + 1}/${todo.length}] #${o.orderId} ${isoTime(o.orderTime)} ${o.shopName || ''} ${baht(o.total)} ${payLabel(o)}${o.cancelled ? ' (ยกเลิก)' : ''}`);
        if (opt.since) {
          older = o.orderTime && monthKey(o.orderTime) < opt.since ? older + 1 : 0;
          if (older >= 5) { log(`ถึงคำสั่งซื้อก่อน ${opt.since} แล้ว หยุด`); break; }
        }
        await sleep(opt.delay);
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  const orders = parseAll(cache);
  if (!orders.length) die('ยังไม่มีข้อมูลคำสั่งซื้อ (no orders found). Run without --report-only first.');
  const rep = writeOutputs(orders, opt);
  log('\nสรุปรายเดือน:');
  for (const m of rep.months) log(`  ${m.key}  ${String(m.orderCount).padStart(3)} คำสั่งซื้อ  ${baht(m.total).padStart(14)}`);
  const unknownPay = orders.filter((o) => !o.payment).length;
  if (unknownPay) log(`\nหมายเหตุ: ${unknownPay} คำสั่งซื้อหาวิธีชำระเงินไม่เจอ ดูข้อมูลดิบได้ที่ ${cache.paths.details}`);
  log(`\nรายงาน: ${path.resolve(opt.out, 'report.html')}`);
  log(`CSV:    ${path.resolve(opt.out, 'orders.csv')}, items.csv, monthly.csv`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseOrder, ordersFromList, groupOrders, buildReport, monthKey, cardFrom, parseShownDate };
