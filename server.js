import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import serve from 'koa-static';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import crypto from 'crypto';
import YAML from 'yaml';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 3010);
const HERMES_CONFIG = process.env.HERMES_CONFIG || path.join(process.env.HOME || process.env.USERPROFILE || '', '.hermes', 'config.yaml');
const HERMES_HOME = process.env.HERMES_HOME || path.dirname(HERMES_CONFIG);
const PROFILES_DIR = process.env.HERMES_PROFILES_DIR || path.join(HERMES_HOME, 'profiles');

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
const PANEL_META_PATH = process.env.PANEL_META_PATH || path.join(process.env.HERMES_HOME || path.dirname(HERMES_CONFIG), 'model-panel-meta.json');
const DEFAULT_OPENAI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function readPanelMeta() {
  try {
    return JSON.parse(fssync.readFileSync(PANEL_META_PATH, 'utf8'));
  } catch {
    return { providers: {} };
  }
}

function writePanelMeta(meta) {
  const dir = path.dirname(PANEL_META_PATH);
  if (!fssync.existsSync(dir)) fssync.mkdirSync(dir, { recursive: true });
  fssync.writeFileSync(PANEL_META_PATH, JSON.stringify(meta || { providers: {} }, null, 2));
}

function rememberProviderMeta(provider, index = 0) {
  const key = stableProviderKey(provider || {}, index);
  if (!key) return;
  const label = String(provider.display_name || provider.label || provider.title || provider.name || '').trim();
  if (!label || label === key) return;
  const meta = readPanelMeta();
  meta.providers = meta.providers || {};
  meta.providers[key] = { ...(meta.providers[key] || {}), display_name: label };
  writePanelMeta(meta);
}

function applyProviderMeta(provider, index = 0) {
  if (!provider) return provider;
  const key = stableProviderKey(provider, index);
  const meta = readPanelMeta();
  const display = meta.providers?.[key]?.display_name;
  return { ...provider, provider_key: key, ...(display ? { display_name: display } : {}) };
}

function stripPanelFields(provider) {
  if (!provider || typeof provider !== 'object') return provider;
  const { provider_key, display_name, label, title, ...rest } = provider;
  return rest;
}
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ENV_FILE = process.env.ENV_FILE || path.join(process.cwd(), 'hermes-model-panel.env');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const COOKIE_NAME = 'hmp_session';
const COOKIE_PATH = process.env.COOKIE_PATH || '/';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';
const TRUST_PROXY_AUTH = process.env.TRUST_PROXY_AUTH === '1';
// 默认关闭本面板认证。公网直出请设 AUTH_DISABLED=0。
// 如需恢复密码保护，可在环境变量里设置 AUTH_DISABLED=0 并重启服务。
let AUTH_DISABLED = process.env.AUTH_DISABLED !== '0';

if (!AUTH_DISABLED && !ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is required when AUTH_DISABLED=0');
  process.exit(1);
}

const app = new Koa();
const router = new Router({ prefix: '/api' });
app.proxy = true;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function updateEnvKey(file, key, value) {
  if (/[\r\n]/.test(String(value))) throw new Error('值不能包含换行');
  let lines = [];
  try {
    lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
  } catch {
    lines = [];
  }
  let found = false;
  lines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) lines.push(`${key}=${value}`);
  await fs.writeFile(`${file}.tmp`, `${lines.join('\n')}\n`, { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
  await fs.chmod(file, 0o600);
}

function authPublicStatus() {
  return { ok: true, password_enabled: !AUTH_DISABLED, password_set: Boolean(ADMIN_PASSWORD) };
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.', 2);
  if (!safeEqual(sig, sign(payload))) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Date.now() - Number(obj.iat || 0) < 7 * 86400 * 1000;
  } catch {
    return false;
  }
}

