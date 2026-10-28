// Centroid v70 protocol regression guard. Usage: node tests/centroid-v70.test.js [file.html|file.js]
// Fails if a candidate build reverts the verified v70 WS protocol (eb9091e) or the qx-v74 alias-qualified
// symbol frame (fixtures/centroid-protocol.fixture.json, placeholders only). No network, no secrets.
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };

check('WS URL is ws?q=<client_code>&token=<token>', /wss:\/\/bridge\.centroidsol\.com\/ws\?q="\+encodeURIComponent\(creds\.code[^)]*\)\+"&token="/.test(src));
check('no token-first WS URL', !/\/ws\?token=/.test(src));
check('symbol constant is EURUSD.q', /CENTROID_SYMBOL\s*=\s*"EURUSD\.q"/.test(src));

// qx-v74: symbol frame must match the live-verified fixture (alias-qualified; bare "EURUSD.q" is ignored).
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'centroid-protocol.fixture.json'), 'utf8'));
const ALIAS = '<RISK_ACCOUNT_ALIAS>';
const fnM = src.match(/function centroidSubscribeMsgs\(alias\)\{[\s\S]*?\n\s*\}\r?\n/);
check('centroidSubscribeMsgs(alias) extractable', !!fnM);
let subs = [], subsNoAlias = [];
try {
  const fctx = { CENTROID_SYMBOL: 'EURUSD.q' };
  vm.runInNewContext(fnM[0] + '; this.f = centroidSubscribeMsgs;', fctx);
  subs = fctx.f(ALIAS); subsNoAlias = fctx.f(null);
} catch (e) {}
check('3 subscribe frames in order fix_conn_status / dashboard_data:unsubscribe / alias-qualified symbol',
  JSON.stringify(subs) === JSON.stringify([{ key: 'fix_conn_status' }, { key: 'dashboard_data', value: 'unsubscribe' }, fx.working_symbol_frame]));
check('symbol value decodes to fixture', !!subs[2] && JSON.stringify(JSON.parse(subs[2].value)) === JSON.stringify(fx.working_symbol_value_decoded));
check('no symbol frame without alias', subsNoAlias.length === 2 && !subsNoAlias.some(m => m.key === 'symbol'));
check('no bare EURUSD.q symbol frame (fixture negative case)', !subs.concat(subsNoAlias).some(m => JSON.stringify(m) === JSON.stringify(fx.negative_cases[0].frame))
  && !/key:"symbol",value:(CENTROID_SYMBOL|"EURUSD\.q")/.test(src));
