#!/usr/bin/env python3
import json
import sys
import time

from dbutil import immediate_transaction

db, session_id = sys.argv[1], sys.argv[2]


def transact(con):
    row = con.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        raise ValueError("会话不存在")
    src, skey, origin = row["source"] or "", row["session_key"] or "", row["origin_json"] or ""
    sid = row["parent_session_id"]
    seen = set()
    while not skey and sid and sid not in seen:
        seen.add(sid)
        parent = con.execute(
            "SELECT source,session_key,origin_json,parent_session_id FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if not parent:
            break
        src = src or (parent["source"] or "")
        skey = skey or (parent["session_key"] or "")
        origin = origin or (parent["origin_json"] or "")
        sid = parent["parent_session_id"]
    if not skey:
        raise ValueError("这条会话没有绑定聊天对象，不能切回")
    now = time.time()
    con.execute(
        "UPDATE sessions SET ended_at=?, end_reason='session_switch' WHERE session_key=? AND id!=? AND ended_at IS NULL",
        (now, skey, session_id),
    )
    con.execute("UPDATE sessions SET ended_at=NULL, end_reason=NULL WHERE id=?", (session_id,))
    updated = False
    for route in con.execute("SELECT scope, session_key, entry_json FROM gateway_routing").fetchall():
        try:
            entry = json.loads(route["entry_json"] or "{}")
        except Exception:
            entry = {}
        if route["session_key"] != skey and entry.get("session_key") != skey:
            continue
        entry.update(
            {
                "session_id": session_id,
                "session_key": skey,
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "suspended": False,
                "resume_pending": False,
                "is_fresh_reset": False,
            }
        )
        con.execute(
            "UPDATE gateway_routing SET entry_json=?, updated_at=? WHERE scope=? AND session_key=?",
            (json.dumps(entry, ensure_ascii=False), now, route["scope"], route["session_key"]),
        )
        updated = True
    if not updated:
        scope_row = con.execute("SELECT scope FROM gateway_routing LIMIT 1").fetchone()
        scope = scope_row["scope"] if scope_row else "/root/.hermes/sessions"
        entry = {
            "session_key": skey,
            "session_id": session_id,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "platform": src,
            "chat_type": row["chat_type"] or "",
            "suspended": False,
            "resume_pending": False,
            "is_fresh_reset": False,
        }
        con.execute(
            "INSERT OR REPLACE INTO gateway_routing(scope, session_key, entry_json, updated_at) VALUES (?,?,?,?)",
            (scope, skey, json.dumps(entry, ensure_ascii=False), now),
        )
    return skey


session_key = immediate_transaction(db, transact)

print(json.dumps({"ok": True, "session_id": session_id, "session_key": session_key}, ensure_ascii=False))
