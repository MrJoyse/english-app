"""Backend приложения для обучения английскому языку."""

import html
import json
import os
import random
from datetime import datetime
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from . import auth
from .database import Base, SessionLocal, engine, get_db
from .models import (
    Expression,
    Lesson,
    Progress,
    SessionToken,
    TaskVisibility,
    User,
)
from .parsing import EXPR_RE, SENTENCE_SPLIT_RE, parse_expressions, youtube_id

Base.metadata.create_all(bind=engine)


def _ensure_columns():
    """Простая миграция: добавляем новые колонки в существующую базу."""
    lessons_cols = [c["name"] for c in inspect(engine).get_columns("lessons")]
    if "video_url" not in lessons_cols:
        with engine.begin() as conn:
            conn.execute(
                text("ALTER TABLE lessons ADD COLUMN video_url VARCHAR(300) DEFAULT ''")
            )
    if "visible_tasks" not in lessons_cols:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE lessons ADD COLUMN visible_tasks VARCHAR(100) "
                    "DEFAULT '1.1,1.2,1.3'"
                )
            )
    expr_cols = [c["name"] for c in inspect(engine).get_columns("expressions")]
    if "hidden_word" not in expr_cols:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE expressions ADD COLUMN hidden_word VARCHAR(100) DEFAULT ''"
                )
            )


_ensure_columns()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COOKIE_NAME = "session_token"
TASKS = ("1.1", "1.2", "1.3")

app = FastAPI(title="English Trainer")


# ------------------------------------------------------------------ схемы API
class LoginIn(BaseModel):
    username: str
    password: str


class LessonIn(BaseModel):
    title: str
    topic: str = ""
    text_markup: str
    video_url: str = ""
    visible_tasks: Optional[List[str]] = None


class ProgressIn(BaseModel):
    lesson_id: int
    task: str


class ActionIn(BaseModel):
    task: str
    kind: str  # match (успех) | wrong (ошибка)
    detail: str = ""
    expected: str = ""
    done: int = 0
    total: int = 0
    mistakes: int = 0


class BoardIn(BaseModel):
    assembled: Optional[List[int]] = None
    filled: Optional[List[int]] = None
    selected_left: Optional[int] = None
    selected_right: Optional[int] = None
    selected_chip: Optional[int] = None
    flash_target: str = ""
    reset: bool = False




class UserIn(BaseModel):
    username: str
    password: str
    role: str = "student"


class VisibilityIn(BaseModel):
    user_id: int
    lesson_id: int
    tasks: Optional[List[str]] = None


def user_dict(user: User) -> dict:
    return {"id": user.id, "username": user.username, "role": user.role}


# ------------------------------------------------------------------ real-time хаб
class WSManager:
    def __init__(self):
        self.connections = {}  # websocket -> {id, username, role}

    async def connect(self, ws, user_pub):
        self.connections[ws] = user_pub

    def disconnect(self, ws):
        self.connections.pop(ws, None)

    def online(self):
        seen = {}
        for u in self.connections.values():
            seen[u["username"]] = u["role"]
        return [
            {"username": name, "role": role} for name, role in sorted(seen.items())
        ]

    async def broadcast(self, payload: dict):
        data = json.dumps(payload, ensure_ascii=False)
        dead = []
        for ws in list(self.connections):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def broadcast_presence(self):
        await self.broadcast({"type": "presence", "users": self.online()})


manager = WSManager()


async def broadcast_activity(user_pub, text, kind, lesson_id=None):
    await manager.broadcast(
        {
            "type": "activity",
            "user": user_pub["username"],
            "text": text,
            "kind": kind,
            "lesson_id": lesson_id,
            "ts": datetime.utcnow().isoformat(timespec="seconds"),
        }
    )


LIVE = {}  # username -> состояние пользователя в реальном времени


async def broadcast_live():
    await manager.broadcast({"type": "live", "states": list(LIVE.values())})


LESSON_BOARD = {}  # lesson_id -> общее состояние доски заданий (зеркалится всем)


