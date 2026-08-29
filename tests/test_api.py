"""Regression checks for the public HTTP interface and core economy rules."""

import tempfile
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


if __name__ == "__main__":
    unittest.main()
