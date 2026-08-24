# Hermes Model Panel

English | [中文](README.md)

Hermes Model Panel is a framework-free Chinese administration UI for Hermes Agent models, providers, sessions, Skills, chat platforms, and Gateway status. It keeps the existing 13-page interface and protects administrative operations with server-side authentication, CSRF validation, and atomic configuration writes.

## Safe access

The server listens on `127.0.0.1` by default, which is appropriate for local access or a Caddy reverse proxy. Setting `HOST=0.0.0.0` listens on every interface and enables LAN access; pair this with host firewall rules that allow only trusted subnets. Never expose a passwordless panel directly to the public internet.

Public access requires a strong administrator password and a persistent session secret. Caddy is recommended for HTTPS, access logging, and additional access controls. See `samples/hermes-model-panel.env.example` for variable names, and never commit real environment files or secrets.

## Install and run

```bash
npm ci
npm start
```

For production, use `systemd/hermes-model-panel.service` as a reference, install the project at `/opt/hermes-model-panel`, and place the environment file at `/etc/hermes-model-panel.env`. An administrator should perform daemon-reload and restart during a maintenance window after unit changes; repository tests never restart services.

## Backup and restore

Before changing Hermes YAML, the panel creates timestamped `.bak-*` files beside the configuration and retains the latest 10. Keep separate deployment backups of the Hermes configuration tree, Session SQLite databases, and panel metadata. Before restoring, stop writers, preserve the current files, and restore a backup made by a compatible version. Do not overwrite a live SQLite database.

## Development and testing

```bash
npm ci
python3 -m pip install -r requirements-dev.txt
npm run check
npm audit --omit=dev
npx playwright install chromium
npm run test:e2e
```

Playwright runs against a read-only fixture server whose non-GET APIs return 405, so E2E tests cannot write production configuration or business data. `npm run check` includes JS/Python syntax checks, ESLint, Stylelint, Ruff, format checks, and `node:test` regressions.

## systemd least-privilege roadmap

The unit intentionally retains `User=root` until every real path used for model configuration, Agent profiles, Session databases, systemd management, and log access has been exercised. The current safe hardening is limited to `NoNewPrivileges`, `PrivateTmp`, `UMask=0077`, `RestrictSUIDSGID`, and `LockPersonality`. A future migration should inventory and verify every read, write, and command path, introduce a dedicated user, and then add `ProtectHome`, `ProtectSystem`, and precise `ReadWritePaths` incrementally with full regression and real management-flow testing after each step.
