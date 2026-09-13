"""Timed economy regression tests use a controlled clock and an isolated database."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as clicker
import timed_games as timed


class TimedGamesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_path = clicker.DATABASE_PATH
        clicker.DATABASE_PATH = Path(self.temp.name) / "timed.db"
        clicker.init_db()
        clicker.app.config.update(TESTING=True)
        self.clock = 1_000_000
        self.clock_patch = patch.object(timed, "now_ms", side_effect=lambda: self.clock)
        self.clock_patch.start()
        self.client = self.player("Player")

    def tearDown(self):
        self.clock_patch.stop()
        clicker.DATABASE_PATH = self.original_path
        self.temp.cleanup()

    def player(self, nickname):
        with clicker.db_connection() as db:
            cursor = db.execute("INSERT INTO users(nickname, email, password_hash, last_income_at) VALUES (?, ?, 'unused', 0)",
                                (nickname, f"{nickname}@example.com"))
            user_id = cursor.lastrowid
        client = clicker.app.test_client()
        with client.session_transaction() as session:
            session["user_id"] = user_id
        return client

    def start(self, duration=60, client=None):
        response = (client or self.client).post("/api/timed/start", json={"duration": duration})
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["timedGames"]["active"]

    def state(self, client=None):
        response = (client or self.client).get("/api/state")
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def action(self, run, action="click", client=None, **payload):
        return (client or self.client).post(f"/api/timed/{run['id']}/action", json={"action": action, **payload})

    def seed_run(self, run, **values):
        with clicker.db_connection() as db:
            for key, value in values.items():
                db.execute(f"UPDATE timed_runs SET {key} = ? WHERE id = ?", (value, run["id"]))

    def finish(self, run, score, client=None):
        self.seed_run(run, score=score, balance=score)
        self.clock = run["endsAt"]
        return self.state(client)["timedGames"]

    def test_start_requires_login_and_valid_duration(self):
        anonymous = clicker.app.test_client()
        self.assertEqual(anonymous.post("/api/timed/start", json={"duration": 60}).status_code, 401)
        for payload in ({}, [], {"duration": []}, {"duration": "60"}, {"duration": 61}, {"duration": True}, {"duration": 60.0}):
            self.assertEqual(self.client.post("/api/timed/start", json=payload).status_code, 400)

    def test_all_modes_start_from_zero_and_allow_replay(self):
        with clicker.db_connection() as db:
            db.execute("UPDATE users SET balance = 1000000, click_force = 100, prestige_points = 50")
        for duration in timed.MODES:
            run = self.start(duration)
            self.assertEqual((run["balance"], run["score"], run["clickPower"], run["incomeRate"]), (0, 0, 1, 0))
            self.assertEqual(run["remainingMs"], duration * 1000)
            self.clock = run["endsAt"]
            self.assertIsNone(self.state()["timedGames"]["active"])
        self.assertEqual(len(self.state()["timedGames"]["history"]), 3)
        self.assertEqual(self.start()["score"], 0)

    def test_only_one_active_game_and_refresh_preserves_it(self):
        run = self.start()
        self.assertEqual(self.client.post("/api/timed/start", json={"duration": 180}).status_code, 409)
        self.clock += 10_000
        restored = self.state()["timedGames"]["active"]
        self.assertEqual(restored["id"], run["id"])
        self.assertEqual(restored["remainingMs"], 53_000)
        self.assertFalse(self.state()["timedGames"]["modes"][0]["top"])

    def test_clicks_are_server_computed_and_rate_limited(self):
        run = self.start()
        self.clock = run["startsAt"]
        first = self.action(run, score=1_000_000, count=9999).get_json()
        self.assertEqual(first["timedGames"]["active"]["score"], 1)
        self.assertEqual(first["userCount"], 0)
        second = self.action(run).get_json()["timedGames"]["active"]
        self.assertEqual(second["score"], 1)
        self.clock += 100
        self.assertEqual(self.action(run).get_json()["timedGames"]["active"]["score"], 2)

    def test_upgrades_reduce_the_result_and_spend_only_run_balance(self):
        run = self.start()
        self.clock = run["startsAt"]
        self.assertEqual(self.action(run, "upgrade", upgrade="click").status_code, 400)
        for _ in range(15):
            self.action(run)
            self.clock += 100
        upgraded = self.action(run, "upgrade", upgrade="click").get_json()["timedGames"]["active"]
        self.assertEqual((upgraded["balance"], upgraded["score"], upgraded["clickPower"]), (0, 0, 2))
        self.assertEqual(self.action(run).get_json()["timedGames"]["active"]["score"], 2)

    def test_robots_and_engine_settle_at_previous_rate_and_keep_fractions(self):
        run = self.start()
        self.clock = run["startsAt"]
        self.seed_run(run, balance=110, score=110)
        self.action(run, "upgrade", upgrade="robot")
        self.clock += 250
        self.assertEqual(self.state()["timedGames"]["active"]["score"], 80)
        self.clock += 250
        self.assertEqual(self.state()["timedGames"]["active"]["score"], 81)
        self.action(run, "upgrade", upgrade="engine")
        self.clock += 1000
        active = self.state()["timedGames"]["active"]
        self.assertEqual((active["score"], active["incomeRate"], active["balance"]), (4, 3, 4))
        self.assertEqual(active["passiveEarned"], 4)

    def test_deadline_blocks_late_actions_and_offline_income_stops_at_finish(self):
        run = self.start()
        self.seed_run(run, robots=1)
        self.clock = run["endsAt"] + 20_000
        state = self.action(run).get_json()
        self.assertIsNone(state["timedGames"]["active"])
        self.assertEqual(state["timedGames"]["history"][0]["score"], 120)
        self.assertEqual(state["userCount"], 60)  # 20 seconds in first place, at 3/sec.
        self.assertEqual(self.action(run).get_json()["userCount"], 60)
        self.assertEqual(len(self.state()["timedGames"]["history"]), 1)

    def test_actions_cannot_access_another_player_or_malformed_upgrade(self):
        run = self.start()
        self.clock = run["startsAt"]
        stranger = self.player("Stranger")
        self.assertEqual(self.action(run, client=stranger).status_code, 404)
        self.assertEqual(self.action(run, "upgrade", upgrade=[]).status_code, 400)
        self.assertEqual(self.action(run, "upgrade", upgrade="missing").status_code, 400)
        self.assertEqual(self.action(run, action=[]).status_code, 400)
        self.seed_run(run, click_level=20, balance=1_000_000)
        self.assertEqual(self.action(run, "upgrade", upgrade="click").status_code, 400)

    def test_best_result_per_player_ties_and_separate_rankings(self):
        first = self.start()
        self.finish(first, 100)
        rival = self.player("Rival")
        tied = self.start(client=rival)
        self.finish(tied, 100, rival)
        worse = self.start()
        result = self.finish(worse, 50)
        ranking = result["modes"][0]
        self.assertEqual(ranking["current"]["score"], 100)
        self.assertEqual(ranking["current"]["rank"], 1)
        self.assertEqual(ranking["totalPlayers"], 2)
        self.assertEqual(result["modes"][1]["top"], [])
        better = self.start(client=rival)
        self.finish(better, 101, rival)
        self.assertEqual(self.state()["timedGames"]["modes"][0]["current"]["rank"], 2)

    def test_prizes_change_at_finish_and_stop_after_leaving_top_three(self):
        self.finish(self.start(), 10)
        initial_time = self.clock
        rivals = [self.player(f"Rival{n}") for n in range(3)]
        runs = [self.start(client=rival) for rival in rivals]
        for index, run in enumerate(runs):
            self.seed_run(run, score=20 + index, balance=20 + index)
        # No requests for a minute after rivals finish; synchronize all deadlines.
        self.clock += 120_000
        state = self.state()
        self.assertEqual(self.clock - initial_time, 120_000)
        self.assertEqual(state["userCount"], 189)  # 3-second countdown + 60 seconds until rivals finish.
        self.assertEqual(state["timedRewardIncome"], 0)
        self.assertEqual(state["timedGames"]["modes"][0]["current"]["rank"], 4)
        self.assertEqual(self.state(rivals[2])["userCount"], 171)
        self.clock += 10_000
        self.assertEqual(self.state()["userCount"], 189)
        self.assertEqual(self.state(rivals[2])["userCount"], 201)

    def test_countdown_is_server_enforced_and_does_not_shorten_the_run(self):
        run = self.start()
        self.assertEqual(run["startsInMs"], 3000)
        self.assertEqual(run["endsAt"] - run["startsAt"], 60_000)
        for delay in (0, 1000, 2999):
            self.clock = run["startsAt"] - 3000 + delay
            active = self.action(run).get_json()["timedGames"]["active"]
            self.assertEqual(active["balance"], 0)
            self.assertEqual(active["remainingMs"], 60_000)
        self.clock = run["startsAt"]
        active = self.action(run).get_json()["timedGames"]["active"]
        self.assertEqual(active["balance"], 1)
        self.assertEqual(active["startsInMs"], 0)

    def test_no_purchase_or_passive_income_before_start(self):
        run = self.start()
        self.seed_run(run, balance=100, robots=1)
        self.clock = run["startsAt"] - 1
        active = self.action(run, "upgrade", upgrade="click").get_json()["timedGames"]["active"]
        self.assertEqual(active["clickPower"], 1)
        self.assertEqual(active["balance"], 100)
        self.clock = run["startsAt"] + 1000
        self.assertEqual(self.state()["timedGames"]["active"]["balance"], 102)

    def test_ranking_uses_final_balance_and_returns_podium_and_neighbors(self):
        own = self.start()
        self.finish(own, 50)
        for index, balance in enumerate((100, 90, 80, 60, 40, 30)):
            rival = self.player(f"Neighbor{index}")
            run = self.start(client=rival)
            self.seed_run(run, balance=balance, score=10_000 - balance)
            self.clock = run["endsAt"]
            self.state(rival)
        mode = self.state()["timedGames"]["modes"][0]
        self.assertEqual([p["score"] for p in mode["top"]], [100, 90, 80])
        self.assertEqual([p["rank"] for p in mode["around"]], [4, 5, 6])
        self.assertTrue(mode["around"][1]["isCurrentUser"])

    def test_old_records_are_rebuilt_from_balance_without_erasing_attempts(self):
        first = self.start()
        self.finish(first, 100)
        second = self.start()
        self.seed_run(second, balance=50, score=1000)
        self.clock = second["endsAt"]
        self.state()
        with clicker.db_connection() as db:
            db.execute("UPDATE timed_bests SET run_id = ?, score = 1000", (second["id"],))
            db.execute("DELETE FROM timed_settings WHERE key = 'balance_scoring_v1'")
        baseline = self.state()["userCount"]
        clicker.init_db()
        state = self.state()
        self.assertEqual(state["timedGames"]["modes"][0]["current"]["score"], 100)
        self.assertEqual(len(state["timedGames"]["history"]), 2)
        self.assertEqual(state["userCount"], baseline)

    def test_offline_rewards_sum_across_modes_without_double_credit(self):
        for duration in timed.MODES:
            self.finish(self.start(duration), 1)
        state = self.state()
        baseline = state["userCount"]
        self.assertEqual(state["timedRewardIncome"], 27)
        self.clock += 10_000
        self.assertEqual(self.state()["userCount"], baseline + 270)
        self.assertEqual(self.state()["userCount"], baseline + 270)
        with clicker.db_connection() as db:
            user = db.execute("SELECT * FROM users WHERE id = 1").fetchone()
            self.assertEqual(user["balance"], user["total_earned"])

    def test_small_reward_intervals_retain_fractional_credit(self):
        self.finish(self.start(), 1)
        for _ in range(10):
            self.clock += 100
            state = self.state()
        self.assertEqual(state["userCount"], 3)

    def test_migration_is_repeatable_and_keeps_runs(self):
        run = self.start()
        clicker.init_db()
        clicker.init_db()
        self.assertEqual(self.state()["timedGames"]["active"]["id"], run["id"])


if __name__ == "__main__":
    unittest.main()
