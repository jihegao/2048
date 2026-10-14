import json
import pathlib
import sqlite3
import unittest


class TournamentMigrationTest(unittest.TestCase):
    def test_imports_existing_brackets_without_changing_original_records(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        db = sqlite3.connect(':memory:')
        for migration in sorted((root / 'migrations').glob('*.sql')):
            if migration.name < '0012_tournament_rooms.sql':
                db.executescript(migration.read_text())
        db.execute("INSERT INTO users (id,login_id,role,display_name,password_hash,password_salt,password_iterations,created_at,updated_at) VALUES ('teacher','teacher','teacher','Synthetic','unused','unused',1,1,1)")
        state = json.dumps({'title': 'Existing event', 'names': ['A'] * 8, 'winners': [[None] * 4, [None] * 2, [None]]})
        db.execute("INSERT INTO tournament_brackets (kind,state_json,revision,updated_by,updated_at) VALUES ('teams8',?,7,'teacher',123)", (state,))
        before = db.execute('SELECT * FROM tournament_brackets').fetchall()
        db.executescript((root / 'migrations/0012_tournament_rooms.sql').read_text())
        self.assertEqual(db.execute('SELECT * FROM tournament_brackets').fetchall(), before)
        self.assertEqual(db.execute('SELECT id,kind,state_json,revision,updated_at FROM tournament_events').fetchall(), [('legacy-teams8', 'teams8', state, 7, 123)])
        self.assertEqual(db.execute('SELECT COUNT(*) FROM tournament_rooms').fetchone()[0], 0)
        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
        db.close()


if __name__ == '__main__':
    unittest.main()
