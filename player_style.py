"""Allowlisted, portable avatar parts shared by profiles and leaderboards."""
import json
import re
import warnings
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_AVATAR_BYTES = 5 * 1024 * 1024


def prepare_avatar_image(data):
    """Decode raster pixels, crop to square, strip metadata and re-encode."""
    if not data or len(data) > MAX_AVATAR_BYTES:
        raise ValueError("Выберите картинку размером до 5 МБ")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("Поддерживаются JPG, PNG и WebP")
                if source.width * source.height > 20_000_000:
                    raise ValueError("Картинка слишком большая: максимум 20 мегапикселей")
                source.load()
                square = ImageOps.fit(ImageOps.exif_transpose(source).convert("RGBA"), (256, 256), method=Image.Resampling.LANCZOS)
                clean = Image.new("RGBA", square.size)
                clean.paste(square)
                output = BytesIO()
                clean.save(output, format="PNG")
                return output.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ValueError("Не удалось прочитать картинку. Выберите другой JPG, PNG или WebP") from error

AVATAR_OPTIONS = {
    "character": ["robot", "cat", "bear", "alien"],
    "background": ["#24365c", "#123f43", "#58304b", "#49376b", "#663c2b", "#253b32"],
    "color": ["#9bbcff", "#79dfca", "#ffadc8", "#c8afff", "#ffd080", "#e5eaf5"],
    "eyes": ["happy", "round", "wink", "cool"],
    "accessory": ["none", "crown", "star", "headphones"],
}
DEFAULT_AVATAR = {key: values[0] for key, values in AVATAR_OPTIONS.items()}


def read_avatar(raw):
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        value = {}
    if not isinstance(value, dict):
        value = {}
    if isinstance(value.get("image"), str) and re.fullmatch(r"[a-f0-9]{32}", value["image"]):
        return {"imageUrl": "/api/avatar-images/" + value["image"]}
    return {key: value[key] if value.get(key) in options else options[0]
            for key, options in AVATAR_OPTIONS.items()}
