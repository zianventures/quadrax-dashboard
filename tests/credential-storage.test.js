// Credential-storage guard. Usage: node tests/credential-storage.test.js [file.html]
// Fails if Centroid credentials or the Firebase password can reach Web Storage. No network, no secrets.
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };
const mkStore = () => { const m = {}; return { m, getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };

// Every inline script must still parse (classic scripts only; %%FB_*%% placeholders are string literals).
const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let bad = 0; scripts.forEach(s => { try { new vm.Script(s); } catch (e) { bad++; } });
check(`all ${scripts.length} inline scripts parse`, bad === 0);

// Centroid: run the real cred functions against mock storages seeded with a legacy plaintext record.
const cM = src.match(/var CRED="qx_ds_cred_v1";[\s\S]*?function clearCreds\(\)\{[^\n]*\n/);
check('Centroid cred functions extractable', !!cM);
if (cM) {
  const ss = mkStore(), ls = mkStore(), legacy = JSON.stringify({ user: 'u', pass: 'LEGACY', code: 'c', broker: 'b', remember: true });
  ss.setItem('qx_ds_cred_v1', legacy); ls.setItem('qx_ds_cred_v1', legacy);
  const ctx = { sessionStorage: ss, localStorage: ls, window: {} };
  vm.runInNewContext(cM[0] + ';this.api={loadCreds,saveCreds,clearCreds,get creds(){return creds;}};', ctx);
  const api = ctx.api;
  check('legacy stored creds are not loaded', api.loadCreds() === null);
  check('legacy record purged from both storages', !('qx_ds_cred_v1' in ss.m) && !('qx_ds_cred_v1' in ls.m));
  api.saveCreds({ user: 'u', pass: 'SECRET', code: 'c', broker: 'b' }, true);
  check('saveCreds keeps creds in memory for the WS session', api.creds && api.creds.pass === 'SECRET' && api.loadCreds() === api.creds);
  check('saveCreds(remember=true) writes nothing to storage', !JSON.stringify([ss.m, ls.m]).includes('SECRET'));
  api.clearCreds();
  check('clearCreds drops memory copy', api.creds === null);
}

// Firebase: save() must never persist fbEmail/fbPassword; legacy stored credentials are purged at load.
const sM = src.match(/function save\(k,v\)\{[^\n]*\n/);
check('settings save() extractable', !!sM);
if (sM) {
  const ls = mkStore(), ctx = { localStorage: ls, KEY: { s: 'qx_s_v5', proj: 'qx_proj_v1' } };
  vm.runInNewContext(sM[0] + ';this.save=save;', ctx);
  const settings = { twelvedataKey: 'td', fbEmail: 'e', fbPassword: 'FBSECRET' };
  ctx.save('qx_s_v5', settings);
  const stored = JSON.parse(ls.m.qx_s_v5);
  check('save(KEY.s) strips fbPassword and fbEmail', !ls.m.qx_s_v5.includes('FBSECRET') && !('fbPassword' in stored) && !('fbEmail' in stored) && stored.twelvedataKey === 'td');
  check('save(KEY.s) leaves in-memory settings intact', settings.fbPassword === 'FBSECRET');
}
check('legacy fbEmail/fbPassword purge runs at settings load', /let settings=loadObj\(KEY\.s[^\n]*\n\s*if\("fbPassword"in settings\|\|"fbEmail"in settings\)\{delete settings\.fbPassword;delete settings\.fbEmail;save\(KEY\.s,settings\);\}/.test(src));
check('settings schema has no Firebase credential fields', !/fbEmail:""|fbPassword:""/.test(src));
check('credentials never read back from settings', !/(?<!delete )settings\.(fbEmail|fbPassword)/.test(src));
check('no Remember-on-device credential option', !/qxsRemember/.test(src));
check('no direct Web Storage write of CRED', !/Storage\.setItem\(CRED/.test(src));

console.log(`\n${path.basename(file)}: ${fails ? fails + ' FAILED' : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
