from __future__ import annotations

import zipfile

import openpyxl
import pytest
import xlwt

from sigongnote_worker.spreadsheet import parse_spreadsheet


@pytest.mark.spreadsheet
def test_xlsx_separates_bundle_from_four_scope_rows(tmp_path):
    path = tmp_path / "labor.xlsx"
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "공임"
    sheet.append(["위치", "단위", "산정수량", "금액"])
    for row, location in enumerate(("가명 1", "가명 2", "가명 3", "가명 4"), 2):
        sheet.cell(row, 1, location)
        sheet.cell(row, 2, "식" if row == 2 else None)
        sheet.cell(row, 3, 1 if row == 2 else None)
        sheet.cell(row, 4, 150000 if row == 2 else None)
    sheet.merge_cells("A6:B6")
    hidden = book.create_sheet("숨김")
    hidden.sheet_state = "hidden"
    hidden["A1"] = "계획 80틀"
    hidden["B1"] = "공수 5일"
    book.save(path)
    parsed = parse_spreadsheet(path)
    assert parsed["status"] == "complete"
    assert parsed["coverage"]["sheets_read"] == 2
    assert parsed["sheets"][1]["state"] == "hidden"
    assert parsed["sheets"][0]["merged_ranges"] == ["A6:B6"]
    cells = parsed["sheets"][0]["cells"]
    assert [cell["value"] for cell in cells if cell["value"] == 150000] == [150000]
    assert [cell["value"] for cell in cells if cell["value"] == "식"] == ["식"]
    assert [cell["value"] for cell in parsed["sheets"][1]["cells"]] == ["계획 80틀", "공수 5일"]
    assert all(cell["locator"].startswith("sheet:") for cell in cells)


@pytest.mark.spreadsheet
def test_formula_without_cache_is_partial_not_zero(tmp_path):
    path = tmp_path / "formula.xlsx"
    book = openpyxl.Workbook()
    sheet = book.active
    sheet["A1"] = "=SUM(B1:B2)"
    sheet["A2"] = "=#REF!"
    book.save(path)
    parsed = parse_spreadsheet(path)
    assert parsed["status"] == "partial"
    a1, a2 = parsed["sheets"][0]["cells"]
    assert a1["formula"] == "=SUM(B1:B2)"
    assert a1["cached_value"] is None
    assert a1["calculation_status"] == "cache_missing"
    assert a2["calculation_status"] == "external_or_broken_reference"


@pytest.mark.spreadsheet
def test_xls_biff_values_date_merge_and_formula_uncertainty(tmp_path):
    path = tmp_path / "legacy.xls"
    book = xlwt.Workbook()
    sheet = book.add_sheet("공임")
    sheet.write_merge(0, 0, 0, 1, "현장 가")
    sheet.write(1, 0, 150000)
    date_style = xlwt.easyxf(num_format_str="YYYY-MM-DD")
    sheet.write(2, 0, 45292, date_style)
    book.save(str(path))
    parsed = parse_spreadsheet(path)
    assert parsed["status"] == "partial"
    assert parsed["sheets"][0]["merged_ranges"] == ["A1:B1"]
    cells = parsed["sheets"][0]["cells"]
    assert [cell["value"] for cell in cells] == ["현장 가", 150000.0, "2024-01-01T00:00:00"]
    assert all(cell["calculation_status"] == "cached_value_only" for cell in cells)


@pytest.mark.spreadsheet
def test_rejects_extension_disguise_and_zip_traversal(tmp_path):
    fake = tmp_path / "fake.xls"
    fake.write_bytes(b"PK\x03\x04garbage")
    with pytest.raises(ValueError, match="INVALID_SPREADSHEET_ENVELOPE"):
        parse_spreadsheet(fake)
    path = tmp_path / "unsafe.xlsx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", "x")
        archive.writestr("[Content_Types].xml", "x")
        archive.writestr("../escape", "x")
    with pytest.raises(ValueError, match="UNSAFE_XLSX_ENTRY"):
        parse_spreadsheet(path)


@pytest.mark.spreadsheet
def test_xlsx_cell_limit_precedes_workbook_materialization(tmp_path, monkeypatch):
    path = tmp_path / "many.xlsx"
    book = openpyxl.Workbook()
    for col in range(1, 4):
        book.active.cell(1, col, col)
    book.save(path)
    monkeypatch.setattr("sigongnote_worker.spreadsheet.MAX_POPULATED_CELLS", 2)
    monkeypatch.setattr(openpyxl, "load_workbook", lambda *args, **kwargs: pytest.fail("loaded before limit"))
    parsed = parse_spreadsheet(path)
    assert parsed["status"] == "partial"
    assert parsed["issues"] == [{"code": "cell_limit_exceeded", "locator": "workbook"}]


