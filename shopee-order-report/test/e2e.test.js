// End-to-end test against the mock site: login wait, list scrolling, detail pages, grouping, report.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { start } = require('./mock-shopee');

function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

(async () => {
  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopee-e2e-'));
  const out = path.join(tmp, 'out');
  const script = path.join(__dirname, '..', 'shopee-report.js');
  const run = (...extra) => new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('node', [script, '--base-url', base, '--out', out, '--profile', path.join(tmp, 'profile'), '--delay', '100', ...extra],
      { timeout: 180000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
  try {
    const stdout = await run();
    process.stdout.write(stdout);

    const csv = fs.readFileSync(path.join(out, 'orders.csv'), 'utf8').replace(/^﻿/, '').trim().split('\r\n');
    const rows = csv.slice(1).map(splitCsv);
    const byId = Object.fromEntries(rows.map((r) => [r[3], r]));
    assert.strictEqual(rows.length, 5, 'five paid, not-cancelled orders');
    assert.ok(!byId['200005'], 'cancelled order left out');
    assert.ok(!byId['200007'], 'unpaid order left out');

    // checkout grouping
    assert.strictEqual(byId['200001'][1], 'checkout:9001');
    assert.strictEqual(byId['200002'][1], 'checkout:9001');
    assert.strictEqual(byId['200001'][7], '568');
    // time-window grouping
    assert.ok(byId['200003'][1].startsWith('time:'));
    assert.strictEqual(byId['200003'][1], byId['200004'][1]);
    // payment + card
    assert.strictEqual(byId['200001'][8], 'บัตรเครดิต/บัตรเดบิต');
    assert.strictEqual(byId['200001'][9], 'VISA *1234');
    assert.strictEqual(byId['200003'][9], 'MASTERCARD *5678');
    assert.strictEqual(byId['200006'][8], 'ชำระเงินปลายทาง');
    assert.strictEqual(byId['200006'][9], '', 'masked phone must not be read as a card');
    // month buckets (Bangkok time)
    assert.strictEqual(byId['200001'][0], '2026-11');
    assert.strictEqual(byId['200003'][0], '2026-10');
    assert.strictEqual(byId['200006'][0], '2026-09');
    assert.strictEqual(byId['200001'][5], 'เสื้อยืด (ดำ, L) x2');
    const monthly = fs.readFileSync(path.join(out, 'monthly.csv'), 'utf8');
    assert.ok(/2026-11,2,568/.test(monthly), monthly); // 418+150
    assert.ok(/2026-10,2,209/.test(monthly), monthly); // 89+120, cancelled 300 not counted
    assert.ok(/2026-09,1,330/.test(monthly), monthly);

    const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
    assert.ok(html.includes('จ่ายพร้อมกัน 2 ร้าน'));
    assert.ok(html.includes('น่าจะจ่ายพร้อมกัน 2 ร้าน'));
    assert.ok(html.includes('เสื้อยืด'));

    // Second run: everything is cached, so no detail pages are re-opened.
    const again = await run();
    assert.ok(/ต้องเปิดดูรายละเอียดใหม่ 0/.test(again), again);
    // Report-only works offline.
    await run('--report-only', '--include-cancelled');
    assert.ok(/2026-10,3,509/.test(fs.readFileSync(path.join(out, 'monthly.csv'), 'utf8')));
    assert.ok(/200005,[^\r\n]*ยกเลิก/.test(fs.readFileSync(path.join(out, 'orders.csv'), 'utf8')));
    console.log('\nE2E OK');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
