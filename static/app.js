"use strict";

/* ============================================================ утилиты */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Требуется вход в приложение");
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  if (!res.ok) throw new Error(data.detail || "Ошибка сервера");
  return data;
}

/* ============================================================ состояние */
const state = {
  user: null,
  lessonsData: null,
  lesson: null,
  view: "login",
  ws: null,
};

/* ============================================================ вход */
function showLogin() {
  state.view = "login";
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.classList.add("hidden");
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("#login-username").value.trim(),
        password: $("#login-password").value,
      }),
    });
    state.user = data.user;
    $("#login-password").value = "";
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  }
});

$("#logout-btn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch (e) { /* ignore */ }
  state.user = null;
  showLogin();
});

async function boot() {
  state.view = "lessons";
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#user-badge").textContent =
    state.user.username + " · " + (state.user.role === "teacher" ? "учитель" : "ученик");
  $("#nav-teacher").classList.toggle("hidden", state.user.role !== "teacher");
  $("#help-btn").classList.toggle("hidden", state.user.role !== "teacher");
  connectWS();
  await showLessons();
}

$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const nav = btn.dataset.nav;
    if (nav === "lessons") showLessons();
    if (nav === "teacher") showTeacher();
  });
});

function setActiveNav(name) {
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
}
/* ============================================================ справка учителя */
function openHelp() {
  $("#help-modal").classList.remove("hidden");
}
function closeHelp() {
  $("#help-modal").classList.add("hidden");
}
$("#help-btn").addEventListener("click", openHelp);
$("#help-close").addEventListener("click", closeHelp);
$("#help-ok").addEventListener("click", closeHelp);
$("#help-modal").addEventListener("click", (e) => {
  if (e.target.id === "help-modal") closeHelp();
});
// закрытие по Esc, пока открыта справка
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#help-modal").classList.contains("hidden")) {
    closeHelp();
  }
});
// плавный переход по оглавлению внутри справки
$$("#help-modal .help-toc a").forEach((a) =>
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href").slice(1);
    const target = $("#" + id);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  })
);



/* ============================================================ WebSocket (реальное время) */
function connectWS() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(proto + "://" + location.host + "/ws");
  state.ws = ws;

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "presence") renderOnline(msg.users || []);
    if (msg.type === "live") renderLive(msg.states || []);
    if (msg.type === "board") {
      if (state.lesson && msg.lesson_id === state.lesson.id) applyBoard(msg.board);
    }
    if (msg.type === "vocabulary") {
      if (state.lesson && msg.lesson_id === state.lesson.id) {
        state.lesson.vocabulary = (msg.vocabulary || []).map((v) => ({
          ...v,
          can_delete:
            state.user.role === "teacher" || v.author === state.user.username,
        }));
        if (msg.markup_changed) {
          // текст урока изменился (**...**) — перезагружаем урок целиком
          openLesson(state.lesson.id);
        } else {
          renderVocabulary();
        }
      }
    }
    if (msg.type === "activity") {

      addActivity(msg);

      const refresh = ["task_completed", "lesson_created", "lesson_updated", "lesson_deleted"];
      if (refresh.includes(msg.kind) && state.view === "lessons") showLessons();
      if (refresh.includes(msg.kind) && state.view === "teacher") showTeacher();
    }
  };
  ws.onclose = () => {
    if (state.user) setTimeout(connectWS, 2500);
  };
}

function renderOnline(users) {
  const list = $("#online-list");
  if (!users.length) {
    list.innerHTML = '<li class="muted">Никто не онлайн</li>';
    return;
  }
  list.innerHTML = users
    .map((u) =>
      '<li><span class="online-dot"></span>' + esc(u.username) +
      ' <span class="muted">(' + (u.role === "teacher" ? "учитель" : "ученик") + ")</span></li>"
    )
    .join("");
}

function addActivity(msg) {
  const list = $("#activity-list");
  const empty = list.querySelector(".muted");
  if (empty) empty.remove();
  const li = document.createElement("li");
  const time = (msg.ts || "").slice(11, 16);
  li.innerHTML =
    '<span class="feed-user">' + esc(msg.user) + "</span> " + esc(msg.text) +
    '<span class="feed-time">' + esc(time) + "</span>";
  if (msg.kind === "task_mistake") li.classList.add("feed-bad");
  else if (msg.kind === "task_completed" || msg.kind === "task_match") li.classList.add("feed-good");
  list.prepend(li);
  while (list.children.length > 30) list.lastElementChild.remove();
}

/* живое состояние «за работой» — кто и что делает прямо сейчас */
function renderLive(states) {
  const list = $("#live-list");
  if (!states || !states.length) {
    list.innerHTML = '<li class="muted">Никто не работает над уроком</li>';
    return;
  }
  list.innerHTML = states
    .map((s) => {
      const meta = [];
      if (s.task) meta.push("задание " + s.task + ": " + s.done + "/" + s.total);
      meta.push("ошибок: " + (s.mistakes || 0));
      const cls =
        s.last_kind === "task_mistake"
          ? "bad"
          : s.last_kind === "task_match" || s.last_kind === "task_completed"
          ? "good"
          : "";
      return (
        '<li class="live-item"><b>' + esc(s.username) + "</b>" +
        '<div class="live-lesson">' + esc(s.lesson_title || "") + "</div>" +
        '<div class="live-meta">' + esc(meta.join(" · ")) + "</div>" +
        '<div class="live-last ' + cls + '">' + esc(s.last || "") + "</div></li>"
      );
    })
    .join("");
}


/* ============================================================ старт */
(async function init() {
  try {
    state.user = await api("/api/me");
    await boot();
  } catch (e) {
    showLogin();
  }
})();

/* ============================================================ список уроков */
async function showLessons() {
  state.view = "lessons";
  setActiveNav("lessons");
  teardownVocabSelection();
  try {
    state.lessonsData = await api("/api/lessons");
  } catch (e) {
    return;
  }
  renderLessons();
}

