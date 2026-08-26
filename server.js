import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import serve from 'koa-static';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import crypto from 'crypto';
import YAML from 'yaml';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const packageInfo = require('./package.json');
import { atomicWriteFile, serializeFile } from './src/lib/atomic-files.js';
import { publicError, safeEqual } from './src/lib/errors.js';
import { execFileAsync } from './src/lib/process-runner.js';
import { createRequireAuth } from './src/middleware/auth.js';
import { securityHeadersAndOrigin } from './src/middleware/csrf.js';
import { mapConcurrent, readResponseText } from './src/lib/http-safety.js';
import { safeOutboundFetch, Semaphore } from './src/lib/outbound-http.js';
const PORT = Number(process.env.PORT || 3010);
const HERMES_CONFIG = process.env.HERMES_CONFIG || '/root/.hermes/config.yaml';
const HERMES_HOME = process.env.HERMES_HOME || path.dirname(HERMES_CONFIG);
const PROFILES_DIR = process.env.HERMES_PROFILES_DIR || path.join(HERMES_HOME, 'profiles');
const PANEL_UPDATE_REPO = process.env.PANEL_UPDATE_REPO || '17sho/hermes-model-panel';
const PANEL_UPDATE_BRANCH = process.env.PANEL_UPDATE_BRANCH || 'main';
const PANEL_UPDATE_SCRIPT = process.env.PANEL_UPDATE_SCRIPT || path.join(process.cwd(), 'scripts', 'update-panel.sh');
const PANEL_UPDATE_STATE = process.env.PANEL_UPDATE_STATE || '/var/lib/hermes-model-panel/update-status.json';
const PANEL_VERSION_FILE = process.env.PANEL_VERSION_FILE || path.join(process.cwd(), '.panel-version');
const OUTBOUND_CONCURRENCY = Number.parseInt(process.env.OUTBOUND_CONCURRENCY || '8', 10);
const outboundSemaphore = new Semaphore(Number.isInteger(OUTBOUND_CONCURRENCY) && OUTBOUND_CONCURRENCY > 0 ? OUTBOUND_CONCURRENCY : 8);

async function withOutboundResponse(url, init, consumer, options = {}) {
  return outboundSemaphore.run(async () => {
    const { response, close } = await safeOutboundFetch(url, init, options);
    try { return await consumer(response); }
    finally { await close(); }
  });
}

function titleCase(s) {
  return String(s || '').replace(/(^|[-_])([a-z])/g, (_, a, b) => (a ? ' ' : '') + b.toUpperCase());
}

function discoverAgents() {
  const list = [];
  if (fssync.existsSync(HERMES_CONFIG)) {
    list.push({
      id: 'default',
      name: 'Agent1',
      profile: 'agent1',
      config: HERMES_CONFIG,
      service: 'hermes-gateway.service',
    });
  }
  let names = [];
  try {
    names = fssync.readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    names = [];
  }
  for (const name of names) {
    const config = path.join(PROFILES_DIR, name, 'config.yaml');
    if (!fssync.existsSync(config)) continue;
    const id = name === 'default' ? 'default-profile' : name;
    list.push({
      id,
      name: titleCase(name),
      profile: name,
      config,
      service: `hermes-gateway-${name}.service`,
    });
  }
  return list;
}

function AGENTS() {
  return discoverAgents();
}

function validGithubRepo(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(value || ''));
}

async function readInstalledPanelSha() {
  // Development/git deployments can retain an old .panel-version marker from a
  // previous archive install. Prefer the live checkout's HEAD when available;
  // packaged installs have no .git directory and fall back to the marker.
  try {
    const { stdout = '' } = await execFileAsync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { timeout: 3000 });
    const value = stdout.trim();
    if (/^[0-9a-f]{40}$/.test(value)) return value;
  } catch { /* release archive installs are not git checkouts */ }
  try {
    const value = (await fs.readFile(PANEL_VERSION_FILE, 'utf8')).trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : '';
  } catch { return ''; }
}

async function fetchGithubReleaseInfo() {
  if (!validGithubRepo(PANEL_UPDATE_REPO)) throw new Error('在线更新源配置无效');
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'hermes-model-panel-updater' };
  const releaseResponse = await fetch(`https://api.github.com/repos/${PANEL_UPDATE_REPO}/releases/latest`, {
    headers,
    signal: globalThis.AbortSignal.timeout(15000),
  });
  if (!releaseResponse.ok) throw new Error(`GitHub Release 检查失败（HTTP ${releaseResponse.status}）`);
  const release = await releaseResponse.json();
  const tag = String(release.tag_name || '');
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('GitHub 返回了无效 Release 标签');
  const refResponse = await fetch(`https://api.github.com/repos/${PANEL_UPDATE_REPO}/git/ref/tags/${encodeURIComponent(tag)}`, {
    headers,
    signal: globalThis.AbortSignal.timeout(15000),
  });
  if (!refResponse.ok) throw new Error(`GitHub Release 引用检查失败（HTTP ${refResponse.status}）`);
  let ref = await refResponse.json();
  if (ref.object?.type === 'tag') {
    const tagResponse = await fetch(ref.object.url, { headers, signal: globalThis.AbortSignal.timeout(15000) });
    if (!tagResponse.ok) throw new Error(`GitHub Release 标签解析失败（HTTP ${tagResponse.status}）`);
    ref = await tagResponse.json();
  }
  const sha = String(ref.object?.sha || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub Release 返回了无效提交号');
  const assets = Array.isArray(release.assets) ? release.assets.map((asset) => String(asset.name || '')) : [];
  if (!assets.includes('hermes-model-panel.tar.gz') || !assets.includes('SHA256SUMS')) throw new Error('最新 Release 缺少已校验更新制品');
  return { sha, version: tag.slice(1), tag };
}

async function fetchGithubPanelSha() {
  return (await fetchGithubReleaseInfo()).sha;
}

async function fetchGithubPanelVersion() {
  return (await fetchGithubReleaseInfo()).version;
}

async function readPanelUpdateStatus() {
  try { return JSON.parse(await fs.readFile(PANEL_UPDATE_STATE, 'utf8')); } catch { return { state: 'idle', message: '尚未执行在线更新' }; }
}
async function listPanelRollbacks() {
  const installDir = path.resolve(process.env.PANEL_INSTALL_DIR || '/opt/hermes-model-panel');
  const parent = path.dirname(installDir);
  const prefix = `${path.basename(installDir)}.rollback-`;
  let entries = [];
  try { entries = await fs.readdir(parent, { withFileTypes: true }); } catch { return []; }
  const rollbacks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const directory = path.join(parent, entry.name);
    try {
      const [pkg, stat] = await Promise.all([
        fs.readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse),
        fs.stat(directory),
      ]);
      let sha = '';
      try { sha = (await fs.readFile(path.join(directory, '.panel-version'), 'utf8')).trim(); } catch { /* legacy backup */ }
      rollbacks.push({ id: entry.name.slice(prefix.length), version: String(pkg.version || '-'), sha, created_at: stat.mtime.toISOString() });
    } catch { /* ignore incomplete backup */ }
  }
  return rollbacks.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 2);
}
const PANEL_META_PATH = process.env.PANEL_META_PATH || '/root/.hermes/model-panel-meta.json';
const DEFAULT_OPENAI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function readPanelMeta() {
  try {
    return JSON.parse(fssync.readFileSync(PANEL_META_PATH, 'utf8'));
  } catch {
    return { providers: {} };
  }
}

async function updatePanelMeta(mutator, metaPath = PANEL_META_PATH) {
  return serializeFile(metaPath, async () => {
    let meta;
    try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch { meta = { providers: {} }; }
    const result = await mutator(meta);
    await atomicWriteFile(metaPath, `${JSON.stringify(meta || { providers: {} }, null, 2)}\n`);
    return result;
  });
}

function configuredServiceScope(agent) {
  const meta = readPanelMeta();
  return meta?.service_scopes?.[agent.profile] || 'auto';
}

async function saveServiceScope(agent, scope) {
  return updatePanelMeta((meta) => {
    meta.service_scopes = { ...(meta.service_scopes || {}), [agent.profile]: scope };
  });
}

async function forgetServiceScope(profile) {
  return updatePanelMeta((meta) => { if (meta.service_scopes) delete meta.service_scopes[profile]; });
}

function publicServiceScopes() {
  const out = {};
  for (const agent of AGENTS()) out[agent.id] = configuredServiceScope(agent);
  return out;
}

async function rememberProviderMeta(provider, index = 0) {
  const key = stableProviderKey(provider || {}, index);
  if (!key) return;
  const label = String(provider.display_name || provider.label || provider.title || provider.name || '').trim();
  if (!label || label === key) return;
  return updatePanelMeta((meta) => {
    meta.providers = meta.providers || {};
    meta.providers[key] = { ...(meta.providers[key] || {}), display_name: label };
  });
}

function applyProviderMeta(provider, index = 0) {
  if (!provider) return provider;
  const key = stableProviderKey(provider, index);
  const meta = readPanelMeta();
  const saved = meta.providers?.[key] || {};
  const display = saved.display_name;
  return { ...provider, provider_key: key, allow_private_network: saved.allow_private_network === true, ...(display ? { display_name: display } : {}) };
}

async function rememberProviderPrivateAccess(provider, index, allowed) {
  const key = stableProviderKey(provider || {}, index);
  if (!key) throw new Error('中转站标识无效');
  return updatePanelMeta((meta) => {
    meta.providers = meta.providers || {};
    meta.providers[key] = { ...(meta.providers[key] || {}), allow_private_network: allowed === true };
  });
}

function stripPanelFields(provider) {
  if (!provider || typeof provider !== 'object') return provider;
  const { provider_key, display_name, label, title, ...rest } = provider;
  return rest;
}
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ENV_FILE = process.env.ENV_FILE || '/root/hermes-model-panel.env';
const SESSION_SECRET_PERSISTED = Boolean(process.env.SESSION_SECRET);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const COOKIE_NAME = 'hmp_session';
const COOKIE_PATH = process.env.COOKIE_PATH || '/';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
let PUBLIC_ORIGIN_URL = null;
try {
  if (PUBLIC_ORIGIN) PUBLIC_ORIGIN_URL = new URL(PUBLIC_ORIGIN);
} catch {
  console.error('PUBLIC_ORIGIN 必须是有效的 http(s) 站点根地址');
  process.exit(1);
}
if (PUBLIC_ORIGIN_URL && (!['http:', 'https:'].includes(PUBLIC_ORIGIN_URL.protocol) || PUBLIC_ORIGIN_URL.pathname !== '/' || PUBLIC_ORIGIN_URL.search || PUBLIC_ORIGIN_URL.hash)) {
  console.error('PUBLIC_ORIGIN 必须是 http(s) 站点根地址，不能包含路径、查询或片段');
  process.exit(1);
}
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || PUBLIC_ORIGIN_URL?.protocol === 'https:';
const TRUST_PROXY_AUTH = process.env.TRUST_PROXY_AUTH === '1';
const TRUSTED_PROXY_AUTH_HEADER = String(process.env.TRUSTED_PROXY_AUTH_HEADER || 'x-hermes-authenticated').toLowerCase();
const CLI_AUTH_HEADER = 'x-hermes-cli-auth';
let SESSION_VERSION = Math.max(1, Number(readPanelMeta()?.security?.session_version) || 1);
// 安全失败：只有明确设为 1 才关闭鉴权，避免环境文件漏载时匿名开放管理接口。
let AUTH_DISABLED = process.env.AUTH_DISABLED === '1';

if (!AUTH_DISABLED && !ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is required when AUTH_DISABLED=0');
  process.exit(1);
}
if (!SESSION_SECRET_PERSISTED) console.warn('SESSION_SECRET 未持久配置：进程重新启动后，现有登录会话将失效。');

const app = new Koa();
const router = new Router({ prefix: '/api' });
// Koa needs trusted loopback proxy protocol metadata so it can emit Secure
// cookies over an HTTPS-terminating reverse proxy. Strip forwarded metadata
// from every non-loopback peer before Koa consumes it. Security and rate-limit
// IP decisions trust forwarded metadata only from the local reverse proxy.
app.proxy = true;
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
app.use(async (ctx, next) => {
  const peer = String(ctx.req.socket?.remoteAddress || '');
  const loopback = LOOPBACK_PEERS.has(peer);
  if (!loopback) {
    for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port']) {
      delete ctx.req.headers[name];
    }
  }
  await next();
});

function clientIp(ctx) {
  const peer = String(ctx.req.socket?.remoteAddress || 'unknown');
  if (!LOOPBACK_PEERS.has(peer)) return peer;
  const forwarded = String(ctx.get('x-forwarded-for') || '')
    .split(',')
    .map((value) => value.trim())
    .find(Boolean);
  return forwarded || peer;
}

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_RATE_MAX_IPS = 2048;
const loginAttempts = new Map();
function loginRateRecord(ip, failed = false) {
  const now = Date.now();
  let item = loginAttempts.get(ip);
  if (!item || now - item.started >= LOGIN_WINDOW_MS) item = { started: now, count: 0 };
  if (failed) item.count += 1;
  loginAttempts.delete(ip);
  loginAttempts.set(ip, item);
  while (loginAttempts.size > LOGIN_RATE_MAX_IPS) loginAttempts.delete(loginAttempts.keys().next().value);
  return item;
}

app.use(securityHeadersAndOrigin({ publicOrigin: PUBLIC_ORIGIN }));

async function updateEnvKey(file, key, value) {
  if (/[\r\n]/.test(String(value))) throw new Error('值不能包含换行');
  return serializeFile(file, async () => {
    let lines = [];
    try { lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter((_, i, arr) => i < arr.length - 1 || arr[i] !== ''); } catch {}
    let found = false;
    lines = lines.map((line) => line.startsWith(`${key}=`) ? (found = true, `${key}=${value}`) : line);
    if (!found) lines.push(`${key}=${value}`);
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(tmp, `${lines.join('\n')}\n`, { mode: 0o600 }); await fs.rename(tmp, file); await fs.chmod(file, 0o600); }
    finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  });
}

function authPublicStatus() {
  return { ok: true, password_enabled: !AUTH_DISABLED, password_set: Boolean(ADMIN_PASSWORD) };
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now(), v: SESSION_VERSION, csrf: crypto.randomBytes(24).toString('base64url') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function tokenPayload(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.', 2);
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Date.now() - Number(obj.iat || 0) < 7 * 86400 * 1000 && Number(obj.v) === SESSION_VERSION ? obj : null;
  } catch {
    return null;
  }
}

function validToken(token) { return Boolean(tokenPayload(token)); }
async function rotateSessionVersion() {
  const next = await updatePanelMeta((meta) => {
    meta.security = meta.security && typeof meta.security === 'object' ? meta.security : {};
    meta.security.session_version = Math.max(SESSION_VERSION, Number(meta.security.session_version) || 0) + 1;
    return meta.security.session_version;
  });
  SESSION_VERSION = next;
}
function sessionPublicStatus(ctx, extra = {}) {
  const payload = tokenPayload(ctx.cookies.get(COOKIE_NAME));
  return { ...authPublicStatus(), ...(payload ? { csrf_token: payload.csrf } : {}), ...extra };
}

function cookieOptions(ctx, extra = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    overwrite: true,
    maxAge: 7 * 86400 * 1000,
    path: COOKIE_PATH,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
    ...extra,
  };
}

