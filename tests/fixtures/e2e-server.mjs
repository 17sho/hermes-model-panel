import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const malicious = `x" onclick="globalThis.pwned=1`;
const slashModel = 'deepseek-ai/DeepSeek-V3';
const state = {
  ok: true,
  agents: [{ id: 'default', name: 'Agent1', profile: 'agent1', current: { model: 'fixture-model', provider: 'custom', base_url: 'https://fixture.invalid/v1' } }],
  current: { model: 'fixture-model', provider: 'custom', base_url: 'https://fixture.invalid/v1' },
  providers: [{ id: 1, name: malicious, slug: 'custom:fixture', base_url: 'https://fixture.invalid/v1', api_mode: 'chat_completions', model: malicious, models: [malicious, slashModel], api_key_redacted: '***' }],
  commands: [{ command: '/model', description: '模型', target: 'default' }], image_models: [],
};
const statuses = [{ agent: 'default', profile: 'agent1', name: 'Agent1', status: 'active', ok: true, platforms: {}, busy_targets: [], active_agents: 0 }];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method === 'DELETE' && url.pathname === `/api/providers/1/models/${encodeURIComponent(slashModel)}`) {
      state.providers[0].models = state.providers[0].models.filter((model) => model !== slashModel);
      response.end(JSON.stringify({ ok: true, state }));
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.statusCode = 405;
      response.end(JSON.stringify({ ok: false, error: 'fixture 禁止写操作' }));
      return;
    }
    const payload = url.pathname === '/api/state' ? state
      : url.pathname === '/api/service-status' ? { ok: true, statuses }
        : url.pathname === '/api/auth-settings' ? { ok: true, password_enabled: false, password_set: false }
          : url.pathname === '/api/sessions' ? { ok: true, sessions: [], total: 0, page: 1, pages: 1, model_choices: [] }
            : url.pathname === '/api/toolsets' ? { ok: true, catalog: [], agents: [{ agent: 'default', name: 'Agent1', enabled: [] }] }
              : url.pathname === '/api/skills' ? { ok: true, agents: [{ agent: 'default', name: 'Agent1', catalog: [], disabled: [] }] }
                : url.pathname === '/api/chat-platforms' ? { ok: true, agents: [] }
                  : url.pathname === '/api/health' ? { ok: true }
                    : { ok: true, statuses: [], events: [], total: 0 };
    response.end(JSON.stringify(payload));
    return;
  }
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const file = path.join(root, 'public', relative);
  if (!file.startsWith(path.join(root, 'public'))) {
    response.statusCode = 403;
    response.end();
    return;
  }
  try {
    const body = await fs.readFile(file);
    response.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.end('not found');
  }
});

server.listen(43173, '127.0.0.1');
