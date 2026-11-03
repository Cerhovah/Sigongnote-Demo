"""Versioned customer-only rendering. All monetary calculation belongs to TS/DB."""
from __future__ import annotations
import base64
import io
import json
import re
import sys
import math
from datetime import date
import unicodedata
from decimal import Decimal
from html import escape
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet.table import Table as ExcelTable, TableStyleInfo
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from .export_batch import _font_path

TEMPLATE = json.loads((Path(__file__).parent / "templates" / "kr-basic-v1.json").read_text(encoding="utf-8"))
NAMES = {"estimate": "견적서", "purchase_order": "발주서", "invoice": "청구서", "delivery_statement": "거래명세서"}
MONEY = re.compile(r"^-?(0|[1-9][0-9]{0,15})$")
FIELDS = {"document_number", "revision", "template_version", "issuer", "recipient", "project", "date", "type", "state", "missing", "lines", "totals", "terms", "disclosure_scope", "basis_hash", "calculation_version"}
LINE_FIELDS = {"id", "description", "spec", "unit", "quantity", "unit_price", "price_tax_mode", "rounding_adjustment", "supply", "tax"}
XLSX_WRAP_SAFETY_LINES = 1  # Extra line for wrapping at a word boundary rather than a glyph boundary.

def validate(snapshot: dict) -> None:
    if not isinstance(snapshot, dict) or set(snapshot) - (FIELDS | ({"form"} if snapshot.get("template_version") == "kr-business-v2" else set())) or snapshot.get("template_version") not in ("kr-basic-v1", "kr-business-v2") or snapshot.get("type") not in NAMES:
        raise ValueError("INVALID_PUBLIC_DOCUMENT")
    if snapshot.get("template_version") == "kr-business-v2":
        form = snapshot.get("form", {})
        limits = {"delivery_place":180,"payment_terms":180,"payment_account":180,"note":300}
        dates = {"valid_until","delivery_date"}
        if not isinstance(form,dict) or set(form) - (set(limits) | dates | {"issuer","recipient"}): raise ValueError("INVALID_DOCUMENT_FORM")
        for key,value in form.items():
            if key in ("issuer","recipient"):
                allowed = {"business_number":13,"representative":60,"address":180,"business_type":60,"business_item":60,"contact":100}
                if key == "issuer": allowed["name"] = 180
                if not isinstance(value,dict) or set(value)-set(allowed): raise ValueError("INVALID_FORM_PARTY")
                for k,v in value.items():
                    if not isinstance(v,str) or len(v)>allowed[k] or (k=="name" and not v.strip()): raise ValueError("INVALID_FORM_PARTY")
                    if k=="business_number" and v and not re.fullmatch(r"[0-9]{3}-[0-9]{2}-[0-9]{5}",v): raise ValueError("INVALID_BUSINESS_NUMBER")
            elif not isinstance(value,str): raise ValueError("INVALID_FORM_VALUE")
            elif key in limits and len(value)>limits[key]: raise ValueError("INVALID_FORM_VALUE")
            elif key in dates and value: date.fromisoformat(value)
    for name in ["issuer", "recipient"]:
        if set(snapshot[name]) != {"name"} or not isinstance(snapshot[name]["name"], str) or not 1 <= len(snapshot[name]["name"]) <= 180:
            raise ValueError("INVALID_PUBLIC_PARTY")
    if set(snapshot["project"]) != {"id", "name"} or not isinstance(snapshot["project"]["name"], str) or len(snapshot["project"]["name"]) > 180:
        raise ValueError("INVALID_PROJECT")
    if not re.fullmatch(r"[QIPS]-[0-9]{7,12}", snapshot["document_number"]) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", snapshot["date"]):
        raise ValueError("INVALID_DOCUMENT_HEADER")
    if not 1 <= len(snapshot["lines"]) <= 100 or len(snapshot["terms"]) > 20 or any(not isinstance(t, str) or len(t) > 300 for t in snapshot["terms"]):
        raise ValueError("INVALID_DOCUMENT_SIZE")
    for line in snapshot["lines"]:
        if set(line) - LINE_FIELDS or any(not isinstance(line[k], str) or len(line[k]) > 180 for k in ["description", "spec", "unit"]):
            raise ValueError("INVALID_DOCUMENT_LINE")
        if line["quantity"] is not None and not re.fullmatch(r"-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?", line["quantity"]):
            raise ValueError("INVALID_QUANTITY")
        for key in ["unit_price", "supply", "tax"]:
            if line[key] is not None and (not isinstance(line[key], str) or not MONEY.fullmatch(line[key])):
                raise ValueError("INVALID_DOCUMENT_MONEY")
    for key in ["supply", "tax", "total"]:
        value = snapshot["totals"][key]
        if value is not None and (not isinstance(value, str) or not MONEY.fullmatch(value)):
            raise ValueError("INVALID_DOCUMENT_TOTAL")
    totals = snapshot["totals"]
    if set(totals) != {"supply", "tax", "total"}:
        raise ValueError("INVALID_PUBLIC_TOTALS")
    for key in ["supply", "tax"]:
        if totals[key] is not None and (any(l[key] is None for l in snapshot["lines"]) or sum(int(l[key]) for l in snapshot["lines"]) != int(totals[key])):
            raise ValueError("DOCUMENT_SUM_MISMATCH")
    if all(totals[k] is not None for k in ["supply", "tax", "total"]) and int(totals["supply"]) + int(totals["tax"]) != int(totals["total"]):
        raise ValueError("DOCUMENT_TOTAL_MISMATCH")
    if snapshot.get("state") == "approved" and (any(v is None for v in totals.values()) or any(l["supply"] is None or l["tax"] is None for l in snapshot["lines"])):
        raise ValueError("UNKNOWN_APPROVED_AMOUNT")

