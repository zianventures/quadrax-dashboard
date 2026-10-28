// Logout / disconnect state guard (qx-v75). Usage: node tests/logout-state.test.js [file.html]
// Runs the real FirebaseSync IIFE and Market session functions against mocks. No network, no real credentials.
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };
const tick = () => new Promise(r => setTimeout(r, 5));

// ── Firebase: generation guard against late async callbacks ──────────────────
const m = src.match(/const FirebaseSync=\(\(\)=>\{[\s\S]*?\n\}\)\(\);\r?\n\/\/ qx-v73[^\n]*\n[\s\S]*?\n\}\);/);
check('FirebaseSync IIFE extractable', !!m);
const PW = 'TEST-PW-not-real';
function env(opts = {}) {
  const calls = { signOut: 0, sub: 0, unsub: 0 }, events = [], authListeners = [], snapCbs = [];
  const auth = {
    currentUser: null,
    setPersistence: async () => {},
    signOut: async () => { calls.signOut++; auth.currentUser = null; authListeners.forEach(f => f(null)); },
    onAuthStateChanged: f => { authListeners.push(f); },
    signInWithEmailAndPassword: async () => {
      if (opts.gate) await opts.gate;
      const user = { uid: 'u1', getIdTokenResult: async () => ({ token: 'T', claims: { role: 'READER' } }) };
      auth.currentUser = user; return { user };
    },
  };
  const doc = { onSnapshot: (ok, err) => { calls.sub++; snapCbs.push({ ok, err }); return () => { calls.unsub++; }; }, set: async () => {} };
  const firestore = () => ({ clearPersistence: async () => {}, collection: () => ({ doc: () => doc }) });
  firestore.FieldValue = { serverTimestamp: () => 0 };
  const authFn = () => auth; authFn.Auth = { Persistence: { NONE: 'none' } };
  const firebase = { apps: [], initializeApp: () => { firebase.apps.push({}); }, auth: authFn, firestore };
  const con = { log() {}, warn() {}, error() {}, info() {} };
  const window = { dispatchEvent: e => events.push(e) };
  const ctx = {
    firebase, console: con, window, setInterval: () => 0, setTimeout, clearTimeout, Date,
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    document: { addEventListener: () => {}, visibilityState: 'visible' }, $: () => null, setFxStatus: () => {},
  };
  vm.runInNewContext(m[0] + ';this.FS=FirebaseSync;', ctx);
  return { FS: ctx.FS, facade: window.FirebaseSync, calls, events, auth, snapCbs };
}
const CFG = { apiKey: 'x', projectId: 'p' };

