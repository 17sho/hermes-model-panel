"""Shared SQLite helpers for panel maintenance scripts."""

import sqlite3
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


def connect_readonly(database: str) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.execute("PRAGMA busy_timeout=5000")
    connection.row_factory = sqlite3.Row
    return connection


def immediate_transaction(database: str, operation: Callable[[sqlite3.Connection], T]) -> T:
    """Run a complete BEGIN IMMEDIATE transaction with bounded lock retries."""
    for attempt in range(3):
        connection = sqlite3.connect(database, timeout=0)
        connection.execute("PRAGMA busy_timeout=5000")
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("BEGIN IMMEDIATE")
            result = operation(connection)
            connection.commit()
            return result
        except sqlite3.OperationalError as exc:
            connection.rollback()
            if "locked" not in str(exc).lower() or attempt == 2:
                raise
            time.sleep(0.1 * (attempt + 1))
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
    raise RuntimeError("SQLite transaction retry exhausted")
