#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ACTION="${1:-}"
STATE="${HERMES_MAINTENANCE_STATE:-/var/lib/hermes-model-panel/hermes-maintenance-status.json}"
HERMES_BIN="${HERMES_BIN:-hermes}"
BACKUP_ROOT="${HERMES_BACKUP_ROOT:-/var/lib/hermes-model-panel/hermes-backups}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$(dirname "$STATE")" "$BACKUP_ROOT"
LOGS=()

redact() { sed -E 's/((api[_-]?key|token|secret|password|authorization)[[:space:]]*[:=][[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig; s/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/-]+/\1[REDACTED]/Ig'; }
write_state() {
  local state="$1" message="$2" backup="${3:-}" logfile="${4:-}"
  STATE_VALUE="$state" MESSAGE_VALUE="$message" BACKUP_VALUE="$backup" LOGFILE_VALUE="$logfile" python3 - "$STATE" <<'PY'
import json,os,sys,tempfile,time
p=sys.argv[1]
logs=[]
logfile=os.environ.get('LOGFILE_VALUE','')
if logfile:
 try:
  with open(logfile,encoding='utf-8',errors='replace') as f: logs=f.read().splitlines()[-200:]
 except OSError: pass
obj={'state':os.environ['STATE_VALUE'],'operation':os.environ.get('ACTION_VALUE',''),'message':os.environ['MESSAGE_VALUE'],'backup':os.environ.get('BACKUP_VALUE',''),'updated_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'logs':logs}
os.makedirs(os.path.dirname(p),exist_ok=True)
fd,tmp=tempfile.mkstemp(prefix='.maintenance-',dir=os.path.dirname(p));os.close(fd)
with open(tmp,'w',encoding='utf-8') as f: json.dump(obj,f,ensure_ascii=False,indent=2);f.write('\n')
os.chmod(tmp,0o600);os.replace(tmp,p)
PY
}
export ACTION_VALUE="$ACTION"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOGFILE="$(mktemp /tmp/hermes-maintenance.XXXXXX.log)"
trap 'rm -f "$LOGFILE"' EXIT
fail() { local code=$?; printf '任务失败（退出码 %s）\n' "$code" >>"$LOGFILE"; write_state failed "维护任务失败，请查看原始日志" "${BACKUP:-}" "$LOGFILE"; exit "$code"; }
trap fail ERR

case "$ACTION" in
  backup)
    write_state running "正在创建配置备份" "" "$LOGFILE"
    BACKUP="$BACKUP_ROOT/hermes-$STAMP.tar.gz"
    items=()
    [[ -d "$HERMES_HOME" ]] && items+=("$HERMES_HOME")
    [[ -f /etc/systemd/system/hermes-gateway.service ]] && items+=(/etc/systemd/system/hermes-gateway.service)
    while IFS= read -r -d '' unit; do items+=("$unit"); done < <(find /etc/systemd/system -maxdepth 1 -type f -name 'hermes-gateway-*.service' -print0 2>/dev/null || true)
    ((${#items[@]})) || { echo '没有找到可备份的 Hermes 数据' >>"$LOGFILE"; false; }
    tar --ignore-failed-read -czf "$BACKUP" --absolute-names "${items[@]}" 2>>"$LOGFILE"
    chmod 600 "$BACKUP"
    printf '备份已创建：%s\n' "$BACKUP" >>"$LOGFILE"
    write_state success "备份已创建" "$BACKUP" "$LOGFILE"
    ;;
  health)
    write_state running "正在运行只读健康检查" "" "$LOGFILE"
    { "$HERMES_BIN" config check; "$HERMES_BIN" doctor; "$HERMES_BIN" status --all; } 2>&1 | redact >"$LOGFILE"
    write_state success "健康检查完成" "" "$LOGFILE"
    ;;
  update)
    write_state running "正在升级 Hermes（官方升级器会先备份）" "" "$LOGFILE"
    "$HERMES_BIN" update --backup --yes 2>&1 | redact >"$LOGFILE"
    "$HERMES_BIN" config migrate 2>&1 | redact >>"$LOGFILE"
    "$HERMES_BIN" config check 2>&1 | redact >>"$LOGFILE"
    "$HERMES_BIN" doctor 2>&1 | redact >>"$LOGFILE"
    "$HERMES_BIN" status --all 2>&1 | redact >>"$LOGFILE"
    "$HERMES_BIN" --version 2>&1 | redact >>"$LOGFILE"
    write_state success "Hermes升级并验证完成" "" "$LOGFILE"
    ;;
  *) echo "unsupported action" >&2; exit 2 ;;
esac
