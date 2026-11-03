"""Bounded, evidence-only HWP5/HWPX readers. No business value is confirmed here.

HWP5 record and table offsets follow Hancom's published format 5.0 revision 1.2.
Unsupported structures stay partial; Preview text is never treated as body coverage.
"""
from __future__ import annotations

import hashlib
import re
import stat
import struct
import zipfile
import zlib
from pathlib import Path

import olefile
from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException

VERSION = "hwp-structure/1.0.1"
MAX_INPUT = 30 * 1024 * 1024
MAX_EXPANDED = 200 * 1024 * 1024
MAX_ENTRIES = 2000
SECTION_XML = re.compile(r"Contents/section(\d+)\.xml$", re.IGNORECASE)
SECTION_OLE = re.compile(r"BodyText/Section(\d+)$", re.IGNORECASE)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _issue(code: str, locator: str) -> dict:
    return {"code": code, "locator": locator}


def _base(path: Path, kind: str) -> dict:
    return {
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "format": kind, "parser_version": VERSION, "status": "failed",
        "supported_scope": "all BodyText sections and table cells" if kind == "hwp5"
        else "all Contents/section*.xml paragraphs and table cells",
        "sections": [], "issues": [],
        "coverage": {"sections_seen": 0, "sections_read": 0,
                     "tables_seen": 0, "tables_read": 0,
                     "cells_expected": 0, "cells_read": 0,
                     "grid_slots_expected": 0},
    }


def _status(result: dict) -> dict:
    result["status"] = ("partial" if result["issues"] else "complete") if result["sections"] else "failed"
    return result


def _text(element) -> str:
    # Text only from actual text runs; metadata, addresses and layout are excluded.
    # A nested table owns its own cells, never its enclosing paragraph/cell.
    def runs(node):
        if _local(node.tag) == "tbl":
            return
        if _local(node.tag) == "t":
            yield node.text or ""
        for child in node:
            yield from runs(child)
    return "".join(runs(element))


def _attr_int(element, *names: str, default: int = 0) -> int:
    for name in names:
        if name in element.attrib:
            return int(element.attrib[name])
    return default


def _hwpx_table(element, section: int, index: int, issues: list[dict]) -> dict:
    locator = f"section:{section}/table:{index}"
    rows = _attr_int(element, "rowCnt", "rowCount", "rows")
    cols = _attr_int(element, "colCnt", "colCount", "cols")
    cells: list[dict] = []
    occupancy: set[tuple[int, int]] = set()
    table_rows = [child for child in element if _local(child.tag) == "tr"]
    if not rows or not cols or rows != len(table_rows):
        issues.append(_issue("table_dimensions_unverified", locator))
    for row_index, tr in enumerate(table_rows):
        for physical_col, tc in enumerate(child for child in tr if _local(child.tag) == "tc"):
            addr = next((child for child in tc if _local(child.tag) == "cellAddr"), None)
            span = next((child for child in tc if _local(child.tag) == "cellSpan"), None)
            if addr is None:
                issues.append(_issue("cell_address_missing", locator))
            row = _attr_int(addr, "rowAddr", default=row_index) if addr is not None else row_index
            col = _attr_int(addr, "colAddr", default=physical_col) if addr is not None else physical_col
            rowspan = _attr_int(span, "rowSpan", default=_attr_int(tc, "rowSpan", default=1)) if span is not None else _attr_int(tc, "rowSpan", default=1)
            colspan = _attr_int(span, "colSpan", default=_attr_int(tc, "colSpan", default=1)) if span is not None else _attr_int(tc, "colSpan", default=1)
            cell_locator = f"{locator}/cell:{row},{col}"
            if row < 0 or col < 0 or rowspan < 1 or colspan < 1 or row + rowspan > rows or col + colspan > cols:
                issues.append(_issue("cell_out_of_bounds", cell_locator))
            for rr in range(row, row + rowspan):
                for cc in range(col, col + colspan):
                    if (rr, cc) in occupancy:
                        issues.append(_issue("cell_overlap", cell_locator))
                    occupancy.add((rr, cc))
            if any(_local(child.tag) == "tbl" for child in tc.iter() if child is not tc):
                issues.append(_issue("nested_table_requires_review", cell_locator))
            cells.append({"row": row, "col": col, "rowspan": rowspan,
                          "colspan": colspan, "text": _text(tc), "locator": cell_locator})
    if rows * cols != len(occupancy):
        issues.append(_issue("table_grid_incomplete", locator))
    return {"locator": locator, "rows": rows, "cols": cols, "cells": cells}


