// qx-v81 v60.1 interface restoration guard. Usage: node tests/v81-restore.test.js [file.html]
// Static structure checks plus the real qx-v81-restore and qx-live-accounts scripts run against mocks.
// No network, no real credentials.
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
const sw = fs.readFileSync(path.join(path.dirname(file), 'service-worker.js'), 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };

// ── structure ────────────────────────────────────────────────────────────────
const markup = src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
check('no duplicate static element ids' + (dup.length ? ' (' + [...new Set(dup)].join(',') + ')' : ''), dup.length === 0);
const blocks = [...src.matchAll(/<script id="qx-v81-restore">([\s\S]*?)<\/script>/g)];
check('exactly one qx-v81-restore script', blocks.length === 1);
const R = blocks[0] ? blocks[0][1] : '';
check('restore script is guarded', /if\(window\.__qxV81\) return; window\.__qxV81=true;/.test(R));
check('restore script has exactly one setInterval', (R.match(/setInterval\(/g) || []).length === 1);
check('restore script registers one qx-auth-change listener', (R.match(/addEventListener\("qx-auth-change"/g) || []).length === 1);
check('restore script never calls signIn or stores credentials',
  !/signInWithEmailAndPassword|localStorage|sessionStorage|__qxFirebaseLogin/.test(R));
check('restore script reads no password value (only clears it)',
  !/qxAuthPassword"\)\.value(?!\s*=)|qxsPass"\)\.value(?!\s*=)/.test(R) && /p\.value=""/.test(R));
check('settings gear captured → Data Sources only',
  /closest\("#settingsBtn"\)[\s\S]{0,80}stopImmediatePropagation\(\); openSources\(\)/.test(R) && /\},true\);/.test(R));
