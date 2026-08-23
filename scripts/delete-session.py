#!/usr/bin/env python3
import json
import sys
import time

from dbutil import immediate_transaction

db, session_id = sys.argv[1], sys.argv[2]


def delete_session(con):
    row = con.execute("SELECT id, session_key FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        raise ValueError("会话不存在")
    skey = row["session_key"] or ""
    delegate_ids = []
    queue = [session_id]
    while queue:
        parent = queue.pop()
        kids = con.execute("SELECT id, model_config FROM sessions WHERE parent_session_id=?", (parent,)).fetchall()
        for kid in kids:
            if "_delegate_from" in (kid["model_config"] or ""):
                delegate_ids.append(kid["id"])
                queue.append(kid["id"])
    for sid in reversed(delegate_ids):
        con.execute("DELETE FROM messages WHERE session_id=?", (sid,))
        con.execute("DELETE FROM sessions WHERE id=?", (sid,))
    con.execute("UPDATE sessions SET parent_session_id=NULL WHERE parent_session_id=?", (session_id,))
    con.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
    con.execute("DELETE FROM sessions WHERE id=?", (session_id,))
    cleared_route = False
    if skey:
        now = time.time()
        for r in con.execute("SELECT scope, session_key, entry_json FROM gateway_routing").fetchall():
            try:
                entry = json.loads(r["entry_json"] or "{}")
            except Exception:
                entry = {}
            if (r["session_key"] == skey or entry.get("session_key") == skey) and entry.get("session_id") == session_id:
                entry.pop("session_id", None)
                entry["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                con.execute(
                    "UPDATE gateway_routing SET entry_json=?, updated_at=? WHERE scope=? AND session_key=?",
                    (json.dumps(entry, ensure_ascii=False), now, r["scope"], r["session_key"]),
                )
                cleared_route = True
    return cleared_route


cleared_route = immediate_transaction(db, delete_session)
print(json.dumps({"ok": True, "session_id": session_id, "cleared_route": cleared_route}, ensure_ascii=False))
