"""Device-bound PIN and platform passkeys. No reusable password is stored in the browser."""

import hashlib
import json
import re
import secrets
import sqlite3
import time
from functools import wraps
from urllib.parse import urlsplit

from flask import abort, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash
from webauthn import (base64url_to_bytes, generate_authentication_options,
                      generate_registration_options, options_to_json,
                      verify_authentication_response, verify_registration_response)
from webauthn.helpers.exceptions import WebAuthnException
from webauthn.helpers.structs import (AuthenticatorAttachment, AuthenticatorSelectionCriteria,
                                     PublicKeyCredentialDescriptor, ResidentKeyRequirement,
                                     UserVerificationRequirement)

COOKIE = "clicker_quick_device"
COOKIE_PATH = "/api/quick-auth"
DEVICE_SECONDS = 90 * 24 * 60 * 60
CHALLENGE_SECONDS = 120
MAX_PIN_ATTEMPTS = 5
DEFAULT_ORIGINS = "https://max-click.iteacher-ai.org,https://max-click-pesh.iteacher-alex.org"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def init_db(db):
    db.execute("""CREATE TABLE IF NOT EXISTS quick_auth_devices (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_version INTEGER NOT NULL,
        pin_hash TEXT,
        pin_attempts INTEGER NOT NULL DEFAULT 0,
        credential_id BLOB UNIQUE,
        public_key BLOB,
        sign_count INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS quick_auth_challenges (
        token_hash TEXT PRIMARY KEY,
        device_hash TEXT NOT NULL REFERENCES quick_auth_devices(token_hash) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        challenge BLOB NOT NULL,
        expires_at INTEGER NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS quick_auth_password_limits (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )""")


