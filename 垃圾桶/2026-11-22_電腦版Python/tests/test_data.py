"""可在任何環境執行的第一階段資料層測試。"""
import sqlite3

from app.repository import CharacterRepository
from app.schemas import DEFAULT_MEMORY_SETTINGS, new_character, new_module, normalize


def test_character_document_normalizes_and_clamps_default_state():
    character = new_character("羅爾")
    character["state"]["mood"] = {"valence": 999, "arousal": -2}
    character["state"]["psychological"] = {"security": 120, "anxiety": -3}
    character["modules"].append(new_module("personality"))
    normalized = normalize(character)

    assert normalized["profile"]["name"] == "羅爾"
    assert normalized["modules"][0]["name"] == "人格特質"
    assert normalized["state"]["mood"] == {"valence": 100.0, "arousal": 0.0}
    assert normalized["state"]["psychological"]["security"] == 100.0
    assert normalized["state"]["psychological"]["anxiety"] == 0.0


def test_sqlite_round_trip_and_independent_import_id(tmp_path):
    repository = CharacterRepository(tmp_path / "characters.db")
    saved = repository.save(normalize(new_character("維伊")))
    stored = repository.get(saved["character_id"])
    assert stored["profile"]["name"] == "維伊"

    imported = normalize(stored, generate_id=True)
    repository.save(imported)
    assert imported["character_id"] != saved["character_id"]
    assert len(repository.list()) == 2
    assert repository.delete(saved["character_id"]) is True
    assert repository.get(saved["character_id"]) is None


def test_invalid_module_data_is_rejected():
    invalid = new_character()
    invalid["modules"] = [{"module_id": "m1", "data": ["not an object"]}]
    try:
        normalize(invalid)
    except ValueError as error:
        assert "module.data" in str(error)
    else:
        raise AssertionError("module.data array should be rejected")


def test_confirmed_interaction_is_saved_with_the_character(tmp_path):
    repository = CharacterRepository(tmp_path / "characters.db")
    character = repository.save(normalize(new_character("蘿拉")))
    repository.save_interaction_turn(
        character,
        contract_version="chat_turn/v0.2",
        user_message="今天過得怎麼樣？",
        character_reply="還算平靜。",
        state_proposal={"summary": "放鬆。", "state_patch": {"mood": {"arousal": 25}}},
        memory_candidates=[{"summary": "問候帶來安心感。", "importance": "ordinary", "reason": "本回合確認保存。"}],
    )
    turns = repository.list_interaction_turns(character["character_id"])
    assert len(turns) == 1
    assert turns[0]["user_message"] == "今天過得怎麼樣？"
    assert turns[0]["state_proposal"]["state_patch"]["mood"]["arousal"] == 25
    assert turns[0]["memory_candidates"][0]["summary"] == "問候帶來安心感。"
    assert repository.delete(character["character_id"]) is True
    assert repository.list_interaction_turns(character["character_id"]) == []


def test_existing_v01_interaction_table_gains_memory_column(tmp_path):
    database_path = tmp_path / "characters.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE interaction_turns (
                id TEXT PRIMARY KEY, character_id TEXT NOT NULL, contract_version TEXT NOT NULL,
                user_message TEXT NOT NULL, character_reply TEXT NOT NULL,
                state_proposal_json TEXT, created_at TEXT NOT NULL
            )
            """
        )
    CharacterRepository(database_path)
    with sqlite3.connect(database_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(interaction_turns)")}
    assert "memory_candidates_json" in columns


def test_memory_settings_default_and_validation_are_backward_compatible():
    character = new_character("北")
    assert character["memory_settings"] == DEFAULT_MEMORY_SETTINGS
    legacy = new_character("舊角色")
    legacy.pop("memory_settings")
    assert normalize(legacy)["memory_settings"] == DEFAULT_MEMORY_SETTINGS
    invalid = new_character("設定錯誤")
    invalid["memory_settings"]["ordinary"]["max_items"] = 0
    try:
        normalize(invalid)
    except ValueError as error:
        assert "max_items" in str(error)
    else:
        raise AssertionError("invalid memory limit should be rejected")


def test_module_text_is_kept_and_old_modules_get_empty_text():
    character = new_character()
    module = new_module("free"); module["text"] = "話不多，但很會觀察人。"
    old_style = {"module_id": "m_old", "type": "values", "name": "價值觀", "enabled": True, "data": {"核心": "誠實"}, "notes": ""}
    character["modules"] = [module, old_style]
    normalized = normalize(character)
    assert normalized["modules"][0]["name"] == "自由描述"
    assert normalized["modules"][0]["text"] == "話不多，但很會觀察人。"
    assert normalized["modules"][1]["text"] == ""
    assert normalized["modules"][1]["data"] == {"核心": "誠實"}


def test_prompt_only_includes_enabled_modules_with_content():
    from app.model_interface import character_for_prompt
    character = new_character()
    written = new_module("personality"); written["text"] = "溫和、慢熱。"
    empty = new_module("values")
    turned_off = new_module("trauma"); turned_off["text"] = "小時候被丟下過。"; turned_off["enabled"] = False
    old_style = new_module("goals"); old_style["data"] = {"目標": "存錢開店"}
    character["modules"] = [written, empty, turned_off, old_style]
    view = character_for_prompt(character)
    assert [item["name"] for item in view["modules"]] == ["人格特質", "需求與目標"]
    assert view["modules"][0]["text"] == "溫和、慢熱。"
    assert character["modules"][1]["name"] == "價值觀"  # 原本的資料沒被改動
