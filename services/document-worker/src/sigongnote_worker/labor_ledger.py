"""C36 labor-ledger-v1 copy adapter. Only an API-approved snapshot supplies money.

The adapter never changes the source workbook. It returns bytes for C37's
atomic artifact publisher and a sidecar for source and reconciliation evidence.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from datetime import date
from pathlib import Path

import openpyxl
import xlrd
from openpyxl.packaging.custom import StringProperty

from .spreadsheet import _xlsx_envelope

# Template copy materialization keeps its existing bound independently of streaming ingestion.
MAX_INPUT = 30 * 1024 * 1024

ADAPTER_VERSION = "labor-ledger-v1/1.0.0"
HEADER_ROW = 3
FIRST_DATA_ROW = 4
LAST_DATA_ROW = 301
HEADER_VALUES = ("일자", "현장", "품명/작업구분", "위치/작업범위", "작업내용",
                 "단위", "산정수량", "단가", "금액")
_MONEY = re.compile(r"^(0|[1-9][0-9]{0,14})$")
_COUNT = re.compile(r"^[1-9][0-9]{0,11}$")


class ExportBlocked(ValueError):
    """A mismatch or unsafe workbook requires review; no artifact is produced."""


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _header_hash(values: tuple[object, ...]) -> str:
    return _sha(_canonical(["" if value is None else str(value).strip() for value in values]))


def inspect_labor_template(path: Path) -> list[dict]:
    """Enrollment aid: human confirms sheet and A:I semantics before approval."""
    path = Path(path)
    if path.stat().st_size > MAX_INPUT:
        raise ExportBlocked("SOURCE_TOO_LARGE")
    if path.suffix.lower() == ".xlsx":
        _xlsx_envelope(path)
        book = openpyxl.load_workbook(path, read_only=True, data_only=False,
                                      keep_links=False)
        try:
            return [{"sheet": sheet.title,
                     "header_fingerprint": _header_hash(tuple(
                         sheet.cell(HEADER_ROW, col).value for col in range(1, 10))),
                     "header_values": [sheet.cell(HEADER_ROW, col).value
                                       for col in range(1, 10)]}
                    for sheet in book.worksheets]
        finally:
            book.close()
    if path.suffix.lower() == ".xls":
        book = xlrd.open_workbook(path, on_demand=True)
        try:
            return [{"sheet": sheet.name,
                     "header_fingerprint": _header_hash(tuple(
                         sheet.cell_value(HEADER_ROW - 1, col)
                         if sheet.nrows >= HEADER_ROW and sheet.ncols > col
                         else None for col in range(9))),
                     "header_values": [sheet.cell_value(HEADER_ROW - 1, col)
                                       if sheet.nrows >= HEADER_ROW and sheet.ncols > col else None
                                       for col in range(9)]}
                    for sheet in book.sheets()]
        finally:
            book.release_resources()
    raise ExportBlocked("UNSUPPORTED_TEMPLATE_FORMAT")


def _approved_rows(snapshot: dict) -> tuple[list[tuple[object, ...]], list[dict]]:
    bundles = snapshot.get("bundles")
    if not isinstance(bundles, list) or not bundles:
        raise ExportBlocked("APPROVED_BUNDLES_REQUIRED")
    rows: list[tuple[object, ...]] = []
    references: list[dict] = []
    seen: set[str] = set()
    for bundle in bundles:
        if not isinstance(bundle, dict) or not isinstance(bundle.get("charge_case_id"), str):
            raise ExportBlocked("INVALID_APPROVED_BUNDLE")
        charge_id = bundle["charge_case_id"]
        if charge_id in seen:
            raise ExportBlocked("DUPLICATE_CHARGE_CASE")
        seen.add(charge_id)
        amount = bundle.get("amount_minor")
        quantity = bundle.get("billing_quantity")
        if not isinstance(amount, str) or not _MONEY.fullmatch(amount):
            raise ExportBlocked("INVALID_APPROVED_AMOUNT")
        if not isinstance(quantity, str) or not _COUNT.fullmatch(quantity):
            raise ExportBlocked("INVALID_BILLING_QUANTITY")
        if bundle.get("unit") not in ("식", "일", "EA", "m²", "장"):
            raise ExportBlocked("UNKNOWN_UNIT")
        work_items = bundle.get("work_items")
        if not isinstance(work_items, list) or not work_items:
            raise ExportBlocked("WORK_ITEMS_REQUIRED")
        if not isinstance(bundle.get("project_label"), str) or not bundle["project_label"].strip() or not isinstance(
                bundle.get("work_type"), str) or not bundle["work_type"].strip():
            raise ExportBlocked("WORK_LABELS_REQUIRED")
        if bundle.get("payment_basis", "unknown") not in (
                "unknown", "ledger_marked", "user_supplied_statement"):
            raise ExportBlocked("INVALID_PAYMENT_BASIS")
        try:
            when = date.fromisoformat(bundle["work_date"])
        except (ValueError, TypeError, KeyError) as exc:
            raise ExportBlocked("INVALID_WORK_DATE") from exc
        for index, item in enumerate(work_items):
            if not isinstance(item, dict) or not isinstance(item.get("location"), str) or not isinstance(
                    item.get("description"), str):
                raise ExportBlocked("INVALID_WORK_ITEM")
            if not item["location"].strip() or not item["description"].strip():
                raise ExportBlocked("INVALID_WORK_ITEM")
            rows.append((when if index == 0 else None,
                         bundle.get("project_label") if index == 0 else None,
                         bundle.get("work_type") if index == 0 else None,
                         item["location"], item["description"],
                         bundle["unit"] if index == 0 else None,
                         int(quantity) if index == 0 else None,
                         None, int(amount) if index == 0 else None))
            references.append({"charge_case_id": charge_id,
                               "work_item_index": index,
                               "evidence_ids": bundle.get("evidence_ids", []),
                               "payment_basis": bundle.get("payment_basis", "unknown")})
    return rows, references


def _standard_book() -> tuple[openpyxl.Workbook, openpyxl.worksheet.worksheet.Worksheet]:
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "공임"
    for column, value in enumerate(HEADER_VALUES, 1):
        sheet.cell(HEADER_ROW, column, value)
    return book, sheet


def _safe_copy_package(original: bytes) -> bool:
    safe_parts = {"[Content_Types].xml", "_rels/.rels", "docProps/app.xml",
                  "docProps/core.xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
                  "xl/styles.xml", "xl/sharedStrings.xml"}
    unsafe_xml = (b"<extLst", b"<dataValidations", b"<conditionalFormatting",
                  b"<hyperlinks", b"<drawing", b"<legacyDrawing", b"<tableParts",
                  b"<controls", b"<oleObjects", b"<definedName ", b"x14:",
                  b"<r>", b"<r ")
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        for name in archive.namelist():
            if name not in safe_parts and not re.fullmatch(
                    r"xl/(worksheets/sheet[0-9]+|theme/theme[0-9]+)\.xml", name):
                return False
            if name.endswith(".xml") and name.startswith("xl/"):
                content = archive.read(name)
                if any(marker in content for marker in unsafe_xml):
                    return False
    return True


def build_labor_ledger(template_path: Path, expected_source_sha256: str,
                       header_fingerprint: str, approved_snapshot: dict,
                       expected_snapshot_sha256: str, batch_id: str) -> tuple[bytes, dict, dict]:
    """Return XLSX bytes, sidecar, manifest; C37 will publish them atomically."""
    source = Path(template_path)
    if not re.fullmatch(r"[0-9a-f]{64}", expected_source_sha256) or not re.fullmatch(
            r"[0-9a-f]{64}", expected_snapshot_sha256) or not re.fullmatch(
            r"[0-9a-f]{64}", header_fingerprint):
        raise ExportBlocked("INVALID_HASH_CONTRACT")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", batch_id):
        raise ExportBlocked("INVALID_BATCH_ID")
    original = source.read_bytes()
    if len(original) > MAX_INPUT or _sha(original) != expected_source_sha256:
        raise ExportBlocked("SOURCE_HASH_CONFLICT")
    if _sha(_canonical(approved_snapshot)) != expected_snapshot_sha256:
        raise ExportBlocked("SNAPSHOT_HASH_CONFLICT")
    if approved_snapshot.get("adapter_version") != ADAPTER_VERSION or not approved_snapshot.get(
            "approval_decision_id"):
        raise ExportBlocked("APPROVED_SNAPSHOT_REQUIRED")
    matches = [item for item in inspect_labor_template(source)
               if item["header_fingerprint"] == header_fingerprint]
    if len(matches) != 1:
        raise ExportBlocked("HEADER_FINGERPRINT_MISMATCH")
    rows, references = _approved_rows(approved_snapshot)
    if len(rows) > LAST_DATA_ROW - FIRST_DATA_ROW + 1:
        raise ExportBlocked("LEDGER_ROW_LIMIT")
    output_mode = "standard_snapshot_only"
    limitations: list[str] = []
    book = None
    sheet = None
    first_row = FIRST_DATA_ROW
    if source.suffix.lower() == ".xlsx":
        if _safe_copy_package(original):
            candidate = openpyxl.load_workbook(io.BytesIO(original), data_only=False,
                                               keep_links=False)
            target = candidate[matches[0]["sheet"]]
            formulas = any(cell.data_type == "f" for part in candidate.worksheets
                           for cell in part._cells.values())
            occupied = [row for row in range(FIRST_DATA_ROW, LAST_DATA_ROW + 1)
                        if any(target.cell(row, col).value is not None for col in range(1, 10))]
            first_row = max(occupied, default=FIRST_DATA_ROW - 1) + 1
            overlapping = any(target.cell(row, col).value is not None or
                              any(target.cell(row, col).coordinate in merged
                                  for merged in target.merged_cells.ranges)
                              for row in range(first_row, min(first_row + len(rows), LAST_DATA_ROW + 1))
                              for col in range(1, 10))
            if not formulas and not overlapping and first_row + len(rows) - 1 <= LAST_DATA_ROW:
                book, sheet = candidate, target
                output_mode = "template_copy"
            else:
                candidate.close()
                limitations.append("template_formula_or_cell_conflict")
        else:
            limitations.append("template_features_not_safe_to_preserve")
    else:
        limitations.append("xls_template_not_written")
    if book is None or sheet is None:
        book, sheet = _standard_book()
        first_row = FIRST_DATA_ROW
    changed_cells: list[str] = []
    format_changed_cells: list[str] = []
    for offset, values in enumerate(rows):
        row_number = first_row + offset
        for column, value in enumerate(values, 1):
            if value is not None:
                cell = sheet.cell(row_number, column)
                if cell.value is not None or cell.data_type == "f":
                    raise ExportBlocked("TARGET_CELL_NOT_EMPTY")
                cell.value = value
                if isinstance(value, str):
                    cell.data_type = "s"
                    cell.quotePrefix = True
                elif column in (7, 9):
                    if cell.number_format != "#,##0":
                        format_changed_cells.append(cell.coordinate)
                    cell.number_format = "#,##0"
                changed_cells.append(cell.coordinate)
    for name, value in (("sigongnote_generated", "true"), ("sigongnote_batch_id", batch_id),
                        ("sigongnote_adapter_version", ADAPTER_VERSION)):
        book.custom_doc_props.append(StringProperty(name=name, value=value))
    output = io.BytesIO()
    book.save(output)
    book.close()
    payload = output.getvalue()
    reopened = openpyxl.load_workbook(io.BytesIO(payload), data_only=False, read_only=False)
    try:
        target = reopened[sheet.title]
        if any(cell.data_type == "f" for part in reopened.worksheets
               for cell in part._cells.values()):
            raise ExportBlocked("OUTPUT_FORMULA_PRESENT")
        if (reopened.custom_doc_props["sigongnote_generated"].value != "true" or
                reopened.custom_doc_props["sigongnote_batch_id"].value != batch_id):
            raise ExportBlocked("OUTPUT_ORIGIN_TAG_MISSING")
        for offset, values in enumerate(rows):
            for column, value in enumerate(values, 1):
                actual = target.cell(first_row + offset, column).value
                same = actual.date() == value if isinstance(value, date) and hasattr(
                    actual, "date") else value == actual
                if not same:
                    raise ExportBlocked("OUTPUT_REOPEN_MISMATCH")
                if column in (7, 9) and value is not None and target.cell(
                        first_row + offset, column).number_format != "#,##0":
                    raise ExportBlocked("OUTPUT_FORMAT_MISMATCH")
        if sum(int(item[8]) for item in rows if item[8] is not None) != sum(
                int(bundle["amount_minor"]) for bundle in approved_snapshot["bundles"]):
            raise ExportBlocked("OUTPUT_TOTAL_MISMATCH")
    finally:
        reopened.close()
    if _sha(source.read_bytes()) != expected_source_sha256:
        raise ExportBlocked("SOURCE_CHANGED_DURING_EXPORT")
    sidecar = {"batch_id": batch_id, "adapter_version": ADAPTER_VERSION,
               "source_sha256": expected_source_sha256,
               "approval_decision_id": approved_snapshot["approval_decision_id"],
               "rows": [{"excel_row": first_row + index, **reference}
                        for index, reference in enumerate(references)],
               "unknown_source_columns_written": [], "bank_transfer_verified": False}
    manifest = {"batch_id": batch_id, "generated_by": "sigongnote_export",
                "adapter_version": ADAPTER_VERSION, "source_sha256": expected_source_sha256,
                "snapshot_sha256": expected_snapshot_sha256,
                "header_fingerprint": header_fingerprint, "output_sha256": _sha(payload),
                "sidecar_sha256": _sha(_canonical(sidecar)), "sheet": sheet.title,
                "output_mode": output_mode, "first_written_row": first_row,
                "row_count": len(rows), "written_cells": changed_cells,
                "format_changed_cells": format_changed_cells,
                "limitations": limitations, "formula_status": "numeric_snapshot_only"}
    return payload, sidecar, manifest
