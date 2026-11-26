/*
 * Shared parsing and report code for Shopee orders.
 * Used by the command-line tool (shopee-report.js) and by the browser
 * bookmarklet (web/), so it must not depend on Node or the DOM.
 */
(function (root) {
'use strict';

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
  // Status lives on the card around the order (e.g. details_list[i].status), not on the order itself.
  walk(json, (obj) => {
    if (!obj.status || typeof obj.status !== 'object') return;
    const texts = [];
    walk(obj.status, (o) => { for (const v of Object.values(o)) if (typeof v === 'string') texts.push(v); });
    if (!texts.length) return;
    const st = texts.join(' | ');
    walk(obj, (inner) => {
      const id = idOf(inner.order_id);
      if (!id || !found.has(id)) return;
      const info = found.get(id);
      info.listStatus = st;
      if (CANCEL_RE.test(st)) info.listCancelled = true;
      if (UNPAID_RE.test(st)) info.listUnpaid = true;
    });
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

const CANCEL_RE = /cancel|ยกเลิก/i;
const UNPAID_RE = /unpaid|to_?pay|wait(ing)?_?(for_?)?pay|ที่ต้องชำระ|รอการชำระ|รอชำระ/i;

/** Paging info of one order-list response: how many cards it held, and Shopee's next offset if given. */
function listPage(json) {
  let cards = null;
  let next = null;
  walk(json, (obj) => {
    if (cards === null && Array.isArray(obj.details_list)) cards = obj.details_list.length;
    if (next === null && typeof obj.next_offset === 'number') next = obj.next_offset;
  });
  return { cards: cards ?? 0, nextOffset: next };
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
  if (!orderTime) { const f = tsByKey(/^(create_time|order_time|order_create_time)$/); if (f) orderTime = f.v; }
  if (!orderTime) orderTime = parseShownDate(textAfter(domText, ['เวลาที่สั่งซื้อ', 'Order Time']));
  let payTime = null;
  const payRow = rowVal(/pay(ment)?_?time|เวลาชำระเงิน|payment time/i);
  if (isTs(toNum(payRow))) payTime = toNum(payRow);
  if (!payTime) { const f = tsByKey(/^(pay_time|paid_time|payment_time)$/); if (f) payTime = f.v; }
  if (!payTime) payTime = parseShownDate(textAfter(domText, ['เวลาชำระเงิน', 'Payment Time']));
  if (!orderTime) orderTime = payTime;

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
  if (listInfo.listItems && listInfo.listItems.length >= items.length) items = listInfo.listItems;
  const statusTexts = [];
  walk(data, (obj, kp) => {
    if (!kp.some((k) => /status/i.test(k)) || kp.some((k) => /button|action/i.test(k))) return;
    for (const v of Object.values(obj)) if (typeof v === 'string') statusTexts.push(v);
  });
  const head = (domText || '').slice(0, 1500);
  const cancelled = !!listInfo.listCancelled || statusTexts.some((t) => CANCEL_RE.test(t))
    || /คำสั่งซื้อถูกยกเลิก|ยกเลิกแล้ว|order cancelled|\bcancelled\b/i.test(head);
  const unpaid = !cancelled && (!!listInfo.listUnpaid || statusTexts.some((t) => UNPAID_RE.test(t)));

  return {
    orderId: String(orderId),
    checkoutId: checkoutId ? String(checkoutId) : null,
    orderTime, payTime, shopName, items, total,
    payment: payment || null, card, cancelled, unpaid,
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
<p class="sub">${rep.groups.reduce((a, g) => a + g.orders.length, 0)} คำสั่งซื้อ · รวม ${baht(grand)}${rep.skipped && !opt.includeCancelled && rep.skipped.cancelled ? ` · ไม่รวมที่ยกเลิก ${rep.skipped.cancelled} รายการ` : ''}${rep.skipped && rep.skipped.unpaid ? ` · ไม่รวมที่ยังไม่จ่าย ${rep.skipped.unpaid} รายการ` : ''} · สร้างเมื่อ ${esc(fmtTime(Date.now() / 1000))}</p>
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
function toCsv(header, rows) {
  return '\ufeff' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Everything the report needs, as strings: { html, ordersCsv, itemsCsv, monthlyCsv, rep }. */
function buildOutputs(orders, opt) {
  let use = orders;
  if (opt.since) use = use.filter((o) => monthKey(o.orderTime) >= opt.since || monthKey(o.orderTime) === 'unknown');
  const skipped = { cancelled: use.filter((o) => o.cancelled).length, unpaid: use.filter((o) => o.unpaid).length };
  use = use.filter((o) => !o.unpaid && (opt.includeCancelled || !o.cancelled));
  const rep = buildReport(use, opt);
  rep.skipped = skipped;
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
  return {
    rep,
    html: renderHtml(rep, opt),
    ordersCsv: toCsv(['เดือน', 'กลุ่มจ่ายพร้อมกัน', 'เวลาสั่งซื้อ', 'order_id', 'ร้าน', 'สินค้า', 'ยอดคำสั่งซื้อ', 'ยอดรวมทั้งกลุ่ม', 'วิธีชำระเงิน', 'บัตร', 'สถานะ'], orderRows),
    itemsCsv: toCsv(['เดือน', 'กลุ่มจ่ายพร้อมกัน', 'เวลาสั่งซื้อ', 'order_id', 'ร้าน', 'สินค้า', 'ตัวเลือก', 'จำนวน', 'ราคาต่อชิ้น', 'วิธีชำระเงิน', 'บัตร'], itemRows),
    monthlyCsv: toCsv(['เดือน', 'จำนวนคำสั่งซื้อ', 'ยอดรวม', 'แยกตามวิธีจ่าย'],
      rep.months.map((m) => [m.key, m.orderCount, m.total, [...m.byPay.entries()].map(([l, v]) => `${l}: ${v}`).join(' | ')])),
  };
}

/**
 * Copy of Shopee JSON with personal text removed, so its structure can be shared to debug parsing.
 * Keeps numbers (prices, times, ids), Shopee's own label keys and payment/status words; every
 * other string becomes "<text:N>". Long arrays are cut to their first 3 entries.
 */
function redact(node, key = '') {
  if (Array.isArray(node)) return node.slice(0, 3).map((v) => redact(v, key)).concat(node.length > 3 ? [`<+${node.length - 3} more>`] : []);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = redact(v, k);
    return out;
  }
  if (typeof node !== 'string') return node;
  if (/^label_[a-z0-9_]+$/i.test(node)) return node;
  if (/status|payment|channel|method|card|bank|type/i.test(key) && node.length <= 60 && !/\d{5,}/.test(node.replace(/[*xX•]{2,}\s*-?\s*\d{4}/g, ''))) return node;
  return `<text:${node.length}>`;
}

/** Only the lines of an order page that carry labels this tool looks for, plus the line after each. */
function redactPageText(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const keep = [];
  // Phone numbers ("(+66) 81****6789") look a lot like masked cards; a card has no digit before its stars.
  const clean = (l) => l
    .replace(/\(?\+\d{1,3}\)?[\d\s*xX•-]{6,}\d/g, '<phone>')
    .replace(/\d[\d\s-]*[*xX•]{2,}[\d\s-]*\d/g, '<phone>')
    .replace(/\b0\d{8,9}\b/g, '<phone>')
    .replace(/\d{5,}/g, (m) => '#'.repeat(m.length)).slice(0, 80);
  const picked = new Set();
  lines.forEach((l, i) => {
    if (/วิธีการชำระ|payment|เวลา|time|ยกเลิก|cancel|สถานะ|ยอดคำสั่งซื้อ|order total|บัตร|card|[*xX•]{2,}\s*\d{4}/i.test(l)) {
      picked.add(i);
      if (i + 1 < lines.length) picked.add(i + 1);
    }
  });
  for (const i of [...picked].sort((x, y) => x - y)) keep.push(clean(lines[i]));
  return keep.join('\n');
}

const api = {
  PRICE_SCALE, TZ, parseOrder, ordersFromList, listPage, redact, redactPageText, itemsFrom, groupOrders, buildReport, buildOutputs,
  monthKey, isoTime, baht, payLabel, cardFrom, parseShownDate,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ShopeeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
