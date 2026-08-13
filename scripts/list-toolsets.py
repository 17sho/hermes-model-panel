#!/usr/bin/env python3
import json
import sys

sys.path.insert(0, "/usr/local/lib/hermes-agent")
from toolsets import get_all_toolsets

SKIP_PREFIX = "hermes-"
SKIP = {
    "hermes-gateway",
    "project",
    "context_engine",
    "kanban",
    "discord",
    "discord_admin",
    "feishu_doc",
    "feishu_drive",
    "yuanbao",
    "spotify",
    "homeassistant",
}

out = []
for name, info in sorted((get_all_toolsets() or {}).items()):
    if name.startswith(SKIP_PREFIX) or name in SKIP:
        continue
    desc = str((info or {}).get("description") or "").strip()
    tools = list((info or {}).get("tools") or [])
    includes = list((info or {}).get("includes") or [])
    out.append(
        {
            "id": name,
            "description": desc[:160],
            "tools": tools[:12],
            "includes": includes,
            "kind": "composite" if includes and not tools else "basic",
        }
    )
print(json.dumps(out, ensure_ascii=False))