function hasValidSession(ctx) {
  if (AUTH_DISABLED) return true;
  return validToken(ctx.cookies.get(COOKIE_NAME));
}

function validTimedHmac(value, purpose) {
  const [stamp, mac] = String(value || '').split('.', 2);
  const time = Number(stamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 60_000) return false;
  return safeEqual(mac, crypto.createHmac('sha256', SESSION_SECRET).update(`${purpose}:${stamp}`).digest('hex'));
}

const requireAuth = createRequireAuth({
  authDisabled: () => AUTH_DISABLED,
  cliAuthHeader: CLI_AUTH_HEADER,
  cookieName: COOKIE_NAME,
  safeEqual,
  tokenPayload,
  trustedProxyAuthHeader: TRUSTED_PROXY_AUTH_HEADER,
  trustProxyAuth: TRUST_PROXY_AUTH,
  validTimedHmac,
});

function getAgent(id = 'default') {
  const agents = AGENTS();
  const key = String(id || 'default').trim();
  const agent = agents.find((a) => a.id === key || a.profile === key);
  if (!agent) throw new Error('未知 Agent');
  return agent;
}

function resolveAgentTargets(targetAgent = 'default') {
  const agents = AGENTS();
  const key = String(targetAgent || 'default').trim();
  if (key === 'all' || key === 'both') return agents;
  return [getAgent(key)];
}

const RESERVED_PROFILE_NAMES = new Set(['default', 'agent1', 'root', 'system']);

function normalizeProfileName(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{0,23}$/.test(name)) {
    throw new Error('名称只能用小写字母开头，后面跟字母或数字，最长 24 位');
  }
  if (RESERVED_PROFILE_NAMES.has(name)) throw new Error('这个名字留给默认 agent 了');
  return name;
}

function gatewayUnitText(name, scope = 'system') {
  const home = path.join(PROFILES_DIR, name);
  const identity = scope === 'user' ? '' : 'User=root\nGroup=root\n';
  return `[Unit]
Description=Hermes Agent Gateway - ${titleCase(name)}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
${identity}ExecStart=/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main --profile ${name} gateway run --replace
WorkingDirectory=${home}
Environment="HOME=/root"
Environment="USER=root"
Environment="LOGNAME=root"
Environment="PATH=/usr/local/lib/hermes-agent/venv/bin:/usr/local/lib/hermes-agent/node_modules/.bin:/root/.hermes/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="VIRTUAL_ENV=/usr/local/lib/hermes-agent/venv"
Environment="HERMES_HOME=${home}"
Environment="HERMES_PROFILE=${name}"
Restart=always
RestartSec=5
RestartMaxDelaySec=300
RestartSteps=5
RestartForceExitStatus=75
KillMode=mixed
KillSignal=SIGTERM
ExecReload=/bin/kill -USR1 $MAINPID
TimeoutStopSec=25
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=${scope === 'user' ? 'default.target' : 'multi-user.target'}
`;
}

