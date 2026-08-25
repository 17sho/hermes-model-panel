#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${PANEL_UPDATE_REPO:-17sho/hermes-model-panel}"
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

json_status downloading "正在下载并验证 GitHub Release"
release_api="https://api.github.com/repos/${REPO}/releases/latest"
curl --fail --silent --show-error --location --max-time 30 \
  -H 'Accept: application/vnd.github+json' "$release_api" -o "$work/release.json"
readarray -t release_info < <(python3 - "$work/release.json" <<'PY'
import json, re, sys
release = json.load(open(sys.argv[1]))
tag = str(release.get("tag_name") or "")
if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
    raise SystemExit("invalid release tag")
assets = {str(x.get("name")): str(x.get("browser_download_url")) for x in release.get("assets", [])}
for name in ("hermes-model-panel.tar.gz", "SHA256SUMS"):
    if not assets.get(name):
        raise SystemExit(f"missing release asset: {name}")
print(tag)
print(assets["hermes-model-panel.tar.gz"])
print(assets["SHA256SUMS"])
PY
)
tag="${release_info[0]}"
archive_url="${release_info[1]}"
sums_url="${release_info[2]}"

ref_api="https://api.github.com/repos/${REPO}/git/ref/tags/${tag}"
curl --fail --silent --show-error --location --max-time 30 \
  -H 'Accept: application/vnd.github+json' "$ref_api" -o "$work/ref.json"
readarray -t ref_info < <(python3 - "$work/ref.json" <<'PY'
import json, sys
obj = json.load(open(sys.argv[1])).get("object") or {}
print(obj.get("type") or "")
print(obj.get("sha") or "")
print(obj.get("url") or "")
PY
)
if [[ "${ref_info[0]}" == "tag" ]]; then
  curl --fail --silent --show-error --location --max-time 30 \
    -H 'Accept: application/vnd.github+json' "${ref_info[2]}" -o "$work/tag.json"
  sha="$(python3 - "$work/tag.json" <<'PY'
import json, sys
print((json.load(open(sys.argv[1])).get("object") or {}).get("sha") or "")
PY
)"
else
  sha="${ref_info[1]}"
fi
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
if [[ -n "$EXPECTED_SHA" && "$sha" != "$EXPECTED_SHA" ]]; then
  json_status failed "Release 已变化，请重新检查后更新" "$sha"
  exit 1
fi

archive="$work/hermes-model-panel.tar.gz"
sums="$work/SHA256SUMS"
curl --fail --silent --show-error --location --max-time 120 "$archive_url" -o "$archive"
curl --fail --silent --show-error --location --max-time 30 "$sums_url" -o "$sums"
expected_hash="$(awk '$2 == "hermes-model-panel.tar.gz" || $2 == "*hermes-model-panel.tar.gz" {print $1; exit}' "$sums")"
[[ "$expected_hash" =~ ^[0-9a-fA-F]{64}$ ]]
printf '%s  %s\n' "$expected_hash" "$archive" | sha256sum --check --status

mkdir "$work/source"
tar -xzf "$archive" --strip-components=1 -C "$work/source"
[[ -f "$work/source/package.json" && -f "$work/source/server.js" ]]
release_version="${tag#v}"
python3 - "$work/source/package.json" "$release_version" <<'PY'
import json, sys
actual = str(json.load(open(sys.argv[1])).get("version") or "")
if actual != sys.argv[2]:
    raise SystemExit(f"release version mismatch: {actual}")
PY

json_status verifying "制品校验通过，正在安装依赖并执行检查" "$sha"
(
  cd "$work/source"
  npm ci --omit=dev --ignore-scripts
  node --check server.js
  node --check public/js/app.js
  python3 -m compileall -q scripts
)
printf '%s\n' "$sha" >"$work/source/.panel-version"
chmod 600 "$work/source/.panel-version"
find "$work/source" -type f -exec chmod go-w {} +
find "$work/source" -type d -exec chmod go-w {} +
chmod 755 "$work/source/scripts/update-panel.sh"

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
