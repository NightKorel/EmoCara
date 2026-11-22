import pytest

from app.interactions import apply_chat_response, validate_chat_response, validate_user_message
from app.schemas import new_character


def test_chat_response_preserves_reply_and_applies_only_valid_state_proposal():
    character = new_character("羅爾")
    updated, response, selected = apply_chat_response(
        character,
        {
            "reply": "我想先想一想。",
            "state_proposal": {"summary": "警戒感略升。", "state_patch": {"psychological": {"anxiety": 42}}},
            "memory_candidates": [{"summary": "對方願意等待。", "importance": "ordinary", "reason": "這次互動明確提及。"}],
        },
        [{"summary": "對方願意等待。", "importance": "ordinary", "reason": "這次互動明確提及。"}],
    )
    assert response["reply"] == "我想先想一想。"
    assert updated["state"]["psychological"]["anxiety"] == 42
    assert updated["profile"] == character["profile"]
    assert selected[0]["importance"] == "ordinary"
    assert updated["memories"][0]["summary"] == "對方願意等待。"


@pytest.mark.parametrize(
    "response",
    [
        {"reply": "x", "state_proposal": None, "memory_candidates": [], "profile": {}},
        {"reply": "", "state_proposal": None, "memory_candidates": []},
        {"reply": "x", "state_proposal": {"summary": "x", "state_patch": {"profile": {}}}, "memory_candidates": []},
    ],
)
def test_chat_response_rejects_unknown_or_unsafe_fields(response):
    with pytest.raises(ValueError):
        validate_chat_response(response)


def test_user_message_must_be_nonempty_text():
    assert validate_user_message("  你好  ") == "你好"
    with pytest.raises(ValueError):
        validate_user_message("  ")


def test_v01_chat_response_remains_compatible_without_memory_candidates():
    response = validate_chat_response({"reply": "舊格式仍可使用。", "state_proposal": None})
    assert response["memory_candidates"] == []


def test_unoffered_memory_candidate_cannot_be_saved():
    with pytest.raises(ValueError, match="只能保存"):
        apply_chat_response(
            new_character("維伊"),
            {"reply": "嗯。", "state_proposal": None, "memory_candidates": []},
            [{"summary": "不存在的候選項", "importance": "ordinary", "reason": "不應保存。"}],
        )


def test_memory_capacity_rejects_overflow_without_removing_existing_memories():
    character = new_character("羅爾")
    character["memory_settings"]["ordinary"] = {"max_items": 1, "max_chars": 40}
    character["memories"] = [{"summary": "已保存", "importance": "ordinary", "reason": "舊記憶"}]
    offered = {"summary": "新記憶", "importance": "ordinary", "reason": "本回合。"}
    with pytest.raises(ValueError, match="不會自動刪除"):
        apply_chat_response(
            character,
            {"reply": "嗯。", "state_proposal": None, "memory_candidates": [offered]},
            [offered],
        )
    assert character["memories"] == [{"summary": "已保存", "importance": "ordinary", "reason": "舊記憶"}]
