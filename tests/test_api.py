"""Regression checks for the public HTTP interface and core economy rules."""

import tempfile
from io import BytesIO
from PIL import Image
import unittest
from pathlib import Path

import app as clicker


class ClickerApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_database_path = clicker.DATABASE_PATH
        clicker.DATABASE_PATH = Path(self.temp_dir.name) / "test-clicker.db"
        clicker.init_db()
        clicker.app.config.update(TESTING=True)
        self.client = clicker.app.test_client()

    def tearDown(self):
        clicker.DATABASE_PATH = self.original_database_path
        self.temp_dir.cleanup()

    def register_and_login(self):
        response = self.client.post(
            "/api/register",
            json={"nickname": "Tester", "email": "tester@example.com", "password": "safe-password"},
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post("/api/login", json={"email": "tester@example.com", "password": "safe-password"})
        self.assertEqual(response.status_code, 200)

    def set_balance(self, balance):
        with clicker.db_connection() as db:
            db.execute("UPDATE users SET balance = ? WHERE email = ?", (balance, "tester@example.com"))

    def test_only_public_assets_are_served(self):
        for path in ("/", "/style.css", "/script.js"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            response.close()
        self.assertEqual(self.client.get("/clicker.db").status_code, 404)
        self.assertEqual(self.client.get("/app.py").status_code, 404)

    def test_avatar_requires_login_validates_parts_and_persists(self):
        from player_style import DEFAULT_AVATAR
        avatar = {**DEFAULT_AVATAR, "character": "cat", "eyes": "wink", "accessory": "crown"}
        self.assertEqual(self.client.post("/api/profile/avatar", json=avatar).status_code, 401)
        self.register_and_login()
        self.assertEqual(self.client.get("/api/state").get_json()["avatar"], DEFAULT_AVATAR)
        for invalid in ([], {}, {**avatar, "color": "<script>"}, {**avatar, "eyes": []}, {**avatar, "extra": True}):
            self.assertEqual(self.client.post("/api/profile/avatar", json=invalid).status_code, 400)
        response = self.client.post("/api/profile/avatar", json=avatar)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["avatar"], avatar)
        self.client.post("/api/logout")
        self.client.post("/api/login", json={"email": "tester@example.com", "password": "safe-password"})
        state = self.client.get("/api/state").get_json()
        self.assertEqual(state["avatar"], avatar)
        self.assertEqual(state["leaderboard"]["top"][0]["avatar"], avatar)

    def test_themes_require_purchase_and_can_be_reused_without_spending(self):
        self.assertEqual(self.client.post("/api/profile/theme", json={"theme": "classic"}).status_code, 401)
        self.register_and_login()
        for theme, item in clicker.COSMETICS.items():
            self.assertGreater(item["cost"], 0)
            self.assertEqual(self.client.post("/api/profile/theme", json={"theme": theme}).status_code, 403)
            self.assertEqual(self.client.post(f"/api/cosmetics/{theme}/buy").status_code, 400)
            self.set_balance(item["cost"])
            bought = self.client.post(f"/api/cosmetics/{theme}/buy")
            self.assertEqual(bought.status_code, 200)
            self.assertEqual(bought.get_json()["userCount"], 0)
            self.assertTrue(bought.get_json()["cosmetics"][theme])
            self.assertEqual(self.client.post(f"/api/cosmetics/{theme}/buy").status_code, 200)
            self.client.post("/api/profile/theme", json={"theme": "classic"})
            result = self.client.post("/api/profile/theme", json={"theme": theme})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.get_json()["activeTheme"], theme)
            self.assertEqual(result.get_json()["userCount"], 0)
            self.assertEqual(self.client.get("/api/state").get_json()["activeTheme"], theme)
        for invalid in ([], {}, {"theme": []}, {"theme": "missing"}):
            self.assertEqual(self.client.post("/api/profile/theme", json=invalid).status_code, 400)
        result = self.client.post("/api/profile/theme", json={"theme": "classic"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.get_json()["userCount"], 0)

    def test_image_avatar_formats_persist_replace_and_return_to_builder(self):
        from player_style import DEFAULT_AVATAR
        self.assertEqual(self.client.post("/api/profile/avatar-image").status_code, 401)
        self.register_and_login()
        previous_url = None
        for fmt in ("PNG", "JPEG", "WEBP"):
            image = BytesIO()
            Image.new("RGB", (600, 300), "red").save(image, format=fmt)
            image.seek(0)
            response = self.client.post("/api/profile/avatar-image", data={"image": (image, "photo." + fmt.lower())})
            self.assertEqual(response.status_code, 200)
            state = response.get_json()
            url = state["avatar"]["imageUrl"]
            self.assertEqual(state["leaderboard"]["top"][0]["avatar"]["imageUrl"], url)
            self.assertEqual(self.client.get("/api/state").get_json()["avatar"]["imageUrl"], url)
            public_client = clicker.app.test_client()
            stored = public_client.get(url)
            self.assertEqual(stored.status_code, 200)
            self.assertEqual(stored.mimetype, "image/png")
            self.assertEqual(Image.open(BytesIO(stored.data)).size, (256, 256))
            self.assertEqual(public_client.get(url, headers={"If-None-Match": stored.headers["ETag"]}).status_code, 304)
            if previous_url:
                self.assertEqual(self.client.get(previous_url).status_code, 404)
            previous_url = url
        self.client.post("/api/logout")
        self.client.post("/api/login", json={"email": "tester@example.com", "password": "safe-password"})
        self.assertEqual(self.client.get("/api/state").get_json()["avatar"]["imageUrl"], url)
        self.client.post("/api/profile/avatar", json=DEFAULT_AVATAR)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.get("/api/state").get_json()["avatar"], DEFAULT_AVATAR)

    def test_image_avatar_rejects_invalid_files_and_keeps_previous_avatar(self):
        from player_style import DEFAULT_AVATAR
        self.register_and_login()
        self.assertEqual(self.client.post("/api/profile/avatar-image").status_code, 400)
        for data in (b"not a png", b'<svg xmlns="http://www.w3.org/2000/svg"/>', b"x" * (5 * 1024 * 1024 + 1)):
            result = self.client.post("/api/profile/avatar-image", data={"image": (BytesIO(data), "avatar.png")})
            self.assertEqual(result.status_code, 400)
        too_large = self.client.post("/api/profile/avatar-image", data=b"x" * (6 * 1024 * 1024 + 1), content_type="multipart/form-data")
        self.assertEqual(too_large.status_code, 413)
        self.assertIn("error", too_large.get_json())
        self.assertEqual(self.client.get("/api/state").get_json()["avatar"], DEFAULT_AVATAR)

    def test_avatar_updates_are_isolated_between_players(self):
        from player_style import DEFAULT_AVATAR
        self.register_and_login()
        avatar = {**DEFAULT_AVATAR, "character": "alien"}
        self.client.post("/api/profile/avatar", json=avatar)
        self.client.post("/api/register", json={"nickname": "Other", "email": "other@example.com", "password": "password"})
        self.client.post("/api/login", json={"email": "other@example.com", "password": "password"})
        state = self.client.get("/api/state").get_json()
        self.assertEqual(state["avatar"], DEFAULT_AVATAR)
        self.assertEqual(state["leaderboard"]["top"][0]["avatar"], avatar)

    def test_verification_is_server_managed_and_visible_in_profile_and_ranking(self):
        self.register_and_login()
        self.assertFalse(self.client.get("/api/state").get_json()["isVerified"])
        with clicker.db_connection() as db:
            db.execute("UPDATE users SET is_verified = 1 WHERE email = ?", ("tester@example.com",))
        state = self.client.get("/api/state").get_json()
        self.assertTrue(state["isVerified"])
        self.assertTrue(state["leaderboard"]["top"][0]["isVerified"])
        self.client.post("/api/register", json={"nickname": "Other", "email": "other@example.com", "password": "password", "isVerified": True, "is_verified": 1})
        self.client.post("/api/login", json={"email": "other@example.com", "password": "password"})
        state = self.client.get("/api/state").get_json()
        self.assertFalse(state["isVerified"])
        self.assertTrue(state["leaderboard"]["top"][0]["isVerified"])

    def test_levels_follow_lifetime_earnings_survive_spending_and_prestige(self):
        from amounts import db_amount
        from progression import REWARDS
        self.register_and_login()
        initial = self.client.get("/api/state").get_json()["progression"]
        self.assertEqual(initial["level"], 1)
        threshold = int(REWARDS[4]["requiredEarnedExact"])
        with clicker.db_connection() as db:
            db.execute("UPDATE users SET balance = ?, total_earned = ?", (db_amount(threshold), db_amount(threshold - 1)))
        result = self.client.post("/api/click").get_json()
        self.assertEqual(result["progression"]["level"], 100)
        self.assertEqual(result["progression"]["badge"]["id"], "technarch")
        self.assertEqual(result["progression"]["earnedInLevelExact"], "0")
        self.assertEqual(result["leaderboard"]["top"][0]["progression"]["level"], 100)
        bought = self.client.post("/api/cosmetics/ocean_theme/buy").get_json()
        self.assertEqual(bought["progression"], result["progression"])
        prestige = self.client.post("/api/prestige").get_json()
        self.assertEqual(prestige["userCount"], 0)
        self.assertEqual(prestige["progression"], result["progression"])
        self.client.post("/api/register", json={"nickname": "Viewer", "email": "viewer@example.com", "password": "password", "level": 200})
        viewer = self.client.post("/api/login", json={"email": "viewer@example.com", "password": "password"}).get_json()
        self.assertEqual(viewer["progression"]["level"], 1)
        for sort in ("balance", "total_earned", "prestige_points"):
            ranking = self.client.get("/api/leaderboard", headers={"X-Leaderboard-Sort": sort}).get_json()
            veteran = next(player for player in ranking["top"] if player["nickname"] == "Tester")
            self.assertEqual(veteran["progression"]["badge"]["id"], "technarch")

    def test_purchase_requires_login_and_funds(self):
        self.assertEqual(self.client.post("/api/robots/robot1/upgrade").status_code, 401)
        self.register_and_login()
        self.assertEqual(self.client.post("/api/robots/robot1/upgrade").status_code, 400)
        self.set_balance(clicker.ROBOTS["robot1"]["buyCost"])
        response = self.client.post("/api/robots/robot1/upgrade")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["robots"]["robot1"]["level"], 1)

    def test_prestige_resets_progress_and_awards_points(self):
        self.register_and_login()
        self.set_balance(clicker.PRESTIGE_MIN_BALANCE)
        response = self.client.post("/api/prestige")
        self.assertEqual(response.status_code, 200)
        state = response.get_json()
        self.assertEqual(state["userCount"], 0)
        self.assertEqual(state["prestigePoints"], 1)
        self.assertEqual(state["baseClickForce"], 1)

    def test_leaderboard_has_podium_and_players_around_current_user(self):
        self.register_and_login()
        with clicker.db_connection() as db:
            for index, score in enumerate((900, 800, 700, 600, 500, 400, 300), start=1):
                db.execute(
                    "INSERT INTO users (nickname, email, password_hash, last_income_at, balance, total_earned, prestige_points) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (f"Player {index}", f"player{index}@example.com", "hash", 0, 1_000 - score, score, index),
                )

        response = self.client.get("/api/state")
        self.assertEqual(response.status_code, 200)
        leaderboard = response.get_json()["leaderboard"]
        self.assertEqual([player["nickname"] for player in leaderboard["top"]], ["Player 1", "Player 2", "Player 3"])
        self.assertEqual(leaderboard["currentRank"], 8)
        self.assertEqual([player["nickname"] for player in leaderboard["around"]], ["Player 5", "Player 6", "Player 7", "Tester"])
        self.assertTrue(leaderboard["around"][-1]["isCurrentUser"])

    def test_leaderboard_can_be_sorted_by_balance_or_prestige(self):
        self.register_and_login()
        with clicker.db_connection() as db:
            db.execute("UPDATE users SET balance = 50, total_earned = 500, prestige_points = 2 WHERE email = ?", ("tester@example.com",))
            db.execute(
                "INSERT INTO users (nickname, email, password_hash, last_income_at, balance, total_earned, prestige_points) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("Rival", "rival@example.com", "hash", 0, 100, 300, 5),
            )

        balance = self.client.get("/api/leaderboard", headers={"X-Leaderboard-Sort": "balance"}).get_json()
        prestige = self.client.get("/api/leaderboard", headers={"X-Leaderboard-Sort": "prestige_points"}).get_json()
        self.assertEqual(balance["sortBy"], "balance")
        self.assertEqual(balance["top"][0]["nickname"], "Rival")
        self.assertEqual(prestige["sortBy"], "prestige_points")
        self.assertEqual(prestige["top"][0]["nickname"], "Rival")


if __name__ == "__main__":
    unittest.main()
