"""Configure admin credentials without placing plaintext secrets in files or argv."""
import argparse
import getpass
import os
import re
import tempfile
from pathlib import Path

from werkzeug.security import generate_password_hash


def write_credentials(path, login, password):
    if not login.strip() or len(login) > 128:
        raise ValueError("Логин должен содержать от 1 до 128 символов")
    if not 12 <= len(password) <= 256:
        raise ValueError("Пароль должен содержать от 12 до 256 символов")
    path = Path(path).resolve()
    content = path.read_text(encoding="utf-8-sig") if path.exists() else ""
    updates = {
        "CLICKER_ADMIN_LOGIN_HASH": generate_password_hash(login.strip()),
        "CLICKER_ADMIN_PASSWORD_HASH": generate_password_hash(password),
    }
    lines = [line for line in content.splitlines() if not re.match(
        r"\s*(?:export\s+)?CLICKER_ADMIN_(?:LOGIN|PASSWORD)_HASH\s*=", line)]
    lines.extend(f"{key}='{value}'" for key, value in updates.items())
    fd, temporary = tempfile.mkstemp(prefix=".admin-env-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write("\n".join(lines) + "\n")
        os.replace(temporary, path)
        if os.name != "nt":
            path.chmod(0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description="Записать хеши логина и пароля администратора в .env")
    parser.add_argument("--env", type=Path, default=Path(__file__).resolve().parent / ".env")
    args = parser.parse_args()
    try:
        login = getpass.getpass("Логин администратора (скрытый ввод): ")
        password = getpass.getpass("Пароль администратора (не менее 12 символов): ")
        if password != getpass.getpass("Повторите пароль: "):
            raise ValueError("Пароли не совпадают")
        write_credentials(args.env, login, password)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Ошибка: {error}\n")
    print(f"Хеши сохранены в {args.env.resolve()}. Перезапустите сервер.")


if __name__ == "__main__":
    main()
