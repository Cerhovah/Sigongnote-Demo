import io
from pathlib import Path
import pytest
from openpyxl import load_workbook
from pypdf import PdfReader
from sigongnote_worker.business_document import render_pdf, render_xlsx, validate, NAMES


def sample(kind="estimate", count=1):
    return {"document_number": "Q-0000001", "revision": 1, "template_version": "kr-basic-v1",
            "issuer": {"name": "합성 시공업체"}, "recipient": {"name": "합성 의뢰업체"},
            "project": {"id": "synthetic", "name": "합성 햇살현장"}, "date": "2026-09-30", "type": kind,
            "state": "approved", "missing": [], "terms": ["합성 개발 검증용 문서"],
            "lines": [{"id": str(n), "description": "주방 창틀 보수 및 실리콘 마감", "spec": "표준 흰색",
                       "unit": "식", "quantity": "1", "unit_price": "1250000", "supply": "1250000", "tax": "125000"} for n in range(count)],
            "totals": {"supply": str(1250000 * count), "tax": str(125000 * count), "total": str(1375000 * count)}}


@pytest.mark.parametrize("kind", list(NAMES))
def test_customer_snapshot_same_amount_and_literal_xlsx(kind):
    d = sample(kind)
    d["lines"][0]["description"] = '=HYPERLINK("https://invalid.example", "합성")'
    pdf, xlsx = render_pdf(d), render_xlsx(d)
    text = "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages)
    assert NAMES[kind] in text and "1,375,000" in text and "1,250,000" in text
    book = load_workbook(io.BytesIO(xlsx), data_only=False)
    assert len(book.worksheets) == 1 and book.active.sheet_state == "visible"
    assert book.active["A9"].data_type == "s"
    assert book.active["F13"].value == 1375000
    assert book.active["F13"].number_format == "#,##0;[Red]-#,##0"
    assert "." not in book.active["D9"].number_format
    assert not book._external_links and book.vba_archive is None
    assert not any(c.data_type == "f" for row in book.active for c in row)
    assert not any(word in text for word in ["margin_bps", "basis_hash", "actual_cost", "synthetic"])


def test_long_korean_pages_unknown_signed_and_internal_rejection(tmp_path):
    d = sample(count=100)
    for line in d["lines"]:
        line["description"] = "장문 한글 품목명 및 현장 조건을 줄바꿈하여 표시하는 창틀 보수 공사 " * 2
    pdf = render_pdf(d)
    pages = PdfReader(io.BytesIO(pdf)).pages
    assert len(pages) >= 5
    assert all("Q-0000001" in page.extract_text() for page in pages)
    assert "137,500,000" in pages[-1].extract_text()
    assert all("품명" in page.extract_text() for page in pages[:-1])
    unknown = sample(); unknown["state"] = "needs_inputs"
    unknown["lines"][0]["supply"] = unknown["lines"][0]["tax"] = None
    unknown["totals"] = {"supply": None, "tax": None, "total": None}
    assert "확인 필요" in PdfReader(io.BytesIO(render_pdf(unknown))).pages[0].extract_text()
    unknown["state"] = "approved"
    with pytest.raises(ValueError, match="UNKNOWN_APPROVED"):
        validate(unknown)
    signed = sample()
    for key in ["unit_price", "supply", "tax"]: signed["lines"][0][key] = "-" + signed["lines"][0][key]
    signed["totals"] = {k: "-" + v for k, v in signed["totals"].items()}
    assert "-1,375,000" in PdfReader(io.BytesIO(render_pdf(signed))).pages[0].extract_text()
    signed["internal_cost"] = "secret"
    with pytest.raises(ValueError, match="INVALID_PUBLIC"):
        render_xlsx(signed)
    # Synthetic visual review artifacts stay outside Git.
    evidence = Path(__file__).resolve().parents[3] / ".work" / "d16-evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "long-korean.pdf").write_bytes(pdf)
    (evidence / "estimate.pdf").write_bytes(render_pdf(sample()))
    (evidence / "estimate.xlsx").write_bytes(render_xlsx(sample()))