function progressBadges(lesson, users, progress) {
  const shown =
    lesson.visible_tasks && lesson.visible_tasks.length
      ? lesson.visible_tasks
      : ["1.1", "1.2", "1.3"];
  return users
    .map((u) => {
      const tasks = (progress[String(lesson.id)] || {})[u.username] || [];
      return (
        '<div class="badge-row"><span class="who">' + esc(u.username) + "</span>" +
        shown
          .map(
            (t) =>
              '<span class="task-chip ' + (tasks.includes(t) ? "done" : "") + '">задание ' + t + "</span>"
          )
          .join("") +
        "</div>"
      );
    })
    .join("");
}

function renderLessons() {
  const { lessons, users, progress } = state.lessonsData;
  let html = '<div class="page-head"><h1>Уроки</h1>';
  if (state.user.role === "teacher") {
    html += '<button class="btn primary" id="new-lesson-btn">+ Новый урок</button>';
  }
  html += "</div>";
  if (!lessons.length) {
    html += '<div class="panel"><p class="muted">Пока нет уроков.</p></div>';
  }
  for (const l of lessons) {
    html +=
      '<div class="lesson-card"><div class="lesson-card-head"><div><h2>' +
      esc(l.title) +
      '</h2><span class="topic">' +
      esc(l.topic || "без темы") +
      " · " +
      l.expression_count +
      " выражений" +
      (l.vocabulary_count ? " · 📚 словарь: " + l.vocabulary_count : "") +
      (l.video_id ? " · 🎬 видео" : "") +
      "</span></div>" +
      '<div class="lesson-actions"><button class="btn primary" data-open="' +
      l.id +
      '">Открыть</button>';
    if (state.user.role === "teacher") {
      html +=
        '<button class="btn" data-edit="' + l.id + '">Изменить</button>' +
        '<button class="btn danger" data-del="' + l.id + '">Удалить</button>';
    }
    html +=
      '</div></div><div class="progress-block">' +
      progressBadges(l, users, progress) +
      "</div></div>";
  }
  $("#main").innerHTML = html;

  const newBtn = $("#new-lesson-btn");
  if (newBtn) newBtn.addEventListener("click", () => openLessonEditor(null));
  $$("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openLesson(+b.dataset.open))
  );
  $$("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openLessonEditor(+b.dataset.edit))
  );
  $$("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Удалить урок вместе со всем прогрессом?")) return;
      try {
        await api("/api/lessons/" + b.dataset.del, { method: "DELETE" });
        toast("Урок удалён");
      } catch (e) {
        toast(e.message, true);
      }
      showLessons();
    })
  );
}

/* ============================================================ управление (только учитель) */
async function showTeacher() {
  if (state.user.role !== "teacher") return;
  state.view = "teacher";
  setActiveNav("teacher");
  teardownVocabSelection();
  let data;
  try {
    data = await api("/api/users");
  } catch (e) {
    return;
  }
  const { users, lessons, progress } = data;
  state.teacherData = data;

  let html = '<div class="page-head"><h1>Управление</h1></div>';

  html +=
    '<div class="panel"><h2>Пользователи</h2>' +
    '<form class="create-user-form" id="create-user-form">' +
    '<label>Имя<input id="new-username" required></label>' +
    '<label>Пароль<input id="new-password" type="password" required></label>' +
    '<label>Роль<select id="new-role"><option value="student">ученик</option>' +
    '<option value="teacher">учитель</option></select></label>' +
    '<button class="btn primary" type="submit">Создать</button></form>' +
    '<p id="create-user-error" class="error-text hidden"></p></div>';

  html +=
    '<div class="panel"><h2>Прогресс всех пользователей</h2>' +
    '<table class="users-table"><tr><th>Пользователь</th>' +
    lessons.map((l) => "<th>" + esc(l.title) + "</th>").join("") +
    "</tr>" +
    users
      .map(
        (u) =>
          "<tr><td><b>" +
          esc(u.username) +
          "</b> <span class='muted'>" +
          (u.role === "teacher" ? "учитель" : "ученик") +
          "</span> " +
          '<button class="btn reset-pw-btn" data-resetpw="' +
          u.id +
          '" data-name="' +
          esc(u.username) +
          '">🔑 Сбросить пароль</button></td>' +
          lessons
            .map((l) => {
              const tasks = (progress[String(l.id)] || {})[u.username] || [];
              return (
                "<td>" +
                (tasks.length
                  ? tasks
                      .map((t) => '<span class="task-chip done">' + t + "</span>")
                      .join(" ")
                  : "<span class='muted'>—</span>") +
                "</td>"
              );
            })
            .join("") +
          "</tr>"
      )
      .join("") +
    "</table></div>";

  html +=
    '<div class="panel"><h2>Видимость заданий</h2>' +
    '<p class="hint">По умолчанию каждый ученик видит набор заданий, заданный в самом уроке. ' +
    "Здесь можно задать набор <b>индивидуально для каждого ученика</b> — он перекроет общий. " +
    "Сняты все галочки — ученик не видит заданий этого урока вовсе; кнопка «Как в уроке» " +
    "возвращает индивидуальную настройку к общей.</p>" +
    (lessons.length
      ? '<label class="hint">Урок: <select id="vis-lesson">' +
        lessons
          .map((l) => '<option value="' + l.id + '">' + esc(l.title) + "</option>")
          .join("") +
        "</select></label>"
      : '<p class="muted">Сначала создайте урок.</p>') +
    '<div id="vis-table-wrap"></div>' +
    '<p id="vis-error" class="error-text hidden"></p></div>';

  $("#main").innerHTML = html;
  $("#create-user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#create-user-error");
    err.classList.add("hidden");
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: $("#new-username").value.trim(),
          password: $("#new-password").value,
          role: $("#new-role").value,
        }),
      });
      toast("Пользователь создан");
      showTeacher();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    }
  });

  $$(".reset-pw-btn").forEach((b) =>
    b.addEventListener("click", async () => {
      const name = b.dataset.name;
      const pw = prompt(
        "Новый пароль для «" + name + "» (не короче 4 символов):"
      );
      if (pw === null) return; // отмена
      if (pw.length < 4) {
        toast("Пароль должен быть не короче 4 символов", true);
        return;
      }
      try {
        await api("/api/users/" + b.dataset.resetpw + "/password", {
          method: "PUT",
          body: JSON.stringify({ password: pw }),
        });
        toast("Пароль для «" + name + "» изменён");
      } catch (ex) {
        toast(ex.message, true);
      }
    })
  );

  const visSel = $("#vis-lesson");
  if (visSel) {
    visSel.addEventListener("change", () => renderVisTable());
    renderVisTable();
  }
}

