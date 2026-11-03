from pathlib import Path
import zipfile
import pytest
from sigongnote_worker.office_copy import inspect_package, cache_matches


def package(path: Path, extra=None):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Fixture" sheetId="1"/></sheets></workbook>')
        for name, body in (extra or {}).items(): z.writestr(name, body)


def test_passive_xlsx_and_source_unchanged(tmp_path):
    p = tmp_path/'copy.xlsx'; package(p)
    before = p.read_bytes()
    assert inspect_package(p)['sheets'] == 1
    assert p.read_bytes() == before


@pytest.mark.parametrize('extra', [
    {'xl/vbaProject.bin': b'fixture'},
    {'xl/embeddings/oleObject1.bin': b'fixture'},
    {'xl/externalLinks/externalLink1.xml': '<x/>'},
    {'xl/_rels/workbook.xml.rels':'<Relationships><Relationship TargetMode="External" Target="https://example.invalid/"/></Relationships>'},
    {'xl/worksheets/sheet1.xml':'<worksheet xmlns="urn:test"><f>WEBSERVICE("https://example.invalid/")</f></worksheet>'},
    {'xl/worksheets/sheet1.xml':'<!DOCTYPE x [<!ENTITY e "fixture">]><x>&e;</x>'},
    {'mimetype':'application/vnd.oasis.opendocument.spreadsheet'},
    {'content.xml':'<x/>'},
    {'xl/worksheets/sheet1.xml':'<worksheet xmlns="urn:test"><f>TODAY()</f></worksheet>'},
    {'xl/worksheets/sheet1.xml':'<!DOCTYPE x [<!ENTITY e "fixture">]><x>&e;</x>'.encode('utf-16')},
])
def test_active_or_external_documents_fail_closed(tmp_path, extra):
    p = tmp_path/'copy.xlsx'; package(p, extra)
    with pytest.raises(ValueError): inspect_package(p)


def test_duplicate_zip_names_rejected(tmp_path):
    p = tmp_path/'copy.xlsx'; package(p)
    with zipfile.ZipFile(p, 'a') as z:
        with pytest.warns(UserWarning): z.writestr('[Content_Types].xml', '<Types/>')
    with pytest.raises(ValueError, match='AMBIGUOUS_PACKAGE'): inspect_package(p)


def test_recalculated_values_compare_types_and_unknown():
    assert cache_matches({'kind':'n','cached':'1.25'},1.25,'')
    assert not cache_matches({'kind':'n','cached':'1.25'},1.26,'')
    assert cache_matches({'kind':'str','cached':'ready'},0,'ready')
    assert not cache_matches({'kind':'str','cached':'ready'},0,'changed')
    assert cache_matches({'kind':'n','cached':None},0,'') is None
