1|# Hermes Model Panel
2|
3|[![版本](https://img.shields.io/badge/version-v1.3.18-6f8cff)](https://github.com/17sho/hermes-model-panel/releases)
4|[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](package.json)
5|[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
6|[![Hermes Agent](https://img.shields.io/badge/for-Hermes%20Agent-111827)](https://github.com/NousResearch/hermes-agent)
7|
8|**中文** · [English](README.en.md)
9|
10|为已经安装好的 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 提供一个中文可视化管理台：管理模型与中转站、Agent/Profile、聊天平台、Skills、工具、会话和 Gateway 状态。
11|
12|> 面板不会替你安装 Hermes，也不会提供 API Key 或 Bot Token。请先安装并配置 Hermes Agent。
13|
14|![模型与 Agent 管理](docs/images/panel-models.png)
15|
16|## 功能
17|
18|| 模块 | 能力 |
19|| --------------- | ---------------------------------------------------------- |
20|| 模型与中转站 | 添加兼容中转、获取模型、切换和测试，并按中转站授权私网访问 |
21|| Agent / Profile | 新建和删除 Profile、独立配置模型与服务 |
22|| 聊天平台 | 管理 Telegram、微信、Discord、WhatsApp、Slack、飞书 |
23|| 工具与 Skills | 按 Agent 查看和切换工具包、管理 Skills |
24|| 会话与上下文 | 查看工作状态、选择历史上下文、生成快捷命令 |
25|| Gateway | 查看状态和原始日志、安装、启动、停止或重启服务 |
26|| 安全 | 服务端登录、Session Cookie、CSRF 校验、原子配置写入 |
27|| 在线更新 | 检查 GitHub 新版本、后台安装、失败自动回滚 |
28|| 响应式界面 | 桌面常驻侧栏、移动抽屉、日间/夜间主题 |
29|
30|<p align="center">
31| <img src="docs/images/panel-platforms.png" width="49%" alt="聊天平台管理">
32| <img src="docs/images/panel-tools.png" width="49%" alt="Agent 工具管理">
33|</p>
34|
35|## 快速安装
36|
37|### 前提
38|
39|- Linux + systemd
40|- 已安装 Hermes Agent，并存在 `~/.hermes/config.yaml`
41|- Node.js 20+、npm、rsync、OpenSSL
42|- root 或 sudo 权限
43|
44|`bash
45|git clone https://github.com/17sho/hermes-model-panel.git
46|cd hermes-model-panel
47|sudo bash install.sh
48|`
49|
50|安装脚本会：
51|
52|1. 检查 Hermes 配置；
53|2. 安装到 `/opt/hermes-model-panel`；
54|3. 安装生产依赖；
55|4. 首次生成 `/etc/hermes-model-panel.env`；
56|5. 安装并启动 `hermes-model-panel.service`；
57|6. 输出本机打开地址。
58|
59|默认仅监听 `127.0.0.1:3010`。局域网访问需要显式执行：
60|
61|`bash
62|sudo HOST=0.0.0.0 AUTH_DISABLED=0 bash install.sh
63|sudo ufw allow from 192.168.0.0/16 to any port 3010 proto tcp
64|`
65|
66|公网访问请保持密码登录，使用 Caddy/Nginx 提供 HTTPS，不要把无密码面板直接暴露到公网。
67|
68|## 手动运行
69|
70|`bash
71|npm ci
72|npm start
73|`
74|
75|生产环境示例见：
76|
77|- [`samples/hermes-model-panel.env.example`](samples/hermes-model-panel.env.example)
78|- [`systemd/hermes-model-panel.service`](systemd/hermes-model-panel.service)
79|- [`caddy/hermes-model-panel.caddy.example`](caddy/hermes-model-panel.caddy.example)
80|
81|## 在线更新
82|
83|首次部署 v1.1.0 后，可在 **设置 → 面板在线更新** 检查 GitHub `main` 分支。更新器锁定目标提交 SHA，在临时目录安装依赖并检查代码，然后替换程序目录并重启；启动失败会恢复上一版。
84|
85|更新只替换代码，不覆盖：
86|
87|- `/etc/hermes-model-panel.env`
88|- Hermes 配置和 Profiles
89|- Session 数据库
90|- 面板元数据及凭据
91|
92|> 当前在线更新以 GitHub 提交 SHA 为目标。正式公网环境建议只从审查后的稳定版本更新。
93|
94|## 安全说明
95|
96|- 服务默认只监听 `127.0.0.1`。
97|- 公网部署必须设置强管理密码和持久的 `SESSION_SECRET`。
98|- 密钥不会在管理页面重新明文显示。
99|- 写入 Hermes YAML 前会创建 `.bak-*` 备份，并保留最近 10 份。
100|- 当前 systemd 服务仍使用 root，以兼容 Hermes 配置、Profile、日志和服务管理；迁移专用用户前必须逐项验证实际权限。
101|
102|不要提交真实 `.env`、API Key、Bot Token、Cookie、数据库或生产配置。
103|
104|## 开发与测试
105|
106|`bash
107|npm ci
108|python3 -m pip install -r requirements-dev.txt
109|npm run check
110|npx playwright install chromium
111|npm run test:e2e
112|`
113|
114|`npm run check` 包含 Node/Python 语法检查、ESLint、Stylelint、Ruff、Prettier 和 `node:test`。Playwright 使用只读 fixture server，不会写入生产配置。
115|
116|## 许可证
117|
118|[MIT](LICENSE)
119|
120|如果这个项目对你有帮助，欢迎点一个 **Star**，也欢迎提交 Issue 或 Pull Request。
121|