const TASK_NAMES = ["1.1", "1.2", "1.3"];

function visTasksFor(lesson, userId, taskVisibility) {
  const overrides = (taskVisibility || {})[String(lesson.id)] || {};
  if (Object.prototype.hasOwnProperty.call(overrides, String(userId))) {
    return overrides[String(userId)];
  }
  return lesson.default_visible_tasks || ["1.1", "1.2", "1.3"];
}

function renderVisTable() {
  const wrap = $("#vis-table-wrap");
  if (!wrap) return;
  const { users, lessons, task_visibility } = state.teacherData;
  const sel = $("#vis-lesson");
  const lesson = lessons.find((l) => l.id === +sel.value);
  if (!lesson) {
    wrap.innerHTML = "";
    return;
  }
  const students = users.filter((u) => u.role === "student");
  if (!students.length) {
    wrap.innerHTML = '<p class="muted">Пока нет учеников — создайте их выше.</p>';
    return;
  }
  const defaults = lesson.default_visible_tasks || ["1.1", "1.2", "1.3"];
  wrap.innerHTML =
    '<table class="users-table"><tr><th>Ученик</th>' +
    TASK_NAMES.map((t) => "<th>Задание " + t + "</th>").join("") +
    "<th>Набор</th><th></th></tr>" +
    students
      .map((u) => {
        const overrides = (task_visibility || {})[String(lesson.id)] || {};
        const custom = Object.prototype.hasOwnProperty.call(
          overrides,
          String(u.id)
        );
        const shown = visTasksFor(lesson, u.id, task_visibility);
        return (
          "<tr>" +
          "<td><b>" + esc(u.username) + "</b></td>" +
          TASK_NAMES.map(
            (t) =>
              '<td><input type="checkbox" class="vis-cb" data-user="' +
              u.id +
              '" data-task="' +
              t +
              '"' +
              (shown.includes(t) ? " checked" : "") +
              "></td>"
          ).join("") +
          '<td><span class="' +
          (custom ? "task-chip custom" : "task-chip") +
          '">' +
          (custom ? "индивидуально" : "как в уроке") +
          "</span></td>" +
          '<td><button class="btn" data-reset="' +
          u.id +
          '"' +
          (custom ? "" : " disabled") +
          ">Как в уроке</button></td>" +
          "</tr>"
        );
      })
      .join("") +
    "</table>" +
    '<p class="hint">Общий набор этого урока: ' +
    defaults.map((t) => "задание " + t).join(", ") +
    "</p>";

  $$("#vis-table-wrap .vis-cb").forEach((cb) =>
    cb.addEventListener("change", () => saveVisRow(+cb.dataset.user))
  );
  $$("#vis-table-wrap [data-reset]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.disabled) return;
      await saveVisRow(+b.dataset.reset, null);
    })
  );
}

async function saveVisRow(userId, tasks) {
  const errEl = $("#vis-error");
  errEl.classList.add("hidden");
  const lessonId = +$("#vis-lesson").value;
  const reset = tasks === null; // «Как в уроке» — снять индивидуальную настройку
  if (reset) {
    tasks = [];
  } else {
    tasks = $$('#vis-table-wrap input.vis-cb[data-user="' + userId + '"]')
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.task);
  }
  try {
    const res = await api("/api/task-visibility", {
      method: "PUT",
      body: JSON.stringify({
        user_id: userId,
        lesson_id: lessonId,
        visible_tasks: tasks,
        reset: reset,
      }),
    });
    const vis = state.teacherData.task_visibility;
    if (res.custom) {
      vis[String(lessonId)] = vis[String(lessonId)] || {};
      vis[String(lessonId)][String(userId)] = res.visible_tasks;
    } else if (vis[String(lessonId)]) {
      delete vis[String(lessonId)][String(userId)];
    }
    renderVisTable();
    toast("Видимость обновлена");
  } catch (ex) {
    errEl.textContent = ex.message;
    errEl.classList.remove("hidden");
  }
}

