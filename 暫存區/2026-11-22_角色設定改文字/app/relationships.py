"""使用者可編輯的關係維度；模型目前不可直接改寫這些資料。"""
from __future__ import annotations

from copy import deepcopy
from typing import Any
from uuid import uuid4

from .schemas import timestamp

RELATIONSHIP_DIMENSIONS = ("trust", "intimacy", "safety", "dependence", "wariness")
DEFAULT_DIMENSIONS = {key: 50 for key in RELATIONSHIP_DIMENSIONS}


def new_relationship(target_name: str = "未命名對象") -> dict[str, Any]:
    now = timestamp()
    return {
        "relationship_id": f"relationship_{uuid4().hex}",
        "target_name": target_name.strip() or "未命名對象",
        "target_type": "person",
        "dimensions": deepcopy(DEFAULT_DIMENSIONS),
        "notes": "",
        "created_at": now,
        "updated_at": now,
    }


def validate_relationship(value: Any, *, relationship_id: str | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("關係資料必須是 JSON 物件。")
    allowed = {"target_name", "target_type", "dimensions", "notes"}
    if set(value) != allowed:
        raise ValueError("關係資料只能包含 target_name、target_type、dimensions 與 notes。")
    target_name = value["target_name"]
    target_type = value["target_type"]
    notes = value["notes"]
    if not isinstance(target_name, str) or not target_name.strip() or len(target_name.strip()) > 200:
        raise ValueError("target_name 必須是 1 至 200 個字元的文字。")
    if not isinstance(target_type, str) or not target_type.strip() or len(target_type.strip()) > 100:
        raise ValueError("target_type 必須是 1 至 100 個字元的文字。")
    if not isinstance(notes, str) or len(notes) > 4000:
        raise ValueError("notes 必須是不超過 4000 個字元的文字。")
    dimensions = value["dimensions"]
    if not isinstance(dimensions, dict) or set(dimensions) != set(RELATIONSHIP_DIMENSIONS):
        raise ValueError("dimensions 必須包含信任、親密、安全感、依賴與戒心五個維度。")
    clean_dimensions: dict[str, float] = {}
    for key in RELATIONSHIP_DIMENSIONS:
        number = dimensions[key]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not 0 <= float(number) <= 100:
            raise ValueError(f"dimensions.{key} 必須是 0 至 100 的數字。")
        clean_dimensions[key] = float(number)
    now = timestamp()
    return {
        "relationship_id": relationship_id or f"relationship_{uuid4().hex}",
        "target_name": target_name.strip(), "target_type": target_type.strip(),
        "dimensions": clean_dimensions, "notes": notes,
        "updated_at": now,
    }
