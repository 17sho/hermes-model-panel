#!/usr/bin/env python3
import json
import sqlite3
import sys
import time

db, session_id = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
row = con.execute("SELECT id, session_key FROM sessions WHERE id=?", (session_id,)).fetchone()
if not row:
    print(json.dumps({"ok": False, "error": "会话不存在"}))
    sys.exit(1)

skey = row["session_key"] or ""
# cascade only delegate children (same rule as hermes_state.delete_session)
kids = con.execute(
    "SELECT id, model_config FROM sessions WHERE parent_session_id=?",
    (session_id,),
).fetchall()
delegate_ids = []
for k in kids:
    cfg = k["model_config"] or ""
    if "_delegate_from" in cfg:
        delegate_ids.append(k["id"])

def wipe(sid):
    con.execute("DELETE FROM messages WHERE session_id=?", (sid,))
    con.execute("DELETE FROM sessions WHERE id=?", (sid,))

for did in delegate_ids:
    wipe(did)

con.execute("UPDATE sessions SET parent_session_id=NULL WHERE parent_session_id=?", (session_id,))
wipe(session_id)

cleared_route = False
if skey:
    routes = con.execute("SELECT scope, session_key, entry_json FROM gateway_routing").fetchall()
    now = time.time()
    for r in routes:
        try:
            entry = json.loads(r["entry_json"] or "{}")
        except Exception:
            entry = {}
        if r["session_key"] != skey and entry.get("session_key") != skey:
            continue
        if entry.get("session_id") != session_id:
            continue
        entry.pop("session_id", None)
        entry["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        con.execute(
            "UPDATE gateway_routing SET entry_json=?, updated_at=? WHERE scope=? AND session_key=?",
            (json.dumps(entry, ensure_ascii=False), now, r["scope"], r["session_key"]),
        )
        cleared_route = True

con.commit()
print(json.dumps({"ok": True, "session_id": session_id, "cleared_route": cleared_route}, ensure_ascii=False))
