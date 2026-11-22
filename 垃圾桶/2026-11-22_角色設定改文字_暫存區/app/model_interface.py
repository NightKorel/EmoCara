"""可替換的模型邊界。

模型只能回傳狀態變化或聊天回合「提案」。提案會在 main.py 交給 Python 驗證，
通過且經使用者確認後才可能由 repository 寫入 SQLite；此模組絕不存取資料庫。
"""
from __future__ import annotations

import asyncio
import json
from copy import deepcopy
import os
from pathlib import Path
from typing import Any, Protocol

import httpx
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
# 只讀取專案根目錄的本機設定；環境變數優先，避免覆蓋部署環境的祕密。
load_dotenv(BASE_DIR / ".env", override=False)

DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"

STATE_PROPOSAL_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}, "state_patch": {"type": "object"}},
    "required": ["summary", "state_patch"],
}
CHAT_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "state_proposal": {"anyOf": [{"type": "object"}, {"type": "null"}]},
        "memory_candidates": {
            "type": "array",
            "maxItems": 3,
            "items": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "importance": {"type": "string", "enum": ["ordinary", "important", "core"]},
                    "reason": {"type": "string"},
                },
                "required": ["summary", "importance", "reason"],
            },
        },
    },
    "required": ["reply", "state_proposal", "memory_candidates"],
}


class ModelConfigurationError(RuntimeError):
    """模型尚未設定或提供者名稱不正確。"""


class ModelResponseError(RuntimeError):
    """模型沒有回傳可安全處理的 JSON 提案。"""


