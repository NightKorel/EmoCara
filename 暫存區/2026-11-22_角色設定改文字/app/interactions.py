"""第一階段互動回合的可驗證契約。

模型（或手動貼回的網頁 AI）只能產生這份提案；真正的寫入永遠由
main.py 與 repository.py 控制。記憶與設定修訂會在較後續的契約版本新增，
不可先由模型夾帶進來。
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from .schemas import MEMORY_IMPORTANCE, new_memory, normalize_memory_settings
from .state_proposals import apply_state_proposal, validate_state_proposal

CHAT_CONTRACT_VERSION = "chat_turn/v0.2"
MAX_MESSAGE_LENGTH = 4_000
MAX_REPLY_LENGTH = 6_000
MAX_MEMORY_CANDIDATES = 3
MAX_MEMORY_TEXT_LENGTH = 1_000


def validate_user_message(message: Any) -> str:
    if not isinstance(message, str):
        raise ValueError("訊息必須是文字。")
    clean = message.strip()
    if not clean:
        raise ValueError("訊息不能是空白。")
    if len(clean) > MAX_MESSAGE_LENGTH:
        raise ValueError(f"訊息不可超過 {MAX_MESSAGE_LENGTH} 個字元。")
    return clean


def validate_memory_candidate(candidate: Any) -> dict[str, str]:
    if not isinstance(candidate, dict) or set(candidate) != {"summary", "importance", "reason"}:
        raise ValueError("每筆記憶候選項只能包含 summary、importance 與 reason。")
    values: dict[str, str] = {}
    for key in ("summary", "reason"):
        value = candidate[key]
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > MAX_MEMORY_TEXT_LENGTH:
            raise ValueError(f"記憶候選項的 {key} 必須是 1 至 {MAX_MEMORY_TEXT_LENGTH} 個字元的文字。")
        values[key] = value.strip()
    importance = candidate["importance"]
    if not isinstance(importance, str) or importance not in MEMORY_IMPORTANCE:
        raise ValueError("記憶候選項的 importance 只能是 ordinary、important 或 core。")
    values["importance"] = importance
    return values


def validate_memory_candidates(candidates: Any) -> list[dict[str, str]]:
    if not isinstance(candidates, list) or len(candidates) > MAX_MEMORY_CANDIDATES:
        raise ValueError(f"memory_candidates 必須是至多 {MAX_MEMORY_CANDIDATES} 筆的陣列。")
    clean = [validate_memory_candidate(candidate) for candidate in candidates]
    if len({(item["summary"], item["importance"], item["reason"]) for item in clean}) != len(clean):
        raise ValueError("記憶候選項不可重複。")
    return clean


def validate_memory_capacity(character: dict[str, Any], selected: list[dict[str, str]]) -> None:
    """依角色自身設定限制新記憶；不會刪除或改寫任何既有記憶。"""
    settings = normalize_memory_settings(character.get("memory_settings"))
    existing = character.get("memories", [])
    for importance in MEMORY_IMPORTANCE:
        tier = settings[importance]
        pending = [item for item in selected if item["importance"] == importance]
        current_count = sum(1 for item in existing if isinstance(item, dict) and item.get("importance") == importance)
        if current_count + len(pending) > tier["max_items"]:
            raise ValueError(f"{importance} 記憶已達 {tier['max_items']} 筆上限；本次不會自動刪除舊記憶。")
        for item in pending:
            if len(item["summary"]) + len(item["reason"]) > tier["max_chars"]:
                raise ValueError(f"{importance} 記憶文字超過每筆 {tier['max_chars']} 字元上限。")


def validate_chat_response(response: Any) -> dict[str, Any]:
    """只保留角色文字、可選狀態提案及待使用者確認的記憶候選項。"""
    if not isinstance(response, dict):
        raise ValueError("互動回覆必須是 JSON 物件。")
    if set(response) not in ({"reply", "state_proposal"}, {"reply", "state_proposal", "memory_candidates"}):
        raise ValueError("互動回覆只能包含 reply、state_proposal 與 memory_candidates。")
    reply = response["reply"]
    if not isinstance(reply, str) or not reply.strip() or len(reply.strip()) > MAX_REPLY_LENGTH:
        raise ValueError(f"reply 必須是 1 至 {MAX_REPLY_LENGTH} 個字元的文字。")
    proposal = response["state_proposal"]
    return {
        "reply": reply.strip(),
        "state_proposal": None if proposal is None else validate_state_proposal(proposal),
        # 接受 v0.1 回覆，讓尚未貼回的舊手動提示詞仍可安全完成既有聊天流程。
        "memory_candidates": validate_memory_candidates(response.get("memory_candidates", [])),
    }


def apply_chat_response(
    character: dict[str, Any], response: Any, selected_memory_candidates: Any,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, str]]]:
    """回傳已驗證的回覆及待保存角色副本，不直接存取 SQLite。"""
    clean = validate_chat_response(response)
    selected = validate_memory_candidates(selected_memory_candidates)
    available = {(item["summary"], item["importance"], item["reason"]) for item in clean["memory_candidates"]}
    if any((item["summary"], item["importance"], item["reason"]) not in available for item in selected):
        raise ValueError("只能保存本次回覆提出的記憶候選項。")
    validate_memory_capacity(character, selected)
    updated = apply_state_proposal(character, clean["state_proposal"]) if clean["state_proposal"] else deepcopy(character)
    updated["memories"].extend(
        new_memory(item["summary"], item["importance"], item["reason"]) for item in selected
    )
    return updated, clean, selected
