#!/usr/bin/env python3
"""Validate protocol snapshots/fixtures; no runtime integration or network writes.

Requires jsonschema >= 4. RRULE syntax is checked only minimally: this does not
validate full RFC 5545 semantics, expand recurrences, or authorize delivery.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from jsonschema import Draft7Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / 'protocol/schema/task-reminder-v1.schema.json'
FIXTURES = ROOT / 'protocol/fixtures/task-reminder-v1.json'
LIMITATION = 'RRULE checked for basic structure only; no full RFC 5545 validation or recurrence expansion.'


def instant(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def utc_second(value):
    return instant(value).astimezone(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def delivery_key(task, delivery):
    fields = ['note.task-reminder/1', task['id'], task['occurrence']['key'],
              delivery['generation'], delivery['reminder_id'],
              utc_second(delivery['trigger_at']), delivery['channel'], delivery['endpoint_id']]
    payload = json.dumps(fields, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(payload).hexdigest()


def semantic_errors(document):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    def temporal_walk(value, path='$'):
        if isinstance(value, dict):
            if value.get('kind') in ('date', 'date_time') and 'value' in value:
                zone = value.get('time_zone')
                if zone:
                    try:
                        tz = ZoneInfo(zone)
                    except (ZoneInfoNotFoundError, ValueError):
                        errors.append(f'{path}: unknown IANA time_zone')
                    else:
                        if value['kind'] == 'date_time':
                            original = instant(value['value'])
                            local = original.astimezone(tz)
                            require(original.utcoffset() == local.utcoffset()
                                    and original.replace(tzinfo=None) == local.replace(tzinfo=None),
                                    f'{path}: time_zone does not match wall time and UTC offset')
            for key, child in value.items():
                temporal_walk(child, f'{path}.{key}')
        elif isinstance(value, list):
            for index, child in enumerate(value):
                temporal_walk(child, f'{path}[{index}]')

    temporal_walk(document)
    task = document['task']
    occurrence = task['occurrence']
    state = task['state']
    if state['lane'] == 'closed':
        require(instant(state['closed_at']) <= instant(document['as_of']), 'closed_at exceeds as_of')
    recurrence = task.get('recurrence')
    if recurrence:
        original = occurrence.get('original_start')
        require(original is not None, 'recurring task requires occurrence.original_start')
        if original:
            key = ('date:' + original['value']) if original['kind'] == 'date' else ('instant:' + utc_second(original['value']))
            require(occurrence['key'] == key, 'occurrence.key must identify original_start, not rescheduled time')
        reference = recurrence['dtstart']
        values = recurrence.get('rdates', []) + recurrence.get('exdates', []) + ([original] if original else [])
        for value in values:
            require((value['kind'], value.get('time_zone')) == (reference['kind'], reference.get('time_zone')),
                    'recurrence dates must share dtstart kind and time_zone')
        parts = recurrence['rrule'].split(';')
        require(all(re.fullmatch(r'[A-Z]+=[^;\s:]+', part) for part in parts), 'RRULE must use unprefixed KEY=VALUE parts')
        frequencies = [part[5:] for part in parts if part.startswith('FREQ=')]
        require(len(frequencies) == 1 and frequencies[0] in
                ('SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'),
                'RRULE requires one supported FREQ')
    else:
        require(occurrence['key'] == 'single', 'non-recurring occurrence.key must be single')
        require('original_start' not in occurrence, 'non-recurring occurrence cannot have original_start')

    reminders = {item['id']: item for item in document['reminders']}
    deliveries = {item['id']: item for item in document['deliveries']}
    for collection, name in ((document['reminders'], 'reminder'), (document['deliveries'], 'delivery')):
        require(len({item['id'].lower() for item in collection}) == len(collection), f'duplicate {name} id')
    require(len({item['idempotency_key'] for item in document['deliveries']}) == len(document['deliveries']),
            'duplicate delivery idempotency_key; retry must reuse the original record')
    for reminder in document['reminders']:
        trigger = reminder['trigger']
        if reminder['enabled'] and trigger['kind'] == 'relative':
            anchor = task.get(trigger['anchor'])
            require(anchor is not None, 'relative trigger anchor is absent')
            if anchor:
                require(('local_time' in trigger) == (anchor['kind'] == 'date'),
                        'relative date anchors require local_time; date_time anchors forbid it')
                if anchor['kind'] == 'date' and 'local_time' in trigger:
                    try:
                        zone = ZoneInfo(anchor['time_zone'])
                    except (ZoneInfoNotFoundError, ValueError):
                        continue  # temporal_walk already reports this invalid zone.
                    local = dt.datetime.fromisoformat(anchor['value'] + 'T' + trigger['local_time'])
                    instants = set()
                    for fold in (0, 1):
                        candidate = local.replace(tzinfo=zone, fold=fold).astimezone(dt.timezone.utc)
                        if candidate.astimezone(zone).replace(tzinfo=None) == local:
                            instants.add(candidate)
                    require(len(instants) == 1, 'relative local_time is nonexistent or ambiguous; use an explicit offset')
    for delivery in document['deliveries']:
        reminder = reminders.get(delivery['reminder_id'])
        require(reminder is not None, 'delivery references unknown reminder_id')
        if reminder and delivery['task_revision'] == document['revision']:
            require(delivery['channel'] in reminder['channels'], 'delivery channel is not enabled for reminder')
        require(instant(delivery['expires_at']) > instant(delivery['trigger_at']), 'expires_at must follow trigger_at')
        require(delivery['generation'] <= occurrence['generation'], 'delivery generation exceeds current generation')
        require(delivery['idempotency_key'] == delivery_key(task, delivery), 'incorrect delivery idempotency_key')
        if delivery['state'] == 'acknowledged':
            require('acknowledged_at' in delivery, 'acknowledged delivery requires acknowledged_at')
        if 'snoozed_from' in delivery:
            previous = deliveries.get(delivery['snoozed_from'])
            require(previous is not None, 'snoozed_from references unknown delivery')
            if previous:
                require(previous['id'] != delivery['id'], 'snoozed_from cannot reference itself')
                require(previous['reminder_id'] == delivery['reminder_id'], 'snoozed_from must share reminder_id')
                require(all(previous[key] == delivery[key] for key in ('generation', 'channel', 'endpoint_id')),
                        'snoozed_from must share generation, channel and endpoint_id')
                require(instant(previous['trigger_at']) < instant(delivery['trigger_at']), 'snoozed delivery must trigger later')
    return errors


def validate(document, validator):
    errors = [f'{error.json_path}: {error.message}' for error in validator.iter_errors(document)]
    if errors:
        return errors
    try:
        return semantic_errors(document)
    except (ValueError, OverflowError) as error:
        return [f'Unrepresentable timestamp: {error}']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshots', nargs='*', type=Path, help='Snapshot JSON files; omit to run fixtures')
    args = parser.parse_args()
    schema = json.loads(SCHEMA.read_text())
    Draft7Validator.check_schema(schema)
    validator = Draft7Validator(schema, format_checker=FormatChecker())
    if args.snapshots:
        cases = [{'name': str(path), 'valid': True, 'document': json.loads(path.read_text())} for path in args.snapshots]
    else:
        cases = json.loads(FIXTURES.read_text())
    failed = 0
    for case in cases:
        errors = validate(case['document'], validator)
        if bool(errors) == case['valid']:
            failed += 1
            print(f"FAIL {case['name']}: {'; '.join(errors) or 'unexpectedly accepted'}")
    print(f'{len(cases) - failed}/{len(cases)} protocol cases passed. {LIMITATION}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
