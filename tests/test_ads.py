"""Reward claims are server-timed, scoped to the user and paid only once."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as clicker


class AdTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = patch.object(clicker, "DATABASE_PATH", Path(self.temporary.name) / "ads.db")
        self.database.start()
        clicker.init_db()
        self.client = clicker.app.test_client()
        self.client.post("/api/register", json={"nickname": "Ads", "email": "ads@test.com", "password": "test"})
        self.client.post("/api/login", json={"email": "ads@test.com", "password": "test"})

    def tearDown(self):
        self.database.stop()
        self.temporary.cleanup()

    def start(self, placement="balance", **extra):
        response = self.client.post("/api/ads/start", json={"placement": placement, **extra})
        self.assertEqual(response.status_code, 200)
        return response.get_json()["token"]

    def mature(self, token, age=5):
        with clicker.db_connection() as db:
            db.execute("UPDATE ad_rewards SET started_at = started_at - ? WHERE token = ?", (age, token))

    def claim(self, token):
        return self.client.post("/api/ads/claim", json={"token": token})

    def test_timer_cancellation_retry_and_cooldown(self):
        token = self.start()
        self.assertEqual(self.client.get("/api/state").get_json()["userCount"], 0)
        self.assertEqual(self.claim(token).status_code, 409)
        # Reopening an abandoned view invalidates its old token.
        replacement = self.start()
        self.assertEqual(self.claim(token).status_code, 404)
        self.mature(replacement)
        state = self.claim(replacement).get_json()
        self.assertEqual(state["userCount"], 100)
        self.assertFalse(state["adOffers"]["balance"]["available"])
        self.assertEqual(self.claim(replacement).get_json()["userCount"], 100)
        self.assertEqual(self.client.post("/api/ads/start", json={"placement": "balance"}).status_code, 409)
        with clicker.db_connection() as db:
            db.execute("UPDATE ad_rewards SET claimed_at = claimed_at - 301")
        self.start()

    def test_auth_ownership_expiry_and_bad_inputs(self):
        anonymous = clicker.app.test_client()
        self.assertEqual(anonymous.post("/api/ads/start", json={"placement": "balance"}).status_code, 401)
        self.assertEqual(anonymous.post("/api/ads/claim", json={"token": "x"}).status_code, 401)
        for payload in ([], {}, {"placement": []}, {"placement": "unknown"}):
            self.assertEqual(self.client.post("/api/ads/start", json=payload).status_code, 400)
        for payload in ([], {}, {"token": []}):
            self.assertEqual(self.client.post("/api/ads/claim", json=payload).status_code, 400)
        token = self.start()
        other = clicker.app.test_client()
        other.post("/api/register", json={"nickname": "Other", "email": "other@test.com", "password": "test"})
        other.post("/api/login", json={"email": "other@test.com", "password": "test"})
        self.assertEqual(other.post("/api/ads/claim", json={"token": token}).status_code, 404)
        self.mature(token, 301)
        self.assertEqual(self.claim(token).status_code, 409)

    def test_boost_extends_existing_time_once(self):
        with clicker.db_connection() as db:
            db.execute("UPDATE user_boosts SET active_until = ? WHERE boost_id = 'income_x2'", (int(clicker.time.time()) + 300,))
        token = self.start("boost")
        self.mature(token)
        state = self.claim(token).get_json()
        self.assertGreaterEqual(state["boosts"]["income_x2"], 358)
        self.assertLessEqual(self.claim(token).get_json()["boosts"]["income_x2"], 360)

    def test_result_reward_preserves_competition(self):
        state = self.client.post("/api/timed/start", json={"duration": 60}).get_json()
        run_id = state["timedGames"]["active"]["id"]
        self.assertEqual(self.client.post("/api/ads/start", json={"placement": "balance"}).status_code, 409)
        with clicker.db_connection() as db:
            db.execute("UPDATE timed_runs SET balance = 42, ends_at = 1, settled_at = 1 WHERE id = ?", (run_id,))
        state = self.client.get("/api/state").get_json()
        self.assertEqual(state["adOffers"]["result"]["amount"], "42")
        self.assertEqual(self.client.post("/api/ads/start", json={"placement": "result", "runId": run_id + 1}).status_code, 409)
        token = self.start("result", runId=run_id)
        self.mature(token)
        self.assertEqual(self.claim(token).status_code, 200)
        with clicker.db_connection() as db:
            self.assertEqual(db.execute("SELECT score FROM timed_bests WHERE run_id = ?", (run_id,)).fetchone()[0], 42)
            self.assertEqual(db.execute("SELECT balance FROM timed_runs WHERE id = ?", (run_id,)).fetchone()[0], 42)
        self.assertEqual(self.client.post("/api/ads/start", json={"placement": "result", "runId": run_id}).status_code, 409)

    def test_large_reward_preserves_integer_precision(self):
        amount = 10**25 + 123
        with patch.object(clicker, "get_click_power", return_value=amount):
            token = self.start()
        self.mature(token)
        state = self.claim(token).get_json()
        self.assertEqual(state["userCountExact"], str(amount * 30))


if __name__ == "__main__":
    unittest.main()