def amount(value):
    return "확인 필요" if value is None else f"{int(value):,}"

def display_text(value) -> str:
    return str(value).replace('\r\n', '\n').replace('\r', '\n')


def render_pdf(snapshot: dict) -> bytes:
    validate(snapshot)
    if snapshot["template_version"] == "kr-business-v2":
        from .business_document_v2 import render_pdf as render_v2
        return render_v2(snapshot)
    font = "SigongnoteBusinessKorean"
    if font not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(font, str(_font_path())))
    style = ParagraphStyle("body", fontName=font, fontSize=TEMPLATE["font_size"], leading=TEMPLATE["line_height"], wordWrap="CJK")
    small = ParagraphStyle("small", parent=style, fontSize=8, leading=12)
    title = ParagraphStyle("title", parent=style, fontSize=24, leading=32, spaceAfter=18)
    p = lambda text: Paragraph(escape(display_text(text)).replace('\n', '<br/>'), style)
    rows = [[p(v) for v in ["품명 · 규격", "수량", "단위", "단가", "공급가액", "부가세"]]]
    for line in snapshot["lines"]:
        rows.append([p(line["description"] + (" / " + line["spec"] if line["spec"] else "")), p(line["quantity"] if line["quantity"] is not None else "—"), p(line["unit"]), p(amount(line["unit_price"]) if line["unit_price"] is not None else "—"), p(amount(line["supply"])), p(amount(line["tax"]))])
    table = Table(rows, colWidths=TEMPLATE["pdf_widths"], repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF1EC")), ("GRID", (0, 0), (-1, -1), .4, colors.HexColor("#C8D3CD")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    stream = io.BytesIO()
    doc = SimpleDocTemplate(stream, pagesize=A4, leftMargin=42, rightMargin=42, topMargin=42, bottomMargin=48, title=NAMES[snapshot["type"]], author="시공노트", pageCompression=1)
    # Exactly A4 content width; long text wraps rather than making columns overflow.
    content = [Paragraph(NAMES[snapshot["type"]], title), p(f"문서번호 {snapshot['document_number']}  ·  작성일 {snapshot['date']}"), Spacer(1, 12), p(f"받는 곳  {snapshot['recipient']['name']}"), p(f"보내는 곳  {snapshot['issuer']['name']}"), p(f"현장  {snapshot['project']['name']}"), Spacer(1, 18), table, Spacer(1, 16)]
    summary = Table([[p("공급가액"), p(amount(snapshot["totals"]["supply"]) + " 원")], [p("부가세"), p(amount(snapshot["totals"]["tax"]) + " 원")], [p("합계"), p(amount(snapshot["totals"]["total"]) + " 원")]], colWidths=[300, 211])
    summary.setStyle(TableStyle([("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#EAF1EC")), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    content += [summary, Spacer(1, 14)]
    content += [p(t) for t in snapshot["terms"]]
    content.append(Paragraph("일반 업무 문서 · 법정 전자세금계산서가 아닙니다. 발행은 전달이나 입금 완료를 뜻하지 않습니다.", small))
    def footer(canvas, _doc):
        canvas.setFont(font, 8)
        canvas.drawString(42, 26, f"시공노트 기본 양식 1.0  ·  {snapshot['document_number']}")
        canvas.drawRightString(A4[0] - 42, 26, str(_doc.page))
    doc.build(content, onFirstPage=footer, onLaterPages=footer)
    return stream.getvalue()

def render_xlsx(snapshot: dict) -> bytes:
    validate(snapshot)
    if snapshot["template_version"] == "kr-business-v2":
        from .business_document_v2 import render_xlsx as render_v2
        return render_v2(snapshot)
    book = Workbook()
    sheet = book.active
    sheet.title = NAMES[snapshot["type"]]
    book.properties.creator = "시공노트"
    book.properties.title = sheet.title
    def text(row, col, value):
        cell = sheet.cell(row, col, display_text(value))
        cell.data_type = "s"  # Even =, +, -, @ prefixes are literal text, not formulas.
        cell.font = Font(name="맑은 고딕", size=11, color="182D24")
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        return cell
    def number(row, col, value):
        if value is None:
            return text(row, col, "—")
        # Excel has 15 significant digits. Preserve larger exact values as visible text.
        if len(value.replace("-", "").replace(".", "").lstrip("0")) > 15:
            return text(row, col, value)
        cell = sheet.cell(row, col, int(value) if "." not in value else float(Decimal(value)))
        scale = len(value.split(".")[1].rstrip("0")) if "." in value else 0
        cell.number_format = '#,##0' + ('.' + '0' * scale if scale else '') + ';[Red]-#,##0' + ('.' + '0' * scale if scale else '')
        cell.font = Font(name="맑은 고딕", size=11)
        return cell
    for row, label in [(1, sheet.title), (3, f"문서번호 {snapshot['document_number']}  ·  {snapshot['date']}"), (4, f"받는 곳  {snapshot['recipient']['name']}"), (5, f"보내는 곳  {snapshot['issuer']['name']}"), (6, f"현장  {snapshot['project']['name']}")]:
        sheet.merge_cells(start_row=row, start_column=1, end_row=row, end_column=7)
        text(row, 1, label)
        sheet.row_dimensions[row].height = 30 if row != 1 else 42
    sheet['A1'].font = Font(name="맑은 고딕", size=24, bold=True)
    for col, value in enumerate(["품명", "규격", "단위", "수량", "단가", "공급가액", "부가세"], 1):
        text(8, col, value)
    for row, line in enumerate(snapshot["lines"], 9):
        for col, key in enumerate(["description", "spec", "unit"], 1): text(row, col, line[key])
        for col, key in enumerate(["quantity", "unit_price", "supply", "tax"], 4): number(row, col, line[key])
        # Size each wrapped column independently: Korean glyphs occupy about two
        # Excel width units. Counting description and spec together clips narrow cells.
        wrapped_lines = max(
            sum(max(1, math.ceil(sum(2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1 for c in part) / (width - 1))) for part in display_text(line[key]).split('\n'))
            for key, width in zip(['description', 'spec', 'unit'], TEMPLATE['xlsx_widths'][:3])
        )
        sheet.row_dimensions[row].height = max(32, 16 * (wrapped_lines + XLSX_WRAP_SAFETY_LINES))
    last = 8 + len(snapshot["lines"])
    table = ExcelTable(displayName="DocumentLines", ref=f"A8:G{last}")
    table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium4", showRowStripes=True)
    sheet.add_table(table)
    for offset, (label, key) in enumerate([("공급가액", "supply"), ("부가세", "tax"), ("합계", "total")], 2):
        row = last + offset
        sheet.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
        text(row, 1, label)
        sheet.merge_cells(start_row=row, start_column=6, end_row=row, end_column=7)
        number(row, 6, snapshot["totals"][key])
        sheet.row_dimensions[row].height = 28
    end = last + 6
    for term in snapshot["terms"] + ["일반 업무 문서 · 법정 전자세금계산서가 아닙니다."]:
        sheet.merge_cells(start_row=end, start_column=1, end_row=end, end_column=7)
        text(end, 1, term)
        sheet.row_dimensions[end].height = max(32, 15 * (len(term) // 55 + 1))
        end += 1
    for col, width in zip("ABCDEFG", TEMPLATE["xlsx_widths"]): sheet.column_dimensions[col].width = width
    sheet.freeze_panes = "A9"
    sheet.print_title_rows = "8:8"
    sheet.print_area = f"A1:G{end-1}"
    sheet.page_setup.orientation = "portrait"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.oddFooter.center.text = "&P / &N"
    stream = io.BytesIO()
    book.save(stream)
    return stream.getvalue()

def main():
    try:
        raw = sys.stdin.buffer.readline(2_000_001)
        if len(raw) > 2_000_000: raise ValueError("INPUT_LIMIT")
        snapshot = json.loads(raw)
        result = {"pdf": base64.b64encode(render_pdf(snapshot)).decode(), "xlsx": base64.b64encode(render_xlsx(snapshot)).decode()}
        sys.stdout.write(json.dumps(result))
    except Exception:
        sys.stderr.write("DOCUMENT_RENDER_FAILED")
        raise SystemExit(1)

if __name__ == "__main__": main()
