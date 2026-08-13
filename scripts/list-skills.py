#!/usr/bin/env python3
import json
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", ".hub", ".archive", "node_modules", "__pycache__"}


def parse_frontmatter(text: str):
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    fm, body = parts[1], parts[2]
    data = {}
    for line in fm.splitlines():
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line.strip())
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip().strip("'\"")
        data[key] = val
    return data, body


def first_desc(body: str) -> str:
    for line in (body or "").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line[:120]
    return ""


def category_of(path: Path, skills_root: Path) -> str:
    try:
        rel = path.parent.relative_to(skills_root)
    except ValueError:
        return "uncategorized"
    parts = list(rel.parts)
    if len(parts) >= 2:
        return parts[0]
    return "uncategorized"


def scan(skills_root: Path):
    out = []
    seen = set()
    if not skills_root.is_dir():
        return out
    for md in sorted(skills_root.rglob("SKILL.md")):
        if any(p in SKIP_DIRS for p in md.parts):
            continue
        try:
            text = md.read_text(encoding="utf-8")[:4000]
        except OSError:
            continue
        fm, body = parse_frontmatter(text)
        name = str(fm.get("name") or md.parent.name).strip()[:80]
        if not name or name in seen:
            continue
        seen.add(name)
        desc = str(fm.get("description") or first_desc(body) or name)[:120]
        out.append(
            {
                "id": name,
                "category": category_of(md, skills_root),
                "description": desc,
                "deletable": True,
            }
        )
    out.sort(key=lambda x: (x["category"], x["id"]))
    return out


def main():
    home = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HERMES_HOME", "/root/.hermes"))
    print(json.dumps(scan(home / "skills"), ensure_ascii=False))


if __name__ == "__main__":
    main()