/* ============================================================ урок */
async function openLesson(id) {
  try {
    state.lesson = await api("/api/lessons/" + id);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  state.view = "lesson";
  api("/api/lessons/" + id + "/open", { method: "POST" }).catch(() => {});
  renderLesson();
}

function renderLesson() {
  const l = state.lesson;
  const vis =
    l.visible_tasks && l.visible_tasks.length
      ? l.visible_tasks
      : ["1.1", "1.2", "1.3"];
  $("#main").innerHTML =
    '<button class="btn ghost" id="back-btn">← К урокам</button>' +
    '<button class="btn ghost" id="reset-board-btn">⟲ Начать заново</button>' +
    '<div class="lesson-header"><h1>' + esc(l.title) + '</h1>' +
    '<span class="topic">' + esc(l.topic || "без темы") + "</span></div>" +
    '<div class="lesson-body">' +
    '<div class="lesson-content">' +
    '<section class="panel" id="sec-text"><h2>Текст</h2>' +
    '<p class="hint">Изучаемые выражения выделены жирным. Выделите любое место текста мышкой — появится кнопка «＋ В словарь»: фрагмент сохранится в словарь и будет взят в **...** как изучаемое выражение (появится в заданиях).</p>' +
    '<div class="lesson-text" id="lesson-text">' + l.text_html + "</div></section>" +
    '<section class="panel" id="vocab-panel"><h2>Словарь урока</h2>' +
    '<p class="hint" id="vocab-hint">Пока пусто — выделите выражение в тексте и нажмите «＋ В словарь».</p>' +
    '<ul id="vocab-list" class="plain-list vocab-list"></ul></section>' +
    (l.video_id
      ? '<section class="panel" id="sec-video"><h2>Видео</h2>' +
        '<p class="hint">Материал урока — посмотрите и повторите новые выражения вслух.</p>' +
        '<div class="video-wrap"><iframe src="https://www.youtube.com/embed/' +
        esc(l.video_id) +
        '" title="Видео урока" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div></section>'
      : "") +
    (vis.includes("1.1")
      ? '<section class="panel" id="sec-task11"><h2>Задание 1.1 — собери выражения</h2>' +
        '<p class="hint">Кликните по левой части выражения (она подсветится зелёным), затем по правой — либо перетащите одну на другую мышкой. Подсвечиваются только кликнутые части: зелёная — верная пара (через 2 секунды соберётся вниз), красная — неверная (через 2 секунды выбор сбросится). Подсветку видно и с другого аккаунта.</p>' +
        '<div class="match-columns"><div class="match-col" id="col-left"></div>' +
        '<div class="match-col" id="col-right"></div></div>' +
        '<div class="assembled"><h3>Собранные выражения</h3><ul id="assembled-list"></ul></div>' +
        '<div class="task-done hidden" id="task11-done">✓ Задание 1.1 выполнено</div></section>'
      : "") +
    (vis.includes("1.2")
      ? '<section class="panel" id="sec-task12"><h2>Задание 1.2 — вставь пропущенные выражения</h2>' +
        '<p class="hint">Кликните по выражению в списке ниже, затем по пропуску — либо перетащите. Правильное встанет сразу; ошибочное подсветится красным на 2 секунды и вернётся в список. Клик по вставленном пропуске возвращает выражение обратно.</p>' +
        '<div class="gap-text" id="gap-text">' + l.sentences_html + "</div>" +
        '<div class="chip-pool" id="chip-pool"></div>' +
        '<div class="task-done hidden" id="task12-done">✓ Задание 1.2 выполнено</div></section>'
      : "") +
    (vis.includes("1.3")
      ? '<section class="panel" id="sec-task13"><h2>Задание 1.3 — впиши недостающее слово</h2>' +
        '<p class="hint">В предложениях внутри изучаемых выражений пропущено слово — напечатайте его. Верное слово подсветится зелёным и зафиксируется, неверное — красным; можно править.</p>' +
        '<div class="gap-text" id="gap13-text">' + l.sentences13_html + "</div>" +
        '<div class="task-done hidden" id="task13-done">✓ Задание 1.3 выполнено</div></section>'
      : "") +
    "</div>" + // .lesson-content
    '<nav class="lesson-aside">' +
    '<a class="aside-link" href="#sec-text">Текст</a>' +
    (vis.includes("1.1") ? '<a class="aside-link" href="#sec-task11">Упражнение 1.1</a>' : "") +
    (vis.includes("1.2") ? '<a class="aside-link" href="#sec-task12">Упражнение 1.2</a>' : "") +
    (vis.includes("1.3") ? '<a class="aside-link" href="#sec-task13">Упражнение 1.3</a>' : "") +
    '<a class="aside-link" href="#vocab-panel">Словарь</a>' +
    (l.video_id ? '<a class="aside-link" href="#sec-video">Видео</a>' : "") +
    "</nav>" +
    "</div>"; // .lesson-body
  $("#back-btn").addEventListener("click", showLessons);
  $("#reset-board-btn").addEventListener("click", async () => {
    if (
      !confirm(
        "Начать урок заново? Сборки и вставки сбросятся у всех, кто сейчас смотрит урок."
      )
    )
      return;
    try {
      const res = await api("/api/lessons/" + l.id + "/board", {
        method: "POST",
        body: JSON.stringify({ reset: true }),
      });
      state.lesson.board = res.board;
      renderLesson();
    } catch (e) {
      toast(e.message, true);
    }
  });
  boardCtl = {
    assembled: [],
    filled: [],
    selectedLeft: null,
    selectedRight: null,
    selectedChip: null,
    lastFlashNonce: (l.board && l.board.flash && l.board.flash.nonce) || 0,
  };
  initTask11(l);
  initTask12(l);
  initTask13(l);
  renderVocabulary();
  initVocabSelection();
  applyBoard(l.board || defaultBoard(l));
}

/* ============================================================ словарь урока */
/* Выделение в тексте урока → плавающая кнопка «＋ В словарь». */
let vocabSelHandler = null;

function initVocabSelection() {
  const textEl = $("#lesson-text");
  if (!textEl) return;
  if (vocabSelHandler) {
    document.removeEventListener("mouseup", vocabSelHandler);
    vocabSelHandler = null;
  }
  hideVocabButton();

  const btn = document.createElement("button");
  btn.id = "vocab-add-btn";
  btn.type = "button";
  btn.className = "vocab-add-btn hidden";
  btn.textContent = "＋ В словарь";
  btn.title = "Добавить выделенное выражение в словарь урока";
  document.body.appendChild(btn);

  const hideBtn = () => btn.classList.add("hidden");

  btn.addEventListener("mousedown", (e) => e.preventDefault()); // не сбрасывать выделение
  btn.addEventListener("click", async () => {
    const sel = window.getSelection();
    const term = btn.dataset.term || (sel ? sel.toString() : "").replace(/\s+/g, " ").trim();
    hideBtn();
    if (sel) sel.removeAllRanges();
    if (term.length < 2) {
      toast("Выделите выражение длиной от 2 символов", true);
      return;
    }
    try {
      const res = await api("/api/lessons/" + state.lesson.id + "/vocabulary", {
        method: "POST",
        body: JSON.stringify({ term }),
      });
      toast("«" + term + "» — добавлено в словарь 📚");
      if (res.markup_changed) {
        // термин взят в **...** в тексте урока — перезагружаем вид
        openLesson(state.lesson.id);
      }
    } catch (e) {
      toast(e.message, true);
    }
  });

  vocabSelHandler = (e) => {
    // клик по самой кнопке не должен сбрасывать выделение до отправки
    if (e.target === btn) return;
    setTimeout(() => {
      // страница урока закрыта — снимаем слушатель совсем
      if (!state.lesson || state.view !== "lesson" || !document.body.contains(textEl)) {
        teardownVocabSelection();
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        hideBtn(); // просто прячем кнопку, слушатель остаётся
        return;
      }
      if (!textEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        hideBtn();
        return;
      }
      const term = sel.toString().replace(/\s+/g, " ").trim();
      if (term.length < 2) {
        hideBtn();
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      btn.dataset.term = term;
      btn.style.top = window.scrollY + rect.top - 42 + "px";
      btn.style.left = window.scrollX + rect.left + "px";
      btn.classList.remove("hidden");
    }, 0);
  };
  document.addEventListener("mouseup", vocabSelHandler);
}

function hideVocabButton() {
  const btn = $("#vocab-add-btn");
  if (btn) btn.remove();
}

/* убираем кнопку и слушатель при уходе со страницы урока */
function teardownVocabSelection() {
  hideVocabButton();
  if (vocabSelHandler) {
    document.removeEventListener("mouseup", vocabSelHandler);
    vocabSelHandler = null;
  }
}

function renderVocabulary() {
  const list = $("#vocab-list");
  if (!list) return;
  const l = state.lesson;
  const items = l.vocabulary || [];
  const hint = $("#vocab-hint");
  if (hint) hint.classList.toggle("hidden", items.length > 0);
  list.innerHTML = items
    .map((v) => {
      const canEdit =
        state.user.role === "teacher" || v.author === state.user.username;
      return (
        '<li class="vocab-item" data-id="' +
        v.id +
        '"><span class="vocab-term">' +
        esc(v.term) +
        "</span>" +
        (v.translation
          ? '<span class="vocab-translation">' + esc(v.translation) + "</span>"
          : "") +
        '<span class="vocab-meta muted">' +
        (v.author ? "· " + esc(v.author) : "") +
        "</span>" +
        (canEdit
          ? '<span class="vocab-actions">' +
            '<button class="btn ghost vocab-edit" title="Перевод/пояснение">✏️</button>' +
            '<button class="btn ghost danger vocab-del" title="Удалить">✕</button>' +
            "</span>"
          : "") +
        "</li>"
      );
    })
    .join("");

  $$("#vocab-list .vocab-del").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.closest(".vocab-item").dataset.id;
      if (!confirm("Удалить выражение из словаря урока?")) return;
      try {
        const res = await api(
          "/api/lessons/" + l.id + "/vocabulary/" + id,
          { method: "DELETE" }
        );
        if (res.markup_changed) {
          // выражение снято и с текста урока — перезагружаем вид
          openLesson(l.id);
        } else {
          l.vocabulary = (l.vocabulary || []).filter(
            (v) => String(v.id) !== String(id)
          );
          renderVocabulary();
        }
        toast("Удалено из словаря");
      } catch (e) {
        toast(e.message, true);
      }
    })
  );

  $$("#vocab-list .vocab-edit").forEach((b) =>
    b.addEventListener("click", async () => {
      const item = b.closest(".vocab-item");
      const id = item.dataset.id;
      const entry = (l.vocabulary || []).find(
        (v) => String(v.id) === String(id)
      );
      if (!entry) return;
      const value = prompt(
        "Перевод / пояснение для «" + entry.term + "»:",
        entry.translation || ""
      );
      if (value === null) return;
      try {
        await api("/api/lessons/" + l.id + "/vocabulary/" + id, {
          method: "PUT",
          body: JSON.stringify({ translation: value }),
        });
        entry.translation = value.replace(/\s+/g, " ").trim().slice(0, 300);
        renderVocabulary();
        toast("Сохранено");
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
}


function flashError(el) {
  el.classList.remove("error");
  void el.offsetWidth; // перезапуск анимации
  el.classList.add("error");
  setTimeout(() => el.classList.remove("error"), 700);
}

async function completeTask(task, selector) {
  const el = $(selector);
  if (el) el.classList.remove("hidden");
  try {
    await api("/api/progress", {
      method: "POST",
      body: JSON.stringify({ lesson_id: state.lesson.id, task }),
    });
  } catch (e) { /* ignore */ }
  toast("Задание " + task + " выполнено! 🎉");
}

/* сообщаем серверу о действии в задании — учитель видит это в реальном времени */
function reportAction(lessonId, task, kind, detail, opts) {
  opts = opts || {};
  api("/api/lessons/" + lessonId + "/action", {
    method: "POST",
    body: JSON.stringify({
      task: task,
      kind: kind,
      detail: detail,
      expected: opts.expected || "",
      done: opts.done || 0,
      total: opts.total || 0,
      mistakes: opts.mistakes || 0,
    }),
  }).catch(() => {});
}

/* ============================================================ общая доска заданий */
/* Состояние доски одно на урок для всех пользователей: порядок карточек,
   выбор, сборки и вставки зеркалятся в реальном времени. */
let boardCtl = {
  assembled: [],
  filled: [],
  selectedLeft: null,
  selectedRight: null,
  selectedChip: null,
  lastFlashNonce: 0,
};

function makeMatchCard(text, id, side) {
  const card = document.createElement("div");
  card.className = "match-card";
  card.textContent = text;
  card.dataset.id = id;
  card.dataset.side = side;
  card.draggable = true;
  return card;
}

function makeChip(id, text) {
  const chip = document.createElement("div");
  chip.className = "chip";
  chip.textContent = text;
  chip.dataset.id = id;
  chip.draggable = true;
  return chip;
}

function defaultBoard(l) {
  return {
    left: l.pairs.map((p) => p.id),
    right: l.pairs.map((p) => p.id),
    chips: l.chips.map((c) => c.id),
    assembled: [],
    filled: [],
    selected_left: null,
    selected_right: null,
    selected_chip: null,
    flash: null,
  };
}

/* отправка текущего состояния доски на сервер (оно зеркалилится всем) */
function sendBoard(patch) {
  const l = state.lesson;
  if (!l) return;
  const body = Object.assign(
    {
      assembled: boardCtl.assembled.slice(),
      filled: boardCtl.filled.slice(),
      selected_left: boardCtl.selectedLeft,
      selected_right: boardCtl.selectedRight,
      selected_chip: boardCtl.selectedChip,
      flash_target: "",
    },
    patch || {}
  );
  api("/api/lessons/" + l.id + "/board", {
    method: "POST",
    body: JSON.stringify(body),
  }).catch(() => {});
}

/* подсветка действия на 2 секунды — видна всем, кто смотрит урок */
const PREVIEW_MS = 2000;

function applyBoardEffect(target) {
  const raw = String(target || "");
  const sep = raw.indexOf(":");
  if (sep === -1) return;
  const kind = raw.slice(0, sep);
  const rest = raw.slice(sep + 1);
  const cls = kind.indexOf("good") === 0 ? "preview-good" : "preview-error";
  const els = [];
  if (kind === "good-pair" || kind === "bad-pair") {
    // элементы вида "p1:<id>+p2:<id>" — подсвечиваем ТОЛЬКО кликнутые карточки
    rest.split("+").forEach((part) => {
      const bits = part.split(":");
      if (bits.length !== 2) return;
      const el = document.querySelector(
        '.match-card[data-id="' + bits[1] + '"][data-side="' + bits[0] + '"]'
      );
      if (el) els.push(el);
    });
  } else if (kind === "good-gap" || kind === "bad-gap") {
    const g = $('.gap[data-answer="' + rest + '"]');
    if (g) els.push(g);
  }
  els.forEach((el) => {
    el.classList.remove(cls);
    void el.offsetWidth; // перезапуск анимации
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), PREVIEW_MS);
  });
}

/* применение пришедшего состояния — экран становится точной копией доски */
function applyBoard(board) {
  const l = state.lesson;
  if (!l || !board) return;
  const colLeft = $("#col-left");
  const colRight = $("#col-right");
  const gapText = $("#gap-text");
  const pool = $("#chip-pool");

  const byId = {};
  l.pairs.forEach((p) => { byId[p.id] = p; });
  const chipText = {};
  l.chips.forEach((c) => { chipText[c.id] = c.text; });

  boardCtl.assembled = (board.assembled || []).map(Number);
  boardCtl.filled = (board.filled || []).map(Number);
  boardCtl.selectedLeft =
    board.selected_left == null ? null : Number(board.selected_left);
  boardCtl.selectedRight =
    board.selected_right == null ? null : Number(board.selected_right);
  boardCtl.selectedChip =
    board.selected_chip == null ? null : Number(board.selected_chip);

  function renderColumn(col, order, side) {
    $$(".match-card", col).forEach((c) => {
      const id = Number(c.dataset.id);
      if (order.indexOf(id) === -1 || boardCtl.assembled.indexOf(id) !== -1) {
        c.remove();
      }
    });
    order.forEach((id) => {
      if (boardCtl.assembled.indexOf(id) !== -1) return;
      let card = col.querySelector('.match-card[data-id="' + id + '"]');
      if (!card) {
        const data = byId[id] || {};
        card = makeMatchCard(side === "p1" ? data.part1 : data.part2, id, side);
      }
      col.appendChild(card); // перемещает существующую карточку на место
      const selectedId =
        side === "p1" ? boardCtl.selectedLeft : boardCtl.selectedRight;
      card.classList.toggle("selected", selectedId === id);
    });
  }
  if (colLeft && colRight) {
    renderColumn(colLeft, (board.left || []).map(Number), "p1");
    renderColumn(colRight, (board.right || []).map(Number), "p2");
    const assembledEl = $("#assembled-list");
    if (assembledEl) {
      assembledEl.innerHTML = boardCtl.assembled
        .map((id) => "<li>" + esc(byId[id] ? byId[id].full : id) + "</li>")
        .join("");
    }
  }

  if (gapText && pool) {
  $$(".gap", gapText).forEach((gap) => {
    const id = Number(gap.dataset.answer);
    if (boardCtl.filled.indexOf(id) !== -1) {
      gap.textContent = chipText[id] || gap.textContent;
      gap.classList.add("filled");
    } else {
      gap.textContent = "⋯";
      gap.classList.remove("filled");
    }
  });

  $$(".chip", pool).forEach((c) => {
    if (boardCtl.filled.indexOf(Number(c.dataset.id)) !== -1) c.remove();
  });
  (board.chips || []).map(Number).forEach((id) => {
    if (boardCtl.filled.indexOf(id) !== -1) return;
    let chip = pool.querySelector('.chip[data-id="' + id + '"]');
    if (!chip) chip = makeChip(id, chipText[id] || String(id));
    pool.appendChild(chip);
    chip.classList.toggle("selected", boardCtl.selectedChip === id);
  });
  }

  if (board.flash && board.flash.nonce > boardCtl.lastFlashNonce) {
    boardCtl.lastFlashNonce = board.flash.nonce;
    applyBoardEffect(board.flash.target);
  }
}


/* --- задание 1.1: собери выражения --- */
function initTask11(l) {
  const colLeft = $("#col-left");
  const colRight = $("#col-right");
  const container = $(".match-columns");
  if (!colLeft || !colRight || !container) return;
  let dragging = null;     // {id, side, el}
  let mistakes = 0;
  let locked = false;      // на время подсветки (2 с) интерфейс заморожен

  function doneCount() {
    return l.pairs.length - colLeft.querySelectorAll(".match-card").length;
  }

  function clearSelection() {
    boardCtl.selectedLeft = null;
    boardCtl.selectedRight = null;
    $$(".match-card.selected").forEach((c) => c.classList.remove("selected"));
  }

  function rebuildAssembled() {
    $("#assembled-list").innerHTML = boardCtl.assembled
      .map((aid) => {
        const p = l.pairs.find((x) => x.id === aid);
        return "<li>" + esc(p ? p.full : aid) + "</li>";
      })
      .join("");
  }

  function checkPair(id, p1el, p2el) {
    if (locked) return;
    locked = true;
    const ok = String(p2el.dataset.id) === String(id);
    boardCtl.selectedRight = Number(p2el.dataset.id);
    // подсвечиваем ТОЛЬКО кликнутые карточки: зелёная — верно, красная — нет
    const effect =
      (ok ? "good-pair:" : "bad-pair:") +
      "p1:" + id +
      "+p2:" + p2el.dataset.id;
    applyBoardEffect(effect);
    sendBoard({ flash_target: effect });
    setTimeout(() => {
      locked = false;
      $$(".preview-error, .preview-good", container).forEach((el) =>
        el.classList.remove("preview-error", "preview-good")
      );
      if (ok) {
        // верная пара уходит вниз
        p1el.remove();
        p2el.remove();
        if (boardCtl.assembled.indexOf(Number(id)) === -1) {
          boardCtl.assembled.push(Number(id));
        }
        rebuildAssembled();
        clearSelection();
        sendBoard({});
        const pair = l.pairs.find((p) => String(p.id) === String(id));
        reportAction(
          l.id,
          "1.1",
          "match",
          pair ? pair.full : p1el.textContent + " " + p2el.textContent,
          {
            done: doneCount(),
            total: l.pairs.length,
            mistakes: mistakes,
          }
        );
        if (!colLeft.querySelector(".match-card")) {
          completeTask("1.1", "#task11-done");
        }
      } else {
        mistakes++;
        reportAction(
          l.id,
          "1.1",
          "wrong",
          p1el.textContent + " + " + p2el.textContent,
          {
            done: doneCount(),
            total: l.pairs.length,
            mistakes: mistakes,
          }
        );
        clearSelection();
        sendBoard({});
      }
    }, PREVIEW_MS);
  }

  container.addEventListener("click", (e) => {
    const card = e.target.closest(".match-card");
    if (!card || locked) return;
    if (card.dataset.side === "p1") {
      const id = Number(card.dataset.id);
      if (boardCtl.selectedLeft === id) {
        clearSelection();
        sendBoard({});
        return;
      }
      clearSelection();
      card.classList.add("selected");
      boardCtl.selectedLeft = id;
      sendBoard({});
    } else {
      if (boardCtl.selectedLeft == null) {
        flashError(card);
        return;
      }
      const p1el = colLeft.querySelector(
        '.match-card[data-id="' + boardCtl.selectedLeft + '"]'
      );
      if (!p1el) {
        clearSelection();
        return;
      }
      checkPair(boardCtl.selectedLeft, p1el, card);
    }
  });

  container.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".match-card");
    if (!card || locked) return;
    dragging = { id: card.dataset.id, side: card.dataset.side, el: card };
    e.dataTransfer.setData("text/plain", card.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  container.addEventListener("dragend", (e) => {
    const card = e.target.closest(".match-card");
    if (card) card.classList.remove("dragging");
    dragging = null;
  });
  container.addEventListener("dragover", (e) => {
    if (e.target.closest(".match-card")) e.preventDefault();
  });
  container.addEventListener("drop", (e) => {
    const card = e.target.closest(".match-card");
    if (!card || !dragging || locked) return;
    e.preventDefault();
    if (card === dragging.el) return;
    const otherSide = dragging.side === "p1" ? "p2" : "p1";
    if (card.dataset.side !== otherSide) {
      flashError(card);
      return;
    }
    if (dragging.side === "p1") checkPair(dragging.id, dragging.el, card);
    else checkPair(card.dataset.id, card, dragging.el);
  });
}

/* --- задание 1.2: вставь пропущенные выражения --- */
function initTask12(l) {
  const pool = $("#chip-pool");
  const gapText = $("#gap-text");
  if (!pool || !gapText) return;
  let draggingChip = null;
  let mistakes = 0;
  let locked = false; // на время подсветки (2 с) интерфейс заморожен

  function doneCount() {
    return gapText.querySelectorAll(".gap.filled").length;
  }

  function totalCount() {
    return gapText.querySelectorAll(".gap").length;
  }

  function correctText(gap) {
    const c = l.chips.find((x) => String(x.id) === String(gap.dataset.answer));
    return c ? c.text : "";
  }

  function clearChipSelection() {
    boardCtl.selectedChip = null;
    $$(".chip.selected", pool).forEach((c) => c.classList.remove("selected"));
  }

  function checkGap(chip, gap) {
    if (locked) return;
    if (gap.classList.contains("filled")) {
      flashError(gap);
      return;
    }
    if (String(gap.dataset.answer) === String(chip.dataset.id)) {
      // верное выражение вставляется сразу, без подсветки
      const text = chip.textContent;
      const chipId = Number(chip.dataset.id);
      gap.textContent = text;
      gap.classList.add("filled");
      chip.remove();
      if (boardCtl.filled.indexOf(chipId) === -1) {
        boardCtl.filled.push(chipId);
      }
      clearChipSelection();
      sendBoard({});
      reportAction(l.id, "1.2", "match", text, {
        done: doneCount(),
        total: totalCount(),
        mistakes: mistakes,
      });
      if (!pool.querySelector(".chip")) {
        completeTask("1.2", "#task12-done");
      }
      return;
    }
    // неверно: пропуск горит красным 2 секунды, затем выбор сбрасывается
    locked = true;
    gap.classList.add("preview-error");
    sendBoard({ flash_target: "bad-gap:" + gap.dataset.answer });
    setTimeout(() => {
      gap.classList.remove("preview-error");
      locked = false;
      mistakes++;
      reportAction(l.id, "1.2", "wrong", chip.textContent, {
        expected: correctText(gap),
        done: doneCount(),
        total: totalCount(),
        mistakes: mistakes,
      });
      clearChipSelection();
      sendBoard({});
    }, PREVIEW_MS);
  }

  pool.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || locked) return;
    const id = Number(chip.dataset.id);
    if (boardCtl.selectedChip === id) {
      clearChipSelection();
      sendBoard({});
      return;
    }
    clearChipSelection();
    chip.classList.add("selected");
    boardCtl.selectedChip = id;
    sendBoard({});
  });

  gapText.addEventListener("click", (e) => {
    const gap = e.target.closest(".gap");
    if (!gap || locked) return;
    if (gap.classList.contains("filled")) {
      // клик по вставленному выражению — вернуть его в список
      const id = Number(gap.dataset.answer);
      pool.appendChild(makeChip(id, gap.textContent));
      gap.textContent = "⋯";
      gap.classList.remove("filled");
      boardCtl.filled = boardCtl.filled.filter((x) => x !== id);
      sendBoard({});
      return;
    }
    if (boardCtl.selectedChip == null) {
      flashError(gap);
      return;
    }
    const chip = pool.querySelector(
      '.chip[data-id="' + boardCtl.selectedChip + '"]'
    );
    if (!chip) {
      clearChipSelection();
      return;
    }
    checkGap(chip, gap);
  });

  pool.addEventListener("dragstart", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || locked) return;
    draggingChip = chip;
    e.dataTransfer.setData("text/plain", chip.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    chip.classList.add("dragging");
  });
  pool.addEventListener("dragend", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) chip.classList.remove("dragging");
    draggingChip = null;
  });
  gapText.addEventListener("dragover", (e) => {
    if (e.target.closest(".gap")) e.preventDefault();
  });
  gapText.addEventListener("drop", (e) => {
    const gap = e.target.closest(".gap");
    if (!gap || !draggingChip || locked) return;
    e.preventDefault();
    checkGap(draggingChip, gap);
    draggingChip = null;
  });
}

