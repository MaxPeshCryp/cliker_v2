import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from verified_users import apply_list, load_verified_emails


@contextmanager
def database_connection(path):
    db = sqlite3.connect(path)
    try:
        with db:
            yield db
    finally:
        db.close()


class VerifiedUsersTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / "production.db"
        self.list_path = self.root / "verified.txt"
        self.list_path.write_text("# Администратор\n KK@KK \nkk@kk\nmissing@example.com\n", encoding="utf-8-sig")
        with database_connection(self.database) as db:
            db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, nickname TEXT, balance INTEGER, password_hash TEXT)")
            db.execute("INSERT INTO users VALUES (1, 'kk@kk', 'kk', 123456, 'password-hash')")
            db.execute("INSERT INTO users VALUES (2, 'other@example.com', 'Other', 789, 'another-hash')")

    def test_grants_migrates_and_is_idempotent_without_touching_game_data(self):
        result = apply_list(self.database, self.list_path)
        self.assertEqual(result["granted"], ["kk@kk"])
        self.assertEqual(result["missing"], ["missing@example.com"])
        with database_connection(self.database) as db:
            self.assertEqual(db.execute("SELECT nickname, balance, password_hash, is_verified FROM users WHERE id = 1").fetchone(), ("kk", 123456, "password-hash", 1))
            self.assertEqual(db.execute("SELECT is_verified FROM users WHERE id = 2").fetchone()[0], 0)
        again = apply_list(self.database, self.list_path)
        self.assertEqual(again["granted"], [])
        self.assertEqual(again["already_verified"], ["kk@kk"])

    def test_new_entries_work_and_removing_an_entry_does_not_revoke(self):
        apply_list(self.database, self.list_path)
        self.list_path.write_text("OTHER@example.com\n", encoding="utf-8")
        self.assertEqual(apply_list(self.database, self.list_path)["granted"], ["other@example.com"])
        with database_connection(self.database) as db:
            self.assertEqual(db.execute("SELECT sum(is_verified) FROM users").fetchone()[0], 2)

    def test_bad_list_is_rejected_before_changing_database(self):
        self.list_path.write_text("kk@kk\ninvalid address\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            apply_list(self.database, self.list_path)
        with database_connection(self.database) as db:
            self.assertNotIn("is_verified", {row[1] for row in db.execute("PRAGMA table_info(users)")})

    def test_missing_database_and_list_do_not_create_files(self):
        missing = self.root / "typo.db"
        with self.assertRaises(sqlite3.OperationalError):
            apply_list(missing, self.list_path)
        self.assertFalse(missing.exists())
        with self.assertRaises(FileNotFoundError):
            load_verified_emails(self.root / "missing.txt")