def initial_board_for(lesson, db):
    """Единая для всех пользователей раскладка и пустое состояние доски.

    Порядок карточек и фишек детерминирован (seed от id урока), поэтому у
    ученика и учителя части выражений стоят в одном и том же порядке.
    """
    exprs = (
        db.query(Expression)
        .filter_by(lesson_id=lesson.id)
        .order_by(Expression.idx)
        .all()
    )
    ids = [e.id for e in exprs]
    rng = random.Random(lesson.id * 7919 + len(ids))
    left = ids[:]
    right = ids[:]
    chips = ids[:]
    rng.shuffle(left)
    rng.shuffle(right)
    rng.shuffle(chips)
    return {
        "left": left,
        "right": right,
        "chips": chips,
        "assembled": [],
        "filled": [],
        "selected_left": None,
        "selected_right": None,
        "selected_chip": None,
        "flash": None,
        "nonce": 0,
        "updated_by": None,
    }




# ------------------------------------------------------------------ авторизация
def _user_from_token(db, token):
    if not token:
        return None
    row = db.query(SessionToken).filter_by(token=token).first()
    if not row:
        return None
    return db.query(User).filter_by(id=row.user_id).first()


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = _user_from_token(db, request.cookies.get(COOKIE_NAME))
    if not user:
        raise HTTPException(status_code=401, detail="Требуется вход в приложение")
    return user


def current_teacher(user: User = Depends(current_user)) -> User:
    if user.role != "teacher":
        raise HTTPException(status_code=403, detail="Раздел доступен только учителю")
    return user


# ------------------------------------------------------------------ выборки
def progress_map(db) -> dict:
    rows = db.query(Progress, User).join(User, Progress.user_id == User.id).all()
    result = {}
    for prog, usr in rows:
        tasks = result.setdefault(str(prog.lesson_id), {}).setdefault(usr.username, [])
        if prog.task not in tasks:
            tasks.append(prog.task)
    for lesson_tasks in result.values():
        for name, tasks in lesson_tasks.items():
            lesson_tasks[name] = sorted(tasks)
    return result