def parse_hwpx(path: str | Path) -> dict:
    path = Path(path)
    if path.stat().st_size > MAX_INPUT or not zipfile.is_zipfile(path):
        raise ValueError("INVALID_HWPX_ENVELOPE")
    result = _base(path, "hwpx")
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > MAX_ENTRIES or sum(info.file_size for info in members) > MAX_EXPANDED:
            raise ValueError("HWPX_LIMIT_EXCEEDED")
        seen_names: set[str] = set()
        for info in members:
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/") or ":" in name or name.casefold() in seen_names:
                raise ValueError("UNSAFE_HWPX_ENTRY")
            if stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK:
                raise ValueError("UNSAFE_HWPX_ENTRY")
            seen_names.add(name.casefold())
            if info.file_size > MAX_EXPANDED or (info.compress_size == 0 and info.file_size > 0):
                raise ValueError("HWPX_LIMIT_EXCEEDED")
        sections = sorted(((int(match.group(1)), info) for info in members
                           if (match := SECTION_XML.fullmatch(info.filename.replace("\\", "/")))),
                          key=lambda item: item[0])
        if not sections or [number for number, _ in sections] != list(range(len(sections))):
            raise ValueError("HWPX_SECTIONS_MISSING")
        result["coverage"]["sections_seen"] = len(sections)
        for number, info in sections:
            locator = f"section:{number}"
            try:
                issue_count = len(result["issues"])
                xml = archive.read(info)
                root = SafeET.fromstring(xml)
                tables = []
                # Keep each logical table distinct even when it repeats in later sections.
                for node in root.iter():
                    if _local(node.tag) == "tbl":
                        result["coverage"]["tables_seen"] += 1
                        table = _hwpx_table(node, number, len(tables), result["issues"])
                        tables.append(table)
                        result["coverage"]["tables_read"] += 1
                        result["coverage"]["cells_read"] += len(table["cells"])
                        result["coverage"]["cells_expected"] += len(table["cells"])
                        result["coverage"]["grid_slots_expected"] += table["rows"] * table["cols"]
                cell_paragraphs = {p for cell in root.iter() if _local(cell.tag) == "tc"
                                   for p in cell.iter() if _local(p.tag) == "p"}
                paragraphs = [{"locator": f"{locator}/paragraph:{index}", "text": _text(node)}
                              for index, node in enumerate(node for node in root.iter()
                                                           if _local(node.tag) == "p")
                              if node not in cell_paragraphs]
                result["sections"].append({"index": number, "locator": locator,
                                           "paragraphs": paragraphs, "tables": tables,
                                           "status": "partial" if len(result["issues"]) > issue_count else "complete"})
                result["coverage"]["sections_read"] += 1
            except (ValueError, SafeET.ParseError, DefusedXmlException, zipfile.BadZipFile) as exc:
                result["issues"].append(_issue(type(exc).__name__, locator))
                result["sections"].append({"index": number, "locator": locator,
                                           "paragraphs": [], "tables": [], "status": "failed"})
    return _status(result)


def _records(data: bytes):
    """Yield complete HWP5 records; never silently truncate a section."""
    offset = 0
    while offset < len(data):
        if len(data) - offset < 4:
            raise ValueError("TRUNCATED_HWP_RECORD")
        start = offset
        word = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        tag, level, size = word & 0x3ff, (word >> 10) & 0x3ff, word >> 20
        if size == 0xfff:
            if len(data) - offset < 4:
                raise ValueError("TRUNCATED_HWP_RECORD")
            size = struct.unpack_from("<I", data, offset)[0]
            offset += 4
        if size > len(data) - offset:
            raise ValueError("TRUNCATED_HWP_RECORD")
        yield tag, level, data[offset:offset + size], start
        offset += size


_LONG_CONTROL = {1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18,
                 19, 20, 21, 22, 23}


