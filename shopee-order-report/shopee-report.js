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

const { parseOrder, ordersFromList, buildOutputs, monthKey, isoTime, baht, payLabel, TZ } = require('./core');

function writeOutputs(orders, opt) {
  const r = buildOutputs(orders, opt);
  fs.writeFileSync(path.join(opt.out, 'report.html'), r.html);
  fs.writeFileSync(path.join(opt.out, 'orders.csv'), r.ordersCsv);
  fs.writeFileSync(path.join(opt.out, 'items.csv'), r.itemsCsv);
  fs.writeFileSync(path.join(opt.out, 'monthly.csv'), r.monthlyCsv);
  return r.rep;
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

module.exports = require('./core');
