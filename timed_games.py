"""Server-authoritative timed runs and time-accounted podium rewards."""

import time

from flask import jsonify, request, session


MODES = {
    60: {"name": "Спринт", "rewards": [3, 2, 1]},
    180: {"name": "Тактика", "rewards": [9, 6, 3]},
    300: {"name": "Марафон", "rewards": [15, 10, 5]},
}
UPGRADES = {
    "click": {"name": "Сила клика", "column": "click_level", "base": 15, "growth": 1.65, "max": 20},
    "robot": {"name": "Робот", "column": "robots", "base": 30, "growth": 1.65, "max": 20},
    "engine": {"name": "Ускорение роботов", "column": "engine_level", "base": 80, "growth": 2, "max": 8},
}
COUNTDOWN_MS = 3000


def now_ms():
    return int(time.time() * 1000)


def init_db(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS timed_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            duration INTEGER NOT NULL CHECK(duration IN (60, 180, 300)),
            started_at INTEGER NOT NULL,
            ends_at INTEGER NOT NULL,
            settled_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'finished')),
            balance INTEGER NOT NULL DEFAULT 0,
            score INTEGER NOT NULL DEFAULT 0,
            income_remainder INTEGER NOT NULL DEFAULT 0,
            click_level INTEGER NOT NULL DEFAULT 0,
            robots INTEGER NOT NULL DEFAULT 0,
            engine_level INTEGER NOT NULL DEFAULT 0,
            last_click_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS timed_one_active_run
            ON timed_runs(user_id) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS timed_due_runs ON timed_runs(status, ends_at);
        CREATE INDEX IF NOT EXISTS timed_user_history ON timed_runs(user_id, id DESC);
        CREATE TABLE IF NOT EXISTS timed_bests (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            duration INTEGER NOT NULL,
            run_id INTEGER NOT NULL REFERENCES timed_runs(id),
            score INTEGER NOT NULL,
            achieved_at INTEGER NOT NULL,
            PRIMARY KEY(user_id, duration)
        );
        CREATE INDEX IF NOT EXISTS timed_ranking
            ON timed_bests(duration, score DESC, achieved_at, run_id);
        CREATE TABLE IF NOT EXISTS timed_rewards (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            duration INTEGER NOT NULL,
            rate INTEGER NOT NULL DEFAULT 0,
            settled_at INTEGER NOT NULL,
            remainder INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(user_id, duration)
        );
        CREATE TABLE IF NOT EXISTS timed_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    if not any(row["name"] == "passive_earned" for row in db.execute("PRAGMA table_info(timed_runs)")):
        db.execute("ALTER TABLE timed_runs ADD COLUMN passive_earned INTEGER NOT NULL DEFAULT 0")
    if not db.execute("SELECT 1 FROM timed_settings WHERE key = 'balance_scoring_v1'").fetchone():
        # Preserve attempts and already-earned prizes when changing the scoring rule.
        timestamp = now_ms()
        synchronize(db, timestamp)
        db.execute("DELETE FROM timed_bests")
        db.execute("""INSERT INTO timed_bests(user_id, duration, run_id, score, achieved_at)
                      SELECT user_id, duration, id, balance, ends_at FROM (
                          SELECT *, ROW_NUMBER() OVER (
                              PARTITION BY user_id, duration ORDER BY balance DESC, ends_at, id
                          ) AS place FROM timed_runs WHERE status = 'finished'
                      ) WHERE place = 1""")
        for duration in MODES:
            update_rewards(db, duration, timestamp)
        db.execute("INSERT INTO timed_settings VALUES ('balance_scoring_v1', '1')")


def income_rate(run):
    return run["robots"] * (2 + run["engine_level"])


def upgrade_cost(run, item):
    return int(item["base"] * item["growth"] ** run[item["column"]])


def settle_run(db, run, timestamp):
    until = max(run["settled_at"], min(timestamp, run["ends_at"]))
    elapsed = max(0, until - run["settled_at"])
    earned, remainder = divmod(elapsed * income_rate(run) + run["income_remainder"], 1000)
    db.execute("""UPDATE timed_runs SET balance = balance + ?, score = score + ?,
                  passive_earned = passive_earned + ?, income_remainder = ?, settled_at = ? WHERE id = ?""",
               (earned, earned, earned, remainder, until, run["id"]))
    return db.execute("SELECT * FROM timed_runs WHERE id = ?", (run["id"],)).fetchone()


