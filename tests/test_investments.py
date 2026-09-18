"""Exact large balances, investment contracts and compatibility with saved games."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as clicker
from amounts import SUFFIXES, db_amount, parse_amount


class InvestmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_path = clicker.DATABASE_PATH
        clicker.DATABASE_PATH = Path(self.temp.name) / "investments.db"
        clicker.init_db()
        clicker.app.config.update(TESTING=True)
        self.clock = 1_800_000_000
        self.time_patch = patch.object(clicker.time, "time", side_effect=lambda: self.clock)
        self.time_patch.start()
        with clicker.db_connection() as db:
            self.user_id = db.execute("INSERT INTO users(nickname, email, password_hash, last_income_at) VALUES ('Investor', 'investor@test', 'unused', ?)", (self.clock,)).lastrowid
        self.client = clicker.app.test_client()
        with self.client.session_transaction() as session:
            session["user_id"] = self.user_id

    def tearDown(self):
        self.time_patch.stop()
        clicker.DATABASE_PATH = self.original_path
        self.temp.cleanup()

    def fund(self, amount):
        with clicker.db_connection() as db:
            db.execute("UPDATE users SET balance = ? WHERE id = ?", (db_amount(amount), self.user_id))

    def create(self, amount, plan="guaranteed"):
        response = self.client.post("/api/investments/create", json={"amount": amount, "plan": plan})
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def collect(self):
        response = self.client.post("/api/investments/collect")
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def test_suffixes_decimal_comma_spaces_and_case(self):
        for suffix, multiplier in SUFFIXES.items():
            self.assertEqual(parse_amount(f"2 {suffix.upper()}"), 2 * multiplier)
        self.assertEqual(parse_amount("1,25 Qi"), 1_250_000_000_000_000_000)
        self.assertEqual(parse_amount("1 000\u00a0M"), 10 ** 9)
        self.assertEqual(parse_amount(".5B"), 500_000_000)
        self.assertEqual(parse_amount(1e21), 10 ** 21)

    def test_big_deposit_and_payout_are_exact_and_collect_only_once(self):
        initial = 20 * 10 ** 18 + 7
        amount = 12 * 10 ** 18 + 1
        self.fund(initial)
        state = self.create("12.000000000000000001 Qi")
        self.assertEqual(state["userCountExact"], str(initial - amount))
        investment = state["investments"][0]
        self.assertEqual(investment["amount"], str(amount))
        self.assertEqual(investment["payout_amount"], str(amount * 120 // 100))
        self.assertEqual(self.collect()["investmentResult"]["won"], 0)
        self.clock += 30
        with patch.object(clicker.random, "random", side_effect=AssertionError("Guaranteed investment must not roll")):
            paid = self.collect()
        final = initial - amount + amount * 120 // 100
        self.assertEqual(paid["userCountExact"], str(final))
        self.assertEqual(paid["investmentResult"]["won"], 1)
        self.assertEqual(self.collect()["userCountExact"], str(final))
        self.assertEqual(self.collect()["investmentPayout"], "0")
        with clicker.db_connection() as db:
            user = clicker.get_user(db, self.user_id)
            self.assertEqual(user["total_spent"], amount)
            self.assertEqual(user["total_earned"], amount * 120 // 100)

    def test_dc_amount_and_subsequent_small_credit_remain_exact(self):
        initial = 10 ** 33 + 1
        self.fund(initial)
        state = self.create("1 Dc", "jackpot")
        self.assertEqual(state["userCountExact"], "1")
        self.clock += 30
        with patch.object(clicker.random, "random", return_value=0):
            state = self.collect()
        self.assertEqual(state["userCountExact"], str(6 * 10 ** 33 + 1))
        with clicker.db_connection() as db:
            clicker.add_balance(db, self.user_id, 1)
            self.assertEqual(clicker.get_user(db, self.user_id)["balance"], 6 * 10 ** 33 + 2)

    def test_exact_all_balance_string(self):
        amount = 50 * 10 ** 18 + 1
        self.fund(amount)
        exact = self.client.get("/api/state").get_json()["userCountExact"]
        self.assertEqual(self.create(exact)["userCountExact"], "0")

    def test_all_plans_have_server_controlled_chances_and_payouts(self):
        chances = []
        profits = []
        for plan_id, plan in clicker.INVESTMENT_PLANS.items():
            self.fund(100)
            state = self.create("100", plan_id)
            investment = state["investments"][0]
            self.assertEqual(investment["success_chance"], plan["successChance"])
            self.assertEqual(investment["payout_amount"], str(100 + plan["profitPercent"]))
            chances.append(plan["successChance"])
            profits.append(plan["profitPercent"])
            self.clock += 30
            with patch.object(clicker.random, "random", return_value=plan["successChance"] / 100 - 0.00001):
                self.assertEqual(self.collect()["investmentResult"]["won"], 1)
            if plan["successChance"] < 100:
                self.fund(100)
                self.create("100", plan_id)
                self.clock += 30
                with patch.object(clicker.random, "random", return_value=plan["successChance"] / 100):
                    lost = self.collect()
                self.assertEqual(lost["userCountExact"], "0")
                self.assertEqual(lost["investmentResult"]["lostAmount"], "100")
                self.assertEqual(lost["investmentResult"]["lost"], 1)
        self.assertEqual(chances, sorted(chances, reverse=True))
        self.assertEqual(profits, sorted(profits))

    def test_malformed_amounts_and_unknown_plans_do_not_spend(self):
        self.fund(20 * 10 ** 18)
        for value in (None, True, [], {}, "", "-1Qi", "NaN", "Infinity", "1QQ", "1.5", "1e999", "9" * 121, "1QiQi"):
            response = self.client.post("/api/investments/create", json={"amount": value, "plan": "guaranteed"})
            self.assertEqual(response.status_code, 400, value)
        for plan in ([], {}, None, "missing", "legacy_risky"):
            self.assertEqual(self.client.post("/api/investments/create", json={"amount": "1Qi", "plan": plan}).status_code, 400)
        self.assertEqual(self.client.post("/api/investments/create", json=[]).status_code, 400)
        self.assertEqual(self.client.get("/api/state").get_json()["userCountExact"], str(20 * 10 ** 18))

    def test_insufficient_funds_does_not_insert_a_contract(self):
        self.fund(10 ** 18)
        response = self.client.post("/api/investments/create", json={"amount": "2Qi"})
        self.assertEqual(response.status_code, 400)
        state = self.client.get("/api/state").get_json()
        self.assertEqual(state["investments"], [])
        self.assertEqual(state["userCountExact"], str(10 ** 18))

    def test_legacy_risky_contracts_keep_their_original_terms(self):
        with clicker.db_connection() as db:
            db.execute("INSERT INTO investments(user_id, amount, payout_amount, ready_at, risky) VALUES (?, 100, 200, ?, 1)", (self.user_id, self.clock))
        clicker.init_db()
        clicker.init_db()
        state = self.client.get("/api/state").get_json()
        self.assertEqual(state["investments"][0]["success_chance"], 50)
        with patch.object(clicker.random, "random", return_value=0.49):
            self.assertEqual(self.collect()["investmentPayout"], "200")

    def test_legacy_client_request_still_works(self):
        self.fund(100)
        response = self.client.post("/api/investments/create", json={"amount": 100, "risky": True})
        self.assertEqual(response.status_code, 200)
        contract = response.get_json()["investments"][0]
        self.assertEqual((contract["success_chance"], contract["payout_amount"]), (50, "200"))

    def test_leaderboard_compares_large_balances_exactly(self):
        self.fund(10 ** 30)
        with clicker.db_connection() as db:
            db.execute("INSERT INTO users(nickname, email, password_hash, last_income_at, balance) VALUES ('Rival', 'rival@test', 'unused', ?, ?)", (self.clock, db_amount(10 ** 30 + 1)))
        ranking = self.client.get("/api/leaderboard", headers={"X-Leaderboard-Sort": "balance"}).get_json()
        self.assertEqual(ranking["currentRank"], 2)
        self.assertEqual(ranking["top"][0]["score"], 10 ** 30 + 1)

    def test_timed_rewards_do_not_round_large_balances(self):
        self.fund(10 ** 30)
        with clicker.db_connection() as db:
            db.execute("INSERT INTO timed_rewards(user_id, duration, rate, settled_at) VALUES (?, 60, 3, ?)", (self.user_id, self.clock * 1000 - 1000))
        self.assertEqual(self.client.get("/api/state").get_json()["userCountExact"], str(10 ** 30 + 3))

    def test_prestige_handles_large_balance_and_points(self):
        self.fund(10 ** 33)
        response = self.client.post("/api/prestige")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["prestigePoints"], 10 ** 24)
        self.assertEqual(response.get_json()["userCountExact"], "0")

    def test_investments_require_authentication(self):
        anonymous = clicker.app.test_client()
        for route in ("create", "collect"):
            self.assertEqual(anonymous.post(f"/api/investments/{route}").status_code, 401)


if __name__ == "__main__":
    unittest.main()
