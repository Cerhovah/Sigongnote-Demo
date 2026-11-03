"""Validate wire shapes only. The worker never confirms business facts or money."""
import json
import re
from importlib.resources import files
from jsonschema import Draft202012Validator, FormatChecker, validators, ValidationError

def _ascii_pattern(validator, pattern, instance, schema):
    if not isinstance(instance, str):
        return
    # Our generated ECMA patterns use ASCII digits and absolute end assertions.
    strict = pattern[:-1] + r"\Z" if pattern.endswith("$") and not pattern.endswith(r"\$") else pattern
    if re.search(strict, instance, flags=re.ASCII) is None:
        yield ValidationError("INVALID_CONTRACT")

_Validator = validators.extend(Draft202012Validator, {"pattern": _ascii_pattern})

_schemas = json.loads(files("sigongnote_worker").joinpath("generated/schema.json").read_text(encoding="utf-8"))["$defs"]

def validate_wire(name: str, value: object) -> None:
    """Reject invalid wire data without returning input or validator internals."""
    schema = _schemas.get(name)
    if schema is None:
        raise ValueError("INVALID_CONTRACT")
    validator = _Validator(schema, format_checker=FormatChecker())
    if not validator.is_valid(value):
        raise ValueError("INVALID_CONTRACT")