/* --- задание 1.3: впиши недостающее слово --- */
function initTask13(l) {
  const root = $("#gap13-text");
  if (!root) return;
  const inputs = $$(".input13", root);
  const total = inputs.length;
  const solved = new Set();
  let mistakes = 0;

  inputs.forEach((inp) => {
    let reportedWrong = false;
    inp.addEventListener("input", () => {
      const val = inp.value.trim().toLowerCase().replace(/\s+/g, " ");
      const answer = String(inp.dataset.answer || "").trim().toLowerCase();
      inp.classList.remove("ok", "bad");
      reportedWrong = false;
      if (!val) return;
      if (val === answer) {
        inp.classList.add("ok");
        inp.readOnly = true;
        if (!solved.has(inp)) {
          solved.add(inp);
          reportAction(l.id, "1.3", "match", inp.value.trim(), {
            done: solved.size,
            total: total,
            mistakes: mistakes,
          });
          if (solved.size === total) completeTask("1.3", "#task13-done");
        }
      } else {
        inp.classList.add("bad");
      }
    });
    // неверный ответ сообщаем учителю один раз — при уходе из поля
    inp.addEventListener("focusout", () => {
      const val = inp.value.trim();
      const answer = String(inp.dataset.answer || "").trim().toLowerCase();
      if (!val || inp.classList.contains("ok") || reportedWrong) return;
      if (val.toLowerCase() !== answer) {
        reportedWrong = true;
        mistakes++;
        reportAction(l.id, "1.3", "wrong", val, {
          expected: inp.dataset.answer || "",
          done: solved.size,
          total: total,
          mistakes: mistakes,
        });
      }
    });
  });
}