check('no "//" comment swallows code on a restore line',
  !R.split(/\r?\n/).some(l => /\/\/[^\n]*\btry\{/.test(l)));
check('exports: __qxOpenSettings', /window\.__qxOpenSettings=openSettings;/.test(src));
check('exports: __qxOpenPrefs', /window\.__qxOpenPrefs=openSettings;/.test(src));
check('exports: __qxMacroTileRows', /window\.__qxMacroTileRows=function\(\)\{ return macroTileRows\(Market\.centroidQuote\); \};/.test(src));
check('login gate uses the single login() path', /if\(e\)e\.value=em;if\(p\)p\.value=pw;return login\(\);\};/.test(src));
check('legacy prefs Firebase password row removed at boot', /\$\("fbPasswordInput"\), row=pw&&pw\.closest\("\.fieldRow"\)/.test(R));
check('live accounts mount into the v81 slot', /getElementById\("qxV81LiveSlot"\)\|\|getElementById\("research-dock"\)/.test(src.replace(/document\./g, '')));
const v60css = (src.match(/<style id="qx-v81-v60-css">([\s\S]*?)<\/style>/) || [])[1] || '';
check('v60 stylesheet present', v60css.length > 10000);
check('v60 font @import intact (no comment inside url)', /@import url\('[^')]*'\);/.test(v60css) && !/@import url\('[^')]*\/\*/.test(v60css));
check('v63 shell retired from view', /#dc-root,#qxField{display:none!important}/.test(src));
check('no "HMM Regime Engine" label survives the restore relabel', /replace\(\/HMM Regime Engine\/,"Regime Engine"\)/.test(R));

// ── service worker ───────────────────────────────────────────────────────────
const reg = (src.match(/service-worker\.js\?v=(\d+)/) || [])[1];
const cache = (sw.match(/CACHE_VERSION\s*=\s*'qx-v(\d+)'/) || [])[1];
check('SW registration ?v=' + reg + ' matches CACHE_VERSION qx-v' + cache, !!reg && reg === cache);

// ── restore script behaviour (role gating, truthful market watch) ────────────
function el(id) {
  return { id, innerHTML: '', textContent: '', hidden: false, value: 'x', style: {}, type: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    querySelector: () => ({ textContent: '', style: {} }), addEventListener() {}, appendChild() {}, insertBefore() {}, removeChild() {} };
}
function runRestore(authState, market) {
  const els = {}; const get = id => els[id] || (els[id] = el(id));
  const document = { readyState: 'complete', body: el('body'), getElementById: get, querySelector: () => null,
    querySelectorAll: () => [], addEventListener() {}, createElement: () => el('') };
  const window = { FirebaseSync: authState ? { authState } : undefined, QXMarket: market && market.M,
    __qxMacroTileRows: market && market.rows, QXTrace: market && market.trace, addEventListener() {} };
  const code = R.replace(/if\(document\.readyState===[^\n]*/, 'window.__t={isDesk:isDesk,paintMarket:paintMarket,paintRole:paintRole,paint:paint};');
  vm.runInNewContext(code, { window, document, Date, isFinite, Object, String, Math, setInterval: () => 0 });
  return { t: window.__t, get, document };
}
const roles = [
  ['MASTER', { state: 'CONNECTED', role: 'MASTER' }, true],
  ['READER', { state: 'CONNECTED', role: 'READER' }, true],
  ['NO ROLE', { state: 'CONNECTED', role: 'NO_ROLE' }, false],
  ['INVESTOR', { state: 'CONNECTED', role: 'INVESTOR' }, false],
  ['MASTER while CONNECTING', { state: 'CONNECTING', role: 'MASTER' }, false],
  ['signed out', { state: 'DISCONNECTED', role: null }, false],
  ['standalone (no FirebaseSync)', null, false],
];
for (const [n, a, want] of roles) {
  const r = runRestore(a);
  r.t.paint();
  check('desk access ' + n + ' → ' + (want ? 'DESK' : 'public only'), r.t.isDesk() === want && r.document.body.classList.contains('qx81-desk') === want);
}

const SECRET = 'ALIAS-SECRET-should-not-render';
const mk = (shown, src) => ({
  M: {
    status: () => ({ state: shown ? 'LIVE_CENTROID' : 'CREDENTIALS_REQUIRED', msg: '' }),
    centroidQuote: () => shown ? { state: 'LIVE', shown: true, mid: 1.16, observed_at: Date.now() } : { state: 'DISCONNECTED', shown: false },
    quoteHealth: () => ({ EURUSD: { observed_at: shown ? Date.now() : 0 }, XAUUSD: {} }),
    quote: () => ({ source_status: src, bid: 1.15995, ask: 1.16005 }),
  },
  rows: () => [{ label: 'GOLD', value: 'CENTROID FEED UNAVAILABLE', status: 'DISCONNECTED' }, { label: 'X', value: 'NOT DEFINED', status: '' },
    { label: 'DXY', value: '99.10', status: 'LIVE', basis: 'ICE' }],
  trace: { wsOpenTs: 1, alias: SECRET, token: SECRET },
});
let r = runRestore({ state: 'CONNECTED', role: 'MASTER' }, mk(false, 'PUBLIC'));
r.t.paintMarket();
let q = r.get('qx81Quotes').innerHTML;
check('no Centroid quote → CENTROID FEED UNAVAILABLE, no price', /CENTROID FEED UNAVAILABLE/.test(q) && !/1\.16/.test(q));
check('macro rows marked NOT DEFINED are not rendered', !/NOT DEFINED/.test(q) && /GOLD/.test(q) && /DXY · ICE/.test(q));
check('WS open but no live quote → never LIVE/AUTHENTICATED', !/AUTHENTICATED/.test(r.get('qx81Conn').innerHTML));
r = runRestore({ state: 'CONNECTED', role: 'MASTER' }, mk(true, 'PUBLIC'));
r.t.paintMarket(); q = r.get('qx81Quotes').innerHTML;
check('Centroid mid shown; bid/ask hidden when quote() is not Centroid-sourced', /1\.16000/.test(q) && !/1\.15995/.test(q));
r = runRestore({ state: 'CONNECTED', role: 'MASTER' }, mk(true, 'LIVE_CENTROID'));
r.t.paintMarket(); q = r.get('qx81Quotes').innerHTML;
check('Centroid-sourced quote → bid, ask + spread rendered (v60 cells)', />1\.15995</.test(q) && />1\.16005</.test(q) && /1\.0 pips/.test(q) && /Bid Vol/.test(q));
check('no volumes in frame → no imbalance/depth figures (no synthetic 50/50)', !/% bid/.test(q) && r.get('qx81LiqReg').textContent === '—');
check('diagnostics never render trace alias/token', ![q, r.get('qx81Conn').innerHTML, r.get('qx81Src').textContent].join('').includes(SECRET));

// ── live MT5 accounts: MASTER only ───────────────────────────────────────────
const LA = (src.match(/<script id="qx-live-accounts">([\s\S]*?)<\/script>/) || [])[1] || '';
check('qx-live-accounts script present', LA.length > 0);
for (const [n, a, want] of [['MASTER', { state: 'CONNECTED', role: 'MASTER' }, 1], ['READER', { state: 'CONNECTED', role: 'READER' }, 0],
  ['NO ROLE', { state: 'CONNECTED', role: 'NO_ROLE' }, 0], ['INVESTOR', { state: 'CONNECTED', role: 'INVESTOR' }, 0], ['signed out', { state: 'DISCONNECTED' }, 0]]) {
  let subs = 0;
  const firebase = { apps: [{}], firestore: () => ({ collection: () => ({ onSnapshot: () => { subs++; return () => {}; } }) }) };
  const document = { getElementById: () => null, createElement: () => el(''), body: { appendChild() {} } };
  const window = { FirebaseSync: { authState: a }, addEventListener() {} };
  window.firebase = firebase;
  try { vm.runInNewContext(LA, { window, document, firebase, Date, isFinite, Math, String, Object, setInterval: () => 0 }); } catch (e) {}
  check('live accounts subscribe for ' + n + ' → ' + (want ? 'yes' : 'no'), subs === want);
}

// v63 shell retired: markup gone, legacy decorators guarded, mobile sign-out reachable
check('v63 #dc-root markup removed', !/<div id="dc-root"/.test(src) && !/id="quadrax-shell"/.test(src));
check('v64/v65/v68 decorators guarded on #quadrax-shell (3)', src.split('if(!document.getElementById("quadrax-shell")) return; /* v81: v63 shell retired */').length - 1 === 3);
check('<=520px: header auth button hidden, sign in/out in #mobMenu', src.includes('@media (max-width:520px){.top-actions #qx81AuthBtn{display:none!important}}') && src.includes('mi.id="qx81MobAuth"') && src.includes('$("qx81MobAuth")'));

// v60.1 overlay: guarded, single timer, no v60 Centroid feed, mode-only storage, replay cleared on sign-out
const OV = [...src.matchAll(/<script id="qx-v81-overlay">([\s\S]*?)<\/script>/g)];
check('exactly one qx-v81-overlay script', OV.length === 1);
const O = OV[0] ? OV[0][1] : '';
check('overlay is guarded', /if\(window\.__qxV81Overlay\) return; window\.__qxV81Overlay=true;/.test(O));
check('overlay has exactly one setInterval', (O.match(/setInterval\(/g) || []).length === 1);
check('no v60 CentroidFeed anywhere', !/CentroidFeed/.test(src));
check('overlay localStorage only for qx_mode_v1', (O.match(/localStorage\.\w+\(([^)]*)/g) || []).every(x => /"qx_mode_v1"/.test(x)) && !/sessionStorage/.test(O));
check('overlay copy never says HMM', !/HMM/.test(O));
check('replay frames cleared on qx-auth-signout', /addEventListener\("qx-auth-signout",function\(\)\{ snaps=\[\]; paintReplay\(\); \}\)/.test(O));
check('v60 sheet: single @import at the top (a mid-sheet one would void the --dt- tokens)',
  (v60nc => (v60nc.match(/@import url\(/g) || []).length === 1 && /^\s*@import url\(/.test(v60nc))(v60css.replace(/\/\*[\s\S]*?\*\//g, '')) && /--dt-bg0:/.test(v60css));
check('Data Sources modal restyled in v60.1 card language', /#qxSettings \.qxs-card\{margin:auto;width:min\(540px/.test(src));
check('<=1600px header: transition chip + TF badge hidden, anon role compact', /@media \(max-width:1600px\)\{\.qx81-role\{[^}]*\}\.qx81-role\.qx81-anon,#qx-v59-host \.top-actions \.qx-tf-badge,#qx-v59-host \.top-actions \.qx-risk-chip\{display:none!important\}\}/.test(src) && /classList\.toggle\("qx81-anon",t==="STANDALONE"\)/.test(R));

console.log(fails ? fails + ' FAILED' : 'ALL PASS');
process.exit(fails ? 1 : 0);
