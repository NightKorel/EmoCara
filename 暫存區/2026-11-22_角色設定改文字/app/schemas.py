from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

SCHEMA_VERSION = "0.1"

DEFAULT_PROFILE = {
    "name": "未命名角色", "aliases": [], "age": None, "gender": None,
    "pronouns": None, "background": "", "appearance": "", "occupation": "",
    "current_situation": "", "other_information": {},
}
DEFAULT_STATE = {
    "mood": {"valence": 0, "arousal": 30}, "emotions": {},
    "psychological": {"security": 50, "anxiety": 30, "loneliness": 30, "emotional_stability": 50},
    "custom_metrics": {}, "last_updated": None,
}
PRESET_MODULES = {
    "personality": "人格特質", "values": "價值觀", "attachment": "依附與親密關係",
    "trauma": "創傷與負面經歷", "coping": "防衛與應對機制",
    "communication": "溝通方式", "goals": "需求與目標", "boundaries": "個人界線",
    "custom": "自訂模組",
}
MEMORY_IMPORTANCE = {"ordinary", "important", "core"}
DEFAULT_MEMORY_SETTINGS = {
    "core": {"max_items": 5, "max_chars": 200},
    "important": {"max_items": 15, "max_chars": 120},
    "ordinary": {"max_items": 30, "max_chars": 60},
}


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


def new_character(name: str = "未命名角色") -> dict[str, Any]:
    profile = deepcopy(DEFAULT_PROFILE)
    profile["name"] = name.strip() or "未命名角色"
    now = timestamp()
    return {
        "schema_version": SCHEMA_VERSION,
        "character_id": f"character_{uuid4().hex}",
        "profile": profile,
        "modules": [],
        "state": deepcopy(DEFAULT_STATE),
        "memories": [],
        "memory_settings": deepcopy(DEFAULT_MEMORY_SETTINGS),
        "relationships": [],
        "metadata": {"created_at": now, "updated_at": now, "tags": [], "import_source": None},
    }


def new_module(module_type: str, name: str | None = None) -> dict[str, Any]:
    chosen_type = module_type.strip() or "custom"
    return {
        "module_id": f"module_{uuid4().hex}", "type": chosen_type,
        "name": (name or PRESET_MODULES.get(chosen_type, chosen_type)).strip(),
        "enabled": True, "data": {}, "notes": "",
    }


def new_memory(summary: str, importance: str, reason: str, *, source: str = "chat") -> dict[str, Any]:
    """建立已確認保存的記憶；不在此處處理容量、淡化或整合。"""
    return {
        "memory_id": f"memory_{uuid4().hex}",
        "summary": summary,
        "importance": importance,
        "reason": reason,
        "source": source,
        "created_at": timestamp(),
        "last_recalled_at": None,
        "status": "active",
        "tags": [],
    }


def _object(value: Any, fallback: dict[str, Any]) -> dict[str, Any]:
    return value if isinstance(value, dict) else deepcopy(fallback)


def normalize_memory_settings(value: Any) -> dict[str, dict[str, int]]:
    """每名角色各自設定記憶容量；超額只會阻止新寫入，絕不刪除舊資料。"""
    raw = _object(value, DEFAULT_MEMORY_SETTINGS)
    clean: dict[str, dict[str, int]] = {}
    for importance, defaults in DEFAULT_MEMORY_SETTINGS.items():
        tier = _object(raw.get(importance), defaults)
        values: dict[str, int] = {}
        for key, default in defaults.items():
            item = tier.get(key, default)
            if isinstance(item, bool) or not isinstance(item, int):
                raise ValueError(f"memory_settings.{importance}.{key} 必須是整數。")
            lower, upper = (1, 500) if key == "max_items" else (40, 5000)
            if not lower <= item <= upper:
                raise ValueError(f"memory_settings.{importance}.{key} 必須介於 {lower} 到 {upper}。")
            values[key] = item
        clean[importance] = values
    return clean


def normalize(document: Any, *, generate_id: bool = False) -> dict[str, Any]:
    """接受可向前相容的角色 JSON，補齊第一階段必要區塊。"""
    if not isinstance(document, dict):
        raise ValueError("角色資料必須是一個 JSON 物件。")
    result = deepcopy(document)
    result["schema_version"] = str(result.get("schema_version") or SCHEMA_VERSION)
    if generate_id or not isinstance(result.get("character_id"), str) or not result["character_id"].strip():
        result["character_id"] = f"character_{uuid4().hex}"
    profile = _object(result.get("profile"), DEFAULT_PROFILE)
    for key, value in DEFAULT_PROFILE.items():
        profile.setdefault(key, deepcopy(value))
    if not isinstance(profile["aliases"], list): profile["aliases"] = []
    if not isinstance(profile["other_information"], dict): profile["other_information"] = {}
    profile["name"] = str(profile.get("name") or "未命名角色")
    result["profile"] = profile
    state = _object(result.get("state"), DEFAULT_STATE)
    for key, value in DEFAULT_STATE.items(): state.setdefault(key, deepcopy(value))
    state["mood"] = _object(state["mood"], DEFAULT_STATE["mood"])
    state["psychological"] = _object(state["psychological"], DEFAULT_STATE["psychological"])
    state["emotions"] = _object(state["emotions"], {})
    state["custom_metrics"] = _object(state["custom_metrics"], {})
    # 預設指標有明確範圍；自訂資料則保留使用者自己的尺度與語意。
    try:
        state["mood"]["valence"] = max(-100, min(100, float(state["mood"].get("valence", 0))))
        state["mood"]["arousal"] = max(0, min(100, float(state["mood"].get("arousal", 30))))
        for key in DEFAULT_STATE["psychological"]:
            state["psychological"][key] = max(0, min(100, float(state["psychological"].get(key, DEFAULT_STATE["psychological"][key]))))
    except (TypeError, ValueError) as exc:
        raise ValueError("預設心理指標必須是數字。") from exc
    result["state"] = state
    modules = result.get("modules", [])
    if not isinstance(modules, list): raise ValueError("modules 必須是陣列。")
    normalized_modules = []
    for module in modules:
        if not isinstance(module, dict): raise ValueError("每個模組必須是 JSON 物件。")
        clean = deepcopy(module)
        clean.setdefault("module_id", f"module_{uuid4().hex}")
        clean.setdefault("type", "custom")
        clean.setdefault("name", PRESET_MODULES.get(str(clean["type"]), str(clean["type"])))
        clean.setdefault("enabled", True); clean.setdefault("data", {}); clean.setdefault("notes", "")
        if not isinstance(clean["data"], dict): raise ValueError("module.data 必須是 JSON 物件。")
        clean["enabled"] = bool(clean["enabled"])
        normalized_modules.append(clean)
    result["modules"] = normalized_modules
    result["memories"] = result["memories"] if isinstance(result.get("memories"), list) else []
    result["memory_settings"] = normalize_memory_settings(result.get("memory_settings"))
    result["relationships"] = result["relationships"] if isinstance(result.get("relationships"), list) else []
    metadata = _object(result.get("metadata"), {})
    metadata.setdefault("created_at", timestamp()); metadata.setdefault("updated_at", timestamp())
    result["metadata"] = metadata
    return result
