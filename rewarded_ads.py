"""Rewarded-ad placeholder. Replace the demo timer with provider verification later."""

import secrets
import time

from flask import jsonify, request, session

from amounts import db_amount

WATCH_SECONDS = 5
COOLDOWNS = {"balance": 300, "boost": 600}


def init_db(db):
    db.execute("""CREATE TABLE IF NOT EXISTS ad_rewards (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        placement TEXT NOT NULL,
        reward_key TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        amount BLOB NOT NULL,
        started_at INTEGER NOT NULL,
        claimed_at INTEGER,
        PRIMARY KEY (user_id, reward_key)
    )""")


def offers(db, user_id, balance_reward):
    now = int(time.time())
    result = {}
    for placement, cooldown in COOLDOWNS.items():
        row = db.execute("SELECT claimed_at FROM ad_rewards WHERE user_id = ? AND reward_key = ?",
                         (user_id, placement)).fetchone()
        remaining = max(0, row["claimed_at"] + cooldown - now) if row and row["claimed_at"] is not None else 0
        result[placement] = {"available": remaining == 0, "remaining": remaining,
                             "amount": str(balance_reward if placement == "balance" else 60)}
    run = db.execute("SELECT id, balance FROM timed_runs WHERE user_id = ? AND status = 'finished' ORDER BY id DESC LIMIT 1",
                     (user_id,)).fetchone()
    if run:
        row = db.execute("SELECT claimed_at FROM ad_rewards WHERE user_id = ? AND reward_key = ?",
                         (user_id, f"result:{run['id']}")).fetchone()
        claimed = bool(row and row["claimed_at"] is not None)
        result["result"] = {"available": not claimed and run["balance"] > 0, "claimed": claimed,
                            "runId": run["id"], "amount": str(run["balance"])}
    return result


def register_routes(app, db_connection, require_user, build_state, add_balance, collect_income, reward_amount):
    @app.post("/api/ads/start")
    @require_user
    def start_ad():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or payload.get("placement") not in ("balance", "boost", "result"):
            return jsonify(error="Неизвестный рекламный бонус"), 400
        placement = payload["placement"]
        user_id = session["user_id"]
        with db_connection() as db:
            active = db.execute("SELECT 1 FROM timed_runs WHERE user_id = ? AND status = 'active'", (user_id,)).fetchone()
            if active:
                return jsonify(error="Сначала завершите мини-игру"), 409
            offer = offers(db, user_id, reward_amount(db, user_id)).get(placement)
            if not offer or not offer["available"]:
                return jsonify(error="Этот бонус пока недоступен"), 409
            if placement == "result" and payload.get("runId") != offer["runId"]:
                return jsonify(error="Результат изменился. Откройте последнюю завершённую игру"), 409
            key = f"result:{offer['runId']}" if placement == "result" else placement
            token = secrets.token_urlsafe(24)
            db.execute("""INSERT INTO ad_rewards VALUES (?, ?, ?, ?, ?, ?, NULL)
                          ON CONFLICT(user_id, reward_key) DO UPDATE SET
                          token = excluded.token, amount = excluded.amount,
                          started_at = excluded.started_at, claimed_at = NULL""",
                       (user_id, placement, key, token, db_amount(int(offer["amount"])), int(time.time())))
            return jsonify(token=token, waitSeconds=WATCH_SECONDS, amount=offer["amount"])

    @app.post("/api/ads/claim")
    @require_user
    def claim_ad():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or not isinstance(payload.get("token"), str):
            return jsonify(error="Откройте рекламный блок заново"), 400
        user_id = session["user_id"]
        with db_connection() as db:
            row = db.execute("SELECT * FROM ad_rewards WHERE user_id = ? AND token = ?",
                             (user_id, payload["token"])).fetchone()
            if not row:
                return jsonify(error="Откройте рекламный блок заново"), 404
            # A retry after a lost response must never pay twice.
            if row["claimed_at"] is not None:
                return jsonify(build_state(db, user_id))
            now = int(time.time())
            if now < row["started_at"] + WATCH_SECONDS:
                return jsonify(error="Дождитесь окончания просмотра"), 409
            if now > row["started_at"] + 300:
                return jsonify(error="Время просмотра истекло. Откройте блок заново"), 409
            income = collect_income(db, user_id)
            if row["placement"] == "boost":
                db.execute("""UPDATE user_boosts SET active_until = MAX(active_until, ?) + 60
                              WHERE user_id = ? AND boost_id = 'income_x2'""", (now, user_id))
            else:
                add_balance(db, user_id, int(row["amount"]))
            db.execute("UPDATE ad_rewards SET claimed_at = ? WHERE token = ?", (now, row["token"]))
            return jsonify(build_state(db, user_id, income))
