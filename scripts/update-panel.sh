#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${PANEL_UPDATE_REPO:-17sho/hermes-model-panel}"
BRANCH="${PANEL_UPDATE_BRANCH:-main}"
INSTALL_DIR="${PANEL_INSTALL_DIR:-/opt/hermes-model-panel}"
SERVICE="${PANEL_SERVICE:-hermes-model-panel.service}"
STATE_DIR="${PANEL_UPDATE_STATE_DIR:-/var/lib/hermes-model-panel}"
STATE_FILE="$STATE_DIR/update-status.json"
LOCK_FILE="${PANEL_UPDATE_LOCK_FILE:-/run/hermes-model-panel-update.lock}"
EXPECTED_SHA="${1:-}"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '{"state":"failed","message":"已有更新任务正在运行"}\n' >"$STATE_FILE"
  exit 1
fi

json_status() {
  local state="$1" message="$2" sha="${3:-}"
  python3 - "$STATE_FILE" "$state" "$message" "$sha" <<'PY'
import json, os, sys, tempfile, time
path, state, message, sha = sys.argv[1:]
data = {"state": state, "message": message, "sha": sha, "updated_at": int(time.time())}
fd, tmp = tempfile.mkstemp(prefix=".update-", dir=os.path.dirname(path))
with os.fdopen(fd, "w") as f:
    json.dump(data, f, ensure_ascii=False)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
}

work="$(mktemp -d /tmp/hermes-model-panel-update.XXXXXX)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
trap 'json_status failed "更新失败（第 ${LINENO} 行）" "${sha:-}"' ERR

json_status downloading "正在下载 GitHub 更新"
api="https://api.github.com/repos/${REPO}/commits/${BRANCH}"
sha="$(curl --fail --silent --show-error --location --max-time 30 \
  -H 'Accept: application/vnd.github+json' "$api" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
if [[ -n "$EXPECTED_SHA" && "$sha" != "$EXPECTED_SHA" ]]; then
  json_status failed "远端版本已变化，请重新检查后更新" "$sha"
  exit 1
fi

archive="$work/source.tar.gz"
curl --fail --silent --show-error --location --max-time 120 \
  "https://github.com/${REPO}/archive/${sha}.tar.gz" -o "$archive"
mkdir "$work/source"
tar -xzf "$archive" --strip-components=1 -C "$work/source"
[[ -f "$work/source/package.json" && -f "$work/source/server.js" ]]

json_status verifying "正在安装依赖并执行检查" "$sha"
(
  cd "$work/source"
  npm ci --omit=dev --ignore-scripts
  node --check server.js
  node --check public/js/app.js
  python3 -m compileall -q scripts
)
printf '%s\n' "$sha" >"$work/source/.panel-version"
chmod 600 "$work/source/.panel-version"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${INSTALL_DIR}.rollback-${stamp}"
json_status installing "正在安装，随后会自动重启面板" "$sha"
if [[ -e "$INSTALL_DIR" ]]; then mv "$INSTALL_DIR" "$backup"; fi
if ! mv "$work/source" "$INSTALL_DIR"; then
  [[ -e "$backup" ]] && mv "$backup" "$INSTALL_DIR"
  exit 1
fi

if ! systemctl restart "$SERVICE"; then
  rm -rf "$INSTALL_DIR"
  [[ -e "$backup" ]] && mv "$backup" "$INSTALL_DIR"
  systemctl restart "$SERVICE" || true
  json_status failed "新版本启动失败，已回滚" "$sha"
  exit 1
fi

for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$SERVICE"; then
    json_status success "更新成功" "$sha"
    find "$(dirname "$INSTALL_DIR")" -maxdepth 1 -type d -name "$(basename "$INSTALL_DIR").rollback-*" -printf '%T@ %p\n' \
      | sort -rn | awk 'NR>2 {sub(/^[^ ]+ /, ""); print}' | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done

rm -rf "$INSTALL_DIR"
[[ -e "$backup" ]] && mv "$backup" "$INSTALL_DIR"
systemctl restart "$SERVICE" || true
json_status failed "新版本未能正常启动，已回滚" "$sha"
exit 1