check('no not_authorized keys subscribed', !subs.some(m => fx.not_authorized_keys.includes(m.key)));
check('no position subscribe frame', !subs.some(m => m && m.key === 'position'));
check('alias read from login user_risk_accounts via centroidRiskAlias', /alias=centroidRiskAlias\(ra\)/.test(src) && /j\.user&&j\.user\.user_risk_accounts/.test(src));
check('onopen subscribes with centroidSubscribeMsgs(alias)', /\|\|centroidSubscribeMsgs\(alias\)/.test(src));
check('alias never persisted or traced', !/(setItem|saveCreds|T\.\w+\s*=)\([^)]*\balias\b[^)]*\)|T\.\w+\s*=\s*alias\b/.test(src));
check('alias cleared on clearCreds and disconnect', /function clearCreds\(\)\{[^}]*alias=null/.test(src) && /function disconnect\(\)\{[^\n]*alias=null/.test(src));

// Behavioural session test: real getToken/openSocket/connect/reconnect/disconnect with mocked fetch + WebSocket.
const grab = (a, b) => { const i = src.indexOf(a), k = src.indexOf(b, i); return i >= 0 && k > i ? src.slice(i, k) : ''; };
const sessSrc = [grab('function centroidSubscribeMsgs(alias){', 'var Market=(function(){'),
  grab('    function purgeStored(){', '    function tdKey(){'), grab('    function setState(', '\n'),
  grab('    async function getToken(){', '    function handle(data){'),
  grab('    function reconnect(){', '    function pipFactor(')].join('\n');
check('session functions extractable', /centroidRiskAlias/.test(sessSrc) && /async function connect/.test(sessSrc) && /function disconnect/.test(sessSrc));
const PASS = 'pw-' + 'test', TOK = 'tk-' + 'test';
function session(riskAccounts) {
  const sockets = [], logs = [], timers = [];
  const ctx = {
    T: {}, ws: null, token: null, alias: null, riskCount: 0, creds: null, remember: false, state: '', msg: '',
    attempts: 0, timer: null, manualClose: false, CENTROID_SYMBOL: 'EURUSD.q', CENTROID_TOKEN_BROKER_URL: '',
    window: {}, sessionStorage: { removeItem() {} }, localStorage: { removeItem() {} },
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {},
    handle() {}, JSON, Math, Date, String, Array, Object, Error,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ token: TOK, user: { client_code: 'CC01', user_risk_accounts: riskAccounts } }) }),
    WebSocket: function (url) { this.url = url; this.sent = []; this.send = m => this.sent.push(m); this.close = () => {}; sockets.push(this); },
  };
  vm.runInNewContext(sessSrc, ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { ctx, sockets, logs, flush };
}
(async () => {
  const one = session([{ alias: ALIAS }]);
  const ok1 = await one.ctx.connect({ user: 'u', pass: PASS }, false);
  one.sockets[0] && one.sockets[0].onopen(); one.flush();
  const sent1 = one.sockets[0] ? one.sockets[0].sent.map(m => JSON.parse(m)) : [];
  check('1 risk account: connects and sends the fixture symbol frame', ok1 === true && JSON.stringify(sent1[2]) === JSON.stringify(fx.working_symbol_frame) && one.ctx.T.riskAccounts === 1);
  one.sockets[0].onclose({ code: 1006 }); one.flush(); await new Promise(r => setImmediate(r));
  const s2 = one.sockets[1]; s2 && s2.onopen(); one.flush();
  check('reconnect re-authenticates and keeps the alias-qualified frame', !!s2 && JSON.stringify(JSON.parse(s2.sent[2])) === JSON.stringify(fx.working_symbol_frame));
  one.ctx.disconnect();
  check('disconnect clears alias and token', one.ctx.alias === null && one.ctx.token === null && one.ctx.state === 'DISCONNECTED');
  const leak = JSON.stringify(one.ctx.T) + one.logs.join('\n');
  check('alias/token/password absent from trace and logs', ![ALIAS, TOK, PASS].some(v => leak.includes(v)));

  const zero = session([]);
  const ok0 = await zero.ctx.connect({ user: 'u', pass: PASS }, false);
  check('0 risk accounts: fail closed (no socket, ERROR, accurate msg)', ok0 === false && zero.sockets.length === 0 && zero.ctx.state === 'ERROR' && /no risk account/.test(zero.ctx.msg) && zero.ctx.token === null);
  const none = session(undefined);
  check('missing user_risk_accounts: fail closed', (await none.ctx.connect({ user: 'u', pass: PASS }, false)) === false && none.sockets.length === 0);

  const many = session([{ alias: ALIAS }, { alias: '<OTHER_ALIAS>' }]);
  const okM = await many.ctx.connect({ user: 'u', pass: PASS }, false);
  check('2 risk accounts: no silent first-pick (no socket, ERROR, count in msg)', okM === false && many.sockets.length === 0 && many.ctx.state === 'ERROR' && /2 risk accounts/.test(many.ctx.msg) && many.ctx.alias === null);
  check('multi-account msg does not expose aliases', !/<OTHER_ALIAS>|RISK_ACCOUNT_ALIAS/.test(many.ctx.msg));

  const blank = session([{ alias: '' }]);
  check('1 risk account with empty alias: fail closed', (await blank.ctx.connect({ user: 'u', pass: PASS }, false)) === false && blank.sockets.length === 0);
  finish();
})();

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

function finish() {
  console.log(`\n${path.basename(file)}: ${fails ? fails + ' FAILED' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
}
