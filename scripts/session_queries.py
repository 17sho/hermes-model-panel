"""Visibility-preserving session query helpers shared by list scripts."""

SESSION_FIELDS = """id, parent_session_id, source, display_name, session_key, chat_type, chat_id,
              origin_json, title, started_at, ended_at, end_reason, model, message_count,
       (SELECT MAX(timestamp) FROM messages WHERE session_id=sessions.id) AS last_ts,
       (SELECT MAX(timestamp) FROM messages WHERE session_id=sessions.id AND role='user') AS last_user_ts"""


def inherit_session_identity(connection, row, cache):
    source = row["source"] or ""
    name = row["display_name"] or ""
    session_key = row["session_key"] or ""
    chat_type = row["chat_type"] or ""
    origin = row["origin_json"] or ""
    parent_id = row["parent_session_id"]
    depth = 0
    while (not name or not session_key) and parent_id and depth < 8:
        if parent_id not in cache:
            cache[parent_id] = connection.execute(
                "SELECT source,display_name,session_key,chat_type,chat_id,origin_json,parent_session_id "
                "FROM sessions WHERE id=?",
                (parent_id,),
            ).fetchone()
        parent = cache[parent_id]
        if not parent:
            break
        source = source or (parent["source"] or "")
        name = name or (parent["display_name"] or "")
        session_key = session_key or (parent["session_key"] or "")
        chat_type = chat_type or (parent["chat_type"] or "")
        origin = origin or (parent["origin_json"] or "")
        parent_id = parent["parent_session_id"]
        depth += 1
    return source, name, session_key, chat_type, origin


def public_session(connection, row, cache):
    source, name, session_key, chat_type, origin = inherit_session_identity(connection, row, cache)
    return {
        "id": row["id"],
        "source": source,
        "display_name": name,
        "session_key": session_key,
        "chat_type": chat_type,
        "origin_json": origin,
        "title": row["title"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "end_reason": row["end_reason"],
        "model": row["model"],
        "message_count": row["message_count"],
        "last_ts": row["last_ts"],
        "last_user_ts": row["last_user_ts"],
        "open": row["ended_at"] is None,
    }