/* ============================================================ редактор урока (учитель) */
function parseExpressionsJs(text) {
  const re = /\*\*(.+?)\*\*/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    const segments = raw
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    const p1 = segments[0] || "";
    const p2 = segments[1] || "";
    let hidden = segments[2] || "";
    const full = segments.join(" ");
    if (!hidden) {
      const words = full.split(/\s+/).filter(Boolean);
      hidden = words.length ? words[words.length - 1] : "";
    }
    out.push({ full: full, part1: p1, part2: p2, hidden: hidden });
  }
  return out;
}

function refreshExprPreview() {
  const exprs = parseExpressionsJs($("#lesson-text").value);
  $("#expr-count").textContent = exprs.length ? "— найдено: " + exprs.length : "";
  $("#expr-preview").innerHTML = exprs.length
    ? exprs
        .map(
          (e) =>
            "<li><code>" + esc(e.full) + "</code> → <code>" + esc(e.part1) +
            "</code> + <code>" + esc(e.part2) + "</code> · слово для 1.3: <code>" +
            esc(e.hidden) + "</code></li>"
        )
        .join("")
    : '<li class="muted">Пока ничего не найдено. Выделяйте выражения так: **give|up** (слово для 1.3 — по умолчанию последнее, либо **give|up|give**)</li>';
}

