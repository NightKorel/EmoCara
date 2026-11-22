from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .model_interface import (
    ModelConfigurationError,
    ModelResponseError,
    build_chat_prompt,
    build_state_proposal_prompt,
    get_configured_model,
    parse_json_object_text,
    parse_state_proposal_text,
)
from .interactions import CHAT_CONTRACT_VERSION, apply_chat_response, validate_chat_response, validate_user_message
from .relationships import new_relationship, validate_relationship
from .repository import CharacterRepository
from .schemas import PRESET_MODULES, new_character, new_module, normalize
from .state_proposals import apply_state_proposal, validate_state_proposal

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.getenv("EMOSIM_DB", BASE_DIR / "data" / "emotional_simulator.db"))
repository = CharacterRepository(DB_PATH)
app = FastAPI(title="情緒模擬器｜角色檔案", version="0.1.1")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


def character_or_404(character_id: str) -> dict[str, Any]:
    character = repository.get(character_id)
    if not character: raise HTTPException(404, "找不到這名角色。")
    return character


def save_validated(document: Any) -> dict[str, Any]:
    try: return repository.save(normalize(document))
    except ValueError as exc: raise HTTPException(422, str(exc)) from exc


@app.get("/", include_in_schema=False)
def home() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/health")
def health() -> dict[str, str]: return {"status": "ok"}


@app.get("/api/model-status")
def model_status() -> dict[str, Any]:
    """確認目前可用的提供者；刻意不回傳任何 API 金鑰或完整設定。"""
    try:
        model = get_configured_model()
        return {"provider": model.provider_name, "ready": model.provider_name != "disabled"}
    except ModelConfigurationError as exc:
        return {"provider": "misconfigured", "ready": False, "message": str(exc)}


@app.get("/api/module-types")
def module_types() -> dict[str, str]: return PRESET_MODULES


@app.get("/api/characters")
def list_characters() -> list[dict[str, Any]]: return repository.list()


@app.post("/api/characters", status_code=201)
async def create_character(request: Request) -> dict[str, Any]:
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    name = str(body.get("name", "未命名角色")) if isinstance(body, dict) else "未命名角色"
    return repository.save(new_character(name))


@app.get("/api/characters/{character_id}")
def get_character(character_id: str) -> dict[str, Any]: return character_or_404(character_id)


@app.get("/api/characters/{character_id}/chat-turns")
def list_chat_turns(character_id: str) -> list[dict[str, Any]]:
    character_or_404(character_id)
    return repository.list_interaction_turns(character_id)


@app.put("/api/characters/{character_id}")
async def replace_character(character_id: str, request: Request) -> dict[str, Any]:
    character_or_404(character_id)
    payload = await request.json()
    if not isinstance(payload, dict): raise HTTPException(422, "角色資料必須是 JSON 物件。")
    payload["character_id"] = character_id
    return save_validated(payload)


@app.delete("/api/characters/{character_id}")
def delete_character(character_id: str) -> dict[str, bool]:
    if not repository.delete(character_id):
        raise HTTPException(404, "找不到這名角色。")
    return {"deleted": True}


@app.patch("/api/characters/{character_id}/profile")
async def update_profile(character_id: str, request: Request) -> dict[str, Any]:
    character = character_or_404(character_id); patch = await request.json()
    if not isinstance(patch, dict): raise HTTPException(422, "profile 必須是 JSON 物件。")
    character["profile"].update(patch)
    return save_validated(character)


@app.patch("/api/characters/{character_id}/state")
async def update_state(character_id: str, request: Request) -> dict[str, Any]:
    character = character_or_404(character_id); patch = await request.json()
    if not isinstance(patch, dict): raise HTTPException(422, "state 必須是 JSON 物件。")
    character["state"].update(patch)
    return save_validated(character)


@app.patch("/api/characters/{character_id}/memory-settings")
async def update_memory_settings(character_id: str, request: Request) -> dict[str, Any]:
    """調整此角色的記憶容量；不會刪除、合併或修改任何既有記憶。"""
    character = character_or_404(character_id)
    settings = await request.json()
    if not isinstance(settings, dict):
        raise HTTPException(422, "memory_settings 必須是 JSON 物件。")
    character["memory_settings"] = settings
    return save_validated(character)


@app.post("/api/characters/{character_id}/state-proposal")
async def propose_state_change(character_id: str, request: Request) -> dict[str, Any]:
    """請模型提出變化；不寫入 SQLite。事件內容由呼叫端定義，必須是 JSON 物件。"""
    character = character_or_404(character_id)
    event = await request.json()
    if not isinstance(event, dict):
        raise HTTPException(422, "事件必須是 JSON 物件。")
    try:
        proposal = await get_configured_model().propose(character, event)
        return validate_state_proposal(proposal)
    except ModelConfigurationError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ModelResponseError as exc:
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, f"模型提案未通過 Python 驗證：{exc}") from exc


