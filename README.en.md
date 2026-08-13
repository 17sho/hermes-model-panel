# Hermes Model Panel

[中文说明](README.md)

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
| Chat platforms | Per-agent Telegram / WeChat / Discord / … tokens (never echoed); turn a platform off |
| Work status | Dedicated page: busy / idle / stopped (busy shows who + elapsed); start/stop/restart Gateway |
| Context | Dedicated page: open sessions, resume, delete, per-chat model |
| Agent tools | Dedicated page: per-agent basic toolsets (web/terminal/browser); not chat-platform toolsets |
| Skills | Dedicated page: enable/disable installed skills; archive-delete a skill |
| Settings | Change or toggle panel password; restart the matching Gateway |

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

Default bind is **127.0.0.1:3010**. You installed over SSH on a cloud VM: there is usually no browser on the server, and `http://PUBLIC_IP:3010/` from your laptop **will not work yet**. That is expected.

Then in the panel:

1. **Add relay** → address + API key → fetch models → assign to an agent
2. **Chat platforms** → fill the token for that agent
3. **Settings** → restart the matching Gateway → `/reset` in chat

## Open it from the internet (cloud VPS)

You installed on a **VPS**. Your laptop is not on the same Wi-Fi as the server. Do not look for 192.168.

Default listen is `127.0.0.1`. `http://PUBLIC_IP:3010/` from home **will fail** until the steps below.

### 1) On the server, confirm the unit is up

SSH in:

```bash
hermes-model-panel
sudo systemctl status hermes-model-panel --no-pager
```

`running` + `http://127.0.0.1:3010/` only means **inside the VM** it works.

### 2) Bind the public NIC

Still in SSH:

```bash
sudo nano /etc/hermes-model-panel.env
```

Set `HOST=0.0.0.0`, then:

```bash
sudo systemctl restart hermes-model-panel
```

This alone is often not enough — the cloud vendor has another door.

### 3) Security group (most common miss)

In the provider console (Aliyun / Tencent / Huawei / Lightsail / DigitalOcean / UpCloud …):

1. Open **Security group / Firewall / Networking** for this instance
2. **Inbound**: TCP **3010**, source = your home IP, or `0.0.0.0/0` if you must
3. Save / apply to the instance

If you only change the env file and skip this, the public IP never answers.

### 4) Host firewall

```bash
sudo ufw allow 3010/tcp && sudo ufw reload
# or: sudo firewall-cmd --add-port=3010/tcp --permanent && sudo firewall-cmd --reload
```

Skip if those commands do not exist.

### 5) Open from your own browser

On **your** laptop or phone (not on the server):

`http://PUBLIC_IP:3010/`

Public IP is on the instance page, or `curl -4 -s ifconfig.me`. Use **http**, port **3010**. Then set:

```
AUTH_DISABLED=0
ADMIN_PASSWORD=a-long-password-you-choose
```

```bash
sudo systemctl restart hermes-model-panel
```

### 6) Domain later (recommended)

Point an A record at the VM, reverse-proxy to `127.0.0.1:3010` (see `caddy/model.example.com.caddy`). Then `HOST` can go back to `127.0.0.1` and the security group only needs 80/443.

### If it does not open

| Symptom | Likely cause |
| --- | --- |
| Timeout on `http://PUBLIC_IP:3010/` | Security group closed, or still `HOST=127.0.0.1` |
| Still timeout after HOST change | Console rule not saved / not applied |
| Connection refused | `sudo systemctl status hermes-model-panel` |
| Open to the world, no login | `AUTH_DISABLED` still `1` |
| `https://` fails | Direct port is http only |

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
