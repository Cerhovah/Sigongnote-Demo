import hashlib
import json
import zipfile

import openpyxl
from pypdf import PdfWriter
from reportlab.pdfgen import canvas

from sigongnote_worker.__main__ import excerpt, parse_document
from sigongnote_worker.evidence import evidence_chunks, write_evidence
from sigongnote_worker.pdf import parse_pdf


def test_full_chunks_keep_1001st_and_long_korean_tail(tmp_path):
    text = "가나다😀" * 601 + "끝부분"
    result = {"status": "complete", "source_sha256": "a" * 64,
              "spans": [{"text": str(i), "locator": f"line:{i}"} for i in range(1001)] +
                       [{"text": text, "locator": "line:1002"}]}
    target = tmp_path / "chunks.jsonl"
    manifest = write_evidence(result, target)
    chunks = [json.loads(line) for line in target.read_text(encoding="utf-8").splitlines()]
    assert manifest["chunkCount"] == 1005
    assert chunks[1000]["text"] == "1000"
    assert "".join(c["text"] for c in chunks[1001:]) == text
    assert all(c["ordinal"] == i for i, c in enumerate(chunks))
    assert all(c["contentHash"] == hashlib.sha256(c["text"].encode()).hexdigest() for c in chunks)
    assert len(excerpt(result)["spans"]) == 1000


def test_pdf_words_keep_coordinates_and_200_page_limit_reads_available_pages(tmp_path, monkeypatch):
    source = tmp_path / "pages.pdf"
    pdf = canvas.Canvas(str(source))
    for i in range(3):
        pdf.drawString(40, 700, f"Page {i+1}")
        pdf.showPage()
    pdf.save()
    import sigongnote_worker.pdf as parser
    monkeypatch.setattr(parser, "MAX_PAGES", 2)
    result = parse_pdf(source)
    assert result["status"] == "partial"
    assert result["coverage"] == {"pages_seen": 3, "pages_read": 2,
                                  "pages_ocr_attempted": 0, "pages_ocr_read": 0, "next_page": 3,
                                  "page_start": 1, "pages_processed": 2, "pages_partial": 0}
    chunk = next(evidence_chunks(result))
    assert chunk["locator"] == "page:1"
    assert chunk["text"] == "Page 1"
    assert len(chunk["position"]["bbox"]) == 4
    assert chunk["position"]["word_range"] == [0, 2]
    assert len(chunk["position"]["words"]) == 2
    resumed = parse_pdf(source, start_page=3)
    assert resumed["status"] == "complete"
    assert resumed["coverage"]["pages_read"] == 1
    assert "next_page" not in resumed["coverage"]
    assert next(evidence_chunks(resumed))["locator"] == "page:3"


def test_real_201_pages_and_recovered_catalog_resume_with_absolute_positions(tmp_path, monkeypatch):
    import sigongnote_worker.pdf as parser
    source = tmp_path / "long.pdf"
    pdf = canvas.Canvas(str(source))
    for i in range(201):
        pdf.drawString(40, 700, f"Page {i+1}")
        pdf.showPage()
    pdf.save()
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    first = parse_pdf(source)
    assert first["coverage"]["next_page"] == 201
    last = parse_document(source, pdf_start_page=201)
    assert [p["number"] for p in last["pages"]] == [201]
    assert next(evidence_chunks(last))["text"] == "Page 201"
    assert last["status"] == "complete"
    real_open = parser.pdfplumber.open

    def missing_catalog(value):
        document = real_open(value)
        if isinstance(value, str):
            document.doc.catalog = {}
        return document

    monkeypatch.setattr(parser.pdfplumber, "open", missing_catalog)
    recovered = parse_pdf(source)
    assert recovered["coverage"]["pages_read"] == 200
    assert recovered["coverage"]["next_page"] == 201
    tail = parse_pdf(source, start_page=201)
    assert tail["coverage"]["pages_seen"] == 201
    assert tail["coverage"]["pages_read"] == 1
    assert next(evidence_chunks(tail))["locator"] == "page:201"
    assert any(i["code"] == "pdf_structure_recovered" for i in tail["issues"])
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash


def test_image_words_group_readably_and_bound_position_without_losing_words():
    words = [{"text": "가", "locator": f"image:0/ocr:{i}",
              "bbox": [i, 0, i+1, 1], "source": "ocr_candidate"} for i in range(1500)]
    words.append({"text": "😀" * 1500, "locator": "image:0/ocr:1500", "bbox": [0, 1, 100, 2]})
    chunks = list(evidence_chunks({"words": words}))
    assert "".join(chunk["text"] for chunk in chunks) == " ".join(word["text"] for word in words)
    assert len(chunks) < 30
    assert {record["i"] for chunk in chunks for record in chunk["position"]["words"]} == set(range(1501))
    for chunk in chunks:
        assert chunk["locator"] == "image:0"
        assert len(chunk["text"].encode("utf-16-le")) // 2 <= 1000
        assert len(json.dumps(chunk["position"], ensure_ascii=False).encode("utf-8")) <= 16 * 1024
        assert len(chunk["position"]["bbox"]) == 4


def test_xlsx_chart_before_worksheet_preserves_raw_decimal_lexeme(tmp_path):
    path = tmp_path / "chart-first.xlsx"
    book = openpyxl.Workbook()
    book.active["A1"] = 1234567890123456
    chart = openpyxl.chart.BarChart()
    chart.add_data(openpyxl.chart.Reference(book.active, min_col=1, min_row=1, max_row=1))
    book.create_chartsheet("도표", index=0).add_chart(chart)
    book.save(path)
    result = parse_document(path)
    cell = result["sheets"][0]["cells"][0]
    assert cell["locator"] == "sheet:0/cell:A1"
    assert cell["raw_numeric"] == "1234567890123456"


def test_xlsx_cells_and_hwpx_long_body_are_entirely_indexed(tmp_path):
    xlsx = tmp_path / "cells.xlsx"
    book = openpyxl.Workbook()
    for i in range(1, 1003):
        book.active.cell(i, 1, f"자재 {i}")
    book.save(xlsx)
    cells = list(evidence_chunks(parse_document(xlsx)))
    assert cells[1001]["locator"] == "sheet:0/cell:A1002"
    hwpx = tmp_path / "long.hwpx"
    text = "현장 변경 요청 " * 1200
    with zipfile.ZipFile(hwpx, "w") as archive:
        archive.writestr("mimetype", "application/hwp+zip")
        archive.writestr("Contents/section0.xml", f'<hp:sec xmlns:hp="urn:hwp:paragraph"><hp:p><hp:run><hp:t>{text}</hp:t></hp:run></hp:p></hp:sec>')
    chunks = list(evidence_chunks(parse_document(hwpx)))
    assert "".join(c["text"] for c in chunks) == text
    assert len({c["locator"] for c in chunks}) == 1


def test_encrypted_and_empty_documents_have_explicit_coverage(tmp_path):
    pdf = tmp_path / "locked.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=300)
    writer.encrypt("synthetic-password")
    writer.write(pdf)
    encrypted = parse_document(pdf)
    assert encrypted["status"] == "encrypted"
    assert encrypted["coverage"]["pages_read"] == 0
    assert list(evidence_chunks(encrypted)) == []
    empty = tmp_path / "empty.txt"
    empty.write_text("\n  \n", encoding="utf-8")
    assert parse_document(empty)["issues"] == [{"code": "empty_document"}]
