"""Isolated LibreOffice evidence-copy renderer. Never approves a quote or sends it.

Run in Docker with --network=none, read-only input, and a dedicated output mount.
Only macro-free, self-contained XLSX is supported. Output remains internal review data.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import time
import zipfile
from xml.etree import ElementTree as ET


def inspect_package(source: Path) -> dict:
    if source.suffix.lower() != '.xlsx' or source.stat().st_size > 50 * 1024**2:
        raise ValueError('UNSUPPORTED_OR_TOO_LARGE')
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 5000 or sum(x.file_size for x in entries) > 100 * 1024**2:
            raise ValueError('EXPANSION_LIMIT')
        names = archive.namelist()
        if len(names) != len(set(names)) or '[Content_Types].xml' not in names or any(
                n in ('mimetype', 'content.xml') or n.startswith('META-INF/') for n in names):
            raise ValueError('AMBIGUOUS_PACKAGE')
        if any(re.search(r'vbaProject|externalLinks/|embeddings/|activeX/|connections.xml|queryTables/|_xmlsignatures/', n, re.I) for n in names):
            raise ValueError('ACTIVE_OR_EXTERNAL_CONTENT')
        for name in names:
            if not name.endswith(('.xml', '.rels')):
                continue
            data = archive.read(name)
            text = data.decode('utf-8-sig')
            if '\x00' in text or '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
                raise ValueError('UNSUPPORTED_XML')
            tree = ET.fromstring(data)
            if name.endswith('.rels') and any(x.get('TargetMode') == 'External' for x in tree):
                raise ValueError('EXTERNAL_RELATIONSHIP')
            # Even without an externalLink relationship, these formulas can fetch data.
            for el in tree.iter():
                if el.tag.rsplit('}', 1)[-1] in ('f', 'definedName', 'formula', 'formula1', 'formula2'):
                    formula = el.text or ''
                    if re.search(r'WEBSERVICE|DDE\s*\(|HYPERLINK\s*\(|\[', formula, re.I):
                        raise ValueError('UNSUPPORTED_FORMULA_SYNTAX')
                    if re.search(r'\b(?:TODAY|NOW|RAND|RANDBETWEEN|RANDARRAY|INFO|CELL|INDIRECT|OFFSET)\s*\(', formula, re.I):
                        raise ValueError('VOLATILE_FORMULA')
        wb = ET.fromstring(archive.read('xl/workbook.xml'))
        ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        return {'sheets': len(wb.findall('m:sheets/m:sheet', ns)),
                'hidden_sheets': sum(s.get('state', 'visible') != 'visible' for s in wb.findall('m:sheets/m:sheet', ns)),
                'images': sum(n.startswith('xl/media/') for n in names),
                'comments': sum(bool(re.search(r'xl/comments\d+\.xml', n)) for n in names)}


def cached_formulas(source: Path) -> list[dict]:
    """Source caches are comparison evidence, never authoritative ledger amounts."""
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    rid = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
    with zipfile.ZipFile(source) as z:
        rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        wb = ET.fromstring(z.read('xl/workbook.xml'))
        result = []
        for i, sheet in enumerate(wb.findall('m:sheets/m:sheet', ns)):
            target = rels[sheet.get(rid)]
            name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
            if not name.startswith('xl/worksheets/'): raise ValueError('UNSUPPORTED_SHEET')
            for cell in ET.fromstring(z.read(name)).findall('.//m:c', ns):
                if cell.find('m:f', ns) is None: continue
                address = cell.get('r', '')
                if not re.fullmatch('[A-Z]{1,3}[1-9][0-9]{0,5}', address): raise ValueError('INVALID_CELL')
                value = cell.find('m:v', ns)
                kind = cell.get('t', 'n')
                if kind not in ('n','b','str'): raise ValueError('UNSUPPORTED_FORMULA_RESULT')
                result.append({'sheet':i, 'address':address, 'kind':kind,
                    'cached':None if value is None else value.text})
        return result


def cache_matches(item: dict, numeric: float, text: str) -> bool | None:
    if item['cached'] is None: return None
    if item['kind'] == 'str': return item['cached'] == text
    return math.isclose(float(item['cached']), numeric, rel_tol=1e-12, abs_tol=1e-8)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render(source: Path, output: Path, *, print_range: str | None = None,
           section_breaks: tuple[int, ...] = (), fit_columns: tuple[str, ...] = ()) -> dict:
    import uno  # Installed with the native engine, never emulated by cached values.
    from com.sun.star.beans import PropertyValue

    inventory = inspect_package(source)
    source_formulas = cached_formulas(source)
    before = sha(source)
    output.mkdir(parents=True, exist_ok=False)
    editable = Path('/tmp/office-editable.xlsx')
    shutil.copyfile(source, editable)
    def prop(name, value):
        p = PropertyValue(); p.Name = name; p.Value = value
        return p
    profile = Path('/tmp/office-profile')
    process = subprocess.Popen(['soffice', '-env:UserInstallation=' + profile.as_uri(),
        '--headless', '--norestore', '--nodefault', '--nofirststartwizard',
        '--accept=pipe,name=sigongnote;urp;StarOffice.ComponentContext'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    doc = None
    try:
        context = uno.getComponentContext()
        resolver = context.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', context)
        remote = None
        for _ in range(100):
            try:
                remote = resolver.resolve('uno:pipe,name=sigongnote;urp;StarOffice.ComponentContext'); break
            except Exception:
                if process.poll() is not None: raise RuntimeError('OFFICE_START_FAILED') from None
                time.sleep(.1)
        if remote is None: raise RuntimeError('OFFICE_START_TIMEOUT')
        desktop = remote.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', remote)
        doc = desktop.loadComponentFromURL(editable.as_uri(), '_blank', 0, (
            prop('FilterName', 'Calc MS Excel 2007 XML'),
            prop('Hidden', True), prop('ReadOnly', False), prop('MacroExecutionMode', 0),
            prop('UpdateDocMode', 0), prop('Silent', True)))
        if doc is None or not doc.supportsService('com.sun.star.sheet.SpreadsheetDocument'):
            raise ValueError('SPREADSHEET_LOAD_FAILED')
        if print_range:
            if not re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]{0,5}:[A-Z]{1,3}[1-9][0-9]{0,5}', print_range):
                raise ValueError('INVALID_PRINT_RANGE')
            if doc.Sheets.Count != 1: raise ValueError('SINGLE_SHEET_REQUIRED')
            sheet = doc.Sheets.getByIndex(0)
            sheet.setPrintAreas((sheet.getCellRangeByName(print_range).getRangeAddress(),))
        if section_breaks:
            if doc.Sheets.Count != 1 or any(type(r) is not int or not 2 <= r <= 10000 for r in section_breaks):
                raise ValueError('INVALID_SECTION_BREAKS')
            for row in section_breaks:
                doc.Sheets.getByIndex(0).Rows.getByIndex(row - 1).IsStartOfNewPage = True
        doc.calculateAll()
        if fit_columns:
            if doc.Sheets.Count != 1 or len(fit_columns)>20 or any(not re.fullmatch('[A-Z]{1,2}',c) for c in fit_columns):
                raise ValueError('INVALID_FIT_COLUMNS')
            sheet = doc.Sheets.getByIndex(0)
            for column in fit_columns:
                # A1 may belong to a merged title: do not resolve the column via
                # a merged cell range (which can return its anchor column).
                index = 0
                for letter in column: index = index * 26 + ord(letter) - 64
                index -= 1
                target_column = sheet.Columns.getByIndex(index)
                # Accounting formats reserve padding; native autofit may retain a
                # too-narrow source width. This explicit review-copy override is logged.
                target_column.setPropertyValue('Width', max(target_column.Width, 4500))
                if target_column.Width < 4500: raise ValueError('LAYOUT_WRITE_REJECTED')
        formula_errors = []
        computed = []
        mismatches, missing_cache = [], []
        for i in range(doc.Sheets.Count):
            sheet = doc.Sheets.getByIndex(i)
            cursor = sheet.createCursor(); cursor.gotoEndOfUsedArea(True)
            area = cursor.RangeAddress
            if (area.EndColumn + 1) * (area.EndRow + 1) > 100000:
                raise ValueError('CELL_LIMIT')
            for row in range(area.EndRow + 1):
                for col in range(area.EndColumn + 1):
                    cell = sheet.getCellByPosition(col, row)
                    if cell.Error: formula_errors.append([i, row, col, cell.Error])
        for item in source_formulas:
            cell = doc.Sheets.getByIndex(item['sheet']).getCellRangeByName(item['address'])
            matched = cache_matches(item, cell.Value, cell.String)
            if matched is False: mismatches.append([item['sheet'], item['address']])
            if matched is None: missing_cache.append([item['sheet'], item['address']])
            address = cell.CellAddress
            computed.append({'sheet': item['sheet'], 'row':address.Row, 'column':address.Column,
                'kind':item['kind'], 'value':cell.String if item['kind']=='str' else cell.Value})
        if formula_errors: raise ValueError('FORMULA_ERROR')
        if mismatches: raise ValueError('CACHED_VALUE_MISMATCH')
        xlsx, pdf = output / 'document.xlsx', output / 'document.pdf'
        doc.storeToURL(xlsx.as_uri(), (prop('FilterName','Calc MS Excel 2007 XML'), prop('Overwrite',False)))
        doc.storeToURL(pdf.as_uri(), (prop('FilterName','calc_pdf_Export'), prop('Overwrite',False)))
        rendered_text = subprocess.check_output(['pdftotext',str(pdf),'-'], text=True)
        if re.search(r'#{3,}', rendered_text): raise ValueError('PRINT_OVERFLOW')
        if sha(source) != before: raise ValueError('SOURCE_CHANGED')
        result = {'purpose':'internal_historical_copy_not_new_quote', 'source_sha256':before,
            'xlsx_sha256':sha(xlsx), 'pdf_sha256':sha(pdf), 'formula_count':len(computed),
            'formula_errors':0, 'recalculated':True, 'macro_execution':False, 'external_updates':False,
            'cached_mismatches':len(mismatches), 'missing_caches':len(missing_cache),
            'xlsx_fidelity':'libreoffice_reexport_with_overrides',
            'fonts':{p.name:sha(p) for p in Path('/usr/share/fonts/truetype/local-user').glob('*.ttf')},
            'inventory':inventory, 'print_range_override':print_range, 'section_breaks':section_breaks, 'fit_columns':fit_columns,
            'engine':subprocess.check_output(['soffice','--version'], text=True).strip(),
            'customer_release_approved':False, 'source_unchanged':True}
        (output/'manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        (output/'computed-private.json').write_text(json.dumps(computed),encoding='utf-8')
        return result
    finally:
        try:
            if doc is not None: doc.close(True)
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill()


if __name__ == '__main__':
    # Fixed mount layout: a document can never choose filesystem targets.
    try:
        layout_path = Path('/input/layout.json')
        layout = json.loads(layout_path.read_text()) if layout_path.exists() else {}
        if set(layout) - {'print_range','section_breaks','fit_columns'}: raise ValueError('INVALID_LAYOUT')
        print(json.dumps(render(Path('/input/source.xlsx'), Path('/output/result'),
            print_range=layout.get('print_range'), section_breaks=tuple(layout.get('section_breaks',[])),
            fit_columns=tuple(layout.get('fit_columns',[])))))
    except Exception as error:
        safe = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]+',str(error)) else 'OFFICE_RENDER_FAILED'
        print(json.dumps({'error':safe}))
        raise SystemExit(1)
