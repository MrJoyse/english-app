"""Создаёт базу, демо-пользователей и демо-урок.

Запуск:  .venv/bin/python seed.py
"""

from app import auth
from app.database import Base, SessionLocal, engine
from app.models import Expression, Lesson, User
from app.parsing import parse_expressions

DEMO_TEXT = (
    "Eating **a balanced|diet** is essential for staying healthy. "
    "Many people try to **give|up** junk food, but it can be hard to "
    "**keep|it up** for a long time. Doctors recommend **taking|regular "
    "exercise** at least three times a week. If you feel tired **all|the "
    "time**, you should check your sleeping habits. It is also important "
    "to **look|after** your mental health, **for|example** by spending "
    "time with friends. Small changes can make a big difference "
    "**in|the long run**."
)


def run():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if not db.query(User).filter_by(username="teacher").first():
            db.add(
                User(
                    username="teacher",
                    password_hash=auth.hash_password("teacher123"),
                    role="teacher",
                )
            )
        if not db.query(User).filter_by(username="student").first():
            db.add(
                User(
                    username="student",
                    password_hash=auth.hash_password("student123"),
                    role="student",
                )
            )
        db.flush()
        if db.query(Lesson).count() == 0:
            teacher = db.query(User).filter_by(username="teacher").first()
            lesson = Lesson(
                title="A Healthy Lifestyle",
                topic="Здоровье",
                text_markup=DEMO_TEXT,
                created_by=teacher.id if teacher else None,
            )
            db.add(lesson)
            db.flush()
            for i, e in enumerate(parse_expressions(DEMO_TEXT)):
                db.add(
                    Expression(
                        lesson_id=lesson.id,
                        idx=i,
                        full_text=e["full"],
                        part1=e["part1"],
                        part2=e["part2"],
                        hidden_word=e["hidden"],
                    )
                )
        db.commit()
        print(
            "Готово. Пользователи: teacher/teacher123 (учитель), "
            "student/student123 (ученик). Демо-урок создан."
        )
    finally:
        db.close()


if __name__ == "__main__":
    run()
