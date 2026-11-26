// A tiny fake Shopee site used to test the scraper end to end without a real account.
// The JSON shapes imitate Shopee's v4 order API (money is baht * 100000).
'use strict';
const http = require('http');

const S = 100000;
const T0 = Date.UTC(2026, 9, 20, 5, 0) / 1000; // 20 Oct 2026 12:00 Bangkok

function order(id, shop, items, total, time, extra = {}) {
  return { id, shop, items, total, time, ...extra };
}
const ORDERS = [
  // two shops paid in one checkout (has checkout_id)
  order('200001', 'ร้านเสื้อ A', [['เสื้อยืด', 'ดำ, L', 2, 199]], 418, T0 + 86400 * 20, { checkout: '9001', pay: 'บัตรเครดิต/บัตรเดบิต', card: 'VISA ****1234' }),
  order('200002', 'ร้านแก้ว B', [['แก้วน้ำ', '', 1, 150]], 150, T0 + 86400 * 20, { checkout: '9001', pay: 'บัตรเครดิต/บัตรเดบิต', card: 'VISA ****1234' }),
  // two shops, no checkout id, 30 s apart, same card -> grouped by time
  order('200003', 'ร้าน C', [['สายชาร์จ', 'USB-C', 1, 89]], 89, T0 + 86400 * 5, { pay: 'บัตรเครดิต/บัตรเดบิต', card: 'Mastercard **** 5678' }),
  order('200004', 'ร้าน D', [['เคส', '', 1, 120]], 120, T0 + 86400 * 5 + 30, { pay: 'บัตรเครดิต/บัตรเดบิต', card: 'Mastercard **** 5678' }),
  // cancelled
  order('200005', 'ร้าน E', [['ของเล่น', '', 1, 300]], 300, T0, { pay: 'ShopeePay', cancelled: true }),
  // previous month, COD, has a masked phone number that must NOT be read as a card
  order('200006', 'ร้าน F', [['หนังสือ', '', 3, 100]], 330, T0 - 86400 * 30, { pay: 'ชำระเงินปลายทาง' }),
];

function listJson(offset, limit) {
  const slice = ORDERS.slice(offset, offset + limit);
  return {
    error: 0,
    data: {
      order_data: {
        details_list: slice.map((o) => ({
          info_card: {
            final_total: o.total * S,
            order_list_cards: [{
              order_id: Number(o.id),
              shop_info: { shop_id: 1, shop_name: o.shop },
              product_info: { item_groups: [{ items: o.items.map(([name, model, amount, price], i) => ({ item_id: i + 1, model_id: 1, name, model_name: model, amount, item_price: price * S, order_price: price * amount * S })) }] },
            }],
          },
          status: { list_view_status_label: { text: o.cancelled ? 'label_order_cancelled' : 'label_order_completed' } },
        })),
      },
      next_offset: offset + limit < ORDERS.length ? offset + limit : -1,
    },
  };
}

function detailJson(id) {
  const o = ORDERS.find((x) => x.id === id);
  return {
    error: 0,
    data: {
      ...(o.checkout ? { checkout_id: Number(o.checkout) } : {}),
      address: { phone: '(+66) 81****6789', name: 'ผู้รับ' },
      info_card: { final_total: o.total * S, order_list_cards: [{ order_id: Number(id), shop_info: { shop_name: o.shop } }] },
      processing_info: {
        info_rows: [
          { info_label: { text: 'label_odp_order_time' }, info_value: { value: o.time } },
          { info_label: { text: 'label_odp_payment_time' }, info_value: { value: o.time + 20 } },
        ],
      },
      payment_info: { payment_method: { payment_method_name: o.pay, card_info: o.card || '' } },
      status: { header_text: { text: o.cancelled ? 'label_order_cancelled' : 'label_order_completed' } },
    },
  };
}

const page = (body) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const loggedIn = /SPC_U=\d+/.test(req.headers.cookie || '');
    const send = (code, type, body, headers = {}) => { res.writeHead(code, { 'content-type': type, ...headers }); res.end(body); };
    if (u.pathname.startsWith('/api/v4/order/get_all_order_and_checkout_list')) {
      if (!loggedIn) return send(403, 'application/json', '{"error":19}');
      return send(200, 'application/json', JSON.stringify(listJson(Number(u.searchParams.get('offset')), Number(u.searchParams.get('limit')))));
    }
    if (u.pathname.startsWith('/api/v4/order/get_order_detail')) {
      return send(200, 'application/json', JSON.stringify(detailJson(u.searchParams.get('order_id'))));
    }
    if (u.pathname === '/buyer/login') {
      // "User" logs in after a short pause.
      return send(200, 'text/html', page(`<h1>login</h1><script>setTimeout(()=>{document.cookie='SPC_U=123;path=/';location.href=${JSON.stringify(u.searchParams.get('next') || '/')}},1500)</script>`));
    }
    if (u.pathname.startsWith('/user/purchase/order/')) {
      if (!loggedIn) return send(302, 'text/plain', '', { location: '/buyer/login?next=' + encodeURIComponent(u.pathname) });
      const id = u.pathname.split('/').pop();
      return send(200, 'text/html', page(`<div id=o></div><script>
fetch('/api/v4/order/get_order_detail?order_id=${id}').then(r=>r.json()).then(j=>{
  const d=j.data, p=d.payment_info.payment_method;
  const t=new Date(d.processing_info.info_rows[0].info_value.value*1000+7*3600e3);
  const pad=n=>String(n).padStart(2,'0');
  document.getElementById('o').innerText=[
    d.status.header_text.text.includes('cancel')?'คำสั่งซื้อถูกยกเลิก':'คำสั่งซื้อสำเร็จแล้ว',
    'ที่อยู่ในการจัดส่ง', d.address.name, d.address.phone,
    'ยอดคำสั่งซื้อทั้งหมด', '฿'+(d.info_card.final_total/100000).toLocaleString('en-US'),
    'วิธีการชำระเงิน', p.payment_method_name, p.card_info,
    'เวลาที่สั่งซื้อ', pad(t.getUTCDate())+'-'+pad(t.getUTCMonth()+1)+'-'+t.getUTCFullYear()+' '+pad(t.getUTCHours())+':'+pad(t.getUTCMinutes()),
  ].filter(Boolean).join('\\n');
});</script>`));
    }
    if (u.pathname.startsWith('/user/purchase')) {
      if (!loggedIn) return send(302, 'text/plain', '', { location: '/buyer/login?next=' + encodeURIComponent('/user/purchase/') });
      return send(200, 'text/html', page(`<div id=l style="min-height:120vh"></div><script>
let off=0, busy=false, done=false;
async function more(){ if(busy||done) return; busy=true;
  const j=await (await fetch('/api/v4/order/get_all_order_and_checkout_list?limit=2&offset='+off)).json();
  for(const d of j.data.order_data.details_list){ const div=document.createElement('div'); div.style.height='400px'; div.textContent=d.info_card.order_list_cards[0].shop_info.shop_name; document.getElementById('l').appendChild(div); }
  off+=2; if(j.data.next_offset<0) done=true; busy=false; }
more(); addEventListener('scroll',()=>{ if(innerHeight+scrollY>=document.body.scrollHeight-50) more(); });
</script>`));
    }
    send(200, 'text/html', page('home'));
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

module.exports = { start, ORDERS };
if (require.main === module) start(8765).then(() => console.log('mock on http://127.0.0.1:8765'));
