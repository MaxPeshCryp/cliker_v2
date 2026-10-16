"""Cosmetic distinctions assigned by an administrator, separate from level rewards."""

BADGES = (
    {"id": "verified", "name": "Проверенный игрок", "symbol": "✓", "color": "#69b9ff"},
    {"id": "founder", "name": "Основатель", "symbol": "♜", "color": "#ffce73"},
    {"id": "legend", "name": "Легенда", "symbol": "♛", "color": "#c3a6ff"},
    {"id": "champion", "name": "Чемпион", "symbol": "🏆", "color": "#ffd56a"},
    {"id": "veteran", "name": "Ветеран", "symbol": "⚑", "color": "#b8d2e8"},
    {"id": "patron", "name": "Меценат", "symbol": "♥", "color": "#ff9bc8"},
    {"id": "robot_master", "name": "Повелитель роботов", "symbol": "⚙", "color": "#72debb"},
    {"id": "investor", "name": "Инвестор", "symbol": "◆", "color": "#85cdff"},
    {"id": "speedster", "name": "Скоростной кликер", "symbol": "ϟ", "color": "#ffaf73"},
    {"id": "creator", "name": "Создатель", "symbol": "✦", "color": "#a6adff"},
    {"id": "helper", "name": "Помощник", "symbol": "✚", "color": "#80e4bd"},
    {"id": "star", "name": "Звезда сообщества", "symbol": "★", "color": "#f5a5e2"},
)
BADGE_IDS = {badge["id"] for badge in BADGES}


def player_badges(db, user_id, is_verified=False):
    assigned = {row[0] for row in db.execute("SELECT badge_id FROM user_badges WHERE user_id = ?", (user_id,))}
    if is_verified:
        assigned.add("verified")
    return [badge for badge in BADGES if badge["id"] in assigned]
