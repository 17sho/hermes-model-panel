#!/usr/bin/env bash
# 给「已经装好 Hermes」的机器装模型面板。
# 不是 Hermes 安装器，也不在这里创建 agent / 写 Bot Token。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${DEST:-/opt/hermes-model-panel}"
ENV_OUT="${ENV_OUT:-/etc/hermes-model-panel.env}"
UNIT_OUT="${UNIT_OUT:-/etc/systemd/system/hermes-model-panel.service}"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
HERMES_CONFIG="${HERMES_CONFIG:-${HERMES_HOME}/config.yaml}"
PORT="${PORT:-3010}"
HOST="${HOST:-127.0.0.1}"
AUTH_DISABLED="${AUTH_DISABLED:-0}"

die() { echo "错误: $*" >&2; exit 1; }
ok() { echo "✓ $*"; }

if [[ "$AUTH_DISABLED" = "1" && "$HOST" != "127.0.0.1" && "$HOST" != "::1" && "$HOST" != "localhost" ]]; then
  die "关闭认证时 HOST 必须是 loopback；拒绝创建匿名公网管理面。"
fi

echo "== Hermes 模型面板安装 =="

command -v node >/dev/null 2>&1 || die "没有 node。先装 Node.js，再跑本脚本。"
NODE_BIN="$(command -v node)"
ok "node: $NODE_BIN ($("$NODE_BIN" -v))"

if [[ ! -f "$HERMES_CONFIG" ]]; then
  cat <<EOF
没有检测到 Hermes 配置：$HERMES_CONFIG

本脚本只装「模型面板」，不会帮你装 Hermes，也不会凭空变出 API Key / Bot Token。
请先按官方装好 Hermes（至少要有 ~/.hermes/config.yaml），再重新执行：
  bash install.sh
EOF
  exit 2
fi
ok "已找到 Hermes：$HERMES_CONFIG"

if ! command -v hermes >/dev/null 2>&1; then
  echo "提示: 找不到 hermes 命令。面板仍可改 yaml / 加中转，但 Gateway 重启、部分 CLI 功能会不可用。"
else
  ok "hermes: $(command -v hermes)"
fi

if command -v npm >/dev/null 2>&1; then
  NPM_BIN="$(command -v npm)"
else
  die "没有 npm，无法安装依赖。"
fi

mkdir -p "$DEST"
rsync -a --delete \
  --exclude node_modules \
  --exclude '*.bak*' \
  --exclude '.git' \
  --exclude 'samples' \
  --exclude 'systemd' \
  --exclude 'install.sh' \
  --exclude 'README.md' \
  "$SRC/" "$DEST/"
ok "代码已放到 $DEST"

(
  cd "$DEST"
  "$NPM_BIN" ci --omit=dev
)
ok "依赖已安装"

if [[ ! -f "$ENV_OUT" ]]; then
  SESSION_SECRET="$(openssl rand -base64 32 | tr -d '\n')"
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=\n' | head -c 20)"
  umask 077
  cat >"$ENV_OUT" <<EOF
PORT=${PORT}
HOST=${HOST}
HERMES_CONFIG=${HERMES_CONFIG}
HERMES_HOME=${HERMES_HOME}
PANEL_META_PATH=${HERMES_HOME}/model-panel-meta.json
ENV_FILE=${ENV_OUT}
AUTH_DISABLED=${AUTH_DISABLED}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
COOKIE_PATH=/
PUBLIC_ORIGIN=${PUBLIC_ORIGIN:-}
COOKIE_SECURE=${COOKIE_SECURE:-0}
EOF
  chmod 600 "$ENV_OUT"
  ok "已生成 $ENV_OUT"
  if [[ "$AUTH_DISABLED" = "0" ]]; then
    echo "面板密码已写入 $ENV_OUT 的 ADMIN_PASSWORD（本脚本不打印）。"
  fi
else
  ok "沿用已有 $ENV_OUT（不覆盖）"
fi

NODE_ESC="${NODE_BIN//\//\\/}"
DEST_ESC="${DEST//\//\\/}"
ENV_ESC="${ENV_OUT//\//\\/}"
sed \
  -e "s|/usr/bin/node|${NODE_BIN}|g" \
  -e "s|/opt/hermes-model-panel|${DEST}|g" \
  -e "s|/etc/hermes-model-panel.env|${ENV_OUT}|g" \
  "$SRC/systemd/hermes-model-panel.service" >"$UNIT_OUT"
# sed above uses literal paths; rewrite if dest/env differ via python for safety
python3 - <<PY
from pathlib import Path
p = Path("$UNIT_OUT")
t = Path("$SRC/systemd/hermes-model-panel.service").read_text()
t = t.replace("/usr/bin/node", "$NODE_BIN")
t = t.replace("/opt/hermes-model-panel", "$DEST")
t = t.replace("/etc/hermes-model-panel.env", "$ENV_OUT")
p.write_text(t)
print("unit written")
PY
ok "已写入 $UNIT_OUT"

systemctl daemon-reload
systemctl enable --now hermes-model-panel
sleep 1
systemctl is-active hermes-model-panel >/dev/null || {
  journalctl -u hermes-model-panel -n 30 --no-pager || true
  die "服务没起来"
}
ok "hermes-model-panel 已 active"

code="$(curl -sS -o /tmp/hmp-health.body -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/api/health" || true)"
if [[ "$code" != "200" ]]; then
  code="$(curl -sS -o /tmp/hmp-health.body -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/" || true)"
fi
[[ "$code" == "200" ]] || die "本机探测失败 HTTP $code。看 journalctl -u hermes-model-panel"
ok "本机 HTTP $code  http://127.0.0.1:${PORT}/"

cat <<EOF

装好了。接下来在面板里补齐就能聊（脚本不会替你填 Key）：

1. 打开面板（本机 ${HOST}:${PORT}；有反代就走你的域名）
2. 「添加中转站」填地址 + API Key → 「获取」模型 → 切给 agent
3. 「聊天平台」给对应 agent 填 Bot Token / 微信等
4. 设置里重启对应 Gateway，聊天里 /reset

做不到的：没装 Hermes、没 Bot、没有任何中转 Key，只跑本脚本就能开聊。
也不在这里创建新 agent / 写 systemd gateway。
EOF
