#!/usr/bin/env python3
"""Offline rollback rehearsal with invented data; never switches a live service."""
import argparse
import importlib.util
import json
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def rehearse(root):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("migration_fixture", Path(__file__).with_name("migration-prep.py"))
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    paths = sorted((root / "migrations").glob("*.sql"))
    if len(paths) != 10:
        raise RuntimeError("Re-review a changed migration baseline")
    with tempfile.TemporaryDirectory(prefix="2048-synthetic-rollback-") as directory:
        databases = []
        for name in ("old", "new", "spare"):
            db = sqlite3.connect(str(Path(directory) / f"{name}.sqlite"))
            db.execute("PRAGMA foreign_keys=ON")
            databases.append(db)
        old, new, spare = databases
        fixture.seed(old, paths)
        original_old = fixture.snapshot(old)
        fixture.restore(old, new)
        before = fixture.compare(old, new)
        assert before["ok"], "Rollback before new writes must preserve every table"

        # Even an unchanged row count can contain a new business write.
        new.execute("UPDATE match_players SET score=score+4 WHERE user_id='student-1'")
        assert fixture.compare(old, new)["differing_tables"] == ["match_players"]
        new.rollback()

        user = dict(zip([r[1] for r in old.execute("PRAGMA table_info(users)")], old.execute("SELECT * FROM users WHERE id='student-7'").fetchone()))
        user.update(id="student-8", login_id="SYNTHETIC-8", student_no="SYNTHETIC-8", display_name="切换后合成学生", created_at=10, updated_at=10)
        fixture.insert(new, "users", **user)
        fixture.insert(new, "practice_results", id="post-switch-result", challenge_id="post-switch-challenge", user_id="student-8", engine_version="synthetic", score=512, max_tile=64, valid_move_count=36, final_board_json="[[2,4],[32,64]]", started_at=10, ended_at=11, grade_at_completion="6", grade_source="completion")
        new.commit()
        after = fixture.compare(old, new)
        assert not after["ok"] and after["differing_tables"] == ["practice_results", "users"]
        assert fixture.snapshot(old) == original_old, "OLD must remain intact"

        # Both writers are assumed frozen for this offline exercise. Preserve
        # the complete NEW database in an isolated spare; never overwrite OLD.
        reverse_digest = fixture.restore(new, spare)
        reconciled = fixture.compare(new, spare)
        assert reconciled["ok"]
        assert spare.execute("SELECT user_id,score FROM practice_results WHERE id='post-switch-result'").fetchone() == ("student-8", 512)
        assert fixture.snapshot(old) == original_old

        # Simultaneous OLD changes invalidate the single-writer assumption.
        old.execute("UPDATE users SET display_name='合成并发修改' WHERE id='student-1'")
        assert fixture.snapshot(old) != original_old
        old.rollback()
        assert fixture.snapshot(old) == original_old
        for db in databases:
            db.close()

    return {"scope": "Offline SQLite synthetic fixtures only; no network or production data", "checked_at_utc": datetime.now(timezone.utc).isoformat(), "ok": True, "before_first_new_write": {"full_copy_matches": before["ok"], "old_restoration_eligible_in_simulation": True}, "after_first_new_write": {"direct_return_to_stale_old_blocked": not after["ok"], "differing_tables": after["differing_tables"], "full_new_copy_to_isolated_spare_matches": reconciled["ok"], "reverse_copy_sha256": reverse_digest, "new_user_and_score_preserved": True, "original_old_untouched": True}, "negative_checks": ["same-count score change blocks direct return", "new user and score block direct return to stale OLD", "simultaneous OLD changes invalidate source baseline"], "production_migration_ready": False, "limits": ["No real rollback, route change or database overwrite was performed", "Both accounts' write quiescence remains a prerequisite, unverified on production", "No live Durable Object/version restore was exercised", "Synthetic reverse SQL copy is not proof of a remote D1 reverse migration"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = rehearse(args.source_root.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"synthetic_rollback_rehearsal_ok": report["ok"], "stale_old_return_blocked_after_new_writes": report["after_first_new_write"]["direct_return_to_stale_old_blocked"], "production_migration_ready": False}))


if __name__ == "__main__":
    main()
