"""Exercise the real stdin/stdout worker boundary, including command recovery."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


def _run(lines):
    source = Path(__file__).resolve().parents[1] / "src"
    process = subprocess.run(
        [sys.executable, "-m", "sigongnote_worker"],
        input="\n".join(lines) + "\n", text=True, encoding="utf-8",
        capture_output=True, timeout=30, check=True,
        env={"PYTHONPATH": str(source), "PYTHONIOENCODING": "utf-8",
             **{key: os.environ[key] for key in ("PATH", "SystemRoot") if key in os.environ}},
    )
    return process, [json.loads(line) for line in process.stdout.splitlines()]


def test_bad_commands_do_not_leak_paths_or_prevent_the_next_document(tmp_path):
    source = tmp_path / "valid.txt"
    source.write_text("합성 현장 자재 12개", encoding="utf-8")
    missing = tmp_path / "synthetic-private-name.txt"
    output = tmp_path / "result.json"
    process, replies = _run([
        "{", "[]", "{}",
        json.dumps({"path": str(missing), "output": str(output)}),
        json.dumps({"path": str(source), "output": str(output)}),
    ])
    assert len(replies) == 5
    for reply in replies[:4]:
        assert reply["status"] == "failed"
        assert reply["issues"] == ["parser_failed"]
        assert reply["spans"] == []
    assert str(tmp_path) not in process.stdout + process.stderr
    assert missing.name not in process.stdout + process.stderr
    assert replies[-1]["status"] == "complete"
    assert replies[-1]["spans"] == [{"text": "합성 현장 자재 12개", "locator": "line:1"}]
    assert json.loads(output.read_text(encoding="utf-8"))["status"] == "complete"


@pytest.mark.parametrize("encoding", ["utf-8-sig", "cp949"])
def test_text_encodings_preserve_original_bytes_hash_and_line_locations(tmp_path, encoding):
    source = tmp_path / "korean.txt"
    raw = "\n합성 현장\n\n자재 12개\n".encode(encoding)
    source.write_bytes(raw)
    output = tmp_path / "result.json"
    _, replies = _run([json.dumps({"path": str(source), "output": str(output)})])
    assert source.read_bytes() == raw
    assert replies[0]["sourceHash"] == hashlib.sha256(raw).hexdigest()
    assert replies[0]["coverage"] == {"lines_read": 2}
    assert replies[0]["spans"] == [
        {"text": "합성 현장", "locator": "line:2"},
        {"text": "자재 12개", "locator": "line:4"},
    ]
    assert json.loads(output.read_text(encoding="utf-8"))["source_sha256"] == replies[0]["sourceHash"]


def test_invalid_pdf_returns_a_machine_code_and_original_hash(tmp_path):
    source = tmp_path / "synthetic-private-content.pdf"
    raw = b"synthetic private document content"
    source.write_bytes(raw)
    process, replies = _run([json.dumps({"path": str(source), "output": str(tmp_path / "result.json")})])
    assert replies[0]["status"] == "failed"
    assert replies[0]["issues"] == ["INVALID_PDF_ENVELOPE"]
    assert replies[0]["sourceHash"] == hashlib.sha256(raw).hexdigest()
    assert source.read_bytes() == raw
    assert source.name not in process.stdout + process.stderr
    assert raw.decode() not in process.stdout + process.stderr