def build_lesson_payload(lesson: Lesson, db: Session, user: User = None) -> dict:
    exprs = (
        db.query(Expression)
        .filter_by(lesson_id=lesson.id)
        .order_by(Expression.idx)
        .all()
    )
    text = lesson.text_markup

    # Текст с жирными выделенными выражениями
    parts = []
    pos = 0
    k = 0
    for m in EXPR_RE.finditer(text):
        parts.append(html.escape(text[pos : m.start()]))
        e = exprs[k] if k < len(exprs) else None
        k += 1
        label = e.full_text if e else m.group(1).replace("|", " ")
        eid = e.id if e else 0
        parts.append(
            '<span class="expr" data-expr="%s">%s</span>' % (eid, html.escape(label))
        )
        pos = m.end()
    parts.append(html.escape(text[pos:]))
    text_html = "".join(parts)

    # Предложения с пропусками + фишки выражений (задание 1.2)
    sentences_html = []
    chips = []
    k = 0
    for sent in SENTENCE_SPLIT_RE.split(text):
        matches = list(EXPR_RE.finditer(sent))
        if not matches:
            sentences_html.append('<p class="sentence">%s</p>' % html.escape(sent))
            continue
        row = []
        pos = 0
        for m in matches:
            row.append(html.escape(sent[pos : m.start()]))
            e = exprs[k] if k < len(exprs) else None
            k += 1
            label = e.full_text if e else m.group(1).replace("|", " ")
            eid = e.id if e else 0
            chips.append({"id": eid, "text": label})
            row.append('<span class="gap" data-answer="%s">⋯</span>' % eid)
            pos = m.end()
        row.append(html.escape(sent[pos:]))
        sentences_html.append('<p class="sentence">%s</p>' % "".join(row))

    # Предложения с пропущенным словом внутри выражений (задание 1.3)
    sentences13 = []
    k = 0
    for sent in SENTENCE_SPLIT_RE.split(text):
        matches = list(EXPR_RE.finditer(sent))
        if not matches:
            sentences13.append('<p class="sentence">%s</p>' % html.escape(sent))
            continue
        row = []
        pos = 0
        for m in matches:
            row.append(html.escape(sent[pos : m.start()]))
            e = exprs[k] if k < len(exprs) else None
            k += 1
            full = e.full_text if e else m.group(1).replace("|", " ")
            hidden = (e.hidden_word or "") if e else ""
            if not hidden:
                words = full.split()
                hidden = words[-1] if words else ""
            idx = full.rfind(hidden) if hidden else -1
            if idx >= 0:
                row.append(html.escape(full[:idx]))
                row.append(
                    '<span class="blank13"><input class="input13" data-expr="%d" '
                    'data-answer="%s" size="%d" maxlength="%d" '
                    'autocomplete="off" spellcheck="false"></span>'
                    % (
                        e.id if e else 0,
                        html.escape(hidden, quote=True),
                        max(4, len(hidden) + 2),
                        len(hidden) + 8,
                    )
                )
                row.append(html.escape(full[idx + len(hidden) :]))
            else:
                row.append(html.escape(full))
            pos = m.end()
        row.append(html.escape(sent[pos:]))
        sentences13.append('<p class="sentence">%s</p>' % "".join(row))

    pairs = [
        {"id": e.id, "part1": e.part1, "part2": e.part2, "full": e.full_text}
        for e in exprs
    ]

    return {
        "id": lesson.id,
        "title": lesson.title,
        "topic": lesson.topic or "",
        "text_markup": lesson.text_markup,
        "video_url": lesson.video_url or "",
        "video_id": youtube_id(lesson.video_url),
        "text_html": text_html,
        "pairs": pairs,
        "chips": chips,
        "sentences_html": "".join(sentences_html),
        "sentences13_html": "".join(sentences13),
        "visible_tasks": _task_visibility_for(db, user, lesson)
        if user is not None
        else _visible_task_list(lesson),
        "default_visible_tasks": _visible_task_list(lesson),
        "board": LESSON_BOARD.setdefault(lesson.id, initial_board_for(lesson, db)),
        "progress": progress_map(db).get(str(lesson.id), {}),
    }



