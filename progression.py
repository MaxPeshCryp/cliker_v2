"""Permanent account levels derived from exact lifetime currency earnings."""
from bisect import bisect_right

BADGES = (
    {"id": "spark", "name": "Искра", "level": 10, "symbol": "ϟ", "color": "#e8b17c"},
    {"id": "mechanic", "name": "Механик", "level": 25, "symbol": "⚙", "color": "#b8d2e8"},
    {"id": "engineer", "name": "Инженер", "level": 50, "symbol": "⌘", "color": "#72debb"},
    {"id": "tycoon", "name": "Магнат", "level": 75, "symbol": "♜", "color": "#ffce73"},
    {"id": "technarch", "name": "Технолорд", "level": 100, "symbol": "◈", "color": "#85cdff"},
    {"id": "architect", "name": "Архитектор звёзд", "level": 150, "symbol": "✦", "color": "#c3a6ff"},
    {"id": "legend", "name": "Легенда кликов", "level": 200, "symbol": "♛", "color": "#ff9bc8"},
)


def thresholds_through(level):
    """Level 1 starts at zero; each next step costs 40% more, rounded up."""
    thresholds, cost = [0], 100
    while len(thresholds) < level:
        thresholds.append(thresholds[-1] + cost)
        cost = (cost * 7 + 4) // 5
    return thresholds


BADGE_THRESHOLDS = thresholds_through(BADGES[-1]["level"])
REWARDS = tuple({**badge, "requiredEarnedExact": str(BADGE_THRESHOLDS[badge["level"] - 1])} for badge in BADGES)


def progression(total_earned, *, details=False):
    earned = max(0, int(total_earned))
    thresholds, cost = [0], 100
    while thresholds[-1] <= earned:
        thresholds.append(thresholds[-1] + cost)
        cost = (cost * 7 + 4) // 5
    level = bisect_right(thresholds, earned)
    unlocked = [badge for badge in REWARDS if badge["level"] <= level]
    result = {"level": level, "badge": unlocked[-1] if unlocked else None}
    if details:
        start, end = thresholds[level - 1:level + 1]
        result.update({
            "totalEarnedExact": str(earned),
            "levelStartExact": str(start),
            "nextLevelAtExact": str(end),
            "earnedInLevelExact": str(earned - start),
            "levelCostExact": str(end - start),
            "remainingExact": str(end - earned),
            "progressPercent": (earned - start) * 10000 // (end - start) / 100,
            "unlockedBadges": unlocked,
            "nextBadge": next((badge for badge in REWARDS if badge["level"] > level), None),
        })
    return result
