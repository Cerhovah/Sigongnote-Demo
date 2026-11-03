"""Synthetic, pseudonymized structure goldens; USB originals never enter the repo."""
import struct
import zipfile
import zlib

import pytest

from sigongnote_worker.hwp import _hwp5_section, _hwp_text, _inflate, _records, assess_golden, parse_hwpx


@pytest.mark.hwp
def test_hwp5_short_opaque_compression_trailer_is_partial_not_lost():
    compressor = zlib.compressobj(wbits=-15)
    raw = compressor.compress(b"record") + compressor.flush()
    issues = []
    assert _inflate(raw + b"opaque!!", issues, "DocInfo") == b"record"
    assert issues == [{"code": "trailing_compressed_bytes", "locator": "DocInfo"}]
    with pytest.raises(ValueError, match="HWP_TRAILING_DATA_LIMIT"):
        _inflate(raw + b"x" * 4097, [], "DocInfo")


def _cell(row, col, text, rowspan=1, colspan=1):
    return (f'<hp:tc><hp:cellAddr rowAddr="{row}" colAddr="{col}"/>'
            f'<hp:cellSpan rowSpan="{rowspan}" colSpan="{colspan}"/>'
            f'<hp:subList><hp:p><hp:run><hp:t>{text}</hp:t></hp:run></hp:p>'
            '</hp:subList></hp:tc>')


def _table(rows):
    cols = max(sum(int(cell.split('colSpan="')[1].split('"')[0]) for cell in row)
               for row in rows)
    return (f'<hp:tbl rowCnt="{len(rows)}" colCnt="{cols}">' +
            ''.join('<hp:tr>' + ''.join(row) + '</hp:tr>' for row in rows) +
            '</hp:tbl>')


@pytest.fixture
def hwpx(tmp_path):
    def make(sections, extra=None):
        path = tmp_path / 'golden.hwpx'
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('mimetype', 'application/hwp+zip')
            archive.writestr('Preview/PrvText.txt', 'not the body')
            for index, body in enumerate(sections):
                archive.writestr(f'Contents/section{index}.xml',
                                 f'<hp:sec xmlns:hp="urn:hwp:paragraph">{body}</hp:sec>')
            for name, value in (extra or {}).items():
                archive.writestr(name, value)
        return path
    return make


@pytest.mark.hwp
@pytest.mark.parametrize('sections,expected', [
    ([_table([[_cell(0, 0, '현장 가'), _cell(0, 1, '40')]])], ['현장 가', '40']),
    (['<hp:p><hp:run><hp:t>가명 현장</hp:t></hp:run></hp:p>',
      _table([[_cell(0, 0, '수량'), _cell(0, 1, '40')]])], ['수량', '40']),
    ([_table([[_cell(0, 0, '단위'), _cell(0, 1, '개')],
             [_cell(1, 0, '금액'), _cell(1, 1, '')]])], ['단위', '개', '금액', '']),
    ([_table([[_cell(0, 0, '반복 제목', colspan=2)],
             [_cell(1, 0, '1차'), _cell(1, 1, '40')]])], ['반복 제목', '1차', '40']),
])
def test_four_pseudonymized_structure_goldens(hwpx, sections, expected):
    parsed = parse_hwpx(hwpx(sections))
    cells = [cell['text'] for section in parsed['sections'] for table in section['tables']
             for cell in table['cells']]
    assert cells == expected
    assert parsed['status'] == 'complete'
    assert parsed['coverage']['sections_read'] == len(sections)
    assert parsed['coverage']['cells_read'] == len(expected)
    assert parsed['source_sha256']
    expected_map = {cell['locator']: {'text': value, 'critical': True}
                    for section in parsed['sections'] for table in section['tables']
                    for cell, value in zip(table['cells'],
                        [item['text'] for item in table['cells']])}
    assessment = assess_golden(parsed, expected_map)
    assert assessment['critical_mismatches'] == 0
    assert assessment['cell_accuracy'] == 1
    assert assessment['read_coverage'] == 1


@pytest.mark.hwp
def test_repeated_table_is_two_source_locators(hwpx):
    table = _table([[_cell(0, 0, '40')]])
    parsed = parse_hwpx(hwpx([table, table]))
    assert [section['tables'][0]['cells'][0]['locator'] for section in parsed['sections']] == [
        'section:0/table:0/cell:0,0', 'section:1/table:0/cell:0,0']


