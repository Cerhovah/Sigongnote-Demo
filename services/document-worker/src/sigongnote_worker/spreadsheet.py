"""Bounded, read-only spreadsheet evidence extraction.

Cells are source observations, never charges, tasks, or approved amounts.
Formula results are cached observations; neither engine evaluates formulas.
"""
from __future__ import annotations

import hashlib
import zipfile
import posixpath
import re
from datetime import date, datetime, time
from pathlib import Path

import openpyxl
import xlrd
import olefile
from defusedxml import ElementTree as SafeET
from openpyxl.utils import get_column_letter
from openpyxl.worksheet._reader import WorkSheetParser
from openpyxl.cell.read_only import ReadOnlyCell

VERSION = "spreadsheet-structure/1.2.0"
MAX_INPUT = 200 * 1024 * 1024
MAX_LEGACY_INPUT = 30 * 1024 * 1024
MAX_EXPANDED = 200 * 1024 * 1024
MAX_ARCHIVE_EXPANDED = 1024 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_SHEETS = 50
MAX_POPULATED_CELLS = 200_000
MAX_SHEET_XML = 64 * 1024 * 1024


class SpreadsheetLimit(ValueError):
    pass


def _value(value: object) -> object:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _source_hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _base(path: Path, kind: str) -> dict:
    return {
        "source_sha256": _source_hash(path),
        "format": kind, "parser_version": VERSION, "status": "failed",
        "supported_scope": "all worksheets, populated cells, merged ranges and cached values",
        "sheets": [], "issues": [],
        "coverage": {"sheets_seen": 0, "sheets_read": 0,
                     "populated_cells_seen": 0, "populated_cells_read": 0},
    }


def _finish(result: dict) -> dict:
    result["status"] = ("partial" if result["issues"] else "complete") if result["sheets"] else "failed"
    return result


def _xlsx_envelope(path: Path) -> list[str]:
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            # read_only + keep_links=False never loads images, embedded workbooks or
            # external-link caches. Bound the whole envelope and the XML actually read separately.
            ignored = ("xl/externalLinks/", "xl/media/", "xl/embeddings/")
            if (len(entries) > MAX_ENTRIES or sum(item.file_size for item in entries) > MAX_ARCHIVE_EXPANDED or
                    sum(item.file_size for item in entries if not item.filename.startswith(ignored)) > MAX_EXPANDED):
                raise ValueError("XLSX_EXPANSION_LIMIT")
            names = []
            xml_cells = 0
            for item in entries:
                name = item.filename.replace("\\", "/")
                if (name.startswith("/") or ".." in name.split("/") or
                        item.file_size > (MAX_ARCHIVE_EXPANDED if name.startswith(ignored) else MAX_EXPANDED) or
                        (item.file_size > 1024 * 1024 and item.file_size > item.compress_size * 1000)):
                    raise ValueError("UNSAFE_XLSX_ENTRY")
                names.append(name)
                if name.startswith("xl/worksheets/") and name.endswith(".xml"):
                    if item.file_size > MAX_SHEET_XML:
                        raise SpreadsheetLimit("sheet_xml_limit_exceeded")
                    with archive.open(item) as stream:
                        for _, element in SafeET.iterparse(stream, events=("end",)):
                            if element.tag.rsplit("}", 1)[-1] == "c":
                                xml_cells += 1
                                if xml_cells > MAX_POPULATED_CELLS:
                                    raise SpreadsheetLimit("cell_limit_exceeded")
                            element.clear()
            if "xl/workbook.xml" not in names or "[Content_Types].xml" not in names:
                raise ValueError("INVALID_XLSX_ENVELOPE")
            return names
    except zipfile.BadZipFile as exc:
        raise ValueError("INVALID_XLSX_ENVELOPE") from exc


