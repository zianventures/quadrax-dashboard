// Centroid v70 protocol regression guard. Usage: node tests/centroid-v70.test.js [file.html|file.js]
// Fails if a candidate build reverts the verified v70 WS protocol (eb9091e). No network, no secrets.
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };

check('WS URL is ws?q=<client_code>&token=<token>', /wss:\/\/bridge\.centroidsol\.com\/ws\?q="\+encodeURIComponent\(creds\.code[^)]*\)\+"&token="/.test(src));
check('no token-first WS URL', !/\/ws\?token=/.test(src));
check('symbol constant is EURUSD.q', /CENTROID_SYMBOL\s*=\s*"EURUSD\.q"/.test(src));

const subsM = src.match(/CENTROID_SUBSCRIBE_MSGS\s*=\s*(\[[\s\S]*?\]);/);
let subs = [];
try { subs = subsM ? vm.runInNewContext(subsM[1], { CENTROID_SYMBOL: 'EURUSD.q' }) : []; } catch (e) {}
check('3 subscribe frames in order fix_conn_status / dashboard_data:unsubscribe / symbol:EURUSD.q',
  JSON.stringify(subs) === JSON.stringify([{ key: 'fix_conn_status' }, { key: 'dashboard_data', value: 'unsubscribe' }, { key: 'symbol', value: 'EURUSD.q' }]));
check('no position subscribe frame', !subs.some(m => m && m.key === 'position'));

// Behavioural parse test: run the real handle() against v70 and legacy frame shapes.
const hM = src.match(/function handle\(data\)\{[\s\S]*?(?=\r?\n\s*function reconnect)/);
check('handle() extractable', !!hM);
if (hM) {
  const ctx = { quotes: {}, lastMsgTs: 0, state: '', T: { rawMsgs: 0, pricePubs: 0, feedFrames: 0, symbolsSeen: [] } };
  ctx.setState = s => { ctx.state = s; };
  vm.runInNewContext(hM[0] + '; this.handle = handle;', ctx);
  ctx.handle(JSON.stringify({ feed_symbols: [{ feed: 'EURUSD.q', bid: 1.0801, ask: 1.0803, bid_vol: 5 }] }));
  const q1 = ctx.quotes.EURUSD;
  check('parses feed + bid/ask (v70 shape)', !!q1 && q1.bid === 1.0801 && q1.ask === 1.0803 && q1.bidVol === 5);
  ctx.handle(JSON.stringify({ feed_symbols: [{ symbol: 'EURUSD.q', bid_price: 1.0805, ask_price: 1.0807 }] }));
  const q2 = ctx.quotes.EURUSD;
  check('parses symbol + bid_price/ask_price (legacy shape)', !!q2 && q2.bid === 1.0805 && q2.ask === 1.0807);
  check('state LIVE_CENTROID only after feed frames', ctx.state === 'LIVE_CENTROID' && ctx.T.feedFrames === 2);
  ctx.state = ''; ctx.handle(JSON.stringify({ key: 'fix_conn_status', value: 'ok' }));
  check('non-feed frame does not fake LIVE', ctx.state === '');
}

check('no hardcoded Centroid password/token literal', !/(password|pass|token)\s*:\s*"[^"%]{6,}"/i.test(src));

console.log(`\n${path.basename(file)}: ${fails ? fails + ' FAILED' : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
