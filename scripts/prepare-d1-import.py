#!/usr/bin/env python3
"""Preserve dump SQL while ordering table definitions before data and triggers after it."""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from pathlib import Path


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def parent_first_data(tables, data):
    # The remote importer may commit multiple batches. Deferral alone therefore
    # cannot protect a child whose parent appears only in a later batch.
    shadow = sqlite3.connect(':memory:')
    shadow.execute('PRAGMA foreign_keys=ON')
    shadow.execute('BEGIN')
    shadow.execute('PRAGMA defer_foreign_keys=ON')
    for statement in tables:
        shadow.execute(statement)
    names = [r[0] for r in shadow.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    foreign = {name: shadow.execute(f'PRAGMA foreign_key_list({quote(name)})').fetchall() for name in names}
    parents = {name: {r[2] for r in foreign[name] if r[2] != name} for name in names}
    self_tables = {name for name in names if any(r[2] == name for r in foreign[name])}
    shadow.execute('CREATE TEMP TABLE migration_insert_capture (statement_number INTEGER, table_name TEXT, inserted_rowid INTEGER)')
    current = [0]
    shadow.create_function('migration_statement_number', 0, lambda: current[0])
    for n, name in enumerate(sorted(self_tables)):
        literal = "'" + name.replace("'", "''") + "'"
        shadow.execute(f'''CREATE TEMP TRIGGER migration_capture_{n} AFTER INSERT ON main.{quote(name)}
          BEGIN INSERT INTO migration_insert_capture VALUES(migration_statement_number(), {literal}, NEW.rowid); END''')
    grouped = {name: [] for name in names}
    sequences = []
    pattern = r'^INSERT\s+INTO\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)\s'
    for index, statement in enumerate(data):
        current[0] = index
        if statement.upper().startswith('DELETE '):
            sequences.append(index)
        else:
            match = re.match(pattern, statement, flags=re.IGNORECASE)
            if not match:
                raise ValueError('Cannot resolve an original INSERT target')
            name = match[1]
            if name.startswith('"'):
                name = name[1:-1].replace('""', '"')
            if name == 'sqlite_sequence':
                sequences.append(index)
            elif name in grouped:
                grouped[name].append(index)
            else:
                raise ValueError('Unexpected data table')
        shadow.execute(statement)
    if shadow.execute('PRAGMA foreign_key_check').fetchall():
        raise ValueError('Original export has foreign key violations')
    shadow.commit()
    dependencies = {index: set() for index in range(len(data))}
    for name in self_tables:
        columns = [r[1] for r in shadow.execute(f'PRAGMA table_info({quote(name)})')]
        primary = [r[1] for r in sorted(shadow.execute(f'PRAGMA table_info({quote(name)})'), key=lambda r: r[5]) if r[5]]
        capture = dict(shadow.execute('SELECT inserted_rowid, statement_number FROM migration_insert_capture WHERE table_name=?', (name,)))
        rows = [(r[0], dict(zip(columns, r[1:]))) for r in shadow.execute(f'SELECT rowid,* FROM {quote(name)}')]
        groups = {}
        for row in foreign[name]:
            if row[2] == name:
                groups.setdefault(row[0], []).append(row)
        for entries in groups.values():
            entries.sort(key=lambda r: r[1])
            child_columns = [r[3] for r in entries]
            parent_columns = [r[4] for r in entries]
            if any(c is None for c in parent_columns):
                parent_columns = primary
            if len(child_columns) != len(parent_columns):
                raise ValueError('Unresolved self-reference')
            owners = {tuple(values[c] for c in parent_columns): capture[rowid] for rowid, values in rows}
            for rowid, values in rows:
                key = tuple(values[c] for c in child_columns)
                if any(v is None for v in key):
                    continue
                owner = owners.get(key)
                if owner is None:
                    raise ValueError('Unresolved self-reference parent')
                if owner != capture[rowid]:
                    dependencies[capture[rowid]].add(owner)
    def ordered(nodes, edges):
        remaining = set(nodes)
        output = []
        while remaining:
            ready = sorted(n for n in remaining if not (edges.get(n, set()) & remaining))
            if not ready:
                raise ValueError('Foreign key cycle requires a separately verified import path')
            output.extend(ready)
            remaining.difference_update(ready)
        return output
    ordered_tables = ordered(names, parents)
    indexes = []
    for name in ordered_tables:
        indexes.extend(ordered(grouped[name], dependencies))
    indexes.extend(sequences)
    if sorted(indexes) != list(range(len(data))):
        raise ValueError('Data statement ordering lost an original statement')
    shadow.close()
    return [data[i] for i in indexes]


def statements(text):
    current = []
    for char in text:
        current.append(char)
        if char == ";" and sqlite3.complete_statement("".join(current)):
            yield "".join(current).strip()
            current = []
    if "".join(current).strip():
        raise ValueError("Incomplete or unsupported trailing SQL; do not import")


def prepare(text):
    tables, data, definitions, pragmas = [], [], [], []
    for statement in statements(text):
        kind = statement.upper()
        if re.fullmatch(r"PRAGMA\s+DEFER_FOREIGN_KEYS\s*=\s*(?:ON|TRUE|1)\s*;", kind):
            pragmas.append(statement)
        elif kind.startswith("CREATE TABLE "):
            tables.append(statement)
        elif kind.startswith("INSERT INTO ") or re.fullmatch(r'DELETE\s+FROM\s+"?SQLITE_SEQUENCE"?\s*;', kind):
            data.append(statement)
        elif kind.startswith(("CREATE INDEX ", "CREATE UNIQUE INDEX ", "CREATE VIEW ", "CREATE TRIGGER ")):
            definitions.append(statement)
        else:
            raise ValueError("Unsupported SQL statement; re-review the export before importing")
    if not tables or not data:
        raise ValueError("Expected a full schema and data dump")
    # Keep exact original statements; parent rows precede children, including
    # users approving another user's grade through a same-table foreign key.
    data = parent_first_data(tables, data)
    output = "\n".join(pragmas + tables + data + definitions) + "\n"
    original_statements = list(statements(text))
    reordered_statements = list(statements(output))
    if sorted(original_statements) != sorted(reordered_statements):
        raise ValueError("SQL statement preservation check failed")
    return output, {"statements": len(original_statements), "table_definitions": len(tables),
                    "data_statements": len(data), "index_view_trigger_definitions": len(definitions),
                    "original_statements_preserved": True,
                    "parent_rows_before_children": True,
                    "input_sha256": hashlib.sha256(text.encode()).hexdigest(),
                    "output_sha256": hashlib.sha256(output.encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.destination.resolve() or args.destination.exists():
        raise ValueError("Keep the original dump and use a new destination")
    output, summary = prepare(args.source.read_bytes().decode('utf-8'))
    # Preserve restrictive dump permissions; do not leave an extra public copy.
    fd = os.open(args.destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(output.encode('utf-8'))
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('D1 import preparation stopped; original export preserved. No SQL or row values logged.', file=sys.stderr)
        sys.exit(1)
