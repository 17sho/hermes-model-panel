# Hermes Model Panel

[English](README.en.md) | 中文

Hermes Model Panel 是一个无前端框架的中文管理面板，用来查看和管理 Hermes Agent 的模型、中转站、会话、Skills、聊天平台及 Gateway 状态。面板保留 13 个功能页，并以服务端鉴权、CSRF 校验和原子配置写入保护管理操作。

## 安全访问

服务默认仅监听 `127.0.0.1`，适合本机访问或由 Caddy 反向代理。若设置 `HOST=0.0.0.0`，面板会监听所有网络接口，可供局域网访问；请同时用主机防火墙只允许可信网段。不要把无密码面板直接暴露到公网。

公网访问必须设置强管理密码和持久的 Session Secret，并建议由 Caddy 提供 HTTPS、访问日志与额外访问控制。示例环境变量名称见 `samples/hermes-model-panel.env.example`；不要把真实环境文件或密钥提交到仓库。

## 安装与运行

```bash
npm ci
npm start
```

生产部署可参考 `systemd/hermes-model-panel.service`，将项目安装到 `/opt/hermes-model-panel`，环境文件放在 `/etc/hermes-model-panel.env`。修改 unit 后需要由管理员在维护窗口执行 daemon-reload 和 restart；本仓库的测试不会重启服务。

## 备份与恢复

面板写入 Hermes YAML 配置前会在原目录生成带时间戳的 `.bak-*` 备份，并只保留最近 10 份。部署前还应独立备份 Hermes 配置目录、Session SQLite 数据库和面板元数据。恢复前停止写入来源，先复制当前文件，再以匹配版本的备份恢复；不要在正在运行的数据库上直接覆盖文件。

## 开发与测试

```bash
npm ci
python3 -m pip install -r requirements-dev.txt
npm run check
npm audit --omit=dev
npx playwright install chromium
npm run test:e2e
```

Playwright 使用只读 fixture server，所有非 GET API 都会返回 405，不会写入生产配置或业务数据。`npm run check` 包含 JS/Python 语法检查、ESLint、Stylelint、Ruff、格式检查和 `node:test` 回归测试。

## systemd 最小权限路线

当前 unit 保留 `User=root`，因为模型配置、Agent profiles、Session 数据库、systemd 管理和日志读取的真实路径需要逐项实测。现阶段只启用 `NoNewPrivileges`、`PrivateTmp`、`UMask=0077`、`RestrictSUIDSGID` 和 `LockPersonality`。后续迁移应先列出并验证全部读写与命令路径，再建立专用用户，最后按实测结果逐步加入 `ProtectHome`、`ProtectSystem` 和精确的 `ReadWritePaths`，每一步都运行完整回归与真实管理流程。