# ------------------------------------------------------------------ вход в приложение
@app.post("/api/login")
def api_login(payload: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter_by(username=payload.username).first()
    if not user or not auth.verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    token = auth.new_token()
    db.add(SessionToken(token=token, user_id=user.id))
    db.commit()
    resp = JSONResponse({"ok": True, "user": user_dict(user)})
    resp.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax")
    return resp


@app.post("/api/logout")
def api_logout(request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        db.query(SessionToken).filter_by(token=token).delete()
        db.commit()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME)
    return resp


@app.get("/api/me")
def api_me(user: User = Depends(current_user)):
    return user_dict(user)


# ------------------------------------------------------------------ уроки
@app.get("/api/lessons")
def api_lessons(db: Session = Depends(get_db), user: User = Depends(current_user)):
    lessons = db.query(Lesson).order_by(Lesson.id).all()
    users = db.query(User).order_by(User.id).all()
    counts = {
        str(l.id): db.query(Expression).filter_by(lesson_id=l.id).count()
        for l in lessons
    }
    return {
        "lessons": [
            {
                "id": l.id,
                "title": l.title,
                "topic": l.topic or "",
                "expression_count": counts[str(l.id)],
                "video_id": youtube_id(l.video_url),
                "visible_tasks": _task_visibility_for(db, user, l),
                "default_visible_tasks": _visible_task_list(l),
            }
            for l in lessons
        ],
        "users": [user_dict(u) for u in users],
        "progress": progress_map(db),
    }


@app.get("/api/lessons/{lesson_id}")
def api_lesson(
    lesson_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Урок не найден")
    return build_lesson_payload(lesson, db, user)


@app.post("/api/lessons/{lesson_id}/open")
async def api_lesson_open(
    lesson_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Урок не найден")
    expr_total = db.query(Expression).filter_by(lesson_id=lesson.id).count()
    LIVE[user.username] = {
        "username": user.username,
        "lesson_id": lesson.id,
        "lesson_title": lesson.title,
        "task": None,
        "done": 0,
        "total": expr_total,
        "mistakes": 0,
        "last": "открыл(а) урок «%s»" % lesson.title,
        "last_kind": "lesson_opened",
    }
    await broadcast_activity(
        user_dict(user),
        "открыл(а) урок «%s»" % lesson.title,
        "lesson_opened",
        lesson.id,
    )
    await broadcast_live()
    return {"ok": True}



def _visible_task_list(lesson):
    raw = (lesson.visible_tasks or "").replace(" ", "")
    tasks = [t for t in raw.split(",") if t in TASKS]
    return tasks or list(TASKS)


def _clean_visible_tasks(value):
    tasks = [t for t in (value or []) if t in TASKS]
    if not tasks:
        raise HTTPException(
            status_code=400, detail="Отметьте хотя бы одно задание для показа ученику"
        )
    return ",".join(tasks)


def _clean_visibility_override(value):
    """Очистка индивидуального набора заданий ученика.

    В отличие от урокового дефолта, здесь допускается пустой список — это
    означает «скрыть все задания урока для данного ученика».
    """
    return ",".join(t for t in (value or []) if t in TASKS)


def _task_visibility_for(db, user, lesson):
    """Эффективный список видимых заданий для конкретного пользователя.

    Если для пары (пользователь, урок) есть индивидуальная настройка — она
    имеет приоритет над уроковым значением по умолчанию.
    """
    override = (
        db.query(TaskVisibility)
        .filter_by(user_id=user.id, lesson_id=lesson.id)
        .first()
    )
    if override is not None:
        raw = (override.visible_tasks or "").replace(" ", "")
        return [t for t in raw.split(",") if t in TASKS]
    return _visible_task_list(lesson)


def _all_visibility(db):
    """Карта индивидуальных настроек: {lesson_id: {user_id: [задания]}}."""
    result = {}
    for row in db.query(TaskVisibility).all():
        raw = (row.visible_tasks or "").replace(" ", "")
        tasks = [t for t in raw.split(",") if t in TASKS]
        result.setdefault(str(row.lesson_id), {})[str(row.user_id)] = tasks
    return result


def _save_expressions(db, lesson_id, exprs):
    db.query(Expression).filter_by(lesson_id=lesson_id).delete()
    for i, e in enumerate(exprs):
        db.add(
            Expression(
                lesson_id=lesson_id,
                idx=i,
                full_text=e["full"],
                part1=e["part1"],
                part2=e["part2"],
                hidden_word=e.get("hidden", ""),
            )
        )


def _validate_lesson(payload: LessonIn) -> list:
    if not payload.title.strip():
        raise HTTPException(status_code=400, detail="Укажите название урока")
    video_url = (payload.video_url or "").strip()
    if video_url and not youtube_id(video_url):
        raise HTTPException(
            status_code=400,
            detail=(
                "Не удалось распознать ссылку YouTube. Примеры: "
                "https://www.youtube.com/watch?v=XXXXXXXXXXX или "
                "https://youtu.be/XXXXXXXXXXX"
            ),
        )
    exprs = parse_expressions(payload.text_markup)
    if len(exprs) < 2:
        raise HTTPException(
            status_code=400,
            detail=(
                "Отметьте в тексте минимум два выражения двойными звёздочками: "
                "**выражение**. Точку разрыва для задания 1.1 укажите через |: "
                "**give|up**"
            ),
        )
    return exprs


@app.post("/api/lessons")
async def api_lesson_create(
    payload: LessonIn,
    db: Session = Depends(get_db),
    teacher: User = Depends(current_teacher),
):
    exprs = _validate_lesson(payload)
    lesson = Lesson(
        title=payload.title.strip(),
        topic=payload.topic.strip(),
        text_markup=payload.text_markup,
        video_url=(payload.video_url or "").strip(),
        visible_tasks=(
            _clean_visible_tasks(payload.visible_tasks)
            if payload.visible_tasks is not None
            else ",".join(TASKS)
        ),
        created_by=teacher.id,
    )
    db.add(lesson)
    db.flush()
    _save_expressions(db, lesson.id, exprs)
    db.commit()
    await broadcast_activity(
        user_dict(teacher),
        "создал(а) урок «%s»" % lesson.title,
        "lesson_created",
        lesson.id,
    )
    return {"ok": True, "id": lesson.id}


@app.put("/api/lessons/{lesson_id}")
async def api_lesson_update(
    lesson_id: int,
    payload: LessonIn,
    db: Session = Depends(get_db),
    teacher: User = Depends(current_teacher),
):
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Урок не найден")
    exprs = _validate_lesson(payload)
    lesson.title = payload.title.strip()
    lesson.topic = payload.topic.strip()
    lesson.text_markup = payload.text_markup
    lesson.video_url = (payload.video_url or "").strip()
    if payload.visible_tasks is not None:
        lesson.visible_tasks = _clean_visible_tasks(payload.visible_tasks)
    LESSON_BOARD.pop(lesson_id, None)
    _save_expressions(db, lesson.id, exprs)
    db.commit()

    await broadcast_activity(
        user_dict(teacher),
        "обновил(а) урок «%s»" % lesson.title,
        "lesson_updated",
        lesson.id,
    )
    return {"ok": True}


@app.delete("/api/lessons/{lesson_id}")
async def api_lesson_delete(
    lesson_id: int,
    db: Session = Depends(get_db),
    teacher: User = Depends(current_teacher),
):
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Урок не найден")
    title = lesson.title
    db.query(Expression).filter_by(lesson_id=lesson_id).delete()
    db.query(Progress).filter_by(lesson_id=lesson_id).delete()
    db.query(TaskVisibility).filter_by(lesson_id=lesson_id).delete()
    LESSON_BOARD.pop(lesson_id, None)
    db.delete(lesson)
    db.commit()

    await broadcast_activity(
        user_dict(teacher),
        "удалил(а) урок «%s»" % title,
        "lesson_deleted",
        lesson_id,
    )
    return {"ok": True}


# ------------------------------------------------------------------ прогресс
@app.post("/api/progress")
async def api_progress(
    payload: ProgressIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    if payload.task not in TASKS:
        raise HTTPException(status_code=400, detail="Неизвестное задание")
    lesson = db.get(Lesson, payload.lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Урок не найден")
    if payload.task not in _task_visibility_for(db, user, lesson):
        raise HTTPException(status_code=400, detail="Задание скрыто учителем")
    existing = (
        db.query(Progress)
        .filter_by(user_id=user.id, lesson_id=payload.lesson_id, task=payload.task)
        .first()
    )
    if not existing:
        db.add(
            Progress(
                user_id=user.id, lesson_id=payload.lesson_id, task=payload.task
            )
        )
        db.commit()
        await broadcast_activity(
            user_dict(user),
            "выполнил(а) задание %s урока «%s»" % (payload.task, lesson.title),
            "task_completed",
            lesson.id,
        )
    state = LIVE.get(user.username, {})
    state.update(
        {
            "username": user.username,
            "lesson_id": lesson.id,
            "lesson_title": lesson.title,
            "task": payload.task,
            "last": "выполнил(а) задание %s урока «%s»"
            % (payload.task, lesson.title),
            "last_kind": "task_completed",
        }
    )
    LIVE[user.username] = state
    await broadcast_live()
    return {"ok": True}



@app.post("/api/lessons/{lesson_id}/action")
async def api_lesson_action(
    lesson_id: int,
    payload: ActionIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """Каждое действие ученика в задании: сборка/вставка или ошибка."""
    if payload.task not in TASKS:
        raise HTTPException(status_code=400, detail="Неизвестное задание")
    if payload.kind not in ("match", "wrong"):
        raise HTTPException(status_code=400, detail="Неизвестное действие")
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Урок не найден")
    if payload.task not in _task_visibility_for(db, user, lesson):
        raise HTTPException(status_code=400, detail="Задание скрыто учителем")
    detail = (payload.detail or "").strip()[:200]
    expected = (payload.expected or "").strip()[:200]

    if payload.kind == "match":
        verb = {"1.1": "собрал(а)", "1.2": "вставил(а)", "1.3": "вписал(а)"}.get(
            payload.task, "выполнил(а)"
        )
        text = "%s выражение «%s» (задание %s)" % (verb, detail, payload.task)
        event_kind = "task_match"
    else:
        if payload.task == "1.1":
            text = "ошибка: «%s» — не выражение (задание 1.1)" % detail
        elif expected:
            text = "ошибка: «%s» вместо «%s» (задание 1.2)" % (detail, expected)
        else:
            text = "ошибка: «%s» не подходит (задание 1.2)" % detail
        event_kind = "task_mistake"

    LIVE[user.username] = {
        "username": user.username,
        "lesson_id": lesson.id,
        "lesson_title": lesson.title,
        "task": payload.task,
        "done": max(payload.done, 0),
        "total": max(payload.total, 0),
        "mistakes": max(payload.mistakes, 0),
        "last": text,
        "last_kind": event_kind,
    }
    await broadcast_activity(user_dict(user), text, event_kind, lesson.id)
    await broadcast_live()
    return {"ok": True}


@app.post("/api/lessons/{lesson_id}/board")
async def api_lesson_board(
    lesson_id: int,
    payload: BoardIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """Общее состояние доски заданий: выбор, сборки, вставки, вспышки ошибок.

    Состояние одно на урок и зеркалится всем подключённым — учитель видит
    экран ученика точно так же: тот же порядок карточек, тот же выбор, те же
    сборки и вставки, те же вспышки ошибок.
    """
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Урок не найден")
    if payload.reset:
        board = initial_board_for(lesson, db)
    else:
        board = LESSON_BOARD.get(lesson_id)
        if board is None:
            board = initial_board_for(lesson, db)
        if payload.assembled is not None:
            board["assembled"] = [int(i) for i in payload.assembled[:200]]
        if payload.filled is not None:
            board["filled"] = [int(i) for i in payload.filled[:200]]
        board["selected_left"] = payload.selected_left
        board["selected_right"] = payload.selected_right
        board["selected_chip"] = payload.selected_chip
        if payload.flash_target:
            board["nonce"] = int(board.get("nonce", 0)) + 1
            board["flash"] = {
                "target": payload.flash_target[:120],
                "nonce": board["nonce"],
            }
        else:
            board["flash"] = None
    board["updated_by"] = user.username
    LESSON_BOARD[lesson_id] = board
    await manager.broadcast(
        {
            "type": "board",
            "lesson_id": lesson_id,
            "user": user.username,
            "board": board,
        }
    )
    return {"ok": True, "board": board}


# ------------------------------------------------------------------ пользователи (только учитель)
@app.get("/api/users")
def api_users(db: Session = Depends(get_db), teacher: User = Depends(current_teacher)):
    users = db.query(User).order_by(User.id).all()
    lessons = db.query(Lesson).order_by(Lesson.id).all()
    return {
        "users": [user_dict(u) for u in users],
        "lessons": [
            {
                "id": l.id,
                "title": l.title,
                "default_visible_tasks": _visible_task_list(l),
            }
            for l in lessons
        ],
        "progress": progress_map(db),
        "task_visibility": _all_visibility(db),
    }


@app.post("/api/users")
def api_user_create(
    payload: UserIn,
    db: Session = Depends(get_db),
    teacher: User = Depends(current_teacher),
):
    if payload.role not in ("teacher", "student"):
        raise HTTPException(
            status_code=400, detail="Роль должна быть teacher или student"
        )
    if not payload.username.strip():
        raise HTTPException(status_code=400, detail="Укажите имя пользователя")
    if len(payload.password) < 4:
        raise HTTPException(
            status_code=400, detail="Пароль должен быть не короче 4 символов"
        )
    if db.query(User).filter_by(username=payload.username.strip()).first():
        raise HTTPException(
            status_code=400, detail="Такой пользователь уже существует"
        )
    user = User(
        username=payload.username.strip(),
        password_hash=auth.hash_password(payload.password),
        role=payload.role,
    )
    db.add(user)
    db.commit()
    return {"ok": True, "user": user_dict(user)}


class TaskVisibilityIn(BaseModel):
    user_id: int
    lesson_id: int
    visible_tasks: Optional[List[str]] = None  # набор заданий ([] → скрыть все)
    reset: bool = False  # True → вернуть уроковый набор по умолчанию


@app.put("/api/task-visibility")
def api_task_visibility_set(
    payload: TaskVisibilityIn,
    db: Session = Depends(get_db),
    teacher: User = Depends(current_teacher),
):
    """Индивидуальная видимость заданий урока для конкретного ученика.

    reset=True снимает индивидуальную настройку (ученик видит уроковый
    набор по умолчанию). Иначе сохраняется переданный набор: пустой список
    означает, что ученик не видит заданий этого урока вовсе.
    """
    user = db.get(User, payload.user_id)
    if not user or user.role != "student":
        raise HTTPException(status_code=400, detail="Ученик не найден")
    lesson = db.get(Lesson, payload.lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail="Урок не найден")
    default = _visible_task_list(lesson)
    cleaned = [t for t in (payload.visible_tasks or []) if t in TASKS]
    if payload.reset or sorted(cleaned) == sorted(default):
        # Совпадает с уроковым значением по умолчанию — настройка не нужна.
        db.query(TaskVisibility).filter_by(
            user_id=user.id, lesson_id=lesson.id
        ).delete()
        db.commit()
        return {"ok": True, "visible_tasks": default, "custom": False}
    raw = _clean_visibility_override(payload.visible_tasks)
    row = (
        db.query(TaskVisibility)
        .filter_by(user_id=user.id, lesson_id=lesson.id)
        .first()
    )
    if row:
        row.visible_tasks = raw
    else:
        db.add(
            TaskVisibility(
                user_id=user.id, lesson_id=lesson.id, visible_tasks=raw
            )
        )
    db.commit()
    return {
        "ok": True,
        "visible_tasks": [t for t in raw.split(",") if t in TASKS],
        "custom": True,
    }


# ------------------------------------------------------------------ WebSocket
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    db = SessionLocal()
    user_pub = None
    try:
        token = ws.cookies.get(COOKIE_NAME)
        if token:
            row = db.query(SessionToken).filter_by(token=token).first()
            if row:
                u = db.query(User).filter_by(id=row.user_id).first()
                if u:
                    user_pub = user_dict(u)
    finally:
        db.close()
    if not user_pub:
        await ws.send_text(json.dumps({"type": "error", "detail": "unauthorized"}))
        await ws.close()
        return
    await manager.connect(ws, user_pub)
    await manager.broadcast_presence()
    await ws.send_text(
        json.dumps({"type": "live", "states": list(LIVE.values())}, ensure_ascii=False)
    )
    try:
        while True:
            raw = await ws.receive_text()
            if raw == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(ws)
        still_online = any(
            u["username"] == user_pub["username"] for u in manager.connections.values()
        )
        if not still_online:
            LIVE.pop(user_pub["username"], None)
            await broadcast_live()
        await manager.broadcast_presence()



# ------------------------------------------------------------------ статика
@app.get("/", response_class=HTMLResponse)
def index():
    with open(os.path.join(BASE_DIR, "static", "index.html"), encoding="utf-8") as f:
        return f.read()


app.mount(
    "/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static"
)




