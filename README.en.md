1|# Hermes Model Panel
2|
3|[![Version](https://img.shields.io/badge/version-v1.3.18-6f8cff)](https://github.com/17sho/hermes-model-panel/releases)
4|[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](package.json)
5|[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
6|[![Hermes Agent](https://img.shields.io/badge/for-Hermes%20Agent-111827)](https://github.com/NousResearch/hermes-agent)
7|
8|[中文](README.md) · **English**
9|
10|A responsive web control panel for an existing [Hermes Agent](https://github.com/NousResearch/hermes-agent) installation. Manage models, OpenAI-compatible relays, Agent profiles, chat platforms, Skills, tools, sessions, and Gateway services from one UI.
11|
12|> This panel does not install Hermes or provide API keys and bot tokens. Install and configure Hermes Agent first.
13|
14|![Model and Agent management](docs/images/panel-models.png)
15|
16|## Features
17|
18|| Area | Capabilities |
19|| -------------------- | -------------------------------------------------------------------------------------------- |
20|| Models and relays | Add compatible relays, fetch and test models, and authorize private-network access per relay |
21|| Agents / Profiles | Create and remove Profiles with independent model and service settings |
22|| Chat platforms | Manage Telegram, Weixin, Discord, WhatsApp, Slack, and Feishu |
23|| Tools and Skills | Inspect and switch toolsets per Agent, manage Skills |
24|| Sessions and context | Inspect work status, resume historical context, generate quick commands |
25|| Gateway | Inspect status and raw logs; install, start, stop, or restart services |
26|| Security | Server-side login, Session cookies, CSRF validation, atomic config writes |
27|| Online updates | Check GitHub revisions, install in the background, automatically roll back failures |
28|| Responsive UI | Persistent desktop sidebar, mobile drawer, light and dark themes |
29|
30|<p align="center">
31| <img src="docs/images/panel-platforms.png" width="49%" alt="Chat platform management">
32| <img src="docs/images/panel-tools.png" width="49%" alt="Agent tool management">
33|</p>
34|
35|## Quick installation
36|
37|### Requirements
38|
39|- Linux with systemd
40|- Hermes Agent already installed with `~/.hermes/config.yaml`
41|- Node.js 20+, npm, rsync, and OpenSSL
42|- root or sudo access
43|
44|`bash
45|git clone https://github.com/17sho/hermes-model-panel.git
46|cd hermes-model-panel
47|sudo bash install.sh
48|`
49|
50|The installer checks the Hermes configuration, installs the panel at `/opt/hermes-model-panel`, installs production dependencies, creates `/etc/hermes-model-panel.env` on first run, enables the systemd service, and prints the local URL.
51|
52|The server listens on `127.0.0.1:3010` by default. For LAN access, explicitly use:
53|
54|`bash
55|sudo HOST=0.0.0.0 AUTH_DISABLED=0 bash install.sh
56|sudo ufw allow from 192.168.0.0/16 to any port 3010 proto tcp
57|`
58|
59|For public access, keep password authentication enabled and terminate HTTPS through Caddy or Nginx. Never expose a passwordless panel directly to the Internet.
60|
61|## Manual run
62|
63|`bash
64|npm ci
65|npm start
66|`
67|
68|Production examples:
69|
70|- [`samples/hermes-model-panel.env.example`](samples/hermes-model-panel.env.example)
71|- [`systemd/hermes-model-panel.service`](systemd/hermes-model-panel.service)
72|- [`caddy/hermes-model-panel.caddy.example`](caddy/hermes-model-panel.caddy.example)
73|
74|## Online updates
75|
76|After the initial v1.1.0 deployment, open **Settings → Panel online update** to check GitHub `main`. The updater pins the target commit SHA, installs dependencies and validates code in a temporary directory, replaces the program directory, and restarts the service. A failed startup restores the previous release.
77|
78|Updates replace code only. They preserve the environment file, Hermes configuration and Profiles, Session databases, panel metadata, and credentials.
79|
80|> The current updater targets GitHub commit SHAs. For public production systems, update only to reviewed stable revisions.
81|
82|## Security notes
83|
84|- The service listens on `127.0.0.1` by default.
85|- Public deployments require a strong administrator password and persistent `SESSION_SECRET`.
86|- Stored secrets are not echoed back in plaintext by the UI.
87|- Before writing Hermes YAML, the panel creates timestamped `.bak-*` files and retains the latest ten.
88|- The current systemd service remains root-compatible because Hermes configuration, Profiles, logs, and service controls need real permission testing before migration to a dedicated user.
89|
90|Never commit real `.env` files, API keys, bot tokens, cookies, databases, or production configuration.
91|
92|## Development and testing
93|
94|`bash
95|npm ci
96|python3 -m pip install -r requirements-dev.txt
97|npm run check
98|npx playwright install chromium
99|npm run test:e2e
100|`
101|
102|`npm run check` covers Node/Python syntax, ESLint, Stylelint, Ruff, Prettier, and `node:test`. Playwright runs against a read-only fixture server and cannot mutate production configuration.
103|
104|## License
105|
106|[MIT](LICENSE)
107|
108|If this project helps you, a **Star** is appreciated. Issues and pull requests are welcome.
109|
