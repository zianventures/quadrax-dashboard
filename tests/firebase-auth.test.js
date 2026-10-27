// Firebase auth-state guard (qx-v73). Usage: node tests/firebase-auth.test.js [file.html]
// Runs the real FirebaseSync IIFE against a mocked firebase SDK. No network, no real credentials.
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
const swSrc = fs.readFileSync(path.join(path.dirname(file), 'service-worker.js'), 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };

const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let bad = 0; scripts.forEach(s => { try { new vm.Script(s); } catch (e) { bad++; } });
check(`all ${scripts.length} inline scripts parse`, bad === 0);

const m = src.match(/const FirebaseSync=\(\(\)=>\{[\s\S]*?\n\}\)\(\);\r?\n\/\/ qx-v73[^\n]*\n[\s\S]*?\n\}\);/);
check('FirebaseSync IIFE + facade extractable', !!m);
if (!m) { console.log('\nFAILED'); process.exit(1); }
const code = m[0];
check('no Firestore enablePersistence (no durable cache)', !/enablePersistence\(/.test(code));
check('auth persistence set to NONE', /setPersistence\(firebase\.auth\.Auth\.Persistence\.NONE\)/.test(code));
check('header pill no longer hardcodes MASTER · DESK 01', !/DESK 01/.test(src) && /id="qxRoleTxt"[^>]*>STANDALONE</.test(src));
const swV = (swSrc.match(/CACHE_VERSION = 'qx-v(\d+)'/) || [])[1], regV = (src.match(/service-worker\.js\?v=(\d+)/) || [])[1];
check(`SW versions consistent (qx-v${swV} / ?v=${regV})`, swV && swV === regV);

const PW = 'TEST-PW-not-real', TOKEN = 'TEST-ID-TOKEN';
function env(opts = {}) {
  const calls = { persistence: [], signIn: 0, signOut: 0, clearPersistence: 0, sub: 0, unsub: 0, set: 0, init: 0 };
  const logs = [], events = [];
  const authListeners = [];
  const auth = {
    currentUser: opts.restoredUser ? { uid: 'restored' } : null,
    setPersistence: async p => { calls.persistence.push(p); },
    signOut: async () => { calls.signOut++; auth.currentUser = null; authListeners.forEach(f => f(null)); },
    onAuthStateChanged: f => { authListeners.push(f); },
    signInWithEmailAndPassword: async (em, pw) => {
      calls.signIn++;
      if (opts.gate) await opts.gate;
      if (opts.error) { const e = new Error('mock'); e.code = opts.error; throw e; }
      const user = { uid: 'u1', getIdTokenResult: async () => ({ token: TOKEN, claims: opts.claims || {} }) };
      auth.currentUser = user; return { user };
    },
  };
  const doc = { onSnapshot: () => { calls.sub++; return () => { calls.unsub++; }; }, set: async () => { calls.set++; } };
  const firestore = () => ({ clearPersistence: async () => { calls.clearPersistence++; }, collection: () => ({ doc: () => doc }) });
  firestore.FieldValue = { serverTimestamp: () => 0 };
  const authFn = () => auth; authFn.Auth = { Persistence: { NONE: 'none', LOCAL: 'local' } };
  const firebase = { apps: [], initializeApp: () => { calls.init++; firebase.apps.push({}); }, auth: authFn, firestore };
  const con = {}; ['log', 'warn', 'error', 'info'].forEach(k => { con[k] = (...a) => logs.push(a.map(String).join(' ')); });
  const window = { dispatchEvent: e => events.push(e) };
  const ctx = {
    firebase, console: con, window, setInterval: () => 0, setTimeout, clearTimeout, Date,
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    document: { addEventListener: () => {}, visibilityState: 'visible' },
    $: () => null, setFxStatus: () => {},
  };
  vm.runInNewContext(code + ';this.FS=FirebaseSync;', ctx);
  return { FS: ctx.FS, facade: window.FirebaseSync, calls, logs, events, auth };
}
const CFG = { apiKey: 'x', projectId: 'p' };
const leak = e => e.logs.join('\n').includes(PW) || e.logs.join('\n').includes(TOKEN) || e.logs.join('\n').includes('user@test.invalid') ||
  JSON.stringify(e.events.map(x => x.detail)).includes(PW) || JSON.stringify(e.FS.authState).includes(TOKEN);

(async () => {
  // Migration from a <=qx-v72 persisted (IndexedDB) session
  let e = env({ restoredUser: true });
  await e.FS.purgePersisted(CFG); await e.FS.purgePersisted(CFG);
  check('restored session: persistence NONE applied', e.calls.persistence[0] === 'none');
  check('restored session: signed out before any listener', e.calls.signOut === 1 && e.auth.currentUser === null);
  check('Firestore disk cache cleared, purge memoized (once)', e.calls.clearPersistence === 1);
  check('state after purge: DISCONNECTED / STANDALONE', e.FS.authState.state === 'DISCONNECTED' && e.FS.role === 'STANDALONE');

  // Roles from verified claim only
  for (const [claims, role, label, master] of [[{ role: 'MASTER' }, 'MASTER', 'MASTER', true], [{ role: 'READER' }, 'READER', 'READER', false],
    [{}, 'NO_ROLE', 'NO ROLE', false], [{ role: 'master' }, 'NO_ROLE', 'NO ROLE', false], [{ admin: true }, 'NO_ROLE', 'NO ROLE', false]]) {
    e = env({ claims });
    await e.FS.init(CFG, 'user@test.invalid', PW);
    check(`claims ${JSON.stringify(claims)} → CONNECTED/${role}, MASTER=${master}`,
      e.FS.authState.state === 'CONNECTED' && e.FS.authState.role === role && e.FS.role === label && e.FS.isMaster === master && e.facade.role === label);
    check(`claims ${JSON.stringify(claims)}: no password/token/email in logs or events`, !leak(e));
  }
  e = env({ claims: {} }); await e.FS.init(CFG, 'user@test.invalid', PW);
  await e.FS.writeState({ policy: 'x' });
  check('NO_ROLE never writes state', e.calls.set === 0);

  // Failure paths (mocked — no production attempts)
  e = env({ error: 'auth/invalid-credential' }); await e.FS.init(CFG, 'user@test.invalid', PW);
  check('invalid-credential → AUTH_ERROR with actionable message', e.FS.authState.state === 'AUTH_ERROR' && /Wrong email or password/.test(e.FS.authState.msg) && !e.FS.configured);
  check('error path: no password in logs', !leak(e));
  e = env({ error: 'auth/too-many-requests' }); await e.FS.init(CFG, 'user@test.invalid', PW);
  check('too-many-requests → RATE_LIMITED, single sign-in attempt (no retry loop)', e.FS.authState.state === 'RATE_LIMITED' && e.calls.signIn === 1);
  e = env({ error: 'auth/weird-thing' }); await e.FS.init(CFG, 'user@test.invalid', PW);
  check('unknown error → sanitized "Sign-in failed [code]"', e.FS.authState.msg === 'Sign-in failed [auth/weird-thing]');

  // Duplicate submissions while pending
  let release; const gate = new Promise(r => { release = r; });
  e = env({ claims: { role: 'READER' }, gate });
  const p1 = e.FS.init(CFG, 'user@test.invalid', PW), p2 = e.FS.init(CFG, 'user@test.invalid', PW);
  await new Promise(r => setTimeout(r, 10));
  check('pending: state CONNECTING, second submit ignored', e.FS.authState.state === 'CONNECTING' && e.calls.signIn === 1);
  release(); await Promise.all([p1, p2]);
  check('pending released after completion', e.FS.authState.state === 'CONNECTED');

  // Logout + listener cleanup, then reauthentication
  let snaps = 0;
  e.FS.subscribeState(() => { snaps++; });
  await e.facade.signOut();
  check('signOut detaches Firestore listener', e.calls.unsub === 1);
  check('signOut → DISCONNECTED, STANDALONE, not configured', e.FS.authState.state === 'DISCONNECTED' && e.FS.role === 'STANDALONE' && !e.FS.configured && !e.FS.isReader);
  check('signOut dispatches qx-auth-signout (UI clears lastFullState)', e.events.some(x => x.type === 'qx-auth-signout'));
  e.FS.subscribeState(() => { snaps++; });
  check('signed-out: subscribeState attaches no listener', e.calls.sub === 1 && e.FS.authState.state === 'DISCONNECTED');
  await e.FS.init(CFG, 'user@test.invalid', PW);
  check('reauthentication succeeds after signOut', e.FS.authState.state === 'CONNECTED' && e.FS.role === 'READER');
  e = env({ claims: { role: 'READER' } }); await e.FS.init(CFG, 'user@test.invalid', PW);
  e.FS.subscribeState(() => {}); await e.auth.signOut();
  check('external sign-out (auth state null) also tears down listener', e.calls.unsub === 1 && e.FS.authState.state === 'DISCONNECTED');

  // Facade is read-only
  check('window.FirebaseSync facade is frozen, exposes no init/writeState', Object.isFrozen(e.facade) && !('init' in e.facade) && !('writeState' in e.facade));

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
