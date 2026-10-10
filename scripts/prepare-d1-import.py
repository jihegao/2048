#!/usr/bin/env python3
"""Preserve dump SQL while ordering table definitions before data and triggers after it."""

import argparse
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path


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
    # Exact original statements are kept. No constraint or history is removed.
    output = "\n".join(pragmas + tables + data + definitions) + "\n"
    original_statements = list(statements(text))
    reordered_statements = list(statements(output))
    if sorted(original_statements) != sorted(reordered_statements):
        raise ValueError("SQL statement preservation check failed")
    return output, {"statements": len(original_statements), "table_definitions": len(tables),
                    "data_statements": len(data), "index_view_trigger_definitions": len(definitions),
                    "original_statements_preserved": True,
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
    main()
