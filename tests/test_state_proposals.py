import sys
import types

import pytest

from app.model_interface import GeminiModel, get_configured_model, parse_state_proposal_text
from app.schemas import new_character
from app.state_proposals import apply_state_proposal, validate_state_proposal


def test_valid_proposal_is_applied_only_to_state():
    character = new_character("布萊克")
    proposal = {
        "summary": "警戒感升高。",
        "state_patch": {"mood": {"valence": -20}, "psychological": {"anxiety": 68}},
    }
    updated = apply_state_proposal(character, proposal)
    assert updated["state"]["mood"]["valence"] == -20
    assert updated["state"]["psychological"]["anxiety"] == 68
    assert updated["profile"] == character["profile"]
    assert updated["state"]["last_updated"] is not None


def test_manual_response_parser_accepts_a_single_json_code_block():
    response = """```json
    {"summary":"稍微放鬆。","state_patch":{"mood":{"arousal":28}}}
    ```"""
    parsed = parse_state_proposal_text(response)
    assert validate_state_proposal(parsed)["state_patch"]["mood"]["arousal"] == 28


@pytest.mark.parametrize(
    "proposal",
    [
        {"summary": "x", "state_patch": {"profile": {"name": "遭竄改"}}},
        {"summary": "x", "state_patch": {"mood": {"valence": 101}}},
        {"summary": "x", "state_patch": {"psychological": {"memory": 1}}},
        {"summary": "x", "state_patch": {"emotions": {"fear": "high"}}},
    ],
)
def test_invalid_or_unsafe_proposals_are_rejected(proposal):
    with pytest.raises(ValueError):
        validate_state_proposal(proposal)


def test_provider_selection_does_not_require_network(monkeypatch):
    monkeypatch.setenv("EMOSIM_MODEL_PROVIDER", "ollama")
    assert get_configured_model().provider_name == "ollama"
    monkeypatch.setenv("EMOSIM_MODEL_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-not-used")
    model = get_configured_model()
    assert model.provider_name == "gemini"
    assert model.model == "gemini-3.8-flash"


def test_gemini_provider_uses_structured_interaction_without_network(monkeypatch):
    captured = {}

    class FakeInteractions:
        def create(self, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(output_text='{"summary":"ok","state_patch":{"mood":{"arousal":42}}}')

    class FakeClient:
        def __init__(self, *, api_key):
            captured["api_key"] = api_key
            self.interactions = FakeInteractions()

    fake_google = types.ModuleType("google")
    fake_google.genai = types.SimpleNamespace(Client=FakeClient)
    monkeypatch.setitem(sys.modules, "google", fake_google)
    result = GeminiModel("secret-never-sent", "gemini-test")._generate("test prompt")

    assert '"summary":"ok"' in result
    assert captured["model"] == "gemini-test"
    assert captured["response_format"]["mime_type"] == "application/json"
