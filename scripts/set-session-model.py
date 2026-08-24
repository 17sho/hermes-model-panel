#!/usr/bin/env python3
import json
import sys
import time

from dbutil import immediate_transaction

db, session_key, model = sys.argv[1], sys.argv[2], sys.argv[3]
provider = sys.argv[4] if len(sys.argv) > 4 else ""
base_url = sys.argv[5] if len(sys.argv) > 5 else ""
override = {"model": model}
if provider:
    override["provider"] = provider
if base_url:
    override["base_url"] = base_url


def set_model(con):
    rows = con.execute("SELECT scope, session_key, entry_json FROM gateway_routing").fetchall()
    now = time.time()
    updated = False
    for r in rows:
        try:
            entry = json.loads(r["entry_json"] or "{}")
        except Exception:
            entry = {}
        if r["session_key"] != session_key and entry.get("session_key") != session_key:
            continue
        if model:
            entry["model_override"] = override
        else:
            entry.pop("model_override", None)
        entry["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        con.execute(
            "UPDATE gateway_routing SET entry_json=?, updated_at=? WHERE scope=? AND session_key=?",
            (json.dumps(entry, ensure_ascii=False), now, r["scope"], r["session_key"]),
        )
        updated = True
    if not updated:
        raise ValueError("找不到这条聊天路由")
    return updated


immediate_transaction(db, set_model)
print(
    json.dumps(
        {"ok": True, "session_key": session_key, "model_override": override if model else None}, ensure_ascii=False
    )
)
