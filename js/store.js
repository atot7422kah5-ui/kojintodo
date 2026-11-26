/**
 * store.js — データモデルと localStorage への保存
 *
 * 画面側は store の関数だけを通してデータを変更する。
 * 変更のたびに localStorage へ保存し、subscribe された関数（再描画）を呼ぶ。
 * ユーザー操作による変更は onLocalChange で同期機能（sync.js）にも通知する。
 *
 * 保存キー:
 *   kojintodo:v1               … ToDo・Daily・日記・Vision（文字）・設定
 *   kojintodo:v1:vision-image  … Vision ボードの画像（サイズが大きいため別に保存）
 */
(function (K) {
  'use strict';

  const { dateKey, isDateKey, addDays, weekday, uid } = K.utils;

  const STORAGE_KEY = 'kojintodo:v1';
  const IMAGE_KEY = `${STORAGE_KEY}:vision-image`;
  const SCHEMA_VERSION = 1;
  const QUADRANTS = ['q1', 'q2', 'q3', 'q4'];
  const THEMES = ['auto', 'light', 'dark'];
  const START_VIEWS = ['today', 'vision', 'journal'];
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const HISTORY_KEEP_DAYS = 400; // Daily の完了履歴を保持する日数
  const IMAGE_MAX_CHARS = 900000; // Firestore の 1 ドキュメント上限（1MB）に収まる大きさ
  const LIMITS = {
    title: 200,
    memo: 2000,
    journalLine: 300,
    journalText: 1000,
    journalMemo: 5000,
    keyword: 80,
    visionTitle: 80,
    statement: 2000,
  };

  let state = createEmptyState();
  let storageAvailable = true;
  let savedImage = null; // localStorage に保存済みの画像（同じなら書き込まない）
  const listeners = new Set();
  const localChangeListeners = new Set();

  function createEmptyState() {
    return {
      version: SCHEMA_VERSION,
      todos: [],
      dailies: [],
      journals: [],
      vision: null,
      visionImage: null,
      settings: { theme: 'auto', startView: 'today' },
    };
  }

  /* ------------------------------------------------------------------
   * 正規化（読み込み・インポート・同期時に壊れたデータを取り除く）
   * ------------------------------------------------------------------ */
  const text = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
  const isoOr = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function normalizeTodo(t) {
    if (!t || typeof t !== 'object') return null;
    const title = text(t.title, LIMITS.title).trim();
    if (!title) return null;
    const now = new Date().toISOString();
    const completed = t.completed === true;
    return {
      id: typeof t.id === 'string' && t.id ? t.id : uid(),
      title,
      memo: text(t.memo, LIMITS.memo),
      dueDate: isDateKey(t.dueDate) ? t.dueDate : null,
      quadrant: QUADRANTS.includes(t.quadrant) ? t.quadrant : null,
      completed,
      completedAt: completed ? isoOr(t.completedAt, now) : null,
      createdAt: isoOr(t.createdAt, now),
      updatedAt: isoOr(t.updatedAt, now),
    };
  }

  function normalizeDays(days) {
    if (!Array.isArray(days)) return ALL_DAYS.slice();
    const valid = [...new Set(days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
    return valid.length ? valid.sort((a, b) => a - b) : ALL_DAYS.slice();
  }

  function normalizeDaily(d) {
    if (!d || typeof d !== 'object') return null;
    const title = text(d.title, LIMITS.title).trim();
    if (!title) return null;
    const now = new Date().toISOString();
    const createdAt = isoOr(d.createdAt, now);
    const doneDates = Array.isArray(d.doneDates) ? [...new Set(d.doneDates.filter(isDateKey))].sort() : [];
    return {
      id: typeof d.id === 'string' && d.id ? d.id : uid(),
      title,
      days: normalizeDays(d.days),
      startDate: isDateKey(d.startDate) ? d.startDate : dateKey(new Date(createdAt)),
      doneDates,
      createdAt,
      updatedAt: isoOr(d.updatedAt, now),
    };
  }

  function normalizeList(list, normalizer) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const item = normalizer(raw);
      if (!item) continue;
      if (seen.has(item.id)) item.id = uid(); // ID 重複は振り直す
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }

  /** 日記（1日1件。id は日付） */
  function normalizeJournal(j) {
    if (!j || typeof j !== 'object') return null;
    const date = isDateKey(j.date) ? j.date : (isDateKey(j.id) ? j.id : null);
    if (!date) return null;
    const now = new Date().toISOString();
    const good = (Array.isArray(j.good) ? j.good : []).slice(0, 3).map((g) => text(g, LIMITS.journalLine));
    while (good.length < 3) good.push('');
    const mood = Number(j.mood);
    return {
      id: date,
      date,
      mood: Number.isInteger(mood) && mood >= 1 && mood <= 5 ? mood : null,
      growth: text(j.growth, LIMITS.journalText),
      good,
      tomorrow: text(j.tomorrow, LIMITS.journalLine),
      memo: text(j.memo, LIMITS.journalMemo),
      createdAt: isoOr(j.createdAt, now),
      updatedAt: isoOr(j.updatedAt, now),
    };
  }

  const isJournalEmpty = (j) => !j.mood && !j.growth.trim() && !j.tomorrow.trim() && !j.memo.trim()
    && j.good.every((g) => !g.trim());

  function normalizeJournals(list) {
    const byDate = new Map();
    (Array.isArray(list) ? list : []).forEach((raw) => {
      const j = normalizeJournal(raw);
      if (!j || isJournalEmpty(j)) return;
      const prev = byDate.get(j.date);
      if (!prev || j.updatedAt > prev.updatedAt) byDate.set(j.date, j);
    });
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Vision の文字情報（タイトル・キーワード・なりたい姿） */
  function normalizeVision(v) {
    if (!v || typeof v !== 'object') return null;
    const keywords = (Array.isArray(v.keywords) ? v.keywords : [])
      .map((k) => text(k, LIMITS.keyword).trim())
      .filter(Boolean)
      .slice(0, 12);
    const year = Number(v.year);
    const vision = {
      id: 'main',
      title: text(v.title, LIMITS.visionTitle).trim(),
      year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null,
      keywords,
      statement: text(v.statement, LIMITS.statement),
      updatedAt: isoOr(v.updatedAt, new Date().toISOString()),
    };
    return vision.title || vision.keywords.length || vision.statement.trim() || vision.year ? vision : null;
  }

  const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

  /** Vision ボードの画像（圧縮済みの data URL） */
  function normalizeVisionImage(v) {
    if (!v || typeof v !== 'object' || typeof v.dataUrl !== 'string') return null;
    if (v.dataUrl.length > IMAGE_MAX_CHARS || !DATA_URL_RE.test(v.dataUrl)) return null;
    const dim = (n) => (Number.isInteger(n) && n > 0 && n < 20000 ? n : null);
    return {
      id: 'image',
      dataUrl: v.dataUrl,
      width: dim(v.width),
      height: dim(v.height),
      updatedAt: isoOr(v.updatedAt, new Date().toISOString()),
    };
  }

  function normalizeState(data) {
    const hasData = data && typeof data === 'object' && ['todos', 'dailies', 'journals'].some((k) => Array.isArray(data[k]));
    if (!hasData) throw new Error('Kojin ToDo のデータ形式ではありません');
    const s = createEmptyState();
    s.todos = normalizeList(data.todos, normalizeTodo);
    s.dailies = normalizeList(data.dailies, normalizeDaily);
    s.journals = normalizeJournals(data.journals);
    s.vision = normalizeVision(data.vision);
    s.visionImage = normalizeVisionImage(data.visionImage);
    const settings = data.settings || {};
    s.settings.theme = THEMES.includes(settings.theme) ? settings.theme : 'auto';
    s.settings.startView = START_VIEWS.includes(settings.startView) ? settings.startView : 'today';
    return s;
  }

  /* ------------------------------------------------------------------
   * 保存・読み込み
   * ------------------------------------------------------------------ */
  function loadImage() {
    try {
      const raw = localStorage.getItem(IMAGE_KEY);
      return raw ? normalizeVisionImage(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }

  function load() {
    let raw = null;
    let result;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageAvailable = false;
      state = createEmptyState();
      return { status: 'unavailable' };
    }
    if (raw == null) {
      state = createEmptyState();
      result = { status: 'empty' };
    } else {
      try {
        state = normalizeState(JSON.parse(raw));
        result = { status: 'ok' };
      } catch (e) {
        // 壊れたデータは消さずに退避してから空の状態で始める
        try { localStorage.setItem(`${STORAGE_KEY}:broken:${Date.now()}`, raw); } catch (_) { /* noop */ }
        state = createEmptyState();
        result = { status: 'corrupt' };
      }
    }
    state.visionImage = loadImage();
    savedImage = state.visionImage;
    return result;
  }

  function persist() {
    const { visionImage, ...main } = state;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(main));
      storageAvailable = true;
    } catch (e) {
      storageAvailable = false;
    }
    if (visionImage !== savedImage) {
      try {
        if (visionImage) localStorage.setItem(IMAGE_KEY, JSON.stringify(visionImage));
        else localStorage.removeItem(IMAGE_KEY);
        savedImage = visionImage;
      } catch (e) {
        // 容量不足で画像だけ保存できない場合も、画面とクラウド（同期中）には残る
      }
    }
  }

  function commit() {
    persist();
    listeners.forEach((fn) => fn(state));
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ------------------------------------------------------------------
   * 同期用のフック
   *   ユーザー操作による変更は emitLocal で「変更内容（ops）」として通知する。
   *   op の形式:
   *     { kind, type: 'set', item }   … 追加・更新（kind: todos / dailies / journals / vision）
   *     { kind, type: 'delete', id }  … 削除
   *     { kind: 'dailies', type: 'done', id, key, done, updatedAt } … Daily の完了チェック
   *     { type: 'replaceAll', todos, dailies, journals, vision }    … インポート・全削除
   *   vision は id が 'main'（文字情報）と 'image'（画像）の2件。
   * ------------------------------------------------------------------ */
  function onLocalChange(fn) {
    localChangeListeners.add(fn);
    return () => localChangeListeners.delete(fn);
  }

  function emitLocal(ops) {
    if (!ops.length) return;
    localChangeListeners.forEach((fn) => fn(ops));
  }

  /** 同期用に、現在のデータを種類ごとの配列で返す */
  function snapshotForSync() {
    return {
      todos: state.todos.map((t) => ({ ...t })),
      dailies: state.dailies.map((d) => ({ ...d, days: d.days.slice(), doneDates: d.doneDates.slice() })),
      journals: state.journals.map((j) => ({ ...j, good: j.good.slice() })),
      vision: [state.vision, state.visionImage].filter(Boolean).map((v) => ({ ...v })),
    };
  }

  const byCreated = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

  /** クラウドから受け取ったデータで置き換える（変更がなければ何もしない） */
  function replaceCollections({ todos, dailies, journals, vision }) {
    let changed = false;
    if (todos) {
      const next = normalizeList(todos, normalizeTodo).sort(byCreated);
      if (!sameJson(next, state.todos.slice().sort(byCreated))) { state.todos = next; changed = true; }
    }
    if (dailies) {
      const next = normalizeList(dailies, normalizeDaily).sort(byCreated);
      if (!sameJson(next, state.dailies.slice().sort(byCreated))) { state.dailies = next; changed = true; }
    }
    if (journals) {
      const next = normalizeJournals(journals);
      if (!sameJson(next, state.journals)) { state.journals = next; changed = true; }
    }
    if (vision) {
      const main = normalizeVision(vision.find((v) => v && v.id === 'main'));
      if (!sameJson(main, state.vision)) { state.vision = main; changed = true; }
      const image = normalizeVisionImage(vision.find((v) => v && v.id === 'image'));
      const current = state.visionImage;
      const imageChanged = Boolean(image) !== Boolean(current)
        || (image && (image.updatedAt !== current.updatedAt || image.dataUrl.length !== current.dataUrl.length));
      if (imageChanged) { state.visionImage = image; changed = true; }
    }
    if (changed) commit();
    return changed;
  }

  function keepSettings() {
    const next = createEmptyState();
    next.settings = { ...state.settings };
    return next;
  }

  /** ログアウト時：この端末のデータを消去する（設定は残す） */
  function clearLocalData() {
    state = keepSettings();
    commit();
  }

  /* ------------------------------------------------------------------
   * ToDo
   * ------------------------------------------------------------------ */
  const findTodo = (id) => state.todos.find((t) => t.id === id) || null;

  function addTodo(input) {
    const now = new Date().toISOString();
    const todo = normalizeTodo({ ...input, id: uid(), completed: false, createdAt: now, updatedAt: now });
    if (!todo) return null;
    state.todos.push(todo);
    commit();
    emitLocal([{ kind: 'todos', type: 'set', item: { ...todo } }]);
    return todo;
  }

  function updateTodo(id, patch) {
    const t = findTodo(id);
    if (!t) return null;
    const next = normalizeTodo({ ...t, ...patch, id: t.id, createdAt: t.createdAt, updatedAt: new Date().toISOString() });
    if (!next) return null;
    Object.assign(t, next);
    commit();
    emitLocal([{ kind: 'todos', type: 'set', item: { ...t } }]);
    return t;
  }

  function setTodoCompleted(id, completed) {
    const t = findTodo(id);
    if (!t || t.completed === !!completed) return;
    const now = new Date().toISOString();
    t.completed = !!completed;
    t.completedAt = completed ? now : null;
    t.updatedAt = now;
    commit();
    emitLocal([{ kind: 'todos', type: 'set', item: { ...t } }]);
  }

  function deleteTodo(id) {
    const index = state.todos.findIndex((t) => t.id === id);
    if (index < 0) return null;
    const [item] = state.todos.splice(index, 1);
    commit();
    emitLocal([{ kind: 'todos', type: 'delete', id }]);
    return { item, index };
  }

  function restoreTodo(entry) {
    if (findTodo(entry.item.id)) return;
    state.todos.splice(Math.min(entry.index, state.todos.length), 0, entry.item);
    commit();
    emitLocal([{ kind: 'todos', type: 'set', item: { ...entry.item } }]);
  }

  function clearCompletedTodos() {
    const removed = state.todos.filter((t) => t.completed);
    if (!removed.length) return [];
    state.todos = state.todos.filter((t) => !t.completed);
    commit();
    emitLocal(removed.map((t) => ({ kind: 'todos', type: 'delete', id: t.id })));
    return removed;
  }

  function restoreTodos(items) {
    const ids = new Set(state.todos.map((t) => t.id));
    const added = items.filter((t) => !ids.has(t.id));
    state.todos.push(...added);
    commit();
    emitLocal(added.map((t) => ({ kind: 'todos', type: 'set', item: { ...t } })));
  }

  /* ------------------------------------------------------------------
   * Daily（毎日・指定曜日に繰り返すタスク）
   * 完了状態は日付ごとに doneDates へ記録するため、日付が変われば自動で未完了に戻る。
   * ------------------------------------------------------------------ */
  const findDaily = (id) => state.dailies.find((d) => d.id === id) || null;

  function addDaily(input) {
    const now = new Date().toISOString();
    const daily = normalizeDaily({ ...input, id: uid(), startDate: dateKey(), doneDates: [], createdAt: now, updatedAt: now });
    if (!daily) return null;
    state.dailies.push(daily);
    commit();
    emitLocal([{ kind: 'dailies', type: 'set', item: { ...daily } }]);
    return daily;
  }

  function updateDaily(id, patch) {
    const d = findDaily(id);
    if (!d) return null;
    const next = normalizeDaily({
      ...d, ...patch, id: d.id, startDate: d.startDate, doneDates: d.doneDates, createdAt: d.createdAt, updatedAt: new Date().toISOString(),
    });
    if (!next) return null;
    Object.assign(d, next);
    commit();
    emitLocal([{ kind: 'dailies', type: 'set', item: { ...d } }]);
    return d;
  }

  function setDailyDone(id, key, done) {
    const d = findDaily(id);
    if (!d) return;
    const has = d.doneDates.includes(key);
    if (done && !has) d.doneDates.push(key);
    if (!done && has) d.doneDates = d.doneDates.filter((k) => k !== key);
    const cutoff = addDays(dateKey(), -HISTORY_KEEP_DAYS);
    d.doneDates = d.doneDates.filter((k) => k >= cutoff).sort();
    d.updatedAt = new Date().toISOString();
    commit();
    emitLocal([{ kind: 'dailies', type: 'done', id, key, done: !!done, updatedAt: d.updatedAt }]);
  }

  function deleteDaily(id) {
    const index = state.dailies.findIndex((d) => d.id === id);
    if (index < 0) return null;
    const [item] = state.dailies.splice(index, 1);
    commit();
    emitLocal([{ kind: 'dailies', type: 'delete', id }]);
    return { item, index };
  }

  function restoreDaily(entry) {
    if (findDaily(entry.item.id)) return;
    state.dailies.splice(Math.min(entry.index, state.dailies.length), 0, entry.item);
    commit();
    emitLocal([{ kind: 'dailies', type: 'set', item: { ...entry.item } }]);
  }

  /** その日が実施対象日か（開始日以降かつ指定曜日） */
  function isScheduled(d, key) {
    return key >= d.startDate && d.days.includes(weekday(key));
  }

  function isDone(d, key) {
    return d.doneDates.includes(key);
  }

  /** 連続達成数。今日が未完了でも「まだ途中」とみなし、昨日までの連続を数える */
  function streak(d, today) {
    let key = today;
    if (isScheduled(d, key) && !isDone(d, key)) key = addDays(key, -1);
    let count = 0;
    for (let i = 0; i < HISTORY_KEEP_DAYS && key >= d.startDate; i += 1) {
      if (isScheduled(d, key)) {
        if (!isDone(d, key)) break;
        count += 1;
      }
      key = addDays(key, -1);
    }
    return count;
  }

  /** 直近 n 日間の記録（古い順） */
  function history(d, today, n = 7) {
    const out = [];
    for (let i = n - 1; i >= 0; i -= 1) {
      const key = addDays(today, -i);
      let status;
      if (key < d.startDate) status = 'before';
      else if (!d.days.includes(weekday(key))) status = 'off';
      else if (isDone(d, key)) status = 'done';
      else status = key === today ? 'pending' : 'missed';
      out.push({ key, status });
    }
    return out;
  }

  /** その日の Daily の達成状況 */
  function dailyProgress(key) {
    const scheduled = state.dailies.filter((d) => isScheduled(d, key));
    return { total: scheduled.length, done: scheduled.filter((d) => isDone(d, key)).length };
  }

  /* ------------------------------------------------------------------
   * 日記
   * ------------------------------------------------------------------ */
  const findJournal = (date) => state.journals.find((j) => j.date === date) || null;
  const byDate = (a, b) => a.date.localeCompare(b.date);

  /** 日記を保存する。すべて空になった場合は削除する */
  function saveJournal(date, fields) {
    if (!isDateKey(date)) return null;
    const prev = findJournal(date);
    const now = new Date().toISOString();
    const next = normalizeJournal({ ...(prev || {}), ...fields, date, createdAt: prev ? prev.createdAt : now, updatedAt: now });
    if (prev && sameJson({ ...next, updatedAt: prev.updatedAt }, prev)) return prev; // 変更なし
    if (isJournalEmpty(next)) {
      if (!prev) return null;
      state.journals = state.journals.filter((j) => j.date !== date);
      commit();
      emitLocal([{ kind: 'journals', type: 'delete', id: date }]);
      return null;
    }
    state.journals = state.journals.filter((j) => j.date !== date).concat(next).sort(byDate);
    commit();
    emitLocal([{ kind: 'journals', type: 'set', item: { ...next, good: next.good.slice() } }]);
    return next;
  }

  /** 日記の連続記録日数（今日がまだなら昨日までを数える） */
  function journalStreak(today) {
    const dates = new Set(state.journals.map((j) => j.date));
    let key = dates.has(today) ? today : addDays(today, -1);
    let count = 0;
    while (dates.has(key) && count < 3660) {
      count += 1;
      key = addDays(key, -1);
    }
    return count;
  }

  /**
   * 「1%前進した日」の一覧（古い順）。
   * その日の Daily をすべて完了した日、または日記に「今日の1%成長」を書いた日を数える。
   */
  function growthDays(today) {
    const days = new Set(state.journals.filter((j) => j.growth.trim() && j.date <= today).map((j) => j.date));
    const candidates = new Set();
    state.dailies.forEach((d) => d.doneDates.forEach((k) => { if (k <= today) candidates.add(k); }));
    candidates.forEach((k) => {
      if (days.has(k)) return;
      const p = dailyProgress(k);
      if (p.total > 0 && p.done === p.total) days.add(k);
    });
    return [...days].sort();
  }

  /* ------------------------------------------------------------------
   * Vision
   * ------------------------------------------------------------------ */
  function saveVision(fields) {
    const next = normalizeVision({ ...(state.vision || {}), ...fields, updatedAt: new Date().toISOString() });
    if (!next && !state.vision) return null;
    state.vision = next;
    commit();
    emitLocal([next
      ? { kind: 'vision', type: 'set', item: { ...next, keywords: next.keywords.slice() } }
      : { kind: 'vision', type: 'delete', id: 'main' }]);
    return next;
  }

  /** 画像を設定する（null で削除）。形式・サイズが不正なら false */
  function setVisionImage(image) {
    const next = image ? normalizeVisionImage({ ...image, updatedAt: new Date().toISOString() }) : null;
    if (image && !next) return false;
    if (!next && !state.visionImage) return true;
    state.visionImage = next;
    commit();
    emitLocal([next ? { kind: 'vision', type: 'set', item: { ...next } } : { kind: 'vision', type: 'delete', id: 'image' }]);
    return true;
  }

  /* ------------------------------------------------------------------
   * 設定・データ管理
   * ------------------------------------------------------------------ */
  function setTheme(theme) {
    if (!THEMES.includes(theme)) return;
    state.settings.theme = theme;
    commit();
  }

  function setStartView(view) {
    if (!START_VIEWS.includes(view)) return;
    state.settings.startView = view;
    commit();
  }

  function exportJson() {
    return JSON.stringify({ app: 'kojintodo', exportedAt: new Date().toISOString(), ...state }, null, 2);
  }

  /** JSON 文字列を読み込み、現在のデータを置き換える。形式が不正なら例外 */
  function importJson(jsonText) {
    const next = normalizeState(JSON.parse(jsonText));
    state = next;
    commit();
    emitLocal([{ type: 'replaceAll', ...snapshotForSync() }]);
    return { todos: next.todos.length, dailies: next.dailies.length, journals: next.journals.length };
  }

  function resetAll() {
    state = keepSettings();
    commit();
    emitLocal([{ type: 'replaceAll', ...snapshotForSync() }]);
  }

  function addSampleData() {
    const today = dateKey();
    const now = new Date().toISOString();
    const yesterday = addDays(today, -1);
    const firstTodo = state.todos.length;
    const firstDaily = state.dailies.length;
    const dailies = [
      { title: '応募者・エントリー状況を確認する', days: [1, 2, 3, 4, 5], done: [yesterday] },
      { title: 'メール・Slackの未読を返信する', days: ALL_DAYS, done: [addDays(today, -2), yesterday] },
      { title: '今日の振り返りを3行で書く', days: ALL_DAYS, done: [] },
    ];
    dailies.forEach((d) => {
      state.dailies.push(normalizeDaily({
        title: d.title, days: d.days, startDate: addDays(today, -6), doneDates: d.done, createdAt: now, updatedAt: now,
      }));
    });
    const todos = [
      { title: '内定者フォロー面談の日程を調整する', dueDate: today, quadrant: 'q1', memo: '候補日を3つ提示する' },
      { title: 'インターン募集ページの文言を見直す', dueDate: yesterday, quadrant: null },
      { title: '採用広報記事の構成案を作る', dueDate: addDays(today, 5), quadrant: 'q2' },
      { title: '来期の新卒採用戦略を整理する', dueDate: addDays(today, 14), quadrant: 'q2' },
      { title: '説明会資料の誤字を修正する', dueDate: addDays(today, 1), quadrant: 'q3' },
      { title: '古い求人票のファイルを整理する', dueDate: null, quadrant: 'q4' },
    ];
    todos.forEach((t) => {
      state.todos.push(normalizeTodo({ ...t, completed: false, createdAt: now, updatedAt: now }));
    });
    commit();
    emitLocal([
      ...state.dailies.slice(firstDaily).map((d) => ({ kind: 'dailies', type: 'set', item: { ...d } })),
      ...state.todos.slice(firstTodo).map((t) => ({ kind: 'todos', type: 'set', item: { ...t } })),
    ]);
  }

  K.store = {
    STORAGE_KEY,
    IMAGE_KEY,
    QUADRANTS,
    ALL_DAYS,
    START_VIEWS,
    LIMITS,
    IMAGE_MAX_CHARS,
    load,
    subscribe,
    onLocalChange,
    snapshotForSync,
    replaceCollections,
    clearLocalData,
    getState: () => state,
    isStorageAvailable: () => storageAvailable,
    getTodo: findTodo,
    getDaily: findDaily,
    getJournal: findJournal,
    addTodo,
    updateTodo,
    setTodoCompleted,
    deleteTodo,
    restoreTodo,
    clearCompletedTodos,
    restoreTodos,
    addDaily,
    updateDaily,
    setDailyDone,
    deleteDaily,
    restoreDaily,
    isScheduled,
    isDone,
    streak,
    history,
    dailyProgress,
    saveJournal,
    journalStreak,
    growthDays,
    saveVision,
    setVisionImage,
    setTheme,
    setStartView,
    exportJson,
    importJson,
    resetAll,
    addSampleData,
  };
})(window.Kojin = window.Kojin || {});
