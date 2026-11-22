from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class CharacterRepository:
    """以一筆 JSON 文件保存一名角色；SQLite 負責持久化與清單索引。"""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS characters (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    document_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS interaction_turns (
                    id TEXT PRIMARY KEY,
                    character_id TEXT NOT NULL,
                    contract_version TEXT NOT NULL,
                    user_message TEXT NOT NULL,
                    character_reply TEXT NOT NULL,
                    state_proposal_json TEXT,
                    memory_candidates_json TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_interaction_turns_character_created "
                "ON interaction_turns(character_id, created_at DESC)"
            )
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(interaction_turns)").fetchall()}
            if "memory_candidates_json" not in columns:
                conn.execute("ALTER TABLE interaction_turns ADD COLUMN memory_candidates_json TEXT")

    def list(self) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT id, name, created_at, updated_at FROM characters ORDER BY updated_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def get(self, character_id: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT document_json FROM characters WHERE id = ?", (character_id,)
            ).fetchone()
        return json.loads(row["document_json"]) if row else None

    def exists(self, character_id: str) -> bool:
        with self.connection() as conn:
            return conn.execute("SELECT 1 FROM characters WHERE id = ?", (character_id,)).fetchone() is not None

    def save(self, document: dict[str, Any]) -> dict[str, Any]:
        with self.connection() as conn:
            self._save_document(conn, document)
        return document

    def _save_document(self, conn: sqlite3.Connection, document: dict[str, Any]) -> None:
        now = utc_now()
        metadata = document.setdefault("metadata", {})
        metadata.setdefault("created_at", now)
        metadata["updated_at"] = now
        document["state"]["last_updated"] = now
        payload = json.dumps(document, ensure_ascii=False)
        name = str(document["profile"].get("name") or "未命名角色")
        conn.execute(
            """
            INSERT INTO characters (id, name, document_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, document_json=excluded.document_json, updated_at=excluded.updated_at
            """,
            (document["character_id"], name, payload, metadata["created_at"], now),
        )

    def list_interaction_turns(self, character_id: str, *, limit: int = 30) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 100))
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, contract_version, user_message, character_reply, state_proposal_json, memory_candidates_json, created_at
                FROM interaction_turns WHERE character_id = ?
                ORDER BY created_at DESC LIMIT ?
                """,
                (character_id, safe_limit),
            ).fetchall()
        turns = []
        for row in reversed(rows):
            turn = dict(row)
            turn["state_proposal"] = json.loads(turn.pop("state_proposal_json")) if turn["state_proposal_json"] else None
            turn["memory_candidates"] = json.loads(turn.pop("memory_candidates_json")) if turn["memory_candidates_json"] else []
            turns.append(turn)
        return turns

    def save_interaction_turn(
        self,
        document: dict[str, Any],
        *,
        contract_version: str,
        user_message: str,
        character_reply: str,
        state_proposal: dict[str, Any] | None,
        memory_candidates: list[dict[str, str]],
    ) -> dict[str, Any]:
        """在同一筆 SQLite transaction 同時保存角色與已確認的互動回合。"""
        created_at = utc_now()
        with self.connection() as conn:
            self._save_document(conn, document)
            conn.execute(
                """
                INSERT INTO interaction_turns
                    (id, character_id, contract_version, user_message, character_reply, state_proposal_json, memory_candidates_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"turn_{uuid4().hex}", document["character_id"], contract_version,
                    user_message, character_reply,
                    json.dumps(state_proposal, ensure_ascii=False) if state_proposal else None,
                    json.dumps(memory_candidates, ensure_ascii=False),
                    created_at,
                ),
            )
        return document

    def delete(self, character_id: str) -> bool:
        with self.connection() as conn:
            conn.execute("DELETE FROM interaction_turns WHERE character_id = ?", (character_id,))
            result = conn.execute("DELETE FROM characters WHERE id = ?", (character_id,))
        return result.rowcount > 0
