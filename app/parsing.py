"""Разбор разметки урока.

Изучаемые выражения выделяются в тексте двойными звёздочками:
    **выражение**          — разрыв для задания 1.1 после первого слова
    **первая|часть**       — разрыв задаётся явно символом |
"""

import re

EXPR_RE = re.compile(r"\*\*(.+?)\*\*")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def parse_expressions(text_markup):
    """Возвращает список {'full', 'part1', 'part2', 'hidden'} по порядку в тексте.

    Разметка: **часть1|часть2|скрываемоеСлово** — вторая и третья части
    необязательны. Если слово не указано, в задании 1.3 пропускается
    последнее слово выражения.
    """
    result = []
    for match in EXPR_RE.finditer(text_markup):
        raw = match.group(1).strip()
        segments = [s.strip() for s in raw.split("|") if s.strip()]
        if not segments:
            segments = [""]
        p1 = segments[0]
        p2 = segments[1] if len(segments) > 1 else ""
        hidden = segments[2] if len(segments) > 2 else ""
        full = " ".join(segments)
        if not hidden:
            words = full.split()
            hidden = words[-1] if words else ""
        result.append(
            {"full": full, "part1": p1, "part2": p2, "hidden": hidden}
        )
    return result


YOUTUBE_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|embed/|shorts/|live/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{6,20})"
)


def youtube_id(url):
    """Достаёт ID видео из ссылки YouTube (или пустая строка, если не вышло)."""
    url = (url or "").strip()
    if not url:
        return ""
    match = YOUTUBE_RE.search(url)
    if match:
        return match.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{6,20}", url):
        return url
    return ""