@pytest.mark.hwp
def test_missing_cell_is_partial_never_complete(hwpx):
    broken = '<hp:tbl rowCnt="1" colCnt="2"><hp:tr>' + _cell(0, 0, '40') + '</hp:tr></hp:tbl>'
    parsed = parse_hwpx(hwpx([broken]))
    assert parsed['status'] == 'partial'
    assert 'table_grid_incomplete' in [issue['code'] for issue in parsed['issues']]
    assessment = assess_golden(parsed, {
        'section:0/table:0/cell:0,0': {'text': '40', 'critical': True},
        'section:0/table:0/cell:0,1': {'text': '', 'critical': True}})
    assert assessment['cell_accuracy'] == 0.5
    assert assessment['read_coverage'] == 0.5
    assert assessment['critical_mismatches'] == 1
    assert not assessment['eligible_for_auto_attribution']


@pytest.mark.hwp
def test_rejects_preview_only_and_unsafe_zip(tmp_path, hwpx):
    with pytest.raises(ValueError, match='HWPX_SECTIONS_MISSING'):
        parse_hwpx(hwpx([]))
    with pytest.raises(ValueError, match='UNSAFE_HWPX_ENTRY'):
        parse_hwpx(hwpx(['<hp:p/>'], {'../escape': 'x'}))


@pytest.mark.hwp
def test_xml_entity_is_not_expanded(hwpx):
    malicious = '<!DOCTYPE x [<!ENTITY x "private">]><hp:p><hp:t>&x;</hp:t></hp:p>'
    parsed = parse_hwpx(hwpx([malicious]))
    assert parsed['status'] == 'partial'
    assert parsed['coverage']['sections_read'] == 0


def _record(tag, level, payload):
    return struct.pack('<I', tag | (level << 10) | (len(payload) << 20)) + payload


@pytest.mark.hwp
def test_hwp5_record_table_cell_and_section_boundary():
    table_payload = b'\0' * 4 + struct.pack('<HH', 1, 1) + b'\0' * 14
    list_payload = b'\0' * 8 + struct.pack('<HHHH', 0, 0, 1, 1) + b'\0' * 18
    body = (_record(77, 2, table_payload) + _record(72, 2, list_payload) +
            _record(67, 3, '수량 40'.encode('utf-16le')))
    assert len(list(_records(body))) == 3
    issues = []
    section = _hwp5_section(body, 0, issues)
    assert issues == []
    assert section['tables'][0]['cells'][0]['text'] == '수량 40'
    assert section['tables'][0]['cells'][0]['locator'] == 'section:0/table:0/cell:0,0'
    with pytest.raises(ValueError, match='TRUNCATED_HWP_RECORD'):
        list(_records(body[:-1]))


@pytest.mark.hwp
def test_hwp5_unicode_pairs_and_broken_pair():
    assert _hwp_text('가😀'.encode('utf-16le')) == '가😀'
    with pytest.raises(ValueError, match='UNPAIRED_HWP_SURROGATE'):
        _hwp_text(struct.pack('<H', 0xD800))


@pytest.mark.hwp
def test_hwp5_control_width_does_not_cut_amount():
    amount = '1,500'.encode('utf-16le') + struct.pack('<H', 30) + '000원'.encode('utf-16le')
    assert _hwp_text(amount) == '1,500 000원'
    extended = '가'.encode('utf-16le') + struct.pack('<H', 11) + b'\0' * 14 + '나'.encode('utf-16le')
    assert _hwp_text(extended) == '가나'


@pytest.mark.hwp
def test_nested_hwpx_table_text_has_one_owner_without_text_deduplication(hwpx):
    # Two independent identical paragraphs remain two observations; table text
    # must not leak into its enclosing paragraph or be emitted as cell paragraphs.
    paragraph = '<hp:p><hp:run><hp:t>합성 반복 요청</hp:t></hp:run></hp:p>'
    inner = _table([[_cell(0, 0, '합성 안쪽 셀')]])
    outer = _table([[_cell(0, 0, '합성 바깥 셀' + inner)]])
    parsed = parse_hwpx(hwpx([paragraph + paragraph + '<hp:p><hp:run><hp:t>표 제목</hp:t>' + outer + '</hp:run></hp:p>']))
    section = parsed['sections'][0]
    assert [p['text'] for p in section['paragraphs']] == ['합성 반복 요청', '합성 반복 요청', '표 제목']
    assert [c['text'] for t in section['tables'] for c in t['cells']] == ['합성 바깥 셀', '합성 안쪽 셀']
    assert len({p['locator'] for p in section['paragraphs']}) == 3
    assert parsed['status'] == 'partial'  # Nested structure still requires review.
