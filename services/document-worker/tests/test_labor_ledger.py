from __future__ import annotations

import hashlib
import io
import json
import uuid

import openpyxl
import pytest
import xlwt

from sigongnote_worker.labor_ledger import (
    ADAPTER_VERSION, ExportBlocked, build_labor_ledger, inspect_labor_template,
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def snapshot() -> dict:
    return {"adapter_version": ADAPTER_VERSION, "approval_decision_id": str(uuid.uuid4()),
            "bundles": [{"charge_case_id": str(uuid.uuid4()), "amount_minor": "150000",
                         "billing_quantity": "1", "unit": "식", "work_date": "2026-09-01",
                         "project_label": "합성 현장", "work_type": "목창호 공임",
                         "evidence_ids": [str(uuid.uuid4())], "payment_basis": "ledger_marked",
                         "work_items": [{"location": "+SUM(1,2)" if number == 2 else f"합성 {number}",
                                         "description": "=HYPERLINK(\"https://example.invalid\",\"열기\")"
                                         if number == 1 else "@SUM(1,2)" if number == 3 else "문틀 설치"}
                                        for number in range(1, 5)]}]}


def make_template(path, formula=False):
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "공임장부"
    for column, label in enumerate(("일자", "현장", "품목", "위치", "색상", "단위",
                                    "산정수량", "단가", "금액"), 1):
        sheet.cell(3, column, label)
    sheet["J4"] = "뜻을 모르는 열"
    sheet["L4"] = "원문 보존"
    sheet["I4"].number_format = "yyyy-mm-dd"
    if formula:
        sheet["I4"] = "=SUM(G4*H4)"
    book.save(path)
    book.close()


@pytest.mark.spreadsheet
def test_labor_copy_writes_amount_once_and_keeps_unknown_columns(tmp_path):
    source = tmp_path / "synthetic-labor.xlsx"
    make_template(source)
    original = source.read_bytes()
    source_hash = digest(original)
    header = inspect_labor_template(source)[0]["header_fingerprint"]
    approved = snapshot()
    approval_hash = digest(json.dumps(approved, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode())
    data, sidecar, manifest = build_labor_ledger(
        source, source_hash, header, approved, approval_hash, str(uuid.uuid4()))
    assert source.read_bytes() == original
    assert manifest["output_mode"] == "template_copy"
    assert manifest["output_sha256"] == digest(data)
    assert "I4" in manifest["format_changed_cells"]
    assert sidecar["bank_transfer_verified"] is False
    assert all(not address.startswith(("J", "K", "L")) for address in manifest["written_cells"])
    book = openpyxl.load_workbook(io.BytesIO(data))
    sheet = book["공임장부"]
    assert [sheet[f"I{row}"].value for row in range(4, 8)] == [150000, None, None, None]
    assert [sheet[f"F{row}"].value for row in range(4, 8)] == ["식", None, None, None]
    assert [sheet[f"G{row}"].value for row in range(4, 8)] == [1, None, None, None]
    assert sheet["H4"].value is None
    assert sheet["I4"].number_format == "#,##0"
    assert sheet["E4"].data_type == "s"
    assert sheet["E4"].value.startswith("=HYPERLINK")
    assert sheet["D5"].data_type == "s"
    assert sheet["E6"].data_type == "s"
    assert all(cell.data_type != "f" for cell in sheet._cells.values())
    assert book.custom_doc_props["sigongnote_generated"].value == "true"
    assert book.custom_doc_props["sigongnote_batch_id"].value == manifest["batch_id"]
    assert sheet["J4"].value == "뜻을 모르는 열"
    assert sheet["L4"].value == "원문 보존"
    book.close()


@pytest.mark.spreadsheet
def test_formula_template_uses_independent_numeric_snapshot(tmp_path):
    source = tmp_path / "formula.xlsx"
    make_template(source, formula=True)
    original = source.read_bytes()
    approved = snapshot()
    approval_hash = digest(json.dumps(approved, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode())
    header = inspect_labor_template(source)[0]["header_fingerprint"]
    with pytest.raises(ExportBlocked, match="HEADER_FINGERPRINT_MISMATCH"):
        build_labor_ledger(source, digest(original), "0" * 64, approved,
                           approval_hash, str(uuid.uuid4()))
    data, _, manifest = build_labor_ledger(source, digest(original), header, approved,
                                           approval_hash, str(uuid.uuid4()))
    assert source.read_bytes() == original
    assert manifest["output_mode"] == "standard_snapshot_only"
    assert "template_formula_or_cell_conflict" in manifest["limitations"]
    book = openpyxl.load_workbook(io.BytesIO(data), data_only=False)
    assert book.active["I4"].value == 150000
    assert book.active["J4"].value is None
    book.close()


@pytest.mark.spreadsheet
def test_snapshot_and_source_hash_conflicts_stop_export(tmp_path):
    source = tmp_path / "source.xlsx"
    make_template(source)
    approved = snapshot()
    approval_hash = digest(json.dumps(approved, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode())
    header = inspect_labor_template(source)[0]["header_fingerprint"]
    with pytest.raises(ExportBlocked, match="SOURCE_HASH_CONFLICT"):
        build_labor_ledger(source, "0" * 64, header, approved, approval_hash, str(uuid.uuid4()))
    approved["bundles"][0]["amount_minor"] = "600000"
    with pytest.raises(ExportBlocked, match="SNAPSHOT_HASH_CONFLICT"):
        build_labor_ledger(source, digest(source.read_bytes()), header,
                           approved, approval_hash, str(uuid.uuid4()))


@pytest.mark.spreadsheet
def test_legacy_xls_creates_independent_xlsx_without_editing_source(tmp_path):
    source = tmp_path / "legacy.xls"
    book = xlwt.Workbook()
    sheet = book.add_sheet("공임")
    for column, label in enumerate(("일자", "현장", "품목", "위치", "색상", "단위",
                                    "산정수량", "단가", "금액")):
        sheet.write(2, column, label)
    book.save(str(source))
    original = source.read_bytes()
    approved = snapshot()
    approval_hash = digest(json.dumps(approved, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode())
    header = inspect_labor_template(source)[0]["header_fingerprint"]
    data, _, manifest = build_labor_ledger(source, digest(original), header, approved,
                                           approval_hash, str(uuid.uuid4()))
    assert source.read_bytes() == original
    assert manifest["output_mode"] == "standard_snapshot_only"
    assert "xls_template_not_written" in manifest["limitations"]
    xlsx = openpyxl.load_workbook(io.BytesIO(data))
    assert xlsx.active["I4"].value == 150000
    xlsx.close()
