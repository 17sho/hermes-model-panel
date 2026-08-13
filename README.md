# Hermes Model Panel

[中文说明](README.zh-CN.md)

A small web panel for an **already-installed** [Hermes Agent](https://github.com/NousResearch/hermes-agent). Add OpenAI-compatible relays, pick models per agent, and attach chat platforms (Telegram / WeChat / Discord / …).

This is **not** a Hermes installer. An empty machine with no Hermes, no Node, and no API keys cannot chat after clone.

## License

MIT. The `LICENSE` file is the canonical text. You may use, modify, and redistribute this panel; keep the copyright notice.

## Prerequisites

- Linux (systemd recommended)
- Node.js 18+ and npm
- Hermes already installed (`~/.hermes/config.yaml` exists)
- Optional: running `hermes-gateway` units if you want chat to go live after restart
- At least one relay API key (the panel cannot invent quota)
- A bot token / WeChat credential if you want messaging platforms

## One-shot install (machine already has Hermes)

```bash
git clone https://github.com/17sho/hermes-model-panel.git
cd hermes-model-panel
sudo bash install.sh
```

`install.sh` will:

1. Stop if Hermes config is missing
2. Copy the app to `/opt/hermes-model-panel` (override with `DEST=`)
3. `npm ci --omit=dev`
4. Write `/etc/hermes-model-panel.env` if absent (does not overwrite)
5. Install and start `hermes-model-panel.service`
6. Probe `http://127.0.0.1:3010/`

Then in the panel:

1. **Add relay** → address + API key → fetch models → assign to an agent
2. **Chat platforms** → fill the token for that agent
3. **Settings** → restart the matching Gateway → `/reset` in chat

Public bind without a reverse proxy: set `AUTH_DISABLED=0` and `ADMIN_PASSWORD` in the env file. The script does not print the password.

## Manual run

```bash
cp samples/hermes-model-panel.env.example hermes-model-panel.env
# edit env
npm ci --omit=dev
node server.js
```

Useful variables: `PORT`, `HOST`, `HERMES_CONFIG`, `HERMES_HOME`, `AUTH_DISABLED`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `AUTH_LOGIN_URL`.

Caddy example: `caddy/model.example.com.caddy`.

## What it scans

Agents are discovered at request time:

- `~/.hermes/config.yaml` → one default agent
- each `~/.hermes/profiles/<name>/config.yaml` → another agent

Ten profiles → ten cards. Platform tokens stay in that agent’s `.env` and are never echoed in full.

## Privacy

The public tree has no live keys, bot tokens, or production hostnames. Do not commit your env file.

If this helped, a GitHub Star is appreciated.
