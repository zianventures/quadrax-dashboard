// qx-v77 quote-health regression guard. Usage: node tests/quote-health.test.js [file.html]
// Runs the real qhObserve/quoteHealth/macroTileRows from index.html against deterministic replays. No network.
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };
const grab = (a, b) => { const i = src.indexOf(a), k = src.indexOf(b, i); return i >= 0 && k > i ? src.slice(i, k) : ''; };
const code = grab('  var QH_CLASS=', '  function paintMacroTiles(');
check('quote-health functions extractable', /function qhObserve/.test(code) && /function quoteHealth/.test(code) && /function macroTileRows/.test(code));
const C = {}; vm.runInNewContext(code + '; this.obs=qhObserve; this.health=quoteHealth; this.rows=macroTileRows; this.open=qhSessionOpen;', C);

const OPEN = Date.UTC(2026, 9, 28, 14, 0, 0);      // Wed 10:00 New York (EDT)
const SAT = Date.UTC(2026, 9, 31, 16, 0, 0);       // Sat 12:00 New York
const CME_BREAK = Date.UTC(2026, 9, 28, 21, 30, 0); // Wed 17:30 New York
const S = 1000;
const MIDS = { EURUSD: 1.11231, GBPUSD: 1.3301, AUDUSD: 0.70323, NZDUSD: 0.56059, USDJPY: 157.957, USDCAD: 1.40619,
  USDCHF: 0.829905, USDSEK: 9.95465, XAUUSD: 4162.255, XTIUSD: 100.735 };
const frame = (mid, sp, extra) => Object.assign({ bid: mid - sp / 2, ask: mid + sp / 2 }, extra || {});
const sp = s => MIDS[s] * 2e-5;
// Feed n frames of sym, one per `step` ms from t0; f(i) -> mid (or a raw frame object).
function feed(sym, rec, t0, n, step, f) { for (let i = 0; i < n; i++) { const m = f(i); rec = C.obs(sym, sym + '.q', rec, typeof m === 'object' ? m : frame(m, sp(sym)), t0 + i * step); } return rec; }
const moving = sym => i => MIDS[sym] * (1 + 1e-5 * ((i % 7) - 3));
const st = (sym, rec, now, conn, ref) => C.health(sym, rec, now, conn === undefined ? true : conn, ref);

// GOLD exit gate: the observed failure (XAUUSD.q frozen at 4162.255 while frames keep arriving).
let everLive = false, g = null;
for (let i = 0; i < 600; i++) { const r = feed('XAUUSD', null, OPEN, i + 1, S, () => 4162.255); g = st('XAUUSD', r, OPEN + i * S); if (g.state === 'LIVE' || g.eligible) everLive = true; }
check('GOLD frozen at 4162.255 for 10 min is never LIVE or eligible', !everLive);
check('GOLD frozen: price never evidenced live is withheld', g.shown === false && g.state === 'STALE');
// Frozen after having been live: SUSPECT then STALE, never LIVE.
let gl = feed('XAUUSD', null, OPEN, 10, S, moving('XAUUSD'));
check('GOLD moving: LIVE after 3 valid changes', st('XAUUSD', gl, OPEN + 9 * S).state === 'LIVE');
const t9 = OPEN + 9 * S, glMid = (gl.bid + gl.ask) / 2;
gl = feed('XAUUSD', gl, t9 + S, 400, S, () => glMid);
const hAt = q => st('XAUUSD', Object.assign({}, gl, { ts: t9 + q }), t9 + q);
check('repeated identical frames: 60 s -> UNCHANGED (eligible)', hAt(60 * S).state === 'UNCHANGED' && hAt(60 * S).eligible);
check('repeated identical frames: 150 s -> SUSPECT (not eligible, last mid shown)', hAt(150 * S).state === 'SUSPECT' && !hAt(150 * S).eligible && hAt(150 * S).shown);
check('repeated identical frames: 301 s -> STALE', hAt(301 * S).state === 'STALE' && !hAt(301 * S).eligible);

// Quiet but valid market on a thin symbol: wider windows.
let sek = feed('USDSEK', null, OPEN, 5, S, moving('USDSEK'));
const sekQ = q => st('USDSEK', Object.assign({}, sek, { ts: OPEN + 4 * S + q }), OPEN + 4 * S + q);
check('quiet thin market: USDSEK 150 s unchanged is UNCHANGED, still eligible', sekQ(150 * S).state === 'UNCHANGED' && sekQ(150 * S).eligible);
check('quiet thin market: USDSEK 310 s -> SUSPECT', sekQ(310 * S).state === 'SUSPECT');

