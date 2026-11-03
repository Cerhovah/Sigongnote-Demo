import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from pypdf import PdfWriter

from sigongnote_worker.pdf import LocalTesseract, parse_pdf


@pytest.mark.pdf
def test_empty_catalog_recovery_preserves_original_and_marks_partial(tmp_path, monkeypatch):
    import hashlib
    from types import SimpleNamespace
    import sigongnote_worker.pdf as module
    source = _pdf(tmp_path)
    before = source.read_bytes()
    real_open = module.pdfplumber.open
    calls = []

    def old_catalog(value):
        calls.append(value)
        if len(calls) == 1:
            return SimpleNamespace(doc=SimpleNamespace(catalog={}), close=lambda: None)
        return real_open(value)

    monkeypatch.setattr(module.pdfplumber, "open", old_catalog)
    result = parse_pdf(source)
    assert result["status"] == "partial"
    assert result["coverage"]["pages_read"] == 2
    assert any(issue["code"] == "pdf_structure_recovered" for issue in result["issues"])
    assert result["source_sha256"] == hashlib.sha256(before).hexdigest()
    assert source.read_bytes() == before


def _pdf(tmp_path, image_only=False, modified_second=False, page_count=2):
    path = tmp_path / ('scanned.pdf' if image_only else 'repeat.pdf')
    pdf = canvas.Canvas(str(path), pagesize=(612, 792))
    for page_index in range(1 if image_only else page_count):
        if image_only:
            image = Image.new('RGB', (1200, 400), 'white')
            ImageDraw.Draw(image).text((80, 100), 'INVOICE 40', fill='black',
                                       font=ImageFont.load_default(size=90))
            pdf.drawImage(ImageReader(image), 60, 500, width=480, height=160)
        else:
            pdf.setFont('Helvetica', 14)
            pdf.drawString(82, 690, 'Site A')
            pdf.drawString(350, 690, '40')
            if modified_second and page_index == 1:
                pdf.drawString(82, 672, 'COPY')
            for x in (72, 300, 440):
                pdf.line(x, 660, x, 710)
            for y in (660, 710):
                pdf.line(72, y, 440, y)
        pdf.showPage()
    pdf.save()
    return path


@pytest.mark.pdf
def test_two_page_repeated_table_keeps_both_sources_without_sum(tmp_path):
    result = parse_pdf(_pdf(tmp_path))
    assert result['status'] == 'complete'
    assert result['coverage']['pages_read'] == 2
    assert [page['number'] for page in result['pages']] == [1, 2]
    first, second = [page['tables'][0] for page in result['pages']]
    assert first['locator'] == 'page:1/table:0'
    assert second['locator'] == 'page:2/table:0'
    assert second['repeated_representation_of'] == first['locator']
    assert not first['aggregation_safe'] and not second['aggregation_safe']
    assert [cell['text'] for cell in first['cells'] if cell['text']] == ['Site A', '40']
    assert not any(key in result for key in ('amount', 'total', 'confirmed_amount'))
    assert all(len(word['bbox']) == 4 for page in result['pages'] for word in page['words'])


@pytest.mark.pdf
def test_changed_copy_row_still_cannot_be_aggregated(tmp_path):
    result = parse_pdf(_pdf(tmp_path, modified_second=True))
    first, second = [page['tables'][0] for page in result['pages']]
    assert first['representation_fingerprint'] != second['representation_fingerprint']
    assert second['repeated_representation_of'] is None
    assert not first['aggregation_safe'] and not second['aggregation_safe']


@pytest.mark.pdf
def test_page_failure_keeps_later_evidence_and_omits_exception_content(tmp_path, monkeypatch):
    from pdfplumber.page import Page
    source = _pdf(tmp_path)
    original_bytes = source.read_bytes()
    extract_words = Page.extract_words

    def fail_first(page, *args, **kwargs):
        if page.page_number == 1:
            raise ValueError("synthetic private source text and path")
        return extract_words(page, *args, **kwargs)

    monkeypatch.setattr(Page, "extract_words", fail_first)
    result = parse_pdf(source)
    assert result["status"] == "partial"
    assert [page["status"] for page in result["pages"]] == ["partial", "complete"]
    assert result["coverage"]["pages_read"] == 1
    assert result["coverage"]["pages_processed"] == 2
    assert result["coverage"]["pages_partial"] == 1
    assert result["issues"] == [{"code": "ValueError", "locator": "page:1"}]
    assert "synthetic private" not in str(result)
    assert source.read_bytes() == original_bytes