def _hwp_text(payload: bytes) -> str:
    if len(payload) % 2:
        raise ValueError("ODD_HWP_TEXT")
    units = struct.unpack("<" + "H" * (len(payload) // 2), payload)
    out = []
    at = 0
    while at < len(units):
        code = units[at]
        if code in _LONG_CONTROL:
            if at + 8 > len(units):
                raise ValueError("TRUNCATED_HWP_CONTROL")
            if code == 9:
                out.append("\t")
            at += 8
        else:
            if code == 10:
                out.append("\n")
            elif code in (30, 31):
                out.append(" ")
            elif 0xD800 <= code <= 0xDBFF:
                if at + 1 >= len(units) or not 0xDC00 <= units[at + 1] <= 0xDFFF:
                    raise ValueError("UNPAIRED_HWP_SURROGATE")
                out.append(chr(0x10000 + ((code - 0xD800) << 10) + units[at + 1] - 0xDC00))
                at += 1
            elif 0xDC00 <= code <= 0xDFFF:
                raise ValueError("UNPAIRED_HWP_SURROGATE")
            elif code >= 32:
                out.append(chr(code))
            at += 1
    return "".join(out)


def _hwp5_section(data: bytes, section: int, issues: list[dict]) -> dict:
    locator = f"section:{section}"
    paragraphs: list[dict] = []
    tables: list[dict] = []
    table = None
    cell = None
    table_level = -1
    for tag, level, payload, offset in _records(data):
        if table is not None and level < table_level:
            table = cell = None
        if tag == 77:  # HWPTAG_TABLE: attributes then row/column counts.
            if len(payload) < 22:
                issues.append(_issue("table_header_short", f"{locator}/record:{offset}"))
                table = cell = None
                continue
            rows, cols = struct.unpack_from("<HH", payload, 4)
            if not (1 <= rows <= 10_000 and 1 <= cols <= 1_000 and rows * cols <= 200_000):
                issues.append(_issue("table_dimensions_invalid", f"{locator}/record:{offset}"))
                table = cell = None
                continue
            table = {"locator": f"{locator}/table:{len(tables)}", "rows": rows,
                     "cols": cols, "cells": []}
            tables.append(table)
            table_level = level
            cell = None
            continue
        if tag == 72 and table is not None and level >= table_level and len(payload) >= 34:
            # Real HWP5 LIST_HEADER has a reserved UINT16 after paragraph count:
            # 8-byte prefix, then at least the 26-byte published cell attributes.
            col, row, colspan, rowspan = struct.unpack_from("<HHHH", payload, 8)
            if 0 <= row < table["rows"] and 0 <= col < table["cols"] and 1 <= colspan <= table["cols"] - col and 1 <= rowspan <= table["rows"] - row:
                cell_locator = f"{table['locator']}/cell:{row},{col}"
                cell = {"row": row, "col": col, "rowspan": rowspan,
                        "colspan": colspan, "text": "", "locator": cell_locator}
                table["cells"].append(cell)
            else:
                issues.append(_issue("cell_header_unresolved", f"{locator}/record:{offset}"))
                cell = None
        elif tag == 67:  # HWPTAG_PARA_TEXT
            try:
                text = _hwp_text(payload)
            except ValueError:
                issues.append(_issue("paragraph_control_unresolved", f"{locator}/record:{offset}"))
                continue
            if cell is not None and table is not None and level > table_level:
                cell["text"] += text
            else:
                paragraphs.append({"locator": f"{locator}/paragraph:{len(paragraphs)}",
                                   "text": text})
        elif tag == 71:
            control = payload[:4]
            if control not in (b"tbl ", b" lbt", b"secd", b"dces", b"cold", b"dloc"):
                issues.append(_issue("control_unresolved", f"{locator}/record:{offset}"))
            if table is not None and level <= table_level:
                table = cell = None
    for table in tables:
        occupied: set[tuple[int, int]] = set()
        for cell in table["cells"]:
            for row in range(cell["row"], cell["row"] + cell["rowspan"]):
                for col in range(cell["col"], cell["col"] + cell["colspan"]):
                    if (row, col) in occupied:
                        issues.append(_issue("cell_overlap", cell["locator"]))
                    occupied.add((row, col))
        if len(occupied) != table["rows"] * table["cols"]:
            issues.append(_issue("table_grid_incomplete", table["locator"]))
    return {"index": section, "locator": locator, "paragraphs": paragraphs,
            "tables": tables, "status": "partial" if issues else "complete"}


def _inflate(raw: bytes, issues: list[dict], locator: str) -> bytes:
    decompressor = zlib.decompressobj(-15)
    data = decompressor.decompress(raw, MAX_EXPANDED + 1)
    if len(data) > MAX_EXPANDED or decompressor.unconsumed_tail or not decompressor.eof:
        raise ValueError("HWP_INFLATE_LIMIT_OR_TRUNCATED")
    # Some field HWP5 OLE streams include a short opaque trailer after the
    # complete raw-deflate member. Read the member, but never claim coverage
    # of the extra bytes or silently accept an unbounded appended payload.
    if decompressor.unused_data:
        if len(decompressor.unused_data) > 4096:
            raise ValueError("HWP_TRAILING_DATA_LIMIT")
        issues.append(_issue("trailing_compressed_bytes", locator))
    return data


def parse_hwp5(path: str | Path) -> dict:
    path = Path(path)
    if path.stat().st_size > MAX_INPUT or not olefile.isOleFile(str(path)):
        raise ValueError("INVALID_HWP5_ENVELOPE")
    result = _base(path, "hwp5")
    with olefile.OleFileIO(str(path)) as ole:
        if not ole.exists("FileHeader"):
            raise ValueError("HWP_HEADER_MISSING")
        header = ole.openstream("FileHeader").read(256)
        if len(header) < 40 or not header.startswith(b"HWP Document File"):
            raise ValueError("HWP_HEADER_INVALID")
        version = tuple(reversed(header[32:36]))
        result["source_version"] = ".".join(map(str, version))
        if version[0] != 5:
            result["issues"].append(_issue("unsupported_version", "FileHeader"))
            result["status"] = "unsupported"
            return result
        flags = struct.unpack_from("<I", header, 36)[0]
        if flags & (2 | 4 | 16 | 256 | 1024):
            code = "encrypted" if flags & (2 | 16 | 256 | 1024) else "distributable"
            result["issues"].append(_issue(code, "FileHeader"))
            result["status"] = code
            return result
        compressed = bool(flags & 1)
        if not ole.exists("DocInfo") or ole.get_size("DocInfo") > MAX_EXPANDED:
            raise ValueError("HWP_DOCINFO_MISSING_OR_LIMIT")
        docinfo_raw = ole.openstream("DocInfo").read(MAX_EXPANDED + 1)
        docinfo = _inflate(docinfo_raw, result["issues"], "DocInfo") if compressed else docinfo_raw
        properties = next((payload for tag, _, payload, _ in _records(docinfo) if tag == 16), None)
        if properties is None or len(properties) < 2:
            raise ValueError("HWP_DOCUMENT_PROPERTIES_MISSING")
        declared_sections = struct.unpack_from("<H", properties)[0]
        sections = sorted(((int(match.group(1)), name) for name in ole.listdir(streams=True, storages=False)
                           if (match := SECTION_OLE.fullmatch("/".join(name)))), key=lambda item: item[0])
        if (not sections or len(sections) != declared_sections or
                [number for number, _ in sections] != list(range(declared_sections))):
            raise ValueError("HWP_SECTIONS_MISSING")
        result["coverage"]["sections_seen"] = len(sections)
        expanded_total = len(docinfo)
        for number, name in sections:
            locator = f"section:{number}"
            try:
                if ole.get_size(name) > MAX_EXPANDED:
                    raise ValueError("HWP_SECTION_LIMIT")
                raw = ole.openstream(name).read(MAX_EXPANDED + 1)
                before = len(result["issues"])
                data = _inflate(raw, result["issues"], locator) if compressed else raw
                expanded_total += len(data)
                if expanded_total > MAX_EXPANDED:
                    raise ValueError("HWP_TOTAL_EXPANDED_LIMIT")
                section = _hwp5_section(data, number, result["issues"])
                section["status"] = "partial" if len(result["issues"]) > before else "complete"
                result["sections"].append(section)
                result["coverage"]["sections_read"] += 1
                result["coverage"]["tables_seen"] += len(section["tables"])
                result["coverage"]["tables_read"] += len(section["tables"])
                result["coverage"]["cells_read"] += sum(len(table["cells"]) for table in section["tables"])
                result["coverage"]["cells_expected"] += sum(len(table["cells"]) for table in section["tables"])
                result["coverage"]["grid_slots_expected"] += sum(table["rows"] * table["cols"] for table in section["tables"])
            except (ValueError, OSError, zlib.error) as exc:
                result["issues"].append(_issue(str(exc).split(":")[0], locator))
                result["sections"].append({"index": number, "locator": locator,
                                           "paragraphs": [], "tables": [], "status": "failed"})
    return _status(result)


def parse_hwp(path: str | Path) -> dict:
    suffix = Path(path).suffix.lower()
    if suffix == ".hwpx":
        return parse_hwpx(path)
    if suffix == ".hwp":
        return parse_hwp5(path)
    raise ValueError("UNSUPPORTED_HWP_FORMAT")


def assess_golden(result: dict, expected: dict[str, dict]) -> dict:
    """Compare reviewed cells including missing ones; never turn a candidate into a fact."""
    actual = {cell["locator"]: cell for section in result["sections"]
              for table in section["tables"] for cell in table["cells"]}
    matched = 0
    present = 0
    critical_wrong = 0
    for locator, target in expected.items():
        cell = actual.get(locator)
        if cell is not None:
            present += 1
        correct = cell is not None and all(cell.get(key) == value for key, value in target.items()
                                               if key != "critical")
        if correct:
            matched += 1
        elif target.get("critical"):
            critical_wrong += 1
    total = len(expected)
    return {"expected_cells": total, "present_cells": present,
            "matching_cells": matched, "cell_accuracy": matched / total if total else None,
            "read_coverage": present / total if total else None,
            "critical_mismatches": critical_wrong,
            "eligible_for_auto_attribution": result["status"] == "complete" and
            critical_wrong == 0 and total > 0 and matched == total}
