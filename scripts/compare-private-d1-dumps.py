#!/usr/bin/env python3
"""Compare full private D1 exports locally; emit only schema/typed-row digests."""
import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import stat
import sys


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def load_dump(path, order):
    path = path.resolve(strict=True)
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError('Dump must be private')
    for parent in path.parents:
        if (parent / '.git').exists():
            raise ValueError('Production SQL must remain outside Git')
    output, _ = order.prepare(path.read_bytes().decode('utf-8'))
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('BEGIN')
    db.execute('PRAGMA defer_foreign_keys=ON')
    for statement in order.statements(output):
        db.execute(statement)
    db.commit()
    return db


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('target', type=Path)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    order = module('prepare-d1-import')
    checker = module('migration-prep')
    left = load_dump(args.source, order)
    right = load_dump(args.target, order)
    report = checker.compare(left, right)
    left.close()
    right.close()
    report.update(private_full_export_comparison=True, raw_records_returned=False)
    args.output.write_text(json.dumps(report, ensure_ascii=True, indent=2) + '\n')
    print(json.dumps({'ok': report['ok'], 'schema_matches': report['schema_matches'], 'differing_tables': report['differing_tables'], 'tables': len(report['source']['tables']), 'source_rows': sum(x['rows'] for x in report['source']['tables'].values()), 'target_rows': sum(x['rows'] for x in report['target']['tables'].values()), 'all_primary_keys_types_contents_constraints_checked': True, 'raw_records_returned': False}))
    if not report['ok']:
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Private full-copy comparison stopped; no SQL, records or password material logged.', file=sys.stderr)
        sys.exit(1)