// Frozen provider timestamp: prices tick, source clock does not.
let fz = feed('EURUSD', null, OPEN, 200, S, i => frame(moving('EURUSD')(i), sp('EURUSD'), { timestamp: OPEN / 1000 }));
check('provider timestamp parsed (seconds -> ms)', fz.provTs === OPEN);
check('frozen source timestamp 199 s -> SUSPECT despite moving prices', st('EURUSD', fz, OPEN + 199 * S).state === 'SUSPECT');
fz = feed('EURUSD', fz, OPEN + 200 * S, 120, S, i => frame(moving('EURUSD')(i), sp('EURUSD'), { timestamp: new Date(OPEN).toISOString() }));
check('frozen source timestamp 319 s -> STALE (ISO form)', st('EURUSD', fz, OPEN + 319 * S).state === 'STALE');
const nots = feed('EURUSD', null, OPEN, 10, S, moving('EURUSD'));
check('missing provider timestamp: change-based health still LIVE', nots.provTs === null && st('EURUSD', nots, OPEN + 9 * S).state === 'LIVE');

// Bad bid/ask and isolation.
let eu = feed('EURUSD', null, OPEN, 10, S, moving('EURUSD'));
const lastBid = eu.bid;
const bad = [{ bid: 1.1, ask: 1.0 }, { bid: 0, ask: 1.1 }, { bid: 'x', ask: 1.1 }, { bid: 1.0, ask: 1.2 }, {}];
check('bad bid/ask (crossed, zero, NaN, 18% spread, missing) -> INVALID, last valid kept, number withheld',
  bad.every(b => { const r = C.obs('EURUSD', 'EURUSD.q', eu, b, OPEN + 10 * S), h = st('EURUSD', r, OPEN + 10 * S); return h.state === 'INVALID' && !h.eligible && !h.shown && r.bid === lastBid && r.run === 0; }));
const recs = {}; Object.keys(MIDS).forEach(s => { recs[s] = feed(s, null, OPEN, 10, S, moving(s)); });
recs.USDJPY = C.obs('USDJPY', 'USDJPY.q', recs.USDJPY, { bid: 158, ask: 157 }, OPEN + 10 * S);
const now10 = OPEN + 10 * S;
check('invalid-data isolation: one INVALID symbol, the other nine LIVE',
  st('USDJPY', recs.USDJPY, now10).state === 'INVALID' && Object.keys(MIDS).filter(s => s !== 'USDJPY').every(s => st(s, recs[s], now10).state === 'LIVE'));
const afterBad = feed('USDJPY', recs.USDJPY, now10 + S, 3, S, moving('USDJPY'));
check('recovery from INVALID needs 3 fresh valid changes', st('USDJPY', feed('USDJPY', recs.USDJPY, now10 + S, 2, S, moving('USDJPY')), now10 + 2 * S).state === 'UNVERIFIED'
  && st('USDJPY', afterBad, now10 + 3 * S).state === 'LIVE');

// One stale among ten; downstream DXY / tiles.
recs.USDJPY = feed('USDJPY', null, OPEN, 10, S, moving('USDJPY'));
const get = (over, now) => s => recs[s] ? st(s, (over && over[s]) || recs[s], now) : null;
const frozenX = Object.assign({}, recs.XAUUSD, { chgTs: now10 - 400 * S, ts: now10 });
const rows = C.rows(get({ XAUUSD: frozenX }, now10)), by = l => rows.filter(r => r.label === l)[0];
check('one stale symbol among ten: GOLD STALE, DXY/WTI/GBP/AUD unaffected and LIVE',
  by('GOLD · XAU').status === 'STALE · CENTROID' && by('DXY INDEX').status === 'LIVE · CENTROID'
  && by('WTI OIL').status === 'LIVE · CENTROID' && by('GBP/USD').status === 'LIVE · CENTROID' && by('AUD/USD').status === 'LIVE · CENTROID');
const legStale = C.rows(get({ USDCHF: Object.assign({}, recs.USDCHF, { chgTs: now10 - 400 * S }) }, now10));
check('DXY preservation: one stale leg -> DXY CENTROID FEED UNAVAILABLE', legStale[0].value === 'CENTROID FEED UNAVAILABLE');
const dxy = Number(by('DXY INDEX').value);
check('DXY preservation: ICE value from live legs (~102.4)', Math.abs(dxy - 102.405) < 0.05);
check('WTI preservation: XTIUSD streams LIVE with 2 dp', /^100\.7\d$/.test(by('WTI OIL').value));

// Spot/futures mismatch and independent-source disagreement.
const goldLive = feed('XAUUSD', null, OPEN, 10, S, i => 4162.255 + i * 0.1), gt = OPEN + 9 * S, gm = 4162.255 + 0.45;
check('spot/futures mismatch: Centroid 4162 vs GC=F 4054.7 (2.65%) -> DISPUTED, number withheld',
  (h => h.state === 'DISPUTED' && !h.eligible && !h.shown && Math.abs(h.mid - gm) < 1)(st('XAUUSD', goldLive, gt, true, { mid: 4054.7, ts: gt, kind: 'futures' })));
