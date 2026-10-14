#!/usr/bin/env python3
"""Create a lossless D1 import copy with bounded SQL statement bytes.

Original SQL remains untouched. Oversized INSERT text literals are reconstructed
from ordered scratch rows inside the destination before the business row is
inserted. Scratch storage is removed before original indexes/views/triggers.
No intermediate business-row updates or omitted values are permitted.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys

SCRATCH = '__2048_private_import_chunks'
LIMIT = 90000
CHUNK = 12000


def literals(sql):
    """Lex SQL quotes/comments; never interpret quoted identifiers as data."""
    i = 0
    while i < len(sql):
        if sql.startswith('--', i):
            n = sql.find('\n', i)
            i = len(sql) if n < 0 else n + 1
        elif sql.startswith('/*', i):
            n = sql.find('*/', i + 2)
            if n < 0:
                raise ValueError('Unclosed comment')
            i = n + 2
        elif sql[i] in "'\"`[":
            opener = sql[i]
            closer = ']' if opener == '[' else opener
            start = i
            i += 1
            value = []
            while i < len(sql):
                if sql[i] == closer:
                    if opener != '[' and i + 1 < len(sql) and sql[i + 1] == closer:
                        value.append(closer)
                        i += 2
                        continue
                    i += 1
                    break
                value.append(sql[i])
                i += 1
            else:
                raise ValueError('Unclosed quote')
            if opener == "'":
                blob = start > 0 and sql[start - 1] in 'xX' and (start < 2 or not (sql[start - 2].isalnum() or sql[start - 2] == '_'))
                yield start, i, ''.join(value), blob
        else:
            i += 1


def chunked(value):
    # Count escaped UTF-8 bytes, including doubled quotes; split codepoints only.
    current, size = [], 0
    for c in value:
        width = len(c.encode('utf-8')) * (2 if c == "'" else 1)
        if size + width > CHUNK and current:
            yield ''.join(current)
            current, size = [], 0
        current.append(c)
        size += width
    if current:
        yield ''.join(current)


def rewrite(statement, number):
    if len(statement.encode('utf-8')) <= LIMIT:
        return [statement], 0
    if not statement.upper().startswith('INSERT INTO '):
        raise ValueError('Oversized non-INSERT cannot be converted safely')
    candidates = [(a, b, v) for a, b, v, blob in literals(statement) if not blob and b - a > 4096]
    if not candidates:
        raise ValueError('Oversized INSERT has no supported text literal')
    before, pieces, cursor = [], [], 0
    for index, (start, end, value) in enumerate(candidates):
        tag = '{}:{}'.format(number, index)
        for seq, chunk in enumerate(chunked(value)):
            before.append("INSERT INTO \"{}\" VALUES('{}',{},'{}');".format(SCRATCH, tag, seq, chunk.replace("'", "''")))
        pieces.append(statement[cursor:start])
        pieces.append("(SELECT group_concat(payload,'') FROM (SELECT payload FROM \"{}\" WHERE tag='{}' ORDER BY seq))".format(SCRATCH, tag))
        cursor = end
    pieces.append(statement[cursor:])
    converted = ''.join(pieces)
    output = before + [converted, 'DELETE FROM "{}";'.format(SCRATCH)]
    if any(len(s.encode('utf-8')) > LIMIT for s in output):
        raise ValueError('Converted statement still exceeds byte limit')
    return output, len(candidates)


def convert(text, statement_parser):
    original = list(statement_parser(text))
    if SCRATCH in text:
        raise ValueError('Scratch name collides with original schema or data')
    output, changed, fields = [], 0, 0
    created = False
    for number, statement in enumerate(original):
        if len(statement.encode('utf-8')) > LIMIT:
            if not created:
                output.append('CREATE TABLE "{}" (tag TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(tag,seq));'.format(SCRATCH))
                created = True
            converted, count = rewrite(statement, number)
            output.extend(converted)
            changed += 1
            fields += count
        else:
            if created and statement.upper().startswith(('CREATE INDEX ', 'CREATE UNIQUE INDEX ', 'CREATE VIEW ', 'CREATE TRIGGER ')):
                output.append('DROP TABLE "{}";'.format(SCRATCH))
                created = False
            output.append(statement)
    if created:
        output.append('DROP TABLE "{}";'.format(SCRATCH))
    if any(len(s.encode('utf-8')) > LIMIT for s in output):
        raise ValueError('Statement byte bound failed')
    return '\n'.join(output) + '\n', {'converted_inserts': changed, 'reassembled_text_literals': fields, 'output_statements': len(output), 'max_statement_bytes': max(len(s.encode('utf-8')) for s in output)}


def digest(db):
    """Compare final schema, typed full rows, explicit PKs and implicit rowids."""
    schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    h = hashlib.sha256(repr(schema).encode('utf-8'))
    names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    rows = 0
    for name in names:
        quoted = '"' + name.replace('"', '""') + '"'
        h.update(name.encode('utf-8'))
        for row in db.execute('SELECT rowid,* FROM {} ORDER BY rowid'.format(quoted)):
            h.update(repr(row).encode('utf-8'))
            rows += 1
    if db.execute('PRAGMA foreign_key_check').fetchall() or db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise ValueError('Final integrity failed')
    return h.hexdigest(), rows


def verified_convert(text, parser):
    output, summary = convert(text, parser)
    digests = []
    for candidate in (text, output):
        db = sqlite3.connect(':memory:')
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN')
        db.execute('PRAGMA defer_foreign_keys=ON')
        for statement in parser(candidate):
            db.execute(statement)
        db.commit()
        digests.append(digest(db))
        db.close()
    if digests[0] != digests[1]:
        raise ValueError('Final schema/types/rows/rowids differ; original retained')
    summary.update(full_typed_row_and_schema_equality=True, foreign_key_and_integrity_checks=True, rows=digests[0][1], input_sha256=hashlib.sha256(text.encode()).hexdigest(), output_sha256=hashlib.sha256(output.encode()).hexdigest())
    return output, summary


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('destination', type=Path)
    args = p.parse_args()
    if args.destination.exists() or args.source.resolve() == args.destination.resolve():
        raise ValueError('Original must be retained; destination must be new')
    spec = importlib.util.spec_from_file_location('order', Path(__file__).with_name('prepare-d1-import.py'))
    order = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(order)
    output, summary = verified_convert(args.source.read_bytes().decode('utf-8'), order.statements)
    fd = os.open(str(args.destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(output.encode('utf-8'))
    print(json.dumps(summary))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Lossless conversion stopped; original retained. No SQL or values logged.', file=sys.stderr)
        sys.exit(1)