def test_nested_internal_fields_and_archive_metadata_are_not_public():
    import zipfile
    d = sample()
    d["totals"]["internal_cost"] = "DO_NOT_EXPORT_COST_731"
    with pytest.raises(ValueError, match="INVALID_PUBLIC_TOTALS"):
        render_xlsx(d)
    d = sample()
    data = render_xlsx(d)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        xml = "\n".join(archive.read(n).decode("utf-8") for n in archive.namelist() if n.endswith(".xml"))
        assert all(v not in xml for v in ["margin_bps", "internal_cost", "actual_cost", "basis_hash", "DO_NOT_EXPORT_COST_731"])
        assert 'state="hidden"' not in xml and 'state="veryHidden"' not in xml
        assert "<f>" not in xml and "externalLink" not in xml
    reader = PdfReader(io.BytesIO(render_pdf(d)))
    assert all(v not in str(reader.metadata) for v in ["margin_bps", "internal_cost", "actual_cost", "basis_hash"])


@pytest.mark.parametrize("kind", list(NAMES))
def test_wrapped_korean_spec_remains_visible_in_narrow_excel_column(kind):
    d = sample(kind, count=2)
    d["lines"][0].update(description="바닥재 시공", spec="비닐 바닥재, 3*450*450mm, 무광 마감")
    d["lines"][1].update(description="천장재 시공", spec="첫 번째 규격\r\n두 번째 규격\n세 번째 규격\r네 번째 규격")
    sheet = load_workbook(io.BytesIO(render_xlsx(d))).active
    # The old 32pt row hid the third line at the existing 11pt type size.
    assert sheet.row_dimensions[9].height >= 48
    assert sheet.row_dimensions[10].height >= 64
    assert sheet['B9'].value == d['lines'][0]['spec']
    assert sheet['B10'].value == '첫 번째 규격\n두 번째 규격\n세 번째 규격\n네 번째 규격'
    assert sheet['F14'].value == 2750000
    assert sheet.page_setup.fitToWidth == 1 and sheet.print_title_rows == '$8:$8'
    pdf_text = PdfReader(io.BytesIO(render_pdf(d))).pages[0].extract_text()
    assert '첫 번째 규격\n두 번째 규격\n세 번째 규격\n네 번째 규격' in pdf_text


@pytest.mark.parametrize("kind", list(NAMES))
def test_v2_business_blocks_seal_and_type_conditions(kind):
    d=sample(kind,count=4);d["template_version"]="kr-business-v2"
    d["form"]={"issuer":{"business_number":"000-00-00000","representative":"가상 대표","address":"가상시 시험로 1","business_type":"건설업","business_item":"실내건축","contact":"합성 담당자"},"recipient":{"business_number":"000-00-00001"},"valid_until":"2030-12-31","delivery_date":"2030-01-03","delivery_place":"가상 현장","payment_terms":"검수 후 협의 지급","payment_account":"가상은행 송금불가","note":"합성 출력 시험"}
    reader=PdfReader(io.BytesIO(render_pdf(d)));text="\n".join(p.extract_text() for p in reader.pages)
    assert len(reader.pages)==1
    assert all(v in text for v in ["사업자등록번호","000-00-00000","발행자 직인","날인란 (빈칸)","5,500,000"])
    assert not any(v in text for v in ["재료비","노무비","경비","margin_bps","internal_cost"])
    sheet=load_workbook(io.BytesIO(render_xlsx(d))).active
    assert sheet['G22'].value==5500000
    assert sheet.row_dimensions[13].height>=45
    assert sheet['A15'].value=='No.' and sheet['B16'].value==d['lines'][0]['description']
    assert sheet.print_title_rows=='$15:$15' and not any(c.data_type=='f' for row in sheet for c in row)
    if kind=='delivery_statement': assert '인수 확인란 (별도 확인)' in text
    if kind=='invoice': assert '입금 계좌·예금주' in text and '전자세금계산서가 아닙니다' in text
    d['form']['issuer']['internal_cost']='secret'
    with pytest.raises(ValueError,match='INVALID_FORM_PARTY'):render_pdf(d)


def test_v2_long_party_metadata_wraps_and_v1_rejects_new_fields():
    d=sample(count=80);d['template_version']='kr-business-v2';d['form']={'issuer':{'address':'합성 주소 '*30},'note':'합성 비고 '*40}
    reader=PdfReader(io.BytesIO(render_pdf(d)))
    assert len(reader.pages)>4 and all('Q-0000001' in p.extract_text() for p in reader.pages)
    sheet=load_workbook(io.BytesIO(render_xlsx(d))).active
    assert sheet.row_dimensions[9].height>32
    d['template_version']='kr-basic-v1'
    with pytest.raises(ValueError,match='INVALID_PUBLIC_DOCUMENT'):render_pdf(d)
