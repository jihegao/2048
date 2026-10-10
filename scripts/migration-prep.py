#!/usr/bin/env python3
"""Offline synthetic migration rehearsal; never contacts Cloudflare or exports production."""

import argparse
import base64
import hashlib
import json
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                                     sort_keys=True).encode()).hexdigest()


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def cell(value):
    if value is None:
        return ["null"]
    if isinstance(value, bytes):
        return ["blob", value.hex()]
    if isinstance(value, int):
        return ["integer", str(value)]
    if isinstance(value, float):
        return ["real", value.hex()]
    return ["text", value]


def snapshot(db):
    schema = [r for r in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
              if not r[2].startswith("_cf_")]
    tables = {}
    for (name,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        if name.startswith("_cf_"):
            continue
        info = db.execute(f"PRAGMA table_info({quote(name)})").fetchall()
        keys = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5]]
        rows = [[cell(v) for v in row] for row in db.execute(f"SELECT * FROM {quote(name)}")]
        encoded = sorted(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
        key_positions = [next(i for i, c in enumerate(info) if c[1] == k) for k in keys]
        key_rows = sorted(json.dumps([r[i] for i in key_positions], ensure_ascii=False,
                                    separators=(",", ":")) for r in rows)
        tables[name] = {"rows": len(rows), "columns": [r[1] for r in info], "primary_key": keys,
                        "content_sha256": digest(encoded), "primary_keys_sha256": digest(key_rows)}
    return {"schema_sha256": digest(schema), "schema_objects": len(schema), "tables": tables,
            "foreign_key_violations": len(db.execute("PRAGMA foreign_key_check").fetchall()),
            "integrity_ok": db.execute("PRAGMA integrity_check").fetchall() == [("ok",)]}


def compare(source, target):
    left, right = snapshot(source), snapshot(target)
    differing = sorted(t for t in left["tables"].keys() | right["tables"].keys()
                       if left["tables"].get(t) != right["tables"].get(t))
    return {"ok": not differing and left["schema_sha256"] == right["schema_sha256"]
            and left["foreign_key_violations"] == right["foreign_key_violations"] == 0
            and left["integrity_ok"] and right["integrity_ok"],
            "differing_tables": differing, "schema_matches": left["schema_sha256"] == right["schema_sha256"],
            "source": left, "target": right}


def insert(db, table, **values):
    db.execute(f"INSERT INTO {quote(table)} ({','.join(quote(k) for k in values)}) VALUES ({','.join('?' for _ in values)})",
               list(values.values()))


def synthetic_hash(password, salt, pepper):
    return base64.urlsafe_b64encode(hashlib.pbkdf2_hmac("sha256", (password + "\0" + pepper).encode(),
                                                     salt, 100000, 32)).decode().rstrip("=")


def seed(db, migrations):
    # These fixtures contain only invented identities and credentials.
    db.execute("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)")
    salt = bytes(range(16))
    password_hash = synthetic_hash("synthetic-password", salt, "synthetic-pepper")
    for index, path in enumerate(migrations):
        db.executescript(path.read_text())
        insert(db, "d1_migrations", name=path.name, applied_at="2026-10-10T00:00:00Z")
        if index == 4:
            insert(db, "users", id="teacher", login_id="synthetic-teacher", role="teacher", student_no=None,
                   display_name="合成教师", class_name=None, locale="zh-CN", password_hash=password_hash,
                   password_salt=base64.urlsafe_b64encode(salt).decode().rstrip("="), password_iterations=100000,
                   credential_version=3, created_at=1, updated_at=2)
            for i in range(1, 8):
                insert(db, "users", id=f"student-{i}", login_id=f"SYNTHETIC-{i}", role="student",
                       student_no=f"SYNTHETIC-{i}", display_name=f"合成学生{i}", class_name="合成班",
                       locale="en", grade_level=6, password_hash=password_hash,
                       password_salt=base64.urlsafe_b64encode(salt).decode().rstrip("="), password_iterations=100000,
                       credential_version=2, created_at=1, updated_at=2)
            # Insert before the grade snapshot migration to exercise historical rows.
            insert(db, "practice_results", id="legacy-practice", challenge_id="legacy-challenge", user_id="student-1",
                   engine_version="synthetic", score=64, max_tile=16, valid_move_count=9,
                   final_board_json="[[2,4],[8,16]]", started_at=1, ended_at=2)
    insert(db, "sessions", token_hash="synthetic-session-hash", user_id="student-1", created_at=1,
           expires_at=999999, last_seen_at=2, credential_version=2)
    for team, start in [("A", 1), ("B", 4)]:
        insert(db, "teams", id=team, code=f"SYNTHETIC-{team}", name=f"合成队{team}", logo="synthetic-logo",
               creator_id=f"student-{start}", created_at=1, updated_at=2)
        for i in range(start, start + 3):
            insert(db, "team_members", team_id=team, user_id=f"student-{i}", joined_at=1)
    insert(db, "leaderboard_periods", id="leaderboard", name="合成周期", start_at=1, end_at=1000000,
           created_by="teacher", created_at=1, updated_at=2)
    for period, status in [("closed-period", "frozen"), ("open-period", "open")]:
        insert(db, "team_practice_periods", id=period, name=f"合成{period}", status=status,
               created_by="teacher", created_at=1, closed_at=2 if status == "frozen" else None,
               frozen_at=3 if status == "frozen" else None)
    insert(db, "rooms", id="ended-room", code="SYNTHETIC-END", name="合成已结束比赛", mode="team_3v3",
           status="ended", created_by="teacher", created_at=1, updated_at=3, starts_at=2, ends_at=3,
           finished_at=3, settled_at=3, finish_reason="time_limit", winner_side="A",
           team_practice_period_id="closed-period", team_group="6-12")
    insert(db, "rooms", id="waiting-room", code="SYNTHETIC-WAIT", name="合成待开始房间", mode="team_3v3",
           status="open", created_by="student-1", created_at=1, updated_at=2, student_created=1,
           creator_team_id="A", team_practice_period_id="open-period", team_group="6-12", self_room_expires_at=999999)
    for team, start in [("A", 1), ("B", 4)]:
        insert(db, "room_entries", room_id="ended-room", side=team, team_id=team,
               joined_by=f"student-{start}", joined_at=1)
        for i in range(start, start + 3):
            insert(db, "match_players", room_id="ended-room", user_id=f"student-{i}", team_id=team, side=team,
                   score=i * 4, max_tile=16, max_tile_reached_at=2, valid_move_count=5, game_over=0,
                   final_board_json="[[2,4],[8,16]]", outcome="win" if team == "A" else "loss", team_total_score=100)
        insert(db, "team_match_results", room_id="ended-room", team_practice_period_id="closed-period",
               team_id=team, side=team, outcome="win" if team == "A" else "loss", points=3 if team == "A" else 0,
               team_score=100, team_name_snapshot=f"合成队{team}", roster_snapshot_json=json.dumps([f"student-{i}" for i in range(start,start+3)]),
               started_at=2, settled_at=3)
        insert(db, "team_period_standings", team_practice_period_id="closed-period", team_id=team,
               team_name_snapshot=f"合成队{team}", wins=1 if team == "A" else 0, draws=0, losses=0 if team == "A" else 1,
               points=3 if team == "A" else 0, matches=1, frozen_at=3)
    insert(db, "room_entries", room_id="waiting-room", side="A", team_id="A", joined_by="student-1", joined_at=1)
    for i in range(1,4):
        insert(db, "active_participations", user_id=f"student-{i}", room_id="waiting-room", side="A")
    insert(db, "practice_results", id="new-practice", challenge_id="new-challenge", user_id="student-2",
           engine_version="synthetic", score=128, max_tile=32, valid_move_count=18,
           final_board_json="[[2,4],[16,32]]", started_at=3, ended_at=4,
           grade_at_completion="6", grade_source="completion")
    insert(db, "timed_practice_sessions", id="timed-session", user_id="student-3", engine_version="synthetic",
           seed=42, started_at=1, deadline_at=180001, seq=1, moves_json='["left"]', snapshot_json='{"score":4}',
           status="settled", settled_at=180001)
    insert(db, "timed_practice_results", id="timed-result", session_id="timed-session", user_id="student-3",
           mode="timed_3m", duration_seconds=180, engine_version="synthetic", score=4, max_tile=4,
           valid_move_count=1, final_board_json="[[2,4],[0,0]]", grade_at_completion="6", started_at=1,
           deadline_at=180001, ended_at=180001, end_reason="time_limit", settled_at=180001)
    insert(db, "import_jobs", id="import-job", type="users", checksum="synthetic-checksum", row_count=7,
           inserted_count=7, updated_count=0, created_by="teacher", committed_at=1)
    db.commit()


def ordered_dump(source):
    # Synthetic SQLite rehearsal only. This is not a production D1 dump converter.
    statements = list(source.iterdump())
    schema, data, remaining = [], [], []
    for sql in statements:
        if sql in ("BEGIN TRANSACTION;", "COMMIT;"):
            continue
        if sql.startswith("CREATE TABLE"):
            schema.append(sql)
        elif sql.startswith(("INSERT INTO", "DELETE FROM")):
            data.append(sql)
        else:
            remaining.append(sql)
    return "PRAGMA defer_foreign_keys=ON;\n" + "\n".join(schema + data + remaining)


def restore(source, target):
    sql = ordered_dump(source)
    target.executescript("BEGIN;\n" + sql + "\nCOMMIT;")
    return hashlib.sha256(sql.encode()).hexdigest()


def rehearse(root, fixture_output=None):
    paths = sorted((root / "migrations").glob("*.sql"))
    if len(paths) != 10:
        raise RuntimeError("Expected the reviewed ten-migration baseline; re-review changed schema")
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="2048-synthetic-rehearsal-") as directory:
        source = sqlite3.connect(str(Path(directory) / "source.sqlite"))
        target = sqlite3.connect(str(Path(directory) / "target.sqlite"))
        source.execute("PRAGMA foreign_keys=ON")
        target.execute("PRAGMA foreign_keys=ON")
        seed(source, paths)
        if fixture_output:
            fixture_output.parent.mkdir(parents=True, exist_ok=True)
            fixture_output.write_text(ordered_dump(source) + "\n")
        import_started = time.perf_counter()
        sql_digest = restore(source, target)
        import_seconds = time.perf_counter() - import_started
        checked = compare(source, target)
        assert checked["ok"], "Synthetic roundtrip changed schema or records"
        assert target.execute("SELECT grade_source FROM practice_results WHERE id='legacy-practice'").fetchone() == ("legacy_unranked",)
        row = target.execute("SELECT password_salt,password_hash FROM users WHERE id='student-1'").fetchone()
        salt = base64.urlsafe_b64decode(row[0] + "=" * (-len(row[0]) % 4))
        assert synthetic_hash("synthetic-password", salt, "synthetic-pepper") == row[1]
        assert synthetic_hash("synthetic-password", salt, "wrong-synthetic-pepper") != row[1]
        try:
            target.execute("INSERT INTO team_members VALUES ('B','student-7',1)")
        except sqlite3.IntegrityError:
            target.rollback()
        else:
            raise AssertionError("Team constraints were not restored")
        target.execute("UPDATE match_players SET score=score+4 WHERE user_id='student-1'")
        assert compare(source, target)["differing_tables"] == ["match_players"]
        target.rollback()
        target.execute("DROP TRIGGER team_member_limit_before_insert")
        assert not compare(source, target)["schema_matches"]
        source.close()
        target.close()
    return {"scope": "synthetic SQLite only; no production data or network access",
            "checked_at_utc": datetime.now(timezone.utc).isoformat(), "ok": True,
            "production_migration_ready": False,
            "migration_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
            "synthetic_dump_sha256": sql_digest, "synthetic_import_seconds": round(import_seconds,6),
            "total_seconds": round(time.perf_counter() - started,6), "verification": checked,
            "negative_checks": ["wrong pepper rejected", "restored team constraint rejects invalid member",
                                "same-count score corruption detected", "missing trigger detected"],
            "limits": ["Not the D1 export/import route", "No DO state, alarms or WebSocket freeze proof",
                       "No production secret verification", "Synthetic timing is not production downtime estimate"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--fixture-output", type=Path, help="Write invented data for local D1 CLI testing")
    args = parser.parse_args()
    report = rehearse(args.source_root.resolve(), args.fixture_output)
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
    print(json.dumps({"synthetic_rehearsal_ok": report["ok"], "tables": len(report["verification"]["source"]["tables"]),
                      "import_seconds": report["synthetic_import_seconds"], "production_migration_ready": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
