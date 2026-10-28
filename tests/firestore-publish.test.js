// qx-v79 change-aware Firestore publishing guard. Usage: node tests/firestore-publish.test.js [file.html]
// Runs the real MASTER write throttle from index.html on a fake clock and a fake Firestore. No network.
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };
const grab = (a, b) => { const i = src.indexOf(a), k = src.indexOf(b, i); return i >= 0 && k > i ? src.slice(i, k) : ''; };
const code = grab('  function _sanitise(payload){', '  return{\n    init,subscribeState');
check('write throttle extractable', /function writeState/.test(code) && /function _doWrite/.test(code));

async function run(minutes, tickMs, stateAt) {
  let now = Date.UTC(2026, 9, 28, 14, 0, 0), timers = [], seq = 0;
  const writes = [];
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const ctx = {
    Date: FakeDate, JSON, Math, Object, Promise, console: { log() {}, warn() {}, error() {} },
    setTimeout: (f, ms) => { const id = ++seq; timers.push({ id, at: now + ms, f }); return id; },
    clearTimeout: id => { timers = timers.filter(t => t.id !== id); },
    setInterval: (f, ms) => { const id = ++seq; const t = { id, at: now + ms, f, every: ms }; timers.push(t); return id; },
    db: { collection: () => ({ doc: () => ({ set: async d => { writes.push({ t: now, d }); } }) }) },
    auth: { currentUser: { uid: 'm' } }, firebase: { firestore: { FieldValue: { serverTimestamp: () => 0 } } },
    _isMaster: true,
  };
  vm.runInNewContext('let db=this.db,auth=this.auth,_isMaster=true;' + code + '; this.writeState=writeState; this.stats=()=>({writes:_writeCount,skipped:typeof _skipCount==="undefined"?0:_skipCount});', ctx);
  const flush = () => new Promise(r => setImmediate(r));
  const end = now + minutes * 60000;
  for (let t = now; t <= end; t += tickMs) {
    while (true) { // fire due timers in order
      timers.sort((a, b) => a.at - b.at); const d = timers[0];
      if (!d || d.at > t) break;
      now = d.at; if (d.every) d.at += d.every; else timers.shift();
      d.f(); await flush();
    }
    now = t; await ctx.writeState(stateAt((t - end + minutes * 60000) / 1000)); await flush();
  }
  const gaps = writes.slice(1).map((w, i) => w.t - writes[i].t);
  return { writes: writes.length, maxGap: Math.max(0, ...gaps), first: writes[0] && writes[0].t, stats: ctx.stats(), all: writes };
}
const base = { policy: 'HOLD', busDir: 'NEUTRAL', bias: 'NEUTRAL', spotPrice: 1.16231, stateName: 'S1', oilInt: 0.2, usdInt: 0.1, fearInt: 0.3 };

(async () => {
  // 60 min, 12 s recalc, nothing meaningful changes (sub-pip noise only)
  const flat = await run(60, 12000, s => ({ ...base, spotPrice: 1.16231 + ((s / 12) % 2) * 0.00001 }));
  console.log(`  flat 60 min: ${flat.writes} writes, ${flat.stats.skipped} skipped, max gap ${flat.maxGap / 1000}s`);
  check('flat state: no routine 30 s writes (<= 1 initial + 2-min heartbeats)', flat.writes <= 32);
  check('flat state: heartbeat keeps max gap within 2–5 min', flat.maxGap >= 120000 && flat.maxGap <= 300000);
  check('flat state: skipped routine writes are counted', flat.stats.skipped > 0);

  // price moves >= 1 pip every tick -> still at most one routine write per 30 s
  const moving = await run(60, 12000, s => ({ ...base, spotPrice: 1.16231 + Math.floor(s / 12) * 0.0002 }));
  console.log(`  moving 60 min: ${moving.writes} writes, max gap ${moving.maxGap / 1000}s`);
  check('moving state: writes continue at the 30 s cadence', moving.writes >= 100 && moving.maxGap <= 36000);

  // regime flips at t=300 s -> written within the 3 s urgent window, not after the 30 s routine wait
  const flip = await run(10, 12000, s => ({ ...base, stateName: s >= 300 ? 'S3' : 'S1' }));
  const fw = flip.all.find(w => w.d.stateName === 'S3');
  check('regime change is published immediately', fw && fw.t - (flip.first + 300000) <= 12000);

  // the last write always carries the newest state (no stale payload after skips)
  const late = await run(6, 12000, s => ({ ...base, spotPrice: s >= 200 ? 1.1650 : 1.16231 }));
  check('latest meaningful change reaches Firestore', late.all.some(w => w.d.spotPrice === 1.165));

  console.log(`\n${path.basename(file)}: ${fails ? fails + ' FAILED' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
})();
