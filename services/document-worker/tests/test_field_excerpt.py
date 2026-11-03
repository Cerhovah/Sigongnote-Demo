from sigongnote_worker.__main__ import excerpt


def test_cached_formula_is_available_but_not_recomputed():
    source = {'status': 'partial', 'source_sha256': 'a' * 64, 'sheets': [{'cells': [
        {'locator': 'sheet:0/cell:D20', 'formula': '=SUM(D1:D19)', 'cached_value': 150000},
        {'locator': 'sheet:0/cell:D21', 'formula': '=D20*0.1', 'cached_value': None},
    ]}]}
    result = excerpt(source)
    assert '150000' in result['spans'][0]['text']
    assert '재계산 안 함' in result['spans'][0]['text']
    assert '수식값 없음' in result['spans'][1]['text']


def test_raw_decimal_survives_float_rounding(tmp_path):
    import zipfile
    import openpyxl
    from sigongnote_worker.spreadsheet import parse_spreadsheet
    source = tmp_path / "decimal.xlsx"
    book = openpyxl.Workbook()
    book.active["A1"] = "=1/3"
    book.save(source)
    with zipfile.ZipFile(source) as old:
        entries = {name: old.read(name) for name in old.namelist()}
    entries["xl/worksheets/sheet1.xml"] = entries["xl/worksheets/sheet1.xml"].replace(b"<v />", b"<v>0.33333333333333331</v>").replace(b"<v></v>", b"<v>0.33333333333333331</v>")
    with zipfile.ZipFile(source, "w") as new:
        for name, data in entries.items():
            new.writestr(name, data)
    parsed = parse_spreadsheet(source)
    assert parsed["sheets"][0]["cells"][0]["raw_numeric"] == "0.33333333333333331"
    assert "0.33333333333333331" in excerpt(parsed)["spans"][0]["text"]
