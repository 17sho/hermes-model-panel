import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const execFileAsync = promisify(execFile);
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
assert.ok(script, '页面脚本存在');
new vm.Script(script, { filename: 'public/index.html' });

// Only the trusted HTML shell contributes to the legacy DOM contract. IDs in
// JavaScript template strings are dynamic and must never be scanned as static.
const shell = html;
const shellIds = new Set([...shell.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
assert.equal([...html.matchAll(/class=["'][^"']*panelSection/g)].length, 14, '14 个页面（含独立命令批准页）保持不变');
assert.doesNotMatch(html, /\son[a-z]+\s*=/i, '静态 HTML 不再包含内联事件');
assert.match(html, /<script type="module" src="js\/app\.js(?:\?v=[A-Za-z0-9._-]+)?"><\/script>/, '前端脚本保持 ES module 入口');
const legacyHtml = fs.readFileSync(path.join(root, 'public/index.html.pre-full-fix-20260823T145836Z'), 'utf8');
const legacyShell = legacyHtml.slice(0, legacyHtml.indexOf('<script>'));
const legacyStaticIds = [...legacyShell.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]).filter((id) => id !== 'login');
assert.equal(legacyStaticIds.length, 107, '旧静态 DOM 契约仍为 107 个 ID');
assert.deepEqual(legacyStaticIds.filter((id) => !shellIds.has(id)), [], '旧静态 ID 零缺失');
assert.ok(!legacyStaticIds.some((id) => id.includes('${')), '动态模板 ID 不得混入静态契约');
const legacyScript = legacyHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
const apiPaths = new Set([...script.matchAll(/api\((['`])([^'`]+)\1/g)].map((match) => match[2]));
const legacyApiPaths = new Set([...legacyScript.matchAll(/api\((['`])([^'`]+)\1/g)].map((match) => match[2]));
assert.deepEqual([...legacyApiPaths].filter((apiPath) => !apiPaths.has(apiPath)), [], '前端 API 路径零缺失');

// Execute the real attribute encoder with a malicious dynamic value. The
// resulting markup must retain one data attribute and create no event handler.
const escSource = script.match(/function esc\(s\)\{[^\n]+/)?.[0];
const escAttrSource = script.match(/function escAttr\(s\)\{[^\n]+/)?.[0];
assert.ok(escSource && escAttrSource);
const sandbox = {};
vm.runInNewContext(`${escSource}\n${escAttrSource}\nthis.encode=escAttr`, sandbox);
const malicious = `x" onclick="globalThis.pwned=1`;
const dynamicMarkup = `<button data-model="${sandbox.encode(malicious)}">safe</button>`;
assert.doesNotMatch(dynamicMarkup, /["']\s+on[a-z]+\s*=/i, '恶意动态值不得生成事件属性');
assert.match(dynamicMarkup, /&quot; onclick=&quot;/, '恶意值应留在已编码的属性值内');

for (const match of script.matchAll(/(?:innerHTML\s*=|return\s+)(`[\s\S]*?`)/g)) {
  assert.doesNotMatch(match[1], /\son(?:click|change|input|keydown)\s*=/i, '动态模板不得注入内联事件');
}

const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hmp-test-'));
const configPath = path.join(tempDir, 'config.yaml');
const metaPath = path.join(tempDir, 'panel-meta.json');
await fsp.writeFile(configPath, 'counter: 0\nmarks: {}\n', { mode: 0o600 });
process.env.HERMES_CONFIG = configPath;
process.env.HERMES_HOME = tempDir;
process.env.HERMES_PROFILES_DIR = path.join(tempDir, 'profiles');
process.env.PANEL_META_PATH = metaPath;
process.env.ADMIN_PASSWORD = 'unit-test-password';
process.env.SESSION_SECRET = 'unit-test-session-secret-that-is-not-production';
process.env.AUTH_DISABLED = '0';
process.env.TRUST_PROXY_AUTH = '1';

const { app, updateConfig, updatePanelMeta, upsertEnvValues } = await import('../server.js');

try {
  await Promise.all(Array.from({ length: 32 }, (_, i) => updateConfig((cfg) => {
    cfg.counter = Number(cfg.counter || 0) + 1;
    cfg.marks = { ...(cfg.marks || {}), [i]: true };
  }, configPath)));
  const concurrent = YAML.parse(await fsp.readFile(configPath, 'utf8'));
  assert.equal(concurrent.counter, 32, '配置并发递增不丢更新');
  assert.equal(Object.keys(concurrent.marks).length, 32, '配置并发独立字段不丢更新');

  await Promise.all(Array.from({ length: 24 }, (_, i) => updatePanelMeta((meta) => {
    meta.test = { ...(meta.test || {}), [i]: true };
  }, metaPath)));
  assert.equal(Object.keys(JSON.parse(await fsp.readFile(metaPath, 'utf8')).test).length, 24, 'PANEL_META 并发写不丢更新');
  const envPath = path.join(tempDir, 'channels.env');
  await Promise.all(Array.from({ length: 20 }, (_, i) => upsertEnvValues(envPath, { [`CHANNEL_${i}`]: `value-${i}` })));
  const envText = await fsp.readFile(envPath, 'utf8');
  for (let i = 0; i < 20; i += 1) assert.match(envText, new RegExp(`^CHANNEL_${i}=value-${i}$`, 'm'), 'env 并发写不丢字段');

  const server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const badOrigin = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.invalid' }, body: '{}',
    });
    assert.equal(badOrigin.status, 403, '跨站 Origin 必须拒绝');

    const unauthenticated = await fetch(`${base}/api/state`);
    assert.equal(unauthenticated.status, 401, '仅开启反代信任、没有可信标记时仍必须拒绝');
    const proxyAuthenticated = await fetch(`${base}/api/state`, { headers: { 'x-hermes-authenticated': '1' } });
    assert.equal(proxyAuthenticated.status, 401, '固定值反代认证标记不得绕过登录');
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'unit-test-password' }),
    });
    assert.equal(login.status, 200, '正确密码应保持可登录');
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie, '登录应设置会话 Cookie');
    const authenticated = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(authenticated.status, 200, 'Cookie 登录态应继续有效');
    const authSettings = await fetch(`${base}/api/auth-settings`, { headers: { cookie } });
    const csrf = (await authSettings.json()).csrf_token;
    assert.ok(csrf && !authSettings.headers.get('set-cookie'), 'CSRF token 安全下发且不另设可读 cookie');
    const noCsrf = await fetch(`${base}/api/auth-settings`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ password_enabled: true }) });
    assert.equal(noCsrf.status, 403, '浏览器 mutation 缺 CSRF 必须拒绝');
    const changed = await fetch(`${base}/api/change-password`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ old_password: 'unit-test-password', new_password: 'new-unit-test-password' }) });
    assert.equal(changed.status, 200, '修改密码成功');
    const newCookie = changed.headers.get('set-cookie')?.split(';', 1)[0];
    const oldAfterChange = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(oldAfterChange.status, 401, '修改密码后旧 cookie 立即失效');
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: newCookie } })).status, 200, '修改密码签发的当前 cookie 有效');
    const oversized = await fetch(`${base}/api/providers`, { method: 'POST', headers: { cookie: newCookie, 'content-type': 'application/json', 'x-csrf-token': (await changed.json()).csrf_token }, body: JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 1) }) });
    assert.equal(oversized.status, 413, '普通 JSON 超过 1MB 必须拒绝');

    for (let i = 0; i < 10; i += 1) {
      const response = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(limited.status, 429, '登录失败达到阈值后必须限速');
    assert.ok(Number(limited.headers.get('retry-after')) > 0, '限速响应必须给 Retry-After');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
} finally {
  await fsp.rm(tempDir, { recursive: true, force: true });
}