def register_routes(app, db_connection, require_user, build_state, ensure_user_rows, reset_income_timer):
    def origin():
        host = request.host
        hostname = urlsplit("//" + host).hostname
        allowed = [value.strip().rstrip("/") for value in app.config["CLICKER_AUTH_ORIGINS"].split(",") if value.strip()]
        if hostname in {"localhost", "127.0.0.1", "::1"}:
            expected = f"{request.scheme}://{host}"
        else:
            expected = next((value for value in allowed if urlsplit(value).scheme == "https" and urlsplit(value).netloc == host), None)
        if not expected:
            abort(jsonify_error("Для быстрого входа откройте настроенный HTTPS-адрес игры", 400))
        if request.headers.get("Origin", expected) != expected or request.headers.get("Sec-Fetch-Site") == "cross-site":
            abort(jsonify_error("Запрос с другого сайта запрещён", 403))
        return expected

    def jsonify_error(message, status, **extra):
        response = jsonify(error=message, **extra)
        response.status_code = status
        return response

    def protected(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            origin()
            token = session.get("quick_csrf", "")
            supplied = request.headers.get("X-Quick-CSRF", "")
            if not token or not secrets.compare_digest(token.encode(), supplied.encode()):
                return jsonify_error("Обновите страницу и повторите попытку", 403)
            if not request.is_json:
                return jsonify_error("Ожидается JSON", 400)
            return handler(*args, **kwargs)
        return wrapped

    def payload():
        value = request.get_json(silent=True)
        return value if isinstance(value, dict) else {}

    def credential_payload():
        value = payload().get("credential")
        if not isinstance(value, dict) or not isinstance(value.get("response"), dict):
            raise ValueError("Invalid credential")
        if any(not isinstance(value.get(key), str) for key in ("id", "rawId", "type")):
            raise ValueError("Invalid credential fields")
        if not isinstance(value["response"].get("clientDataJSON"), str):
            raise ValueError("Invalid client data")
        return value

    def device(db):
        token = request.cookies.get(COOKIE, "")
        if not token or len(token) > 128:
            return None
        row = db.execute("""SELECT d.*, u.nickname, u.is_banned, u.session_version AS current_version
                            FROM quick_auth_devices d JOIN users u ON u.id = d.user_id
                            WHERE d.token_hash = ? AND d.origin = ? AND d.expires_at > ?""",
                         (digest(token), origin(), int(time.time()))).fetchone()
        if row is None or row["is_banned"] or row["session_version"] != row["current_version"]:
            return None
        return row

    def configuration_user(db, password):
        user = db.execute("SELECT * FROM users WHERE id = ?", (session["user_id"],)).fetchone()
        now = int(time.time())
        limit = db.execute("SELECT * FROM quick_auth_password_limits WHERE user_id = ?", (user["id"],)).fetchone()
        if limit and limit["expires_at"] > now and limit["attempts"] >= 5:
            return None, jsonify_error("Слишком много попыток подтверждения пароля. Повторите через 5 минут", 429)
        if not isinstance(password, str) or not check_password_hash(user["password_hash"], password):
            attempts = limit["attempts"] + 1 if limit and limit["expires_at"] > now else 1
            expires = limit["expires_at"] if limit and limit["expires_at"] > now else now + 300
            db.execute("INSERT OR REPLACE INTO quick_auth_password_limits VALUES (?, ?, ?)", (user["id"], attempts, expires))
            return None, jsonify_error("Пароль аккаунта неверен", 400)
        db.execute("DELETE FROM quick_auth_password_limits WHERE user_id = ?", (user["id"],))
        return user, None

    def prepare_device(db, user):
        now = int(time.time())
        db.execute("DELETE FROM quick_auth_devices WHERE expires_at <= ? OR (user_id = ? AND session_version != ?)",
                   (now, user["id"], user["session_version"]))
        current = device(db)
        if current and current["user_id"] == user["id"]:
            token = request.cookies[COOKIE]
            db.execute("UPDATE quick_auth_devices SET expires_at = ? WHERE token_hash = ?", (now + DEVICE_SECONDS, current["token_hash"]))
        else:
            token = secrets.token_urlsafe(32)
            db.execute("""INSERT INTO quick_auth_devices(token_hash, user_id, session_version, origin, expires_at)
                          VALUES (?, ?, ?, ?, ?)""", (digest(token), user["id"], user["session_version"], origin(), now + DEVICE_SECONDS))
        return token

    def set_device_cookie(response, token):
        response.set_cookie(COOKIE, token, max_age=DEVICE_SECONDS, httponly=True,
                            secure=origin().startswith("https://"), samesite="Strict", path=COOKIE_PATH)
        return response

    def save_challenge(db, device_hash, purpose, challenge):
        previous = session.pop("quick_challenge", "")
        db.execute("DELETE FROM quick_auth_challenges WHERE expires_at <= ? OR token_hash = ?", (int(time.time()), digest(previous)))
        token = secrets.token_urlsafe(32)
        session["quick_challenge"] = token
        db.execute("INSERT INTO quick_auth_challenges VALUES (?, ?, ?, ?, ?)",
                   (digest(token), device_hash, purpose, challenge, int(time.time()) + CHALLENGE_SECONDS))

    def take_challenge(db, current, purpose):
        token = session.pop("quick_challenge", "")
        row = db.execute("SELECT * FROM quick_auth_challenges WHERE token_hash = ?", (digest(token),)).fetchone()
        db.execute("DELETE FROM quick_auth_challenges WHERE token_hash = ?", (digest(token),))
        if not current or not row or row["purpose"] != purpose or row["device_hash"] != current["token_hash"] or row["expires_at"] <= int(time.time()):
            return None
        return row

    def sign_in(db, current):
        session["user_id"] = current["user_id"]
        session["user_session_version"] = current["session_version"]
        ensure_user_rows(db, current["user_id"])
        reset_income_timer(db, current["user_id"])
        return jsonify(build_state(db, current["user_id"], 0))

    @app.after_request
    def quick_auth_headers(response):
        if request.path.startswith("/api/quick-auth/"):
            response.headers["Cache-Control"] = "no-store"
            response.headers["Vary"] = "Cookie"
        return response

    @app.get("/api/quick-auth/status")
    def status():
        origin()
        if "quick_csrf" not in session:
            session["quick_csrf"] = secrets.token_urlsafe(32)
        with db_connection() as db:
            current = device(db)
            if current and session.get("user_id", current["user_id"]) != current["user_id"]:
                current = None
            return jsonify(csrfToken=session["quick_csrf"], pinEnabled=bool(current and current["pin_hash"]),
                           passkeyEnabled=bool(current and current["credential_id"]), nickname=current["nickname"] if current else "")

    @app.post("/api/quick-auth/pin")
    @require_user
    @protected
    def setup_pin():
        data = payload()
        pin = data.get("pin")
        if not isinstance(pin, str) or not re.fullmatch(r"[0-9]{6}", pin):
            return jsonify_error("PIN должен состоять ровно из 6 цифр", 400)
        with db_connection() as db:
            user, error = configuration_user(db, data.get("password"))
            if error is not None:
                return error
            token = prepare_device(db, user)
            db.execute("UPDATE quick_auth_devices SET pin_hash = ?, pin_attempts = 0 WHERE token_hash = ?",
                       (generate_password_hash(f"{token}:{pin}"), digest(token)))
            return set_device_cookie(jsonify(message="Вход по PIN включён на этом устройстве"), token)

    @app.post("/api/quick-auth/pin/login")
    @protected
    def login_pin():
        pin = payload().get("pin")
        if not isinstance(pin, str) or not re.fullmatch(r"[0-9]{6}", pin):
            return jsonify_error("Введите 6 цифр PIN-кода", 400)
        with db_connection() as db:
            current = device(db)
            if not current or not current["pin_hash"]:
                return jsonify_error("Вход по PIN недоступен. Войдите по почте и паролю", 401, code="PIN_DISABLED")
            if not check_password_hash(current["pin_hash"], f"{request.cookies[COOKIE]}:{pin}"):
                attempts = current["pin_attempts"] + 1
                if attempts >= MAX_PIN_ATTEMPTS:
                    db.execute("UPDATE quick_auth_devices SET pin_hash = NULL, pin_attempts = ? WHERE token_hash = ?", (attempts, current["token_hash"]))
                    return jsonify_error("После 5 неверных попыток вход по PIN отключён. Войдите паролем и настройте PIN заново", 429, code="PIN_DISABLED")
                db.execute("UPDATE quick_auth_devices SET pin_attempts = ? WHERE token_hash = ?", (attempts, current["token_hash"]))
                return jsonify_error(f"Неверный PIN. Осталось попыток: {MAX_PIN_ATTEMPTS - attempts}", 401)
            db.execute("UPDATE quick_auth_devices SET pin_attempts = 0 WHERE token_hash = ?", (current["token_hash"],))
            return sign_in(db, current)

    @app.post("/api/quick-auth/passkey/register/options")
    @require_user
    @protected
    def registration_options():
        with db_connection() as db:
            user, error = configuration_user(db, payload().get("password"))
            if error is not None:
                return error
            token = prepare_device(db, user)
            options = generate_registration_options(
                rp_id=urlsplit(origin()).hostname, rp_name="Кликер",
                user_id=str(user["id"]).encode(), user_name=user["email"], user_display_name=user["nickname"],
                authenticator_selection=AuthenticatorSelectionCriteria(
                    authenticator_attachment=AuthenticatorAttachment.PLATFORM,
                    resident_key=ResidentKeyRequirement.PREFERRED,
                    user_verification=UserVerificationRequirement.REQUIRED),
                timeout=60000,
                exclude_credentials=[PublicKeyCredentialDescriptor(id=row["credential_id"]) for row in db.execute(
                    "SELECT credential_id FROM quick_auth_devices WHERE user_id = ? AND origin = ? AND credential_id IS NOT NULL",
                    (user["id"], origin())).fetchall()])
            save_challenge(db, digest(token), "register", options.challenge)
            return set_device_cookie(jsonify(json.loads(options_to_json(options))), token)

    @app.post("/api/quick-auth/passkey/register/verify")
    @require_user
    @protected
    def registration_verify():
        with db_connection() as db:
            current = device(db)
            challenge = take_challenge(db, current, "register")
            if not challenge or current["user_id"] != session["user_id"]:
                return jsonify_error("Запрос истёк. Начните настройку заново", 400)
            try:
                credential = credential_payload()
                if not isinstance(credential["response"].get("attestationObject"), str):
                    raise ValueError("Invalid attestation")
                verified = verify_registration_response(credential=credential,
                    expected_challenge=challenge["challenge"], expected_rp_id=urlsplit(origin()).hostname,
                    expected_origin=origin(), require_user_verification=True)
                db.execute("UPDATE quick_auth_devices SET credential_id = ?, public_key = ?, sign_count = ? WHERE token_hash = ?",
                           (verified.credential_id, verified.credential_public_key, verified.sign_count, current["token_hash"]))
            except (WebAuthnException, ValueError, TypeError, KeyError, sqlite3.IntegrityError):
                return jsonify_error("Не удалось подтвердить ключ доступа. Повторите настройку", 400)
            return jsonify(message="Вход по биометрии или защите устройства включён")

    @app.post("/api/quick-auth/passkey/login/options")
    @protected
    def authentication_options():
        with db_connection() as db:
            current = device(db)
            if not current or not current["credential_id"]:
                return jsonify_error("Сначала настройте биометрию после входа по паролю", 401)
            options = generate_authentication_options(rp_id=urlsplit(origin()).hostname,
                allow_credentials=[PublicKeyCredentialDescriptor(id=current["credential_id"])],
                user_verification=UserVerificationRequirement.REQUIRED, timeout=60000)
            save_challenge(db, current["token_hash"], "login", options.challenge)
            return jsonify(json.loads(options_to_json(options)))

    @app.post("/api/quick-auth/passkey/login/verify")
    @protected
    def authentication_verify():
        with db_connection() as db:
            current = device(db)
            challenge = take_challenge(db, current, "login")
            if not challenge or not current["credential_id"]:
                return jsonify_error("Запрос истёк. Повторите вход", 400)
            try:
                credential = credential_payload()
                if any(not isinstance(credential["response"].get(key), str) for key in ("authenticatorData", "signature")):
                    raise ValueError("Invalid assertion")
                if base64url_to_bytes(credential["id"]) != current["credential_id"]:
                    raise ValueError("Wrong credential")
                handle = credential.get("response", {}).get("userHandle")
                if handle is not None and (not isinstance(handle, str) or base64url_to_bytes(handle) != str(current["user_id"]).encode()):
                    raise ValueError("Wrong account")
                verified = verify_authentication_response(credential=credential,
                    expected_challenge=challenge["challenge"], expected_rp_id=urlsplit(origin()).hostname,
                    expected_origin=origin(), credential_public_key=current["public_key"],
                    credential_current_sign_count=current["sign_count"], require_user_verification=True)
            except (WebAuthnException, ValueError, TypeError, KeyError):
                return jsonify_error("Не удалось подтвердить вход. Попробуйте ещё раз или войдите паролем", 401)
            db.execute("UPDATE quick_auth_devices SET sign_count = ? WHERE token_hash = ?", (verified.new_sign_count, current["token_hash"]))
            return sign_in(db, current)

    @app.post("/api/quick-auth/disable")
    @require_user
    @protected
    def disable():
        with db_connection() as db:
            db.execute("DELETE FROM quick_auth_devices WHERE token_hash = ? AND user_id = ?", (digest(request.cookies.get(COOKIE, "")), session["user_id"]))
        session.pop("quick_challenge", None)
        response = jsonify(message="Быстрый вход на этом устройстве отключён")
        response.delete_cookie(COOKIE, path=COOKIE_PATH, secure=origin().startswith("https://"), httponly=True, samesite="Strict")
        return response
