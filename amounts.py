"""Exact integer currency, including amounts beyond SQLite's signed 64-bit range."""

import math
import re
from decimal import Decimal, localcontext


SUFFIXES = {suffix.lower(): 10 ** (3 * index) for index, suffix in enumerate(
    ("", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc")
)}
MAX_AMOUNT = 10 ** 100


def db_amount(value):
    value = int(value)
    if -(2 ** 63) <= value < 2 ** 63:
        return value
    # SQLite INTEGER affinity converts numeric TEXT to a lossy REAL. Decimal
    # bytes retain every digit without rebuilding existing tables or their FKs.
    return str(value).encode("ascii")


def add_db_amount(left, right):
    return db_amount(int(left) + int(right))


def parse_amount(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("Введите сумму, например 250M, 2.5B или 1 Qi")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Введите конечную положительную сумму")
        value = format(Decimal(str(value)), "f")
    raw = re.sub(r"\s+", "", str(value))
    if len(raw) > 120:
        raise ValueError("Слишком большая сумма")
    match = re.fullmatch(r"(\d+(?:[.,]\d+)?|[.,]\d+)([A-Za-z]*)", raw)
    if not match or match[2].lower() not in SUFFIXES:
        raise ValueError("Используйте число и обозначение K, M, B, T, Qa, Qi, Sx, Sp, Oc, No или Dc")
    with localcontext() as context:
        context.prec = 160
        amount = Decimal(match[1].replace(",", ".")) * SUFFIXES[match[2].lower()]
        if amount <= 0 or amount > MAX_AMOUNT:
            raise ValueError("Сумма должна быть положительной и не превышать 10^100 монет")
        if amount != amount.to_integral_value():
            raise ValueError("Сумма должна составлять целое число монет")
        return int(amount)
