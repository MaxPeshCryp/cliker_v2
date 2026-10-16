"""Separate administrator authentication and transactional player management."""
import hashlib
import json
import secrets
import time
from functools import wraps
from urllib.parse import urlsplit

from flask import abort, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash

import timed_games
from amounts import MAX_AMOUNT, db_amount
from badges import BADGES, BADGE_IDS, player_badges

SESSION_SECONDS = 3600
LOGIN_WINDOW = 300
LOGIN_ATTEMPTS = 8


def init_db(db):
    db.execute("""CREATE TABLE IF NOT EXISTS user_badges (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        badge_id TEXT NOT NULL,
        PRIMARY KEY (user_id, badge_id)
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS admin_login_limits (
        key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        action TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL
    )""")


def register_routes(app, base_dir, db_connection, ensure_user_rows):
    def credentials():
        return (app.config.get("CLICKER_ADMIN_LOGIN_HASH", ""),
                app.config.get("CLICKER_ADMIN_PASSWORD_HASH", ""))

    def credential_version():
        return hashlib.sha256("\0".join(credentials()).encode()).hexdigest()

    def authenticated():
        value = session.get("admin_auth")
        return bool(all(credentials()) and isinstance(value, dict)
                    and value.get("version") == credential_version()
                    and value.get("expires", 0) > int(time.time()))

    def csrf_token():
        if "admin_csrf" not in session:
            session["admin_csrf"] = secrets.token_urlsafe(32)
        return session["admin_csrf"]

    def check_csrf():
        expected = session.get("admin_csrf", "")
        supplied = request.headers.get("X-CSRF-Token", "")
        origin = request.headers.get("Origin")
        try:
            same_origin = not origin or urlsplit(origin).netloc == request.host
        except ValueError:
            same_origin = False
        if (not request.is_json or not expected or not secrets.compare_digest(expected, supplied)
                or not same_origin):
            abort(jsonify_error("Обновите страницу и повторите действие", 403))

    def jsonify_error(message, status):
        response = jsonify(error=message)
        response.status_code = status
        return response

    def require_admin(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            if not authenticated():
                session.pop("admin_auth", None)
                return jsonify_error("Требуется вход администратора", 401)
            if request.method != "GET":
                check_csrf()
            return handler(*args, **kwargs)
        return wrapped

    def serialize_user(db, row):
        return {
            "id": row["id"], "nickname": row["nickname"], "email": row["email"],
            "balance": str(int(row["balance"])), "totalEarned": str(int(row["total_earned"])),
            "isBanned": bool(row["is_banned"]), "isVerified": bool(row["is_verified"]),
            "badges": player_badges(db, row["id"], row["is_verified"]),
            "incomeBoost": {"multiplier": row["admin_income_multiplier"],
                            "until": row["admin_income_until"],
                            "remaining": max(0, row["admin_income_until"] - int(time.time()))},
        }

    @app.after_request
    def admin_headers(response):
        if request.path.startswith("/admin") or request.path.startswith("/api/admin/"):
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Frame-Options"] = "DENY"
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "same-origin"
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self'; style-src 'self'; "
                "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        return response

    @app.get("/admin")
    @app.get("/admin/")
    @app.get("/admin/login")
    def admin_page():
        return send_from_directory(base_dir, "admin.html")

    @app.get("/admin.js")
    def admin_script():
        return send_from_directory(base_dir, "admin.js")

    @app.get("/admin.css")
    def admin_style():
        return send_from_directory(base_dir, "admin.css")

    @app.get("/api/admin/session")
    def admin_session():
        return jsonify(authenticated=authenticated(), configured=bool(all(credentials())),
                       csrfToken=csrf_token(), badges=BADGES if authenticated() else [])

    @app.post("/api/admin/login")
    def admin_login():
        check_csrf()
        if not all(credentials()):
            return jsonify_error("Вход администратора ещё не настроен на сервере", 503)
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify_error("Введите логин и пароль", 400)
        login, password = payload.get("login"), payload.get("password")
        if not isinstance(login, str) or not isinstance(password, str) or len(login) > 128 or len(password) > 256:
            return jsonify_error("Введите логин и пароль", 400)
        now = int(time.time())
        # Shared SQLite limit survives restarts and applies to every Gunicorn worker.
        with db_connection() as db:
            limit = db.execute("SELECT * FROM admin_login_limits WHERE key = 'login'").fetchone()
            if limit and now - limit["started_at"] < LOGIN_WINDOW and limit["attempts"] >= LOGIN_ATTEMPTS:
                response = jsonify_error("Слишком много попыток. Повторите вход через 5 минут", 429)
                response.headers["Retry-After"] = str(LOGIN_WINDOW - (now - limit["started_at"]))
                return response
            if not limit or now - limit["started_at"] >= LOGIN_WINDOW:
                db.execute("INSERT OR REPLACE INTO admin_login_limits VALUES ('login', ?, 0)", (now,))
            try:
                login_matches = check_password_hash(credentials()[0], login.strip())
                password_matches = check_password_hash(credentials()[1], password)
            except (ValueError, TypeError):
                return jsonify_error("Некорректная настройка входа администратора на сервере", 503)
            if not (login_matches and password_matches):
                db.execute("UPDATE admin_login_limits SET attempts = attempts + 1 WHERE key = 'login'")
                return jsonify_error("Логин или пароль неверны", 401)
            db.execute("DELETE FROM admin_login_limits WHERE key = 'login'")
        session["admin_auth"] = {"version": credential_version(), "expires": now + SESSION_SECONDS}
        session["admin_csrf"] = secrets.token_urlsafe(32)
        return jsonify(authenticated=True, csrfToken=session["admin_csrf"], badges=BADGES)

    @app.post("/api/admin/logout")
    @require_admin
    def admin_logout():
        session.pop("admin_auth", None)
        session.pop("admin_csrf", None)
        return jsonify(message="Вы вышли из админ-панели")

    @app.get("/api/admin/users")
    @require_admin
    def admin_users():
        query = request.args.get("q", "").strip()[:200]
        try:
            page = max(1, min(1_000_000, int(request.args.get("page", "1"))))
        except ValueError:
            return jsonify_error("Некорректный номер страницы", 400)
        where = " WHERE instr(casefold(nickname), casefold(?)) > 0 OR instr(casefold(email), casefold(?)) > 0 OR CAST(id AS TEXT) = ?"
        with db_connection() as db:
            count = db.execute("SELECT COUNT(*) FROM users" + where, (query, query, query)).fetchone()[0]
            rows = db.execute("SELECT * FROM users" + where + " ORDER BY id DESC LIMIT 50 OFFSET ?",
                              (query, query, query, (page - 1) * 50)).fetchall()
            return jsonify(users=[serialize_user(db, row) for row in rows], total=count, page=page, pageSize=50)

    @app.get("/api/admin/users/<int:user_id>")
    @require_admin
    def admin_user(user_id):
        with db_connection() as db:
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if row is None:
                return jsonify_error("Игрок не найден", 404)
            return jsonify(user=serialize_user(db, row))

    @app.post("/api/admin/users/<int:user_id>/actions")
    @require_admin
    def admin_action(user_id):
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify_error("Выберите действие", 400)
        action = payload.get("action")
        if not isinstance(action, str) or action not in {
            "ban", "unban", "add_clicks", "remove_clicks", "income_boost", "stop_income_boost",
            "reset", "grant_badges", "revoke_badges",
        }:
            return jsonify_error("Неизвестное действие", 400)
        details = {}
        if action in {"add_clicks", "remove_clicks"}:
            raw = payload.get("amount")
            if (isinstance(raw, bool) or not isinstance(raw, (str, int)) or len(str(raw)) > 101
                    or not str(raw).isascii() or not str(raw).isdigit()):
                return jsonify_error("Введите положительное целое количество кликов", 400)
            amount = int(raw)
            if not 0 < amount <= MAX_AMOUNT:
                return jsonify_error("Количество кликов должно быть от 1 до 10^100", 400)
            details["amount"] = str(amount)
        if action == "income_boost":
            multiplier, duration = payload.get("multiplier"), payload.get("duration")
            if (type(multiplier) is not int or not 2 <= multiplier <= 1000
                    or type(duration) is not int or not 1 <= duration <= 31_536_000):
                return jsonify_error("Множитель: 2–1000. Срок: от 1 секунды до 365 дней", 400)
            details = {"multiplier": multiplier, "duration": duration}
        if action in {"grant_badges", "revoke_badges"}:
            selected = payload.get("badges")
            if (not isinstance(selected, list) or not 1 <= len(selected) <= len(BADGES)
                    or any(not isinstance(item, str) or item not in BADGE_IDS for item in selected)):
                return jsonify_error("Выберите бейджи из списка", 400)
            details["badges"] = sorted(set(selected))
        if action == "reset" and (type(payload.get("confirmUserId")) is not int or payload["confirmUserId"] != user_id):
            return jsonify_error("Подтвердите ID обнуляемого аккаунта", 400)
        with db_connection() as db:
            user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if user is None:
                return jsonify_error("Игрок не найден", 404)
            timestamp = timed_games.now_ms()
            timed_games.synchronize(db, timestamp, user_id)
            user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if action == "remove_clicks" and amount > int(user["balance"]):
                return jsonify_error("Нельзя забрать больше кликов, чем есть на балансе", 400)
            if action in {"ban", "unban"}:
                banned = int(action == "ban")
                db.execute("UPDATE users SET is_banned = ?, session_version = session_version + 1, last_income_at = ? WHERE id = ?",
                           (banned, int(time.time()), user_id))
                for duration in timed_games.MODES:
                    timed_games.update_rewards(db, duration, timestamp)
            elif action in {"add_clicks", "remove_clicks"}:
                delta = amount if action == "add_clicks" else -amount
                db.execute("UPDATE users SET balance = amount_add(balance, ?) WHERE id = ?", (db_amount(delta), user_id))
            elif action in {"income_boost", "stop_income_boost"}:
                factor = multiplier if action == "income_boost" else 1
                until = int(time.time()) + duration if action == "income_boost" else 0
                db.execute("UPDATE users SET admin_income_multiplier = ?, admin_income_until = ?, last_income_at = ? WHERE id = ?",
                           (factor, until, int(time.time()), user_id))
            elif action in {"grant_badges", "revoke_badges"}:
                for badge_id in details["badges"]:
                    if badge_id == "verified":
                        verified = int(action == "grant_badges")
                        db.execute("UPDATE users SET is_verified = ?, verification_override = ? WHERE id = ?", (verified, verified, user_id))
                    elif action == "grant_badges":
                        db.execute("INSERT OR IGNORE INTO user_badges VALUES (?, ?)", (user_id, badge_id))
                    else:
                        db.execute("DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?", (user_id, badge_id))
            elif action == "reset":
                # Remove dependent records before runs, preserving credentials and moderation status.
                for table in ("timed_bests", "timed_rewards", "timed_runs", "ad_rewards", "investments",
                              "user_achievements", "user_badges", "user_avatar_images", "user_robots",
                              "user_research", "user_cosmetics", "user_collections", "user_boosts"):
                    db.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
                db.execute("""UPDATE users SET balance = 0, click_force = 1, click_upgrade_cost = 100,
                              prestige_points = 0, total_earned = 0, total_spent = 0,
                              active_theme = 'classic', avatar = '{}', is_verified = 0, verification_override = 0,
                              admin_income_multiplier = 1, admin_income_until = 0, last_income_at = ?,
                              session_version = session_version + 1 WHERE id = ?""", (int(time.time()), user_id))
                ensure_user_rows(db, user_id)
                for duration in timed_games.MODES:
                    timed_games.update_rewards(db, duration, timestamp)
            timed_games.refresh_reward_rates(db, user_id)
            db.execute("INSERT INTO admin_audit(user_id, action, details, created_at) VALUES (?, ?, ?, ?)",
                       (user_id, action, json.dumps(details, ensure_ascii=False), int(time.time())))
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            return jsonify(message="Изменения сохранены", user=serialize_user(db, row))