def settle_reward(db, reward, timestamp):
    elapsed = max(0, timestamp - reward["settled_at"])
    earned, remainder = divmod(elapsed * reward["rate"] + reward["remainder"], 1000)
    if earned:
        db.execute("UPDATE users SET balance = amount_add(balance, ?), total_earned = amount_add(total_earned, ?) WHERE id = ?",
                   (earned, earned, reward["user_id"]))
    db.execute("UPDATE timed_rewards SET settled_at = ?, remainder = ? WHERE user_id = ? AND duration = ?",
               (max(timestamp, reward["settled_at"]), remainder, reward["user_id"], reward["duration"]))


def podium(db, duration):
    return db.execute("""SELECT user_id FROM timed_bests WHERE duration = ?
                         ORDER BY score DESC, achieved_at, run_id LIMIT 3""", (duration,)).fetchall()


def update_rewards(db, duration, timestamp):
    # Settle the OLD rates exactly at the ranking change, including offline users.
    for reward in db.execute("SELECT * FROM timed_rewards WHERE duration = ? AND rate > 0", (duration,)).fetchall():
        settle_reward(db, reward, timestamp)
    db.execute("UPDATE timed_rewards SET rate = 0 WHERE duration = ?", (duration,))
    for index, player in enumerate(podium(db, duration)):
        db.execute("""INSERT INTO timed_rewards(user_id, duration, rate, settled_at) VALUES (?, ?, ?, ?)
                      ON CONFLICT(user_id, duration) DO UPDATE SET rate = excluded.rate, settled_at = excluded.settled_at""",
                   (player["user_id"], duration, MODES[duration]["rewards"][index], timestamp))


def synchronize(db, timestamp, user_id=None):
    # Process overdue runs chronologically, so a closed tab cannot delay a prize
    # or earn the old leader extra income. The caller holds a write transaction.
    due = db.execute("SELECT * FROM timed_runs WHERE status = 'active' AND ends_at <= ? ORDER BY ends_at, id",
                     (timestamp,)).fetchall()
    for run in due:
        run = settle_run(db, run, run["ends_at"])
        db.execute("UPDATE timed_runs SET status = 'finished' WHERE id = ?", (run["id"],))
        changed = db.execute("""INSERT INTO timed_bests(user_id, duration, run_id, score, achieved_at)
                                VALUES (?, ?, ?, ?, ?)
                                ON CONFLICT(user_id, duration) DO UPDATE SET
                                    run_id = excluded.run_id, score = excluded.score, achieved_at = excluded.achieved_at
                                WHERE excluded.score > timed_bests.score""",
                             (run["user_id"], run["duration"], run["id"], run["balance"], run["ends_at"])).rowcount
        if changed:
            update_rewards(db, run["duration"], run["ends_at"])
    if user_id is not None:
        for reward in db.execute("SELECT * FROM timed_rewards WHERE user_id = ?", (user_id,)).fetchall():
            settle_reward(db, reward, timestamp)


def reward_rate(db, user_id):
    return db.execute("SELECT COALESCE(SUM(rate), 0) FROM timed_rewards WHERE user_id = ?", (user_id,)).fetchone()[0]


def serialize_run(run, timestamp):
    return {
        "id": run["id"], "duration": run["duration"], "status": run["status"],
        "remainingMs": min(run["duration"] * 1000, max(0, run["ends_at"] - timestamp)), "endsAt": run["ends_at"],
        "startsAt": run["started_at"], "startsInMs": max(0, run["started_at"] - timestamp),
        "balance": run["balance"], "score": run["balance"], "passiveEarned": run["passive_earned"],
        "clickPower": 1 + run["click_level"], "incomeRate": income_rate(run),
        "upgrades": {key: {"name": item["name"], "level": run[item["column"]],
                            "maxLevel": item["max"], "cost": upgrade_cost(run, item)}
                     for key, item in UPGRADES.items()},
    }


