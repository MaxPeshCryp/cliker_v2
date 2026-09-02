import os
import random
import secrets
import sqlite3
import time
from contextlib import contextmanager
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
# Keep persistent data outside the Git working tree in production.  Locally the
# application remains backwards-compatible and uses clicker.db beside app.py.
DATABASE_PATH = Path(os.environ.get("CLICKER_DATABASE_PATH", BASE_DIR / "clicker.db"))
BASE_ROBOT_MAX_LEVEL = 5
ROBOTS = {
    "robot1": {
        "name": "Робот 1",
        "className": "Стартовый",
        "buyCost": 2_000,
        "upgradeCosts": [5_000, 12_000, 28_000, 65_000, 160_000, 420_000, 1_100_000],
        "powers": [10, 30, 75, 160, 350, 820, 1_900, 4_400],
        "requiresPrestige": 0,
    },
    "robot2": {
        "name": "Робот 2",
        "className": "Тяжелый",
        "buyCost": 10_000,
        "upgradeCosts": [25_000, 60_000, 140_000, 320_000, 800_000, 2_000_000, 5_000_000],
        "powers": [60, 180, 420, 950, 2_100, 4_800, 11_000, 26_000],
        "requiresPrestige": 0,
    },
    "robot3": {
        "name": "Робот 3",
        "className": "Промышленный",
        "buyCost": 50_000,
        "upgradeCosts": [120_000, 300_000, 700_000, 1_500_000, 3_800_000, 9_000_000, 22_000_000],
        "powers": [320, 900, 2_200, 5_200, 12_000, 28_000, 66_000, 150_000],
        "requiresPrestige": 0,
    },
    "gold_robot": {
        "name": "Золотой робот",
        "className": "Золотой класс",
        "buyCost": 1_000_000_000,
        "upgradeCosts": [2_500_000_000, 6_000_000_000, 14_000_000_000, 32_000_000_000, 75_000_000_000, 170_000_000_000, 400_000_000_000],
        "powers": [850_000, 2_500_000, 7_000_000, 18_000_000, 45_000_000, 110_000_000, 260_000_000, 620_000_000],
        "requiresPrestige": 1,
    },
    "quantum_robot": {
        "name": "Квантовый робот",
        "className": "Квантовый класс",
        "buyCost": 2_000_000_000_000,
        "upgradeCosts": [5_000_000_000_000, 13_000_000_000_000, 34_000_000_000_000, 90_000_000_000_000, 240_000_000_000_000, 650_000_000_000_000, 1_700_000_000_000_000],
        "powers": [1_800_000_000, 5_500_000_000, 16_000_000_000, 48_000_000_000, 135_000_000_000, 380_000_000_000, 1_050_000_000_000, 2_900_000_000_000],
        "requiresPrestige": 3,
    },
    "star_forge": {
        "name": "Звездная фабрика",
        "className": "Космический класс",
        "buyCost": 5_000_000_000_000_000,
        "upgradeCosts": [12_000_000_000_000_000, 30_000_000_000_000_000, 75_000_000_000_000_000, 180_000_000_000_000_000, 450_000_000_000_000_000, 1_100_000_000_000_000_000, 2_700_000_000_000_000_000],
        "powers": [5_000_000_000_000, 15_000_000_000_000, 45_000_000_000_000, 130_000_000_000_000, 380_000_000_000_000, 1_100_000_000_000_000, 3_200_000_000_000_000, 9_000_000_000_000_000],
        "requiresPrestige": 6,
    },
}
RESEARCH = {
    "robotics": {"name": "Робототехника", "baseCost": 2_000_000, "maxLevel": 20, "description": "+5% к роботам за уровень"},
    "click_engine": {"name": "Клик-двигатель", "baseCost": 1_000_000, "maxLevel": 20, "description": "+10% к клику за уровень"},
    "discounts": {"name": "Оптимизация цен", "baseCost": 4_000_000, "maxLevel": 15, "description": "-3% к ценам за уровень"},
    "maintenance": {"name": "Сервисный отдел", "baseCost": 6_000_000, "maxLevel": 10, "description": "-1% обслуживания за уровень"},
    "robot_limits": {"name": "Новые модули", "baseCost": 25_000_000, "maxLevel": 3, "description": "+1 максимум уровня роботов"},
}
BOOSTS = {
    "income_x2": {"name": "Турборежим", "cost": 2_000_000, "duration": 300, "description": "x2 доход роботов на 5 минут", "incomeMultiplier": 2},
    "click_x10": {"name": "Золотой палец", "cost": 1_000_000, "duration": 60, "description": "x10 сила клика на 60 секунд", "clickMultiplier": 10},
}
COSMETICS = {
    "gold_theme": {"name": "Золотая тема", "cost": 5_000_000, "description": "Золотая рамка интерфейса"},
    "neon_theme": {"name": "Неоновая тема", "cost": 50_000_000, "description": "Неоновый блеск табло"},
    "royal_theme": {"name": "Королевская тема", "cost": 500_000_000, "description": "Премиальный стиль счета"},
}
COLLECTIONS = {
    "bronze_trophy": {"name": "Бронзовый трофей", "cost": 10_000_000, "bonus": 0.005, "description": "+0.5% ко всему доходу"},
    "gold_trophy": {"name": "Золотой трофей", "cost": 250_000_000, "bonus": 0.02, "description": "+2% ко всему доходу"},
    "crown": {"name": "Корона магната", "cost": 5_000_000_000, "bonus": 0.05, "description": "+5% ко всему доходу"},
}
ACHIEVEMENTS = {
    "first_billion": {"name": "Первый миллиард", "description": "Накопить 1B", "bonus": 0.01},
    "robot_master": {"name": "Мастер роботов", "description": "Прокачать 3 роботов до максимума", "bonus": 0.02},
    "spender": {"name": "Большие траты", "description": "Потратить 1B", "bonus": 0.01},
    "prestige_first": {"name": "Новый цикл", "description": "Сделать престиж", "bonus": 0.03},
}
INVESTMENT_DURATION = 30
MAINTENANCE_BASE_RATE = 0.08
PRESTIGE_MIN_BALANCE = 1_000_000_000

