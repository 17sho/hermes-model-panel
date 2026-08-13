# Hermes 模型面板

[English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-6f8cff.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Hermes](https://img.shields.io/badge/requires-Hermes%20Agent-0e1016)](https://github.com/NousResearch/hermes-agent)

给**已经装好** [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的机器用的深色小面板：加 OpenAI 兼容中转、按 agent 选模型、给对应 agent 接聊天平台（Telegram / 微信 / Discord 等）。

**不是** Hermes 安装器。clone + `install.sh` 只把面板跑起来。要聊天还得有 Hermes、中转 Key，接平台还要 Bot Token。

<p align="center">
  <img src="docs/images/panel-models.png" alt="当前模型" width="720">
</p>
<p align="center">
  <img src="docs/images/panel-platforms.png" alt="聊天平台" width="720">
</p>

## 能干什么

| 区块 | 作用 |
| --- | --- |
| 当前模型 | 列出扫到的每个 agent、当前模型和中转 |
| 中转站 | 加 OpenAI 兼容地址，拉模型，按 agent 切换 |
| 生图模型 | 从同一批中转里选生图模型 |
| 聊天平台 | 按 agent 填 Telegram / 微信 / Discord 等，密钥不回显 |
| 设置 | 重启对应 Gateway，改完才进线 |

agent 只在打开页面或点刷新时扫，不定时后台扫。

## 协议

MIT，以根目录 `LICENSE` 为准。可使用、修改、再分发，保留版权声明即可。

## 前置

- Linux（建议 systemd）
- Node.js 18+ 和 npm
- 本机已有 Hermes（存在 `~/.hermes/config.yaml`）
- 要进线聊天：对应 `hermes-gateway` 能跑
- 至少一家中转 API Key（面板变不出额度）
- 要接聊天平台：Bot Token / 微信凭据等

## 一键安装（机器已有 Hermes）

```bash
git clone https://github.com/17sho/hermes-model-panel.git
cd hermes-model-panel
sudo bash install.sh
```

脚本会：

1. 找不到 Hermes 配置就停并提示
2. 拷到 `/opt/hermes-model-panel`（可用 `DEST=` 改）
3. `npm ci --omit=dev`
4. 没有才写 `/etc/hermes-model-panel.env`（不覆盖已有）
5. 安装并启动 `hermes-model-panel.service`
6. 探测 `http://127.0.0.1:3010/`
7. 安装命令 `hermes-model-panel`

打开面板：

```bash
hermes-model-panel          # 打印监听地址和怎么开
```

默认只绑 **127.0.0.1:3010**，本机浏览器打开 `http://127.0.0.1:3010/`。  
别的设备用 `http://服务器IP:3010/` **打不开**。要局域网访问：在 `/etc/hermes-model-panel.env` 设 `HOST=0.0.0.0`，再 `sudo systemctl restart hermes-model-panel`，然后用 `http://那台机器的IP:3010/`。有域名就走反代。

然后在面板里：

1. **添加中转站** → 地址 + Key → 获取模型 → 切给 agent
2. **聊天平台** → 给对应 agent 填 Token
3. **设置** → 重启对应 Gateway → 聊天里 `/reset`

公网直出、没有反代：在 env 里设 `AUTH_DISABLED=0` 和 `ADMIN_PASSWORD`。脚本不打印密码。

## 手动跑

```bash
cp samples/hermes-model-panel.env.example hermes-model-panel.env
# 改配置
npm ci --omit=dev
node server.js
```

常用变量：`PORT`、`HOST`、`HERMES_CONFIG`、`HERMES_HOME`、`AUTH_DISABLED`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`AUTH_LOGIN_URL`。

Caddy 示例：`caddy/model.example.com.caddy`。

## 怎么扫 agent

- `~/.hermes/config.yaml` → 1 个默认 agent
- `~/.hermes/profiles/<名>/config.yaml` → 再加一个

10 个 profile 就 10 张卡。平台凭据写在该 agent 自己的 `.env`，界面不回显全文。

## 隐私

公开仓库不含线上 Key、Bot Token、生产域名。不要提交自己的 env。

觉得有用的话，欢迎点个 Star。
