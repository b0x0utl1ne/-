(() => {
  "use strict";

  const DATA = window.CET6_DATA;
  if (!DATA) {
    document.querySelector("#viewRoot").innerHTML =
      '<div class="empty-state"><h3>数据没有加载</h3><p>请在项目根目录运行 <code>python3 scripts/build_site.py</code> 生成 site/data.js，然后刷新。</p></div>';
    return;
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const WORD_RE = /[A-Za-z]+(?:[-'][A-Za-z]+)*/g;
  const STORAGE_KEY = "cet6-wordbook-v1";
  const EXAM = { year: 2026, month: 12, day: 12, label: "2026-12-12" };
  const VIEWS = ["today", "words", "reading", "review", "plan", "stats"];
  const VIEW_TITLES = {
    today: "今日学习",
    words: "核心词书",
    reading: "真题语境",
    review: "复习与测验",
    plan: "29 天计划",
    stats: "学习数据",
  };

  const CORE = DATA.words
    .filter((word) => word.core)
    .sort((a, b) => (a.daily_rank || 9999) - (b.daily_rank || 9999));
  const WORD_BY_ID = new Map(DATA.words.map((word) => [word.id, word]));
  const ARTICLE_BY_ID = new Map(DATA.articles.map((article) => [article.id, article]));
  const SET_BY_ID = new Map(DATA.sets.map((set) => [set.id, set]));
  const PLAN_BY_DATE = new Map(DATA.plan.map((day) => [day.date, day]));
  const ARTICLE_ORDER = DATA.articles.map((article) => article.id);
  const PAGE_SIZE = 60;

  const ui = {
    view: "today",
    wordFilter: "core",
    wordQuery: "",
    wordSort: "priority",
    wordPage: 1,
    readingArticleId: null,
    openSets: new Set(),
    reviewTab: "due",
    session: null,
    quiz: null,
    searchQuery: "",
    context: null,
    longPressTimer: null,
    longPressFired: false,
  };

  let store = loadStore();

  function defaultStore() {
    return {
      version: 1,
      words: {},
      days: {},
      settings: { theme: "auto", newPerDay: 25, voice: "aria" },
      streak: { current: 0, best: 0, lastStudy: "" },
    };
  }

  function loadStore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return defaultStore();
      return {
        ...defaultStore(),
        ...saved,
        words: saved.words || {},
        days: saved.days || {},
        settings: { ...defaultStore().settings, ...(saved.settings || {}) },
        streak: { ...defaultStore().streak, ...(saved.streak || {}) },
      };
    } catch {
      return defaultStore();
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      toast("浏览器存储已满，先导出备份");
    }
  }

  function todayKey() {
    return localDateKey(new Date());
  }

  function localDateKey(value) {
    const d = value instanceof Date ? value : new Date(value);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function parseDateKey(key) {
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(key, amount) {
    const d = parseDateKey(key);
    d.setDate(d.getDate() + amount);
    return localDateKey(d);
  }

  function dateCN(key) {
    const d = parseDateKey(key);
    const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
  }

  function weekdayCN(key) {
    const d = parseDateKey(key);
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  }

  function daysUntilExam() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const exam = new Date(EXAM.year, EXAM.month - 1, EXAM.day);
    return Math.ceil((exam - start) / 86400000);
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function escAttr(value) {
    return esc(value).replace(/`/g, "&#96;");
  }

  function icon(name, className = "") {
    return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function shorten(value, max = 120) {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
  }

  function wordState(id) {
    return store.words[id] || null;
  }

  function ensureWordState(id) {
    if (!store.words[id]) {
      store.words[id] = {
        status: "new",
        favorite: false,
        due: null,
        interval: 0,
        ease: 2.5,
        lapses: 0,
        reviews: 0,
        learnedOn: null,
        lastReview: null,
      };
    }
    return store.words[id];
  }

  function statusOf(id) {
    return wordState(id)?.status || "new";
  }

  function isFavorite(id) {
    return Boolean(wordState(id)?.favorite);
  }

  function getDay(key = todayKey()) {
    if (!store.days[key]) {
      store.days[key] = {
        newCount: 0,
        reviewCount: 0,
        quizCount: 0,
        readArticles: [],
        marked: 0,
      };
    }
    return store.days[key];
  }

  function touchStudy() {
    const today = todayKey();
    if (store.streak.lastStudy === today) return;
    store.streak.current = store.streak.lastStudy === addDays(today, -1)
      ? (store.streak.current || 0) + 1
      : 1;
    store.streak.lastStudy = today;
    store.streak.best = Math.max(store.streak.best || 0, store.streak.current);
  }

  function markWord(id, status, options = {}) {
    const word = WORD_BY_ID.get(id);
    if (!word) return;
    const state = ensureWordState(id);
    const today = todayKey();
    const previous = state.status;
    const isToggle = previous === status && !options.fromReview;

    if (isToggle) {
      state.status = "new";
      state.due = null;
      state.interval = 0;
      state.lastReview = new Date().toISOString();
      saveStore();
      toast(`已取消「${word.lemma}」的标记`);
      refreshWordUI(id);
      return;
    }

    if (!state.learnedOn) {
      state.learnedOn = today;
      getDay(today).newCount += 1;
    }

    if (status === "familiar") {
      state.interval = state.reviews
        ? Math.min(30, Math.max(7, Math.round((state.interval || 7) * 2.1)))
        : 7;
      state.due = addDays(today, state.interval);
    } else if (status === "fuzzy") {
      state.interval = 3;
      state.due = addDays(today, 3);
    } else if (status === "unfamiliar") {
      state.interval = 1;
      state.due = addDays(today, 1);
      state.lapses = (state.lapses || 0) + 1;
    }
    state.status = status;
    state.reviews = (state.reviews || 0) + 1;
    state.lastReview = new Date().toISOString();
    getDay(today).marked += 1;
    touchStudy();
    saveStore();
    refreshWordUI(id);
    if (status === "familiar") toast(`「${word.lemma}」标为熟悉，${state.interval} 天后再见`);
    if (status === "unfamiliar") toast(`「${word.lemma}」已加入陌生队列`);
    if (status === "fuzzy") toast(`「${word.lemma}」标为模糊，3 天后复习`);
  }

  function toggleFavorite(id) {
    const word = WORD_BY_ID.get(id);
    if (!word) return;
    const state = ensureWordState(id);
    state.favorite = !state.favorite;
    saveStore();
    refreshWordUI(id);
    toast(state.favorite ? `已收藏「${word.lemma}」` : `已取消收藏「${word.lemma}」`);
  }

  function markRead(articleId) {
    const day = getDay();
    const index = day.readArticles.indexOf(articleId);
    if (index >= 0) {
      day.readArticles.splice(index, 1);
      toast("已取消本篇的已读标记");
    } else {
      day.readArticles.push(articleId);
      toast("本篇已标记读完");
    }
    touchStudy();
    saveStore();
    renderPreserveScroll();
  }

  function dueWords() {
    const today = todayKey();
    return DATA.words
      .filter((word) => {
        const state = wordState(word.id);
        return state && state.status !== "new" && state.due && state.due <= today;
      })
      .sort((a, b) => {
        const sa = wordState(a.id);
        const sb = wordState(b.id);
        if ((sa?.due || "") !== (sb?.due || "")) return (sa?.due || "").localeCompare(sb?.due || "");
        return (a.daily_rank || 99999) - (b.daily_rank || 99999);
      });
  }

  function newQueue() {
    return CORE.filter((word) => statusOf(word.id) === "new");
  }

  function todayPlan() {
    const today = todayKey();
    if (PLAN_BY_DATE.has(today)) return PLAN_BY_DATE.get(today);
    const upcoming = DATA.plan.find((day) => day.date >= today);
    return upcoming || DATA.plan[DATA.plan.length - 1];
  }

  function dailyNewTarget() {
    const plan = todayPlan();
    if (!plan) return store.settings.newPerDay || 25;
    if (plan.kind === "study") return store.settings.newPerDay || 25;
    return plan.new_target || 0;
  }

  function todayStats() {
    const day = getDay();
    const learnedToday = CORE.filter((word) => wordState(word.id)?.learnedOn === todayKey()).length;
    return {
      newDone: Math.max(day.newCount || 0, learnedToday),
      reviewDone: day.reviewCount || 0,
      quizDone: day.quizCount || 0,
      readDone: (day.readArticles || []).length,
    };
  }

  function progressPercent(parts) {
    if (!parts.length) return 0;
    return Math.round((parts.filter(Boolean).length / parts.length) * 100);
  }

  function getArticle(id) {
    return ARTICLE_BY_ID.get(id) || null;
  }

  function getWordByForm(form) {
    const normalized = String(form || "").toLowerCase().replace(/[’']/g, "'");
    const id = DATA.forms?.[normalized] || (WORD_BY_ID.has(normalized) ? normalized : null);
    return id ? WORD_BY_ID.get(id) : null;
  }

  function stateClass(id) {
    const state = wordState(id);
    const classes = [];
    if (state?.status === "familiar") classes.push("familiar");
    if (state?.status === "unfamiliar") classes.push("unfamiliar");
    if (state?.status === "fuzzy") classes.push("fuzzy");
    if (state?.favorite) classes.push("favorite");
    return classes.join(" ");
  }

  function statusPill(id) {
    const status = statusOf(id);
    if (status === "familiar") return `<span class="pill pill-green">${icon("check")} 熟悉</span>`;
    if (status === "unfamiliar") return `<span class="pill pill-red">${icon("x")} 陌生</span>`;
    if (status === "fuzzy") return `<span class="pill pill-blue">模糊</span>`;
    return `<span class="pill">未学</span>`;
  }

  function highlight(text, surface) {
    if (!surface) return esc(text);
    const source = String(text);
    const index = source.toLowerCase().indexOf(String(surface).toLowerCase());
    if (index < 0) return esc(source);
    return `${esc(source.slice(0, index))}<mark>${esc(source.slice(index, index + surface.length))}</mark>${esc(source.slice(index + surface.length))}`;
  }

  function wrapWords(text) {
    let output = "";
    let last = 0;
    const source = String(text || "");
    WORD_RE.lastIndex = 0;
    let match;
    while ((match = WORD_RE.exec(source))) {
      output += esc(source.slice(last, match.index));
      const original = match[0];
      const form = original.toLowerCase().replace(/[’']/g, "'");
      const id = DATA.forms?.[form] || (WORD_BY_ID.has(form) ? form : null);
      if (id && WORD_BY_ID.has(id)) {
        const classes = ["w", stateClass(id)].filter(Boolean).join(" ");
        output += `<span class="${classes}" data-lemma="${escAttr(id)}" data-form="${escAttr(form)}">${esc(original)}</span>`;
      } else {
        output += esc(original);
      }
      last = match.index + original.length;
    }
    output += esc(source.slice(last));
    return output;
  }

  function ctxSource(context) {
    if (!context) return "";
    return `${context.set_label || ""}${context.section ? ` · ${context.section}` : ""}`;
  }

  function viewHead(kicker, title, subtitle = "", action = "") {
    return `<div class="section-head">
      <div><div class="kicker">${esc(kicker)}</div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div>
      ${action}
    </div>`;
  }

  function route() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, query = ""] = raw.split("?");
    const view = VIEWS.includes(path) ? path : "today";
    const changed = view !== ui.view;
    ui.view = view;
    if (view === "reading") {
      const params = new URLSearchParams(query);
      if (params.get("article") && ARTICLE_BY_ID.has(params.get("article"))) {
        ui.readingArticleId = params.get("article");
      }
    }
    if (view !== "review") {
      ui.session = null;
      ui.quiz = null;
    }
    render();
    if (changed) window.scrollTo({ top: 0, behavior: "auto" });
  }

  function go(view) {
    const next = `#/${view}`;
    if (location.hash === next) {
      ui.view = view;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      location.hash = next;
    }
  }

  function openArticle(id) {
    if (!ARTICLE_BY_ID.has(id)) return;
    ui.readingArticleId = id;
    location.hash = `#/reading?article=${encodeURIComponent(id)}`;
    if (location.hash === `#/reading?article=${encodeURIComponent(id)}` && ui.view !== "reading") {
      ui.view = "reading";
      render();
    }
  }

  function updateChrome() {
    const days = daysUntilExam();
    const dayText = days > 0 ? String(days) : "0";
    $("#topDays").textContent = dayText;
    $("#sideDays").textContent = dayText;
    $("#pageTitle").textContent = VIEW_TITLES[ui.view] || "今日学习";
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.nav === ui.view));
    const due = dueWords().length;
    const badge = $("#navDue");
    badge.textContent = due ? String(due) : "";
    badge.dataset.zero = due ? "0" : "1";
    const reviewBadge = $("#navReview");
    reviewBadge.textContent = due ? String(due) : "";
    reviewBadge.dataset.zero = due ? "0" : "1";
    document.title = `${VIEW_TITLES[ui.view] || "今日学习"} · CET-6 12套一卷语境词书`;
  }

  function renderPreserveScroll() {
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y, behavior: "auto" });
  }

  function render() {
    updateChrome();
    const root = $("#viewRoot");
    root.classList.remove("view-enter");
    if (ui.view === "today") root.innerHTML = renderToday();
    if (ui.view === "words") root.innerHTML = renderWords();
    if (ui.view === "reading") root.innerHTML = renderReading();
    if (ui.view === "review") root.innerHTML = renderReview();
    if (ui.view === "plan") root.innerHTML = renderPlan();
    if (ui.view === "stats") root.innerHTML = renderStats();
    void root.offsetWidth;
    root.classList.add("view-enter");
    bindViewInputs();
    updateChrome();
  }

  function renderToday() {
    const plan = todayPlan();
    const due = dueWords();
    const queue = newQueue();
    const target = dailyNewTarget();
    const newCount = Math.min(target, queue.length);
    const stats = todayStats();
    const readTarget = plan?.article_slugs?.length || 0;
    const readDone = readTarget ? Math.min(stats.readDone, readTarget) : 0;
    const reviewDone = due.length === 0;
    const newDone = newCount === 0;
    const readingDone = readTarget === 0 || readDone >= readTarget;
    const pct = progressPercent([reviewDone, newDone, readingDone]);
    const days = daysUntilExam();
    const primaryQueue = newCount ? queue : due;
    const featured = primaryQueue[0] || CORE[0];
    const featuredContext = featured?.context;
    const today = todayKey();
    const week = Array.from({ length: 7 }, (_, index) => {
      const date = addDays(today, index - 6);
      const day = store.days[date];
      const activity = day ? (day.newCount || 0) + (day.reviewCount || 0) + (day.quizCount || 0) + (day.readArticles?.length || 0) : 0;
      return { date, activity };
    });

    const taskRows = [
      {
        icon: "cards",
        tone: "accent",
        title: "到期复习",
        sub: due.length ? `最早到期 ${due[0].due} · 先回忆，再看释义` : "今天没有到期词，保持住",
        count: due.length,
        unit: "词",
        action: due.length
          ? `<button class="btn btn-primary btn-sm" data-action="start-review">开始复习</button>`
          : `<span class="pill pill-green">${icon("check")} 已清空</span>`,
      },
      {
        icon: "book",
        tone: "green",
        title: "今日新词",
        sub: newCount ? `目标 ${target} 个 · 来自高频与精读推荐` : (target ? "今日新词已完成" : "今天不排新词"),
        count: newCount,
        unit: "词",
        action: newCount
          ? `<button class="btn btn-soft btn-sm" data-action="start-new">学新词</button>`
          : `<span class="pill pill-green">${icon("check")} 已完成</span>`,
      },
      {
        icon: "text",
        tone: "gold",
        title: "语境精读",
        sub: plan?.article_slugs?.length ? `${plan.set_label} · ${plan.part} 组 · ${readTarget} 篇` : "今天只复习，不开新文章",
        count: readDone,
        unit: readTarget ? `/ ${readTarget} 篇` : "篇",
        action: readTarget
          ? `<button class="btn btn-soft btn-sm" data-action="open-today-reading">去精读</button>`
          : `<button class="btn btn-ghost btn-sm" data-action="start-review">去复习</button>`,
      },
    ];

    const previewWords = (newCount ? queue : due.length ? due : CORE).slice(0, 6);
    const previewHtml = previewWords.map((word) => `
      <button class="mini-word" data-action="open-word" data-word="${escAttr(word.id)}">
        <strong>${esc(word.lemma)}</strong>
        <span class="ipa">${esc(word.phonetic)}</span>
        <p>${esc(shorten(word.definition, 62))}</p>
      </button>
    `).join("");

    const quote = featuredContext ? `
      <article class="card quote-card">
        <div class="kicker">TODAY'S SENTENCE · 今日一句</div>
        <p class="quote-text">${highlight(featuredContext.text, featuredContext.surface)}</p>
        <div class="quote-meta">
          <span>${esc(ctxSource(featuredContext))}${featuredContext.article_title ? ` · ${esc(featuredContext.article_title)}` : ""}</span>
          <button type="button" data-action="open-word" data-word="${escAttr(featured.id)}">${esc(featured.lemma)} →</button>
        </div>
      </article>
    ` : "";

    return `
      <section class="hero">
        <div class="hero-copy">
          <div class="kicker">${DATA.meta.sets} SETS · ${DATA.meta.corpus_words.toLocaleString()} WORDS · ${CORE.length} CORE</div>
          <h1>把真题读成<br><em>你的词库。</em></h1>
          <p>不从字母表开始。先用真题语境认出词，再让熟悉、陌生、收藏决定下一次什么时候出现。今天只做三件事：复习到期词、${newCount ? `学 ${newCount} 个新词` : "不排新词"}、读 ${readTarget || 1} 篇原文。</p>
          <div class="hero-actions">
            <button class="btn btn-primary btn-lg" data-action="${newCount ? "start-new" : "start-review"}">
              ${icon("arrow")} ${newCount ? "开始今天的新词" : "进入复习"}
            </button>
            <button class="btn btn-ghost btn-lg" data-action="${readTarget ? "open-today-reading" : "go"}" ${readTarget ? "" : 'data-view="words"'}>
              ${icon("text")} 打开语境精读
            </button>
          </div>
          <div class="hero-meta">
            <span>${icon("calendar")} ${esc(plan?.date || today)} · ${esc(plan?.set_label || "阶段复习")}</span>
            <span>${icon("clock")} 建议 <b>60–80</b> 分钟</span>
            <span>${icon("flame")} 连续 <b>${store.streak.current || 0}</b> 天</span>
          </div>
        </div>
        <div class="hero-side">
          <div class="countdown-card">
            <small>DISTANCE TO CET-6</small>
            <div class="countdown-big"><b>${Math.max(0, days)}</b><span>天</span></div>
            <div class="countdown-date">2026.12.12 · 15:00</div>
            <div class="countdown-foot">${days <= 0 ? "今天考试，稳住" : `第 ${plan?.day || 1} 天 · 还有 ${DATA.plan.length - (plan?.day || 1)} 个学习日`}</div>
          </div>
        </div>
      </section>

      <div class="dashboard-grid">
        <div class="stack">
          <section class="card">
            <div class="card-head">
              <div><h3>今天的三件事</h3><p>${esc(dateCN(today))} · ${esc(plan?.focus || "保持复习节奏")}</p></div>
              <span class="pill pill-ink">${esc(plan?.kind === "study" ? `第 ${plan.part} 组` : plan?.set_label || "今日")}</span>
            </div>
            <div class="task-list">
              ${taskRows.map((task) => `
                <div class="task-row">
                  <div class="task-icon ${task.tone}">${icon(task.icon)}</div>
                  <div>
                    <div class="task-title">${task.title}</div>
                    <div class="task-sub">${task.sub}</div>
                  </div>
                  <div class="task-action">
                    <span class="task-count">${task.count}<small>${task.unit}</small></span>
                    ${task.action}
                  </div>
                </div>
              `).join("")}
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <div><h3>先看这些词</h3><p>${queue.length ? "按今日优先级排在最前" : "没有新词时，从到期词开始"}</p></div>
              <button class="link-btn" data-action="go" data-view="words">打开词书 →</button>
            </div>
            <div class="today-words">${previewHtml}</div>
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <div class="today-progress">
              <div class="progress-ring" style="--p:${pct}"><b>${pct}<small>%</small></b></div>
              <div class="progress-copy">
                <h3>${pct >= 100 ? "今天的闭环完成了" : "把今天做完再走"}</h3>
                <p>复习 ${stats.reviewDone} 次 · 新词 ${stats.newDone} 个 · 精读 ${stats.readDone} 篇</p>
                <div class="mini-stats">
                  <div class="mini-stat"><b>${due.length}</b><span>到期词</span></div>
                  <div class="mini-stat"><b>${newCount}</b><span>今日新词</span></div>
                  <div class="mini-stat"><b>${readDone}</b><span>已读文章</span></div>
                </div>
              </div>
            </div>
          </section>
          ${quote}
          <section class="card">
            <div class="card-head"><div><h3>最后 7 天</h3><p>有学习记录的日子会亮起</p></div><span class="pill">${icon("flame")} ${store.streak.best || 0} 天最佳</span></div>
            <div class="week-strip">
              ${week.map((day) => `
                <div class="week-day ${day.date === today ? "today" : day.activity ? "done" : ""}">
                  <span>${weekdayCN(day.date).slice(-1)}</span>
                  <b>${parseDateKey(day.date).getDate()}</b>
                </div>
              `).join("")}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function wordCard(word) {
    const state = wordState(word.id);
    const status = state?.status || "new";
    const context = word.context;
    const source = context ? ctxSource(context) : "真题补充";
    return `
      <article class="word-card ${status !== "new" ? `status-${status}` : ""} ${state?.favorite ? "favorite" : ""}">
        <div class="word-card-top">
          <div class="word-title-row">
            <button class="word-title" type="button" data-action="open-word" data-word="${escAttr(word.id)}" data-context="wordbook">${esc(word.lemma)}</button>
            <div class="word-meta">
              <span class="ipa">${esc(word.phonetic)}</span>
              ${word.cefr ? `<span class="pill">CEFR ${esc(word.cefr)}</span>` : ""}
              ${word.teacher_pick ? `<span class="pill pill-gold">精读推荐</span>` : ""}
              ${word.core ? `<span class="pill pill-ink">核心 ${word.daily_rank}</span>` : `<span class="pill">扩展词</span>`}
            </div>
          </div>
          <div class="word-actions">
            <button class="icon-btn" type="button" data-action="speak-word" data-word="${escAttr(word.id)}" aria-label="朗读 ${escAttr(word.lemma)}" title="朗读">${icon("volume")}</button>
            <button class="icon-btn ${state?.favorite ? "fav-on" : ""}" type="button" data-action="toggle-fav" data-word="${escAttr(word.id)}" aria-label="收藏" title="收藏">${icon("star")}</button>
          </div>
        </div>
        <p class="word-def">${esc(word.definition)}</p>
        ${context ? `<p class="word-context">${highlight(shorten(context.text, 230), context.surface)}</p>` : ""}
        <div class="word-card-foot">
          ${statusPill(word.id)}
          <span class="pill">出现 ${word.doc_freq} 套</span>
          <span class="source">${esc(source)}</span>
        </div>
      </article>
    `;
  }

  function filteredWords() {
    const query = ui.wordQuery.trim().toLowerCase();
    let words;
    if (ui.wordFilter === "core") words = CORE.slice();
    else if (ui.wordFilter === "all") words = DATA.words.slice();
    else if (ui.wordFilter === "unfamiliar") words = DATA.words.filter((word) => statusOf(word.id) === "unfamiliar");
    else if (ui.wordFilter === "familiar") words = DATA.words.filter((word) => statusOf(word.id) === "familiar");
    else if (ui.wordFilter === "favorite") words = DATA.words.filter((word) => isFavorite(word.id));
    else if (ui.wordFilter === "picks") words = DATA.words.filter((word) => word.teacher_pick);
    else words = CORE.slice();

    if (query) {
      words = words.filter((word) => {
        const haystack = `${word.lemma} ${word.definition} ${word.context?.text || ""} ${word.context?.set_label || ""}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    if (ui.wordSort === "alpha") words.sort((a, b) => a.lemma.localeCompare(b.lemma));
    else if (ui.wordSort === "freq") words.sort((a, b) => b.doc_freq - a.doc_freq || b.article_freq - a.article_freq || a.lemma.localeCompare(b.lemma));
    else {
      words.sort((a, b) => {
        if (a.core !== b.core) return a.core ? -1 : 1;
        if (a.core && b.core) return (a.daily_rank || 99999) - (b.daily_rank || 99999);
        return b.score - a.score || a.lemma.localeCompare(b.lemma);
      });
    }
    return words;
  }

  function renderWords() {
    const words = filteredWords();
    const visible = words.slice(0, ui.wordPage * PAGE_SIZE);
    const filters = [
      ["core", "核心 700"],
      ["all", `全部 ${DATA.meta.word_count.toLocaleString()}`],
      ["unfamiliar", "陌生"],
      ["familiar", "熟悉"],
      ["favorite", "收藏"],
      ["picks", "精读推荐"],
    ];
    return `
      ${viewHead("WORD BOOK · 词书", "核心词书", `${CORE.length} 个核心词，全部带音标、中文释义与真题语境；右击任何词可标记。`, `<button class="btn btn-soft btn-sm" data-action="go" data-view="reading">${icon("text")} 去语境里学</button>`)}
      <div class="toolbar">
        <div class="filter-group">
          ${filters.map(([value, label]) => `<button class="filter-chip ${ui.wordFilter === value ? "active" : ""}" type="button" data-action="word-filter" data-filter="${value}">${label}</button>`).join("")}
        </div>
        <div class="toolbar-spacer"></div>
        <label class="inline-search">${icon("search")}<input type="search" data-role="word-search" value="${escAttr(ui.wordQuery)}" placeholder="搜词、释义或年份" aria-label="搜索词书"></label>
        <select class="select" data-role="word-sort" aria-label="排序">
          <option value="priority" ${ui.wordSort === "priority" ? "selected" : ""}>按优先级</option>
          <option value="freq" ${ui.wordSort === "freq" ? "selected" : ""}>按出现套数</option>
          <option value="alpha" ${ui.wordSort === "alpha" ? "selected" : ""}>按字母</option>
        </select>
      </div>
      <div class="list-meta">
        <span>共 <b>${words.length}</b> 个词 · 显示 ${visible.length}</span>
        <span>${ui.wordQuery ? `搜索：${esc(ui.wordQuery)}` : "提示：右击词条或原文单词可打开快捷菜单"}</span>
      </div>
      <div class="word-list">${visible.map(wordCard).join("")}</div>
      ${visible.length < words.length ? `<div class="load-more-wrap"><button class="btn btn-soft" data-action="load-more">再显示 ${Math.min(PAGE_SIZE, words.length - visible.length)} 个</button></div>` : ""}
      ${visible.length === 0 ? `<div class="empty-state"><div class="empty-icon">${icon("search")}</div><h3>没有匹配的词</h3><p>换个筛选条件，或搜索中文释义。</p></div>` : ""}
    `;
  }

  function articleGroupButton(set, articles, current) {
    const open = ui.openSets.has(set.id) || current?.set_id === set.id;
    return `
      <div class="set-group ${open ? "open" : ""}">
        <button class="set-toggle" type="button" data-action="toggle-set" data-set="${escAttr(set.id)}">
          <span class="dot"></span><b>${esc(set.label)}</b><span>${articles.length} 篇</span>${icon("chevron")}
        </button>
        <div class="article-nav">
          ${articles.map((article) => `
            <button class="article-link ${current?.id === article.id ? "active" : ""}" type="button" data-action="open-article" data-article="${escAttr(article.id)}">
              <span class="dot"></span>
              <span>${esc(articleTitle(article))}<small>${esc(article.section)} · ${article.word_count} 词</small></span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function readingCurrent() {
    let id = ui.readingArticleId;
    const plan = todayPlan();
    if (!id && plan?.article_slugs?.length) {
      id = `${plan.set_id}/${plan.article_slugs[0]}`;
    }
    if (!id || !ARTICLE_BY_ID.has(id)) {
      id = DATA.articles[0]?.id;
    }
    return getArticle(id);
  }

  function articleTitle(article) {
    const title = String(article?.title || "");
    if (!title || title.includes("Part ") || (title.includes("英语六级真题") && title.startsWith("20"))) {
      return article?.section || "真题原文";
    }
    return title;
  }

  function renderReading() {
    const current = readingCurrent();
    if (!current) return `<div class="empty-state"><h3>没有可读文章</h3></div>`;
    ui.readingArticleId = current.id;
    ui.openSets.add(current.set_id);
    const set = SET_BY_ID.get(current.set_id);
    const articlesBySet = DATA.sets.map((item) => ({
      set: item,
      articles: DATA.articles.filter((article) => article.set_id === item.id),
    }));
    const index = ARTICLE_ORDER.indexOf(current.id);
    const prev = index > 0 ? getArticle(ARTICLE_ORDER[index - 1]) : null;
    const next = index < ARTICLE_ORDER.length - 1 ? getArticle(ARTICLE_ORDER[index + 1]) : null;
    const read = (store.days[todayKey()]?.readArticles || []).includes(current.id);
    const keyWords = (current.key_words || [])
      .map((form) => getWordByForm(form))
      .filter(Boolean)
      .filter((word, idx, list) => list.findIndex((item) => item.id === word.id) === idx)
      .slice(0, 10);
    const mobileSelect = `
      <div class="reading-mobile-nav">
        <label class="inline-search" style="min-width:0;flex:1">${icon("text")}<select class="select" data-role="article-select" aria-label="选择文章" style="border:0;background:transparent;height:auto;padding:0;width:100%">
          ${articlesBySet.map(({ set: s, articles: list }) => `<optgroup label="${escAttr(s.label)}">${list.map((article) => `<option value="${escAttr(article.id)}" ${article.id === current.id ? "selected" : ""}>${esc(articleTitle(article))}</option>`).join("")}</optgroup>`).join("")}
        </select></label>
        <button class="icon-btn" type="button" data-action="toggle-paper-nav" aria-label="打开文章目录">${icon("menu")}</button>
      </div>
    `;
    return `
      ${viewHead("CONTEXT LAB · 语境精读", "先读真题，再收词", "右击任意单词：翻译 / 熟悉 / 陌生 / 收藏；单击也能打开完整词卡。", `<button class="btn btn-soft btn-sm" data-action="go" data-view="words">${icon("book")} 回词书</button>`)}
      ${mobileSelect}
      <div class="reading-shell">
        <aside class="paper-nav" id="paperNav">
          <div class="paper-nav-head"><h3>12 次考试</h3><p>${DATA.meta.articles} 篇 · ${DATA.meta.corpus_words.toLocaleString()} 词原文</p></div>
          ${articlesBySet.map(({ set: item, articles: list }) => articleGroupButton(item, list, current)).join("")}
        </aside>
        <section class="article-shell">
          <div class="article-toolbar">
            <div class="crumbs"><b>${esc(set?.label || "")}</b> / ${esc(current.part || current.section)} / ${esc(current.section)}</div>
            <div class="article-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-action="prev-article" ${prev ? "" : "disabled"}>${prev ? `← ${esc(shorten(prev.section, 18))}` : "已是第一篇"}</button>
              <button class="btn btn-ghost btn-sm" type="button" data-action="next-article" ${next ? "" : "disabled"}>${next ? `${esc(shorten(next.section, 18))} →` : "已是最后一篇"}</button>
            </div>
          </div>
          <article class="article-paper">
            <div class="article-kicker">
              <span class="pill pill-gold">${esc(current.section)}</span>
              ${current.cefr ? `<span class="pill">CEFR ${esc(current.cefr)}</span>` : ""}
              ${current.genre ? `<span class="pill">${esc(current.genre)}</span>` : ""}
              <span class="pill">${current.word_count} 词</span>
              ${read ? `<span class="pill pill-green">${icon("check")} 今日已读</span>` : ""}
            </div>
            <h2 class="article-title">${esc(articleTitle(current))}</h2>
            <p class="article-byline">${esc(current.part || "")} · ${esc(set?.label || "")} · ${esc(current.source_note ? "真题原文" : "文章原文")}</p>
            ${current.source_note ? `<p class="article-source-note">${esc(current.source_note)}</p>` : ""}
            ${keyWords.length ? `<div class="key-words"><span>本篇精读推荐</span>${keyWords.map((word) => `<button class="key-word" type="button" data-action="open-word" data-word="${escAttr(word.id)}" data-context="article">${esc(word.lemma)} <span class="ipa">${esc(word.phonetic)}</span></button>`).join("")}</div>` : ""}
            <div class="article-body ${current.section.startsWith("听力") ? "listening" : ""}">
              ${current.paragraphs.map((paragraph) => `<p>${wrapWords(paragraph)}</p>`).join("")}
            </div>
            <div class="article-foot">
              <span>${esc(set?.label || "")} · ${esc(current.section)} · 原文来自 ${esc(current.url || "真题语料")}</span>
              <div class="actions">
                <button class="btn btn-soft btn-sm" type="button" data-action="mark-read" data-article="${escAttr(current.id)}">${read ? `${icon("check")} 取消已读` : `${icon("eye")} 标记已读`}</button>
                <a class="btn btn-ghost btn-sm" href="${escAttr(current.url)}" target="_blank" rel="noopener">原网页 ↗</a>
              </div>
            </div>
          </article>
          <div class="reading-tip">${icon("quote")} 选中语境里最打动你的那句话，记住词在句中的位置，而不是只记中文。</div>
        </section>
      </div>
    `;
  }

  function startReview(mode = "due") {
    ui.reviewTab = mode;
    ui.view = "review";
    location.hash = "#/review";
    const queue = mode === "new" ? newQueue().slice(0, dailyNewTarget()) : dueWords();
    if (mode === "quiz") {
      startQuiz();
      return;
    }
    if (!queue.length) {
      ui.session = null;
      render();
      return;
    }
    ui.session = {
      mode,
      queue,
      index: 0,
      revealed: false,
      stats: { remember: 0, fuzzy: 0, forget: 0 },
    };
    ui.quiz = null;
    if (ui.view === "review") render();
  }

  function renderReview() {
    const tabs = [
      ["due", "到期复习", dueWords().length],
      ["new", "今日新词", Math.min(dailyNewTarget(), newQueue().length)],
      ["quiz", "语境测验", "10"],
    ];
    const tabHtml = tabs.map(([key, label, count]) => `<button class="review-tab ${ui.reviewTab === key ? "active" : ""}" type="button" data-action="review-tab" data-tab="${key}">${label} <span class="small muted">${count}</span></button>`).join("");
    let body;
    if (ui.reviewTab === "quiz") body = renderQuiz();
    else body = renderFlashSession();
    return `
      ${viewHead("RECALL · 主动回忆", "复习与测验", "先回忆，再揭晓。答错不是失败，是把下一次间隔拉回今天。")}
      <div class="review-shell">
        <div class="review-tabs">${tabHtml}</div>
        ${body}
      </div>
    `;
  }

  function sessionProgress(session) {
    const total = session.queue.length;
    const index = Math.min(session.index, total);
    return { total, index, percent: total ? Math.round((index / total) * 100) : 0 };
  }

  function renderFlashSession() {
    if (!ui.session || ui.session.mode !== ui.reviewTab) return renderReviewStart();
    const session = ui.session;
    const progress = sessionProgress(session);
    if (session.index >= session.queue.length) return renderSessionComplete(session);
    const word = session.queue[session.index];
    const state = wordState(word.id);
    const context = word.context;
    return `
      <div class="review-progress"><span>${session.mode === "new" ? "新词" : "到期"} ${session.index + 1} / ${session.queue.length}</span><div class="review-bar"><span style="width:${progress.percent}%"></span></div><span>${session.mode === "new" ? "先猜，再揭晓" : "诚实地回忆"}</span></div>
      <article class="flashcard">
        <div class="flashcard-top">
          <div>
            <h2 class="flashcard-word">${esc(word.lemma)}</h2>
            <div class="flashcard-ipa">${esc(word.phonetic)} ${state?.due ? `<span class="pill">下次 ${esc(state.due)}</span>` : ""}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="icon-btn" type="button" data-action="speak-word" data-word="${escAttr(word.id)}" aria-label="朗读">${icon("volume")}</button>
            <button class="icon-btn ${state?.favorite ? "fav-on" : ""}" type="button" data-action="toggle-fav" data-word="${escAttr(word.id)}" aria-label="收藏">${icon("star")}</button>
          </div>
        </div>
        <div class="flashcard-center">
          ${session.revealed ? `
            <p class="flashcard-def">${esc(word.definition)}</p>
            ${context ? `<blockquote class="flashcard-context">${highlight(context.text, context.surface)}<div class="flashcard-source">${esc(ctxSource(context))}${context.article_title ? ` · ${esc(context.article_title)}` : ""}</div></blockquote>` : ""}
            <div class="kbd-hint"><span><kbd>1</kbd> 忘记</span><span><kbd>2</kbd> 模糊</span><span><kbd>3</kbd> 记得</span></div>
          ` : `
            <p class="flashcard-hint">先在脑中说出意思，再按空格揭晓。不要靠眼熟。</p>
            <button class="btn btn-primary btn-lg reveal-btn" type="button" data-action="reveal-card">${icon("eye")} 显示释义</button>
          `}
        </div>
        <div class="flashcard-actions">
          ${session.revealed ? `
            <button class="btn btn-red btn-lg" type="button" data-action="grade-card" data-grade="forget">忘记 <span class="small">1</span></button>
            <button class="btn btn-soft btn-lg" type="button" data-action="grade-card" data-grade="fuzzy">模糊 <span class="small">2</span></button>
            <button class="btn btn-green btn-lg" type="button" data-action="grade-card" data-grade="remember">记得 <span class="small">3</span></button>
          ` : `<button class="btn btn-ghost btn-lg" type="button" data-action="skip-card">先跳过</button>`}
        </div>
      </article>
    `;
  }

  function renderReviewStart() {
    const due = dueWords();
    const newCount = Math.min(dailyNewTarget(), newQueue().length);
    if (ui.reviewTab === "new") {
      if (newCount === 0) {
        return `
          <div class="empty-state">
            <div class="empty-icon">${icon("check")}</div>
            <h3>今天不排新词</h3>
            <p>${todayPlan()?.kind === "mock" || todayPlan()?.kind === "sprint" ? "模考/考前日只做复盘与到期复习。" : "核心词已经全部进入学习队列，继续复习到期词即可。"}</p>
            <button class="btn btn-primary btn-lg" type="button" data-action="start-review">${icon("cards")} 去复习到期词</button>
          </div>
        `;
      }
      return `
        <div class="empty-state">
          <div class="empty-icon">${icon("book")}</div>
          <h3>今日新词池 ${newCount} 个</h3>
          <p>新词来自真题精读推荐、B2/C1 和跨套复现词。先按顺序过一轮，不要求一次背会。</p>
          <button class="btn btn-primary btn-lg" type="button" data-action="start-new">${icon("arrow")} 开始 ${newCount} 个新词</button>
        </div>
      `;
    }
    return `
      <div class="empty-state">
        <div class="empty-icon">${icon("cards")}</div>
        <h3>到期复习 ${due.length} 个</h3>
        <p>${due.length ? "这些词已经到复习点。先不看释义，回忆，再给自己评分。" : "今天没有到期词。可以学新词，或者做一组语境测验。"}</p>
        <button class="btn btn-primary btn-lg" type="button" data-action="${due.length ? "start-review" : "start-quiz"}">${due.length ? `${icon("cards")} 开始复习` : `${icon("text")} 做一组语境测验`}</button>
      </div>
    `;
  }

  function renderSessionComplete(session) {
    const total = session.queue.length;
    const remember = session.stats.remember;
    const fuzzy = session.stats.fuzzy;
    const forget = session.stats.forget;
    return `
      <div class="card quiz-card quiz-result">
        <div class="score">${Math.round((remember / total) * 100)}<span style="font-size:18px">%</span></div>
        <h3>这一轮走完了</h3>
        <p>记得 ${remember} · 模糊 ${fuzzy} · 忘记 ${forget}。忘记的词已自动回到 1 天后。</p>
        <div class="hero-actions" style="justify-content:center">
          <button class="btn btn-primary" type="button" data-action="${session.mode === "new" ? "start-new" : "start-review"}">再一轮</button>
          <button class="btn btn-soft" type="button" data-action="go" data-view="words">回词书</button>
          <button class="btn btn-ghost" type="button" data-action="go" data-view="today">回今日</button>
        </div>
      </div>
    `;
  }

  function gradeCard(grade) {
    const session = ui.session;
    if (!session || !session.revealed) return;
    const word = session.queue[session.index];
    const status = grade === "remember" ? "familiar" : grade === "fuzzy" ? "fuzzy" : "unfamiliar";
    const before = wordState(word.id);
    const isNew = !before || !before.learnedOn;
    markWord(word.id, status, { fromReview: true });
    if (!isNew) {
      getDay().reviewCount += 1;
      saveStore();
    }
    session.stats[grade] += 1;
    session.index += 1;
    session.revealed = false;
    render();
  }

  function skipCard() {
    if (!ui.session) return;
    ui.session.index += 1;
    ui.session.revealed = false;
    render();
  }

  function startQuiz() {
    const candidates = CORE.filter((word) => word.context?.text && word.context.surface && CONTEXT_INCLUDES(word.context.text, word.context.surface));
    const shuffled = shuffle(candidates).slice(0, 10);
    ui.quiz = {
      questions: shuffled.map((word) => {
        const sameLevel = CORE.filter((item) => item.id !== word.id && item.cefr && item.cefr === word.cefr);
        const pool = sameLevel.length >= 6 ? sameLevel : CORE.filter((item) => item.id !== word.id);
        const distractors = shuffle(pool).slice(0, 3).map((item) => item.lemma);
        return {
          word,
          sentence: word.context.text,
          surface: word.context.surface,
          options: shuffle([word.lemma, ...distractors]),
          answer: word.lemma,
          selected: null,
        };
      }),
      index: 0,
      score: 0,
      answered: false,
    };
    ui.reviewTab = "quiz";
    ui.session = null;
    if (ui.view === "review") render();
  }

  function CONTEXT_INCLUDES(text, surface) {
    return String(text).toLowerCase().includes(String(surface).toLowerCase());
  }

  function renderQuiz() {
    if (!ui.quiz) {
      return `<div class="empty-state"><div class="empty-icon">${icon("text")}</div><h3>语境测验 · 10 题</h3><p>从真题句子里挖掉一个词，让你从四个选项里选。不是拼记忆，是练“在句中认出它”。</p><button class="btn btn-primary btn-lg" type="button" data-action="start-quiz">${icon("arrow")} 开始测验</button></div>`;
    }
    const quiz = ui.quiz;
    if (quiz.index >= quiz.questions.length) {
      return `
        <div class="card quiz-card quiz-result">
          <div class="score">${quiz.score}<span style="font-size:18px">/10</span></div>
          <h3>${quiz.score >= 8 ? "语境识别很稳" : quiz.score >= 6 ? "基础有了，再练一轮" : "先回到词卡"}</h3>
          <p>做错的词会留在“陌生/模糊”的复习路径里，稍后右键或词书里继续标记。</p>
          <div class="hero-actions" style="justify-content:center">
            <button class="btn btn-primary" type="button" data-action="start-quiz">再来一组</button>
            <button class="btn btn-soft" type="button" data-action="go" data-view="words">回词书</button>
          </div>
        </div>
      `;
    }
    const question = quiz.questions[quiz.index];
    const sentence = blankSurface(question.sentence, question.surface);
    const feedback = quiz.answered ? `
      <div class="quiz-feedback ${question.selected === question.answer ? "correct" : "wrong"}">
        <b>${question.selected === question.answer ? "对了。" : `正确词是 ${esc(question.answer)}。`}</b>
        ${esc(question.word.definition)}
        ${question.word.context ? `<br><span class="muted">${esc(ctxSource(question.word.context))} · ${esc(shorten(question.word.context.text, 150))}</span>` : ""}
      </div>
      <div class="quiz-foot"><button class="btn btn-primary" type="button" data-action="quiz-next">${quiz.index === quiz.questions.length - 1 ? "看结果" : "下一题"} ${icon("arrow")}</button></div>
    ` : "";
    return `
      <div class="card quiz-card">
        <div class="quiz-meta"><span>CONTEXT QUIZ · 语境填空</span><span>${quiz.index + 1} / ${quiz.questions.length} · 得分 ${quiz.score}</span></div>
        <p class="quiz-sentence">${sentence}</p>
        <div class="quiz-options">
          ${question.options.map((option) => {
            const classes = quiz.answered && option === question.answer ? "correct" : quiz.answered && option === question.selected ? "wrong" : "";
            return `<button class="quiz-option ${classes}" type="button" data-action="quiz-answer" data-option="${escAttr(option)}" ${quiz.answered ? "disabled" : ""}>${esc(option)}</button>`;
          }).join("")}
        </div>
        ${feedback}
      </div>
    `;
  }

  function blankSurface(text, surface) {
    const source = String(text || "");
    const index = source.toLowerCase().indexOf(String(surface || "").toLowerCase());
    if (index < 0) return esc(source);
    return `${esc(source.slice(0, index))}<span class="blank">______</span>${esc(source.slice(index + surface.length))}`;
  }

  function answerQuiz(option) {
    const quiz = ui.quiz;
    if (!quiz || quiz.answered) return;
    const question = quiz.questions[quiz.index];
    question.selected = option;
    quiz.answered = true;
    if (option === question.answer) {
      quiz.score += 1;
      markWord(question.word.id, "familiar", { fromReview: true });
    } else {
      markWord(question.word.id, "unfamiliar", { fromReview: true });
    }
    getDay().quizCount += 1;
    touchStudy();
    saveStore();
    render();
  }

  function nextQuiz() {
    if (!ui.quiz) return;
    ui.quiz.index += 1;
    ui.quiz.answered = false;
    render();
  }

  function renderPlan() {
    const today = todayKey();
    const days = daysUntilExam();
    return `
      ${viewHead("PLAN · 时间表", "29 天，刚好够把真题吃透", "2026-11-13 → 2026-12-12。纸面两天一套，阶段复习日只复习不开新文章。")}
      <section class="plan-hero">
        <div>
          <div class="kicker">THE ONLY TIMELINE</div>
          <h2>12 套 × 2 天 + 3 次阶段复习 + 1 次模考</h2>
          <p>新词队列按当天计划发放：精读日 25 个，阶段复习日 10 个，模考与考前日 0 个。核心词库有 ${CORE.length} 个，留出机动余量；没学完的词会一直在词书里，不消失。</p>
          <div class="plan-summary">
            <div><b>${Math.max(0, days)}</b><span>距考试 / 天</span></div>
            <div><b>${DATA.meta.articles}</b><span>原文 / 篇</span></div>
            <div><b>${CORE.length}</b><span>核心词 / 个</span></div>
          </div>
        </div>
        <div class="plan-date-card">
          <small>FINAL COUNTDOWN</small>
          <b>${Math.max(0, days)}</b>
          <span>2026.12.12 · 15:00</span>
        </div>
      </section>
      <div class="plan-list">
        ${DATA.plan.map((day) => {
          const isToday = day.date === today;
          const isPast = day.date < today;
          const active = store.days[day.date] && ((store.days[day.date].newCount || 0) + (store.days[day.date].reviewCount || 0) + (store.days[day.date].quizCount || 0) + (store.days[day.date].readArticles?.length || 0) > 0);
          return `
            <div class="plan-row ${isToday ? "today" : ""} ${isPast && !active ? "past" : ""} ${day.kind === "exam" ? "exam" : ""}" data-action="plan-day" data-date="${escAttr(day.date)}" role="button" tabindex="0">
              <div class="plan-day">D${day.day}<small>${esc(day.kind === "exam" ? "考试" : active ? "已学习" : isPast ? "已过" : "计划")}</small></div>
              <div class="plan-date">${esc(day.date)}</div>
              <div class="plan-task"><b>${esc(day.kind === "study" ? `${day.set_label} · ${day.part} 组` : day.set_label)}</b><span>${esc(day.focus)}</span></div>
              <div class="plan-paper">${day.kind === "study" ? `${day.article_slugs.length} 篇 · ${day.minutes} 分钟` : `${day.minutes} 分钟`}</div>
              <div class="plan-new">${day.new_target}<small> 新词</small></div>
            </div>
          `;
        }).join("")}
      </div>
      <div class="method-grid">
        <div class="method-card"><b>01 · 语境优先</b><p>每个核心词都从 12 套真题里取一句原句。先读懂它在句中的位置，再记中文。</p></div>
        <div class="method-card"><b>02 · 主动回忆</b><p>词卡先遮住释义，按“忘记 / 模糊 / 记得”评分；答错会自动回到 1 天后。</p></div>
        <div class="method-card"><b>03 · 真题闭环</b><p>阶段复习只回看陌生、收藏和到期词，不再用新文章稀释注意力。</p></div>
      </div>
      <section class="sources">
        <h3>来源与口径</h3>
        <ul>
          ${DATA.meta.sources.map((source) => `<li><a href="${escAttr(source.url)}" target="_blank" rel="noopener">${esc(source.label)}</a> — ${esc(source.note)}</li>`).join("")}
          <li>词频口径：12 次第1套成篇原文 + 可抽取的试卷 PDF 题干/选项；核心词另加真题精读“生词推断”推荐。</li>
          <li>考试时间来源：教育部教育考试院 / 全国大学英语四、六级考试报名网，<a href="https://cet.neea.cn/html1/report/2609/1-1.htm" target="_blank" rel="noopener">2026年下半年考试安排</a>。</li>
        </ul>
      </section>
    `;
  }

  function renderStats() {
    const learned = DATA.words.filter((word) => statusOf(word.id) !== "new").length;
    const familiar = DATA.words.filter((word) => statusOf(word.id) === "familiar").length;
    const unfamiliar = DATA.words.filter((word) => statusOf(word.id) === "unfamiliar").length;
    const favorites = DATA.words.filter((word) => isFavorite(word.id)).length;
    const due = dueWords().length;
    const today = todayKey();
    const chart = Array.from({ length: 7 }, (_, index) => {
      const date = addDays(today, index - 6);
      const day = store.days[date];
      const value = day ? (day.newCount || 0) + (day.reviewCount || 0) + (day.quizCount || 0) + (day.readArticles?.length || 0) : 0;
      return { date, value };
    });
    const max = Math.max(1, ...chart.map((item) => item.value));
    return `
      ${viewHead("DATA · 学习记录", "学习数据", "所有记录只保存在这台电脑的浏览器 localStorage；换浏览器或清理缓存前先导出。")}
      <div class="stat-grid">
        <div class="stat-card accent"><span>累计接触</span><b>${learned}</b><small>至少标记过一次的词</small></div>
        <div class="stat-card green"><span>熟悉</span><b>${familiar}</b><small>进入较长间隔</small></div>
        <div class="stat-card"><span>陌生</span><b>${unfamiliar}</b><small>优先回到复习队列</small></div>
        <div class="stat-card gold"><span>收藏</span><b>${favorites}</b><small>写作/翻译备用</small></div>
      </div>
      <div class="stats-grid">
        <section class="card card-pad">
          <div class="card-head" style="padding:0 0 16px;border:0"><div><h3>最近 7 天活动</h3><p>新词 + 复习 + 测验 + 精读篇数</p></div><span class="pill">${icon("flame")} 连续 ${store.streak.current || 0} 天</span></div>
          <div class="chart">
            ${chart.map((item) => `<div class="chart-col ${item.date === today ? "today" : ""}"><b>${item.value}</b><div class="chart-bar" style="height:${Math.max(3, Math.round((item.value / max) * 135))}px"></div><span>${weekdayCN(item.date).slice(-1)}</span></div>`).join("")}
          </div>
        </section>
        <section class="card card-pad">
          <h3 style="margin:0 0 14px;font:700 17px var(--serif)">设置</h3>
          <div class="settings-row"><div><b>每天新词</b><span>精读日生效，建议 20–30</span></div><div class="segmented" data-role="new-per-day">${[20,25,30].map((n) => `<button type="button" data-value="${n}" class="${store.settings.newPerDay === n ? "active" : ""}">${n}</button>`).join("")}</div></div>
          <div class="settings-row"><div><b>发音</b><span>优先 Edge 自然神经语音，切换即试听</span></div><div class="segmented" data-role="voice-preset">${[["aria","Aria 美"],["sonia","Sonia 英"],["auto","自动"]].map(([value, label]) => `<button type="button" data-value="${value}" class="${(store.settings.voice || "aria") === value ? "active" : ""}">${label}</button>`).join("")}</div></div>
          <div class="settings-row"><div><b>主题</b><span>自动跟随系统 / 手选</span></div><div class="segmented" data-role="theme-mode">${["auto","light","dark"].map((mode) => `<button type="button" data-value="${mode}" class="${store.settings.theme === mode ? "active" : ""}">${mode === "auto" ? "自动" : mode === "light" ? "浅色" : "深色"}</button>`).join("")}</div></div>
          <div class="settings-row"><div><b>到期词</b><span>每天打开时自动计算</span></div><span class="pill pill-gold">${due} 个</span></div>
          <div class="data-actions" style="margin-top:16px">
            <button class="btn btn-soft btn-sm" type="button" data-action="export-data">${icon("download")} 导出备份</button>
            <button class="btn btn-soft btn-sm" type="button" data-action="import-data">${icon("upload")} 导入</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="reset-data">${icon("reset")} 重置记录</button>
            <input type="file" id="importFile" accept="application/json" hidden>
          </div>
        </section>
      </div>
      <section class="sources">
        <h3>怎么用这张表</h3>
        <p class="about-copy">不要追“累计接触”的数字。真正值得看的是到期词是否清空、陌生词是否在减少、收藏词是否能在写作里用出来。连续天数只记录你有没有碰过学习动作，不等于掌握。</p>
      </section>
      <section class="sources">
        <h3>数据与来源</h3>
        <ul>${DATA.meta.sources.map((source) => `<li><a href="${escAttr(source.url)}" target="_blank" rel="noopener">${esc(source.label)}</a> — ${esc(source.note)}</li>`).join("")}</ul>
        <p class="about-copy">词典音标与中文释义来自 ECDICT（MIT License）；真题原文版权归全国大学英语四、六级考试委员会，网页仅作个人学习使用。</p>
      </section>
    `;
  }

  function openWordModal(id, context = "wordbook") {
    const word = WORD_BY_ID.get(id);
    if (!word) return;
    const state = wordState(id);
    const modal = $("#wordModal");
    const body = $("#wordModalBody");
    const contextData = word.context;
    const forms = (word.forms || []).filter((form) => form !== word.lemma).slice(0, 8);
    body.innerHTML = `
      <div class="modal-kicker">WORD CARD · 真题语境</div>
      <h2 id="wordModalTitle">${esc(word.lemma)}</h2>
      <div class="ipa-row"><span class="ipa">${esc(word.phonetic)}</span><button class="speak" type="button" data-action="speak-word" data-word="${escAttr(word.id)}" aria-label="朗读">${icon("volume")}</button>${state?.favorite ? `<span class="pill pill-gold">${icon("star")} 已收藏</span>` : ""}</div>
      <div class="modal-meta">
        ${word.core ? `<span class="pill pill-ink">核心词 ${word.daily_rank}</span>` : `<span class="pill">扩展词</span>`}
        ${word.teacher_pick ? `<span class="pill pill-gold">精读推荐</span>` : ""}
        ${word.cefr ? `<span class="pill">CEFR ${esc(word.cefr)}</span>` : ""}
        <span class="pill">${word.doc_freq} 套出现</span>
        ${statusPill(word.id)}
        ${state?.due ? `<span class="pill pill-blue">下次 ${esc(state.due)}</span>` : ""}
      </div>
      <p class="modal-def">${esc(word.definition)}</p>
      ${forms.length ? `<div class="modal-meta"><span class="small muted">词形：</span>${forms.map((form) => `<span class="pill">${esc(form)}</span>`).join("")}</div>` : ""}
      ${contextData ? `
        <div class="modal-context">
          <div class="label">EXAM CONTEXT · 原文语境</div>
          <blockquote>${highlight(contextData.text, contextData.surface)}</blockquote>
          <div class="modal-source"><span>${esc(ctxSource(contextData))}${contextData.article_title ? ` · ${esc(shorten(contextData.article_title, 90))}` : ""}</span>${contextData.article_id ? `<button type="button" data-action="modal-open-article" data-article="${escAttr(contextData.article_id)}">去原文 →</button>` : ""}</div>
        </div>
      ` : ""}
      <div class="modal-status">
        <button class="status-btn ${state?.status === "familiar" ? "active-familiar" : ""}" type="button" data-action="modal-status" data-word="${escAttr(word.id)}" data-status="familiar">${icon("check")} ${state?.status === "familiar" ? "取消熟悉" : "标记熟悉"}</button>
        <button class="status-btn ${state?.status === "unfamiliar" ? "active-unfamiliar" : ""}" type="button" data-action="modal-status" data-word="${escAttr(word.id)}" data-status="unfamiliar">${icon("x")} ${state?.status === "unfamiliar" ? "取消陌生" : "标记陌生"}</button>
        <button class="status-btn ${state?.favorite ? "active-favorite" : ""}" type="button" data-action="modal-fav" data-word="${escAttr(word.id)}">${icon("star")} ${state?.favorite ? "取消收藏" : "收藏"}</button>
      </div>
      <div class="modal-hint">右击原文任意单词也能打开这张卡；${context === "article" ? "当前来自语境精读。" : "当前来自词书。"}</div>
    `;
    modal.hidden = false;
    modal.dataset.lemma = id;
    document.body.style.overflow = "hidden";
    setTimeout(() => $(".modal-close", modal)?.focus(), 20);
  }

  function closeWordModal() {
    $("#wordModal").hidden = true;
    document.body.style.overflow = "";
  }

  function refreshWordUI(id) {
    const word = WORD_BY_ID.get(id);
    if (!word) return;
    // Update article spans
    $$(".w").forEach((span) => {
      if (span.dataset.lemma !== id) return;
      span.className = ["w", stateClass(id)].filter(Boolean).join(" ");
    });
    // Update visible word-card classes and buttons without a full re-render
    $$(".word-card").forEach((card) => {
      const title = $(".word-title", card);
      if (!title || title.dataset.word !== id) return;
      const state = wordState(id);
      card.classList.toggle("status-familiar", state?.status === "familiar");
      card.classList.toggle("status-unfamiliar", state?.status === "unfamiliar");
      card.classList.toggle("favorite", Boolean(state?.favorite));
      const favButton = $('[data-action="toggle-fav"]', card);
      if (favButton) favButton.classList.toggle("fav-on", Boolean(state?.favorite));
      const pill = $(".word-card-foot", card);
      if (pill) {
        const first = $(".pill", pill);
        if (first) first.outerHTML = statusPill(id);
      }
    });
    // Update an open modal
    const modal = $("#wordModal");
    if (!modal.hidden && modal.dataset.lemma === id) {
      const state = wordState(id);
      const statuses = $$(".status-btn", modal);
      statuses.forEach((button) => {
        const status = button.dataset.status;
        button.classList.toggle("active-familiar", status === "familiar" && state?.status === "familiar");
        button.classList.toggle("active-unfamiliar", status === "unfamiliar" && state?.status === "unfamiliar");
        button.classList.toggle("active-favorite", button.dataset.action === "modal-fav" && Boolean(state?.favorite));
      });
      const fav = $('[data-action="modal-fav"]', modal);
      if (fav) fav.innerHTML = `${icon("star")} ${state?.favorite ? "取消收藏" : "收藏"}`;
      const familiar = $('[data-action="modal-status"][data-status="familiar"]', modal);
      const unfamiliar = $('[data-action="modal-status"][data-status="unfamiliar"]', modal);
      if (familiar) familiar.innerHTML = `${icon("check")} ${state?.status === "familiar" ? "取消熟悉" : "标记熟悉"}`;
      if (unfamiliar) unfamiliar.innerHTML = `${icon("x")} ${state?.status === "unfamiliar" ? "取消陌生" : "标记陌生"}`;
    }
    updateChrome();
  }

  function showContextMenu(x, y, id, form) {
    const word = WORD_BY_ID.get(id);
    if (!word) return;
    const state = wordState(id);
    const menu = $("#contextMenu");
    menu.innerHTML = `
      <div class="context-word"><strong>${esc(word.lemma)}</strong><span>${esc(word.phonetic)} · ${esc(shorten(word.definition, 42))}</span></div>
      <button class="ctx-item" type="button" data-action="ctx-word" data-word="${escAttr(id)}">${icon("eye")} 查词卡 / 翻译<span class="ctx-state">${form && form !== id ? esc(form) : ""}</span></button>
      <button class="ctx-item" type="button" data-action="ctx-speak" data-word="${escAttr(id)}">${icon("volume")} 朗读</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" type="button" data-action="ctx-status" data-word="${escAttr(id)}" data-status="familiar">${icon("check")} 标记熟悉${state?.status === "familiar" ? '<span class="ctx-state">当前</span>' : ""}</button>
      <button class="ctx-item" type="button" data-action="ctx-status" data-word="${escAttr(id)}" data-status="unfamiliar">${icon("x")} 标记陌生${state?.status === "unfamiliar" ? '<span class="ctx-state">当前</span>' : ""}</button>
      <button class="ctx-item" type="button" data-action="ctx-fav" data-word="${escAttr(id)}">${icon("star")} ${state?.favorite ? "取消收藏" : "收藏"}${state?.favorite ? '<span class="ctx-state">已收藏</span>' : ""}</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" type="button" data-action="ctx-copy" data-word="${escAttr(id)}">${icon("book")} 复制单词</button>
    `;
    menu.hidden = false;
    menu.style.left = `${clamp(x, 8, window.innerWidth - 226)}px`;
    menu.style.top = `${y}px`;
    const rect = menu.getBoundingClientRect();
    if (y + rect.height > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
    ui.context = { id, form };
    setTimeout(() => $(".ctx-item", menu)?.focus(), 10);
  }

  function hideContextMenu() {
    $("#contextMenu").hidden = true;
    ui.context = null;
  }

  function openSearch() {
    if (!$("#wordModal").hidden) closeWordModal();
    const modal = $("#searchModal");
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    ui.searchQuery = "";
    const input = $("#searchInput");
    input.value = "";
    renderSearch("");
    setTimeout(() => input.focus(), 30);
  }

  function closeSearch() {
    $("#searchModal").hidden = true;
    document.body.style.overflow = "";
  }

  function renderSearch(query) {
    ui.searchQuery = query;
    const q = query.trim().toLowerCase();
    let results;
    if (!q) {
      results = CORE.slice(0, 12);
    } else if (q === "陌生") {
      results = DATA.words.filter((word) => statusOf(word.id) === "unfamiliar").slice(0, 40);
    } else {
      results = DATA.words
        .map((word) => {
          const lemma = word.lemma.toLowerCase();
          const def = word.definition.toLowerCase();
          const source = `${word.context?.set_label || ""} ${word.context?.section || ""}`.toLowerCase();
          let score = 0;
          if (lemma === q) score += 100;
          if (lemma.startsWith(q)) score += 40;
          if (lemma.includes(q)) score += 20;
          if (def.includes(q)) score += 8;
          if (source.includes(q)) score += 4;
          return { word, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.word.doc_freq - a.word.doc_freq || a.word.lemma.localeCompare(b.word.lemma))
        .slice(0, 40)
        .map((item) => item.word);
    }
    $("#searchResults").innerHTML = results.length ? results.map((word) => `
      <button class="search-result" type="button" data-action="search-open-word" data-word="${escAttr(word.id)}">
        <span><strong>${esc(word.lemma)}</strong><span class="ipa">${esc(word.phonetic)}</span><p>${esc(shorten(word.definition, 92))}</p></span>
        <span class="sr-meta">${word.core ? `核心 ${word.daily_rank}` : "扩展"}<br>${esc(word.context?.set_label || "")}</span>
      </button>
    `).join("") : `<div class="search-empty">没有找到。试试英文原形，或中文释义。</div>`;
  }

  function toast(message) {
    const stack = $("#toastStack");
    const item = document.createElement("div");
    item.className = "toast";
    item.innerHTML = `${icon("check")}<span>${esc(message)}</span>`;
    stack.appendChild(item);
    setTimeout(() => {
      item.classList.add("out");
      setTimeout(() => item.remove(), 220);
    }, 2200);
  }

  let cachedVoices = [];
  let voicesPromise = null;

  function loadVoices() {
    if (!("speechSynthesis" in window)) return Promise.resolve([]);
    const current = speechSynthesis.getVoices();
    if (current.length) {
      cachedVoices = current;
      return Promise.resolve(current);
    }
    if (voicesPromise) return voicesPromise;
    voicesPromise = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        cachedVoices = speechSynthesis.getVoices();
        resolve(cachedVoices);
      };
      speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
      setTimeout(finish, 1400);
    });
    return voicesPromise;
  }

  function pickVoice(voices, preset) {
    const englishNatural = voices.filter(
      (voice) => /^en-(US|GB)$/i.test(voice.lang) && /natural/i.test(voice.name),
    );
    const presetNames = {
      aria: "Aria",
      sonia: "Sonia",
      ryan: "Ryan",
      jenny: "Jenny",
    };
    const wanted = presetNames[preset] || "";
    if (wanted) {
      const exact = englishNatural.find((voice) => voice.name.includes(wanted));
      if (exact) return exact;
    }
    for (const name of ["Aria", "Jenny", "Ava", "Emma", "Sonia", "Ryan", "Libby"]) {
      const voice = englishNatural.find((item) => item.name.includes(name));
      if (voice) return voice;
    }
    return (
      voices.find((voice) => /^en-US$/i.test(voice.lang))
      || voices.find((voice) => /^en-GB$/i.test(voice.lang))
      || voices.find((voice) => /^en/i.test(voice.lang))
      || null
    );
  }

  async function speakWord(id) {
    const word = WORD_BY_ID.get(id);
    if (!word) return;
    if (!("speechSynthesis" in window)) {
      toast("当前浏览器不支持朗读");
      return;
    }
    const voices = await loadVoices();
    const voice = pickVoice(voices, store.settings.voice || "aria");
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word.lemma.replace(/-/g, " "));
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = store.settings.voice === "sonia" ? "en-GB" : "en-US";
    }
    utterance.rate = 0.9;
    utterance.pitch = 1;
    utterance.volume = 1;
    let fellBack = false;
    utterance.onerror = (event) => {
      if (fellBack || event.error === "canceled" || event.error === "interrupted") return;
      fellBack = true;
      toast("自然语音暂不可用，已切到系统语音");
      const fallback = new SpeechSynthesisUtterance(word.lemma.replace(/-/g, " "));
      fallback.lang = "en-US";
      fallback.rate = 0.9;
      fallback.pitch = 1;
      speechSynthesis.speak(fallback);
    };
    speechSynthesis.speak(utterance);
  }

  function copyWord(id) {
    const word = WORD_BY_ID.get(id);
    if (!word) return;
    const done = () => toast(`已复制 ${word.lemma}`);
    const fallback = () => {
      const input = document.createElement("textarea");
      input.value = word.lemma;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand?.("copy");
      input.remove();
      toast(ok ? `已复制 ${word.lemma}` : "复制失败，请手动选中");
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(word.lemma).then(done, fallback);
    } else {
      fallback();
    }
  }

  function applyTheme() {
    const mode = store.settings.theme || "auto";
    const dark = mode === "dark" || (mode === "auto" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $$("[data-role='theme-mode'] button").forEach((button) => button.classList.toggle("active", button.dataset.value === mode));
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    store.settings.theme = current === "dark" ? "light" : "dark";
    saveStore();
    applyTheme();
    toast(store.settings.theme === "dark" ? "已切到深色" : "已切到浅色");
  }

  function openTodayReading() {
    const plan = todayPlan();
    const read = new Set(getDay().readArticles || []);
    const slug = (plan?.article_slugs || []).find((item) => !read.has(`${plan.set_id}/${item}`))
      || plan?.article_slugs?.[0];
    const id = slug ? `${plan.set_id}/${slug}` : DATA.articles[0]?.id;
    if (id) openArticle(id);
  }

  function bindViewInputs() {
    const wordSearch = $("[data-role='word-search']");
    if (wordSearch) {
      let timer = null;
      wordSearch.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          ui.wordQuery = wordSearch.value;
          ui.wordPage = 1;
          const y = window.scrollY;
          render();
          window.scrollTo({ top: y, behavior: "auto" });
          const next = $("[data-role='word-search']");
          next?.focus();
          if (next) next.setSelectionRange(next.value.length, next.value.length);
        }, 180);
      });
    }
    const sort = $("[data-role='word-sort']");
    if (sort) sort.addEventListener("change", () => { ui.wordSort = sort.value; ui.wordPage = 1; render(); });
    const articleSelect = $("[data-role='article-select']");
    if (articleSelect) articleSelect.addEventListener("change", () => openArticle(articleSelect.value));
    const importFile = $("#importFile");
    if (importFile) importFile.addEventListener("change", importData);
  }

  function exportData() {
    const payload = {
      app: "cet6-wordbook",
      version: 1,
      exportedAt: new Date().toISOString(),
      store,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cet6-wordbook-backup-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("学习记录已导出");
  }

  function importData(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result));
        const next = payload.store || payload;
        if (!next || typeof next !== "object" || !next.words) throw new Error("结构不对");
        if (!confirm("导入会覆盖当前学习记录，继续？")) return;
        store = {
          ...defaultStore(),
          ...next,
          words: next.words || {},
          days: next.days || {},
          settings: { ...defaultStore().settings, ...(next.settings || {}) },
          streak: { ...defaultStore().streak, ...(next.streak || {}) },
        };
        saveStore();
        applyTheme();
        render();
        toast("记录已导入");
      } catch {
        toast("导入失败：不是有效的备份文件");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  function resetData() {
    if (!confirm("重置会清空所有熟悉/陌生/收藏和每日记录。确定吗？")) return;
    store = defaultStore();
    saveStore();
    applyTheme();
    render();
    toast("学习记录已清空");
  }

  function planDay(date) {
    const day = PLAN_BY_DATE.get(date);
    if (!day) return;
    if (day.kind === "study" && day.article_slugs?.length) {
      openArticle(`${day.set_id}/${day.article_slugs[0]}`);
    } else if (day.kind === "weekly") {
      go("review");
    } else if (day.kind === "mock") {
      openArticle(`${day.set_id}/${DATA.articles.find((article) => article.set_id === day.set_id)?.slug || ""}`);
    } else {
      go("today");
    }
  }

  function shuffle(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function handleClick(event) {
    const nav = event.target.closest("[data-nav]");
    if (nav) return;
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) {
      if (!event.target.closest("#contextMenu")) hideContextMenu();
      return;
    }
    const action = actionNode.dataset.action;
    if (!action) return;
    if (action === "go") {
      go(actionNode.dataset.view || "today");
      return;
    }
    if (action === "open-word" || action === "search-open-word") {
      const id = actionNode.dataset.word;
      if (action === "search-open-word") closeSearch();
      openWordModal(id, actionNode.dataset.context || "wordbook");
      return;
    }
    if (action === "speak-word" || action === "ctx-speak") {
      speakWord(actionNode.dataset.word);
      if (action === "ctx-speak") hideContextMenu();
      return;
    }
    if (action === "toggle-fav" || action === "modal-fav" || action === "ctx-fav") {
      toggleFavorite(actionNode.dataset.word);
      if (action === "ctx-fav") hideContextMenu();
      return;
    }
    if (action === "ctx-word") {
      openWordModal(actionNode.dataset.word, "article");
      hideContextMenu();
      return;
    }
    if (action === "ctx-status") {
      markWord(actionNode.dataset.word, actionNode.dataset.status);
      hideContextMenu();
      return;
    }
    if (action === "modal-status") {
      markWord(actionNode.dataset.word, actionNode.dataset.status);
      return;
    }
    if (action === "ctx-copy") {
      copyWord(actionNode.dataset.word);
      hideContextMenu();
      return;
    }
    if (action === "start-review") { startReview("due"); return; }
    if (action === "start-new") { startReview("new"); return; }
    if (action === "start-quiz") { startQuiz(); return; }
    if (action === "review-tab") {
      ui.reviewTab = actionNode.dataset.tab;
      ui.session = null;
      ui.quiz = null;
      if (ui.reviewTab === "quiz") startQuiz();
      else render();
      return;
    }
    if (action === "reveal-card") {
      if (ui.session) { ui.session.revealed = true; render(); }
      return;
    }
    if (action === "grade-card") { gradeCard(actionNode.dataset.grade); return; }
    if (action === "skip-card") { skipCard(); return; }
    if (action === "quiz-answer") { answerQuiz(actionNode.dataset.option); return; }
    if (action === "quiz-next") { nextQuiz(); return; }
    if (action === "open-today-reading") { openTodayReading(); return; }
    if (action === "open-article") { openArticle(actionNode.dataset.article); return; }
    if (action === "prev-article" || action === "next-article") {
      const current = readingCurrent();
      const index = ARTICLE_ORDER.indexOf(current?.id);
      const next = actionNode.dataset.action === "prev-article" ? ARTICLE_ORDER[index - 1] : ARTICLE_ORDER[index + 1];
      if (next) openArticle(next);
      return;
    }
    if (action === "toggle-set") {
      const id = actionNode.dataset.set;
      if (ui.openSets.has(id)) ui.openSets.delete(id); else ui.openSets.add(id);
      renderPreserveScroll();
      return;
    }
    if (action === "toggle-paper-nav") {
      $("#paperNav")?.classList.toggle("mobile-open");
      return;
    }
    if (action === "mark-read") { markRead(actionNode.dataset.article); return; }
    if (action === "modal-open-article") {
      closeWordModal();
      openArticle(actionNode.dataset.article);
      return;
    }
    if (action === "word-filter") {
      ui.wordFilter = actionNode.dataset.filter;
      ui.wordPage = 1;
      render();
      return;
    }
    if (action === "load-more") { ui.wordPage += 1; renderPreserveScroll(); return; }
    if (action === "plan-day") { planDay(actionNode.dataset.date); return; }
    if (action === "export-data") { exportData(); return; }
    if (action === "import-data") { $("#importFile")?.click(); return; }
    if (action === "reset-data") { resetData(); return; }
  }

  function handleKeydown(event) {
    if (event.key === "Escape") {
      if (!$("#wordModal").hidden) closeWordModal();
      if (!$("#searchModal").hidden) closeSearch();
      hideContextMenu();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
      return;
    }
    if (ui.view === "review" && ui.session && ["Space", "1", "2", "3"].includes(event.code)) {
      if (event.target.matches("input, textarea, select")) return;
      if (!ui.session.revealed && (event.code === "Space" || event.code === "Enter")) {
        event.preventDefault();
        ui.session.revealed = true;
        render();
      } else if (ui.session.revealed && ["Digit1", "Digit2", "Digit3"].includes(event.code)) {
        event.preventDefault();
        gradeCard(event.code === "Digit1" ? "forget" : event.code === "Digit2" ? "fuzzy" : "remember");
      }
    }
  }

  function handleContextMenu(event) {
    const wordNode = event.target.closest(".w, [data-action='open-word'], .word-title");
    if (!wordNode) return;
    const id = wordNode.dataset.lemma || wordNode.dataset.word;
    if (!id || !WORD_BY_ID.has(id)) return;
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event.clientX, event.clientY, id, wordNode.dataset.form || id);
  }

  function handleTouchStart(event) {
    const wordNode = event.target.closest(".w, [data-action='open-word'], .word-title");
    if (!wordNode) return;
    const id = wordNode.dataset.lemma || wordNode.dataset.word;
    if (!id) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    const startX = touch.clientX;
    const startY = touch.clientY;
    clearTimeout(ui.longPressTimer);
    ui.longPressFired = false;
    ui.longPressTimer = setTimeout(() => {
      ui.longPressFired = true;
      showContextMenu(startX, startY, id, wordNode.dataset.form || id);
    }, 560);
  }

  function handleTouchMove(event) {
    if (!ui.longPressTimer) return;
    clearTimeout(ui.longPressTimer);
    ui.longPressTimer = null;
  }

  function handleTouchEnd() {
    clearTimeout(ui.longPressTimer);
    ui.longPressTimer = null;
    if (ui.longPressFired) {
      setTimeout(() => { ui.longPressFired = false; }, 50);
    }
  }

  function handleClickCapture(event) {
    if (!ui.longPressFired) return;
    if (event.target.closest(".context-menu")) return;
    event.stopPropagation();
    event.preventDefault();
    ui.longPressFired = false;
  }

  function init() {
    applyTheme();
    if (!location.hash) location.hash = "#/today";
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if (store.settings.theme === "auto") applyTheme();
    });
    window.addEventListener("hashchange", route);
    window.addEventListener("scroll", hideContextMenu, { passive: true });
    window.addEventListener("resize", hideContextMenu);
    document.addEventListener("click", handleClickCapture, true);
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchmove", handleTouchMove, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    $("#themeToggle").addEventListener("click", toggleTheme);
    $("#searchOpen").addEventListener("click", openSearch);
    $("#searchInput").addEventListener("input", (event) => renderSearch(event.target.value));
    $("#searchInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const first = $(".search-result");
        if (first) first.click();
      }
    });
    $$("[data-search-q]").forEach((button) => button.addEventListener("click", () => {
      $("#searchInput").value = button.dataset.searchQ;
      renderSearch(button.dataset.searchQ);
      $("#searchInput").focus();
    }));
    document.addEventListener("click", (event) => {
      const close = event.target.closest("[data-close]");
      if (!close) return;
      if (close.dataset.close === "wordModal") closeWordModal();
      if (close.dataset.close === "searchModal") closeSearch();
    });
    // Segmented controls use buttons, not form controls, so listen separately.
    document.addEventListener("click", (event) => {
      const newPerDay = event.target.closest("[data-role='new-per-day'] button");
      if (newPerDay) {
        store.settings.newPerDay = Number(newPerDay.dataset.value);
        saveStore();
        render();
        toast(`每天新词改为 ${store.settings.newPerDay} 个`);
        return;
      }
      const themeMode = event.target.closest("[data-role='theme-mode'] button");
      if (themeMode) {
        store.settings.theme = themeMode.dataset.value;
        saveStore();
        applyTheme();
        toast("主题已更新");
        return;
      }
      const voicePreset = event.target.closest("[data-role='voice-preset'] button");
      if (voicePreset) {
        store.settings.voice = voicePreset.dataset.value;
        saveStore();
        const labels = { aria: "Aria 美音", sonia: "Sonia 英音", auto: "自动自然语音" };
        toast(`发音已切换：${labels[store.settings.voice]}`);
        setTimeout(() => speakWord("resilience"), 40);
      }
    });
    route();
  }

  init();
})();
