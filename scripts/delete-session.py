#!/usr/bin/env python3
import json
import sqlite3
import sys
import time

db, session_id = sys.argv[1], sys.argv[2]
for attempt in range(3):
    con = sqlite3.connect(db, timeout=0)
    con.execute("PRAGMA busy_timeout=5000")
    con.row_factory = sqlite3.Row
    try:
        con.execute("BEGIN IMMEDIATE")
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
                try: entry = json.loads(r["entry_json"] or "{}")
                except Exception: entry = {}
                if (r["session_key"] == skey or entry.get("session_key") == skey) and entry.get("session_id") == session_id:
                    entry.pop("session_id", None)
                    entry["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                    con.execute("UPDATE gateway_routing SET entry_json=?, updated_at=? WHERE scope=? AND session_key=?", (json.dumps(entry, ensure_ascii=False), now, r["scope"], r["session_key"]))
                    cleared_route = True
        con.commit()
        break
    except sqlite3.OperationalError as exc:
        con.rollback()
        if "locked" not in str(exc).lower() or attempt == 2:
            raise
        time.sleep(0.1 * (attempt + 1))
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
print(json.dumps({"ok": True, "session_id": session_id, "cleared_route": cleared_route}, ensure_ascii=False))
