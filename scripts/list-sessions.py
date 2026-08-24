#!/usr/bin/env python3
import json
import sys

from dbutil import connect_readonly
from session_queries import SESSION_FIELDS, public_session

database = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 8
connection = connect_readonly(database)
rows = connection.execute(
    f"""SELECT {SESSION_FIELDS}
        FROM sessions
        WHERE IFNULL(source,'') NOT IN ('cli','tui','subagent','cron')
          AND IFNULL(archived,0)=0
        ORDER BY COALESCE(last_ts, started_at) DESC LIMIT ?""",
    (limit,),
).fetchall()
cache = {}
print(json.dumps([public_session(connection, row, cache) for row in rows], ensure_ascii=False))