const dbutil = fs.readFileSync(path.join(root, 'scripts', 'dbutil.py'), 'utf8');
assert.match(dbutil, /busy_timeout=5000/);
assert.match(dbutil, /range\(3\)/);
assert.match(dbutil, /BEGIN IMMEDIATE/);
assert.match(dbutil, /rollback\(\)/);
for (const name of ['delete-session.py', 'resume-session.py', 'set-session-model.py']) {
  const py = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
  assert.match(py, /immediate_transaction/);
}

const delegateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hmp-delegate-'));
const delegateDb = path.join(delegateDir, 'delegate.db');
const makeDb = `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.executescript('CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT,model_config TEXT);CREATE TABLE messages(session_id TEXT);CREATE TABLE gateway_routing(scope TEXT,session_key TEXT,entry_json TEXT,updated_at REAL);')
rows=[('root','agent:test',None,''),('d1','', 'root',json.dumps({'_delegate_from':'root'})),('d2','', 'd1',json.dumps({'_delegate_from':'d1'})),('d3','', 'd2',json.dumps({'_delegate_from':'d2'}))]
c.executemany('INSERT INTO sessions VALUES(?,?,?,?)',rows);c.executemany('INSERT INTO messages VALUES(?)',[(x[0],) for x in rows]);c.execute('INSERT INTO gateway_routing VALUES(?,?,?,?)',('scope','agent:test',json.dumps({'session_id':'root','session_key':'agent:test'}),0));c.commit()`;
await execFileAsync('python3', ['-c', makeDb, delegateDb]);
await execFileAsync('python3', [path.join(root, 'scripts/delete-session.py'), delegateDb, 'root']);
const countCode = `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('select count(*) from sessions').fetchone()[0], c.execute('select count(*) from messages').fetchone()[0])`;
const deleted = await execFileAsync('python3', ['-c', countCode, delegateDb]);
assert.equal(deleted.stdout.trim(), '0 0', '三层 delegate 必须递归删除消息和会话');
await fsp.rm(delegateDir, { recursive: true, force: true });

assert.doesNotMatch(script, /ACTION_BUTTON/, '按钮归属不得依赖隐式全局');
assert.match(script, /INFLIGHT_CONTROLLERS/, '维护全局在途请求集合');
assert.match(script, /nextRequestSequence\('serviceStatus'\)/, 'serviceStatus 使用 sequence');

console.log('audit regression checks passed');