async function openLessonEditor(lessonId) {
  const modal = $("#lesson-modal");
  $("#lesson-modal-error").classList.add("hidden");
  $("#lesson-id").value = "";
  $("#lesson-title").value = "";
  $("#lesson-topic").value = "";
  $("#lesson-video").value = "";
  $("#lesson-text").value = "";
  $("#vis-11").checked = true;
  $("#vis-12").checked = true;
  $("#vis-13").checked = true;
  $("#lesson-modal-title").textContent = "Новый урок";
  if (lessonId) {
    try {
      const l = await api("/api/lessons/" + lessonId);
      $("#lesson-id").value = l.id;
      $("#lesson-title").value = l.title;
      $("#lesson-topic").value = l.topic;
      $("#lesson-video").value = l.video_url || "";
      $("#lesson-text").value = l.text_markup;
      const vis = l.default_visible_tasks || l.visible_tasks || ["1.1", "1.2", "1.3"];
      $("#vis-11").checked = vis.includes("1.1");
      $("#vis-12").checked = vis.includes("1.2");
      $("#vis-13").checked = vis.includes("1.3");
      $("#lesson-modal-title").textContent = "Редактирование урока";
    } catch (e) {
      toast(e.message, true);
      return;
    }
  }
  refreshExprPreview();
  lessonSnapshot = lessonFormState();
  modal.classList.remove("hidden");
}