def build_state(db, user_id):
    timestamp = now_ms()
    # Also handles a deadline crossed while building the main game's response.
    synchronize(db, timestamp, user_id)
    active = db.execute("SELECT * FROM timed_runs WHERE user_id = ? AND status = 'active'", (user_id,)).fetchone()
    if active:
        active = settle_run(db, active, timestamp)
    modes = []
    for duration, mode in MODES.items():
        rows = db.execute("""SELECT b.*, u.nickname,
                             ROW_NUMBER() OVER (ORDER BY b.score DESC, b.achieved_at, b.run_id) AS rank
                             FROM timed_bests b JOIN users u ON u.id = b.user_id
                             WHERE b.duration = ? ORDER BY rank""", (duration,)).fetchall()
        current = next((row for row in rows if row["user_id"] == user_id), None)
        def player(row):
            return {"rank": row["rank"], "nickname": row["nickname"], "score": row["score"],
                    "isCurrentUser": row["user_id"] == user_id}
        modes.append({"duration": duration, "name": mode["name"], "rewards": mode["rewards"],
                      "top": [player(row) for row in rows[:3]], "totalPlayers": len(rows),
                      "around": [player(row) for row in rows if current and abs(row["rank"] - current["rank"]) <= 1],
                      "current": player(current) if current else None})
    history = db.execute("SELECT * FROM timed_runs WHERE user_id = ? AND status = 'finished' ORDER BY ends_at DESC, id DESC LIMIT 10",
                         (user_id,)).fetchall()
    return {"serverNow": timestamp, "active": serialize_run(active, timestamp) if active else None,
            "modes": modes, "rewardRate": reward_rate(db, user_id),
            "history": [serialize_run(run, timestamp) for run in history]}


def register_routes(app, db_connection, require_user, main_state):
    @app.post("/api/timed/start")
    @require_user
    def timed_start():
        payload = request.get_json(silent=True)
        duration = payload.get("duration") if isinstance(payload, dict) else None
        if type(duration) is not int or duration not in MODES:
            return jsonify({"error": "Выберите 1, 3 или 5 минут"}), 400
        with db_connection() as db:
            user_id = session["user_id"]
            if db.execute("SELECT 1 FROM timed_runs WHERE user_id = ? AND status = 'active'", (user_id,)).fetchone():
                return jsonify({"error": "Сначала дождитесь окончания текущей игры"}), 409
            timestamp = now_ms() + COUNTDOWN_MS
            db.execute("INSERT INTO timed_runs(user_id, duration, started_at, ends_at, settled_at) VALUES (?, ?, ?, ?, ?)",
                       (user_id, duration, timestamp, timestamp + duration * 1000, timestamp))
            return jsonify(main_state(db, user_id))

    @app.post("/api/timed/<int:run_id>/action")
    @require_user
    def timed_action(run_id):
        payload = request.get_json(silent=True)
        action = payload.get("action") if isinstance(payload, dict) else None
        if not isinstance(action, str) or action not in ("click", "upgrade"):
            return jsonify({"error": "Неизвестное действие"}), 400
        upgrade = payload.get("upgrade")
        if action == "upgrade" and (not isinstance(upgrade, str) or upgrade not in UPGRADES):
            return jsonify({"error": "Неизвестное улучшение"}), 400
        with db_connection() as db:
            user_id = session["user_id"]
            run = db.execute("SELECT * FROM timed_runs WHERE id = ? AND user_id = ?", (run_id, user_id)).fetchone()
            if run is None:
                return jsonify({"error": "Игра не найдена"}), 404
            timestamp = now_ms()
            synchronize(db, timestamp, user_id)
            run = db.execute("SELECT * FROM timed_runs WHERE id = ?", (run_id,)).fetchone()
            if run["status"] == "finished" or timestamp < run["started_at"]:
                return jsonify(main_state(db, user_id))
            run = settle_run(db, run, timestamp)
            if action == "click":
                # One click per 100 ms, with no client-supplied score or batch size.
                if timestamp - run["last_click_at"] >= 100:
                    power = run["click_level"] + 1
                    db.execute("UPDATE timed_runs SET balance = balance + ?, score = score + ?, last_click_at = ? WHERE id = ?",
                               (power, power, timestamp, run_id))
            else:
                item = UPGRADES[upgrade]
                cost = upgrade_cost(run, item)
                if run[item["column"]] >= item["max"]:
                    return jsonify({"error": "Достигнут максимальный уровень"}), 400
                if run["balance"] < cost:
                    return jsonify({"error": "Не хватает монет мини-игры"}), 400
                db.execute(f"UPDATE timed_runs SET balance = balance - ?, {item['column']} = {item['column']} + 1 WHERE id = ?",
                           (cost, run_id))
            return jsonify(main_state(db, user_id))
