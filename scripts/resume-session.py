#!/usr/bin/env python3
import json
import sqlite3
import sys
import time

db, session_id = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
row = con.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
if not row:
    print(json.dumps({"ok": False, "error": "会话不存在"}))
    sys.exit(1)

# climb to a platform session_key
src = row["source"] or ""
skey = row["session_key"] or ""
origin = row["origin_json"] or ""
sid = row["parent_session_id"]
depth = 0
while (not skey) and sid and depth < 8:
    p = con.execute(
        "SELECT source,session_key,origin_json,parent_session_id FROM sessions WHERE id=?",
        (sid,),
    ).fetchone()
    if not p:
        break
    src = src or (p["source"] or "")
    skey = skey or (p["session_key"] or "")
    origin = origin or (p["origin_json"] or "")
    sid = p["parent_session_id"]
    depth += 1

if not skey:
    print(json.dumps({"ok": False, "error": "这条会话没有绑定聊天对象，不能切回"}))
    sys.exit(1)

now = time.time()
# end other open sessions on the same key (except target)
con.execute(
    "UPDATE sessions SET ended_at=?, end_reason='session_switch' WHERE session_key=? AND id!=? AND ended_at IS NULL",
    (now, skey, session_id),
)
con.execute(
    "UPDATE sessions SET ended_at=NULL, end_reason=NULL WHERE id=?",
    (session_id,),
)

routes = con.execute("SELECT scope, session_key, entry_json FROM gateway_routing").fetchall()
updated = False
for r in routes:
    try:
        entry = json.loads(r["entry_json"] or "{}")
    except Exception:
        entry = {}
    if r["session_key"] != skey and entry.get("session_key") != skey:
        continue
    entry["session_id"] = session_id
    entry["session_key"] = skey
    entry["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    entry["suspended"] = False
    entry["resume_pending"] = False
    entry["is_fresh_reset"] = False
    con.execute(
        "UPDATE gateway_routing SET entry_json=?, updated_at=? WHERE scope=? AND session_key=?",
        (json.dumps(entry, ensure_ascii=False), now, r["scope"], r["session_key"]),
    )
    updated = True

if not updated:
    # create a routing row if missing
    scope = "/root/.hermes/sessions"
    try:
        scopes = con.execute("SELECT DISTINCT scope FROM gateway_routing").fetchall()
        if scopes:
            scope = scopes[0]["scope"]
    except Exception:
        pass
    entry = {
        "session_key": skey,
        "session_id": session_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "platform": src or "",
        "chat_type": row["chat_type"] or "",
        "suspended": False,
        "resume_pending": False,
        "is_fresh_reset": False,
    }
    con.execute(
        "INSERT OR REPLACE INTO gateway_routing(scope, session_key, entry_json, updated_at) VALUES (?,?,?,?)",
        (scope, skey, json.dumps(entry, ensure_ascii=False), now),
    )

con.commit()
print(json.dumps({"ok": True, "session_id": session_id, "session_key": skey}, ensure_ascii=False))
