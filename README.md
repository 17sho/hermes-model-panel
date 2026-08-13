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
| 聊天平台 | 按 agent 填 Telegram / 微信 / Discord 等，密钥不回显；可关掉某个平台 |
| 工作状态 | 独立页：干活 / 空闲 / 停了（干活时显示回谁、工作时间），可启停重启 Gateway |
| 选上下文 | 独立页：看未结束会话、切回、删上下文、给这条聊天换模型 |
| Agent 工具 | 独立页：按 agent 开/关基础能力（网页/终端/浏览器等），不列聊天平台 toolset |
| Skills | 独立页：按 agent 开/关已装 skill，可把 skill 归档删除 |
| 设置 | 改/开关面板密码；重启对应 Gateway |

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

默认只绑 **127.0.0.1:3010**。你是 SSH 上云服务器装的：服务器自己的浏览器一般没有，**笔记本/手机直接打开 `http://公网IP:3010/` 现在打不开**，这是正常的。

然后在面板里：

1. **添加中转站** → 地址 + Key → 获取模型 → 切给 agent
2. **聊天平台** → 给对应 agent 填 Token
3. **设置** → 重启对应 Gateway → 聊天里 `/reset`

## 云服务器怎么从外面打开（小白按这个做）

前提：面板已经装在 **VPS / 云主机** 上，你用 SSH 登录那台机器操作。家里电脑和服务器**不是**同一个 Wi-Fi，所以不要找 192.168。

装完默认只听 `127.0.0.1`，外网用 `http://公网IP:3010/` **一定打不开**，不是装坏了。

### 1）在服务器上确认服务活着

SSH 进那台机器：

```bash
hermes-model-panel
sudo systemctl status hermes-model-panel --no-pager
```

看到 running、以及 `http://127.0.0.1:3010/` 就对了。这一步只能证明**服务器内部**通了。

### 2）让进程听外网网卡

还在 SSH 里：

```bash
sudo nano /etc/hermes-model-panel.env
```

找到（没有就加一行）：

```
HOST=127.0.0.1
```

改成：

```
HOST=0.0.0.0
```

保存，然后：

```bash
sudo systemctl restart hermes-model-panel
hermes-model-panel
```

只改这一项，浏览器还是可能打不开——云厂商还有一层门。

### 3）云控制台安全组（这一步最容易漏）

打开你买服务器的网页后台（阿里云 / 腾讯云 / 华为云 / Lightsail / DigitalOcean / UpCloud …）：

1. 找到这台机器的 **安全组 / Firewall / Networking**
2. **入站 / Inbound** 增加一条：协议 TCP，端口 **3010**，来源先写你自己的家庭/公司 IP；实在不知道就 `0.0.0.0/0`（全世界都能扫到这个端口）
3. 保存。有的商家还要「应用到实例」

只改服务器里的 env、不改安全组，外网永远进不来。

### 4）服务器自己的防火墙

有的镜像还开了 ufw / firewalld。SSH 里：

```bash
# ufw
sudo ufw allow 3010/tcp
sudo ufw reload
sudo ufw status

# 或 firewalld
sudo firewall-cmd --add-port=3010/tcp --permanent
sudo firewall-cmd --reload
```

没装这些命令就跳过。

### 5）用公网 IP 打开

在**你自己的电脑或手机浏览器**（不要在服务器里找浏览器）打开：

`http://你的公网IP:3010/`

公网 IP 在云控制台「实例详情」里，或 SSH 里：

```bash
curl -4 -s ifconfig.me; echo
```

必须是 **http**（不是 https），端口是 **3010**。  
这时面板是裸奔的，**务必**再改同一个 env：

```
AUTH_DISABLED=0
ADMIN_PASSWORD=自己设一个够长的密码
```

```bash
sudo systemctl restart hermes-model-panel
```

密码不会打印到屏幕上。

### 6）有域名（推荐，以后再做也行）

不要长期把 3010 直接挂在公网上。解析 A 记录到这台机器，用 Caddy / Nginx 反代到 `127.0.0.1:3010`，浏览器走 `https://你的域名`。示例：`caddy/model.example.com.caddy`。反代配好后，`HOST` 可以改回 `127.0.0.1`，安全组只放行 80/443。

### 打不开时先看这几条

| 现象 | 多半是 |
| --- | --- |
| `http://公网IP:3010/` 一直转圈 / 超时 | 安全组没放行 3010，或 `HOST` 还是 127.0.0.1 |
| 改了 HOST 还超时 | 只改了 env，云控制台安全组没保存 |
| 连接被拒绝 | 服务没起来：`sudo systemctl status hermes-model-panel` |
| 能打开但谁都能进、没登录 | 没设 `AUTH_DISABLED=0` |
| 用了 https:// 打不开 | 直连端口只有 http |
| 国内访问国外 VPS 超时 | 线路问题，和面板无关；可先用手机流量试 |

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
