#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${PANEL_INSTALL_DIR:-/opt/hermes-model-panel}"
SERVICE="${PANEL_SERVICE:-hermes-model-panel.service}"
STATE_DIR="${PANEL_UPDATE_STATE_DIR:-/var/lib/hermes-model-panel}"
STATE_FILE="$STATE_DIR/update-status.json"
LOCK_FILE="${PANEL_UPDATE_LOCK_FILE:-/run/hermes-model-panel-update.lock}"
TARGET="${1:-}"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '{"state":"failed","operation":"rollback","message":"已有更新或回滚任务正在运行"}\n' >"$STATE_FILE"
  exit 1
fi

json_status() {
  local state="$1" message="$2" version="${3:-}" sha="${4:-}"
  python3 - "$STATE_FILE" "$state" "$message" "$version" "$sha" <<'PY'
import json, os, sys, tempfile, time
path, state, message, version, sha = sys.argv[1:]
data = {"state": state, "operation": "rollback", "message": message, "version": version, "sha": sha, "updated_at": int(time.time())}
fd, tmp = tempfile.mkstemp(prefix=".rollback-", dir=os.path.dirname(path))
with os.fdopen(fd, "w") as f:
    json.dump(data, f, ensure_ascii=False)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
}

base="$(basename "$INSTALL_DIR")"
parent="$(dirname "$INSTALL_DIR")"
case "$TARGET" in
  "$parent/$base.rollback-"*) ;;
  *) json_status failed "回滚目标无效"; exit 1 ;;
esac
[[ -d "$TARGET" && -f "$TARGET/package.json" && -f "$TARGET/server.js" ]] || { json_status failed "回滚版本不存在或不完整"; exit 1; }

version="$(node -p "require(process.argv[1]).version" "$TARGET/package.json")"
sha="$(tr -d '\r\n' <"$TARGET/.panel-version" 2>/dev/null || true)"
[[ "$version" =~ ^[0-9A-Za-z.+-]+$ ]] || { json_status failed "回滚版本号无效"; exit 1; }
[[ -z "$sha" || "$sha" =~ ^[0-9a-f]{40}$ ]] || { json_status failed "回滚版本标识无效"; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
failed="${INSTALL_DIR}.failed-${stamp}"
json_status rolling_back "正在切换到 v${version}" "$version" "$sha"
mv "$INSTALL_DIR" "$failed"
if ! mv "$TARGET" "$INSTALL_DIR"; then
  mv "$failed" "$INSTALL_DIR"
  json_status failed "无法切换回滚版本" "$version" "$sha"
  exit 1
fi

restore_current() {
  rm -rf "$INSTALL_DIR"
  mv "$failed" "$INSTALL_DIR"
  systemctl restart "$SERVICE" || true
}

if ! systemctl restart "$SERVICE"; then
  restore_current
  json_status failed "回滚版本启动失败，已恢复原版本" "$version" "$sha"
  exit 1
fi

for _ in $(seq 1 30); do
  if health="$(curl --fail --silent --show-error --max-time 2 http://127.0.0.1:${PORT:-3010}/api/health 2>/dev/null)" \
    && python3 - "$version" "$health" <<'PY'
import json, sys
expected, raw = sys.argv[1:]
data = json.loads(raw)
raise SystemExit(0 if data.get("ok") is True and str(data.get("version")) == expected else 1)
PY
  then
    mv "$failed" "${INSTALL_DIR}.rollback-${stamp}"
    find "$parent" -maxdepth 1 -type d -name "$base.rollback-*" -printf '%T@ %p\n' \
      | sort -rn | awk 'NR>2 {sub(/^[^ ]+ /, ""); print}' | xargs -r rm -rf
    json_status success "已回滚到 v${version}" "$version" "$sha"
    exit 0
  fi
  sleep 1
done

restore_current
json_status failed "回滚版本健康检查失败，已恢复原版本" "$version" "$sha"
exit 1