def _raw_numeric_values(path: Path) -> dict:
    """Retain the XML decimal lexeme beside Python's approximate numeric value."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    result = {}
    with zipfile.ZipFile(path) as archive:
        relationships = SafeET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {r.attrib["Id"]: r.attrib["Target"] for r in relationships if r.attrib.get("TargetMode") != "External"}
        workbook = SafeET.fromstring(archive.read("xl/workbook.xml"))
        index = 0
        for sheet in workbook.findall("m:sheets/m:sheet", ns):
            target = targets.get(sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"))
            if target is None:
                continue
            name = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
            if not name.startswith("xl/worksheets/") or name not in archive.namelist():
                continue
            if index >= MAX_SHEETS:
                break
            with archive.open(name) as stream:
                for _, cell in SafeET.iterparse(stream, events=("end",)):
                    tag = cell.tag.rsplit("}", 1)[-1]
                    if tag == "c":
                        raw = cell.findtext("m:v", namespaces=ns)
                        if cell.attrib.get("t", "n") == "n" and raw and len(raw) < 100 and re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?", raw):
                            result[(index, cell.attrib.get("r"))] = raw
                        cell.clear()
                    elif tag == "row":
                        cell.clear()
            index += 1
    return result


def _xlsx(path: Path) -> dict:
    result = _base(path, "xlsx")
    try:
        names = _xlsx_envelope(path)
    except SpreadsheetLimit as exc:
        result["status"] = "partial"
        result["issues"].append({"code": str(exc), "locator": "workbook"})
        return result
    if any(name.startswith("xl/externalLinks/") for name in names):
        result["issues"].append({"code": "external_link_present", "locator": "workbook"})
    if any(name.endswith("vbaProject.bin") for name in names):
        result["issues"].append({"code": "macro_present_not_executed", "locator": "workbook"})
    raw_numbers = _raw_numeric_values(path)
    # keep_links=False avoids fetching or retaining external-workbook caches.
    formulas = openpyxl.load_workbook(path, data_only=False, read_only=True, keep_links=False)
    try:
        result["date_epoch"] = formulas.epoch.isoformat()
        result["coverage"]["sheets_seen"] = len(formulas.worksheets)
        if len(formulas.worksheets) > MAX_SHEETS:
            result["issues"].append({"code": "sheet_limit_exceeded", "locator": "workbook"})
            return result
        for index, sheet in enumerate(formulas.worksheets):
            locator = f"sheet:{index}"
            try:
                dimensions = sheet.calculate_dimension()
            except ValueError:
                dimensions = None
                result["issues"].append({"code": "dimension_unknown", "locator": locator})
            item = {"index": index, "name": sheet.title, "state": sheet.sheet_state,
                    "locator": locator, "dimensions": dimensions,
                    "merged_ranges": [],
                    "cells": [], "status": "complete" if dimensions else "partial"}
            # Parse sparse XML rows directly: read-only iter_rows fills distant styled
            # rectangles, while normal workbooks also load every embedded image.
            with sheet._get_source() as formula_xml, sheet._get_source() as cached_xml:
                def reader(stream, data_only):
                    return WorkSheetParser(stream, sheet._shared_strings, data_only=data_only,
                                           epoch=formulas.epoch, date_formats=formulas._date_formats,
                                           timedelta_formats=formulas._timedelta_formats)
                formula_reader, cache_reader = reader(formula_xml, False), reader(cached_xml, True)
                for (row, cells), (cache_row, cache_cells) in zip(formula_reader.parse(), cache_reader.parse(), strict=True):
                    if row != cache_row:
                        raise ValueError("XLSX_ROW_MISMATCH")
                    values = {c["column"]: c for c in cache_cells}
                    for data in cells:
                        if data["value"] is None:
                            continue
                        result["coverage"]["populated_cells_seen"] += 1
                        if result["coverage"]["populated_cells_seen"] > MAX_POPULATED_CELLS:
                            raise SpreadsheetLimit("cell_limit_exceeded")
                        cell = ReadOnlyCell(sheet, **data)
                        address = cell.coordinate
                        try:
                            number_format = cell.number_format
                        except IndexError:
                            # Invalid style IDs occur in exported business workbooks.
                            # Keep the numeric lexeme; do not infer its date/currency format.
                            number_format = None
                            item["status"] = "partial"
                            result["issues"].append({"code": "invalid_cell_style", "locator": f"{locator}/cell:{address}"})
                        formula = cell.value if cell.data_type == "f" else None
                        cached_value = _value(values.get(cell.column, {}).get("value")) if formula else None
                        status = "not_formula"
                        if formula:
                            status = "cache_missing" if cached_value is None else "cached_unverified"
                            if isinstance(cached_value, str) and cached_value.startswith("#"):
                                status = "cache_error"
                            if not isinstance(formula, str):
                                formula = getattr(formula, "text", None) or "[unsupported formula]"
                                status = "external_or_broken_reference"
                            if "[" in formula or "#REF!" in formula:
                                status = "external_or_broken_reference"
                            if status != "cached_unverified":
                                item["status"] = "partial"
                                result["issues"].append({"code": status, "locator": f"{locator}/cell:{address}"})
                        item["cells"].append({
                            "address": address, "locator": f"{locator}/cell:{address}",
                            "kind": "formula" if formula else cell.data_type,
                            "value": None if formula else _value(cell.value),
                            "formula": formula, "cached_value": cached_value,
                            "raw_numeric": raw_numbers.get((index, address)),
                            "calculation_status": status, "number_format": number_format,
                        })
                        result["coverage"]["populated_cells_read"] += 1
                if formula_reader.merged_cells:
                    item["merged_ranges"] = [str(cell.ref) for cell in formula_reader.merged_cells.mergeCell]
            result["sheets"].append(item)
            result["coverage"]["sheets_read"] += 1
        return _finish(result)
    finally:
        formulas.close()


def _xls(path: Path) -> dict:
    result = _base(path, "xls")
    # xlrd exposes BIFF cached results, but cannot prove which cells were formulas.
    result["issues"].append({"code": "formula_provenance_unavailable", "locator": "workbook"})
    book = xlrd.open_workbook(str(path), formatting_info=True, on_demand=True)
    try:
        result["date_epoch"] = "1904" if book.datemode else "1900"
        result["coverage"]["sheets_seen"] = book.nsheets
        if book.nsheets > MAX_SHEETS:
            result["issues"].append({"code": "sheet_limit_exceeded", "locator": "workbook"})
            return result
        for index in range(book.nsheets):
            sheet = book.sheet_by_index(index)
            locator = f"sheet:{index}"
            item = {"index": index, "name": sheet.name, "state": "unknown",
                    "locator": locator, "dimensions": f"A1:{get_column_letter(max(sheet.ncols, 1))}{max(sheet.nrows, 1)}",
                    "merged_ranges": [f"{get_column_letter(c0+1)}{r0+1}:{get_column_letter(c1)}{r1}"
                                      for r0, r1, c0, c1 in sheet.merged_cells],
                    "cells": [], "status": "partial"}
            if sheet.nrows * sheet.ncols > 2_000_000:
                result["issues"].append({"code": "sheet_dimensions_limit", "locator": locator})
                result["sheets"].append(item)
                return _finish(result)
            for row in range(sheet.nrows):
                for col in range(sheet.row_len(row)):
                    cell = sheet.cell(row, col)
                    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                        continue
                    result["coverage"]["populated_cells_seen"] += 1
                    if result["coverage"]["populated_cells_seen"] > MAX_POPULATED_CELLS:
                        result["issues"].append({"code": "cell_limit_exceeded", "locator": locator})
                        result["sheets"].append(item)
                        return _finish(result)
                    value = cell.value
                    if cell.ctype == xlrd.XL_CELL_DATE:
                        value = xlrd.xldate.xldate_as_datetime(value, book.datemode).isoformat()
                    elif cell.ctype == xlrd.XL_CELL_ERROR:
                        value = xlrd.error_text_from_code.get(value, "#UNKNOWN!")
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        value = bool(value)
                    address = f"{get_column_letter(col+1)}{row+1}"
                    format_string = None
                    if cell.xf_index is not None:
                        xf = book.xf_list[cell.xf_index]
                        fmt = book.format_map.get(xf.format_key)
                        format_string = fmt.format_str if fmt else None
                    item["cells"].append({"address": address,
                                          "locator": f"{locator}/cell:{address}",
                                          "kind": cell.ctype,
                                          "value": _value(value), "formula": None,
                                          "cached_value": _value(value),
                                          "calculation_status": "cached_value_only",
                                          "number_format": format_string})
                    result["coverage"]["populated_cells_read"] += 1
            result["sheets"].append(item)
            result["coverage"]["sheets_read"] += 1
        return _finish(result)
    finally:
        book.release_resources()


def parse_spreadsheet(path: str | Path) -> dict:
    path = Path(path)
    if path.stat().st_size > (MAX_LEGACY_INPUT if path.suffix.lower() == ".xls" else MAX_INPUT):
        raise ValueError("SPREADSHEET_INPUT_LIMIT")
    with path.open("rb") as stream:
        signature = stream.read(8)
    suffix = path.suffix.lower()
    if signature == bytes.fromhex("D0CF11E0A1B11AE1"):
        with olefile.OleFileIO(str(path)) as container:
            if container.exists("EncryptionInfo") or container.exists("EncryptedPackage"):
                raise ValueError("SPREADSHEET_PASSWORD_REQUIRED")
    if suffix == ".xlsx" and signature.startswith(b"PK\x03\x04"):
        return _xlsx(path)
    if suffix == ".xls" and signature == bytes.fromhex("D0CF11E0A1B11AE1"):
        return _xls(path)
    raise ValueError("INVALID_SPREADSHEET_ENVELOPE")
