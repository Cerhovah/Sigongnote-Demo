from __future__ import annotations

import hashlib
import json
import uuid

import openpyxl
import pypdf
import pytest

import sigongnote_worker.export_batch as batch
from sigongnote_worker.labor_ledger import ADAPTER_VERSION, ExportBlocked, inspect_labor_template


def fixture(tmp_path):
    source = tmp_path / "source.xlsx"
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "공임"
    for column, label in enumerate(("일자", "현장", "작업", "위치", "내용", "단위",
                                    "산정수량", "단가", "금액"), 1):
        sheet.cell(3, column, label)
    book.save(source)
    book.close()
    original = source.read_bytes()
    snapshot = {"adapter_version": ADAPTER_VERSION, "approval_decision_id": str(uuid.uuid4()),
                "bundles": [{"charge_case_id": str(uuid.uuid4()), "amount_minor": "150000",
                             "billing_quantity": "1", "unit": "식", "work_date": "2026-09-01",
                             "project_label": "가명 현장", "work_type": "공임",
                             "work_items": [{"location": "가명 1", "description": "문틀 설치"}],
                             "payment_basis": "ledger_marked", "evidence_ids": [str(uuid.uuid4())]}]}
    fingerprint = inspect_labor_template(source)[0]["header_fingerprint"]
    snapshot_hash = hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode()).hexdigest()
    return source, original, fingerprint, snapshot, snapshot_hash


@pytest.mark.spreadsheet
def test_atomic_batch_replay_and_internal_pdf(tmp_path):
    source, original, fingerprint, snapshot, snapshot_hash = fixture(tmp_path)
    root = tmp_path / "published"
    batch_id = str(uuid.uuid4())
    args = (root, batch_id, source, hashlib.sha256(original).hexdigest(),
            fingerprint, snapshot, snapshot_hash)
    final, manifest = batch.publish_labor_batch(*args)
    assert final.is_dir()
    assert source.read_bytes() == original
    assert manifest["audience"] == "internal"
    assert manifest["output_sha256"] == hashlib.sha256(
        (final / "labor-ledger.xlsx").read_bytes()).hexdigest()
    pdf_reader = pypdf.PdfReader(final / "internal-packet.pdf")
    assert len(pdf_reader.pages) == 1
    assert f"sigongnote_generated=true;batch_id={batch_id}" in pdf_reader.metadata.keywords
    replay, replay_manifest = batch.publish_labor_batch(*args)
    assert replay == final and replay_manifest == manifest
    assert len(list(root.iterdir())) == 1
    changed = {**snapshot, "approval_decision_id": str(uuid.uuid4())}
    with pytest.raises(ExportBlocked, match="BATCH_ID_CONFLICT"):
        batch.publish_labor_batch(root, batch_id, source, hashlib.sha256(original).hexdigest(),
                                  fingerprint, changed, "0" * 64)


@pytest.mark.spreadsheet
def test_complete_temp_recovers_after_crash_before_rename(tmp_path, monkeypatch):
    source, original, fingerprint, snapshot, snapshot_hash = fixture(tmp_path)
    root = tmp_path / "published"
    batch_id = str(uuid.uuid4())
    real_commit = batch._commit_directory

    def crash_once(_source, _destination):
        raise OSError("synthetic crash before atomic rename")

    monkeypatch.setattr(batch, "_commit_directory", crash_once)
    with pytest.raises(OSError, match="synthetic crash"):
        batch.publish_labor_batch(root, batch_id, source, hashlib.sha256(original).hexdigest(),
                                  fingerprint, snapshot, snapshot_hash)
    assert not (root / batch_id).exists()
    monkeypatch.setattr(batch, "_commit_directory", real_commit)
    assert batch.recover_export_batches(root) == [{"batch_id": batch_id,
                                                    "status": "needs_source_recheck"}]
    assert batch.recover_export_batches(root, {batch_id: source}) == [
        {"batch_id": batch_id, "status": "recovered"}]
    assert (root / batch_id / "manifest.json").is_file()
    assert source.read_bytes() == original


@pytest.mark.spreadsheet
def test_incomplete_temp_is_visible_and_not_published(tmp_path):
    root = tmp_path / "published"
    root.mkdir()
    batch_id = str(uuid.uuid4())
    temp = root / f".{batch_id}.tmp-{uuid.uuid4()}"
    temp.mkdir()
    (temp / "labor-ledger.xlsx").write_bytes(b"partial")
    assert batch.recover_export_batches(root) == [{"batch_id": batch_id, "status": "incomplete"}]
    assert temp.is_dir() and not (root / batch_id).exists()


@pytest.mark.spreadsheet
def test_recovery_refuses_changed_source(tmp_path, monkeypatch):
    source, original, fingerprint, snapshot, snapshot_hash = fixture(tmp_path)
    root = tmp_path / "published"
    batch_id = str(uuid.uuid4())
    def crash(_source, _destination):
        raise OSError("synthetic crash")
    monkeypatch.setattr(batch, "_commit_directory", crash)
    with pytest.raises(OSError):
        batch.publish_labor_batch(root, batch_id, source, hashlib.sha256(original).hexdigest(),
                                  fingerprint, snapshot, snapshot_hash)
    source.write_bytes(original + b"modified")
    assert batch.recover_export_batches(root, {batch_id: source}) == [
        {"batch_id": batch_id, "status": "source_changed"}]
    assert not (root / batch_id).exists()
