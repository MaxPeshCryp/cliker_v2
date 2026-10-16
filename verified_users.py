"""Grant verification from an administrator-maintained email list."""
import argparse
import os
import re
import sqlite3
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_LIST = Path(os.environ.get("CLICKER_VERIFIED_USERS_FILE", BASE_DIR / "verified_users.txt"))


def load_verified_emails(path=DEFAULT_LIST):
    emails = set()
    for line_number, line in enumerate(Path(path).read_text(encoding="utf-8-sig").splitlines(), 1):
        email = line.strip().lower()
        if not email or email.startswith("#"):
            continue
        if not re.fullmatch(r"[^\s@]+@[^\s@]+", email):
            raise ValueError(f"{path}, строка {line_number}: укажите один email без пробелов")
        emails.add(email)
    return emails


def grant_verification(db, emails):
    """Only grant badges; preserve existing manual verifications and game data."""
    result = {"granted": [], "already_verified": [], "missing": []}
    has_override = "verification_override" in {row[1] for row in db.execute("PRAGMA table_info(users)")}
    eligible = " AND verification_override IS NULL" if has_override else ""
    for email in sorted(emails):
        rows = db.execute("SELECT is_verified FROM users WHERE lower(trim(email)) = ?", (email,)).fetchall()
        if not rows:
            result["missing"].append(email)
        elif all(row[0] == 1 for row in rows):
            result["already_verified"].append(email)
        else:
            changed = db.execute("UPDATE users SET is_verified = 1 WHERE lower(trim(email)) = ? AND is_verified IS NOT 1" + eligible, (email,)).rowcount
            if changed:
                result["granted"].append(email)
    return result


def apply_list(database, list_path=DEFAULT_LIST):
    emails = load_verified_emails(list_path)
    # Refuse to silently create an empty DB when a production path is mistyped.
    uri = Path(database).resolve().as_uri() + "?mode=rw"
    db = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
            if not {"id", "email"}.issubset(columns):
                raise ValueError("В выбранной базе нет таблицы пользователей кликера")
            if "is_verified" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0")
            return grant_verification(db, emails)
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="Выдать галочки пользователям из verified_users.txt")
    parser.add_argument("--database", type=Path, default=Path(os.environ.get("CLICKER_DATABASE_PATH", BASE_DIR / "clicker.db")), help="Путь к существующей базе (по умолчанию CLICKER_DATABASE_PATH или clicker.db)")
    parser.add_argument("--list", dest="list_path", type=Path, default=DEFAULT_LIST, help="Путь к списку email")
    args = parser.parse_args()
    try:
        result = apply_list(args.database, args.list_path)
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"Ошибка: {error}\n")
    print(f"База: {args.database.resolve()}")
    for key, label in (("granted", "Галочка выдана"), ("already_verified", "Уже проверены"), ("missing", "Ещё не зарегистрированы")):
        print(f"{label}: {len(result[key])}")
        for email in result[key]:
            print(f"  {email}")


if __name__ == "__main__":
    main()
