import pytest

from app.relationships import new_relationship, validate_relationship


def test_relationship_has_all_five_dimensions_and_validates():
    relationship = new_relationship("維伊")
    payload = {key: relationship[key] for key in ("target_name", "target_type", "dimensions", "notes")}
    validated = validate_relationship(payload, relationship_id=relationship["relationship_id"])
    assert validated["target_name"] == "維伊"
    assert set(validated["dimensions"]) == {"trust", "intimacy", "safety", "dependence", "wariness"}


@pytest.mark.parametrize(
    "dimensions",
    [
        {"trust": 50},
        {"trust": 50, "intimacy": 50, "safety": 50, "dependence": 50, "wariness": 101},
    ],
)
def test_relationship_rejects_incomplete_or_out_of_range_dimensions(dimensions):
    with pytest.raises(ValueError):
        validate_relationship({"target_name": "某人", "target_type": "person", "dimensions": dimensions, "notes": ""})