async function installAgentUnit(name, scope = 'system') {
  const unit = `hermes-gateway-${name}.service`;
  const user = scope === 'user';
  const unitDir = user ? '/root/.config/systemd/user' : '/etc/systemd/system';
  await fs.mkdir(unitDir, { recursive: true });
  await fs.writeFile(path.join(unitDir, unit), gatewayUnitText(name, scope), { mode: 0o644 });
  const env = user ? { ...process.env, XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' } : process.env;
  const prefix = user ? ['--user'] : [];
  await execFileAsync('systemctl', [...prefix, 'daemon-reload'], { timeout: 30000, env });
  await execFileAsync('systemctl', [...prefix, 'enable', '--now', unit], { timeout: 60000, env });
}

async function removeAgentUnit(name, scope) {
  const unit = `hermes-gateway-${name}.service`;
  const { prefix, env } = systemctlContext(scope);
  try { await execFileAsync('systemctl', [...prefix, 'disable', '--now', unit], { timeout: 30000, env }); } catch (_) {}
  const unitPath = scope === 'user' ? `/root/.config/systemd/user/${unit}` : `/etc/systemd/system/${unit}`;
  if (fssync.existsSync(unitPath)) await fs.unlink(unitPath);
  await execFileAsync('systemctl', [...prefix, 'daemon-reload'], { timeout: 30000, env });
  try { await execFileAsync('systemctl', [...prefix, 'reset-failed', unit], { timeout: 15000, env }); } catch (_) {}
}

async function migrateAgentUnit(agent, targetScope) {
  if (isDefaultAgent(agent)) throw new Error('默认 Gateway 不支持在面板内迁移层级，请使用 Hermes 安装命令迁移');
  const probes = await probeService(agent.service);
  const existing = ['system', 'user'].filter((s) => probes[s].loaded);
  if (existing.length === 2 && probes.system.active === 'active' && probes.user.active === 'active') throw new Error('系统级和用户级 Gateway 同时运行，已阻止迁移');
  const sourceScope = existing.find((s) => s !== targetScope) || null;
  if (!probes[targetScope].loaded) await installAgentUnit(agent.profile, targetScope);
  const state = await systemctlAction(agent.service, 'is-active', targetScope);
  if (state.stdout.trim() !== 'active') throw new Error('目标层级 Gateway 未能启动，保留原服务');
  if (sourceScope) await removeAgentUnit(agent.profile, sourceScope);
  await saveServiceScope(agent, targetScope);
  return { source_scope: sourceScope, effective_scope: targetScope, status: 'active' };
}

async function createAgentProfile(rawName, scope = 'system') {
  const name = normalizeProfileName(rawName);
  if (AGENTS().some((a) => a.profile === name || a.id === name)) {
    throw new Error('已经有这个 agent 了');
  }
  const dest = path.join(PROFILES_DIR, name);
  if (fssync.existsSync(dest)) throw new Error('目录已经存在');
  const hermesBin = process.env.HERMES_BIN || 'hermes';
  await execFileAsync(hermesBin, ['profile', 'create', name, '--no-alias'], { timeout: 60000, env: process.env });
  try {
    const cfg = path.join(dest, 'config.yaml');
    if (!fssync.existsSync(cfg)) {
      if (!fssync.existsSync(HERMES_CONFIG)) throw new Error('profile 建完但没有 config.yaml，默认配置也不存在');
      await fs.copyFile(HERMES_CONFIG, cfg);
    }
    const envPath = path.join(dest, '.env');
    if (!fssync.existsSync(envPath)) await fs.writeFile(envPath, '', { mode: 0o600 });
    await installAgentUnit(name, scope);
    await saveServiceScope({ profile: name }, scope);
    return AGENTS().find((a) => a.profile === name);
  } catch (e) {
    try { await removeAgentUnit(name, scope); } catch (_) {}
    if (fssync.existsSync(dest)) await fs.rm(dest, { recursive: true, force: true });
    await forgetServiceScope(name);
    throw e;
  }
}

function isDefaultAgent(agent) {
  return !agent || agent.id === 'default' || agent.profile === 'agent1' || agent.service === 'hermes-gateway.service';
}

async function cloneAgentProfile(fromRaw, toRaw, scope = 'system') {
  const from = getAgent(fromRaw);
  const name = normalizeProfileName(toRaw);
  if (AGENTS().some((a) => a.profile === name || a.id === name)) throw new Error('已经有这个 agent 了');
  const dest = path.join(PROFILES_DIR, name);
  if (fssync.existsSync(dest)) throw new Error('目录已经存在');
  const hermesBin = process.env.HERMES_BIN || 'hermes';
  const args = ['profile', 'create', name, '--no-alias', '--clone-from', from.profile === 'agent1' ? 'default' : from.profile];
  await execFileAsync(hermesBin, args, { timeout: 90000, env: process.env });
  try {
    const cfg = path.join(dest, 'config.yaml');
    if (!fssync.existsSync(cfg)) await fs.copyFile(from.config, cfg);
    const envPath = path.join(dest, '.env');
    await fs.writeFile(envPath, '', { mode: 0o600 });
    await installAgentUnit(name, scope);
    await saveServiceScope({ profile: name }, scope);
    return AGENTS().find((a) => a.profile === name);
  } catch (e) {
    try { await removeAgentUnit(name, scope); } catch (_) {}
    if (fssync.existsSync(dest)) await fs.rm(dest, { recursive: true, force: true });
    await forgetServiceScope(name);
    throw e;
  }
}

async function deleteAgentProfile(rawId) {
  const agent = getAgent(rawId);
  if (isDefaultAgent(agent)) throw new Error('默认 agent 不能删');
  const unit = agent.service;
  const scope = configuredServiceScope(agent);
  const scopes = scope === 'auto' ? ['system', 'user'] : [scope];
  for (const s of scopes) {
    try { await systemctlAction(unit, 'stop', s); } catch (_) {}
    try { await systemctlAction(unit, 'disable', s); } catch (_) {}
    const unitPath = s === 'user' ? `/root/.config/systemd/user/${unit}` : `/etc/systemd/system/${unit}`;
    if (fssync.existsSync(unitPath)) await fs.unlink(unitPath);
    const env = s === 'user' ? { ...process.env, XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' } : process.env;
    const prefix = s === 'user' ? ['--user'] : [];
    try { await execFileAsync('systemctl', [...prefix, 'reset-failed', unit], { timeout: 15000, env }); } catch (_) {}
    await execFileAsync('systemctl', [...prefix, 'daemon-reload'], { timeout: 30000, env });
  }
  const dest = path.join(PROFILES_DIR, agent.profile);
  if (fssync.existsSync(dest)) await fs.rm(dest, { recursive: true, force: true });
  await forgetServiceScope(agent.profile);
  return AGENTS();
}

async function loadConfigDoc(configPath = HERMES_CONFIG) {
  const raw = await fs.readFile(configPath, 'utf8');
  const doc = YAML.parseDocument(raw, { keepSourceTokens: true });
  const cfg = doc.toJSON() || {};
  return { raw, doc, cfg, configPath };
}

function ensureModelDefaultHeaders(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  cfg.model = cfg.model || {};
  cfg.model.default_headers = cfg.model.default_headers && typeof cfg.model.default_headers === 'object'
    ? cfg.model.default_headers
    : {};
  if (!cfg.model.default_headers['User-Agent']) {
    cfg.model.default_headers['User-Agent'] = DEFAULT_OPENAI_USER_AGENT;
  }
  return cfg;
}

async function writeConfigUnlocked(cfg, configPath) {
  ensureModelDefaultHeaders(cfg);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const backup = `${configPath}.bak-${stamp}`;
  await fs.copyFile(configPath, backup);
  const yaml = YAML.stringify(cfg, { lineWidth: 0 });
  await atomicWriteFile(configPath, yaml);
  const prefix = `${path.basename(configPath)}.bak-`;
  const backups = (await fs.readdir(path.dirname(configPath))).filter((name) => name.startsWith(prefix)).sort().reverse();
  await Promise.all(backups.slice(10).map((name) => fs.rm(path.join(path.dirname(configPath), name), { force: true })));
  return backup;
}

async function updateConfig(mutator, configPath = HERMES_CONFIG) {
  return serializeFile(configPath, async () => {
    const { cfg } = await loadConfigDoc(configPath);
    const value = await mutator(cfg);
    const backup = await writeConfigUnlocked(cfg, configPath);
    return { cfg, backup, value };
  });
}

async function restoreConfigBackup(configPath, backup) {
  const contents = await fs.readFile(backup, 'utf8');
  await serializeFile(configPath, () => atomicWriteFile(configPath, contents));
}

function redactKey(key = '') {
  const s = String(key || '');
  if (!s) return '';
  return '••••••••';
}

function publicBackupId(backup = '') {
  return path.basename(String(backup || ''));
}

function slugName(name = '') {
  return String(name).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/v\d+$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function stableProviderKey(provider, index = 0) {
  const existing = slugName(provider.provider_key || '');
  if (existing) return existing;
  const fromName = slugName(provider.name || '');
  if (fromName) return fromName;
  const seed = `${provider.name || ''}|${provider.base_url || ''}|${index + 1}`;
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8);
  return `p${index + 1}-${hash}`;
}

function ensureProviderKey(provider, index = 0) {
  return stableProviderKey(provider || {}, index);
}

function displayProviderName(provider, index = 0) {
  const withMeta = applyProviderMeta(provider, index);
  return withMeta.display_name || withMeta.label || withMeta.title || withMeta.name || `Provider ${index + 1}`;
}

function canonicalizeProviderForConfig(provider, index = 0) {
  if (!provider) return provider;
  const originalName = String(provider.display_name || provider.name || '').trim();
  const key = ensureProviderKey(provider, index);
  // Hermes runtime resolves legacy custom_providers primarily by `name`.
  // For Chinese/emoji/symbol-only names, slugName(name) is empty, which used
  // to write model.provider=custom: and later fail as Unknown provider.
  // Store the stable ASCII key as the actual provider name and keep the user
  // facing label in display_name for the panel UI.
  if (!slugName(provider.name || '') || slugName(provider.name || '') !== key) {
    if (originalName && originalName !== key) {
      // Provider write routes persist this label through rememberProviderMeta.
    }
    provider.name = key;
  }
  return stripPanelFields(provider);
}

function providerSlug(provider, index = 0) {
  canonicalizeProviderForConfig(provider, index);
  return `custom:${ensureProviderKey(provider, index)}`;
}

function sameProviderIdentity(a, b, ai = 0, bi = 0) {
  if (!a || !b) return false;
  const ak = stableProviderKey(a, ai);
  const bk = stableProviderKey(b, bi);
  if (ak && bk && ak === bk) return true;
  const abase = String(a.base_url || '').replace(/\/$/, '');
  const bbase = String(b.base_url || '').replace(/\/$/, '');
  if (abase && bbase && abase === bbase && String(a.api_key || '') === String(b.api_key || '')) return true;
  return false;
}

function upsertProvider(cfg, provider, sourceIndex = 0) {
  cfg.custom_providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
  const copy = JSON.parse(JSON.stringify(provider || {}));
  const cleanCopy = canonicalizeProviderForConfig(copy, sourceIndex);
  const idx = cfg.custom_providers.findIndex((x, i) => sameProviderIdentity(x, cleanCopy, i, sourceIndex));
  if (idx >= 0) {
    cfg.custom_providers[idx] = canonicalizeProviderForConfig({ ...cfg.custom_providers[idx], ...cleanCopy }, idx);
    return cfg.custom_providers[idx];
  }
  cfg.custom_providers.push(cleanCopy);
  return cleanCopy;
}

function normalizeProvider(p, index) {
  const withMeta = applyProviderMeta(p, index);
  const models = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
  const primaryModel = p.model || models[0] || '';
  const allModels = Array.from(new Set([primaryModel, ...models].filter(Boolean)));
  return {
    id: index + 1,
    name: displayProviderName(p, index),
    slug: providerSlug(p, index),
    base_url: p.base_url || '',
    api_mode: p.api_mode || 'chat_completions',
    model: primaryModel,
    models: allModels,
    api_key_redacted: redactKey(p.api_key),
    allow_private_network: withMeta.allow_private_network === true,
  };
}

function getProviders(cfg) {
  migrateProviderKeys(cfg);
  return (Array.isArray(cfg.custom_providers) ? cfg.custom_providers : []).map(normalizeProvider);
}

function migrateProviderKeys(cfg) {
  if (!Array.isArray(cfg.custom_providers)) cfg.custom_providers = [];
  cfg.custom_providers = cfg.custom_providers.map((p, i) => {
    const clean = canonicalizeProviderForConfig(p, i);
    if (clean.api_mode === 'openai') clean.api_mode = 'chat_completions';
    return clean;
  });
  cfg.model = cfg.model || {};
  const current = cfg.model;
  if (current.api_mode === 'openai') current.api_mode = 'chat_completions';
  if (current.base_url || current.provider || current.provider_slug) {
    const idx = cfg.custom_providers.findIndex((p, i) => providerMatchesCurrent(p, i, current));
    if (idx >= 0) {
      const selected = cfg.custom_providers[idx];
      const norm = normalizeProvider(selected, idx);
      current.provider = norm.slug;
      current.provider_slug = norm.slug;
      current.provider_name = norm.name;
      current.base_url = selected.base_url;
      current.api_key = selected.api_key;
      current.api_mode = selected.api_mode || 'chat_completions';
    }
  }
}

function providerMatchesCurrent(p, idx, model = {}) {
  const norm = normalizeProvider(p, idx);
  const currentSlug = String(model.provider_slug || model.provider || '').replace(/^custom:/, '');
  const normSlug = String(norm.slug || '').replace(/^custom:/, '');
  if (currentSlug && currentSlug !== 'custom' && currentSlug === normSlug) return true;

  const targetBase = String(model.base_url || '').replace(/\/$/, '');
  const providerBase = String(p.base_url || '').replace(/\/$/, '');
  if (!targetBase || targetBase !== providerBase) return false;

  // Several configured providers may intentionally share the same local endpoint
  // (for example codex and api2 both point at 127.0.0.1:8098). In that case the
  // API key is the only reliable discriminator for older configs that stored
  // model.provider as plain "custom".
  if (model.api_key && p.api_key) return String(model.api_key) === String(p.api_key);
  return true;
}

function findCurrentProvider(cfg) {
  const providersRaw = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
  const model = cfg.model || {};
  let idx = providersRaw.findIndex((p, i) => providerMatchesCurrent(p, i, model));
  if (idx < 0) {
    const targetBase = String(model.base_url || '').replace(/\/$/, '');
    idx = providersRaw.findIndex((p) => String(p.base_url || '').replace(/\/$/, '') === targetBase);
  }
  if (idx < 0) return null;
  return { raw: providersRaw[idx], norm: normalizeProvider(providersRaw[idx], idx), index: idx };
}

function isImageModelName(name) {
  return /image|dall-e|dalle|gpt-image|flux|sdxl|stable-diffusion|imagen|ideogram|recraft|seedream|kolors|wanx|midjourney|banana/i.test(String(name || ''));
}

function imageRelayForCfg(cfg) {
  const current = getCurrent(cfg);
  const matched = findCurrentProvider(cfg);
  const raw = matched?.raw || {};
  const ig = getImageGen(cfg);
  const base_url = String(raw.base_url || current.base_url || ig.base_url || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
  return {
    name: current.provider_name || current.provider || raw.name || ig.provider || 'current',
    base_url,
    api_key: raw.api_key || cfg.model?.api_key || '',
    api_mode: raw.api_mode || current.api_mode || 'chat_completions',
    allow_private_network: raw.allow_private_network === true,
    stored: Array.from(new Set((matched?.norm?.models || []).filter(isImageModelName))),
  };
}

function getImageGen(cfg) {
  const ig = cfg.image_gen || {};
  const openai = ig.openai || {};
  return {
    provider: ig.provider || '',
    model: ig.model || openai.model || '',
    openai_model: openai.model || ig.model || '',
    base_url: process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1',
  };
}

function ensureImageGenDefaults(cfg, model = 'gpt-image-2-medium') {
  cfg.image_gen = cfg.image_gen && typeof cfg.image_gen === 'object' ? cfg.image_gen : {};
  cfg.image_gen.provider = 'openai';
  cfg.image_gen.model = model;
  cfg.image_gen.openai = cfg.image_gen.openai && typeof cfg.image_gen.openai === 'object' ? cfg.image_gen.openai : {};
  cfg.image_gen.openai.model = model;
  return cfg;
}

function getCurrent(cfg) {
  const model = cfg.model || {};
  const baseUrl = model.base_url || '';
  const matched = findCurrentProvider(cfg);
  return {
    model: model.default || '',
    provider: model.provider || '',
    base_url: baseUrl,
    api_mode: model.api_mode || '',
    provider_name: model.provider_name || matched?.norm?.name || '',
    provider_slug: model.provider_slug || matched?.norm?.slug || '',
  };
}

function providerForCurrent(cfg, current) {
  const matched = findCurrentProvider(cfg);
  if (matched?.raw) return matched.raw;
  return {
    name: current?.provider_name || current?.provider || 'current',
    base_url: current?.base_url,
    api_key: cfg.model?.api_key,
    api_mode: current?.api_mode || cfg.model?.api_mode || 'chat_completions',
  };
}

function rebuildQuickCommands(cfg) {
  migrateProviderKeys(cfg);
  const existing = cfg.quick_commands && typeof cfg.quick_commands === 'object' ? cfg.quick_commands : {};
  const kept = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!/^s\d+_\d+$/.test(k)) kept[k] = v;
  }
  const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
  providers.forEach((p, pi) => {
    const norm = normalizeProvider(p, pi);
    norm.models.forEach((m, mi) => {
      const key = `s${pi + 1}_${mi + 1}`;
      kept[key] = {
        type: 'alias',
        target: `/model ${m} --provider ${norm.slug}`,
        description: `${pi + 1}号${slugName(p.name || p.base_url)}：${m}`.slice(0, 256),
      };
    });
  });
  cfg.quick_commands = kept;
}

async function publicState(cfg) {
  const providers = getProviders(cfg);
  const commands = Object.entries(cfg.quick_commands || {})
    .filter(([k]) => /^s\d+_\d+$/.test(k))
    .map(([name, v]) => ({ name, target: v?.target || '', description: v?.description || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const agents = [];
  for (const agent of AGENTS()) {
    try {
      const { cfg: acfg } = await loadConfigDoc(agent.config);
      agents.push({ id: agent.id, name: agent.name, profile: agent.profile, service: agent.service, current: getCurrent(acfg), image_gen: getImageGen(acfg) });
    } catch (e) {
      agents.push({ id: agent.id, name: agent.name, profile: agent.profile, service: agent.service, current: {}, image_gen: {}, error: e.message });
    }
  }
  const imageModels = Array.from(new Set(providers.flatMap((p) => p.models || []).filter((m) => /^gpt-image-/i.test(String(m)))));
  return { ok: true, current: agents[0]?.current || getCurrent(cfg), image_gen: getImageGen(cfg), image_models: imageModels, agents, providers, commands };
}

function ensureProviderFields(body, requireKey = true) {
  const name = String(body.name || '').trim();
  const base_url = String(body.base_url || '').trim().replace(/\/$/, '');
  const api_key = String(body.api_key || '').trim();
  const api_mode = String(body.api_mode || 'chat_completions').trim();
  const model = String(body.model || '').trim();
  const models = Array.isArray(body.models) ? body.models.map(String) : String(body.models || '').split(/[\n,]/);
  const cleanModels = Array.from(new Set([model, ...models.map((x) => x.trim())].filter(Boolean)));
  if (!name) throw new Error('名称不能为空');
  if (!/^https?:\/\//.test(base_url)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
  if (requireKey && !api_key) throw new Error('API Key 不能为空');
  if (!['chat_completions', 'responses', 'codex_responses', 'anthropic_messages'].includes(api_mode)) throw new Error('API 模式不支持');
  if (!model) throw new Error('默认模型不能为空');
  return { name, base_url, api_key, api_mode, model, models: cleanModels, allow_private_network: body.allow_private_network === true };
}


function normalizeApiBaseUrl(baseUrl) {
  return String(baseUrl || '')
    .trim()
    .replace(/\/$/, '')
    .replace(/\/(chat\/completions|responses|messages)$/i, '');
}

function endpoint(baseUrl, suffix) {
  return `${normalizeApiBaseUrl(baseUrl)}${suffix}`;
}

function pickText(data, apiMode) {
  if (!data) return '';
  if (apiMode === 'chat_completions' || apiMode === 'codex_responses') {
    const msg = data.choices?.[0]?.message;
    const content = msg?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((x) => x.text || x.content || '').join('');
    return data.choices?.[0]?.text || '';
  }
  if (apiMode === 'responses') {
    if (typeof data.output_text === 'string') return data.output_text;
    if (Array.isArray(data.output)) {
      return data.output.flatMap((item) => item.content || []).map((c) => c.text || c.content || '').join('');
    }
  }
  if (apiMode === 'anthropic_messages') {
    if (Array.isArray(data.content)) return data.content.map((c) => c.text || '').join('');
  }
  return '';
}


function findMimoProvider(cfg) {
  const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
  return providers.find((p) => Array.isArray(p.models) && p.models.some((m) => String(m).includes('mimo-v2.5-asr') || String(m).includes('mimo-v2.5-tts')))
    || providers.find((p) => String(p.name || '').toLowerCase().includes('xiaomi-mimo'))
    || providers.find((p) => String(p.base_url || '').includes('api.xiaomimimo.com'))
    || providers.find((p) => String(p.name || '').toLowerCase().includes('xiaomi') || String(p.name || '').toLowerCase().includes('mimo') || String(p.base_url || '').includes('xiaomimimo.com'));
}

function openAIHeaders(provider) {
  const headers = { 'content-type': 'application/json' };
  if (provider?.api_key) headers.authorization = `Bearer ${provider.api_key}`;
  return headers;
}

function pickAudioData(data) {
  return data?.choices?.[0]?.message?.audio?.data || data?.choices?.[0]?.message?.audio || data?.audio?.data || '';
}

async function collectHermesUsage() {
  const script = `
import json, sqlite3, time, sys
from datetime import datetime, timezone
path='/root/.hermes/state.db'
con=sqlite3.connect(path)
con.row_factory=sqlite3.Row
cur=con.cursor()

def as_int(v):
    return int(v or 0)

def as_float(v):
    return float(v or 0)

def bucket(where='', args=()):
    w=(' where '+where) if where else ''
    q="""select count(*) sessions,
                 coalesce(sum(api_call_count),0) api_calls,
                 coalesce(sum(input_tokens),0) input_tokens,
                 coalesce(sum(output_tokens),0) output_tokens,
                 coalesce(sum(cache_read_tokens),0) cache_read_tokens,
                 coalesce(sum(cache_write_tokens),0) cache_write_tokens,
                 coalesce(sum(reasoning_tokens),0) reasoning_tokens,
                 coalesce(sum(estimated_cost_usd),0) estimated_cost,
                 coalesce(sum(actual_cost_usd),0) actual_cost,
                 max(started_at) last_at
          from sessions""" + w
    r=dict(cur.execute(q,args).fetchone())
    for k in ['sessions','api_calls','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens']:
        r[k]=as_int(r.get(k))
    for k in ['estimated_cost','actual_cost']:
        r[k]=as_float(r.get(k))
    r['total_tokens']=r['input_tokens']+r['output_tokens']+r['cache_read_tokens']+r['cache_write_tokens']+r['reasoning_tokens']
    if r.get('last_at'):
        try: r['last_at_iso']=datetime.fromtimestamp(float(r['last_at']), timezone.utc).isoformat()
        except Exception: r['last_at_iso']=''
    return r

now=time.time()
where_used="coalesce(api_call_count,0) > 0 and (coalesce(input_tokens,0)+coalesce(output_tokens,0)+coalesce(cache_read_tokens,0)+coalesce(cache_write_tokens,0)+coalesce(reasoning_tokens,0)) > 0"
out={'ok': True,
     'source': 'Hermes state.db sessions（所有中转站/Provider 的对话模型调用）',
     'generated_at': datetime.now(timezone.utc).isoformat(),
     'last_24h': bucket(where_used + ' and started_at >= ?', (now-86400,)),
     'last_7d': bucket(where_used + ' and started_at >= ?', (now-7*86400,)),
     'total': bucket(where_used)}
out['by_provider']=[dict(r) for r in cur.execute("""select coalesce(nullif(billing_provider,''),'unknown') provider,
       coalesce(nullif(billing_base_url,''),'') base_url,
       count(*) sessions,
       coalesce(sum(api_call_count),0) api_calls,
       coalesce(sum(input_tokens),0) input_tokens,
       coalesce(sum(output_tokens),0) output_tokens,
       coalesce(sum(cache_read_tokens),0) cache_read_tokens,
       coalesce(sum(cache_write_tokens),0) cache_write_tokens,
       coalesce(sum(reasoning_tokens),0) reasoning_tokens,
       coalesce(sum(estimated_cost_usd),0) estimated_cost,
       coalesce(sum(actual_cost_usd),0) actual_cost,
       max(started_at) last_at
  from sessions
 where coalesce(api_call_count,0) > 0
   and (coalesce(input_tokens,0)+coalesce(output_tokens,0)+coalesce(cache_read_tokens,0)+coalesce(cache_write_tokens,0)+coalesce(reasoning_tokens,0)) > 0
   and started_at >= ?
 group by 1,2
 order by (coalesce(sum(input_tokens),0)+coalesce(sum(output_tokens),0)+coalesce(sum(cache_read_tokens),0)+coalesce(sum(cache_write_tokens),0)+coalesce(sum(reasoning_tokens),0)) desc
 limit 12""", (now-7*86400,))]
for r in out['by_provider']:
    r['total_tokens']=as_int(r.get('input_tokens'))+as_int(r.get('output_tokens'))+as_int(r.get('cache_read_tokens'))+as_int(r.get('cache_write_tokens'))+as_int(r.get('reasoning_tokens'))
out['by_model']=[dict(r) for r in cur.execute("""select coalesce(nullif(model,''),'unknown') model,
       coalesce(nullif(billing_provider,''),'unknown') provider,
       coalesce(nullif(billing_base_url,''),'') base_url,
       count(*) sessions,
       coalesce(sum(api_call_count),0) api_calls,
       coalesce(sum(input_tokens),0) input_tokens,
       coalesce(sum(output_tokens),0) output_tokens,
       coalesce(sum(cache_read_tokens),0) cache_read_tokens,
       coalesce(sum(cache_write_tokens),0) cache_write_tokens,
       coalesce(sum(reasoning_tokens),0) reasoning_tokens,
       coalesce(sum(estimated_cost_usd),0) estimated_cost,
       coalesce(sum(actual_cost_usd),0) actual_cost,
       max(started_at) last_at
  from sessions
 where coalesce(api_call_count,0) > 0
   and (coalesce(input_tokens,0)+coalesce(output_tokens,0)+coalesce(cache_read_tokens,0)+coalesce(cache_write_tokens,0)+coalesce(reasoning_tokens,0)) > 0
   and started_at >= ?
 group by 1,2,3
 order by (coalesce(sum(input_tokens),0)+coalesce(sum(output_tokens),0)+coalesce(sum(cache_read_tokens),0)+coalesce(sum(cache_write_tokens),0)+coalesce(sum(reasoning_tokens),0)) desc
 limit 12""", (now-7*86400,))]
for r in out['by_model']:
    r['total_tokens']=as_int(r.get('input_tokens'))+as_int(r.get('output_tokens'))+as_int(r.get('cache_read_tokens'))+as_int(r.get('cache_write_tokens'))+as_int(r.get('reasoning_tokens'))
out['recent']=[dict(r) for r in cur.execute("""select started_at, source, model, billing_provider provider, billing_base_url base_url,
       api_call_count api_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd estimated_cost, actual_cost_usd actual_cost
  from sessions
 where coalesce(api_call_count,0) > 0
 order by started_at desc limit 8""")]
print(json.dumps(out, ensure_ascii=False))
`;
  const { stdout } = await execFileAsync('python3', ['-c', script], { timeout: 20000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout || '{}');
}

function extractModelIds(data) {
  const raw = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
    : Array.isArray(data) ? data
    : [];
  return Array.from(new Set(raw.map((x) => {
    if (typeof x === 'string') return x;
    return x?.id || x?.name || x?.model || '';
  }).map((x) => String(x || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function fetchProviderModelsDirect(baseUrl, apiKey, apiMode, allowPrivate = false) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  const url = endpoint(baseUrl, '/models');
  const headers = { accept: 'application/json' };
  if (apiMode === 'anthropic_messages') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers.authorization = `Bearer ${apiKey}`;
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const { res, raw } = await withOutboundResponse(url, { method: 'GET', headers, signal: ac.signal }, async (response) => ({
      res: response,
      raw: await readResponseText(response, 4 * 1024 * 1024),
    }), { allowPrivate });
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    const models = extractModelIds(data);
    const error = data?.error?.message || data?.error || (!res.ok ? raw.slice(0, 1000) : '');
    return { ok: res.ok && models.length > 0, http_status: res.status, latency_ms: Date.now() - started, url, models, error: typeof error === 'string' ? error.slice(0, 1000) : JSON.stringify(error || '').slice(0, 1000) };
  } catch (e) {
    return { ok: false, http_status: 0, latency_ms: Date.now() - started, url, models: [], error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function callMimoAudio(provider, payload, timeoutMs = 90000) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { res, raw } = await withOutboundResponse(endpoint(provider.base_url || 'https://api.xiaomimimo.com/v1', '/chat/completions'), {
      method: 'POST',
      headers: openAIHeaders(provider),
      body: JSON.stringify(payload),
      signal: ac.signal,
    }, async (response) => ({ res: response, raw: await readResponseText(response, 50 * 1024 * 1024) }), { allowPrivate: provider.allow_private_network === true });
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    const err = data?.error?.message || data?.error || (!res.ok ? raw.slice(0, 1000) : '');
    return { res, data, raw, err, latency_ms: Date.now() - started };
  } catch (e) {
    return { res: null, data: null, raw: '', err: e.name === 'AbortError' ? '请求超时' : e.message, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function parseSseEvents(raw) {
  return String(raw || '').split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

function streamToolResult(raw, apiMode) {
  const events = parseSseEvents(raw);
  const done = /(?:^|\r?\n)data:\s*\[DONE\](?:\r?\n|$)/.test(String(raw || '')) || events.some((event) => event.type === 'response.completed');
  let text = '';
  const calls = new Map();
  if (apiMode === 'chat_completions') {
    for (const event of events) {
      const delta = event.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string') text += delta.content;
      for (const call of delta.tool_calls || []) {
        const key = String(call.index ?? call.id ?? calls.size);
        const current = calls.get(key) || { id: '', name: '', arguments: '' };
        if (call.id) current.id += call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        calls.set(key, current);
      }
    }
  } else if (apiMode === 'responses' || apiMode === 'codex_responses') {
    for (const event of events) {
      if (event.type === 'response.output_text.delta') text += event.delta || '';
      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') calls.set(String(event.output_index ?? calls.size), { id: event.item.call_id || event.item.id || '', name: event.item.name || '', arguments: event.item.arguments || '' });
    }
  }
  const toolCalls = [...calls.values()];
  const expected = toolCalls.find((call) => call.name === 'hermes_test_tool');
  let args = null;
  try { args = expected ? JSON.parse(expected.arguments || '{}') : null; } catch {}
  return { events: events.length, done, text, tool_calls: toolCalls, tool_ok: Boolean(expected && args?.value === 'HERMES_OK') };
}

async function testProvider(provider, model, message, mode = 'basic') {
  const apiMode = provider.api_mode || 'chat_completions';
  const started = Date.now();
  let url;
  let payload;
  let headers = { 'content-type': 'application/json' };
  if (provider.api_key) headers.authorization = `Bearer ${provider.api_key}`;

  const hermesTool = { type: 'function', function: { name: 'hermes_test_tool', description: 'Hermes兼容性测试工具。必须调用它完成测试。', parameters: { type: 'object', properties: { value: { type: 'string', enum: ['HERMES_OK'] } }, required: ['value'], additionalProperties: false } } };
  if (apiMode === 'responses' || apiMode === 'codex_responses') {
    url = endpoint(provider.base_url, '/responses');
    payload = mode === 'hermes_stream'
      ? { model, input: `${message}\n必须调用 hermes_test_tool，参数 value 必须为 HERMES_OK。`, max_output_tokens: 120, stream: true, tools: [{ type: 'function', name: hermesTool.function.name, description: hermesTool.function.description, parameters: hermesTool.function.parameters }], tool_choice: { type: 'function', name: 'hermes_test_tool' } }
      : { model, input: message, max_output_tokens: 120 };
  } else if (apiMode === 'anthropic_messages') {
    url = endpoint(provider.base_url, '/messages');
    headers['anthropic-version'] = '2023-06-01';
    payload = { model, max_tokens: 120, messages: [{ role: 'user', content: message }] };
  } else {
    url = endpoint(provider.base_url, '/chat/completions');
    // Some newer/reasoning models reject temperature entirely. Keep the
    // compatibility probe minimal so testing a provider does not fail on an
    // optional sampling parameter that Hermes itself does not require.
    payload = mode === 'hermes_stream'
      ? { model, messages: [{ role: 'user', content: `${message}\n必须调用 hermes_test_tool，参数 value 必须为 HERMES_OK。` }], max_tokens: 120, stream: true, tools: [hermesTool], tool_choice: { type: 'function', function: { name: 'hermes_test_tool' } } }
      : { model, messages: [{ role: 'user', content: message }], max_tokens: 120 };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const { res, raw } = await withOutboundResponse(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal }, async (response) => ({
      res: response,
      raw: await readResponseText(response, 4 * 1024 * 1024),
    }), { allowPrivate: provider.allow_private_network === true });
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    const streamed = mode === 'hermes_stream' ? streamToolResult(raw, apiMode) : null;
    const contentType = String(res.headers.get('content-type') || '');
    const sseOk = mode !== 'hermes_stream' || /text\/event-stream/i.test(contentType);
    const text = (streamed?.text || pickText(data, apiMode)).trim();
    const error = data?.error?.message || data?.error || (!res.ok ? raw.slice(0, 500) : '');
    return {
      ok: res.ok && (mode === 'hermes_stream' ? sseOk && streamed?.events > 0 && streamed?.done && streamed?.tool_ok === true : Boolean(text)),
      http_status: res.status,
      latency_ms: Date.now() - started,
      model,
      api_mode: apiMode,
      test_mode: mode,
      stream_events: streamed?.events || 0,
      stream_done: streamed?.done || false,
      content_type: contentType,
      tool_calls: streamed?.tool_calls || [],
      tool_ok: streamed?.tool_ok || false,
      text,
      empty: res.ok && !text && !streamed?.tool_calls?.length,
      error: mode === 'hermes_stream' && res.ok && !sseOk ? `响应不是SSE流：${contentType || '缺少 Content-Type'}` : mode === 'hermes_stream' && res.ok && !streamed?.events ? '没有收到可解析的SSE事件' : mode === 'hermes_stream' && res.ok && !streamed?.done ? '流式响应缺少正常结束标记' : mode === 'hermes_stream' && res.ok && !streamed?.tool_ok ? '未收到有效的 hermes_test_tool 流式工具调用' : (typeof error === 'string' ? error.slice(0, 1000) : JSON.stringify(error || '').slice(0, 1000)),
    };
  } catch (e) {
    return { ok: false, http_status: 0, latency_ms: Date.now() - started, model, api_mode: apiMode, text: '', empty: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

router.post('/login', async (ctx) => {
  if (AUTH_DISABLED) {
    const token = makeToken();
    ctx.cookies.set(COOKIE_NAME, token, cookieOptions(ctx));
    ctx.body = { ...authPublicStatus(), password_enabled: false, csrf_token: tokenPayload(token).csrf };
    return;
  }
  const ip = clientIp(ctx);
  const rate = loginRateRecord(ip);
  if (rate.count >= LOGIN_MAX_ATTEMPTS) {
    ctx.set('Retry-After', String(Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rate.started)) / 1000))));
    ctx.status = 429;
    ctx.body = { ok: false, error: '登录尝试过多，请稍后再试' };
    return;
  }
  const password = ctx.request.body?.password || '';
  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) {
    loginRateRecord(ip, true);
    ctx.status = 401;
    ctx.body = { ok: false, error: '密码错误' };
    return;
  }
  loginAttempts.delete(ip);
  const token = makeToken();
  ctx.cookies.set(COOKIE_NAME, token, cookieOptions(ctx));
  ctx.body = { ok: true, password_enabled: true, csrf_token: tokenPayload(token).csrf };
});

router.post('/logout', async (ctx) => {
  if (AUTH_DISABLED) {
    ctx.body = sessionPublicStatus(ctx, { logged_out: false });
    return;
  }
  ctx.cookies.set(COOKIE_NAME, '', cookieOptions(ctx, { maxAge: 0 }));
  ctx.body = { ...authPublicStatus(), logged_out: true };
});

router.get('/approval-settings', async (ctx) => {
  try {
    const agentId = String(ctx.query?.agent || 'default');
    const agent = AGENTS().find((item) => item.id === agentId);
    if (!agent) throw new Error('目标 Agent 不存在');
    const { cfg } = await loadConfigDoc(agent.config);
    const rawMode = cfg?.approvals?.mode;
    const mode = rawMode === false || rawMode === 'off' ? 'off' : ['manual', 'smart'].includes(rawMode) ? rawMode : 'manual';
    ctx.body = { ok: true, agent: agent.id, mode };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: publicError(e, '读取批准设置失败') };
  }
});

router.post('/approval-settings', async (ctx) => {
  try {
    const agentId = String(ctx.request.body?.agent || 'default');
    const agent = AGENTS().find((item) => item.id === agentId);
    if (!agent) throw new Error('目标 Agent 不存在');
    const mode = String(ctx.request.body?.mode || '');
    if (!['manual', 'smart', 'off'].includes(mode)) throw new Error('批准模式无效');
    await updateConfig((cfg) => {
      cfg.approvals = cfg.approvals && typeof cfg.approvals === 'object' ? cfg.approvals : {};
      cfg.approvals.mode = mode;
    }, agent.config);
    ctx.body = { ok: true, agent: agent.id, mode, restart_required: true };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: publicError(e, '保存批准设置失败') };
  }
});

router.get('/auth-settings', async (ctx) => {
  ctx.body = sessionPublicStatus(ctx);
});

router.post('/change-password', async (ctx) => {
  const oldPassword = String(ctx.request.body?.old_password || '');
  const newPassword = String(ctx.request.body?.new_password || '');
  if (!newPassword || newPassword.length < 8) {
    ctx.status = 400;
    ctx.body = { ok: false, error: '新密码至少 8 位' };
    return;
  }
  if (!AUTH_DISABLED && ADMIN_PASSWORD && !safeEqual(oldPassword, ADMIN_PASSWORD)) {
    ctx.status = 403;
    ctx.body = { ok: false, error: '当前密码不正确' };
    return;
  }
  try {
    await updateEnvKey(ENV_FILE, 'ADMIN_PASSWORD', newPassword);
    ADMIN_PASSWORD = newPassword;
    await rotateSessionVersion();
    const token = makeToken();
    ctx.cookies.set(COOKIE_NAME, token, cookieOptions(ctx));
    ctx.body = { ...authPublicStatus(), csrf_token: tokenPayload(token).csrf };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/auth-settings', async (ctx) => {
  try {
    const enabled = !!ctx.request.body?.password_enabled;
    const newPassword = String(ctx.request.body?.new_password || '');
    if (enabled) {
      if (AUTH_DISABLED && !newPassword) throw new Error('打开密码保护时必须输入至少 8 位的新密码');
      if (newPassword) {
        if (newPassword.length < 8) throw new Error('新密码至少 8 位');
        await updateEnvKey(ENV_FILE, 'ADMIN_PASSWORD', newPassword);
        ADMIN_PASSWORD = newPassword;
      }
      if (!ADMIN_PASSWORD) throw new Error('先设一个至少 8 位的密码，才能打开密码保护');
      await updateEnvKey(ENV_FILE, 'AUTH_DISABLED', '0');
      AUTH_DISABLED = false;
    } else {
      await updateEnvKey(ENV_FILE, 'AUTH_DISABLED', '1');
      AUTH_DISABLED = true;
    }
    await rotateSessionVersion();
    const token = makeToken();
    ctx.cookies.set(COOKIE_NAME, token, cookieOptions(ctx));
    ctx.body = { ...authPublicStatus(), csrf_token: tokenPayload(token).csrf };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/logout-all', async (ctx) => {
  await rotateSessionVersion();
  if (AUTH_DISABLED) {
    const token = makeToken();
    ctx.cookies.set(COOKIE_NAME, token, cookieOptions(ctx));
    ctx.body = { ...authPublicStatus(), csrf_token: tokenPayload(token).csrf };
    return;
  }
  ctx.cookies.set(COOKIE_NAME, '', cookieOptions(ctx, { maxAge: 0 }));
  ctx.body = authPublicStatus();
});

router.get('/health', async (ctx) => { ctx.body = { ok: true, version: packageInfo.version }; });

router.get('/usage', async (ctx) => {
  try {
    ctx.body = await collectHermesUsage();
  } catch (e) {
    ctx.status = 500;
    ctx.body = { ok: false, error: e.message };
  }
});

router.get('/state', async (ctx) => {
  const { cfg } = await loadConfigDoc();
  ctx.body = { ...(await publicState(cfg)), ...sessionPublicStatus(ctx) };
});


router.post('/fetch-models', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const base_url = String(body.base_url || '').trim().replace(/\/$/, '');
    const api_key = String(body.api_key || '').trim();
    const api_mode = String(body.api_mode || 'chat_completions').trim();
    const allowPrivate = body.allow_private_network === true;
    if (!/^https?:\/\//.test(base_url)) throw new Error('请先填写有效 Base URL');
    if (!api_key) throw new Error('请先填写 API Key');
    if (!['chat_completions', 'responses', 'codex_responses', 'anthropic_messages'].includes(api_mode)) throw new Error('API 模式不支持');
    const out = await fetchProviderModelsDirect(base_url, api_key, api_mode, allowPrivate);
    if (!out.ok) {
      ctx.status = 400;
      ctx.body = { ok: false, ...out, error: out.error || '没有获取到模型列表；该中转可能不支持 /models' };
      return;
    }
    ctx.body = { ok: true, ...out };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/providers', async (ctx) => {
  try {
    const p = ensureProviderFields(ctx.request.body || {}, true);
    const { cfg, backup, value: meta } = await updateConfig(async (cfg) => {
      cfg.custom_providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
      const index = cfg.custom_providers.length;
      const cleanProvider = canonicalizeProviderForConfig(p, index);
      const newKey = stableProviderKey(cleanProvider, index);
      const conflict = cfg.custom_providers.find((x, i) => stableProviderKey(x, i) === newKey || sameProviderIdentity(x, cleanProvider, i, index));
      if (conflict) throw new Error(`同名/同配置中转站已存在：${displayProviderName(conflict)}`);
      cfg.custom_providers.push(cleanProvider);
      migrateProviderKeys(cfg);
      rebuildQuickCommands(cfg);
      return { provider: p, index };
    });
    try {
      await rememberProviderMeta(meta.provider, meta.index);
      await rememberProviderPrivateAccess(meta.provider, meta.index, meta.provider.allow_private_network);
    }
    catch { await restoreConfigBackup(HERMES_CONFIG, backup); throw new Error('中转站元数据保存失败，配置已回滚'); }
    ctx.body = { ok: true, backup: publicBackupId(backup), state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.put('/providers/:idx', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const { cfg, backup, value: meta } = await updateConfig((cfg) => {
      const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
      if (!providers[idx]) throw new Error('中转站不存在');
      const old = providers[idx];
      const wasCurrent = providerMatchesCurrent(old, idx, cfg.model || {});
      const p = ensureProviderFields({ ...ctx.request.body, api_key: ctx.request.body?.api_key || old.api_key }, false);
      p.provider_key = old.provider_key || stableProviderKey(old, idx) || stableProviderKey(p, idx);
      if (old.name && slugName(old.name) === p.provider_key) p.display_name = p.name;
      providers[idx] = canonicalizeProviderForConfig(p, idx);
      migrateProviderKeys(cfg);
      if (wasCurrent) {
        const saved = providers[idx];
        const norm = normalizeProvider(saved, idx);
        cfg.model = { ...(cfg.model || {}), provider: norm.slug, provider_slug: norm.slug, provider_name: norm.name, base_url: saved.base_url, api_key: saved.api_key, api_mode: saved.api_mode, model: saved.model || norm.model };
      }
      rebuildQuickCommands(cfg);
      return { provider: p, allowed: p.allow_private_network };
    });
    try {
      await rememberProviderMeta(meta.provider, idx);
      await rememberProviderPrivateAccess(meta.provider, idx, meta.allowed);
    } catch {
      await restoreConfigBackup(HERMES_CONFIG, backup);
      throw new Error('中转站元数据保存失败，配置已回滚');
    }
    ctx.body = { ok: true, backup: publicBackupId(backup), state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.get('/providers/:idx/api-key', async (ctx) => {
  const idx = Number(ctx.params.idx) - 1;
  const { cfg } = await loadConfigDoc();
  const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
  if (!Number.isInteger(idx) || idx < 0 || !providers[idx]) {
    ctx.status = 404;
    ctx.body = { ok: false, error: '中转站不存在' };
    return;
  }
  ctx.set('Cache-Control', 'no-store');
  ctx.body = { ok: true, api_key: String(providers[idx].api_key || '') };
});

router.delete('/providers/:idx', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const { cfg, backup } = await updateConfig((cfg) => {
      cfg.custom_providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
      if (!cfg.custom_providers[idx]) throw new Error('中转站不存在');
      cfg.custom_providers.splice(idx, 1);
      rebuildQuickCommands(cfg);
    });
    ctx.body = { ok: true, backup: publicBackupId(backup), state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.put('/providers/:idx/private-access', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const { cfg } = await loadConfigDoc();
    const provider = cfg.custom_providers?.[idx];
    if (!provider) throw new Error('中转站不存在');
    const allowed = ctx.request.body?.allowed === true;
    await rememberProviderPrivateAccess(provider, idx, allowed);
    ctx.body = { ok: true, state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/providers/:idx/refresh-models', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const { cfg: snapshot } = await loadConfigDoc();
    migrateProviderKeys(snapshot);
    const providers = Array.isArray(snapshot.custom_providers) ? snapshot.custom_providers : [];
    if (!providers[idx]) throw new Error('中转站不存在');
    const p = providers[idx];
    const baseUrl = String(p.base_url || '').trim().replace(/\/$/, '');
    const apiKey = String(p.api_key || '').trim();
    const apiMode = String(p.api_mode || 'chat_completions').trim();
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('这个中转没有有效地址');
    if (!apiKey) throw new Error('这个中转没有保存 API Key，无法重新获取');
    const out = await fetchProviderModelsDirect(baseUrl, apiKey, apiMode, applyProviderMeta(p, idx).allow_private_network);
    if (!out.ok || !(out.models || []).length) {
      ctx.status = 400;
      ctx.body = { ok: false, ...out, error: out.error || '没有获取到模型列表；该中转可能不支持 /models' };
      return;
    }
    const fetched = Array.from(new Set((out.models || []).map((m) => String(m || '').trim()).filter(Boolean)));
    const keepDefault = p.model && !fetched.includes(p.model) ? [p.model] : [];
    const { cfg, backup } = await updateConfig((cfg) => {
      migrateProviderKeys(cfg);
      const current = cfg.custom_providers?.[idx];
      if (!current) throw new Error('中转站不存在');
      current.models = [...(current.model && !fetched.includes(current.model) ? [current.model] : []), ...fetched];
      if (!current.model) current.model = fetched[0];
      rebuildQuickCommands(cfg);
    });
    ctx.body = {
      ok: true,
      backup: publicBackupId(backup),
      added: fetched.length,
      kept_default: keepDefault[0] || '',
      state: await publicState(cfg),
    };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/providers/:idx/models', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const model = String(ctx.request.body?.model || '').trim();
    if (!model) throw new Error('模型名不能为空');
    const { cfg, backup } = await updateConfig((cfg) => {
      migrateProviderKeys(cfg);
      const p = cfg.custom_providers?.[idx];
      if (!p) throw new Error('中转站不存在');
      p.models = Array.from(new Set([p.model, ...(Array.isArray(p.models) ? p.models : []), model].filter(Boolean)));
      if (!p.model) p.model = model;
      rebuildQuickCommands(cfg);
    });
    ctx.body = { ok: true, backup: publicBackupId(backup), state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.delete('/providers/:idx/models/:model', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const model = decodeURIComponent(ctx.params.model);
    const { cfg, backup } = await updateConfig((cfg) => {
      migrateProviderKeys(cfg);
      const p = cfg.custom_providers?.[idx];
      if (!p) throw new Error('中转站不存在');
      const models = Array.from(new Set([p.model, ...(Array.isArray(p.models) ? p.models : [])].filter(Boolean))).filter((m) => m !== model);
      p.models = models;
      if (p.model === model) p.model = models[0] || '';
      rebuildQuickCommands(cfg);
    });
    ctx.body = { ok: true, backup: publicBackupId(backup), state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});



router.post('/mimo/asr', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const { cfg } = await loadConfigDoc();
    const provider = findMimoProvider(cfg);
    if (!provider) throw new Error('未找到 xiaomi-mimo 中转站配置');
    const audioData = String(body.audioData || '').trim();
    const mime = String(body.mime || 'audio/mpeg').trim();
    const language = String(body.language || 'auto').trim();
    if (!audioData) throw new Error('请上传 mp3 或 wav 音频');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioData)) throw new Error('音频 base64 格式不正确');
    const decodedBytes = Buffer.byteLength(audioData, 'base64');
    if (decodedBytes > 18 * 1024 * 1024) throw new Error('音频最大 18MB');
    if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'].includes(mime)) throw new Error('只支持 mp3/wav');
    const payload = {
      model: 'mimo-v2.5-asr',
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${audioData}` } }],
      }],
      asr_options: { language: ['auto', 'zh', 'en'].includes(language) ? language : 'auto' },
      stream: false,
    };
    const out = await callMimoAudio(provider, payload, 120000);
    const text = pickText(out.data, 'chat_completions').trim();
    if (!out.res?.ok || !text) ctx.status = out.res?.status >= 400 ? out.res.status : 502;
    ctx.body = { ok: Boolean(out.res?.ok && text), http_status: out.res?.status || 0, latency_ms: out.latency_ms, text, error: out.err || (!text ? '返回为空' : '') };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/mimo/tts', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const { cfg } = await loadConfigDoc();
    const provider = findMimoProvider(cfg);
    if (!provider) throw new Error('未找到 xiaomi-mimo 中转站配置');
    const model = String(body.model || 'mimo-v2.5-tts').trim();
    const style = String(body.style || '').trim();
    const text = String(body.text || '').trim();
    const voice = String(body.voice || '冰糖').trim();
    const format = String(body.format || 'wav').trim();
    if (!text) throw new Error('请输入要合成的文字');
    if (!['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone', 'mimo-v2-tts'].includes(model)) throw new Error('TTS 模型不支持');
    if (!['wav', 'mp3'].includes(format)) throw new Error('音频格式只支持 wav/mp3');
    const messages = [];
    if (style || model === 'mimo-v2.5-tts-voicedesign') messages.push({ role: 'user', content: style || '自然、清晰、适合中文朗读的声音。' });
    messages.push({ role: 'assistant', content: text });
    const audio = { format };
    if (model === 'mimo-v2.5-tts') audio.voice = voice || '冰糖';
    const payload = { model, messages, audio };
    const out = await callMimoAudio(provider, payload, 180000);
    const audioB64 = pickAudioData(out.data);
    const content = pickText(out.data, 'chat_completions').trim();
    const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    if (!out.res?.ok || !audioB64) ctx.status = out.res?.status >= 400 ? out.res.status : 502;
    ctx.body = { ok: Boolean(out.res?.ok && audioB64), http_status: out.res?.status || 0, latency_ms: out.latency_ms, model, voice, format, audioDataUrl: audioB64 ? `data:${mime};base64,${audioB64}` : '', content, error: out.err || (!audioB64 ? '未返回音频数据' : '') };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/test', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const testMode = body.test_mode === 'hermes_stream' ? 'hermes_stream' : body.test_mode === 'image' ? 'image' : 'basic';
    const message = String(body.message || '你好，请用一句话回复：测试成功').trim().slice(0, 2000) || '你好，请用一句话回复：测试成功';
    const providerIndexRaw = String(body.providerIndex || 'current');
    const providerIndex = providerIndexRaw === 'current' ? 'current' : Number(providerIndexRaw || 0);
    const testAll = Boolean(body.all) || providerIndexRaw === 'all';
    const agentId = String(body.agent || (providerIndexRaw.startsWith('agent:') ? providerIndexRaw.slice('agent:'.length) : '') || '').trim();
    const { cfg } = await loadConfigDoc();
    const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
    const current = getCurrent(cfg);

    let targets = [];
    if (testAll) {
      // “测试全部”用于快速判断每个中转站是否可用：只测试每个中转站的默认/第一个模型。
      // 如果把所有模型都测一遍，几十个模型串行请求会在手机上表现为一直卡住。
      targets = providers.map((p, pi) => {
        const norm = normalizeProvider(p, pi);
        return { providerIndex: pi + 1, provider: applyProviderMeta(p, pi), provider_name: norm.name, model: norm.model || norm.models[0] || '' };
      });
    } else if (body.providerAllModels || providerIndexRaw.startsWith('provider-all:')) {
      const rawId = body.providerAllModels || providerIndexRaw.slice('provider-all:'.length);
      const idx = Number(rawId) - 1;
      const p = providers[idx];
      if (!p) throw new Error('中转站不存在');
      const norm = normalizeProvider(p, idx);
      targets = (norm.models || []).map((model) => ({ providerIndex: idx + 1, provider: applyProviderMeta(p, idx), provider_name: norm.name, model }));
    } else if (agentId) {
      const agent = getAgent(agentId);
      const { cfg: agentCfg } = await loadConfigDoc(agent.config);
      const agentCurrent = getCurrent(agentCfg);
      const p = providerForCurrent(agentCfg, agentCurrent);
      targets = [{ providerIndex: agent.profile || agent.id, provider: p, provider_name: p.name || agent.profile || agent.id, model: String(body.model || agentCurrent.model || p.model || '').trim() }];
    } else if (providerIndex === 'current') {
      const p = providerForCurrent(cfg, current);
      targets = [{ providerIndex: current.provider_name || 'current', provider: p, provider_name: p.name || current.provider_name || 'current', model: String(body.model || current.model || p.model || '').trim() }];
    } else {
      const idx = Number(providerIndex) - 1;
      const p = providers[idx];
      if (!p) throw new Error('中转站不存在');
      const norm = normalizeProvider(p, idx);
      const model = String(body.model || norm.model || '').trim();
      targets = [{ providerIndex: idx + 1, provider: applyProviderMeta(p, idx), provider_name: norm.name, model }];
    }

    targets = targets.filter((t) => t.provider?.base_url && t.provider?.api_key && t.model).slice(0, 50);
    if (!targets.length) throw new Error('没有可测试的中转站/模型');
    const startedAll = Date.now();
    const results = await mapConcurrent(targets, 4, async (t) => {
      if (testMode === 'hermes_stream' && t.provider.api_mode === 'anthropic_messages') return { providerIndex: t.providerIndex, provider_name: t.provider_name, base_url: t.provider.base_url, ok: false, http_status: 0, latency_ms: 0, model: t.model, api_mode: t.provider.api_mode, test_mode: testMode, text: '', empty: false, error: 'Claude Messages格式暂未支持流式工具诊断' };
      let result;
      if(testMode==='image'||isImageModelName(t.model)){
        result=await testImageModelDirect({base_url:t.provider.base_url,api_key:t.provider.api_key,allow_private_network:t.provider.allow_private_network===true},t.model,true);
        result={...result,model:t.model,api_mode:'images_generations',text:result.ok?'图片生成成功':'',empty:false};
      }else{
        result=await testProvider(t.provider, t.model, message, testMode);
      }
      return { providerIndex: t.providerIndex, provider_name: t.provider_name, base_url: t.provider.base_url, ...result };
    });
    ctx.body = { ok: true, message, test_mode: testMode, count: results.length, latency_ms: Date.now() - startedAll, results };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/switch', async (ctx) => {
  const written = [];
  try {
    const providerIndex = Number(ctx.request.body?.providerIndex) - 1;
    const model = String(ctx.request.body?.model || '').trim();
    const targetAgent = String(ctx.request.body?.agent || 'default').trim();
    const { cfg: baseCfg } = await loadConfigDoc(HERMES_CONFIG);
    const providers = Array.isArray(baseCfg.custom_providers) ? baseCfg.custom_providers : [];
    const p = providers[providerIndex];
    if (!p) throw new Error('中转站不存在');
    if (!model) throw new Error('模型不能为空');
    const allowedModels = new Set([p.model, ...(Array.isArray(p.models) ? p.models : [])].filter(Boolean).map(String));
    if (!allowedModels.has(model)) throw new Error('模型不在该中转站已验证列表中');
    const targets = resolveAgentTargets(targetAgent);
    const backups = [];
    migrateProviderKeys(baseCfg);
    ensureProviderKey(p, providerIndex);
    const touchesDefaultConfig = targets.some((a) => a.config === HERMES_CONFIG);
    if (!touchesDefaultConfig) {
      const { backup } = await updateConfig((cfg) => {
        migrateProviderKeys(cfg);
        ensureProviderKey(cfg.custom_providers?.[providerIndex], providerIndex);
      }, HERMES_CONFIG);
      backups.push({ agent: 'base', backup });
      written.push({ config: HERMES_CONFIG, backup });
    }
    for (const agent of targets) {
      const { backup } = await updateConfig((cfg) => {
        migrateProviderKeys(cfg);
        const selected = upsertProvider(cfg, p, providerIndex);
        migrateProviderKeys(cfg);
        const targetIndex = cfg.custom_providers.findIndex((x, i) => sameProviderIdentity(x, selected, i, providerIndex));
        const norm = normalizeProvider(selected, targetIndex >= 0 ? targetIndex : providerIndex);
        cfg.model = cfg.model || {};
        cfg.model.default = model;
        cfg.model.provider = norm.slug;
        cfg.model.provider_slug = norm.slug;
        cfg.model.provider_name = norm.name;
        cfg.model.base_url = selected.base_url;
        cfg.model.api_key = selected.api_key;
        cfg.model.api_mode = selected.api_mode || 'chat_completions';
      }, agent.config);
      backups.push({ agent: agent.id, backup });
      written.push({ config: agent.config, backup });
    }
    const { cfg } = await loadConfigDoc(HERMES_CONFIG);
    ctx.body = { ok: true, backups: backups.map(publicBackupId), switched: targets.map((a) => a.id), state: await publicState(cfg) };
  } catch (e) {
    for (const item of written.reverse()) await restoreConfigBackup(item.config, item.backup).catch(() => {});
    ctx.status = 400;
    ctx.body = { ok: false, error: written.length ? '切换失败，已回滚全部配置' : String(e.message || '切换失败') };
  }
});


router.post('/image-gen/models', async (ctx) => {
  try {
    const targetAgent = String(ctx.request.body?.agent || 'default').trim();
    const agent = getAgent(targetAgent);
    const { cfg } = await loadConfigDoc(agent.config);
    const relay = imageRelayForCfg(cfg);
    if (!relay.api_key) throw new Error('当前中转没有 API Key，无法获取模型');
    const out = await fetchProviderModelsDirect(relay.base_url, relay.api_key, relay.api_mode);
    const live = (out.models || []).filter(isImageModelName);
    const current = getImageGen(cfg).model;
    const models = Array.from(new Set([current, ...live, ...relay.stored].filter(Boolean)));
    if (!out.ok && !models.length) {
      ctx.status = 400;
      ctx.body = { ok: false, error: out.error || '该中转没有返回生图模型', relay: { name: relay.name, base_url: relay.base_url } };
      return;
    }
    ctx.body = {
      ok: true,
      agent: agent.id,
      profile: agent.profile,
      models,
      fetched: live.length,
      fallback: !out.ok,
      error: out.ok ? '' : (out.error || ''),
      relay: { name: relay.name, base_url: relay.base_url },
    };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

async function testImageModelDirect(relay, model, includeImage = false, timeoutMs = 90000) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { res, raw } = await withOutboundResponse(endpoint(relay.base_url, '/images/generations'), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${relay.api_key}` },
      body: JSON.stringify({ model, prompt: 'A simple blue circle on a plain white background', n: 1, size: '1024x1024' }),
      signal: ac.signal,
    }, async (response) => ({ res: response, raw: await readResponseText(response, 4 * 1024 * 1024) }), { allowPrivate: relay.allow_private_network });
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    const image = data?.data?.[0];
    const hasImage = Boolean(image?.url || image?.b64_json);
    const error = data?.error?.message || data?.error || (!res.ok ? raw.slice(0, 1000) : !hasImage ? '接口未返回图片数据' : '');
    const imageUrl = includeImage ? (image?.url || (image?.b64_json ? `data:image/png;base64,${image.b64_json}` : '')) : '';
    return { ok: Boolean(res.ok && hasImage), http_status: res.status, latency_ms: Date.now() - started, image_url: imageUrl, revised_prompt: includeImage ? String(image?.revised_prompt || '').slice(0, 2000) : '', error: typeof error === 'string' ? error.slice(0, 1000) : JSON.stringify(error || '').slice(0, 1000) };
  } catch (e) {
    return { ok: false, http_status: 0, latency_ms: Date.now() - started, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

router.post('/image-gen/test', async (ctx) => {
  try {
    const targetAgent = String(ctx.request.body?.agent || 'default').trim();
    const model = String(ctx.request.body?.model || '').trim();
    if (!model) throw new Error('生图模型不能为空');
    const agent = getAgent(targetAgent);
    const { cfg } = await loadConfigDoc(agent.config);
    const relay = imageRelayForCfg(cfg);
    if (!relay.api_key) throw new Error('当前中转没有 API Key，无法测试');
    const result = await testImageModelDirect(relay, model, true);
    if (!result.ok) ctx.status = result.http_status >= 400 ? result.http_status : 502;
    ctx.body = { ...result, model, agent: agent.id, relay: { name: relay.name, base_url: relay.base_url } };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, http_status: 0, latency_ms: 0, error: e.message };
  }
});

router.post('/image-gen/switch', async (ctx) => {
  const written = [];
  try {
    const model = String(ctx.request.body?.model || '').trim();
    const targetAgent = String(ctx.request.body?.agent || 'default').trim();
    if (!model) throw new Error('生图模型不能为空');
    if (!isImageModelName(model)) throw new Error('生图模型名称未通过校验');
    const targets = resolveAgentTargets(targetAgent);
    const backups = [];
    for (const agent of targets) {
      const { backup } = await updateConfig((cfg) => { ensureImageGenDefaults(cfg, model); }, agent.config);
      backups.push({ agent: agent.id, backup });
      written.push({ config: agent.config, backup });
    }
    const { cfg } = await loadConfigDoc(HERMES_CONFIG);
    ctx.body = { ok: true, backups: backups.map(publicBackupId), switched: targets.map((a) => a.id), state: await publicState(cfg) };
  } catch (e) {
    for (const item of written.reverse()) await restoreConfigBackup(item.config, item.backup).catch(() => {});
    ctx.status = 400;
    ctx.body = { ok: false, error: written.length ? '生图模型切换失败，已回滚全部配置' : String(e.message || '切换失败') };
  }
});

const CHAT_PLATFORMS = [
  {
    id: 'telegram',
    label: 'Telegram',
    configuredIf: ['TELEGRAM_BOT_TOKEN'],
    fields: [
      { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', secret: true, required: true, placeholder: '从 @BotFather 获取' },
      { key: 'TELEGRAM_ALLOWED_USERS', label: '允许的用户 ID', secret: false, required: false, placeholder: '逗号分隔，如 123456' },
      { key: 'TELEGRAM_HOME_CHANNEL', label: 'Home 频道', secret: false, required: false, placeholder: '可选' },
    ],
  },
  {
    id: 'weixin',
    label: '微信',
    configuredIf: ['WEIXIN_ACCOUNT_ID', 'WEIXIN_TOKEN'],
    fields: [
      { key: 'WEIXIN_ACCOUNT_ID', label: '账号 ID', secret: false, required: true, placeholder: '微信账号 ID' },
      { key: 'WEIXIN_TOKEN', label: 'Token', secret: true, required: true, placeholder: '微信 Token' },
      { key: 'WEIXIN_BASE_URL', label: '接口地址', secret: false, required: false, placeholder: '可选' },
      { key: 'WEIXIN_CDN_BASE_URL', label: 'CDN 地址', secret: false, required: false, placeholder: '可选' },
      { key: 'WEIXIN_HOME_CHANNEL', label: 'Home 频道', secret: false, required: false, placeholder: '可选' },
    ],
  },
  {
    id: 'discord',
    label: 'Discord',
    configuredIf: ['DISCORD_BOT_TOKEN'],
    fields: [
      { key: 'DISCORD_BOT_TOKEN', label: 'Bot Token', secret: true, required: true, placeholder: 'Discord Developer Portal' },
      { key: 'DISCORD_ALLOWED_USERS', label: '允许的用户 ID', secret: false, required: false, placeholder: '逗号分隔' },
    ],
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    configuredIf: ['WHATSAPP_ENABLED'],
    fields: [
      { key: 'WHATSAPP_ENABLED', label: '启用', secret: false, required: true, placeholder: 'true' },
      { key: 'WHATSAPP_MODE', label: '模式', secret: false, required: false, placeholder: '可选' },
      { key: 'WHATSAPP_ALLOWED_USERS', label: '允许的用户', secret: false, required: false, placeholder: '可选' },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    configuredIf: ['SLACK_BOT_TOKEN'],
    fields: [
      { key: 'SLACK_BOT_TOKEN', label: 'Bot Token', secret: true, required: true, placeholder: 'xoxb-...' },
      { key: 'SLACK_APP_TOKEN', label: 'App Token', secret: true, required: false, placeholder: 'xapp-... 可选' },
      { key: 'SLACK_ALLOWED_USERS', label: '允许的成员 ID', secret: false, required: false, placeholder: '可选' },
    ],
  },
  {
    id: 'feishu',
    label: '飞书',
    configuredIf: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
    fields: [
      { key: 'FEISHU_APP_ID', label: 'App ID', secret: false, required: true, placeholder: '飞书应用 ID' },
      { key: 'FEISHU_APP_SECRET', label: 'App Secret', secret: true, required: true, placeholder: '飞书应用密钥' },
      { key: 'FEISHU_HOME_CHANNEL', label: 'Home 频道', secret: false, required: false, placeholder: '可选' },
    ],
  },
];
const CHAT_PLATFORM_IDS = new Set(CHAT_PLATFORMS.map((p) => p.id));
const CHAT_PLATFORM_KEYS = new Set(CHAT_PLATFORMS.flatMap((p) => p.fields.map((f) => f.key)));
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';

function agentEnvPath(agent) {
  if (!agent) throw new Error('agent 不存在');
  if (agent.profile === 'agent1' || agent.id === 'default') return path.join(HERMES_HOME, '.env');
  return path.join(PROFILES_DIR, agent.profile, '.env');
}

function agentHomeDir(agent) {
  if (!agent) throw new Error('agent 不存在');
  if (agent.profile === 'agent1' || agent.id === 'default') return HERMES_HOME;
  return path.join(PROFILES_DIR, agent.profile);
}

function agentStateDb(agent) {
  return path.join(agentHomeDir(agent), 'state.db');
}

const PLATFORM_LABELS = {
  telegram: 'Telegram',
  weixin: '微信',
  wechat: '微信',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  email: '邮件',
};

function platformLabel(id) {
  const key = String(id || '').toLowerCase();
  return PLATFORM_LABELS[key] || (key ? key : '未知平台');
}

function looksLikeId(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  if (/@im\.wechat$/i.test(s)) return true;
  if (/^[0-9-]{6,}$/.test(s)) return true;
  if (/^[a-z0-9_-]{20,}$/i.test(s)) return true;
  return false;
}

function parseSessionPlatform(source, sessionKey) {
  const src = String(source || '').trim().toLowerCase();
  if (src && !['cli', 'tui', 'subagent', 'cron', 'web'].includes(src)) return src;
  const key = String(sessionKey || '');
  const m = key.match(/^agent:[^:]+:([a-z0-9_]+):/i);
  return m ? m[1].toLowerCase() : src;
}

function formatWorkAge(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 60) return Math.max(1, Math.round(n)) + ' 秒';
  if (n < 3600) return Math.round(n / 60) + ' 分钟';
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  return m ? (h + ' 小时 ' + m + ' 分钟') : (h + ' 小时');
}

function workAgeSeconds(row) {
  const now = Date.now() / 1000;
  const start = Number(row.last_user_ts || row.started_at || 0);
  if (!start) return 0;
  return Math.max(0, now - start);
}

async function readBusyTargets(agent, activeCount) {
  const jobs = Number(activeCount) || 0;
  if (jobs <= 0) return [];
  const dbPath = agentStateDb(agent);
  if (!fssync.existsSync(dbPath)) return [];
  try {
    const limit = Math.min(Math.max(jobs, 1), 3);
    const script = path.join(process.cwd(), 'scripts', 'busy-targets.py');
    const { stdout: out } = await execFileAsync('python3', [script, dbPath, String(limit)], {
      timeout: 2500,
      encoding: 'utf8',
      maxBuffer: 200000,
    });
    const rows = out && String(out).trim() ? JSON.parse(out) : [];
    const seen = new Set();
    const list = [];
    for (const row of rows) {
      let origin = {};
      try { origin = row.origin_json ? JSON.parse(row.origin_json) : {}; } catch { origin = {}; }
      const platform = parseSessionPlatform(row.source || origin.platform, row.session_key);
      if (!platform || ['cli', 'tui', 'subagent', 'cron', 'web'].includes(platform)) continue;
      let name = String(row.display_name || origin.chat_name || origin.user_name || '').trim();
      if (looksLikeId(name)) name = '';
      const key = `${platform}|${name || row.session_key || origin.chat_id || row.title || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        platform,
        platform_label: platformLabel(platform),
        name,
        chat_type: String(row.chat_type || origin.chat_type || ''),
        started_at: Number(row.started_at) || 0,
        last_user_ts: Number(row.last_user_ts) || 0,
        elapsed_seconds: workAgeSeconds(row),
        elapsed_label: formatWorkAge(workAgeSeconds(row)),
      });
    }
    return list;
  } catch {
    return [];
  }
}

function readGatewayState(agent) {
  const file = path.join(agentHomeDir(agent), 'gateway_state.json');
  try {
    const raw = JSON.parse(fssync.readFileSync(file, 'utf8'));
    const platforms = {};
    const src = raw && raw.platforms && typeof raw.platforms === 'object' ? raw.platforms : {};
    for (const [name, info] of Object.entries(src)) {
      platforms[name] = {
        state: info && info.state ? String(info.state) : 'unknown',
        error_code: info && info.error_code ? String(info.error_code) : '',
        error_message: info && info.error_message ? String(info.error_message) : '',
        updated_at: info && info.updated_at ? String(info.updated_at) : '',
      };
    }
    return {
      gateway_state: raw && raw.gateway_state ? String(raw.gateway_state) : '',
      active_agents: Number(raw && raw.active_agents) || 0,
      pid: raw && raw.pid ? Number(raw.pid) : 0,
      updated_at: raw && raw.updated_at ? String(raw.updated_at) : '',
      platforms,
    };
  } catch {
    return { gateway_state: '', active_agents: 0, pid: 0, updated_at: '', platforms: {} };
  }
}

async function runPyScript(name, args, timeout = 4000) {
  const script = path.join(process.cwd(), 'scripts', name);
  const { stdout: out } = await execFileAsync('python3', [script, ...args], {
    timeout,
    encoding: 'utf8',
    maxBuffer: 400000,
  });
  return out && String(out).trim() ? JSON.parse(out) : {};
}

function formatWhen(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function normalizeSessionRows(agent, rows) {
  const list = [];
  for (const row of rows || []) {
    let origin = {};
    try { origin = row.origin_json ? JSON.parse(row.origin_json) : {}; } catch { origin = {}; }
    const platform = parseSessionPlatform(row.source || origin.platform, row.session_key);
    if (!platform || ['cli', 'tui', 'subagent', 'cron', 'web'].includes(platform)) continue;
    let name = String(row.display_name || origin.chat_name || origin.user_name || '').trim();
    if (looksLikeId(name)) name = '';
    list.push({ id: row.id, session_key: row.session_key || '', platform, platform_label: platformLabel(platform), name,
      title: String(row.title || '').trim(), model: String(row.model || '').trim(), message_count: Number(row.message_count) || 0,
      open: !!row.open, when: formatWhen(row.last_ts || row.started_at), current: false });
  }
  let routing = {};
  try {
    const raw = JSON.parse(fssync.readFileSync(path.join(agentHomeDir(agent), 'sessions', 'sessions.json'), 'utf8'));
    routing = raw && typeof raw === 'object' ? raw : {};
  } catch { routing = {}; }
  const currentIds = new Set();
  for (const v of Object.values(routing)) if (v && v.session_id) currentIds.add(String(v.session_id));
  for (const item of list) item.current = currentIds.has(String(item.id));
  return list;
}

async function readAgentSessionPage(agent, page = 1, pageSize = 20, query = '') {
  const dbPath = agentStateDb(agent);
  if (!fssync.existsSync(dbPath)) return { items: [], total: 0 };
  try {
    const result = await runPyScript('list-sessions-page.py', [dbPath, String(pageSize), String((page - 1) * pageSize), String(query || '')]) || {};
    return { items: normalizeSessionRows(agent, result.items || []), total: Number(result.total) || 0 };
  } catch { return { items: [], total: 0 }; }
}

function agentModelChoicesSync(agent) {
  try {
    const raw = fssync.readFileSync(agent.config, 'utf8');
    const models = [];
    const seen = new Set();
    const add = (m) => {
      const s = String(m || '').trim();
      if (!s || seen.has(s)) return;
      seen.add(s);
      models.push(s);
    };
    const def = raw.match(/^\s*default:\s*["']?([^"'\n#]+)/m);
    if (def) add(def[1]);
    const block = raw.split(/custom_providers:/)[1] || '';
    for (const m of block.matchAll(/^\s+-\s+["']?([^"'\n#]+)/gm)) add(m[1]);
    return models.slice(0, 40);
  } catch {
    return [];
  }
}

function systemctlContext(scope) {
  const user = scope === 'user';
  return {
    prefix: user ? ['--user'] : [],
    env: user ? { ...process.env, XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' } : process.env,
  };
}

async function probeService(service) {
  const result = {};
  for (const scope of ['system', 'user']) {
    const { prefix, env } = systemctlContext(scope);
    try {
      const { stdout = '' } = await execFileAsync('systemctl', [...prefix, 'show', service, '--property=LoadState,ActiveState,UnitFileState', '--value'], { timeout: 7000, env });
      const [load = 'not-found', active = 'inactive', enabled = ''] = stdout.trim().split(/\r?\n/);
      result[scope] = { scope, loaded: load === 'loaded', load, active, enabled };
    } catch (_) {
      result[scope] = { scope, loaded: false, load: 'not-found', active: 'inactive', enabled: '' };
    }
  }
  return result;
}

async function resolveServiceScope(service, requestedScope = 'auto') {
  if (requestedScope === 'system' || requestedScope === 'user') return { scope: requestedScope, probes: await probeService(service) };
  const probes = await probeService(service);
  const loaded = ['system', 'user'].filter((s) => probes[s].loaded);
  const active = loaded.filter((s) => probes[s].active === 'active');
  if (active.length > 1) throw new Error('检测到系统级和用户级 Gateway 同时运行，请先处理服务冲突');
  if (active.length === 1) return { scope: active[0], probes };
  if (loaded.length > 1) throw new Error('检测到系统级和用户级同名 Unit，请明确选择服务层级');
  if (loaded.length === 1) return { scope: loaded[0], probes };
  throw new Error('Gateway Unit 尚未安装');
}

async function systemctlAction(service, action, requestedScope = 'auto') {
  const resolved = await resolveServiceScope(service, requestedScope);
  const { prefix, env } = systemctlContext(resolved.scope);
  const { stdout, stderr } = await execFileAsync('systemctl', [...prefix, action, service], { timeout: 25000, env });
  return { stdout, stderr, scope: resolved.scope, probes: resolved.probes };
}

function parseDotEnv(text = '') {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function envHas(map, key) {
  return Boolean(String(map[key] || '').trim());
}

function maskSecret(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return '••••••••';
}

async function readAgentPlatforms(agent, gatewaySnapshot = null) {
  const envPath = agentEnvPath(agent);
  let map = {};
  await serializeFile(envPath, async () => { try { map = parseDotEnv(await fs.readFile(envPath, 'utf8')); } catch { map = {}; } });
  const live = gatewaySnapshot || readGatewayState(agent);
  return CHAT_PLATFORMS.map((p) => {
    const configured = p.configuredIf.every((k) => envHas(map, k));
    const liveInfo = live.platforms?.[p.id] || live.platforms?.[p.label.toLowerCase()] || {};
    const fields = p.fields.map((f) => ({
      key: f.key,
      label: f.label,
      secret: !!f.secret,
      required: !!f.required,
      placeholder: f.placeholder || '',
      set: envHas(map, f.key),
      preview: f.secret ? (envHas(map, f.key) ? maskSecret(map[f.key]) : '') : String(map[f.key] || ''),
    }));
    return {
      id: p.id, label: p.label, configured, fields,
      state: liveInfo.state || '',
      error_message: liveInfo.error_message || '',
      updated_at: liveInfo.updated_at || '',
    };
  });
}

async function upsertEnvValues(envPath, updates, validate = null) {
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('环境变量名不合法');
    if (value !== null && /[\r\n\0]/.test(String(value))) throw new Error('值不能包含换行或 NUL');
  }
  return serializeFile(envPath, async () => {
  let text = '';
  try { text = await fs.readFile(envPath, 'utf8'); } catch { text = ''; }
  if (validate) await validate(parseDotEnv(text), updates);
  const lines = text ? text.split(/\r?\n/) : [];
  const seen = new Set();
  const next = [];
  for (const line of lines) {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!m) { next.push(line); continue; }
    const key = m[2];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) { next.push(line); continue; }
    seen.add(key);
    if (updates[key] === null) continue;
    next.push(`${m[1]}${key}=${updates[key]}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key) || value === null) continue;
    next.push(`${key}=${value}`);
  }
  const out = next.join('\n').replace(/\n*$/, '\n');
  await atomicWriteFile(envPath, out, 0o600);
  });
}

async function removeEnvKeys(envPath, keys) {
  const updates = {};
  for (const key of keys) updates[key] = null;
  await upsertEnvValues(envPath, updates);
}

router.get('/chat-platforms', async (ctx) => {
  try {
    const agents = await Promise.all(AGENTS().map(async (agent) => ({ id: agent.id, profile: agent.profile, name: agent.name, platforms: await readAgentPlatforms(agent) })));
    ctx.body = { ok: true, catalog: CHAT_PLATFORMS.map((p) => ({ id: p.id, label: p.label, fields: p.fields })), agents };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/chat-platforms', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const agent = getAgent(String(body.agent || '').trim());
    const platformId = String(body.platform || '').trim();
    if (!CHAT_PLATFORM_IDS.has(platformId)) throw new Error('不支持的平台');
    const spec = CHAT_PLATFORMS.find((p) => p.id === platformId);
    const incoming = body.values && typeof body.values === 'object' ? body.values : {};
    const updates = {};
    for (const field of spec.fields) {
      if (!Object.prototype.hasOwnProperty.call(incoming, field.key)) continue;
      const value = String(incoming[field.key] ?? '').trim();
      if (!value) continue;
      if (!CHAT_PLATFORM_KEYS.has(field.key)) continue;
      updates[field.key] = value;
    }
    if (!Object.keys(updates).length) throw new Error('没有可保存的字段');
    await upsertEnvValues(agentEnvPath(agent), updates, (current) => {
      const merged = { ...current, ...updates };
      for (const key of spec.configuredIf) if (!String(merged[key] || '').trim()) throw new Error(`${spec.label} 还缺必填项`);
    });
    ctx.body = { ok: true, agent: agent.id, profile: agent.profile, platform: platformId, platforms: await readAgentPlatforms(agent) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.delete('/chat-platforms/:agent/:platform', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.params.agent || '').trim());
    const platformId = String(ctx.params.platform || '').trim();
    if (!CHAT_PLATFORM_IDS.has(platformId)) throw new Error('不支持的平台');
    const spec = CHAT_PLATFORMS.find((p) => p.id === platformId);
    const keys = spec.fields.map((f) => f.key).filter((k) => CHAT_PLATFORM_KEYS.has(k));
    if (!keys.length) throw new Error('没有可关掉的字段');
    await removeEnvKeys(agentEnvPath(agent), keys);
    ctx.body = { ok: true, agent: agent.id, profile: agent.profile, platform: platformId, platforms: await readAgentPlatforms(agent) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/rebuild-commands', async (ctx) => {
  const { cfg, backup } = await updateConfig((cfg) => { rebuildQuickCommands(cfg); });
  ctx.body = { ok: true, backup: publicBackupId(backup), state: await publicState(cfg) };
});

router.post('/agents', async (ctx) => {
  try {
    const name = ctx.request.body?.name || ctx.request.body?.profile;
    const cloneFrom = ctx.request.body?.cloneFrom || ctx.request.body?.from;
    const scope = String(ctx.request.body?.scope || 'system');
    if (!['system', 'user'].includes(scope)) throw new Error('新建 Agent 请选择系统级或用户级');
    const agent = cloneFrom ? await cloneAgentProfile(cloneFrom, name, scope) : await createAgentProfile(name, scope);
    ctx.body = { ok: true, agent, agents: AGENTS() };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message || '操作失败' };
  }
});

router.delete('/agents/:id', async (ctx) => {
  try {
    const agents = await deleteAgentProfile(ctx.params.id);
    ctx.body = { ok: true, agents };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message || '操作失败' };
  }
});

router.get('/service-scopes', async (ctx) => {
  ctx.body = { ok: true, service_scopes: publicServiceScopes() };
});

router.post('/service-scope', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const scope = String(ctx.request.body?.scope || 'auto');
    if (!['auto', 'system', 'user'].includes(scope)) throw new Error('服务层级不正确');
    let result;
    if (scope === 'auto') {
      const resolved = await resolveServiceScope(agent.service, 'auto');
      await saveServiceScope(agent, 'auto');
      result = { source_scope: resolved.scope, effective_scope: resolved.scope, status: resolved.probes[resolved.scope].active };
    } else if (isDefaultAgent(agent)) {
      const probes = await probeService(agent.service);
      if (!probes[scope].loaded) throw new Error('默认 Gateway 当前不在所选层级；为避免中断正式服务，面板不自动迁移默认 Gateway');
      await saveServiceScope(agent, scope);
      result = { source_scope: scope, effective_scope: scope, status: probes[scope].active };
    } else {
      result = await migrateAgentUnit(agent, scope);
    }
    ctx.body = { ok: true, agent: agent.id, scope, detected: result.effective_scope, ...result, service_scopes: publicServiceScopes() };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/pairing-approve', async (ctx) => {
  try {
    const platform = String(ctx.request.body?.platform || '').trim().toLowerCase();
    const code = String(ctx.request.body?.code || '').trim().toUpperCase();
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const requestedScope = String(ctx.request.body?.scope || configuredServiceScope(agent));
    if (!['auto', 'system', 'user'].includes(requestedScope)) throw new Error('服务层级不正确');
    const resolved = await resolveServiceScope(agent.service, requestedScope);
    const scope = resolved.scope;
    const allowedPlatforms = new Set(['telegram', 'feishu', 'discord', 'slack', 'whatsapp', 'signal', 'weixin', 'wechat']);
    if (!allowedPlatforms.has(platform)) throw new Error('请选择正确的聊天平台');
    if (!/^[A-Z0-9]{6,16}$/.test(code)) throw new Error('配对码格式不正确');
    const hermesArgs = [];
    if (!isDefaultAgent(agent)) hermesArgs.push('--profile', agent.profile);
    hermesArgs.push('pairing', 'approve', platform, code);
    const { stdout = '', stderr = '' } = await execFileAsync('hermes', hermesArgs, {
      timeout: 15000, env: process.env, maxBuffer: 100000,
    });
    const output = `${stdout}\n${stderr}`.trim();
    if (/not found|expired|no pending|invalid/i.test(output)) throw new Error(output);
    ctx.body = { ok: true, platform, agent: agent.id, scope, message: output || '配对已批准' };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: publicError(e, '批准失败') };
  }
});

router.post('/gateway-install', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const scope = String(ctx.request.body?.scope || configuredServiceScope(agent));
    if (!['system', 'user'].includes(scope)) throw new Error('安装 Gateway 前请明确选择系统级或用户级');
    let newlyInstalled = false;
    try {
      await systemctlAction(agent.service, 'cat', scope);
    } catch (_) {
      if (isDefaultAgent(agent)) {
        const hermesBin = process.env.HERMES_BIN || 'hermes';
        if (scope === 'user') {
          await execFileAsync(hermesBin, ['gateway', 'install'], { timeout: 90000, env: process.env });
        } else {
          await execFileAsync('bash', ['-lc', `printf 'n\\n' | ${hermesBin} gateway install`], { timeout: 90000, env: process.env });
        }
      } else {
        await installAgentUnit(agent.profile, scope);
      }
      await saveServiceScope(agent, scope);
      newlyInstalled = true;
    }
    await systemctlAction(agent.service, 'start', scope);
    const { stdout } = await systemctlAction(agent.service, 'is-active', scope);
    ctx.body = { ok: stdout.trim() === 'active', installed: newlyInstalled, status: stdout.trim(), service: agent.service, scope };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message || '操作失败' };
  }
});

router.post('/restart-gateway', async (ctx) => {
  try {
    const targetAgent = String(ctx.request.body?.agent || 'default').trim();
    const targets = resolveAgentTargets(targetAgent);
    const results = [];
    for (const agent of targets) {
      const { scope } = await systemctlAction(agent.service, 'restart', configuredServiceScope(agent));
      results.push({ agent: agent.id, service: agent.service, effective_scope: scope, status: 'completed' });
    }
    ctx.body = { ok: true, results };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { ok: false, error: e.message || '操作失败' };
  }
});

router.get('/sessions', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.query.agent || 'default').trim());
    const pageSize = Math.max(10, Math.min(Number(ctx.query.page_size) || 20, 50));
    const query = String(ctx.query.search || '').trim().slice(0, 100);
    const requestedPage = Math.max(1, Number(ctx.query.page) || 1);
    let result = await readAgentSessionPage(agent, requestedPage, pageSize, query);
    const pages = Math.max(1, Math.ceil(result.total / pageSize));
    const page = Math.min(requestedPage, pages);
    if (page !== requestedPage) result = await readAgentSessionPage(agent, page, pageSize, query);
    ctx.body = { ok: true, agent: agent.id, profile: agent.profile, sessions: result.items, total: result.total, page, page_size: pageSize, pages, model_choices: agentModelChoicesSync(agent) };
  } catch (e) {
    ctx.status = 400; ctx.body = { ok: false, error: e.message };
  }
});

router.get('/gateway-logs', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.query.agent || 'default').trim());
    const scope = configuredServiceScope(agent);
    const lines = Math.max(20, Math.min(Number(ctx.query.lines) || 120, 500));
    let effective = scope;
    if (scope === 'auto') {
      try { effective = (await systemctlAction(agent.service, 'is-active', 'auto')).scope; } catch { effective = 'system'; }
    }
    const user = effective === 'user';
    const env = user ? { ...process.env, XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' } : process.env;
    const args = [...(user ? ['--user'] : []), '-u', agent.service, '-n', String(lines), '--no-pager', '--output=json'];
    const { stdout = '' } = await execFileAsync('journalctl', args, { timeout: 15000, env, maxBuffer: 500000 });
    const entries = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const item = JSON.parse(line);
        const priority = Number(item.PRIORITY);
        const micros = Number(item.__REALTIME_TIMESTAMP);
        const time = Number.isFinite(micros) ? new Date(Math.floor(micros / 1000)).toISOString() : '';
        const module = String(item.SYSLOG_IDENTIFIER || item._COMM || 'Gateway');
        const message = Array.isArray(item.MESSAGE) ? item.MESSAGE.join(' ') : String(item.MESSAGE || '');
        const raw = `${time} ${module}: ${message}`.trim();
        return [{ time, module, message, raw, priority: Number.isInteger(priority) ? priority : null }];
      } catch {
        return [];
      }
    });
    ctx.body = { ok: true, agent: agent.id, scope: effective, logs: entries.map((item) => item.raw).join('\n'), entries };
  } catch (e) {
    ctx.status = 400; ctx.body = { ok: false, error: publicError(e, '读取日志失败') };
  }
});

router.get('/service-status', async (ctx) => {
  const includeSessions = String(ctx.query.include_sessions || '') === '1';
  const statuses = await Promise.all(AGENTS().map(async (agent) => {
    try {
      const ctl = await systemctlAction(agent.service, 'is-active', configuredServiceScope(agent));
      const { stdout } = ctl;
      const gw = readGatewayState(agent);
      return { agent: agent.id, profile: agent.profile, name: agent.name, service: agent.service, service_scope: configuredServiceScope(agent), effective_scope: ctl.scope, status: stdout.trim(), ok: stdout.trim() === 'active', ...gw, busy_targets: await readBusyTargets(agent, gw.active_agents), ...(includeSessions ? { sessions: (await readAgentSessionPage(agent, 1, 20)).items, model_choices: agentModelChoicesSync(agent) } : {}) };
    } catch (e) {
      const st = String((e.stdout || '')).trim() || 'inactive';
      const gw = readGatewayState(agent);
      let effectiveScope = null;
      try { effectiveScope = (await resolveServiceScope(agent.service, configuredServiceScope(agent))).scope; } catch (_) {}
      return { agent: agent.id, profile: agent.profile, name: agent.name, service: agent.service, service_scope: configuredServiceScope(agent), effective_scope: effectiveScope, status: st, ok: false, error: String(e.message || ''), ...gw, busy_targets: [], ...(includeSessions ? { sessions: (await readAgentSessionPage(agent, 1, 20)).items, model_choices: agentModelChoicesSync(agent) } : {}) };
    }
  }));
  ctx.body = { ok: true, all_running: statuses.every((s) => s.ok), statuses, status: statuses.map((s) => `${s.profile || s.agent}:${s.status}`).join(' ') };
});

async function catalogToolsets() {
  try {
    return await runPyScript('list-toolsets.py', [], 8000) || [];
  } catch (e) {
    return [];
  }
}

router.get('/toolsets', async (ctx) => {
  try {
    const catalog = await catalogToolsets();
    const ids = new Set(catalog.map((x) => x.id));
    const agents = [];
    for (const agent of AGENTS()) {
      const { cfg } = await loadConfigDoc(agent.config);
      const enabled = Array.isArray(cfg?.toolsets) ? cfg.toolsets.filter((x) => typeof x === 'string') : [];
      const disabled = Array.isArray(cfg?.agent?.disabled_toolsets) ? cfg.agent.disabled_toolsets.filter((x) => typeof x === 'string') : [];
      agents.push({
        agent: agent.id,
        name: agent.name,
        profile: agent.profile,
        enabled,
        disabled,
        unknown: enabled.filter((x) => !ids.has(x) && !String(x).startsWith('hermes-')),
      });
    }
    ctx.body = { ok: true, catalog, agents };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/toolsets', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const catalog = await catalogToolsets();
    const allowed = new Set(catalog.map((x) => x.id));
    const incoming = Array.isArray(ctx.request.body?.enabled) ? ctx.request.body.enabled : null;
    if (!incoming) throw new Error('没有勾选列表');
    const enabled = [];
    for (const raw of incoming) {
      const id = String(raw || '').trim();
      if (!id || !allowed.has(id)) continue;
      if (!enabled.includes(id)) enabled.push(id);
    }
    const { backup } = await updateConfig((cfg) => {
      cfg.toolsets = enabled;
      cfg.agent = cfg.agent && typeof cfg.agent === 'object' ? cfg.agent : {};
      cfg.agent.disabled_toolsets = Array.isArray(cfg.agent.disabled_toolsets) ? cfg.agent.disabled_toolsets.filter((x) => typeof x === 'string' && !enabled.includes(x)) : [];
    }, agent.config);
    ctx.body = { ok: true, enabled, backup: publicBackupId(backup), hint: '已写入该 agent 的 config.yaml。Gateway 在跑请到设置里重启后才生效。' };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

async function catalogSkills(home) {
  try {
    return await runPyScript('list-skills.py', [home], 8000) || [];
  } catch (e) {
    return [];
  }
}

router.get('/skills', async (ctx) => {
  try {
    const agents = [];
    for (const agent of AGENTS()) {
      const { cfg } = await loadConfigDoc(agent.config);
      const catalog = await catalogSkills(agentHomeDir(agent));
      const disabled = Array.isArray(cfg?.skills?.disabled) ? cfg.skills.disabled.filter((x) => typeof x === 'string') : [];
      agents.push({
        agent: agent.id,
        name: agent.name,
        profile: agent.profile,
        catalog,
        disabled,
      });
    }
    ctx.body = { ok: true, agents };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/skills', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const catalog = await catalogSkills(agentHomeDir(agent));
    const allowed = new Set(catalog.map((x) => x.id));
    const incoming = Array.isArray(ctx.request.body?.disabled) ? ctx.request.body.disabled : null;
    if (!incoming) throw new Error('没有开关列表');
    const disabled = [];
    for (const raw of incoming) {
      const id = String(raw || '').trim();
      if (!id || !allowed.has(id)) continue;
      if (!disabled.includes(id)) disabled.push(id);
    }
    const { backup } = await updateConfig((cfg) => {
      cfg.skills = cfg.skills && typeof cfg.skills === 'object' ? cfg.skills : {};
      cfg.skills.disabled = disabled;
    }, agent.config);
    ctx.body = { ok: true, disabled, backup: publicBackupId(backup), hint: '已写入该 agent 的 skills.disabled。Gateway 在跑请到设置里重启后才生效。' };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/skills/delete', async (ctx) => {
  let archived = '';
  let original = '';
  try {
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const name = String(ctx.request.body?.name || '').trim();
    if (!name) throw new Error('没有 skill 名字');
    const result = await runPyScript('delete-skill.py', [agentHomeDir(agent), name], 8000);
    if (!result || result.ok === false) throw new Error(result?.error || '删除失败');
    archived = String(result.archived || ''); original = String(result.original || '');
    try {
      await updateConfig((cfg) => { if (Array.isArray(cfg?.skills?.disabled)) cfg.skills.disabled = cfg.skills.disabled.filter((x) => x !== name); }, agent.config);
    } catch (error) {
      if (archived && original) await fs.rename(archived, original).catch(() => {});
      throw new Error('配置更新失败，Skill 归档已补偿恢复');
    }
    ctx.body = { ok: true, name, archived: true, hint: '已移到这个 agent 的 skills/.archive。Gateway 在跑请到设置里重启后才生效。' };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/sessions/resume', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const sessionId = String(ctx.request.body?.session_id || '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(sessionId)) throw new Error('会话编号不对');
    const dbPath = agentStateDb(agent);
    if (!fssync.existsSync(dbPath)) throw new Error('没有会话库');
    const out = await runPyScript('resume-session.py', [dbPath, sessionId], 5000);
    if (!out.ok) throw new Error(out.error || '切回失败');
    ctx.body = { ok: true, ...out, hint: 'Gateway 在跑的话，重启后下一条消息才会切到这条上下文' };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/sessions/delete', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const sessionId = String(ctx.request.body?.session_id || '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(sessionId)) throw new Error('会话编号不对');
    const dbPath = agentStateDb(agent);
    if (!fssync.existsSync(dbPath)) throw new Error('没有会话库');
    const out = await runPyScript('delete-session.py', [dbPath, sessionId], 5000);
    if (!out.ok) throw new Error(out.error || '删除失败');
    ctx.body = { ok: true, ...out, hint: '这条上下文已删。Gateway 在跑请到工作状态里重启后再发下一条。' };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/sessions/model', async (ctx) => {
  try {
    const agent = getAgent(String(ctx.request.body?.agent || 'default').trim());
    const sessionKey = String(ctx.request.body?.session_key || '').trim();
    const model = String(ctx.request.body?.model || '').trim();
    if (!sessionKey.startsWith('agent:')) throw new Error('这条没有绑定聊天对象');
    if (!model || model.length > 120) throw new Error('模型名不对');
    const dbPath = agentStateDb(agent);
    if (!fssync.existsSync(dbPath)) throw new Error('没有会话库');
    const { cfg } = await loadConfigDoc(agent.config);
    const current = getCurrent(cfg);
    const slug = String(current.provider_slug || current.provider || '').trim();
    const base = String(current.base_url || '').trim();
    const out = await runPyScript('set-session-model.py', [dbPath, sessionKey, model, slug, base], 5000);
    if (!out.ok) throw new Error(out.error || '切模型失败');
    ctx.body = { ok: true, ...out, hint: '只对这条聊天生效。Gateway 在跑请重启后再发下一条。' };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/gateway-control', async (ctx) => {
  try {
    const action = String(ctx.request.body?.action || '').trim();
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('只支持 start / stop / restart');
    const targets = resolveAgentTargets(String(ctx.request.body?.agent || 'default').trim());
    const results = [];
    for (const agent of targets) {
      const { stdout, stderr, scope } = await systemctlAction(agent.service, action, configuredServiceScope(agent));
      results.push({ agent: agent.id, profile: agent.profile, service: agent.service, action, effective_scope: scope, status: 'completed' });
    }
    ctx.body = { ok: true, results };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message || '操作失败' };
  }
});

router.get('/panel-update', async (ctx) => {
  try {
    const [installed_sha, latest_sha, latest_version, status, rollbacks] = await Promise.all([
      readInstalledPanelSha(), fetchGithubPanelSha(), fetchGithubPanelVersion(), readPanelUpdateStatus(), listPanelRollbacks(),
    ]);
    ctx.body = {
      ok: true,
      repo: PANEL_UPDATE_REPO,
      branch: PANEL_UPDATE_BRANCH,
      version: packageInfo.version,
      latest_version,
      installed_sha,
      latest_sha,
      update_available: !installed_sha || installed_sha !== latest_sha,
      status,
      rollbacks,
    };
  } catch (e) {
    // Keep the updater's error response at HTTP 200 so Cloudflare does not
    // replace the structured JSON body with its branded HTML 502 page.
    ctx.status = 200;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { ok: false, error: publicError(e, '版本检查失败') };
  }
});

router.post('/panel-update', async (ctx) => {
  try {
    const expected = String(ctx.request.body?.expected_sha || '').trim();
    if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('请先检查最新版本');
    const latest = await fetchGithubPanelSha();
    if (latest !== expected) throw new Error('GitHub 版本已变化，请重新检查');
    await fs.access(PANEL_UPDATE_SCRIPT, fssync.constants.X_OK);
    const unit = `hermes-model-panel-update-${Date.now()}`;
    await execFileAsync('systemd-run', [
      '--unit', unit, '--collect', '--property=Type=exec',
      '--setenv', `PANEL_UPDATE_REPO=${PANEL_UPDATE_REPO}`,
      PANEL_UPDATE_SCRIPT, expected,
    ], { timeout: 10000 });
    ctx.status = 202;
    ctx.body = { ok: true, state: 'started', expected_sha: expected };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: publicError(e, '启动在线更新失败') };
  }
});

router.post('/panel-rollback', async (ctx) => {
  try {
    const id = String(ctx.request.body?.id || '').trim();
    const rollbacks = await listPanelRollbacks();
    const target = rollbacks.find((item) => item.id === id);
    if (!target) throw new Error('请选择仍然存在的回滚版本');
    const installDir = path.resolve(process.env.PANEL_INSTALL_DIR || '/opt/hermes-model-panel');
    const script = path.resolve(process.env.PANEL_ROLLBACK_SCRIPT || path.join(process.cwd(), 'scripts/rollback-panel.sh'));
    await fs.access(script, fssync.constants.X_OK);
    const directory = `${installDir}.rollback-${id}`;
    const unit = `hermes-model-panel-rollback-${Date.now()}`;
    await execFileAsync('systemd-run', [
      '--unit', unit, '--collect', '--property=Type=exec',
      '--setenv', `PANEL_INSTALL_DIR=${installDir}`,
      script, directory,
    ], { timeout: 10000 });
    ctx.status = 202;
    ctx.body = { ok: true, state: 'started', target };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: publicError(e, '启动版本回滚失败') };
  }
});

// Caddy forward_auth endpoint. It must be outside /api so every subdomain can
// ask the shared auth service whether the .23cm.me cookie is valid.
app.use(async (ctx, next) => {
  if (ctx.path !== '/auth/check') return next();
  if (hasValidSession(ctx)) {
    ctx.status = 204;
    return;
  }
  const allowedHosts = new Set(String(process.env.AUTH_REDIRECT_HOSTS || 'hermes.23cm.me,panel.23cm.me').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const candidateHost = String(ctx.get('x-forwarded-host') || '').split(',', 1)[0].trim().toLowerCase();
  const forwardedHost = allowedHosts.has(candidateHost) ? candidateHost : 'hermes.23cm.me';
  let forwardedUri = String(ctx.get('x-forwarded-uri') || '/');
  if (!forwardedUri.startsWith('/') || forwardedUri.startsWith('//') || /[\r\n]/.test(forwardedUri)) forwardedUri = '/';
  if (forwardedHost === 'hermes.23cm.me' && forwardedUri === '/index.html') forwardedUri = '/';
  const nextUrl = `https://${forwardedHost}${forwardedUri}`;
  ctx.status = 302;
  ctx.redirect(`https://hermes.23cm.me/login?next=${encodeURIComponent(nextUrl)}`);
});

app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/api/')) return requireAuth(ctx, next);
  return next();
});
const normalJsonParser = bodyParser({ jsonLimit: '1mb' });
const mimoJsonParser = bodyParser({ jsonLimit: '25mb' });
app.use(async (ctx, next) => (ctx.path === '/api/mimo/asr' || ctx.path === '/api/mimo/tts')
  ? mimoJsonParser(ctx, next) : normalJsonParser(ctx, next));
app.use(router.routes());
app.use(router.allowedMethods());
app.use(async (ctx, next) => {
  await next();
  if (ctx.path === '/' || ctx.path.endsWith('.html')) ctx.set('Cache-Control', 'no-store');
  else if (/\.(?:js|css)$/.test(ctx.path)) ctx.set('Cache-Control', 'public, max-age=300, must-revalidate');
});
app.use(serve(PUBLIC_DIR));
app.use(async (ctx) => {
  if (ctx.method === 'GET') ctx.type = 'html', ctx.body = fssync.createReadStream(path.join(PUBLIC_DIR, 'index.html'));
});

const HOST = process.env.HOST || '127.0.0.1';
if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) {
  if (AUTH_DISABLED && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    console.error('AUTH_DISABLED=1 时只允许监听 loopback');
    process.exit(1);
  }
  const server = app.listen(PORT, HOST, () => {
    console.log(`Hermes model panel listening on ${HOST}:${PORT}`);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
}

export { app, clientIp, loginRateRecord, loginAttempts, updateConfig, updatePanelMeta, upsertEnvValues };
