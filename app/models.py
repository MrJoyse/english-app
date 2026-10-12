from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text

from .database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    password_hash = Column(String(256), nullable=False)
    role = Column(String(16), nullable=False, default="student")  # teacher | student
    created_at = Column(DateTime, default=datetime.utcnow)


class SessionToken(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True)
    token = Column(String(64), unique=True, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)


class Lesson(Base):
    __tablename__ = "lessons"

    id = Column(Integer, primary_key=True)
    title = Column(String(200), nullable=False)
    topic = Column(String(200), default="")
    text_markup = Column(Text, nullable=False)
    video_url = Column(String(300), default="")
    visible_tasks = Column(String(100), default="1.1,1.2,1.3")
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)


class TaskVisibility(Base):
    """Переопределение видимости заданий для конкретного ученика в уроке.

    Если строки для (user_id, lesson_id) нет — действует уроковый дефолт
    lessons.visible_tasks. Сама строка хранит список заданий через запятую.
    """

    __tablename__ = "task_visibility"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    lesson_id = Column(Integer, ForeignKey("lessons.id"), index=True, nullable=False)
    visible_tasks = Column(String(100), default="1.1,1.2,1.3")
    updated_at = Column(DateTime, default=datetime.utcnow)


class Expression(Base):
    __tablename__ = "expressions"

    id = Column(Integer, primary_key=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id"), index=True)
    idx = Column(Integer, default=0)
    full_text = Column(String(300), nullable=False)
    part1 = Column(String(300), nullable=False, default="")
    part2 = Column(String(300), nullable=False, default="")
    hidden_word = Column(String(100), nullable=False, default="")


class Progress(Base):
    __tablename__ = "progress"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id"), index=True)
    task = Column(String(8), nullable=False)  # "1.1" | "1.2"
    completed_at = Column(DateTime, default=datetime.utcnow)
