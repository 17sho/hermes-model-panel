# Hermes Model Panel

[中文说明](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-6f8cff.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Hermes](https://img.shields.io/badge/requires-Hermes%20Agent-0e1016)](https://github.com/NousResearch/hermes-agent)

A small dark-theme web panel for an **already-installed** [Hermes Agent](https://github.com/NousResearch/hermes-agent). Add OpenAI-compatible relays, pick models per agent, and attach chat platforms (Telegram / WeChat / Discord / …).

**Not** a Hermes installer. Clone + `install.sh` only starts the panel. Chat still needs Hermes, a relay API key, and (for messaging) a bot token.

<p align="center">
  <img src="docs/images/panel-models.png" alt="Current models" width="720">
</p>
<p align="center">
  <img src="docs/images/panel-platforms.png" alt="Chat platforms" width="720">
</p>

## What you get

| Area | What it does |
| --- | --- |
| Current models | Lists every scanned agent, current model + relay |
| Relays | Add OpenAI-compatible endpoints, fetch models, assign per agent |
| Image models | Pick image generation models from the same relays |
| Chat platforms | Per-agent Telegram / WeChat / Discord / … tokens (never echoed) |
| Settings | Restart the matching Gateway so changes go live |

Agents are discovered when you open or refresh the page — not on a timer.

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
7. Install the `hermes-model-panel` command

Open the panel:

```bash
hermes-model-panel          # print listen address + how to open
```

Default bind is **127.0.0.1:3010** — only that machine’s browser works (`http://127.0.0.1:3010/`).  
Other devices using `http://服务器IP:3010/` will fail until you set `HOST=0.0.0.0` in `/etc/hermes-model-panel.env` and restart the unit. Then use `http://那台机器的IP:3010/`. Put a reverse proxy in front for a domain.

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

- `~/.hermes/config.yaml` → one default agent
- each `~/.hermes/profiles/<name>/config.yaml` → another agent

Ten profiles → ten cards. Platform tokens stay in that agent’s `.env` and are never echoed in full.

## Privacy

The public tree has no live keys, bot tokens, or production hostnames. Do not commit your env file.

If this helped, a GitHub Star is appreciated.
