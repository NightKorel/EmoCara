"""模型提案的 Python 端白名單驗證與套用。"""
from __future__ import annotations

import math
from copy import deepcopy
from typing import Any

from .schemas import DEFAULT_STATE, normalize, timestamp

_STATE_KEYS = {"mood", "psychological", "emotions", "custom_metrics"}
_MOOD_KEYS = {"valence", "arousal"}
_PSYCHOLOGICAL_KEYS = set(DEFAULT_STATE["psychological"])


def _number(value: Any, label: str, lower: float | None = None, upper: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValueError(f"{label} 必須是有限數字。")
    number = float(value)
    if (lower is not None and number < lower) or (upper is not None and number > upper):
        raise ValueError(f"{label} 必須介於 {lower} 到 {upper}。")
    return number


def _numeric_mapping(value: Any, label: str, lower: float | None = None, upper: float | None = None) -> dict[str, float]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} 必須是 JSON 物件。")
    clean: dict[str, float] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError(f"{label} 的名稱必須是非空白文字。")
        clean[key] = _number(item, f"{label}.{key}", lower, upper)
    return clean


def validate_state_proposal(proposal: Any) -> dict[str, Any]:
    """接受模型回覆，但只留下可安全寫入 state 的數值白名單。"""
    if not isinstance(proposal, dict):
        raise ValueError("模型提案必須是 JSON 物件。")
    if set(proposal) != {"summary", "state_patch"}:
        raise ValueError("模型提案只能包含 summary 與 state_patch。")
    summary = proposal["summary"]
    if not isinstance(summary, str) or not summary.strip() or len(summary) > 1000:
        raise ValueError("模型提案的 summary 必須是 1 至 1000 字元的文字。")
    patch = proposal["state_patch"]
    if not isinstance(patch, dict) or not patch:
        raise ValueError("state_patch 必須是非空的 JSON 物件。")
    unknown = set(patch) - _STATE_KEYS
    if unknown:
        raise ValueError(f"state_patch 含有不允許的欄位：{', '.join(sorted(unknown))}。")
    clean: dict[str, Any] = {}
    if "mood" in patch:
        mood = _numeric_mapping(patch["mood"], "mood")
        if set(mood) - _MOOD_KEYS:
            raise ValueError("mood 只能包含 valence 與 arousal。")
        clean["mood"] = {
            key: _number(value, f"mood.{key}", -100 if key == "valence" else 0, 100)
            for key, value in mood.items()
        }
    if "psychological" in patch:
        psychological = _numeric_mapping(patch["psychological"], "psychological", 0, 100)
        if set(psychological) - _PSYCHOLOGICAL_KEYS:
            raise ValueError("psychological 含有不允許的指標。")
        clean["psychological"] = psychological
    if "emotions" in patch:
        clean["emotions"] = _numeric_mapping(patch["emotions"], "emotions", 0, 100)
    if "custom_metrics" in patch:
        clean["custom_metrics"] = _numeric_mapping(patch["custom_metrics"], "custom_metrics")
    if not any(clean.values()):
        raise ValueError("state_patch 至少要包含一項數值變化。")
    return {"summary": summary.strip(), "state_patch": clean}


def apply_state_proposal(character: dict[str, Any], proposal: Any) -> dict[str, Any]:
    """將已驗證的狀態提案合併進副本，並交由既有 normalize 再驗證。"""
    clean = validate_state_proposal(proposal)
    updated = deepcopy(character)
    state = updated["state"]
    for section, values in clean["state_patch"].items():
        state[section].update(values)
    state["last_updated"] = timestamp()
    return normalize(updated)
