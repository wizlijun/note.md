#!/usr/bin/env python3
"""Compare viewer fixtures with an explicitly supplied Timeline generator.

Requires the generator's Python dependencies (PyYAML). No external source is
modified. Metadata comparison deliberately uses validate_event_metadata rather
than the generator's full document validator: historical viewer input need not
meet producer-only title, timestamp, source-label, or single-link requirements.
Synthetic source lines satisfy the generator's filesystem checks; this does not
prove original evidence exists or support semantic importance judgements.

Any contract mismatch or selection failure exits 1, including known upstream
scanner differences. --select-only independently checks stored-judgement
selection, without claiming automatic diary writing or factual verification.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile


REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / 'plugins-src/timeline/src/lib/fixtures/event-importance.json'


def metadata_comparison(generator, root, file):
    cases = json.loads(FIXTURES.read_text())
    results = []
    for case in cases:
        file.write_text(case['content'], encoding='utf-8')
        try:
            doc = generator.load(root, file)
            errors = generator.validate_event_metadata(root, file, doc)
            actual = not errors
        except Exception as exc:
            errors, actual = [str(exc)], False
        results.append(dict(name=case['name'], expected_valid=case['valid'],
                            generator_valid=actual, matched=actual == case['valid'],
                            errors=errors))
    return dict(total=len(results), matched=sum(item['matched'] for item in results),
                mismatches=[item for item in results if not item['matched']], cases=results)


def judgement(importance='high', anomaly='none', short=False):
    result = dict(importance=importance, reason='合成样例：按已保存判断选材。',
                  evidence=[] if importance == 'unknown' else [dict(source='s01', locator='L2')],
                  signals=dict(source_chars=2 if short else 20,
                               duration_minutes=None, owner_relation='direct'))
    if anomaly is not None:
        result['anomaly'] = dict(status=anomaly, reason='合成样例：独立保存反常判断。',
                                 evidence=[dict(source='s01', locator='L3')] if anomaly == 'flagged' else [])
    return result


def event(event_id, importance='high', anomaly='none', *, kind='沟通', short=False, child=False):
    return dict(id=event_id, metadata=judgement(importance, anomaly, short), kind=kind, child=child)


def selection_cases(generator, root, file):
    scenarios = [
        ('rich day keeps more than four independent events',
         [event(f'e{i}') for i in range(1, 8)],
         dict(selected=[f'e{i}' for i in range(1, 8)], pending_review=[], meeting_containers=[])),
        ('mostly ordinary day does not fill a quota',
         [event(f'e{i}', 'normal') for i in range(1, 7)] + [event('e7'), event('e8', 'unknown')],
         dict(selected=['e7'], pending_review=['e8'], meeting_containers=[])),
        ('short important life events survive size signals',
         [event('e1', kind='健康', short=True), event('e2', kind='探访', short=True),
          event('e3', kind='出行', short=True), event('e4', 'normal', kind='开发')],
         dict(selected=['e1', 'e2', 'e3'], pending_review=[], meeting_containers=[])),
        ('independent children anomalies unknowns and overlapping review',
         [event('e1', anomaly='flagged', kind='会议'),
          event('e2', 'normal', kind='议题', child=True),
          event('e3', 'unknown', kind='议题', child=True),
          event('e4', anomaly=None), event('e5', 'normal', 'flagged'),
          event('e6', 'unknown', 'flagged'), event('e7', 'normal')],
         dict(selected=['e4', 'e5', 'e6'], pending_review=['e3', 'e4', 'e6'], meeting_containers=['e1'])),
    ]
    results = []
    for name, events, expected in scenarios:
        meta = dict(type='Timeline', title='2026-10-21 Timeline', description='合成选材验收。',
                    tags=['test'], timezone='Asia/Taipei',
                    generated=dict(by='contract-check/1', at='2026-10-21T10:00:00+08:00'),
                    sources=[dict(id='s01', resource='/source.md', title='Source')],
                    event_metadata={item['id']: item['metadata'] for item in events})
        rows = []
        for index, item in enumerate(events):
            indent = '  ' if item['child'] else ''
            start = f'09:{index:02}:00'
            end = '09:30:00' if item['kind'] == '会议' else start
            label = 'L2' if item['child'] else 'Source'
            rows.append(f'{indent}- {start}–{end} — {item["kind"]}：合成事件 {item["id"]}。 '
                        f'[{label}](../source.md#L2) <!-- event:{item["id"]} -->')
        file.write_text('---\n' + generator.yaml.safe_dump(meta, allow_unicode=True, sort_keys=False) +
                        '---\n# 2026-10-21 Timeline\n\n' + '\n'.join(rows) + '\n', encoding='utf-8')
        result = generator.select_events(root, file, generator.load(root, file), include_anomalies=True)
        actual = {key: [item['event_id'] for item in result.get(key, [])] for key in expected}
        # Ordinary flagged evidence remains ordinary, despite inclusion for review.
        flagged_not_promoted = all(item['importance'] == meta['event_metadata'][item['event_id']]['importance']
                                   for item in result.get('selected', []))
        results.append(dict(name=name, passed=result.get('ok') is True and actual == expected and flagged_not_promoted,
                            expected=expected, actual=actual, errors=result.get('errors', [])))
    return dict(total=len(results), passed=sum(item['passed'] for item in results), cases=results)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generator-script', type=Path, required=True)
    parser.add_argument('--select-only', action='store_true')
    parser.add_argument('--output', type=Path, help='Optional JSON evidence report')
    args = parser.parse_args()
    script = args.generator_script.expanduser().resolve(strict=True)
    sys.dont_write_bytecode = True
    module_spec = importlib.util.spec_from_file_location('timeline_generator', script)
    generator = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(generator)
    with tempfile.TemporaryDirectory(prefix='timeline-contract-') as temp:
        root = Path(temp).resolve()
        (root / 'diary').mkdir()
        (root / 'source.md').write_text('# Source\n' + '合成证据行。\n' * 30, encoding='utf-8')
        file = root / 'diary/2026-10-21.timeline.md'
        report = dict(generator_script=str(script), generator_version=getattr(generator, 'VERSION', None),
                      generator_sha256=hashlib.sha256(script.read_bytes()).hexdigest(),
                      fixture_sha256=hashlib.sha256(FIXTURES.read_bytes()).hexdigest(),
                      scope='Synthetic saved-judgement contract and selection only; no original evidence or diary writing.')
        if not args.select_only:
            report['metadata'] = metadata_comparison(generator, root, file)
        report['selection'] = selection_cases(generator, root, file)
    report['ok'] = (report.get('metadata', {}).get('mismatches', []) == [] and
                    report['selection']['passed'] == report['selection']['total'])
    output = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding='utf-8')
    summary = {key: value for key, value in report.items() if key not in ('metadata', 'selection')}
    if 'metadata' in report:
        summary['metadata'] = {key: value for key, value in report['metadata'].items() if key != 'cases'}
    summary['selection'] = report['selection']
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
