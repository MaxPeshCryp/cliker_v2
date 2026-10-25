"""Device PIN, enrollment authorization, revocation and WebAuthn challenge boundaries."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from werkzeug.security import generate_password_hash

import app as clicker
import quick_auth


class QuickAuthTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        database = patch.object(clicker, "DATABASE_PATH", Path(temporary.name) / "quick.db")
        database.start()
        self.addCleanup(database.stop)
        config = patch.dict(clicker.app.config, TESTING=True, SESSION_COOKIE_SECURE=False)
        config.start()
        self.addCleanup(config.stop)
        clicker.init_db()
        with clicker.db_connection() as db:
            db.execute("INSERT INTO users(nickname, email, password_hash, last_income_at) VALUES (?, ?, ?, 0)",
                       ("PIN Player", "quick@test", generate_password_hash("account-password", method="pbkdf2:sha256:1000")))
            clicker.ensure_user_rows(db, 1)
        self.client = clicker.app.test_client()
        self.csrf = self.client.get("/api/quick-auth/status").get_json()["csrfToken"]

    def post(self, path, data=None, client=None, **kwargs):
        return (client or self.client).post("/api/quick-auth/" + path, json=data or {}, headers={"X-Quick-CSRF": self.csrf, **kwargs.pop("headers", {})}, **kwargs)

    def password_login(self):
        self.assertEqual(self.client.post("/api/login", json={"email": "quick@test", "password": "account-password"}).status_code, 200)

    def enroll_pin(self, pin="012345"):
        self.password_login()
        response = self.post("pin", {"pin": pin, "password": "account-password"})
        self.assertEqual(response.status_code, 200, response.get_json())
        return self.client.get_cookie(quick_auth.COOKIE, path=quick_auth.COOKIE_PATH).value

    def test_pin_is_device_bound_and_password_is_required_to_enroll(self):
        self.assertEqual(self.post("pin", {"pin": "012345", "password": "account-password"}).status_code, 401)
        self.password_login()
        self.assertEqual(self.post("pin", {"pin": "012345", "password": "wrong"}).status_code, 400)
        for invalid in (123456, "12345", "1234567", "abcdef", "１２３４５６", None):
            self.assertEqual(self.post("pin", {"pin": invalid, "password": "account-password"}).status_code, 400)
        token = self.enroll_pin()
        cookie = self.client.get_cookie(quick_auth.COOKIE, path=quick_auth.COOKIE_PATH)
        self.assertTrue(cookie.http_only)
        self.assertEqual(cookie.same_site, "Strict")
        with clicker.db_connection() as db:
            row = db.execute("SELECT * FROM quick_auth_devices").fetchone()
            self.assertNotEqual(row["token_hash"], token)
            self.assertNotIn("012345", row["pin_hash"])
        self.client.post("/api/logout")
        outsider = clicker.app.test_client()
        csrf = outsider.get("/api/quick-auth/status").get_json()["csrfToken"]
        self.assertEqual(self.post("pin/login", {"pin": "012345"}, client=outsider, headers={"X-Quick-CSRF": csrf}).status_code, 401)
        self.assertEqual(self.post("pin/login", {"pin": "012345"}).status_code, 200)
        self.assertEqual(self.client.get("/api/state").get_json()["userNik"], "PIN Player")

    def test_five_wrong_pins_disable_pin_across_sessions(self):
        token = self.enroll_pin()
        self.client.post("/api/logout")
        for index in range(5):
            response = self.post("pin/login", {"pin": "999999"})
            self.assertEqual(response.status_code, 429 if index == 4 else 401)
        self.assertEqual(response.get_json()["code"], "PIN_DISABLED")
        self.assertEqual(self.post("pin/login", {"pin": "012345"}).status_code, 401)
        self.assertFalse(self.client.get("/api/quick-auth/status").get_json()["pinEnabled"])
        other = clicker.app.test_client()
        other.set_cookie(quick_auth.COOKIE, token, path=quick_auth.COOKIE_PATH)
        csrf = other.get("/api/quick-auth/status").get_json()["csrfToken"]
        self.assertEqual(self.post("pin/login", {"pin": "012345"}, client=other, headers={"X-Quick-CSRF": csrf}).status_code, 401)
        self.enroll_pin("654321")
        self.client.post("/api/logout")
        self.assertEqual(self.post("pin/login", {"pin": "654321"}).status_code, 200)

    def test_success_resets_failed_pin_attempts(self):
        self.enroll_pin()
        self.client.post("/api/logout")
        self.assertEqual(self.post("pin/login", {"pin": "999999"}).status_code, 401)
        self.assertEqual(self.post("pin/login", {"pin": "012345"}).status_code, 200)
        with clicker.db_connection() as db:
            self.assertEqual(db.execute("SELECT pin_attempts FROM quick_auth_devices").fetchone()[0], 0)

    def test_expiry_ban_and_session_version_revoke_device(self):
        for change in ("expiry", "ban", "version"):
            with self.subTest(change=change):
                with clicker.db_connection() as db:
                    db.execute("UPDATE users SET is_banned = 0 WHERE id = 1")
                self.enroll_pin()
                self.client.post("/api/logout")
                with clicker.db_connection() as db:
                    if change == "expiry":
                        db.execute("UPDATE quick_auth_devices SET expires_at = 0")
                    elif change == "ban":
                        db.execute("UPDATE users SET is_banned = 1 WHERE id = 1")
                    else:
                        db.execute("UPDATE users SET session_version = session_version + 1 WHERE id = 1")
                self.assertEqual(self.post("pin/login", {"pin": "012345"}).status_code, 401)
                self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_disable_forgets_pin_and_passkey_and_clears_cookie(self):
        token = self.enroll_pin()
        self.assertEqual(self.post("disable").status_code, 200)
        self.assertIsNone(self.client.get_cookie(quick_auth.COOKIE, path=quick_auth.COOKIE_PATH))
        self.client.set_cookie(quick_auth.COOKIE, token, path=quick_auth.COOKIE_PATH)
        self.client.post("/api/logout")
        self.assertEqual(self.post("pin/login", {"pin": "012345"}).status_code, 401)

    def test_csrf_origin_and_public_asset_boundaries(self):
        self.password_login()
        for path in ("pin", "disable", "passkey/register/options", "pin/login", "passkey/login/options", "passkey/login/verify", "passkey/register/verify"):
            self.assertEqual(self.client.post("/api/quick-auth/" + path, json={}).status_code, 403)
            self.assertEqual(self.post(path, headers={"Origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(self.client.get("/api/quick-auth/status", base_url="http://untrusted.example").status_code, 400)
        self.assertEqual(self.client.get("/api/quick-auth/status").headers["Cache-Control"], "no-store")
        for path, code in (("/quick-auth.js", 200), ("/quick_auth.py", 404)):
            with self.client.get(path) as response:
                self.assertEqual(response.status_code, code)

    def test_confirmation_password_is_rate_limited(self):
        self.password_login()
        for _ in range(5):
            self.assertEqual(self.post("pin", {"pin": "012345", "password": "wrong"}).status_code, 400)
        self.assertEqual(self.post("pin", {"pin": "012345", "password": "account-password"}).status_code, 429)
        with clicker.db_connection() as db:
            db.execute("UPDATE quick_auth_password_limits SET expires_at = 0")
        self.assertEqual(self.post("pin", {"pin": "012345", "password": "account-password"}).status_code, 200)

    def test_registration_challenge_expires_is_bound_and_is_consumed_on_failure(self):
        self.password_login()
        options = self.post("passkey/register/options", {"password": "account-password"})
        self.assertEqual(options.status_code, 200)
        data = options.get_json()
        self.assertEqual(data["authenticatorSelection"]["userVerification"], "required")
        self.assertEqual(data["authenticatorSelection"]["authenticatorAttachment"], "platform")
        self.assertEqual(data["rp"]["id"], "localhost")
        for invalid in ({}, None, [], "invalid", {"response": []}, {"id": "a", "rawId": "a", "type": "public-key", "response": {"clientDataJSON": [], "attestationObject": {}}}):
            self.post("passkey/register/options", {"password": "account-password"})
            self.assertEqual(self.post("passkey/register/verify", {"credential": invalid}).status_code, 400)
        with clicker.db_connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM quick_auth_challenges").fetchone()[0], 0)
        self.assertFalse(self.client.get("/api/quick-auth/status").get_json()["passkeyEnabled"])
        self.post("passkey/register/options", {"password": "account-password"})
        with clicker.db_connection() as db:
            db.execute("UPDATE quick_auth_challenges SET expires_at = 0")
        self.assertEqual(self.post("passkey/register/verify", {"credential": {}}).status_code, 400)
        self.assertEqual(self.post("passkey/login/options").status_code, 401)


if __name__ == "__main__":
    unittest.main()