(async () => {
  if (m) {
    // Sign-out while sign-in is still in flight: the late result must not configure the session.
    let release; const gate = new Promise(r => { release = r; });
    let e = env({ gate });
    const p = e.FS.init(CFG, 'user@test.invalid', PW);
    await tick();
    await e.facade.signOut();
    release(); await p;
    check('sign-out during in-flight sign-in: late result discarded (not configured, STANDALONE)',
      !e.FS.configured && e.FS.role === 'STANDALONE' && e.FS.authState.state === 'DISCONNECTED');
    check('sign-out during in-flight sign-in: late user signed out again', e.auth.currentUser === null && e.calls.signOut >= 2);

    // Snapshot that arrives after sign-out must not reach the UI.
    e = env(); await e.FS.init(CFG, 'user@test.invalid', PW);
    let snaps = 0, errs = 0;
    e.FS.subscribeState(() => { snaps++; });
    const cb = e.snapCbs[0];
    await e.facade.signOut();
    cb && cb.ok({ exists: true, data: () => ({ policy: 'late' }) });
    cb && cb.err && cb.err({ code: 'permission-denied' });
    check('snapshot callback after sign-out is ignored', !!cb && snaps === 0 && e.FS.authState.state === 'DISCONNECTED');
    check('listener detached on sign-out', e.calls.unsub === 1);

    // External sign-out (token revoked / other tab) dispatches the same signal the UI reloads on.
    e = env(); await e.FS.init(CFG, 'user@test.invalid', PW);
    await e.auth.signOut();
    check('auth state null dispatches qx-auth-signout', e.events.some(x => x.type === 'qx-auth-signout'));
  }

  // ── UI: sign-out reloads to drop DOM, memory, timers and listeners ─────────
  const h = src.match(/window\.addEventListener\("qx-auth-signout",\(\)=>\{[\s\S]*?\n\}\);/);
  check('qx-auth-signout handler extractable', !!h);
  if (h) {
    const run = (configured, state) => {
      let reloads = 0, listener;
      const ctx = { window: { __qxAuthConfigured: configured, addEventListener: (t, f) => { listener = f; } },
        location: { reload: () => { reloads++; } }, lastFullState: state, setFxStatus() {} };
      vm.runInNewContext(h[0] + ';', ctx); listener();
      return { reloads, ctx };
    };
    const a = run(true, { x: 1 });
    check('sign-out with authenticated state: state cleared and page reloaded', a.reloads === 1 && a.ctx.lastFullState === null && a.ctx.window.__qxAuthConfigured === false);
    check('sign-out with no authenticated state: no reload loop', run(false, null).reloads === 0);
  }
  check('settings prefs survive reload (save keeps non-credential keys)', /function save\(k,v\)\{try\{if\(k===KEY\.s\)\{v=Object\.assign\(\{\},v\);delete v\.fbEmail;delete v\.fbPassword;\}localStorage\.setItem/.test(src));

  // ── Centroid: password field and reconnect credentials ─────────────────────
  check('#qxsPass cleared right after it is read on connect', /pass:\$\("#qxsPass"\)\.value[^\n]*\n\s*\$\("#qxsPass"\)\.value="";/.test(src));
  check('#qxsPass cleared on disconnect', /\$\("#qxsDisc",settingsEl\)\.addEventListener\("click",function\(\)\{ Market\.disconnect\(\); \$\("#qxsPass"\)\.value="";/.test(src));
  check('no pricePubs counter left', !/pricePubs/.test(src));

  const grab = (a, b) => { const i = src.indexOf(a), k = src.indexOf(b, i); return i >= 0 && k > i ? src.slice(i, k) : ''; };
  const sessSrc = [grab('function centroidSubscribeMsgs(alias){', 'var Market=(function(){'),
    grab('    function purgeStored(){', '    function tdKey(){'), grab('    function setState(', '\n'),
    grab('    async function getToken(){', '    function handle(data){'),
    grab('    function reconnect(){', '    function pipFactor(')].join('\n');
  check('Market session functions extractable', /async function connect/.test(sessSrc) && /function disconnect/.test(sessSrc));
  const session = (status) => {
    const timers = [], sockets = [];
    const ctx = {
      T: {}, ws: null, token: null, alias: null, riskCount: 0, creds: null, remember: false, state: '', msg: '',
      attempts: 0, timer: null, manualClose: false, CENTROID_SYMBOL: 'EURUSD.q', CENTROID_TOKEN_BROKER_URL: '',
      window: {}, sessionStorage: { removeItem() {} }, localStorage: { removeItem() {} }, console: { log() {}, warn() {}, error() {} },
      setTimeout: f => { timers.push(f); return timers.length; }, clearTimeout() {}, handle() {}, JSON, Math, Date, String, Array, Object, Error,
      fetch: async () => (status === 200
        ? { ok: true, status, json: async () => ({ token: 'tk', user: { client_code: 'CC01', user_risk_accounts: [{ alias: 'A' }] } }) }
        : { ok: false, status, json: async () => ({}) }),
      WebSocket: function () { this.send = () => {}; this.close = () => {}; sockets.push(this); },
    };
    vm.runInNewContext(sessSrc, ctx);
    return { ctx, timers, sockets };
  };
  for (const st of [401, 403]) {
    const s = session(st);
    const ok = await s.ctx.connect({ user: 'u', pass: PW }, false);
    check(`login ${st}: credentials destroyed, CREDENTIALS_REQUIRED, no reconnect scheduled`,
      ok === false && s.ctx.creds === null && s.ctx.token === null && s.ctx.state === 'CREDENTIALS_REQUIRED' && s.timers.length === 0);
  }
  const s5 = session(500);
  await s5.ctx.connect({ user: 'u', pass: PW }, false);
  check('login 500: transient failure keeps memory creds and schedules reconnect', s5.ctx.creds !== null && s5.timers.length === 1);
  const sd = session(200);
  await sd.ctx.connect({ user: 'u', pass: PW }, false);
  sd.ctx.disconnect();
  check('explicit disconnect destroys reconnect credentials', sd.ctx.creds === null && sd.ctx.token === null && sd.ctx.alias === null && sd.ctx.state === 'DISCONNECTED');
  sd.timers.forEach(f => f());
  check('no reconnect after explicit disconnect', sd.sockets.length === 1);

  console.log(`\n${path.basename(file)}: ${fails ? fails + ' FAILED' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
})();
