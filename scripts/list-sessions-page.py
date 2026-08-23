#!/usr/bin/env python3
import json, sqlite3, sys

db = sys.argv[1]
limit = max(1, min(int(sys.argv[2]) if len(sys.argv) > 2 else 20, 100))
offset = max(0, int(sys.argv[3]) if len(sys.argv) > 3 else 0)
query = (sys.argv[4] if len(sys.argv) > 4 else '').strip()
con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
con.execute("PRAGMA busy_timeout=5000")
con.row_factory = sqlite3.Row
where = "IFNULL(source,'') NOT IN ('cli','tui','subagent','cron','web') AND IFNULL(archived,0)=0"
args = []
if query:
    where += " AND (IFNULL(title,'') LIKE ? OR IFNULL(display_name,'') LIKE ? OR IFNULL(session_key,'') LIKE ? OR IFNULL(model,'') LIKE ? OR IFNULL(source,'') LIKE ?)"
    like = '%' + query + '%'
    args.extend([like] * 5)
total = con.execute("SELECT COUNT(*) FROM sessions WHERE " + where, args).fetchone()[0]
rows = con.execute(
    """SELECT id, parent_session_id, source, display_name, session_key, chat_type, chat_id,
              origin_json, title, started_at, ended_at, end_reason, model, message_count,
       (SELECT MAX(timestamp) FROM messages WHERE session_id=sessions.id) AS last_ts,
       (SELECT MAX(timestamp) FROM messages WHERE session_id=sessions.id AND role='user') AS last_user_ts
       FROM sessions WHERE %s
       ORDER BY COALESCE(last_ts, started_at) DESC LIMIT ? OFFSET ?""" % where,
    args + [limit, offset],
).fetchall()
cache = {}
def walk(sid):
    if not sid: return None
    if sid in cache: return cache[sid]
    r = con.execute("SELECT source,display_name,session_key,chat_type,chat_id,origin_json,parent_session_id FROM sessions WHERE id=?", (sid,)).fetchone()
    cache[sid] = r
    return r
out = []
for row in rows:
    src, name, skey = row['source'] or '', row['display_name'] or '', row['session_key'] or ''
    ctype, origin, sid = row['chat_type'] or '', row['origin_json'] or '', row['parent_session_id']
    depth = 0
    while (not name or not skey) and sid and depth < 8:
        p = walk(sid)
        if not p: break
        src = src or (p['source'] or ''); name = name or (p['display_name'] or ''); skey = skey or (p['session_key'] or '')
        ctype = ctype or (p['chat_type'] or ''); origin = origin or (p['origin_json'] or ''); sid = p['parent_session_id']; depth += 1
    out.append({'id':row['id'],'source':src,'display_name':name,'session_key':skey,'chat_type':ctype,'origin_json':origin,
      'title':row['title'],'started_at':row['started_at'],'ended_at':row['ended_at'],'end_reason':row['end_reason'],
      'model':row['model'],'message_count':row['message_count'],'last_ts':row['last_ts'],'last_user_ts':row['last_user_ts'],'open':row['ended_at'] is None})
print(json.dumps({'items':out,'total':total}, ensure_ascii=False))