@pytest.mark.spreadsheet
def test_large_sparse_xlsx_keeps_values_without_materializing_empty_rectangle(tmp_path):
    import hashlib
    path = tmp_path / "large-sparse.xlsx"
    book = openpyxl.Workbook()
    book.active["A1"] = "단위: 원"
    book.active["XFD1048576"] = 12.5
    book.save(path)
    # A large embedded payload must not cause loading millions of empty cells.
    with zipfile.ZipFile(path, "a", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("xl/media/unused.bin", b"x" * (31 * 1024 * 1024))
    with path.open("rb") as stream:
        before = hashlib.file_digest(stream, "sha256").hexdigest()
    result = parse_spreadsheet(path)
    assert result["status"] == "complete"
    assert result["coverage"]["populated_cells_read"] == 2
    assert result["sheets"][0]["cells"][1]["raw_numeric"] == "12.5"
    assert result["sheets"][0]["cells"][1]["address"] == "XFD1048576"
    with path.open("rb") as stream:
        assert result["source_sha256"] == before == hashlib.file_digest(stream, "sha256").hexdigest()


@pytest.mark.spreadsheet
def test_spreadsheet_upload_ceiling_still_applies(tmp_path):
    path = tmp_path / "too-large.xlsx"
    with path.open("wb") as stream:
        stream.truncate(200 * 1024 * 1024 + 1)
    with pytest.raises(ValueError, match="SPREADSHEET_INPUT_LIMIT"):
        parse_spreadsheet(path)


@pytest.mark.spreadsheet
def test_unloaded_external_caches_do_not_consume_parsed_xml_budget(tmp_path, monkeypatch):
    path = tmp_path / 'external-cache.xlsx'
    book = openpyxl.Workbook()
    book.active['A1'] = '실제 셀'
    book.save(path)
    with zipfile.ZipFile(path, 'a', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr('xl/externalLinks/unused.xml', b'x' * 65536)
    monkeypatch.setattr('sigongnote_worker.spreadsheet.MAX_EXPANDED', 32768)
    result = parse_spreadsheet(path)
    assert result['coverage']['populated_cells_read'] == 1
    assert result['status'] == 'partial'
    assert result['issues'] == [{'code': 'external_link_present', 'locator': 'workbook'}]


@pytest.mark.spreadsheet
def test_invalid_style_preserves_cell_value_and_marks_unknown_format(tmp_path):
    original = tmp_path / 'source.xlsx'
    path = tmp_path / 'broken-style.xlsx'
    book = openpyxl.Workbook()
    book.active['A1'] = 12.5
    book.save(original)
    with zipfile.ZipFile(original) as source, zipfile.ZipFile(path, 'w') as target:
        for info in source.infolist():
            value = source.read(info)
            if info.filename == 'xl/worksheets/sheet1.xml':
                value = value.replace(b'<c r="A1"', b'<c r="A1" s="9999"')
            target.writestr(info, value)
    result = parse_spreadsheet(path)
    cell = result['sheets'][0]['cells'][0]
    assert result['status'] == 'partial'
    assert cell['value'] == 12.5 and cell['raw_numeric'] == '12.5'
    assert cell['number_format'] is None
    assert result['issues'] == [{'code': 'invalid_cell_style', 'locator': 'sheet:0/cell:A1'}]


@pytest.mark.spreadsheet
def test_missing_dimension_keeps_streaming_cells_without_forced_rectangle_scan(tmp_path):
    import re
    original = tmp_path / 'with-dimension.xlsx'
    path = tmp_path / 'without-dimension.xlsx'
    book = openpyxl.Workbook()
    book.active['A1'] = '품명'
    book.active['XFD1048576'] = 28
    book.save(original)
    with zipfile.ZipFile(original) as source, zipfile.ZipFile(path, 'w') as target:
        for info in source.infolist():
            value = source.read(info)
            if info.filename == 'xl/worksheets/sheet1.xml':
                value = re.sub(rb'<dimension\b[^>]*/>', b'', value)
            target.writestr(info, value)
    result = parse_spreadsheet(path)
    assert result['status'] == 'partial'
    assert result['coverage']['populated_cells_read'] == 2
    assert result['sheets'][0]['cells'][1]['raw_numeric'] == '28'
    assert result['sheets'][0]['dimensions'] is None
    assert result['issues'] == [{'code': 'dimension_unknown', 'locator': 'sheet:0'}]