class CharacterModel(Protocol):
    """角色演繹模型所需的最小介面。"""

    provider_name: str

    async def propose(self, character: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
        """回傳狀態變化提案，不直接寫入資料庫。"""
        ...

    async def interact(self, prompt: str) -> dict[str, Any]:
        """回傳聊天回合提案，不直接寫入資料庫。"""
        ...


def character_for_prompt(character: dict[str, Any]) -> dict[str, Any]:
    """給 AI 看的角色資料：只放開著、而且有寫內容的模組，空白模組直接跳過。"""
    view = deepcopy(character)
    modules = []
    for module in character.get("modules", []):
        if not isinstance(module, dict) or not module.get("enabled", True):
            continue
        text = module.get("text") if isinstance(module.get("text"), str) else ""
        data = module.get("data") if isinstance(module.get("data"), dict) else {}
        if not text.strip() and not data:
            continue
        item = {"name": module.get("name", "")}
        if text.strip(): item["text"] = text.strip()
        if data: item["data"] = data
        if isinstance(module.get("notes"), str) and module["notes"].strip(): item["notes"] = module["notes"].strip()
        modules.append(item)
    view["modules"] = modules
    return view


def build_state_proposal_prompt(character: dict[str, Any], event: dict[str, Any]) -> str:
    """固定契約，讓每個提供者請求相同且可驗證的資料形狀。"""
    supplied = json.dumps({"character": character_for_prompt(character), "event": event}, ensure_ascii=False)
    return f"""你是角色心理狀態的模擬器。根據下列角色資料與事件，提出一個保守、可解釋的狀態變化提案。

你不是資料庫，也不能修改角色設定、記憶、關係、模組或 metadata。只可提出數值狀態的變化。
只回傳 JSON 物件，不要 Markdown，不要額外文字。格式必須是：
{{
  \"summary\": \"簡短說明\",
  \"state_patch\": {{
    \"mood\": {{\"valence\": -100 到 100 的數字，\"arousal\": 0 到 100 的數字}},
    \"psychological\": {{\"security\": 0 到 100, \"anxiety\": 0 到 100, \"loneliness\": 0 到 100, \"emotional_stability\": 0 到 100}},
    \"emotions\": {{\"可選的情緒名稱\": 0 到 100 的數字}},
    \"custom_metrics\": {{\"可選的自訂指標\": 有限數字}}
  }}
}}
state_patch 可只包含實際需要改動的欄位，但不得為空。不要臆測角色資料中沒有的事實。

輸入資料：
{supplied}"""


def build_chat_prompt(character: dict[str, Any], recent_turns: list[dict[str, Any]], user_message: str) -> str:
    """產生自足的聊天提示詞，供 API 與手動網頁 AI 共用。"""
    supplied = json.dumps(
        {"character": character_for_prompt(character), "recent_turns": recent_turns, "user_message": user_message},
        ensure_ascii=False,
    )
    return f"""你是角色互動模擬器。請以角色自己的觀點、界線和語氣回覆使用者，
不得臆測輸入資料沒有的事實，也不必迎合使用者。你不是資料庫，不能修改角色的
profile、modules、memories、relationships 或 metadata。

只回傳 JSON 物件，不要 Markdown 或額外文字。格式必須是：
{{
  "reply": "角色對使用者說的話",
  "state_proposal": null 或 {{
    "summary": "簡短說明",
    "state_patch": {{
      "mood": {{"valence": -100 到 100，"arousal": 0 到 100}},
      "psychological": {{"security": 0 到 100，"anxiety": 0 到 100，"loneliness": 0 到 100，"emotional_stability": 0 到 100}},
      "emotions": {{"可選情緒名稱": 0 到 100}},
      "custom_metrics": {{"可選指標名稱": 有限數字}}
    }}
  }},
  "memory_candidates": [
    {{"summary": "值得保存的互動事實或感受", "importance": "ordinary、important 或 core", "reason": "為何值得保留"}}
  ]
}}
state_proposal 只在這次對話確有足夠依據的心理數值變化時提出；否則填 null。
即使提出提案，它也必須等待 Python 驗證與使用者確認才可能保存。
memory_candidates 最多三筆，只記錄本次對話明確出現且有長期意義的事；沒有則回傳 []。
這些只是候選項，使用者可能不選擇保存，且不得將它們當作已保存記憶。
角色資料中的 memory_settings 是各層級的筆數與每筆文字上限；候選項必須遵守它。

輸入資料：
{supplied}"""


def parse_json_object_text(text: str) -> dict[str, Any]:
    """解析自動或手動模式取得的 JSON；不驗證、更不寫入資料庫。"""
    if not isinstance(text, str) or not text.strip():
        raise ModelResponseError("模型沒有回傳文字提案。")
    candidate = text.strip()
    # 網頁版模型偶爾仍會用 Markdown code fence 包裝 JSON；只接受完整的單一區塊。
    if candidate.startswith("```") and candidate.endswith("```"):
        lines = candidate.splitlines()
        if len(lines) >= 3:
            candidate = "\n".join(lines[1:-1]).strip()
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ModelResponseError("模型沒有回傳有效的 JSON 提案。") from exc
    if not isinstance(value, dict):
        raise ModelResponseError("模型提案必須是 JSON 物件。")
    return value


def parse_state_proposal_text(text: str) -> dict[str, Any]:
    return parse_json_object_text(text)


class DisabledModel:
    """安全預設：未設定提供者時絕不進行網路呼叫。"""

    provider_name = "disabled"

    async def propose(self, character: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
        raise ModelConfigurationError("AI 模型尚未啟用。請在 .env 設定 EMOSIM_MODEL_PROVIDER。")

    async def interact(self, prompt: str) -> dict[str, Any]:
        raise ModelConfigurationError("AI 模型尚未啟用。請在 .env 設定 EMOSIM_MODEL_PROVIDER。")


class OllamaModel:
    """保留本機 Ollama 作為無雲端金鑰的選項。"""

    provider_name = "ollama"

    def __init__(self, model: str, base_url: str) -> None:
        self.model = model
        self.base_url = base_url.rstrip("/")

    async def _request_json(self, prompt: str) -> dict[str, Any]:
        payload = {
            "model": self.model,
            "stream": False,
            "format": "json",
            "messages": [{"role": "user", "content": prompt}],
        }
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(f"{self.base_url}/api/chat", json=payload)
                response.raise_for_status()
            text = response.json()["message"]["content"]
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            raise ModelResponseError(f"Ollama 提案失敗：{exc}") from exc
        return parse_json_object_text(text)

    async def propose(self, character: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
        return await self._request_json(build_state_proposal_prompt(character, event))

    async def interact(self, prompt: str) -> dict[str, Any]:
        return await self._request_json(prompt)


class GeminiModel:
    """使用官方 google-genai SDK 的 Gemini Developer API 提供者。"""

    provider_name = "gemini"

    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def _generate(self, prompt: str, response_schema: dict[str, Any] | None = None) -> str:
        # 延遲匯入：使用 disabled 或 Ollama 時不要求安裝雲端 SDK。
        try:
            from google import genai
        except ImportError as exc:
            raise ModelConfigurationError("缺少 google-genai。請重新執行 start.bat 安裝相依套件。") from exc
        client = genai.Client(api_key=self.api_key)
        try:
            interaction = client.interactions.create(
                model=self.model,
                input=prompt,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": response_schema or STATE_PROPOSAL_RESPONSE_SCHEMA,
                },
            )
        except Exception as exc:  # SDK 的傳輸例外類型可能隨版本調整。
            raise ModelResponseError(f"Gemini 提案失敗：{exc}") from exc
        if not isinstance(interaction.output_text, str) or not interaction.output_text.strip():
            raise ModelResponseError("Gemini 沒有產生文字提案。")
        return interaction.output_text

    async def propose(self, character: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
        return parse_state_proposal_text(await asyncio.to_thread(self._generate, build_state_proposal_prompt(character, event)))

    async def interact(self, prompt: str) -> dict[str, Any]:
        response = await asyncio.to_thread(self._generate, prompt, CHAT_RESPONSE_SCHEMA)
        return parse_json_object_text(response)


def get_configured_model() -> CharacterModel:
    """由環境設定選擇模型；不回傳或記錄 API 金鑰。"""
    provider = os.getenv("EMOSIM_MODEL_PROVIDER", "disabled").strip().lower()
    if provider in {"", "disabled", "none"}:
        return DisabledModel()
    if provider == "ollama":
        return OllamaModel(
            model=os.getenv("EMOSIM_OLLAMA_MODEL", "qwen3:latest"),
            base_url=os.getenv("EMOSIM_OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
        )
    if provider == "gemini":
        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise ModelConfigurationError("缺少 GEMINI_API_KEY。請填入 .env 或設定環境變數。")
        return GeminiModel(api_key, os.getenv("EMOSIM_GEMINI_MODEL", DEFAULT_GEMINI_MODEL))
    raise ModelConfigurationError("EMOSIM_MODEL_PROVIDER 只能是 disabled、ollama 或 gemini。")