// снимок полей формы урока — для отслеживания несохранённых изменений
let lessonSnapshot = "";
function lessonFormState() {
  return JSON.stringify({
    title: $("#lesson-title").value,
    topic: $("#lesson-topic").value,
    video: $("#lesson-video").value,
    text: $("#lesson-text").value,
    vis: [$("#vis-11").checked, $("#vis-12").checked, $("#vis-13").checked],
  });
}
function lessonFormDirty() {
  return lessonFormState() !== lessonSnapshot;
}
function tryCloseLessonModal() {
  if (
    lessonFormDirty() &&
    !confirm("Закрыть без сохранения? Все изменения будут потеряны.")
  )
    return;
  $("#lesson-modal").classList.add("hidden");
}

$("#lesson-text").addEventListener("input", refreshExprPreview);
$("#lesson-cancel").addEventListener("click", tryCloseLessonModal);
$("#lesson-modal").addEventListener("click", (e) => {
  if (e.target.id === "lesson-modal") tryCloseLessonModal();
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    !$("#lesson-modal").classList.contains("hidden")
  )
    tryCloseLessonModal();
});

$("#lesson-save").addEventListener("click", async () => {
  const err = $("#lesson-modal-error");
  err.classList.add("hidden");
  const id = $("#lesson-id").value;
  const payload = {
    title: $("#lesson-title").value.trim(),
    topic: $("#lesson-topic").value.trim(),
    text_markup: $("#lesson-text").value,
    video_url: $("#lesson-video").value.trim(),
    visible_tasks: [
      $("#vis-11").checked ? "1.1" : null,
      $("#vis-12").checked ? "1.2" : null,
      $("#vis-13").checked ? "1.3" : null,
    ].filter(Boolean),
  };
  try {
    if (id) {
      await api("/api/lessons/" + id, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/lessons", { method: "POST", body: JSON.stringify(payload) });
    }
    $("#lesson-modal").classList.add("hidden");
    toast("Урок сохранён");
    showLessons();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  }
});





