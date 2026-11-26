/*
 * Bookmarklet: runs on shopee.co.th while you are logged in, reads your order
 * history the same way the "My Purchases" page does, and shows the monthly
 * report in a panel on top of the page. Nothing is sent anywhere else.
 *
 * Built together with ../core.js by build.js (ShopeeCore is defined there).
 */
(function () {
  'use strict';
  const C = globalThis.ShopeeCore;
  const ORIGIN = location.origin;
  const CACHE_KEY = 'shopeeOrderReport.v2'; // v1 results could hold wrong dates/status
  const HOST_ID = 'shopee-order-report-host';

  if (document.getElementById(HOST_ID)) { document.getElementById(HOST_ID).style.display = 'block'; return; }
  if (!/(^|\.)shopee\./.test(location.hostname) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    alert('กรุณาเปิดเว็บ shopee.co.th และ login ก่อน แล้วค่อยกดปุ่มนี้');
    return;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const API_RE = /\/api\/v\d+\/order\//;

  // ------------------------------------------------------------ UI (shadow DOM so Shopee's CSS can't touch it)
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);
  shadow.innerHTML = `<style>
:host{all:initial}
.wrap{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,"Noto Sans Thai",sans-serif;color:#1d1d1b}
.panel{background:#fff;border-radius:14px;width:min(960px,calc(100vw - 24px));max-height:calc(100vh - 24px);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.top{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #eee;gap:8px}
.top b{font-size:17px}.x{border:0;background:none;font-size:24px;cursor:pointer;color:#666;line-height:1}
.body{padding:16px;overflow:auto}
label{display:block;margin:10px 0}
select{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid #ccc}
.btn{font:inherit;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;background:#ee4d2d;color:#fff;font-weight:600}
.btn.s{background:#f1f1ef;color:#1d1d1b;font-weight:500}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 8px}
.bar{height:8px;background:#f1f1ef;border-radius:99px;overflow:hidden;margin:12px 0}.bar i{display:block;height:100%;width:0;background:#ee4d2d;transition:width .3s}
.mute{color:#6b6b66;font-size:13px}.err{color:#c0392b}
.note{background:#fdf6e3;border-radius:8px;padding:8px 12px;font-size:13px;margin-top:12px}
</style>
<div class="wrap"><div class="panel">
  <div class="top"><b>สรุปรายจ่าย Shopee</b><button class="x" title="ปิด">×</button></div>
  <div class="body" id="body"></div>
</div></div>`;
  const $body = shadow.getElementById('body');
  shadow.querySelector('.x').onclick = () => { stopped = true; host.remove(); };

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function showStart(msg) {
    const cached = Object.keys(loadCache().orders).length;
    $body.innerHTML = `
      ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
      <label>ดึงย้อนหลัง
        <select id="range">
          <option value="3">3 เดือน</option><option value="6">6 เดือน</option>
          <option value="12" selected>12 เดือน</option><option value="24">2 ปี</option><option value="0">ทั้งหมด</option>
        </select></label>
      <label><input type="checkbox" id="cancel"> นับคำสั่งซื้อที่ยกเลิกรวมในยอดด้วย</label>
      <div class="btns"><button class="btn" id="go">เริ่มดึงข้อมูล</button>
      ${cached ? `<button class="btn s" id="clear">ลบข้อมูลที่จำไว้ (${cached} รายการ)</button>` : ''}</div>
      <p class="mute">ใช้เวลาประมาณ 1–2 วินาทีต่อคำสั่งซื้อ ข้อมูลอยู่ในเบราว์เซอร์ของคุณเท่านั้น ไม่ได้ส่งไปที่ไหน${cached ? ' · คำสั่งซื้อที่เคยดึงแล้วจะไม่ดึงซ้ำ' : ''}</p>`;
    shadow.getElementById('go').onclick = () => {
      const months = Number(shadow.getElementById('range').value);
      run({ months, includeCancelled: shadow.getElementById('cancel').checked }).catch((e) => {
        console.error(e);
        showStart('เกิดข้อผิดพลาด: ' + (e && e.message || e));
      });
    };
    const clr = shadow.getElementById('clear');
    if (clr) clr.onclick = () => { try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ } showStart(); };
  }

  let stopped = false;
  function showProgress() {
    $body.innerHTML = `<p id="ptext">กำลังเริ่ม...</p><div class="bar"><i id="pbar"></i></div>
      <p class="mute" id="plast"></p><button class="btn s" id="stop">หยุดและดูผลเท่าที่ได้</button>`;
    shadow.getElementById('stop').onclick = () => { stopped = true; };
  }
  function progress(text, frac, last) {
    const t = shadow.getElementById('ptext'); if (t) t.textContent = text;
    const b = shadow.getElementById('pbar'); if (b && frac !== undefined) b.style.width = Math.round(frac * 100) + '%';
    const l = shadow.getElementById('plast'); if (l && last !== undefined) l.textContent = last;
  }

  // ------------------------------------------------------------ cache (localStorage on shopee.co.th, this browser only)
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || { orders: {} }; } catch { return { orders: {} }; }
  }
  function saveCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* full or blocked */ } }

  // ------------------------------------------------------------ Shopee API, same requests the purchase page makes
  function headers() {
    const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1];
    const h = { accept: 'application/json', 'x-api-source': 'pc', 'x-shopee-language': 'th', 'x-requested-with': 'XMLHttpRequest' };
    if (csrf) h['x-csrftoken'] = csrf;
    return h;
  }
  async function api(p) {
    let r;
    try { r = await fetch(ORIGIN + p, { credentials: 'include', headers: headers() }); } catch (e) { return { ok: false, status: 0 }; }
    let j = null;
    try { j = JSON.parse(await r.text()); } catch { /* not JSON */ }
    const ok = r.ok && j && (j.error === 0 || j.error == null) && j.data != null;
    const needLogin = r.status === 401 || r.status === 403 || (j && (j.error === 19 || j.error === 401));
    return { ok, json: j, status: r.status, needLogin };
  }

  // ------------------------------------------------------------ fallback: load Shopee's own pages in a hidden frame
  // If Shopee refuses our direct API calls (anti-bot signing), we let its own page
  // make the calls and listen in, and also read the text the page shows.
  let frame = null;
  function hook(w, onJson) {
    if (w.__shopeeReportHooked) return;
    w.__shopeeReportHooked = true;
    const X = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
    if (X) {
      const open = X.open; const send = X.send;
      X.open = function (m, u) { this.__srUrl = String(u); return open.apply(this, arguments); };
      X.send = function () {
        this.addEventListener('load', () => {
          if (!API_RE.test(this.__srUrl || '')) return;
          try { onJson(this.__srUrl, this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* ignore */ }
        });
        return send.apply(this, arguments);
      };
    }
    const f = w.fetch;
    if (f) {
      w.fetch = function (input) {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        const p = f.apply(this, arguments);
        if (API_RE.test(u)) p.then((r) => r.clone().json().then((j) => onJson(u, j)).catch(() => {})).catch(() => {});
        return p;
      };
    }
  }
  async function frameLoad(url, until, onJson, timeout = 20000) {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1280px;height:900px;border:0;visibility:hidden';
      document.body.appendChild(frame);
    }
    frame.src = url;
    const end = Date.now() + timeout;
    await sleep(50);
    while (Date.now() < end && !stopped) {
      let w = null;
      try { w = frame.contentWindow; if (w && w.location.href !== 'about:blank') hook(w, onJson); } catch { /* navigating */ }
      try { if (w && w.document && await until(w)) return w; } catch { /* not ready */ }
      await sleep(5);
    }
    try { return frame.contentWindow; } catch { return null; }
  }
  const frameText = (w) => { try { return w.document.body ? w.document.body.innerText : ''; } catch { return ''; } };
  const isLoginPage = (w) => { try { return /\/buyer\/login|\/verify\/|captcha/.test(w.location.pathname); } catch { return false; } };

  async function detailViaFrame(id) {
    let detail = null;
    const w = await frameLoad(`${ORIGIN}/user/purchase/order/${id}`,
      (win) => isLoginPage(win) || (detail && /วิธีการชำระเงิน|payment method/i.test(frameText(win))),
      (u, j) => { if (/detail/i.test(u) && JSON.stringify(j).includes(id)) detail = j; });
    if (w && isLoginPage(w)) throw new Error('LOGIN');
    // A little extra time in case the detail JSON never matched but the text is there.
    if (!detail) await sleep(500);
    return { detail, domText: w ? frameText(w) : '' };
  }

  async function listViaFrame(onInfos) {
    let found = 0;
    const onJson = (u, j) => { if (!/detail/i.test(u)) { const infos = C.ordersFromList(j); if (infos.length) { raw.lists.push(j); found += onInfos(infos); } } };
    const linkIds = (win) => [...win.document.querySelectorAll('a[href*="/user/purchase/order/"]')]
      .map((a) => (a.href.match(/order\/(\d+)/) || [])[1]).filter(Boolean);
    const w = await frameLoad(`${ORIGIN}/user/purchase/`, (win) => isLoginPage(win) || found > 0 || linkIds(win).length > 0, onJson, 25000);
    if (!w || isLoginPage(w)) throw new Error('LOGIN');
    let last = -1; let stable = 0;
    while (stable < 5 && !stopped) {
      try {
        found += onInfos(linkIds(w).map((orderId) => ({ orderId })));
        w.scrollTo(0, w.document.body.scrollHeight);
      } catch { /* ignore */ }
      progress(`กำลังไล่ดูหน้า "การซื้อของฉัน"... พบ ${found} คำสั่งซื้อ`);
      await sleep(1500);
      if (found === last) stable++; else { stable = 0; last = found; }
    }
  }

  // ------------------------------------------------------------ main run
  const raw = { lists: [], details: {}, marks: [] };

  function sinceKey(months) {
    if (!months) return null;
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - (months - 1));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  async function run({ months, includeCancelled }) {
    stopped = false;
    showProgress();
    const since = sinceKey(months);
    const cache = loadCache();
    const listInfo = new Map();
    const queue = [];
    const queued = new Set();
    const results = new Map();
    const addInfos = (infos) => {
      let n = 0;
      for (const info of infos) {
        if (!queued.has(info.orderId)) { queued.add(info.orderId); queue.push(info.orderId); n++; }
        listInfo.set(info.orderId, { ...(listInfo.get(info.orderId) || {}), ...info });
      }
      return n;
    };

    let detailMode = 'api';
    let apiFails = 0;
    let olderInARow = 0;
    let done = 0;
    const RECENT = 30 * 86400; // recent orders can still change status, so re-check them
    const nowS = Date.now() / 1000;

    async function processQueue() {
      while (queue.length && !stopped) {
        const id = queue.shift();
        const cached = cache.orders[id];
        const li = listInfo.get(id) || {};
        let o;
        if ((li.listCancelled && !includeCancelled) || li.listUnpaid) {
          o = C.parseOrder({ orderId: id, listInfo: li });
          o.cancelled = !!li.listCancelled; o.unpaid = !li.listCancelled && !!li.listUnpaid;
        } else if (cached && cached.orderTime && nowS - cached.orderTime > RECENT) {
          o = cached;
        } else {
          let got = null;
          if (detailMode === 'api') {
            const r = await api(`/api/v4/order/get_order_detail?order_id=${id}`);
            if (r.ok) { got = { detail: r.json, domText: '' }; apiFails = 0; } else if (++apiFails >= 2) detailMode = 'frame';
          }
          if (!got) got = await detailViaFrame(id);
          raw.details[id] = got;
          o = C.parseOrder({ orderId: id, ...got, listInfo: listInfo.get(id) || {} });
          // If the API JSON lacked payment or card info, the page text usually has it.
          if (got.detail && (!o.payment || !o.orderTime || (!o.card && /บัตร|card/i.test(o.payment)))) {
            const f = await detailViaFrame(id);
            const o2 = C.parseOrder({ orderId: id, detail: got.detail || f.detail, domText: f.domText, listInfo: listInfo.get(id) || {} });
            o = { ...o, payment: o.payment || o2.payment, card: o.card || o2.card, orderTime: o.orderTime || o2.orderTime,
              payTime: o.payTime || o2.payTime, cancelled: o.cancelled || o2.cancelled };
          }
          cache.orders[id] = o;
          saveCache(cache);
          await sleep(300);
        }
        results.set(id, o);
        done++;
        const total = done + queue.length;
        progress(`ดูรายละเอียดแล้ว ${done} จาก ${total} คำสั่งซื้อที่พบ`, done / total,
          `${C.isoTime(o.orderTime)} · ${o.shopName || ''} · ${C.baht(o.total)} · ${C.payLabel(o)}`);
        if (since && o.orderTime) {
          olderInARow = C.monthKey(o.orderTime) < since ? olderInARow + 1 : 0;
          if (olderInARow >= 5) return 'old';
        }
      }
      return null;
    }

    try {
      // 0) which orders are cancelled / not paid yet, straight from Shopee's own tabs
      for (const [type, flag, label] of [[4, 'listCancelled', 'ที่ยกเลิก'], [9, 'listUnpaid', 'ที่ยังไม่ชำระ']]) {
        let offset = 0;
        for (let pageNo = 0; pageNo < 100 && !stopped; pageNo++) {
          progress(`กำลังดูรายการ${label}...`);
          const r = await api(`/api/v4/order/get_order_list?list_type=${type}&limit=10&offset=${offset}`);
          if (!r.ok) { if (offset === 0 && r.needLogin) throw new Error('LOGIN'); break; }
          raw.marks.push({ type, json: r.json });
          const infos = C.ordersFromList(r.json);
          for (const info of infos) listInfo.set(info.orderId, { ...(listInfo.get(info.orderId) || {}), ...info, [flag]: true });
          const pg = C.listPage(r.json);
          if (!pg.cards || pg.nextOffset === -1) break;
          offset = pg.nextOffset > offset ? pg.nextOffset : offset + pg.cards;
          await sleep(250);
        }
      }
      // 1) list orders page by page, fetching details as we go (newest first)
      const endpoints = [
        (o) => `/api/v4/order/get_all_order_and_checkout_list?limit=10&offset=${o}`,
        (o) => `/api/v4/order/get_order_list?list_type=5&limit=10&offset=${o}`,
      ];
      let listed = false;
      for (const ep of endpoints) {
        if (listed || stopped) break;
        let offset = 0;
        let pageNo = 0;
        let emptyPages = 0;
        for (;;) {
          if (stopped) break;
          progress(`กำลังดึงรายการคำสั่งซื้อ... (หน้า ${++pageNo})`);
          const r = await api(ep(offset));
          if (!r.ok) {
            if (offset === 0 && r.needLogin) throw new Error('LOGIN');
            break;
          }
          listed = true;
          raw.lists.push(r.json);
          const infos = C.ordersFromList(r.json);
          // Keep the cancelled/unpaid marks from step 0 when the same order shows up here.
          const fresh = addInfos(infos.map((i) => ({ ...(listInfo.get(i.orderId) || {}), ...i,
            listCancelled: i.listCancelled || (listInfo.get(i.orderId) || {}).listCancelled,
            listUnpaid: i.listUnpaid || (listInfo.get(i.orderId) || {}).listUnpaid })));
          const pg = C.listPage(r.json);
          // A page can hold only unpaid checkouts with no order id: that is not the end of the list.
          emptyPages = fresh ? 0 : emptyPages + 1;
          if (!pg.cards || emptyPages >= 3) break;
          if (await processQueue() === 'old') { queue.length = 0; break; }
          if (pg.nextOffset === -1) break;
          // Shopee may return fewer cards than asked for, so move by what it actually gave.
          offset = pg.nextOffset > offset ? pg.nextOffset : offset + pg.cards;
          await sleep(300);
        }
      }
      // 2) the API refused us: let Shopee's own page do the listing
      if (!listed && !stopped) {
        await listViaFrame(addInfos);
        await processQueue();
      }
    } catch (e) {
      if (e && e.message === 'LOGIN') { showStart('ยังไม่ได้ login หรือ Shopee ขอยืนยันตัวตน: กรุณา login ที่ shopee.co.th ในแท็บนี้ก่อน แล้วกดปุ่มอีกครั้ง'); return; }
      throw e;
    } finally {
      if (frame) { frame.remove(); frame = null; }
    }

    const orders = [...results.values()];
    if (!orders.length) { showStart('ไม่พบคำสั่งซื้อ (หรือ Shopee ไม่ยอมให้ดึงข้อมูล) ลองเปิดหน้า "การซื้อของฉัน" แล้วกดปุ่มอีกครั้ง'); return; }
    showResult(orders, { since, includeCancelled, groupWindow: 120 });
  }

  function diagnostics(orders, opt) {
    const details = Object.entries(raw.details).slice(0, 8).map(([id, d]) => ({
      orderId: id, detail: d.detail ? C.redact(d.detail) : null, pageText: C.redactPageText(d.domText),
    }));
    return {
      tool: 'shopee-order-report', host: location.hostname, when: new Date().toISOString(), options: opt,
      parsed: orders.map((o) => ({ orderId: o.orderId, checkoutId: o.checkoutId, orderTime: o.orderTime, total: o.total,
        items: o.items.length, payment: o.payment, card: o.card, cancelled: o.cancelled, unpaid: o.unpaid })),
      lists: raw.lists.map((j) => C.redact(j)),
      statusLists: raw.marks.map((m) => ({ type: m.type, json: C.redact(m.json) })),
      details,
    };
  }

  // ------------------------------------------------------------ result
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    shadow.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function showResult(orders, opt) {
    const out = C.buildOutputs(orders, opt);
    const style = (out.html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    const main = (out.html.match(/<main>([\s\S]*?)<\/main>/) || [])[1] || '';
    const unknown = orders.filter((o) => !o.payment && !o.cancelled && !o.unpaid).length;
    const noDate = orders.filter((o) => !o.orderTime && !o.cancelled && !o.unpaid).length;
    const stamp = new Date().toISOString().slice(0, 10);
    $body.innerHTML = `
      <div class="btns">
        <button class="btn" id="dh">ดาวน์โหลดรายงาน</button>
        <button class="btn s" id="dc">Excel: คำสั่งซื้อ</button>
        <button class="btn s" id="di">Excel: รายการสินค้า</button>
        <button class="btn s" id="dm">Excel: สรุปรายเดือน</button>
        <button class="btn s" id="again">ดึงใหม่</button>
      </div>
      <p class="mute">พบทั้งหมด ${orders.length} คำสั่งซื้อ · ยกเลิก ${out.rep.skipped.cancelled}${opt.includeCancelled ? '' : ' (ไม่นับ)'} · ยังไม่ชำระ ${out.rep.skipped.unpaid} (ไม่นับ)${unknown ? ` · หาวิธีจ่ายไม่เจอ ${unknown}` : ''}${noDate ? ` · ไม่ทราบวันที่ ${noDate}` : ''}</p>
      <div class="note">ถ้ารายการไม่ครบหรือไม่ถูก กด <a href="#" id="dr">ดาวน์โหลดไฟล์ตรวจปัญหา</a> แล้วส่งไฟล์นั้นมา ไฟล์นี้ตัดชื่อ ที่อยู่ เบอร์โทร ชื่อร้านและชื่อสินค้าออกแล้ว เหลือแค่โครงสร้างข้อมูล ตัวเลข และสถานะ</div>
      <div id="rep"></div>`;
    const repHost = shadow.getElementById('rep').attachShadow({ mode: 'open' });
    repHost.innerHTML = `<style>${style.replace(/:root/g, ':host')} :host{display:block;background:var(--bg);color:var(--fg);border-radius:10px;margin-top:8px} main{padding:16px}</style><main>${main}</main>`;
    repHost.querySelectorAll('a[href^="#m-"]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); const t = repHost.getElementById(a.getAttribute('href').slice(1)); if (t) t.scrollIntoView({ behavior: 'smooth' }); };
    });
    shadow.getElementById('dh').onclick = () => download(`shopee-report-${stamp}.html`, out.html, 'text/html;charset=utf-8');
    shadow.getElementById('dc').onclick = () => download(`shopee-orders-${stamp}.csv`, out.ordersCsv, 'text/csv;charset=utf-8');
    shadow.getElementById('di').onclick = () => download(`shopee-items-${stamp}.csv`, out.itemsCsv, 'text/csv;charset=utf-8');
    shadow.getElementById('dm').onclick = () => download(`shopee-monthly-${stamp}.csv`, out.monthlyCsv, 'text/csv;charset=utf-8');
    shadow.getElementById('again').onclick = () => showStart();
    const dr = shadow.getElementById('dr');
    if (dr) dr.onclick = (e) => { e.preventDefault(); download(`shopee-debug-${stamp}.json`, JSON.stringify(diagnostics(orders, opt), null, 1), 'application/json'); };
  }

  showStart();
})();