check('futures basis inside 2% is not a dispute', st('XAUUSD', goldLive, gt, true, { mid: 4130, ts: gt, kind: 'futures' }).state === 'LIVE');
check('independent spot disagreement 1% -> DISPUTED', st('XAUUSD', goldLive, gt, true, { mid: gm * 1.01, ts: gt, kind: 'spot' }).state === 'DISPUTED');
check('reference older than 30 min is ignored', st('XAUUSD', goldLive, gt, true, { mid: 3000, ts: gt - 31 * 60 * S, kind: 'spot' }).state === 'LIVE');
check('reference is never substituted for the Centroid value', st('XAUUSD', goldLive, gt, true, { mid: 4054.7, ts: gt, kind: 'futures' }).mid !== 4054.7);

// Market closed.
const satRec = feed('EURUSD', null, SAT, 10, S, moving('EURUSD'));
check('market closed: Saturday -> MARKET CLOSED, not eligible', st('EURUSD', satRec, SAT + 9 * S).state === 'MARKET CLOSED' && !st('EURUSD', satRec, SAT + 9 * S).eligible);
check('CME daily break: XAU closed at 17:30 NY while EURUSD open', !C.open('cme', CME_BREAK) && C.open('fx', CME_BREAK));
check('sessions: Sun 17:30 NY FX open / CME closed; Fri 16:59 open; Fri 17:00 closed',
  C.open('fx', Date.UTC(2026, 10, 1, 22, 30)) && !C.open('cme', Date.UTC(2026, 10, 1, 22, 30)) && C.open('fx', Date.UTC(2026, 9, 30, 20, 59)) && !C.open('fx', Date.UTC(2026, 9, 30, 21, 0)));

// Reconnection and recovery.
check('disconnected socket -> DISCONNECTED, not eligible', st('EURUSD', eu, OPEN + 9 * S, false).state === 'DISCONNECTED');
check('no frame for 9 s on a connected socket -> STALE', st('EURUSD', eu, OPEN + 18 * S).state === 'STALE');
const rc = Object.assign({}, eu, { run: 0 }); // what ws.onopen does to every record
check('reconnect: last value not LIVE until re-evidenced', st('EURUSD', C.obs('EURUSD', 'EURUSD.q', rc, frame(MIDS.EURUSD * 1.00002, sp('EURUSD')), OPEN + 20 * S), OPEN + 20 * S).state === 'UNVERIFIED');
let rv = Object.assign({}, gl);
rv = feed('XAUUSD', rv, t9 + 400 * S, 1, S, () => glMid + 0.3);
check('recovery after STALE: first change -> UNVERIFIED (hysteresis)', rv.run === 1 && st('XAUUSD', rv, t9 + 400 * S).state === 'UNVERIFIED');
rv = feed('XAUUSD', rv, t9 + 401 * S, 2, S, i => glMid + 0.4 + i * 0.1);
check('recovery: third consecutive change -> LIVE', st('XAUUSD', rv, t9 + 402 * S).state === 'LIVE');

// No synthetic fallback.
check('never-streamed symbol -> UNVERIFIED with no mid', (h => h.state === 'UNVERIFIED' && h.mid === null && !h.shown)(st('XAUUSD', null, OPEN)));
check('no Centroid -> every priced tile CENTROID FEED UNAVAILABLE', C.rows(() => null).slice(0, 5).every(r => r.value === 'CENTROID FEED UNAVAILABLE'));
check('quote-health source has no public/synthetic fallback', !/(fxSpot|lastKnown|MacroFeed|yahoo|Math\.random)/i.test(code));

// Wiring in the Market IIFE.
check('handle() records via qhObserve', /quotes\[sym\]=qhObserve\(sym,raw,quotes\[sym\],s,now\)/.test(src));
check('ws.onopen resets run for every symbol', /ws\.onopen=function\(\)\{[^\n]*\n[^\n]*quotes\[k\]\.run=0/.test(src));
check('Market.quote() uses Centroid EURUSD only when eligible', /h\.eligible && isFinite\(q\.bid\)/.test(src));
check('centroidQuote returns quoteHealth', /function centroidMid\(sym\)\{[^\n]*quoteHealth\(sym,q,Date\.now\(\),state==="LIVE_CENTROID"\)/.test(src));
check('QXMarket exposes quoteHealth', /quoteHealth:function\(\)\{/.test(src));

console.log(`\n${path.basename(file)}: ${fails ? fails + ' FAILED' : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
