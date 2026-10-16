"""Administrative permissions, moderation, exact balances and reset regressions."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dotenv import dotenv_values
from werkzeug.security import check_password_hash, generate_password_hash

import app as clicker
import admin_panel
from admin_credentials import write_credentials
from badges import BADGES


class AdminTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.login_hash = generate_password_hash("administrator", method="pbkdf2:sha256:1000")
        cls.password_hash = generate_password_hash("admin-test-password", method="pbkdf2:sha256:1000")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        database = patch.object(clicker, "DATABASE_PATH", Path(temporary.name) / "admin.db")
        database.start()
        self.addCleanup(database.stop)
        config = patch.dict(clicker.app.config, TESTING=True, SESSION_COOKIE_SECURE=False,
                            CLICKER_ADMIN_LOGIN_HASH=self.login_hash, CLICKER_ADMIN_PASSWORD_HASH=self.password_hash)
        config.start()
        self.addCleanup(config.stop)
        clicker.init_db()
        with clicker.db_connection() as db:
            db.execute("INSERT INTO users(nickname, email, password_hash, last_income_at) VALUES ('Игрок', 'kk@kk', ?, 0)",
                       (generate_password_hash("player-password", method="pbkdf2:sha256:1000"),))
            db.execute("INSERT INTO users(nickname, email, password_hash, last_income_at) VALUES ('Other', 'other@test', 'unused', 0)")
            clicker.ensure_user_rows(db, 1)
            clicker.ensure_user_rows(db, 2)
        self.player = clicker.app.test_client()
        with self.player.session_transaction() as value:
            value["user_id"] = 1
        self.admin = clicker.app.test_client()
        self.token = self.admin.get("/api/admin/session").get_json()["csrfToken"]

    def login(self, client=None, token=None):
        response = (client or self.admin).post("/api/admin/login", headers={"X-CSRF-Token": token or self.token},
                                              json={"login": "administrator", "password": "admin-test-password"})
        if response.status_code == 200 and client is None:
            self.token = response.get_json()["csrfToken"]
        return response

    def action(self, action, user_id=1, **extra):
        return self.admin.post(f"/api/admin/users/{user_id}/actions", json={"action": action, **extra},
                               headers={"X-CSRF-Token": self.token})

    def user(self, user_id=1):
        with clicker.db_connection() as db:
            return clicker.get_user(db, user_id)

    def test_separate_login_protected_data_and_private_files(self):
        for client in (self.player, self.admin):
            self.assertEqual(client.get("/api/admin/users").status_code, 401)
            self.assertEqual(client.post("/api/admin/users/1/actions", json={"action": "ban"}).status_code, 401)
        for path in ("/admin", "/admin/login", "/admin.js", "/admin.css"):
            response = self.admin.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            response.close()
        for path in ("/.env", "/admin_credentials.py", "/admin_panel.py", "/clicker.db", "/verified_users.txt"):
            self.assertEqual(self.admin.get(path).status_code, 404)
        self.assertEqual(self.login().status_code, 200)
        self.assertEqual(self.admin.get("/api/state").status_code, 401)
        data = self.admin.get("/api/admin/users?q=kk@kk").get_json()
        self.assertEqual(data["total"], 1)
        self.assertNotIn("password_hash", data["users"][0])
        self.assertNotIn(self.password_hash, str(data))
        self.assertEqual(self.admin.get("/api/admin/users?q=2").get_json()["users"][0]["id"], 2)
        self.assertEqual(self.admin.get("/api/admin/users", query_string={"q": "игРОК"}).get_json()["total"], 1)
        self.assertEqual(self.admin.get("/api/admin/users?page=bad").status_code, 400)

    def test_csrf_origin_and_rotated_tokens(self):
        self.assertEqual(self.admin.post("/api/admin/login", json={"login": "administrator", "password": "admin-test-password"}).status_code, 403)
        old_token = self.token
        self.assertEqual(self.login().status_code, 200)
        for headers in ({}, {"X-CSRF-Token": old_token}, {"X-CSRF-Token": self.token, "Origin": "https://evil.example"},
                        {"X-CSRF-Token": self.token, "Origin": "http://["}):
            result = self.admin.post("/api/admin/users/1/actions", headers=headers, json={"action": "ban"})
            self.assertEqual(result.status_code, 403)
        self.assertFalse(self.user()["is_banned"])
        self.assertEqual(self.action("ban").status_code, 200)

    def test_login_is_disabled_expired_and_invalidated_when_credentials_change(self):
        with patch.dict(clicker.app.config, CLICKER_ADMIN_PASSWORD_HASH=""):
            self.assertFalse(self.admin.get("/api/admin/session").get_json()["configured"])
            self.assertEqual(self.login().status_code, 503)
        self.login()
        with patch.dict(clicker.app.config, CLICKER_ADMIN_LOGIN_HASH="changed"):
            self.assertEqual(self.admin.get("/api/admin/users").status_code, 401)
        self.login()
        with patch.object(admin_panel.time, "time", return_value=admin_panel.time.time() + admin_panel.SESSION_SECONDS + 1):
            self.assertEqual(self.admin.get("/api/admin/users").status_code, 401)

    def test_failed_login_limit_shared_by_clients_and_resets_after_window(self):
        for _ in range(admin_panel.LOGIN_ATTEMPTS):
            result = self.admin.post("/api/admin/login", headers={"X-CSRF-Token": self.token},
                                     json={"login": "administrator", "password": "wrong"})
            self.assertEqual(result.status_code, 401)
        other = clicker.app.test_client()
        token = other.get("/api/admin/session").get_json()["csrfToken"]
        limited = self.login(other, token)
        self.assertEqual(limited.status_code, 429)
        self.assertIn("Retry-After", limited.headers)
        with patch.object(admin_panel.time, "time", return_value=admin_panel.time.time() + admin_panel.LOGIN_WINDOW + 1):
            self.assertEqual(self.login(other, token).status_code, 200)

    def test_exact_balance_change_and_validation_do_not_modify_experience(self):
        self.login()
        amount = 10 ** 40 + 123456789
        response = self.action("add_clicks", amount=str(amount))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["user"]["balance"], str(amount))
        self.assertEqual(self.action("remove_clicks", amount="9").get_json()["user"]["balance"], str(amount - 9))
        self.assertEqual(self.user()["total_earned"], 0)
        for invalid in ("-1", "0", "1.5", "1e3", [], {}, True, 5.5, "1" * 102):
            self.assertEqual(self.action("add_clicks", amount=invalid).status_code, 400)
        self.assertEqual(self.action("remove_clicks", amount=str(amount)).status_code, 400)
        self.assertEqual(self.user()["balance"], amount - 9)
        with clicker.db_connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM admin_audit").fetchone()[0], 2)

    def seed_podium(self):
        with clicker.db_connection() as db:
            timestamp = clicker.timed_games.now_ms()
            for user_id in (1, 2):
                run_id = db.execute("""INSERT INTO timed_runs(user_id, duration, started_at, ends_at, settled_at, status, balance, score)
                                       VALUES (?, 60, ?, ?, ?, 'finished', ?, ?)""",
                                    (user_id, timestamp - 61_000, timestamp - 1000, timestamp - 1000, 100 - user_id, 100 - user_id)).lastrowid
                db.execute("INSERT INTO timed_bests VALUES (?, 60, ?, ?, ?)", (user_id, run_id, 100 - user_id, timestamp - 1000))
            clicker.timed_games.update_rewards(db, 60, timestamp)

    def test_ban_blocks_existing_sessions_and_login_and_removes_podium_income(self):
        self.login()
        self.seed_podium()
        self.assertEqual(self.action("ban").status_code, 200)
        with clicker.db_connection() as db:
            self.assertEqual(clicker.timed_games.reward_rate(db, 1), 0)
            self.assertEqual(clicker.timed_games.podium(db, 60)[0][0], 2)
        response = self.player.post("/api/click")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.player.post("/api/login", json={"email": "kk@kk", "password": "player-password"}).status_code, 403)
        self.assertEqual(self.action("unban").status_code, 200)
        self.assertEqual(self.player.get("/api/state").status_code, 401)
        self.assertEqual(self.player.post("/api/login", json={"email": "kk@kk", "password": "player-password"}).status_code, 200)
        with clicker.db_connection() as db:
            self.assertGreater(clicker.timed_games.reward_rate(db, 1), 0)

    def test_ban_prevents_mini_game_and_ad_claims_in_other_open_sessions(self):
        self.login()
        other = clicker.app.test_client()
        with other.session_transaction() as value:
            value["user_id"] = 1
        self.action("ban")
        self.assertEqual(self.player.post("/api/timed/start", json={"duration": 60}).status_code, 403)
        self.assertEqual(other.post("/api/ads/start", json={"placement": "balance"}).status_code, 403)

    def test_income_multiplier_is_timed_stacks_and_can_be_revoked(self):
        self.login()
        with clicker.db_connection() as db:
            db.execute("UPDATE user_robots SET level = 1 WHERE user_id = 1 AND robot_id = 'robot1'")
            baseline = clicker.get_net_income_per_second(db, 1)
        self.assertEqual(self.action("income_boost", multiplier=5, duration=60).status_code, 200)
        with clicker.db_connection() as db:
            self.assertEqual(clicker.get_base_income_per_second(db, 1), 50)
            db.execute("UPDATE user_boosts SET active_until = ? WHERE user_id = 1 AND boost_id = 'income_x2'", (int(clicker.time.time()) + 120,))
            self.assertEqual(clicker.get_base_income_per_second(db, 1), 100)
        with patch.object(clicker.time, "time", return_value=clicker.time.time() + 61):
            with clicker.db_connection() as db:
                self.assertEqual(clicker.get_base_income_per_second(db, 1), 20)
        self.action("stop_income_boost")
        self.assertEqual(self.user()["admin_income_until"], 0)
        self.assertGreater(baseline, 0)
        for values in ({"multiplier": True, "duration": 60}, {"multiplier": 2, "duration": 0},
                       {"multiplier": 1001, "duration": 60}, {"multiplier": 2, "duration": 31_536_001}):
            self.assertEqual(self.action("income_boost", **values).status_code, 400)

    def test_twelve_multiple_badges_in_profiles_and_both_rankings_and_persistent_revocation(self):
        self.login()
        self.seed_podium()
        ids = [badge["id"] for badge in BADGES]
        self.assertEqual(len(ids), 12)
        self.assertEqual(self.action("grant_badges", badges=ids).status_code, 200)
        self.assertEqual(self.action("grant_badges", badges=ids).status_code, 200)
        state = self.player.get("/api/state").get_json()
        self.assertEqual(len(state["badges"]), 12)
        self.assertEqual(len(state["leaderboard"]["around"][0]["badges"]), 12)
        self.assertEqual(len(state["timedGames"]["modes"][0]["top"][0]["badges"]), 12)
        self.assertEqual(self.action("revoke_badges", badges=["verified", "legend"]).status_code, 200)
        clicker.init_db()
        self.assertFalse(self.user()["is_verified"])
        state = self.player.get("/api/state").get_json()
        self.assertEqual(len(state["badges"]), 10)
        self.assertNotIn("legend", [badge["id"] for badge in state["badges"]])
        for invalid in ([], ["invalid"], [True], "verified", [[]]):
            self.assertEqual(self.action("grant_badges", badges=invalid).status_code, 400)

    def test_full_reset_preserves_credentials_and_other_users_and_invalidates_sessions(self):
        self.login()
        self.seed_podium()
        self.action("add_clicks", amount="100000")
        self.action("grant_badges", badges=["verified", "founder"])
        self.action("income_boost", multiplier=5, duration=60)
        with clicker.db_connection() as db:
            db.execute("UPDATE users SET click_force = 25, prestige_points = 20, total_earned = 30000, total_spent = 500, avatar = ? WHERE id = 1", ('{"character":"cat"}',))
            db.execute("UPDATE user_robots SET level = 2 WHERE user_id = 1")
            db.execute("UPDATE user_research SET level = 2 WHERE user_id = 1")
            db.execute("UPDATE user_cosmetics SET unlocked = 1 WHERE user_id = 1")
            db.execute("INSERT INTO investments(user_id, amount, payout_amount, ready_at) VALUES (1, 100, 120, 9999999999)")
            db.execute("INSERT INTO user_achievements VALUES (1, 'spender', 1)")
        password_hash = self.user()["password_hash"]
        self.assertEqual(self.action("reset").status_code, 400)
        self.assertEqual(self.action("reset", confirmUserId=2).status_code, 400)
        self.assertEqual(self.action("reset", confirmUserId=True).status_code, 400)
        self.assertEqual(self.action("reset", confirmUserId=1).status_code, 200)
        user = self.user()
        for field in ("balance", "prestige_points", "total_earned", "total_spent", "is_verified", "admin_income_until"):
            self.assertEqual(user[field], 0, field)
        self.assertEqual(user["password_hash"], password_hash)
        self.assertEqual(user["email"], "kk@kk")
        self.assertEqual(user["click_force"], 1)
        with clicker.db_connection() as db:
            for table in ("timed_runs", "timed_bests", "timed_rewards", "investments", "user_achievements", "user_badges"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id = 1").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT SUM(level) FROM user_robots WHERE user_id = 1").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM timed_runs WHERE user_id = 2").fetchone()[0], 1)
        self.assertEqual(self.player.get("/api/state").status_code, 401)
        self.assertEqual(self.player.post("/api/login", json={"email": "kk@kk", "password": "player-password"}).status_code, 200)
        clicker.init_db()
        self.assertFalse(self.user()["is_verified"])

    def test_independent_player_and_admin_logout(self):
        self.admin.post("/api/login", json={"email": "kk@kk", "password": "player-password"})
        self.login()
        self.admin.post("/api/logout")
        self.assertEqual(self.admin.get("/api/admin/users").status_code, 200)
        self.admin.post("/api/admin/logout", json={}, headers={"X-CSRF-Token": self.token})
        self.assertEqual(self.admin.get("/api/admin/users").status_code, 401)


class AdminCredentialTests(unittest.TestCase):
    def test_env_preserves_settings_and_contains_only_hashes_and_can_be_updated(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / ".env"
            path.write_text("CLICKER_SECRET_KEY=keep-this\n# existing comment\nCLICKER_ADMIN_LOGIN_HASH=old\n", encoding="utf-8")
            write_credentials(path, "my-admin", "secret-password-example")
            values = dotenv_values(path)
            self.assertEqual(values["CLICKER_SECRET_KEY"], "keep-this")
            self.assertTrue(check_password_hash(values["CLICKER_ADMIN_LOGIN_HASH"], "my-admin"))
            self.assertTrue(check_password_hash(values["CLICKER_ADMIN_PASSWORD_HASH"], "secret-password-example"))
            self.assertNotIn("secret-password-example", path.read_text())
            self.assertNotIn("my-admin", path.read_text())
            write_credentials(path, "new-admin", "another-secret-password")
            self.assertEqual(path.read_text().count("CLICKER_ADMIN_LOGIN_HASH="), 1)
            self.assertTrue(check_password_hash(dotenv_values(path)["CLICKER_ADMIN_LOGIN_HASH"], "new-admin"))
            before = path.read_text()
            with self.assertRaises(ValueError):
                write_credentials(path, "admin", "short")
            self.assertEqual(path.read_text(), before)
