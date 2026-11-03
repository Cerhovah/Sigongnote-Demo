"""Approved, allowlisted customer quote copy. Rendering does not claim delivery."""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import uuid
from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .export_batch import _font_path
from .labor_ledger import ExportBlocked

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MONEY = re.compile(r"^(0|[1-9][0-9]{0,15})$")
TOP_FIELDS = {"quote_id", "revision_id", "kind", "trade_pack_id", "vat_mode",
              "supply_minor", "vat_minor", "total_minor", "exclusions", "scope_lines"}
LINE_FIELDS = {"id", "display_name", "quantity_value", "unit_code", "operation", "supply_minor",
               "previous_quantity_value", "resulting_quantity_value"}


def _json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _validate(snapshot: dict, approval_id: str, expected_sha256: str) -> None:
    if not UUID.fullmatch(approval_id) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ExportBlocked("INVALID_QUOTE_ID")
    if not isinstance(snapshot, dict) or set(snapshot) != TOP_FIELDS or _sha(_json(snapshot)) != expected_sha256:
        raise ExportBlocked("QUOTE_SNAPSHOT_MISMATCH")
    if not UUID.fullmatch(str(snapshot["quote_id"])) or not UUID.fullmatch(str(snapshot["revision_id"])):
        raise ExportBlocked("INVALID_QUOTE_ID")
    if snapshot["kind"] not in {"new", "additional", "amendment"} or \
            snapshot["vat_mode"] not in {"exclusive", "not_applicable"}:
        raise ExportBlocked("INVALID_QUOTE_SNAPSHOT")
    numbers = [snapshot[key] for key in ("supply_minor", "vat_minor", "total_minor")]
    if any(not isinstance(number, str) or not MONEY.fullmatch(number) for number in numbers):
        raise ExportBlocked("INVALID_QUOTE_AMOUNT")
    if int(numbers[0]) + int(numbers[1]) != int(numbers[2]) or \
            snapshot["vat_mode"] == "not_applicable" and numbers[1] != "0":
        raise ExportBlocked("INVALID_QUOTE_AMOUNT")
    lines = snapshot["scope_lines"]
    if not isinstance(lines, list) or not 1 <= len(lines) <= 100:
        raise ExportBlocked("INVALID_QUOTE_SCOPE")
    identifiers = set()
    allocated = 0
    for line in lines:
        if not isinstance(line, dict) or set(line) != LINE_FIELDS or not UUID.fullmatch(str(line["id"])):
            raise ExportBlocked("INVALID_QUOTE_SCOPE")
        if line["id"] in identifiers or not isinstance(line["display_name"], str) or \
                not 1 <= len(line["display_name"].strip()) <= 180 or \
                not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", str(line["unit_code"])) or \
                line["operation"] not in {"add", "delta", "replace", "remove"} or \
                not isinstance(line["quantity_value"], str) or \
                not re.fullmatch(r"-?(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?", line["quantity_value"]) or \
                (line["previous_quantity_value"] is not None and
                 not re.fullmatch(r"(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?",
                                  str(line["previous_quantity_value"]))) or \
                not re.fullmatch(r"(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?",
                                 str(line["resulting_quantity_value"])) or \
                not isinstance(line["supply_minor"], str) or not MONEY.fullmatch(line["supply_minor"]):
            raise ExportBlocked("INVALID_QUOTE_SCOPE")
        identifiers.add(line["id"])
        allocated += int(line["supply_minor"])
    if allocated != int(snapshot["supply_minor"]):
        raise ExportBlocked("QUOTE_ALLOCATION_MISMATCH")
    exclusions = snapshot["exclusions"]
    if not isinstance(exclusions, list) or len(exclusions) > 20 or any(
            not isinstance(item, str) or not 1 <= len(item.strip()) <= 180 for item in exclusions):
        raise ExportBlocked("INVALID_QUOTE_EXCLUSIONS")


