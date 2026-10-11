import importlib.util
from pathlib import Path
import sqlite3
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[2] / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


order = load('prepare-d1-import')
bounded = load('prepare-d1-long-statements')


class LosslessLongStatementTests(unittest.TestCase):
    def test_large_text_survives_each_statement_committing_separately(self):
        first = ("quote';, Unicode\u4e2d\U0001f600\n" * 9000)
        second = 'x' * 145000
        quote = lambda s: "'" + s.replace("'", "''") + "'"
        source = '''CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL);
CREATE TABLE child(id TEXT PRIMARY KEY,parent_id INTEGER REFERENCES parent(id),a TEXT,b TEXT,payload BLOB,n REAL);
INSERT INTO parent VALUES(4,'parent');
INSERT INTO child VALUES('child',4,''' + quote(first) + ',' + quote(second) + ''',X'003127',1.25);
CREATE INDEX child_idx ON child(parent_id);
CREATE TRIGGER child_keep AFTER UPDATE ON child BEGIN SELECT 1; END;
'''
        output, summary = bounded.verified_convert(source, order.statements)
        self.assertTrue(summary['full_typed_row_and_schema_equality'])
        self.assertEqual(summary['converted_inserts'], 1)
        self.assertEqual(summary['reassembled_text_literals'], 2)
        db = sqlite3.connect(':memory:')
        db.execute('PRAGMA foreign_keys=ON')
        for statement in order.statements(output):
            self.assertLess(len(statement.encode('utf-8')), 100000)
            db.execute(statement)
            db.commit()
        self.assertEqual(db.execute('SELECT a,b,typeof(a),typeof(b),payload,n FROM child').fetchone(), (first, second, 'text', 'text', bytes([0, 49, 39]), 1.25))
        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(db.execute('SELECT name FROM sqlite_master WHERE name=?', (bounded.SCRATCH,)).fetchall(), [])
        db.close()

    def test_unsupported_long_blob_schema_and_scratch_collision_fail_closed(self):
        cases = ['CREATE TABLE t(x TEXT DEFAULT \'' + 'x' * 100000 + "');",
                 "INSERT INTO t VALUES(X'" + 'AA' * 100000 + "');",
                 'CREATE TABLE "' + bounded.SCRATCH + '"(x TEXT);']
        for source in cases:
            with self.subTest(kind=source[:20]):
                with self.assertRaises(ValueError):
                    bounded.convert(source, order.statements)


if __name__ == '__main__':
    unittest.main()