@app.post("/api/characters/{character_id}/manual-state-proposal-prompt")
async def create_manual_state_proposal_prompt(character_id: str, request: Request) -> dict[str, str]:
    """為網頁 AI 產生自足提示詞；只讀取角色，不呼叫模型、不寫入資料庫。"""
    character = character_or_404(character_id)
    event = await request.json()
    if not isinstance(event, dict):
        raise HTTPException(422, "事件必須是 JSON 物件。")
    return {"contract": "state_proposal/v0.1", "prompt": build_state_proposal_prompt(character, event)}


@app.post("/api/characters/{character_id}/parse-state-proposal")
async def parse_manual_state_proposal(character_id: str, request: Request) -> dict[str, Any]:
    """驗證手動貼回的回覆，供介面預覽；不會寫入資料庫。"""
    character_or_404(character_id)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(422, "回覆內容必須是 JSON 物件。")
    try:
        return validate_state_proposal(parse_state_proposal_text(payload.get("response_text")))
    except ModelResponseError as exc:
        raise HTTPException(422, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, f"手動回覆未通過 Python 驗證：{exc}") from exc


def chat_request_or_422(payload: Any) -> str:
    if not isinstance(payload, dict) or set(payload) != {"user_message"}:
        raise HTTPException(422, "聊天請求只能包含 user_message。")
    try:
        return validate_user_message(payload["user_message"])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def chat_prompt_for(character: dict[str, Any], user_message: str) -> str:
    # 回傳的歷史只含已確認保存的回合，避免把未核准提案送進下一次互動。
    recent_turns = repository.list_interaction_turns(character["character_id"], limit=12)
    return build_chat_prompt(character, recent_turns, user_message)


@app.post("/api/characters/{character_id}/chat-proposal")
async def propose_chat_turn(character_id: str, request: Request) -> dict[str, Any]:
    """自動模式：呼叫已明確啟用的模型，但不保存任何資料。"""
    character = character_or_404(character_id)
    user_message = chat_request_or_422(await request.json())
    try:
        response = await get_configured_model().interact(chat_prompt_for(character, user_message))
        return validate_chat_response(response)
    except ModelConfigurationError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ModelResponseError as exc:
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, f"模型回覆未通過 Python 驗證：{exc}") from exc


@app.post("/api/characters/{character_id}/manual-chat-prompt")
async def create_manual_chat_prompt(character_id: str, request: Request) -> dict[str, str]:
    """手動模式：只產生自足提示詞，完全不呼叫模型、不寫入資料庫。"""
    character = character_or_404(character_id)
    user_message = chat_request_or_422(await request.json())
    return {"contract": CHAT_CONTRACT_VERSION, "prompt": chat_prompt_for(character, user_message)}


@app.post("/api/characters/{character_id}/parse-chat-response")
async def parse_manual_chat_response(character_id: str, request: Request) -> dict[str, Any]:
    """驗證手動貼回的聊天回覆，供預覽；不會寫入資料庫。"""
    character_or_404(character_id)
    payload = await request.json()
    if not isinstance(payload, dict) or set(payload) != {"response_text"}:
        raise HTTPException(422, "手動回覆只能包含 response_text。")
    try:
        return validate_chat_response(parse_json_object_text(payload["response_text"]))
    except ModelResponseError as exc:
        raise HTTPException(422, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, f"手動回覆未通過 Python 驗證：{exc}") from exc


@app.post("/api/characters/{character_id}/apply-chat-turn")
async def apply_chat_turn(character_id: str, request: Request) -> dict[str, Any]:
    """只保存使用者已看過、且 Python 已驗證的聊天回合。"""
    character = character_or_404(character_id)
    payload = await request.json()
    if not isinstance(payload, dict) or set(payload) != {"user_message", "response", "selected_memory_candidates"}:
        raise HTTPException(422, "確認保存只能包含 user_message、response 與 selected_memory_candidates。")
    try:
        user_message = validate_user_message(payload["user_message"])
        updated, response, selected_memories = apply_chat_response(
            character, payload["response"], payload["selected_memory_candidates"]
        )
        return repository.save_interaction_turn(
            updated,
            contract_version=CHAT_CONTRACT_VERSION,
            user_message=user_message,
            character_reply=response["reply"],
            state_proposal=response["state_proposal"],
            memory_candidates=selected_memories,
        )
    except ValueError as exc:
        raise HTTPException(422, f"聊天回覆未通過 Python 驗證：{exc}") from exc


