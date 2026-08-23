#!/usr/bin/env python3
import json
import sys

from dbutil import connect_readonly
from session_queries import SESSION_FIELDS, public_session

database = sys.argv[1]
limit = max(1, min(int(sys.argv[2]) if len(sys.argv) > 2 else 20, 100))
offset = max(0, int(sys.argv[3]) if len(sys.argv) > 3 else 0)
query = (sys.argv[4] if len(sys.argv) > 4 else "").strip()
connection = connect_readonly(database)
where = "IFNULL(source,'') NOT IN ('cli','tui','subagent','cron','web') AND IFNULL(archived,0)=0"
args = []
if query:
    where += " AND (IFNULL(title,'') LIKE ? OR IFNULL(display_name,'') LIKE ? OR IFNULL(session_key,'') LIKE ? OR IFNULL(model,'') LIKE ? OR IFNULL(source,'') LIKE ?)"
    args.extend([f"%{query}%"] * 5)
total = connection.execute(f"SELECT COUNT(*) FROM sessions WHERE {where}", args).fetchone()[0]
rows = connection.execute(
    f"""SELECT {SESSION_FIELDS} FROM sessions WHERE {where}
        ORDER BY COALESCE(last_ts, started_at) DESC LIMIT ? OFFSET ?""",
    args + [limit, offset],
).fetchall()
cache = {}
items = [public_session(connection, row, cache) for row in rows]
print(json.dumps({"items": items, "total": total}, ensure_ascii=False))