@pytest.mark.pdf
def test_repeated_tables_keep_lineage_across_page_chunks(tmp_path):
    result = parse_pdf(_pdf(tmp_path, page_count=21))
    assert result["status"] == "complete"
    assert result["coverage"]["pages_read"] == 21
    assert [page["chunk"] for page in result["pages"]] == [0] * 20 + [1]
    tables = [page["tables"][0] for page in result["pages"]]
    assert tables[0]["repeated_representation_of"] is None
    assert all(table["repeated_representation_of"] == "page:1/table:0" for table in tables[1:])
    assert all(not table["aggregation_safe"] for table in tables)


class EmptyOCR:
    def words(self, png: bytes, page: int, scale: float) -> list[dict]:
        assert png.startswith(b'\x89PNG') and page == 1 and scale > 0
        return []


@pytest.mark.pdf
def test_image_only_pdf_ocr_failure_is_visible_partial(tmp_path):
    result = parse_pdf(_pdf(tmp_path, image_only=True), ocr=EmptyOCR())
    assert result['status'] == 'partial'
    assert result['pages'][0]['status'] == 'partial'
    assert result['pages'][0]['text_source'] == 'ocr_candidate'
    assert len(result['pages'][0]['images']) >= 1
    assert len(result['pages'][0]['images'][0]['bbox']) == 4
    assert result['coverage']['pages_ocr_attempted'] == 1
    assert any(issue['code'] == 'OCR_EMPTY' for issue in result['issues'])


@pytest.mark.pdf
def test_local_korean_english_ocr_engine_when_installed(tmp_path):
    engine = LocalTesseract()
    if not engine.executable or not engine.tessdata_dir:
        pytest.skip('Local Tesseract and Korean model unavailable')
    result = parse_pdf(_pdf(tmp_path, image_only=True), ocr=engine)
    assert result['status'] == 'partial'  # OCR text never becomes confirmed automatically.
    assert result['coverage']['pages_ocr_attempted'] == 1
    assert result['coverage']['pages_ocr_read'] == 1
    assert result['pages'][0]['words']


@pytest.mark.pdf
def test_rejects_pdf_extension_masquerade(tmp_path):
    path = tmp_path / 'fake.pdf'
    path.write_bytes(b'ZIP')
    with pytest.raises(ValueError, match='INVALID_PDF_ENVELOPE'):
        parse_pdf(path)


@pytest.mark.pdf
def test_user_password_is_visible_encrypted_result(tmp_path):
    writer = PdfWriter()
    writer.append(str(_pdf(tmp_path)))
    writer.encrypt('fixture-only')
    path = tmp_path / 'locked.pdf'
    writer.write(str(path))
    result = parse_pdf(path)
    assert result['status'] == 'encrypted'
    assert result['issues'] == [{'code': 'password_required', 'locator': 'document'}]
    assert result['source_sha256']


class BoxOCR:
    def words(self, png: bytes, page: int, scale: float) -> list[dict]:
        return [{'text': '40', 'bbox': [10, 20, 30, 40],
                 'locator': f'page:{page}/ocr:0', 'source': 'ocr_candidate'}]


@pytest.mark.pdf
def test_rotated_cropped_ocr_coordinates_are_display_page_points(tmp_path):
    writer = PdfWriter()
    writer.append(str(_pdf(tmp_path, image_only=True)))
    page = writer.pages[0]
    page.cropbox.lower_left = (50, 50)
    page.cropbox.upper_right = (500, 700)
    page.rotate(90)
    path = tmp_path / 'rotated-cropped.pdf'
    writer.write(str(path))
    result = parse_pdf(path, ocr=BoxOCR())
    evidence = result['pages'][0]
    x0, y0, _, _ = evidence['cropbox']
    assert evidence['rotation'] == 90
    assert evidence['coordinate_space'] == 'rotated_page_top_left_points'
    assert evidence['words'][0]['bbox'] == [x0 + 10, y0 + 20, x0 + 30, y0 + 40]
    assert evidence['words'][0]['coordinate_space'] == evidence['coordinate_space']


@pytest.mark.pdf
def test_large_pdf_embedded_payload_and_upload_ceiling(tmp_path):
    import hashlib
    writer = PdfWriter()
    writer.append(str(_pdf(tmp_path)))
    writer.add_attachment('internal-regression.bin', b'x' * (51 * 1024 * 1024))
    path = tmp_path / 'large.pdf'
    writer.write(str(path))
    assert path.stat().st_size > 50 * 1024 * 1024
    with path.open('rb') as stream:
        before = hashlib.file_digest(stream, 'sha256').hexdigest()
    result = parse_pdf(path)
    assert result['coverage']['pages_read'] == 2
    with path.open('rb') as stream:
        assert result['source_sha256'] == before == hashlib.file_digest(stream, 'sha256').hexdigest()
    oversized = tmp_path / 'too-large.pdf'
    with oversized.open('wb') as stream:
        stream.truncate(200 * 1024 * 1024 + 1)
    with pytest.raises(ValueError, match='INVALID_PDF_ENVELOPE'):
        parse_pdf(oversized)
