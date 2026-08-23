#!/usr/bin/env python3
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

SKIP_DIRS = {".git", ".hub", ".archive", "node_modules", "__pycache__"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def parse_name(text: str, fallback: str) -> str:
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].splitlines():
                m = re.match(r"^name:\s*(.*)$", line.strip())
                if m:
                    return m.group(1).strip().strip("'\"") or fallback
    return fallback


def find_skill(skills_root: Path, name: str) -> Path | None:
    if not skills_root.is_dir():
        return None
    for md in skills_root.rglob("SKILL.md"):
        if any(p in SKIP_DIRS for p in md.parts):
            continue
        try:
            text = md.read_text(encoding="utf-8")[:2000]
        except OSError:
            continue
        if parse_name(text, md.parent.name) == name:
            return md.parent
    return None


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "用法: delete-skill.py <home> <name>"}))
        sys.exit(1)
    home = Path(sys.argv[1])
    name = sys.argv[2].strip()
    if not NAME_RE.match(name):
        print(json.dumps({"ok": False, "error": "skill 名字不合法"}))
        sys.exit(1)
    skills_root = home / "skills"
    dest_dir = find_skill(skills_root, name)
    if dest_dir is None:
        print(json.dumps({"ok": False, "error": "没找到这个 skill"}))
        sys.exit(1)
    try:
        dest_dir.relative_to(skills_root.resolve())
    except ValueError:
        print(json.dumps({"ok": False, "error": "路径不在这个 agent 的 skills 目录里"}))
        sys.exit(1)
    if dest_dir.resolve() == skills_root.resolve():
        print(json.dumps({"ok": False, "error": "拒绝删整个 skills 目录"}))
        sys.exit(1)
    archive = skills_root / ".archive"
    archive.mkdir(parents=True, exist_ok=True)
    dest = archive / dest_dir.name
    if dest.exists():
        dest = archive / f"{dest_dir.name}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    try:
        dest_dir.rename(dest)
    except OSError:
        shutil.move(str(dest_dir), str(dest))
    print(json.dumps({"ok": True, "archived": str(dest), "original": str(dest_dir), "name": name}, ensure_ascii=False))


if __name__ == "__main__":
    main()
