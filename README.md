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

## 怎么给外部访问（小白按这个做）

装完**默认只能本机开**。手机、另一台电脑、公网 IP **打不开**，这是正常的，不是装坏了。

### 1）先确认本机已经起来

在装面板的那台机器上：

```bash
hermes-model-panel
```

看到「本机浏览器打开 http://127.0.0.1:3010/」就对了。先在这台机器自己的浏览器试一下。

### 2）改成局域网 / IP:端口 能打开

还是在那台机器上：

```bash
sudo nano /etc/hermes-model-panel.env
```

找到（没有就自己加一行）：

```
HOST=127.0.0.1
```

改成：

```
HOST=0.0.0.0
```

保存退出，然后：

```bash
sudo systemctl restart hermes-model-panel
hermes-model-panel
```

命令会打印类似 `http://192.168.x.x:3010/` 的地址。手机和电脑要跟服务器在**同一个 Wi-Fi / 内网**，浏览器打开那一行。

云服务器还要在商家控制台给 **3010/tcp** 加安全组 / 防火墙放行，例如：

```bash
sudo ufw allow 3010/tcp
sudo ufw reload
```

（没装 ufw 就按你用的防火墙来，阿里云/腾讯云还要在网页安全组里放行。）

### 3）公网用 IP:3010 直开（不推荐，但能用）

上面改完 `HOST=0.0.0.0` 并且安全组放行后，外网浏览器打开：

`http://你的公网IP:3010/`

这时面板是裸奔的。**务必**再改同一个 env：

```
AUTH_DISABLED=0
ADMIN_PASSWORD=自己设一个够长的密码
```

再执行：

```bash
sudo systemctl restart hermes-model-panel
```

脚本**不会**在屏幕上打印密码。

### 4）有域名（推荐）

不要把 3010 直接暴露到公网。用 Caddy / Nginx 反代到 `127.0.0.1:3010`，浏览器走 `https://你的域名`。仓库里有一份示例：`caddy/model.example.com.caddy`。这时 `HOST` 可以继续留 `127.0.0.1`。

### 打不开时先看这几条

| 现象 | 多半是 |
| --- | --- |
| 只有本机能开，别人 IP:3010 不行 | 还是 `HOST=127.0.0.1`，没改或没重启 |
| 改了还是不行 | 云安全组 / ufw 没放行 3010 |
| 能开网页但空白 / 连不上 | `sudo systemctl status hermes-model-panel` |
| 公网谁都能进、没有登录 | 没设 `AUTH_DISABLED=0` |

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
