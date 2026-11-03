"""Convert an existing, locally approved field dataset to the demo's private bundle.

No network calls. Source files remain read-only. Outputs must stay outside Git.
Usage: python scripts/import-field-dataset.py --input DATASET --output PRIVATE_DIR
"""
import argparse
import csv
import datetime
import hashlib
import json
import pathlib
import re
import sys
from collections import defaultdict


def optional(value):
    value = str(value or '').strip()
    return None if value in ('', '미확인', '미측정', '없음', '해당없음', '해당 없음') else value


def date(value):
    value = optional(value)
    if not value:
        return None
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        try:
            datetime.date.fromisoformat(value)
            return value
        except ValueError:
            return None
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})', value):
        return value
    return None


def money(value):
    value = optional(value)
    if not value:
        return None
    if re.fullmatch(r'-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\s*원)?', value):
        return str(int(value.replace(',', '').replace('원', '').strip()))
    return None


def csv_rows(path):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def write_json(path, data):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def convert(input_dir, output_dir, hold_back=False):
    source = input_dir.resolve(strict=True)
    output = output_dir.resolve()
    repo = pathlib.Path(__file__).resolve().parent.parent
    if output == repo or repo in output.parents or output == source or source in output.parents or any((parent / '.git').exists() for parent in (output, *output.parents)):
        raise ValueError('Output must be outside the source dataset and the repository')
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'bundle.json').exists():
        raise FileExistsError('Private bundle already exists; choose a new output folder')
    raw = (source / '시안' / 'data.js').read_text(encoding='utf-8-sig')
    data = json.loads(raw[raw.index('{'):].strip().removesuffix(';'))
    ledger = {row['업무ID']: row for row in csv_rows(source / '03_업무원장.csv')}
    evidence_rows = csv_rows(source / '06_원문근거연결표.csv')
    evidence = defaultdict(list)
    for row in evidence_rows:
        evidence[row['자료ID']].append(row)
    issues = defaultdict(list)
    for issue in data['issues']:
        issues[issue['event_id']].append(issue)
    transactions = {row['event_id']: row for row in data['transactions']}
    all_ids = {row['id'] for row in data['events']}
    records = []
    for event in data['events']:
        row = ledger.get(event['id'], {})
        changes = issues[event['id']]
        transaction = transactions.get(event['id'])
        previous = [item for item in re.split(r'[;,|\s]+', row.get('연결된이전기록', '')) if item in all_ids and item != event['id']]
        change_text = []
        for change in changes:
            if change['kind'] in ('규격변경', '기존규격부재'):
                change_text.append('이전: ' + (optional(change.get('old_value')) or '미확인') + ' → 변경: ' + (optional(change.get('new_value')) or '미확인'))
        next_actions = list(dict.fromkeys(optional(item.get('next_action')) for item in changes if optional(item.get('next_action'))))
        source_ids = list(dict.fromkeys(event['source_ids'] + [sid for issue in changes for sid in issue.get('source_ids', [])]))
        assigned = bool(event.get('default_visible'))
        confirmed = bool(event.get('human_confirmed'))
        amount = money(event.get('amount'))
        if amount is None and transaction:
            amount = money(transaction.get('document_total'))
        record = {
            'id': event['id'], 'projectId': event['site_id'], 'projectName': event['site_label'],
            'occurredAt': date(event.get('event_date')), 'receivedAt': date(event.get('record_received_at')),
            'type': event['type'], 'party': optional(row.get('상대업체')), 'item': optional(event.get('item')),
            'quantity': optional(event.get('quantity')), 'amountMinor': amount,
            'request': optional(event.get('summary')) or optional(row.get('요청내용')) or '자료 접수',
            'change': '\n'.join(change_text) or optional(row.get('변경내용')),
            'status': optional(event.get('state')) or '기록',
            'attribution': 'assigned' if assigned else 'review',
            'confirmation': 'confirmed' if confirmed else 'pending' if next_actions else 'recorded',
            'nextAction': '\n'.join(next_actions) or None, 'previousIds': previous, 'sourceIds': source_ids,
            'updatedAt': date(event.get('confirmed_at')), 'origin': 'import', 'revision': 1,
            'transactionKey': transaction['id'] if transaction else None,
        }
        records.append(record)
    used = {sid for record in records for sid in record['sourceIds']}
    sources = []
    paths = {}
    originals = excerpts = 0
    for sid in sorted(used):
        info = data['source_index'].get(sid)
        if not info:
            raise ValueError('Source ID missing from registered dataset: ' + sid)
        links = evidence.get(sid, [])
        locator = '; '.join(dict.fromkeys(row['원문위치'] for row in links if row['원문위치']))[:1000] or None
        original = pathlib.Path(info.get('original_path') or '')
        suffix = original.suffix.lower()
        # A message source can point into a whole-phone container. Only serve its selected excerpt.
        raw_file = suffix in ('.pdf', '.xlsx', '.xls', '.hwpx', '.hwp', '.jpg', '.jpeg', '.png', '.heic', '.dwg', '.dxf') and original.is_file()
        expected_hash = info.get('sha256')
        if raw_file:
            digest = hashlib.sha256(original.read_bytes()).hexdigest()
            raw_file = not expected_hash or digest == expected_hash
        if raw_file:
            mime = {'.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}.get(suffix, 'application/octet-stream')
            paths[sid] = {'path': str(original.resolve()), 'sha256': digest, 'mime': mime, 'downloadName': original.name}
            label = info.get('file_name') or original.name
            originals += 1
        else:
            lines = ['자료 ID: ' + sid, '원문 위치: ' + (locator or '자료 등록부 참조'), '', '보관된 원문 근거 발췌']
            for row in links:
                quote = optional(row.get('근거발췌_내부전용'))
                if quote:
                    lines.extend(['', row.get('원문위치', ''), quote])
            if not any(optional(row.get('근거발췌_내부전용')) for row in links):
                lines.append('근거 연결표에 등록된 자료입니다. 제공된 발췌 본문은 없습니다.')
            excerpt = '\n'.join(lines)
            digest = hashlib.sha256(excerpt.encode()).hexdigest()
            paths[sid] = {'text': excerpt, 'sha256': digest, 'mime': 'text/plain;charset=utf-8', 'downloadName': sid + '_근거발췌.txt'}
            label = (info.get('file_name') or sid) + ' · 근거 발췌'
            excerpts += 1
        sources.append({'id': sid, 'kind': info.get('kind') or 'file', 'label': label[:500], 'locator': locator, 'sha256': digest, 'url': '/api/sources/' + sid, 'version': 1})
    projects = [{'id': site['id'], 'name': site['label']} for site in data['sites']]
    bundle = {'schemaVersion': 1, 'projects': projects, 'sources': sources, 'records': records}
    full_count = len(records)
    held = None
    if hold_back:
        primary = next((p['id'] for p in projects if '봉천' in p['name']), projects[0]['id'])
        choices = [record for record in records if record['projectId'] == primary and record['attribution'] == 'assigned']
        held = sorted(choices, key=lambda r: (r['occurredAt'] or '', r['id']))[-1]
        delta = {'schemaVersion': 1, 'projects': projects, 'sources': [item for item in sources if item['id'] in held['sourceIds']], 'records': [held]}
        write_json(output / '신규반영_실제기록.json', delta)
        bundle['records'] = [record for record in records if record['id'] != held['id']]
    write_json(output / 'bundle.json', bundle)
    write_json(output / 'source-paths.json', paths)
    receipt = {'schemaVersion': 1, 'recordCount': full_count, 'initialRecordCount': len(bundle['records']), 'assignedCount': sum(r['attribution'] == 'assigned' for r in records), 'reviewCount': sum(r['attribution'] == 'review' for r in records), 'sourceCount': len(sources), 'originalFiles': originals, 'selectedExcerpts': excerpts, 'heldBackRecordId': held['id'] if held else None, 'customerOriginalsModified': False}
    write_json(output / 'import-receipt.json', receipt)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--hold-back-one', action='store_true', help='Keep one actual primary-site record in a separate file to demonstrate incremental import.')
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(convert(args.input, args.output, args.hold_back_one), ensure_ascii=False))