def render_quote_pdf(snapshot: dict, approval_id: str, expected_sha256: str) -> bytes:
    """Return a customer-safe copy from the exact owner-approved projection."""
    _validate(snapshot, approval_id, expected_sha256)
    font = "SigongnoteQuoteKorean"
    if font not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(font, str(_font_path())))
    regular = ParagraphStyle("quote", fontName=font, fontSize=10, leading=16,
                             textColor=colors.HexColor("#18212D"))
    heading = ParagraphStyle("quoteHeading", parent=regular, fontSize=18, leading=24)
    small = ParagraphStyle("quoteSmall", parent=regular, fontSize=9, leading=14)
    stream = io.BytesIO()
    document = SimpleDocTemplate(stream, pagesize=A4, leftMargin=42, rightMargin=42,
                                 topMargin=48, bottomMargin=52, title="시공노트 견적서",
                                 author="Sigongnote")
    kind_label = {"new": "신규", "additional": "추가", "amendment": "변경"}[snapshot["kind"]]
    pack_label = {"generic": "일반 공정", "joinery": "목창호", "wet-trade": "습식 공정"}.get(
        snapshot["trade_pack_id"], snapshot["trade_pack_id"])
    story = [Paragraph(f"{kind_label} 견적서", heading), Spacer(1, 12),
             Paragraph(f"견적: {escape(snapshot['quote_id'])}", small),
             Paragraph(f"승인: {escape(approval_id)}", small),
             Paragraph(f"공종: {escape(pack_label)}", small),
             Spacer(1, 18)]
    rows = [[Paragraph(value, regular) for value in ("범위", "수량", "단위", "공급가")]]
    operation_label = {"add": "추가", "delta": "증감", "replace": "대체", "remove": "제외"}
    units = {"m2": "㎡", "ea": "개", "day": "공수", "lump": "식", "pack": "포장"}
    for line in snapshot["scope_lines"]:
        label = f"{operation_label[line['operation']]} · {line['display_name']}"
        amount = (f"{line['previous_quantity_value']} → {line['resulting_quantity_value']}"
                  if line["previous_quantity_value"] is not None else line["resulting_quantity_value"])
        rows.append([Paragraph(escape(label), regular),
                     Paragraph(escape(amount), regular),
                     Paragraph(escape(units.get(line["unit_code"], line["unit_code"])), regular),
                     Paragraph(f"{int(line['supply_minor']):,}원", regular)])
    table = Table(rows, colWidths=[225, 80, 65, 108], repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF3F7")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#9FAFBD")),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#D9E2E9")),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.extend([table, Spacer(1, 16),
                  Paragraph(f"공급가: {int(snapshot['supply_minor']):,}원", regular),
                  Paragraph(f"부가세: {int(snapshot['vat_minor']):,}원", regular),
                  Paragraph(f"합계: {int(snapshot['total_minor']):,}원", heading)])
    if snapshot["exclusions"]:
        story.extend([Spacer(1, 15), Paragraph("제외 범위", regular)])
        story.extend(Paragraph(f"- {escape(item)}", regular) for item in snapshot["exclusions"])

    def footer(canvas, doc) -> None:
        canvas.setKeywords(f"sigongnote_generated=true;quote_snapshot_sha256={expected_sha256};audience=customer")
        canvas.setFont(font, 8)
        canvas.setFillColor(colors.HexColor("#596775"))
        canvas.drawString(42, 30, "승인된 견적 복사본 · 전달 여부는 별도 확인")
        canvas.drawRightString(A4[0] - 42, 30, str(doc.page))

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return stream.getvalue()


def publish_quote_pdf(root: str | Path, snapshot: dict, approval_id: str,
                      expected_sha256: str) -> dict:
    """Publish an atomic, idempotent generated copy and hash manifest."""
    _validate(snapshot, approval_id, expected_sha256)
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    folder = root / approval_id
    if folder.exists():
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        pdf = (folder / "quote.pdf").read_bytes()
        if manifest.get("approval_id") != approval_id or \
                manifest.get("snapshot_sha256") != expected_sha256 or \
                manifest.get("pdf_sha256") != _sha(pdf):
            raise ExportBlocked("QUOTE_OUTPUT_CONFLICT")
        return manifest
    temporary = root / f".{approval_id}.{uuid.uuid4()}.tmp"
    temporary.mkdir()
    try:
        pdf = render_quote_pdf(snapshot, approval_id, expected_sha256)
        manifest = {"approval_id": approval_id, "quote_id": snapshot["quote_id"],
                    "snapshot_sha256": expected_sha256, "pdf_sha256": _sha(pdf),
                    "audience": "customer", "delivery_verified": False}
        (temporary / "quote.pdf").write_bytes(pdf)
        (temporary / "manifest.json").write_bytes(_json(manifest))
        os.rename(temporary, folder)
        return manifest
    finally:
        if temporary.exists():
            for child in temporary.iterdir():
                child.unlink()
            temporary.rmdir()
