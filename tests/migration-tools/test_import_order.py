import importlib.util
from pathlib import Path
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location('import_order', Path(__file__).resolve().parents[2] / 'scripts/prepare-d1-import.py')
order = importlib.util.module_from_spec(spec)
spec.loader.exec_module(order)


class RemoteImportOrderingTests(unittest.TestCase):
    def test_parents_and_same_table_approvers_precede_children_across_commit_boundaries(self):
        original = '''PRAGMA defer_foreign_keys=TRUE;
        CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id));
        CREATE TABLE parents (id TEXT PRIMARY KEY, approved_by TEXT REFERENCES parents(id));
        INSERT INTO children VALUES ('child','student');
        INSERT INTO parents VALUES ('student','teacher');
        INSERT INTO parents VALUES ('teacher',NULL);
        CREATE INDEX children_parent ON children(parent_id);
        '''
        prepared, evidence = order.prepare(original)
        self.assertTrue(evidence['parent_rows_before_children'])
        self.assertEqual(sorted(order.statements(original)), sorted(order.statements(prepared)))
        target = sqlite3.connect(':memory:')
        target.execute('PRAGMA foreign_keys=ON')
        # Each statement commits separately, as a worst case for remote batches.
        for statement in order.statements(prepared):
            target.execute(statement)
            target.commit()
        self.assertEqual(target.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(target.execute('SELECT parent_id FROM children').fetchone(), ('student',))

    def test_cyclic_self_references_fail_closed_without_dropping_constraints_or_records(self):
        original = '''PRAGMA defer_foreign_keys=TRUE;
        CREATE TABLE users (id TEXT PRIMARY KEY, approver TEXT REFERENCES users(id));
        INSERT INTO users VALUES ('a','b');
        INSERT INTO users VALUES ('b','a');
        '''
        with self.assertRaisesRegex(ValueError, 'cycle'):
            order.prepare(original)


if __name__ == '__main__':
    unittest.main()
