/**
 * store.js — データモデルと localStorage への保存
 *
 * 画面側は store の関数だけを通してデータを変更する。
 * 変更のたびに localStorage へ保存し、subscribe された関数（再描画）を呼ぶ。
 * 将来、外部データベースへ移行する場合はこのファイルの load / persist を差し替える想定。
 */
(function (K) {
  'use strict';

  const { dateKey, isDateKey, addDays, weekday, uid } = K.utils;

  const STORAGE_KEY = 'kojintodo:v1';
  const SCHEMA_VERSION = 1;
  const QUADRANTS = ['q1', 'q2', 'q3', 'q4'];
  const THEMES = ['auto', 'light', 'dark'];
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const HISTORY_KEEP_DAYS = 400; // Daily の完了履歴を保持する日数
  const LIMITS = { title: 200, memo: 2000 };

  let state = createEmptyState();
  let storageAvailable = true;
  const listeners = new Set();
  const localChangeListeners = new Set(); // 同期機能（sync.js）が、端末内での変更を受け取る

  function createEmptyState() {
    return { version: SCHEMA_VERSION, todos: [], dailies: [], settings: { theme: 'auto' } };
  }

  /* ------------------------------------------------------------------
   * 正規化（読み込み・インポート時に壊れたデータを取り除く）
   * ------------------------------------------------------------------ */
  const text = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
  const isoOr = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);

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

  function normalizeState(data) {
    if (!data || typeof data !== 'object' || (!Array.isArray(data.todos) && !Array.isArray(data.dailies))) {
      throw new Error('Kojin ToDo のデータ形式ではありません');
    }
    const s = createEmptyState();
    s.todos = normalizeList(data.todos, normalizeTodo);
    s.dailies = normalizeList(data.dailies, normalizeDaily);
    const theme = data.settings && data.settings.theme;
    s.settings.theme = THEMES.includes(theme) ? theme : 'auto';
    return s;
  }

  /* ------------------------------------------------------------------
   * 保存・読み込み
   * ------------------------------------------------------------------ */
  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageAvailable = false;
      state = createEmptyState();
      return { status: 'unavailable' };
    }
    if (raw == null) {
      state = createEmptyState();
      return { status: 'empty' };
    }
    try {
      state = normalizeState(JSON.parse(raw));
      return { status: 'ok' };
    } catch (e) {
      // 壊れたデータは消さずに退避してから空の状態で始める
      try { localStorage.setItem(`${STORAGE_KEY}:broken:${Date.now()}`, raw); } catch (_) { /* noop */ }
      state = createEmptyState();
      return { status: 'corrupt' };
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageAvailable = true;
    } catch (e) {
      storageAvailable = false;
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
   *     { kind: 'todos' | 'dailies', type: 'set', item }       … 追加・更新
   *     { kind: 'todos' | 'dailies', type: 'delete', id }      … 削除
   *     { kind: 'dailies', type: 'done', id, key, done, updatedAt } … Daily の完了チェック
   *     { type: 'replaceAll', todos, dailies }                 … インポート・全削除
   * ------------------------------------------------------------------ */
  function onLocalChange(fn) {
    localChangeListeners.add(fn);
    return () => localChangeListeners.delete(fn);
  }

  function emitLocal(ops) {
    if (!ops.length) return;
    localChangeListeners.forEach((fn) => fn(ops));
  }

  const byCreated = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

  /** クラウドから受け取ったデータで ToDo・Daily を置き換える（変更がなければ何もしない） */
  function replaceCollections({ todos, dailies }) {
    const nextTodos = normalizeList(todos, normalizeTodo).sort(byCreated);
    const nextDailies = normalizeList(dailies, normalizeDaily).sort(byCreated);
    const same = JSON.stringify(nextTodos) === JSON.stringify(state.todos.slice().sort(byCreated))
      && JSON.stringify(nextDailies) === JSON.stringify(state.dailies.slice().sort(byCreated));
    if (same) return false;
    state.todos = nextTodos;
    state.dailies = nextDailies;
    commit();
    return true;
  }

  /** ログアウト時：この端末のタスクを消去する（テーマ設定は残す） */
  function clearLocalData() {
    const theme = state.settings.theme;
    state = createEmptyState();
    state.settings.theme = theme;
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

  /* ------------------------------------------------------------------
   * 設定・データ管理
   * ------------------------------------------------------------------ */
  function setTheme(theme) {
    if (!THEMES.includes(theme)) return;
    state.settings.theme = theme;
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
    emitLocal([{ type: 'replaceAll', todos: state.todos.map((t) => ({ ...t })), dailies: state.dailies.map((d) => ({ ...d })) }]);
    return { todos: next.todos.length, dailies: next.dailies.length };
  }

  function resetAll() {
    const theme = state.settings.theme;
    state = createEmptyState();
    state.settings.theme = theme;
    commit();
    emitLocal([{ type: 'replaceAll', todos: [], dailies: [] }]);
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
    QUADRANTS,
    ALL_DAYS,
    LIMITS,
    load,
    subscribe,
    onLocalChange,
    replaceCollections,
    clearLocalData,
    getState: () => state,
    isStorageAvailable: () => storageAvailable,
    getTodo: findTodo,
    getDaily: findDaily,
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
    setTheme,
    exportJson,
    importJson,
    resetAll,
    addSampleData,
  };
})(window.Kojin = window.Kojin || {});