function cookieOptions(ctx, extra = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.secure || ctx.get('x-forwarded-proto') === 'https',
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

function requireAuth(ctx, next) {
  if (AUTH_DISABLED || TRUST_PROXY_AUTH || ctx.path === '/api/login' || ctx.path === '/api/health') return next();
  if (!hasValidSession(ctx)) {
    ctx.status = 401;
    ctx.body = { ok: false, error: 'unauthorized' };
    return;
  }
  return next();
}

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

function gatewayUnitText(name) {
  const home = path.join(PROFILES_DIR, name);
  const hermesPython = process.env.HERMES_PYTHON || '/usr/local/lib/hermes-agent/venv/bin/python';
  const pathExtra = process.env.HERMES_PATH_EXTRA || '/usr/local/lib/hermes-agent/venv/bin:/usr/local/lib/hermes-agent/node_modules/.bin';
  const venv = process.env.HERMES_VENV || '/usr/local/lib/hermes-agent/venv';
  const runUser = process.env.HERMES_RUN_USER || 'root';
  return `[Unit]
Description=Hermes Agent Gateway - ${name}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${runUser}
Group=${runUser}
ExecStart=${hermesPython} -m hermes_cli.main --profile ${name} gateway run --replace
WorkingDirectory=${home}
Environment="HOME=${process.env.HOME || '/root'}"
Environment="HERMES_HOME=${home}"
Environment="HERMES_PROFILE=${name}"
Environment="PATH=${pathExtra}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="VIRTUAL_ENV=${venv}"
Restart=always
RestartSec=5
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=25
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

async function createAgentProfile(rawName) {
  const name = normalizeProfileName(rawName);
  if (AGENTS().some((a) => a.profile === name || a.id === name)) {
    throw new Error('已经有这个 agent 了');
  }
  const dest = path.join(PROFILES_DIR, name);
  if (fssync.existsSync(dest)) throw new Error('目录已经存在');
  const hermesBin = process.env.HERMES_BIN || 'hermes';
  await execFileAsync(hermesBin, ['profile', 'create', name, '--no-alias'], { timeout: 60000, env: process.env });
  const cfg = path.join(dest, 'config.yaml');
  if (!fssync.existsSync(cfg)) {
    if (!fssync.existsSync(HERMES_CONFIG)) throw new Error('profile 建完但没有 config.yaml，默认配置也不存在');
    await fs.copyFile(HERMES_CONFIG, cfg);
  }
  const envPath = path.join(dest, '.env');
  if (!fssync.existsSync(envPath)) await fs.writeFile(envPath, '', { mode: 0o600 });
  const unitPath = `/etc/systemd/system/hermes-gateway-${name}.service`;
  await fs.writeFile(unitPath, gatewayUnitText(name), { mode: 0o644 });
  await execFileAsync('systemctl', ['daemon-reload'], { timeout: 30000 });
  await execFileAsync('systemctl', ['enable', '--now', `hermes-gateway-${name}.service`], { timeout: 60000 });
  return AGENTS().find((a) => a.profile === name);
}

function isDefaultAgent(agent) {
  return !agent || agent.id === 'default' || agent.profile === 'agent1' || agent.service === 'hermes-gateway.service';
}

async function cloneAgentProfile(fromRaw, toRaw) {
  const from = getAgent(fromRaw);
  const name = normalizeProfileName(toRaw);
  if (AGENTS().some((a) => a.profile === name || a.id === name)) throw new Error('已经有这个 agent 了');
  const dest = path.join(PROFILES_DIR, name);
  if (fssync.existsSync(dest)) throw new Error('目录已经存在');
  const hermesBin = process.env.HERMES_BIN || 'hermes';
  const args = ['profile', 'create', name, '--no-alias', '--clone-from', from.profile === 'agent1' ? 'default' : from.profile];
  await execFileAsync(hermesBin, args, { timeout: 90000, env: process.env });
  const cfg = path.join(dest, 'config.yaml');
  if (!fssync.existsSync(cfg)) await fs.copyFile(from.config, cfg);
  const envPath = path.join(dest, '.env');
  await fs.writeFile(envPath, '', { mode: 0o600 });
  const unitPath = `/etc/systemd/system/hermes-gateway-${name}.service`;
  await fs.writeFile(unitPath, gatewayUnitText(name), { mode: 0o644 });
  await execFileAsync('systemctl', ['daemon-reload'], { timeout: 30000 });
  await execFileAsync('systemctl', ['enable', '--now', `hermes-gateway-${name}.service`], { timeout: 60000 });
  return AGENTS().find((a) => a.profile === name);
}

async function deleteAgentProfile(rawId) {
  const agent = getAgent(rawId);
  if (isDefaultAgent(agent)) throw new Error('默认 agent 不能删');
  const unit = agent.service;
  try { await execFileAsync('systemctl', ['kill', '-s', 'SIGKILL', unit], { timeout: 15000 }); } catch (_) {}
  try { await execFileAsync('systemctl', ['disable', '--now', unit], { timeout: 20000 }); } catch (_) {}
  const unitPath = `/etc/systemd/system/${unit}`;
  if (fssync.existsSync(unitPath)) await fs.unlink(unitPath);
  try { await execFileAsync('systemctl', ['reset-failed', unit], { timeout: 15000 }); } catch (_) {}
  await execFileAsync('systemctl', ['daemon-reload'], { timeout: 30000 });
  const dest = path.join(PROFILES_DIR, agent.profile);
  if (fssync.existsSync(dest)) await fs.rm(dest, { recursive: true, force: true });
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

async function saveConfig(cfg, configPath = HERMES_CONFIG) {
  ensureModelDefaultHeaders(cfg);
  const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.copyFile(configPath, backup);
  const yaml = YAML.stringify(cfg, { lineWidth: 0 });
  await fs.writeFile(configPath, yaml, 'utf8');
  return backup;
}

function redactKey(key = '') {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 12) return '***';
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function slugName(name = '') {
  return String(name).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/v\d+$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizedProviderName(name = '') {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
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
      const meta = readPanelMeta();
      meta.providers = meta.providers || {};
      meta.providers[key] = { ...(meta.providers[key] || {}), display_name: originalName };
      writePanelMeta(meta);
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
  return { name, base_url, api_key, api_mode, model, models: cleanModels };
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

function normalizeModelListBaseUrl(baseUrl) {
  return normalizeApiBaseUrl(baseUrl);
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
path=os.environ.get('HERMES_STATE_DB') or os.path.expanduser('~/.hermes/state.db')
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

async function fetchProviderModelsDirect(baseUrl, apiKey, apiMode) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  const url = endpoint(normalizeModelListBaseUrl(baseUrl), '/models');
  const headers = { accept: 'application/json' };
  if (apiMode === 'anthropic_messages') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers.authorization = `Bearer ${apiKey}`;
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ac.signal });
    const raw = await res.text();
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
    const res = await fetch(endpoint(provider.base_url || 'https://api.xiaomimimo.com/v1', '/chat/completions'), {
      method: 'POST',
      headers: openAIHeaders(provider),
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const raw = await res.text();
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

async function testProvider(provider, model, message) {
  const apiMode = provider.api_mode || 'chat_completions';
  const started = Date.now();
  let url;
  let payload;
  let headers = { 'content-type': 'application/json' };
  if (provider.api_key) headers.authorization = `Bearer ${provider.api_key}`;

  if (apiMode === 'responses' || apiMode === 'codex_responses') {
    url = endpoint(provider.base_url, '/responses');
    payload = { model, input: message, max_output_tokens: 120 };
  } else if (apiMode === 'anthropic_messages') {
    url = endpoint(provider.base_url, '/messages');
    headers['anthropic-version'] = '2023-06-01';
    payload = { model, max_tokens: 120, messages: [{ role: 'user', content: message }] };
  } else {
    url = endpoint(provider.base_url, '/chat/completions');
    // Some newer/reasoning models reject temperature entirely. Keep the
    // compatibility probe minimal so testing a provider does not fail on an
    // optional sampling parameter that Hermes itself does not require.
    payload = { model, messages: [{ role: 'user', content: message }], max_tokens: 120 };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    const text = pickText(data, apiMode).trim();
    const error = data?.error?.message || data?.error || (!res.ok ? raw.slice(0, 500) : '');
    return {
      ok: res.ok && Boolean(text),
      http_status: res.status,
      latency_ms: Date.now() - started,
      model,
      api_mode: apiMode,
      text,
      empty: res.ok && !text,
      error: typeof error === 'string' ? error.slice(0, 1000) : JSON.stringify(error || '').slice(0, 1000),
    };
  } catch (e) {
    return { ok: false, http_status: 0, latency_ms: Date.now() - started, model, api_mode: apiMode, text: '', empty: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

router.post('/login', async (ctx) => {
  if (AUTH_DISABLED) {
    ctx.body = { ok: true, password_enabled: false };
    return;
  }
  const password = ctx.request.body?.password || '';
  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) {
    ctx.status = 401;
    ctx.body = { ok: false, error: '密码错误' };
    return;
  }
  ctx.cookies.set(COOKIE_NAME, makeToken(), cookieOptions(ctx));
  ctx.body = { ok: true, password_enabled: true };
});

router.post('/logout', async (ctx) => {
  ctx.cookies.set(COOKIE_NAME, '', cookieOptions(ctx, { maxAge: 0 }));
  ctx.body = { ok: true };
});

router.get('/auth-settings', async (ctx) => {
  ctx.body = authPublicStatus();
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
    if (!AUTH_DISABLED) ctx.cookies.set(COOKIE_NAME, makeToken(), cookieOptions(ctx));
    ctx.body = authPublicStatus();
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
      if (newPassword) {
        if (newPassword.length < 8) throw new Error('新密码至少 8 位');
        await updateEnvKey(ENV_FILE, 'ADMIN_PASSWORD', newPassword);
        ADMIN_PASSWORD = newPassword;
      }
      if (!ADMIN_PASSWORD) throw new Error('先设一个至少 8 位的密码，才能打开密码保护');
      await updateEnvKey(ENV_FILE, 'AUTH_DISABLED', '0');
      AUTH_DISABLED = false;
      ctx.cookies.set(COOKIE_NAME, makeToken(), cookieOptions(ctx));
    } else {
      await updateEnvKey(ENV_FILE, 'AUTH_DISABLED', '1');
      AUTH_DISABLED = true;
    }
    ctx.body = authPublicStatus();
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.get('/health', async (ctx) => { ctx.body = { ok: true }; });

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
  ctx.body = await publicState(cfg);
});


router.post('/fetch-models', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const base_url = String(body.base_url || '').trim().replace(/\/$/, '');
    const api_key = String(body.api_key || '').trim();
    const api_mode = String(body.api_mode || 'chat_completions').trim();
    if (!/^https?:\/\//.test(base_url)) throw new Error('请先填写有效 Base URL');
    if (!api_key) throw new Error('请先填写 API Key');
    if (!['chat_completions', 'responses', 'codex_responses', 'anthropic_messages'].includes(api_mode)) throw new Error('API 模式不支持');
    const out = await fetchProviderModelsDirect(base_url, api_key, api_mode);
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
    const { cfg } = await loadConfigDoc();
    cfg.custom_providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
    rememberProviderMeta(p, cfg.custom_providers.length);
    const cleanProvider = canonicalizeProviderForConfig(p, cfg.custom_providers.length);
    const newKey = stableProviderKey(cleanProvider, cfg.custom_providers.length);
    const conflict = cfg.custom_providers.find((x, i) => stableProviderKey(x, i) === newKey || sameProviderIdentity(x, cleanProvider, i, cfg.custom_providers.length));
    if (conflict) throw new Error(`同名/同配置中转站已存在：${displayProviderName(conflict)}`);
    cfg.custom_providers.push(cleanProvider);
    migrateProviderKeys(cfg);
    rebuildQuickCommands(cfg);
    const backup = await saveConfig(cfg);
    ctx.body = { ok: true, backup, state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.put('/providers/:idx', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const { cfg } = await loadConfigDoc();
    const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
    if (!providers[idx]) throw new Error('中转站不存在');
    const old = providers[idx];
    const p = ensureProviderFields({ ...ctx.request.body, api_key: ctx.request.body?.api_key || old.api_key }, false);
    p.provider_key = old.provider_key || stableProviderKey(old, idx) || stableProviderKey(p, idx);
    if (old.name && slugName(old.name) === p.provider_key) p.display_name = p.name;
    rememberProviderMeta(p, idx);
    providers[idx] = canonicalizeProviderForConfig(p, idx);
    migrateProviderKeys(cfg);
    rebuildQuickCommands(cfg);
    const backup = await saveConfig(cfg);
    ctx.body = { ok: true, backup, state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.delete('/providers/:idx', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const { cfg } = await loadConfigDoc();
    cfg.custom_providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
    if (!cfg.custom_providers[idx]) throw new Error('中转站不存在');
    cfg.custom_providers.splice(idx, 1);
    rebuildQuickCommands(cfg);
    const backup = await saveConfig(cfg);
    ctx.body = { ok: true, backup, state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/providers/:idx/refresh-models', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const { cfg } = await loadConfigDoc();
    migrateProviderKeys(cfg);
    const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
    if (!providers[idx]) throw new Error('中转站不存在');
    const p = providers[idx];
    canonicalizeProviderForConfig(p, idx);
    const baseUrl = String(p.base_url || '').trim().replace(/\/$/, '');
    const apiKey = String(p.api_key || '').trim();
    const apiMode = String(p.api_mode || 'chat_completions').trim();
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('这个中转没有有效地址');
    if (!apiKey) throw new Error('这个中转没有保存 API Key，无法重新获取');
    const out = await fetchProviderModelsDirect(baseUrl, apiKey, apiMode);
    if (!out.ok || !(out.models || []).length) {
      ctx.status = 400;
      ctx.body = { ok: false, ...out, error: out.error || '没有获取到模型列表；该中转可能不支持 /models' };
      return;
    }
    const fetched = Array.from(new Set((out.models || []).map((m) => String(m || '').trim()).filter(Boolean)));
    const keepDefault = p.model && !fetched.includes(p.model) ? [p.model] : [];
    p.models = [...keepDefault, ...fetched];
    if (!p.model) p.model = fetched[0];
    rebuildQuickCommands(cfg);
    const backup = await saveConfig(cfg);
    ctx.body = {
      ok: true,
      backup,
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
    const { cfg } = await loadConfigDoc();
    migrateProviderKeys(cfg);
    const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
    if (!providers[idx]) throw new Error('中转站不存在');
    const p = providers[idx];
    canonicalizeProviderForConfig(p, idx);
    const models = Array.from(new Set([p.model, ...(Array.isArray(p.models) ? p.models : []), model].filter(Boolean)));
    p.models = models;
    if (!p.model) p.model = model;
    rebuildQuickCommands(cfg);
    const backup = await saveConfig(cfg);
    ctx.body = { ok: true, backup, state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.delete('/providers/:idx/models/:model', async (ctx) => {
  try {
    const idx = Number(ctx.params.idx) - 1;
    const model = decodeURIComponent(ctx.params.model);
    const { cfg } = await loadConfigDoc();
    migrateProviderKeys(cfg);
    const providers = Array.isArray(cfg.custom_providers) ? cfg.custom_providers : [];
    if (!providers[idx]) throw new Error('中转站不存在');
    const p = providers[idx];
    canonicalizeProviderForConfig(p, idx);
    const models = Array.from(new Set([p.model, ...(Array.isArray(p.models) ? p.models : [])].filter(Boolean))).filter((m) => m !== model);
    p.models = models;
    if (p.model === model) p.model = models[0] || '';
    rebuildQuickCommands(cfg);
    const backup = await saveConfig(cfg);
    ctx.body = { ok: true, backup, state: await publicState(cfg) };
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
    ctx.body = { ok: Boolean(out.res?.ok && audioB64), http_status: out.res?.status || 0, latency_ms: out.latency_ms, model, voice, format, audioDataUrl: audioB64 ? `data:${mime};base64,${audioB64}` : '', content, error: out.err || (!audioB64 ? '未返回音频数据' : '') };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/test', async (ctx) => {
  try {
    const body = ctx.request.body || {};
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
        return { providerIndex: pi + 1, provider: p, provider_name: norm.name, model: norm.model || norm.models[0] || '' };
      });
    } else if (body.providerAllModels || providerIndexRaw.startsWith('provider-all:')) {
      const rawId = body.providerAllModels || providerIndexRaw.slice('provider-all:'.length);
      const idx = Number(rawId) - 1;
      const p = providers[idx];
      if (!p) throw new Error('中转站不存在');
      const norm = normalizeProvider(p, idx);
      targets = (norm.models || []).map((model) => ({ providerIndex: idx + 1, provider: p, provider_name: norm.name, model }));
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
      targets = [{ providerIndex: idx + 1, provider: p, provider_name: norm.name, model }];
    }

    targets = targets.filter((t) => t.provider?.base_url && t.provider?.api_key && t.model).slice(0, 50);
    if (!targets.length) throw new Error('没有可测试的中转站/模型');
    const startedAll = Date.now();
    const results = await Promise.all(targets.map(async (t) => {
      const result = await testProvider(t.provider, t.model, message);
      return { providerIndex: t.providerIndex, provider_name: t.provider_name, base_url: t.provider.base_url, ...result };
    }));
    ctx.body = { ok: true, message, count: results.length, latency_ms: Date.now() - startedAll, results };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/switch', async (ctx) => {
  try {
    const providerIndex = Number(ctx.request.body?.providerIndex) - 1;
    const model = String(ctx.request.body?.model || '').trim();
    const targetAgent = String(ctx.request.body?.agent || 'default').trim();
    const { cfg: baseCfg } = await loadConfigDoc(HERMES_CONFIG);
    const providers = Array.isArray(baseCfg.custom_providers) ? baseCfg.custom_providers : [];
    const p = providers[providerIndex];
    if (!p) throw new Error('中转站不存在');
    if (!model) throw new Error('模型不能为空');
    const targets = resolveAgentTargets(targetAgent);
    const backups = [];
    migrateProviderKeys(baseCfg);
    ensureProviderKey(p, providerIndex);
    const touchesDefaultConfig = targets.some((a) => a.config === HERMES_CONFIG);
    if (!touchesDefaultConfig) {
      const backup = await saveConfig(baseCfg, HERMES_CONFIG);
      backups.push({ agent: 'base', backup });
    }
    for (const agent of targets) {
      const { cfg } = await loadConfigDoc(agent.config);
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
      const backup = await saveConfig(cfg, agent.config);
      backups.push({ agent: agent.id, backup });
    }
    const { cfg } = await loadConfigDoc(HERMES_CONFIG);
    ctx.body = { ok: true, backups, switched: targets.map((a) => a.id), state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
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

router.post('/image-gen/switch', async (ctx) => {
  try {
    const model = String(ctx.request.body?.model || '').trim();
    const targetAgent = String(ctx.request.body?.agent || 'default').trim();
    if (!model) throw new Error('生图模型不能为空');
    const targets = resolveAgentTargets(targetAgent);
    const backups = [];
    for (const agent of targets) {
      const { cfg } = await loadConfigDoc(agent.config);
      ensureImageGenDefaults(cfg, model);
      const backup = await saveConfig(cfg, agent.config);
      backups.push({ agent: agent.id, backup });
    }
    const { cfg } = await loadConfigDoc(HERMES_CONFIG);
    ctx.body = { ok: true, backups, switched: targets.map((a) => a.id), state: await publicState(cfg) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
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

function parseToolsList(stdout = '') {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([✓✗])\s+(enabled|disabled)\s+(\S+)\s+/);
    if (!m) continue;
    out.push({ name: m[3], enabled: m[2] === 'enabled' });
  }
  return out;
}

function agentEnvPath(agent) {
  if (!agent) throw new Error('agent 不存在');
  if (agent.profile === 'agent1' || agent.id === 'default') return path.join(HERMES_HOME, '.env');
  return path.join(PROFILES_DIR, agent.profile, '.env');
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
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function readAgentPlatforms(agent) {
  const envPath = agentEnvPath(agent);
  let map = {};
  try { map = parseDotEnv(fssync.readFileSync(envPath, 'utf8')); } catch { map = {}; }
  return CHAT_PLATFORMS.map((p) => {
    const configured = p.configuredIf.every((k) => envHas(map, k));
    const fields = p.fields.map((f) => ({
      key: f.key,
      label: f.label,
      secret: !!f.secret,
      required: !!f.required,
      placeholder: f.placeholder || '',
      set: envHas(map, f.key),
      preview: f.secret ? (envHas(map, f.key) ? maskSecret(map[f.key]) : '') : String(map[f.key] || ''),
    }));
    return { id: p.id, label: p.label, configured, fields };
  });
}

function agentHomeDir(agent) {
  if (!agent) throw new Error('agent 不存在');
  if (agent.profile === 'agent1' || agent.id === 'default') return HERMES_HOME;
  return path.join(PROFILES_DIR, agent.profile);
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

async function systemctlAction(service, action) {
  const { stdout, stderr } = await execFileAsync('systemctl', [action, service], { timeout: 25000 });
  return { stdout, stderr };
}

function upsertEnvValues(envPath, updates) {
  let text = '';
  try { text = fssync.readFileSync(envPath, 'utf8'); } catch { text = ''; }
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
  const dir = path.dirname(envPath);
  if (!fssync.existsSync(dir)) fssync.mkdirSync(dir, { recursive: true });
  fssync.writeFileSync(envPath, out, { mode: 0o600 });
}

function removeEnvKeys(envPath, keys) {
  const updates = {};
  for (const key of keys) updates[key] = null;
  upsertEnvValues(envPath, updates);
}

router.get('/chat-platforms', async (ctx) => {
  try {
    const agents = AGENTS().map((agent) => ({
      id: agent.id,
      profile: agent.profile,
      name: agent.name,
      platforms: readAgentPlatforms(agent),
    }));
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
    const current = parseDotEnv(fssync.existsSync(agentEnvPath(agent)) ? fssync.readFileSync(agentEnvPath(agent), 'utf8') : '');
    const updates = {};
    for (const field of spec.fields) {
      if (!Object.prototype.hasOwnProperty.call(incoming, field.key)) continue;
      const value = String(incoming[field.key] ?? '').trim();
      if (!value) continue;
      if (!CHAT_PLATFORM_KEYS.has(field.key)) continue;
      updates[field.key] = value;
    }
    const merged = { ...current, ...updates };
    for (const key of spec.configuredIf) {
      if (!String(merged[key] || '').trim()) throw new Error(`${spec.label} 还缺必填项`);
    }
    if (!Object.keys(updates).length) throw new Error('没有可保存的字段');
    upsertEnvValues(agentEnvPath(agent), updates);
    ctx.body = { ok: true, agent: agent.id, profile: agent.profile, platform: platformId, platforms: readAgentPlatforms(agent) };
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
    removeEnvKeys(agentEnvPath(agent), keys);
    ctx.body = { ok: true, agent: agent.id, profile: agent.profile, platform: platformId, platforms: readAgentPlatforms(agent) };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message };
  }
});

router.post('/rebuild-commands', async (ctx) => {
  const { cfg } = await loadConfigDoc();
  rebuildQuickCommands(cfg);
  const backup = await saveConfig(cfg);
  ctx.body = { ok: true, backup, state: await publicState(cfg) };
});

router.post('/agents', async (ctx) => {
  try {
    const name = ctx.request.body?.name || ctx.request.body?.profile;
    const cloneFrom = ctx.request.body?.cloneFrom || ctx.request.body?.from;
    const agent = cloneFrom ? await cloneAgentProfile(cloneFrom, name) : await createAgentProfile(name);
    ctx.body = { ok: true, agent, agents: AGENTS() };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr };
  }
});

router.delete('/agents/:id', async (ctx) => {
  try {
    const agents = await deleteAgentProfile(ctx.params.id);
    ctx.body = { ok: true, agents };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr };
  }
});

router.post('/restart-gateway', async (ctx) => {
  try {
    const targetAgent = String(ctx.request.body?.agent || 'default').trim();
    const targets = resolveAgentTargets(targetAgent);
    const results = [];
    for (const agent of targets) {
      const { stdout, stderr } = await execFileAsync('systemctl', ['restart', agent.service], { timeout: 240000 });
      results.push({ agent: agent.id, service: agent.service, stdout, stderr });
    }
    ctx.body = { ok: true, results };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr };
  }
});

router.get('/service-status', async (ctx) => {
  const statuses = await Promise.all(AGENTS().map(async (agent) => {
    try {
      const { stdout } = await execFileAsync('systemctl', ['is-active', agent.service], { timeout: 4000 });
      const gw = readGatewayState(agent);
      return { agent: agent.id, profile: agent.profile, name: agent.name, service: agent.service, status: stdout.trim(), ok: stdout.trim() === 'active', ...gw };
    } catch (e) {
      const st = String((e.stdout || '')).trim() || 'inactive';
      const gw = readGatewayState(agent);
      return { agent: agent.id, profile: agent.profile, name: agent.name, service: agent.service, status: st, ok: false, ...gw };
    }
  }));
  ctx.body = { ok: statuses.every((s) => s.ok), statuses, status: statuses.map((s) => `${s.profile || s.agent}:${s.status}`).join(' ') };
});

router.post('/gateway-control', async (ctx) => {
  try {
    const action = String(ctx.request.body?.action || '').trim();
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('只支持 start / stop / restart');
    const targets = resolveAgentTargets(String(ctx.request.body?.agent || 'default').trim());
    const results = [];
    for (const agent of targets) {
      const { stdout, stderr } = await systemctlAction(agent.service, action);
      results.push({ agent: agent.id, profile: agent.profile, service: agent.service, action, stdout, stderr });
    }
    ctx.body = { ok: true, results };
  } catch (e) {
    ctx.status = 400;
    ctx.body = { ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr };
  }
});

app.use(bodyParser({ jsonLimit: '30mb' }));

// Caddy forward_auth endpoint. It must be outside /api so every subdomain can
// optional shared cookie check; override AUTH_LOGIN_URL.
app.use(async (ctx, next) => {
  if (ctx.path !== '/auth/check') return next();
  if (hasValidSession(ctx)) {
    ctx.status = 204;
    return;
  }
  const forwardedHost = ctx.get('x-forwarded-host') || ctx.host || 'localhost';
  let forwardedUri = ctx.get('x-forwarded-uri') || '/';
  if (false && forwardedUri === '/index.html') forwardedUri = '/';
  const nextUrl = forwardedUri.startsWith('http') ? forwardedUri : `https://${forwardedHost}${forwardedUri}`;
  ctx.status = 302;
  ctx.redirect(`${process.env.AUTH_LOGIN_URL || '/login'}?next=${encodeURIComponent(nextUrl)}`);
});

app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/api/')) return requireAuth(ctx, next);
  return next();
});
app.use(router.routes());
app.use(router.allowedMethods());
app.use(serve(PUBLIC_DIR));
app.use(async (ctx) => {
  if (ctx.method === 'GET') ctx.type = 'html', ctx.body = fssync.createReadStream(path.join(PUBLIC_DIR, 'index.html'));
});

const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Hermes model panel listening on ${HOST}:${PORT}`);
});