@app.post("/api/characters/{character_id}/apply-state-proposal")
async def apply_proposed_state_change(character_id: str, request: Request) -> dict[str, Any]:
    """只套用已通過白名單驗證的 state 提案，再由既有儲存流程持久化。"""
    character = character_or_404(character_id)
    payload = await request.json()
    try:
        return save_validated(apply_state_proposal(character, payload))
    except ValueError as exc:
        raise HTTPException(422, f"狀態提案未通過 Python 驗證：{exc}") from exc


@app.post("/api/characters/{character_id}/modules", status_code=201)
async def add_module(character_id: str, request: Request) -> dict[str, Any]:
    character = character_or_404(character_id); body = await request.json()
    if not isinstance(body, dict): raise HTTPException(422, "模組資料必須是 JSON 物件。")
    character["modules"].append(new_module(str(body.get("type", "custom")), str(body.get("name") or "") or None))
    return save_validated(character)


def module_or_404(character: dict[str, Any], module_id: str) -> dict[str, Any]:
    module = next((item for item in character["modules"] if item["module_id"] == module_id), None)
    if not module: raise HTTPException(404, "找不到這個模組。")
    return module


@app.put("/api/characters/{character_id}/modules/{module_id}")
async def update_module(character_id: str, module_id: str, request: Request) -> dict[str, Any]:
    character = character_or_404(character_id); module = module_or_404(character, module_id); body = await request.json()
    if not isinstance(body, dict): raise HTTPException(422, "模組資料必須是 JSON 物件。")
    for key in ("type", "name", "enabled", "data", "notes"):
        if key in body: module[key] = body[key]
    return save_validated(character)


@app.patch("/api/characters/{character_id}/modules/{module_id}/enabled")
async def set_module_enabled(character_id: str, module_id: str, request: Request) -> dict[str, Any]:
    character = character_or_404(character_id); module = module_or_404(character, module_id); body = await request.json()
    module["enabled"] = bool(body.get("enabled")) if isinstance(body, dict) else False
    return save_validated(character)


@app.delete("/api/characters/{character_id}/modules/{module_id}")
def delete_module(character_id: str, module_id: str) -> dict[str, Any]:
    character = character_or_404(character_id); module_or_404(character, module_id)
    character["modules"] = [item for item in character["modules"] if item["module_id"] != module_id]
    return save_validated(character)


def relationship_or_404(character: dict[str, Any], relationship_id: str) -> dict[str, Any]:
    relationship = next(
        (item for item in character["relationships"] if isinstance(item, dict) and item.get("relationship_id") == relationship_id),
        None,
    )
    if not relationship:
        raise HTTPException(404, "找不到這筆關係資料。")
    return relationship


@app.post("/api/characters/{character_id}/relationships", status_code=201)
async def add_relationship(character_id: str, request: Request) -> dict[str, Any]:
    character = character_or_404(character_id)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(422, "關係資料必須是 JSON 物件。")
    relationship = new_relationship(str(body.get("target_name") or "未命名對象"))
    character["relationships"].append(relationship)
    return save_validated(character)


@app.put("/api/characters/{character_id}/relationships/{relationship_id}")
async def update_relationship(character_id: str, relationship_id: str, request: Request) -> dict[str, Any]:
    character = character_or_404(character_id)
    existing = relationship_or_404(character, relationship_id)
    try:
        updated = validate_relationship(await request.json(), relationship_id=relationship_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    updated["created_at"] = existing.get("created_at", updated["updated_at"])
    character["relationships"] = [updated if item is existing else item for item in character["relationships"]]
    return save_validated(character)


@app.delete("/api/characters/{character_id}/relationships/{relationship_id}")
def delete_relationship(character_id: str, relationship_id: str) -> dict[str, Any]:
    character = character_or_404(character_id)
    relationship_or_404(character, relationship_id)
    character["relationships"] = [
        item for item in character["relationships"]
        if not (isinstance(item, dict) and item.get("relationship_id") == relationship_id)
    ]
    return save_validated(character)


@app.get("/api/characters/{character_id}/export")
def export_character(character_id: str) -> JSONResponse:
    character = character_or_404(character_id)
    safe_name = "".join(ch for ch in character["profile"]["name"] if ch.isalnum() or ch in "-_ ").strip() or "character"
    # HTTP 標頭只能安全放 ASCII；RFC 5987 讓中文角色名稱仍能正確下載。
    encoded_name = quote(f"{safe_name}.json")
    return JSONResponse(character, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"})


@app.post("/api/characters/import", status_code=201)
async def import_character(request: Request) -> dict[str, Any]:
    try: payload = await request.json()
    except json.JSONDecodeError as exc: raise HTTPException(422, "上傳檔案不是有效的 JSON。") from exc
    try:
        imported = normalize(payload)
    except ValueError as exc: raise HTTPException(422, str(exc)) from exc
    if repository.exists(imported["character_id"]): imported = normalize(imported, generate_id=True)
    imported["metadata"]["import_source"] = "json_import"
    return repository.save(imported)