app = Flask(__name__, static_folder=None)
# A deployment must provide CLICKER_SECRET_KEY.  The random development fallback
# is deliberately not persisted, so it cannot be guessed or reused after restart.
app.secret_key = os.environ.get("CLICKER_SECRET_KEY") or secrets.token_urlsafe(48)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("CLICKER_COOKIE_SECURE", "").lower() in {"1", "true", "yes"},
)


def get_db():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def db_connection():
    """Commit or roll back a request transaction, then always release SQLite."""
    connection = get_db()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def column_exists(db, table, column):
    rows = db.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


def add_column_if_missing(db, table, column, definition):
    if not column_exists(db, table, column):
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db():
    with db_connection() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nickname TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                balance INTEGER NOT NULL DEFAULT 0,
                click_force INTEGER NOT NULL DEFAULT 1,
                click_upgrade_cost INTEGER NOT NULL DEFAULT 100,
                last_income_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_robots (
                user_id INTEGER NOT NULL,
                robot_id TEXT NOT NULL,
                level INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, robot_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS user_research (
                user_id INTEGER NOT NULL,
                research_id TEXT NOT NULL,
                level INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, research_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS user_cosmetics (
                user_id INTEGER NOT NULL,
                cosmetic_id TEXT NOT NULL,
                unlocked INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, cosmetic_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS user_collections (
                user_id INTEGER NOT NULL,
                collection_id TEXT NOT NULL,
                unlocked INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, collection_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS user_boosts (
                user_id INTEGER NOT NULL,
                boost_id TEXT NOT NULL,
                active_until INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, boost_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS investments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount INTEGER NOT NULL,
                payout_amount INTEGER NOT NULL,
                ready_at INTEGER NOT NULL,
                risky INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active',
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS user_achievements (
                user_id INTEGER NOT NULL,
                achievement_id TEXT NOT NULL,
                unlocked_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, achievement_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """
        )
        add_column_if_missing(db, "users", "prestige_points", "INTEGER NOT NULL DEFAULT 0")
        add_column_if_missing(db, "users", "total_earned", "INTEGER NOT NULL DEFAULT 0")
        add_column_if_missing(db, "users", "total_spent", "INTEGER NOT NULL DEFAULT 0")
        add_column_if_missing(db, "users", "active_theme", "TEXT NOT NULL DEFAULT 'classic'")

def ensure_user_rows(db, user_id):
    for robot_id in ROBOTS:
        db.execute("INSERT OR IGNORE INTO user_robots (user_id, robot_id, level) VALUES (?, ?, 0)", (user_id, robot_id))
    for research_id in RESEARCH:
        db.execute("INSERT OR IGNORE INTO user_research (user_id, research_id, level) VALUES (?, ?, 0)", (user_id, research_id))
    for cosmetic_id in COSMETICS:
        db.execute("INSERT OR IGNORE INTO user_cosmetics (user_id, cosmetic_id, unlocked) VALUES (?, ?, 0)", (user_id, cosmetic_id))
    for collection_id in COLLECTIONS:
        db.execute("INSERT OR IGNORE INTO user_collections (user_id, collection_id, unlocked) VALUES (?, ?, 0)", (user_id, collection_id))
    for boost_id in BOOSTS:
        db.execute("INSERT OR IGNORE INTO user_boosts (user_id, boost_id, active_until) VALUES (?, ?, 0)", (user_id, boost_id))


def require_user(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Требуется вход"}), 401
        return handler(*args, **kwargs)
    return wrapped


def get_user(db, user_id):
    return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def get_levels(db, table, key_column, user_id):
    ensure_user_rows(db, user_id)
    rows = db.execute(f"SELECT {key_column}, level FROM {table} WHERE user_id = ?", (user_id,)).fetchall()
    return {row[key_column]: row["level"] for row in rows}


def get_robot_levels(db, user_id):
    return get_levels(db, "user_robots", "robot_id", user_id)


def get_research_levels(db, user_id):
    return get_levels(db, "user_research", "research_id", user_id)


def get_unlocked_ids(db, table, key_column, user_id):
    ensure_user_rows(db, user_id)
    rows = db.execute(f"SELECT {key_column}, unlocked FROM {table} WHERE user_id = ?", (user_id,)).fetchall()
    return {row[key_column]: bool(row["unlocked"]) for row in rows}


def get_boosts(db, user_id):
    now = int(time.time())
    rows = db.execute("SELECT boost_id, active_until FROM user_boosts WHERE user_id = ?", (user_id,)).fetchall()
    return {row["boost_id"]: max(0, row["active_until"] - now) for row in rows}


def prestige_multiplier(user):
    return 1 + user["prestige_points"] * 0.01


def achievement_bonus(db, user_id):
    count = db.execute("SELECT COUNT(*) AS c FROM user_achievements WHERE user_id = ?", (user_id,)).fetchone()["c"]
    bonus = 0
    for achievement_id in ACHIEVEMENTS:
        unlocked = db.execute(
            "SELECT 1 FROM user_achievements WHERE user_id = ? AND achievement_id = ?",
            (user_id, achievement_id),
        ).fetchone()
        if unlocked:
            bonus += ACHIEVEMENTS[achievement_id]["bonus"]
    return bonus


def collection_bonus(db, user_id):
    unlocked = get_unlocked_ids(db, "user_collections", "collection_id", user_id)
    return sum(COLLECTIONS[item_id]["bonus"] for item_id, has_item in unlocked.items() if has_item)


def robot_max_level(research):
    return BASE_ROBOT_MAX_LEVEL + research.get("robot_limits", 0)


def discount_multiplier(research):
    return max(0.45, 1 - research.get("discounts", 0) * 0.03)


def apply_discount(cost, research):
    return max(1, int(cost * discount_multiplier(research)))


def spend_balance(db, user_id, amount):
    user = get_user(db, user_id)
    if user["balance"] < amount:
        return False
    db.execute("UPDATE users SET balance = balance - ?, total_spent = total_spent + ? WHERE id = ?", (amount, amount, user_id))
    return True


def add_balance(db, user_id, amount):
    if amount <= 0:
        return
    db.execute("UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?", (amount, amount, user_id))


def get_base_income_per_second(db, user_id):
    user = get_user(db, user_id)
    research = get_research_levels(db, user_id)
    levels = get_robot_levels(db, user_id)
    max_level = robot_max_level(research)
    income = 0
    for robot_id, level in levels.items():
        if level > 0:
            level = min(level, max_level, len(ROBOTS[robot_id]["powers"]))
            income += ROBOTS[robot_id]["powers"][level - 1]
    income *= 1 + research.get("robotics", 0) * 0.05
    income *= prestige_multiplier(user)
    income *= 1 + collection_bonus(db, user_id) + achievement_bonus(db, user_id)
    active_boosts = get_boosts(db, user_id)
    if active_boosts.get("income_x2", 0) > 0:
        income *= BOOSTS["income_x2"]["incomeMultiplier"]
    return int(income)


def get_maintenance_cost(db, user_id, gross_income):
    research = get_research_levels(db, user_id)
    rate = max(0, MAINTENANCE_BASE_RATE - research.get("maintenance", 0) * 0.01)
    return int(gross_income * rate)


def get_net_income_per_second(db, user_id):
    gross = get_base_income_per_second(db, user_id)
    maintenance = get_maintenance_cost(db, user_id, gross)
    return max(0, gross - maintenance)


def get_click_power(db, user_id):
    user = get_user(db, user_id)
    research = get_research_levels(db, user_id)
    power = user["click_force"] * (1 + research.get("click_engine", 0) * 0.10)
    power *= prestige_multiplier(user)
    power *= 1 + collection_bonus(db, user_id) + achievement_bonus(db, user_id)
    if get_boosts(db, user_id).get("click_x10", 0) > 0:
        power *= BOOSTS["click_x10"]["clickMultiplier"]
    return max(1, int(power))


def reset_income_timer(db, user_id):
    db.execute("UPDATE users SET last_income_at = ? WHERE id = ?", (int(time.time()), user_id))


def collect_active_income(db, user_id):
    user = get_user(db, user_id)
    now = int(time.time())
    seconds = max(0, now - user["last_income_at"])
    if seconds < 1:
        return 0
    income = get_net_income_per_second(db, user_id)
    add_balance(db, user_id, income)
    db.execute("UPDATE users SET last_income_at = ? WHERE id = ?", (now, user_id))
    unlock_achievements(db, user_id)
    return income


def unlock_achievements(db, user_id):
    user = get_user(db, user_id)
    levels = get_robot_levels(db, user_id)
    research = get_research_levels(db, user_id)
    max_level = robot_max_level(research)
    checks = {
        "first_billion": user["balance"] >= 1_000_000_000 or user["total_earned"] >= 1_000_000_000,
        "robot_master": sum(1 for level in levels.values() if level >= max_level) >= 3,
        "spender": user["total_spent"] >= 1_000_000_000,
        "prestige_first": user["prestige_points"] > 0,
    }
    now = int(time.time())
    for achievement_id, passed in checks.items():
        if passed:
            db.execute(
                "INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)",
                (user_id, achievement_id, now),
            )


def serialize_catalog():
    return {
        "robots": ROBOTS,
        "research": RESEARCH,
        "boosts": BOOSTS,
        "cosmetics": COSMETICS,
        "collections": COLLECTIONS,
        "achievements": ACHIEVEMENTS,
        "prestigeMinBalance": PRESTIGE_MIN_BALANCE,
        "investmentDuration": INVESTMENT_DURATION,
    }


def build_state(db, user_id, auto_income=0):
    ensure_user_rows(db, user_id)
    unlock_achievements(db, user_id)
    user = get_user(db, user_id)
    research = get_research_levels(db, user_id)
    robots_income_gross = get_base_income_per_second(db, user_id)
    maintenance = get_maintenance_cost(db, user_id, robots_income_gross)
    investments = db.execute(
        "SELECT id, amount, payout_amount, ready_at, risky, status FROM investments WHERE user_id = ? AND status = 'active' ORDER BY id DESC",
        (user_id,),
    ).fetchall()
    achievements = {
        row["achievement_id"]: True
        for row in db.execute("SELECT achievement_id FROM user_achievements WHERE user_id = ?", (user_id,)).fetchall()
    }
    return {
        "userNik": user["nickname"],
        "userEmail": user["email"],
        "userCount": user["balance"],
        "clickForce": get_click_power(db, user_id),
        "baseClickForce": user["click_force"],
        "forceUpgradeCost": apply_discount(user["click_upgrade_cost"], research),
        "robots": {robot_id: {"level": level} for robot_id, level in get_robot_levels(db, user_id).items()},
        "robotsIncome": max(0, robots_income_gross - maintenance),
        "robotsIncomeGross": robots_income_gross,
        "maintenanceCost": maintenance,
        "autoIncome": auto_income,
        "prestigePoints": user["prestige_points"],
        "prestigeMultiplier": prestige_multiplier(user),
        "research": research,
        "robotMaxLevel": robot_max_level(research),
        "boosts": get_boosts(db, user_id),
        "cosmetics": get_unlocked_ids(db, "user_cosmetics", "cosmetic_id", user_id),
        "collections": get_unlocked_ids(db, "user_collections", "collection_id", user_id),
        "activeTheme": user["active_theme"],
        "investments": [dict(row) for row in investments],
        "achievements": achievements,
        "catalog": serialize_catalog(),
    }


@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/style.css")
def stylesheet():
    return send_from_directory(BASE_DIR, "style.css")


@app.get("/script.js")
def script():
    return send_from_directory(BASE_DIR, "script.js")


@app.post("/api/register")
def register():
    payload = request.get_json(silent=True) or {}
    nickname = str(payload.get("nickname", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    password = str(payload.get("password", ""))
    if not nickname or not email or not password:
        return jsonify({"error": "Заполните все поля"}), 400
    with db_connection() as db:
        if db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
            return jsonify({"error": "Почта занята"}), 409
        cursor = db.execute(
            "INSERT INTO users (nickname, email, password_hash, last_income_at) VALUES (?, ?, ?, ?)",
            (nickname, email, generate_password_hash(password), int(time.time())),
        )
        ensure_user_rows(db, cursor.lastrowid)
    return jsonify({"message": "Вы зарегистрированы"})


@app.post("/api/login")
def login():
    payload = request.get_json(silent=True) or {}
    email = str(payload.get("email", "")).strip().lower()
    password = str(payload.get("password", ""))
    with db_connection() as db:
        user = db.execute("SELECT id, password_hash FROM users WHERE email = ?", (email,)).fetchone()
        if user is None or not check_password_hash(user["password_hash"], password):
            return jsonify({"error": "Логин или пароль неверны"}), 401
        session["user_id"] = user["id"]
        ensure_user_rows(db, user["id"])
        reset_income_timer(db, user["id"])
        return jsonify(build_state(db, user["id"], 0))


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"message": "Вы вышли из аккаунта"})


@app.get("/api/state")
@require_user
def state():
    with db_connection() as db:
        reset_income_timer(db, session["user_id"])
        return jsonify(build_state(db, session["user_id"], 0))


@app.post("/api/click")
@require_user
def click():
    with db_connection() as db:
        auto_income = collect_active_income(db, session["user_id"])
        add_balance(db, session["user_id"], get_click_power(db, session["user_id"]))
        return jsonify(build_state(db, session["user_id"], auto_income))


@app.post("/api/click-upgrade")
@require_user
def click_upgrade():
    with db_connection() as db:
        auto_income = collect_active_income(db, session["user_id"])
        user = get_user(db, session["user_id"])
        research = get_research_levels(db, session["user_id"])
        cost = apply_discount(user["click_upgrade_cost"], research)
        if not spend_balance(db, session["user_id"], cost):
            return jsonify({"error": "Не хватает кликов"}), 400
        db.execute("UPDATE users SET click_force = click_force + 1, click_upgrade_cost = ? WHERE id = ?", (round(user["click_upgrade_cost"] * 1.5), session["user_id"]))
        return jsonify(build_state(db, session["user_id"], auto_income))


@app.post("/api/robots/<robot_id>/upgrade")
@require_user
def robot_upgrade(robot_id):
    robot = ROBOTS.get(robot_id)
    if robot is None:
        return jsonify({"error": "Робот не найден"}), 404
    with db_connection() as db:
        user_id = session["user_id"]
        auto_income = collect_active_income(db, user_id)
        user = get_user(db, user_id)
        research = get_research_levels(db, user_id)
        if user["prestige_points"] < robot["requiresPrestige"]:
            return jsonify({"error": "Нужен престиж для этого класса роботов"}), 400
        row = db.execute("SELECT level FROM user_robots WHERE user_id = ? AND robot_id = ?", (user_id, robot_id)).fetchone()
        level = row["level"]
        max_level = min(robot_max_level(research), len(robot["powers"]))
        if level >= max_level:
            return jsonify({"error": "Достигнут максимальный уровень"}), 400
        base_cost = robot["buyCost"] if level == 0 else robot["upgradeCosts"][level - 1]
        cost = apply_discount(base_cost, research)
        if not spend_balance(db, user_id, cost):
            return jsonify({"error": "Не хватает кликов"}), 400
        db.execute("UPDATE user_robots SET level = level + 1 WHERE user_id = ? AND robot_id = ?", (user_id, robot_id))
        return jsonify(build_state(db, user_id, auto_income))


@app.post("/api/collect-income")
@require_user
def collect_income():
    with db_connection() as db:
        auto_income = collect_active_income(db, session["user_id"])
        return jsonify(build_state(db, session["user_id"], auto_income))


@app.post("/api/prestige")
@require_user
def prestige():
    with db_connection() as db:
        user_id = session["user_id"]
        user = get_user(db, user_id)
        if user["balance"] < PRESTIGE_MIN_BALANCE:
            return jsonify({"error": "Для престижа нужен минимум 1B"}), 400
        gained = max(1, int(user["balance"] // PRESTIGE_MIN_BALANCE))
        db.execute("UPDATE users SET balance = 0, click_force = 1, click_upgrade_cost = 100, prestige_points = prestige_points + ?, last_income_at = ? WHERE id = ?", (gained, int(time.time()), user_id))
        db.execute("UPDATE user_robots SET level = 0 WHERE user_id = ?", (user_id,))
        db.execute("UPDATE user_boosts SET active_until = 0 WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM investments WHERE user_id = ? AND status = 'active'", (user_id,))
        unlock_achievements(db, user_id)
        return jsonify(build_state(db, user_id, 0))


@app.post("/api/research/<research_id>/upgrade")
@require_user
def research_upgrade(research_id):
    item = RESEARCH.get(research_id)
    if item is None:
        return jsonify({"error": "Исследование не найдено"}), 404
    with db_connection() as db:
        user_id = session["user_id"]
        auto_income = collect_active_income(db, user_id)
        level = get_research_levels(db, user_id)[research_id]
        if level >= item["maxLevel"]:
            return jsonify({"error": "Исследование уже на максимуме"}), 400
        cost = int(item["baseCost"] * (1.8 ** level))
        if not spend_balance(db, user_id, cost):
            return jsonify({"error": "Не хватает кликов"}), 400
        db.execute("UPDATE user_research SET level = level + 1 WHERE user_id = ? AND research_id = ?", (user_id, research_id))
        return jsonify(build_state(db, user_id, auto_income))


@app.post("/api/boosts/<boost_id>/buy")
@require_user
def buy_boost(boost_id):
    boost = BOOSTS.get(boost_id)
    if boost is None:
        return jsonify({"error": "Буст не найден"}), 404
    with db_connection() as db:
        user_id = session["user_id"]
        auto_income = collect_active_income(db, user_id)
        if not spend_balance(db, user_id, boost["cost"]):
            return jsonify({"error": "Не хватает кликов"}), 400
        active_until = int(time.time()) + boost["duration"]
        db.execute("UPDATE user_boosts SET active_until = MAX(active_until, ?) WHERE user_id = ? AND boost_id = ?", (active_until, user_id, boost_id))
        return jsonify(build_state(db, user_id, auto_income))


@app.post("/api/cosmetics/<cosmetic_id>/buy")
@require_user
def buy_cosmetic(cosmetic_id):
    cosmetic = COSMETICS.get(cosmetic_id)
    if cosmetic is None:
        return jsonify({"error": "Косметика не найдена"}), 404
    with db_connection() as db:
        user_id = session["user_id"]
        auto_income = collect_active_income(db, user_id)
        unlocked = get_unlocked_ids(db, "user_cosmetics", "cosmetic_id", user_id).get(cosmetic_id)
        if not unlocked and not spend_balance(db, user_id, cosmetic["cost"]):
            return jsonify({"error": "Не хватает кликов"}), 400
        db.execute("UPDATE user_cosmetics SET unlocked = 1 WHERE user_id = ? AND cosmetic_id = ?", (user_id, cosmetic_id))
        db.execute("UPDATE users SET active_theme = ? WHERE id = ?", (cosmetic_id, user_id))
        return jsonify(build_state(db, user_id, auto_income))


@app.post("/api/collections/<collection_id>/buy")
@require_user
def buy_collection(collection_id):
    item = COLLECTIONS.get(collection_id)
    if item is None:
        return jsonify({"error": "Предмет не найден"}), 404
    with db_connection() as db:
        user_id = session["user_id"]
        auto_income = collect_active_income(db, user_id)
        if get_unlocked_ids(db, "user_collections", "collection_id", user_id).get(collection_id):
            return jsonify({"error": "Уже куплено"}), 400
        if not spend_balance(db, user_id, item["cost"]):
            return jsonify({"error": "Не хватает кликов"}), 400
        db.execute("UPDATE user_collections SET unlocked = 1 WHERE user_id = ? AND collection_id = ?", (user_id, collection_id))
        return jsonify(build_state(db, user_id, auto_income))


@app.post("/api/investments/create")
@require_user
def create_investment():
    payload = request.get_json(silent=True) or {}
    amount = int(payload.get("amount", 0) or 0)
    risky = 1 if payload.get("risky") else 0
    if amount <= 0:
        return jsonify({"error": "Введите сумму инвестиции"}), 400
    with db_connection() as db:
        user_id = session["user_id"]
        auto_income = collect_active_income(db, user_id)
        if not spend_balance(db, user_id, amount):
            return jsonify({"error": "Не хватает кликов"}), 400
        multiplier = 2.0 if risky else 1.2
        payout = int(amount * multiplier)
        db.execute("INSERT INTO investments (user_id, amount, payout_amount, ready_at, risky) VALUES (?, ?, ?, ?, ?)", (user_id, amount, payout, int(time.time()) + INVESTMENT_DURATION, risky))
        return jsonify(build_state(db, user_id, auto_income))


@app.post("/api/investments/collect")
@require_user
def collect_investments():
    with db_connection() as db:
        user_id = session["user_id"]
        auto_income = collect_active_income(db, user_id)
        rows = db.execute("SELECT id, payout_amount, risky FROM investments WHERE user_id = ? AND status = 'active' AND ready_at <= ?", (user_id, int(time.time()))).fetchall()
        payout_total = 0
        for row in rows:
            won = not row["risky"] or random.random() < 0.5
            if won:
                payout_total += row["payout_amount"]
            db.execute("UPDATE investments SET status = ? WHERE id = ?", ("collected" if won else "lost", row["id"]))
        add_balance(db, user_id, payout_total)
        state = build_state(db, user_id, auto_income)
        state["investmentPayout"] = payout_total
        return jsonify(state)


@app.post("/api/fusion")
@require_user
def fusion():
    with db_connection() as db:
        user_id = session["user_id"]
        auto_income = collect_active_income(db, user_id)
        research = get_research_levels(db, user_id)
        max_level = robot_max_level(research)
        base_ids = ["robot1", "robot2", "robot3"]
        levels = get_robot_levels(db, user_id)
        if not all(levels.get(robot_id, 0) >= max_level for robot_id in base_ids):
            return jsonify({"error": "Нужны первые 3 робота на максимуме"}), 400
        db.execute("UPDATE user_robots SET level = 0 WHERE user_id = ? AND robot_id IN ('robot1', 'robot2', 'robot3')", (user_id,))
        db.execute("UPDATE users SET prestige_points = prestige_points + 1 WHERE id = ?", (user_id,))
        gold_level = levels.get("gold_robot", 0)
        if gold_level == 0:
            db.execute("UPDATE user_robots SET level = 1 WHERE user_id = ? AND robot_id = 'gold_robot'", (user_id,))
        return jsonify(build_state(db, user_id, auto_income))


init_db()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)
