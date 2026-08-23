#!/usr/bin/env python3
import json
import sqlite3
import sys
import time

db, session_key, model = sys.argv[1], sys.argv[2], sys.argv[3]
provider = sys.argv[4] if len(sys.argv) > 4 else ""
base_url = sys.argv[5] if len(sys.argv) > 5 else ""
override = {"model": model}
if provider:
    override["provider"] = provider
if base_url:
    override["base_url"] = base_url
for attempt in range(3):
    con = sqlite3.connect(db, timeout=0)
    con.execute("PRAGMA busy_timeout=5000")
    con.row_factory = sqlite3.Row
    try:
        con.execute("BEGIN IMMEDIATE")
        rows = con.execute("SELECT scope, session_key, entry_json FROM gateway_routing").fetchall()
        now = time.time()
        updated = False
        for r in rows:
            try: entry = json.loads(r["entry_json"] or "{}")
            except Exception: entry = {}
            if r["session_key"] != session_key and entry.get("session_key") != session_key: continue
            if model: entry["model_override"] = override
            else: entry.pop("model_override", None)
            entry["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            con.execute("UPDATE gateway_routing SET entry_json=?, updated_at=? WHERE scope=? AND session_key=?", (json.dumps(entry, ensure_ascii=False), now, r["scope"], r["session_key"]))
            updated = True
        if not updated: raise ValueError("找不到这条聊天路由")
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
print(json.dumps({"ok": True, "session_key": session_key, "model_override": override if model else None}, ensure_ascii=False))
