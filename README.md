# Hermes Model Panel

[![版本](https://img.shields.io/badge/version-v1.3.13-6f8cff)](https://github.com/17sho/hermes-model-panel/releases)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Hermes Agent](https://img.shields.io/badge/for-Hermes%20Agent-111827)](https://github.com/NousResearch/hermes-agent)

**中文** · [English](README.en.md)

为已经安装好的 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 提供一个中文可视化管理台：管理模型与中转站、Agent/Profile、聊天平台、Skills、工具、会话和 Gateway 状态。

> 面板不会替你安装 Hermes，也不会提供 API Key 或 Bot Token。请先安装并配置 Hermes Agent。

![模型与 Agent 管理](docs/images/panel-models.png)

## 功能

| 模块            | 能力                                                       |
| --------------- | ---------------------------------------------------------- |
| 模型与中转站    | 添加兼容中转、获取模型、切换和测试，并按中转站授权私网访问 |
| Agent / Profile | 新建和删除 Profile、独立配置模型与服务                     |
| 聊天平台        | 管理 Telegram、微信、Discord、WhatsApp、Slack、飞书        |
| 工具与 Skills   | 按 Agent 查看和切换工具包、管理 Skills                     |
| 会话与上下文    | 查看工作状态、选择历史上下文、生成快捷命令                 |
| Gateway         | 查看状态和原始日志、安装、启动、停止或重启服务             |
| 安全            | 服务端登录、Session Cookie、CSRF 校验、原子配置写入        |
| 在线更新        | 检查 GitHub 新版本、后台安装、失败自动回滚                 |
| 响应式界面      | 桌面常驻侧栏、移动抽屉、日间/夜间主题                      |

<p align="center">
  <img src="docs/images/panel-platforms.png" width="49%" alt="聊天平台管理">
  <img src="docs/images/panel-tools.png" width="49%" alt="Agent 工具管理">
</p>

## 快速安装

### 前提

- Linux + systemd
- 已安装 Hermes Agent，并存在 `~/.hermes/config.yaml`
- Node.js 20+、npm、rsync、OpenSSL
- root 或 sudo 权限

```bash
git clone https://github.com/17sho/hermes-model-panel.git
cd hermes-model-panel
sudo bash install.sh
```

安装脚本会：

1. 检查 Hermes 配置；
2. 安装到 `/opt/hermes-model-panel`；
3. 安装生产依赖；
4. 首次生成 `/etc/hermes-model-panel.env`；
5. 安装并启动 `hermes-model-panel.service`；
6. 输出本机打开地址。

默认仅监听 `127.0.0.1:3010`。局域网访问需要显式执行：

```bash
sudo HOST=0.0.0.0 AUTH_DISABLED=0 bash install.sh
sudo ufw allow from 192.168.0.0/16 to any port 3010 proto tcp
```

公网访问请保持密码登录，使用 Caddy/Nginx 提供 HTTPS，不要把无密码面板直接暴露到公网。

## 手动运行

```bash
npm ci
npm start
```

生产环境示例见：

- [`samples/hermes-model-panel.env.example`](samples/hermes-model-panel.env.example)
- [`systemd/hermes-model-panel.service`](systemd/hermes-model-panel.service)
- [`caddy/hermes-model-panel.caddy.example`](caddy/hermes-model-panel.caddy.example)

## 在线更新

首次部署 v1.1.0 后，可在 **设置 → 面板在线更新** 检查 GitHub `main` 分支。更新器锁定目标提交 SHA，在临时目录安装依赖并检查代码，然后替换程序目录并重启；启动失败会恢复上一版。

更新只替换代码，不覆盖：

- `/etc/hermes-model-panel.env`
- Hermes 配置和 Profiles
- Session 数据库
- 面板元数据及凭据

> 当前在线更新以 GitHub 提交 SHA 为目标。正式公网环境建议只从审查后的稳定版本更新。

## 安全说明

- 服务默认只监听 `127.0.0.1`。
- 公网部署必须设置强管理密码和持久的 `SESSION_SECRET`。
- 密钥不会在管理页面重新明文显示。
- 写入 Hermes YAML 前会创建 `.bak-*` 备份，并保留最近 10 份。
- 当前 systemd 服务仍使用 root，以兼容 Hermes 配置、Profile、日志和服务管理；迁移专用用户前必须逐项验证实际权限。

不要提交真实 `.env`、API Key、Bot Token、Cookie、数据库或生产配置。

## 开发与测试

```bash
npm ci
python3 -m pip install -r requirements-dev.txt
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run check` 包含 Node/Python 语法检查、ESLint、Stylelint、Ruff、Prettier 和 `node:test`。Playwright 使用只读 fixture server，不会写入生产配置。

## 许可证

[MIT](LICENSE)

如果这个项目对你有帮助，欢迎点一个 **Star**，也欢迎提交 Issue 或 Pull Request。
