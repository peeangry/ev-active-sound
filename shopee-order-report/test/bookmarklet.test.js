// Runs the built bookmarklet on the mock Shopee site, with and without "anti-bot" API blocking.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { start } = require('./mock-shopee');

const code = fs.readFileSync(path.join(__dirname, '..', 'web', 'dist', 'bookmarklet.min.js'), 'utf8');

async function scenario(strict) {
  const server = await start(0, { strict });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e));
    await page.goto(base + '/user/purchase/'); // redirects to login, which "logs in" and comes back
    await page.waitForURL(/\/user\/purchase\/$/);
    await page.evaluate(code);
    const host = page.locator('#shopee-order-report-host');
    await host.locator('#range').selectOption('0');
    await host.locator('#go').click();
    await host.locator('#dh').waitFor({ timeout: 120000 });
    const text = await host.locator('#rep main').innerText();
    for (const s of ['พฤศจิกายน 2569', 'จ่ายพร้อมกัน 2 ร้าน', 'น่าจะจ่ายพร้อมกัน 2 ร้าน', 'VISA *1234', 'MASTERCARD *5678', 'ชำระเงินปลายทาง', '฿568.00', '฿209.00', 'เสื้อยืด'])
      assert.ok(text.includes(s), `${strict ? 'strict' : 'normal'}: missing ${s}\n${text}`);
    const [dl] = await Promise.all([page.waitForEvent('download'), host.locator('#dc').click()]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.ok(csv.includes('checkout:9001') && csv.split('\r\n').length === 6, csv);
    for (const s of ['ของเล่น', 'ร่ม', 'พัดลม']) assert.ok(!text.includes(s) && !csv.includes(s), `cancelled/unpaid "${s}" must not be listed`);
    const summary = await host.locator('.body > p.mute').innerText();
    assert.ok(/พบทั้งหมด 7 คำสั่งซื้อ · ยกเลิก 1 \(ไม่นับ\) · ยังไม่ชำระ 1/.test(summary), summary);
    const [dbg] = await Promise.all([page.waitForEvent('download'), host.locator('#dr').click()]);
    const dbgText = fs.readFileSync(await dbg.path(), 'utf8');
    assert.ok(dbgText.includes('label_order_cancelled') && !dbgText.includes('ร้านเสื้อ') && !dbgText.includes('81****6789'), 'debug file is redacted');
    // Second run uses the localStorage cache for old orders.
    await host.locator('#again').click();
    assert.ok(/ลบข้อมูลที่จำไว้ \(5/.test(await host.locator('.body').innerText()));
    console.log(`${strict ? 'strict (API blocked, frame fallback)' : 'normal (direct API)'}: OK`);
  } finally {
    await browser.close();
    server.close();
  }
}

(async () => {
  await scenario(false);
  await scenario(true);
  console.log('BOOKMARKLET OK');
})().catch((e) => { console.error(e); process.exit(1); });
