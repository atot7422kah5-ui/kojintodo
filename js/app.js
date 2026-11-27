/**
 * app.js — 画面の切り替え・操作イベント・ダイアログ・ドラッグ＆ドロップ・演出
 */
(function (K) {
  'use strict';

  const U = K.utils;
  const S = K.store;
  const V = K.views;

  const VIEWS = ['today', 'daily', 'todo', 'matrix', 'vision', 'goals', 'journal', 'memo'];
  const VIEW_TITLES = {
    today: '今日', daily: 'Daily', todo: 'ToDo', matrix: 'マトリクス', vision: 'Vision', goals: '目標', journal: '日記', memo: 'メモ',
  };
  // 「タスク」と「ライフ」のどちらの画面か
  const VIEW_MODE = {
    today: 'task', daily: 'task', todo: 'task', matrix: 'task', vision: 'life', goals: 'life', journal: 'life', memo: 'life',
  };
  const THEME_COLORS = { light: '#f5f6f8', dark: '#0f1115', discipline: '#0a0b0e' };
  const CHECK_ANIMATION_MS = 220;
  const JOURNAL_SAVE_DELAY = 600;
  const IMAGE_TARGET_CHARS = 700000; // 圧縮後の画像の目安（Firestore の上限に余裕を持たせる）

  const ui = {
    view: 'today',
    todoFilter: 'open',
    folds: { doneToday: false },
    renderedDay: U.dateKey(),
    lastByMode: { task: 'today', life: 'vision' },
    journalDate: U.dateKey(),
    journalMonth: U.dateKey().slice(0, 7),
    goalPeriod: { period: 'week', key: S.periodKeyOf('week', U.dateKey()) },
    memoDate: U.dateKey(),
  };
  let pendingFocus = null; // 再描画後にフォーカスを戻す要素のセレクタ

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const appEl = $('.app');
  const viewEl = $('#view');
  const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isTouch = () => touchQuery.matches;

  /* ------------------------------------------------------------------
   * 描画
   * ------------------------------------------------------------------ */
  function captureFocus() {
    const el = document.activeElement;
    if (!el || !viewEl.contains(el)) return null;
    const form = el.closest('[data-quick]');
    if (form && el.name === 'title') {
      return {
        selector: `[data-quick="${form.dataset.quick}"] input[name="title"]`,
        value: el.value,
        start: el.selectionStart,
        end: el.selectionEnd,
      };
    }
    if (el.dataset.action && el.dataset.id) {
      return { selector: `[data-action="${el.dataset.action}"][data-id="${CSS.escape(el.dataset.id)}"]` };
    }
    if (el.dataset.action === 'set-filter') {
      return { selector: `[data-action="set-filter"][data-filter="${el.dataset.filter}"]` };
    }
    if (el.dataset.action === 'journal-date') {
      return { selector: `[data-action="journal-date"][data-date="${el.dataset.date}"]` };
    }
    if (el.dataset.action) {
      return { selector: `[data-action="${el.dataset.action}"]` };
    }
    return null;
  }

  function restoreFocus(focus) {
    if (!focus) return;
    const el = $(focus.selector, viewEl);
    if (!el) return;
    if (typeof focus.value === 'string') el.value = focus.value;
    el.focus({ preventScroll: true });
    if (typeof focus.start === 'number' && el.setSelectionRange) el.setSelectionRange(focus.start, focus.end);
  }

  /**
   * 日記・メモの入力欄は再描画で作り直さない（入力中の文字・カーソル・日本語変換・音声入力を守るため）。
   * 同じ入力欄（data-keep が同じ）が表示中なら、それ以外の部分（data-part）だけを差し替える。
   */
  function patchKeptEditor(html) {
    const editor = $('[data-part="editor"][data-keep]', viewEl);
    if (!editor) return false;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const next = tmp.firstElementChild;
    const nextEditor = next && $('[data-part="editor"]', next);
    if (!nextEditor || nextEditor.dataset.keep !== editor.dataset.keep) return false;
    const current = viewEl.firstElementChild;
    $$(':scope > [data-part]', next).forEach((part) => {
      if (part.dataset.part === 'editor') return;
      const old = $(`:scope > [data-part="${part.dataset.part}"]`, current);
      if (old) old.replaceWith(part);
    });
    if (ui.view === 'journal' && !editor.contains(document.activeElement) && !journal.dirty) {
      fillJournalForm(editor, S.getJournal(ui.journalDate));
    }
    return true;
  }

  function render() {
    const today = U.dateKey();
    ui.renderedDay = today;
    const focus = pendingFocus ? { selector: pendingFocus, value: '' } : captureFocus();
    pendingFocus = null;

    const ctx = { state: S.getState(), today, ui, storageOk: S.isStorageAvailable(), touch: isTouch() };
    const html = V.render(ui.view, ctx);
    if (!patchKeptEditor(html)) {
      viewEl.innerHTML = html;
      restoreFocus(focus);
    }
    // 積み上げのマス目は最新の日（右端）が見えるようにする
    const heat = $('.heat-scroll', viewEl);
    if (heat) heat.scrollLeft = heat.scrollWidth;
    updateNav(ctx);
  }

  function updateNav(ctx) {
    const sum = V.summarize(ctx.state, ctx.today);
    const remainingToday = (sum.scheduled.length - sum.dailyDone) + sum.dueNow.length;
    const counts = {
      today: remainingToday || '',
      daily: sum.scheduled.length ? `${sum.dailyDone}/${sum.scheduled.length}` : '',
      todo: sum.open.length || '',
      matrix: '',
      journal: S.getJournal(ctx.today) ? '✓' : '',
      memo: S.memosFor(ctx.today).length || '',
      goals: (() => {
        const goals = S.goalsFor('week', S.periodKeyOf('week', ctx.today));
        return goals.length ? `${goals.filter((g) => S.goalProgress(g).achieved).length}/${goals.length}` : '';
      })(),
    };
    $$('[data-count]').forEach((el) => { el.textContent = counts[el.dataset.count]; });
    $$('[data-badge="today"]').forEach((el) => {
      el.textContent = remainingToday > 99 ? '99+' : remainingToday || '';
      el.hidden = !remainingToday;
    });
    $$('[data-nav]').forEach((a) => {
      if (a.dataset.nav === ui.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const mode = VIEW_MODE[ui.view];
    ui.lastByMode[mode] = ui.view;
    appEl.dataset.mode = mode;
    $$('[data-action="set-mode"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    document.title = `${VIEW_TITLES[ui.view]} — Kojin ToDo`;
  }

  function viewFromHash() {
    const name = location.hash.replace('#', '');
    return VIEWS.includes(name) ? name : 'today';
  }

  /** 静的 HTML 内の <span data-icon="..."> を SVG に置き換える */
  function hydrateIcons(root = document) {
    $$('[data-icon]', root).forEach((el) => {
      el.outerHTML = V.icon(el.dataset.icon);
    });
  }

  /* ------------------------------------------------------------------
   * テーマ
   * ------------------------------------------------------------------ */
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme() {
    const theme = S.getState().settings.theme;
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark' || theme === 'discipline') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    const resolved = theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : theme;
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);
  }

  /* ------------------------------------------------------------------
   * トースト（元に戻す操作つき通知）
   * ------------------------------------------------------------------ */
  const toastEl = $('#toast');
  let toastTimer = null;

  function hideToast() {
    toastEl.classList.remove('is-show');
    clearTimeout(toastTimer);
  }

  function toast(message, { action, onAction, duration = 4000 } = {}) {
    toastEl.replaceChildren();
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;
    toastEl.append(msg);
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action;
      btn.addEventListener('click', () => { hideToast(); onAction(); });
      toastEl.append(btn);
    }
    toastEl.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, duration);
  }

  /* ------------------------------------------------------------------
   * 演出：チェック時の振動と、Daily をすべて完了したときのお祝い
   * ------------------------------------------------------------------ */
  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern); // Android のみ対応（iPhone では何もしない）
    } catch (e) { /* noop */ }
  }

  const celebrateEl = $('#celebrate');
  const confettiCanvas = $('.celebrate-canvas', celebrateEl);
  let celebrateTimer = null;
  let confettiFrame = null;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function runConfetti() {
    const canvas = confettiCanvas;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['--accent', '--q1', '--q3', '--success', '--warn'].map(cssVar).filter(Boolean);
    const pieces = Array.from({ length: 150 }, (_, i) => ({
      x: w / 2 + (Math.random() - 0.5) * 80,
      y: h * 0.42,
      vx: (Math.random() - 0.5) * 16,
      vy: -8 - Math.random() * 12,
      size: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      color: colors[i % colors.length],
    }));
    const startedAt = performance.now();
    cancelAnimationFrame(confettiFrame);
    const step = (now) => {
      const t = now - startedAt;
      ctx.clearRect(0, 0, w, h);
      pieces.forEach((p) => {
        p.vy += 0.42;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - t / 2600);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        ctx.restore();
      });
      if (t < 2600) confettiFrame = requestAnimationFrame(step);
      else ctx.clearRect(0, 0, w, h);
    };
    confettiFrame = requestAnimationFrame(step);
  }

  function closeCelebrate() {
    clearTimeout(celebrateTimer);
    celebrateEl.classList.remove('is-show');
    setTimeout(() => { if (!celebrateEl.classList.contains('is-show')) celebrateEl.hidden = true; }, 260);
  }

  function celebrate({ eyebrow = 'Discipline', title, text, meter }) {
    vibrate([20, 60, 30]);
    if (reducedMotion.matches) {
      toast(`${title}　${text}`);
      return;
    }
    $('[data-celebrate-eyebrow]', celebrateEl).textContent = eyebrow;
    $('[data-celebrate-title]', celebrateEl).textContent = title;
    $('[data-celebrate-text]', celebrateEl).textContent = text;
    $('[data-celebrate-meter]', celebrateEl).textContent = meter || '';
    celebrateEl.hidden = false;
    requestAnimationFrame(() => celebrateEl.classList.add('is-show'));
    runConfetti();
    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(closeCelebrate, 3200);
  }

  celebrateEl.addEventListener('click', closeCelebrate);

  /** 今の時点で達成している目標の id */
  function achievedGoalIds() {
    return new Set(S.getState().goals.filter((g) => S.goalProgress(g).achieved).map((g) => g.id));
  }

  /** 操作の前の状態を記録しておき、操作の後に比べてお祝いを出す */
  function snapshotProgress() {
    const today = U.dateKey();
    return { daily: S.dailyProgress(today), streak: S.growthStreak(today), goals: achievedGoalIds() };
  }

  function celebrateChanges(before) {
    const today = U.dateKey();
    const newGoals = [...achievedGoalIds()].filter((id) => !before.goals.has(id)).map((id) => S.getGoal(id));
    const after = S.dailyProgress(today);
    const dayComplete = after.total > 0 && after.done === after.total && before.daily.done < before.daily.total;
    const streak = S.growthStreak(today);
    const levelUp = V.flameLevel(streak) > V.flameLevel(before.streak) && V.flameLevel(streak) >= 2;
    const n = S.growthDays(today).length;
    const meter = `1.01^${n} = ×${V.formatTimes(V.COMPOUND ** n)}`;
    if (newGoals.length) {
      const g = newGoals[0];
      celebrate({
        eyebrow: `${V.periodTitle(g.period, g.periodKey)}の目標`,
        title: 'Goal achieved',
        text: newGoals.map((x) => x.title).join('・'),
        meter,
      });
    } else if (levelUp) {
      const level = V.flameLevel(streak);
      celebrate({
        eyebrow: 'Streak',
        title: 'Level up',
        text: `${streak}日連続。炎が Lv.${level}「${V.FLAME_LEVELS[level].label}」になりました`,
        meter,
      });
    } else if (dayComplete) {
      celebrate({ title: 'Day complete', text: `今日の Daily ${after.total} 件をすべて完了しました`, meter });
    }
  }

  /* ------------------------------------------------------------------
   * ダイアログ共通
   * ------------------------------------------------------------------ */
  function setupDialog(dialog) {
    // 背景（ダイアログの外側）をクリックしたら閉じる。テキスト選択中のドラッグでは閉じない
    let downOnBackdrop = false;
    dialog.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dialog; });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && downOnBackdrop) dialog.close();
    });
    $$('[data-close]', dialog).forEach((btn) => btn.addEventListener('click', () => dialog.close()));
  }

  function focusFirstField(form, { force = false } = {}) {
    if (!force && isTouch()) return; // スマホでの編集時はキーボードが画面を覆うため自動フォーカスしない
    const input = form.elements.title;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function showFieldError(form, name, show) {
    const el = $(`[data-error="${name}"]`, form);
    if (el) el.hidden = !show;
  }

  /* ------------------------------------------------------------------
   * ToDo ダイアログ
   * ------------------------------------------------------------------ */
  const taskDialog = $('#task-dialog');
  const taskForm = $('#task-form');
  let taskEditingId = null;
  let dialogSourceForm = null; // 「詳細」を押したクイック追加フォーム

  function openTaskDialog({ id = null, defaults = {} } = {}) {
    const t = id ? S.getTodo(id) : null;
    taskEditingId = t ? t.id : null;
    $('#task-dialog-title').textContent = t ? 'タスクを編集' : 'タスクを追加';
    taskForm.elements.title.value = t ? t.title : (defaults.title || '');
    taskForm.elements.dueDate.value = (t ? t.dueDate : defaults.dueDate) || '';
    taskForm.elements.memo.value = t ? t.memo : '';
    const q = (t ? t.quadrant : defaults.quadrant) || 'none';
    $(`input[name="quadrant"][value="${q}"]`, taskForm).checked = true;
    $('#task-delete').hidden = !t;
    showFieldError(taskForm, 'title', false);

    const meta = $('[data-meta="task"]', taskForm);
    if (t) {
      const parts = [`作成 ${U.formatShort(U.isoToKey(t.createdAt))}`];
      if (t.completed && t.completedAt) parts.push(`完了 ${U.formatShort(U.isoToKey(t.completedAt))}`);
      meta.textContent = parts.join('　');
    } else {
      meta.textContent = '';
    }
    updateDueChips();
    taskDialog.showModal();
    focusFirstField(taskForm, { force: !t });
  }

  function updateDueChips() {
    const value = taskForm.elements.dueDate.value;
    const today = U.dateKey();
    $$('[data-due]', taskForm).forEach((chip) => {
      const d = chip.dataset.due;
      const target = d === 'none' ? '' : U.addDays(today, Number(d));
      chip.setAttribute('aria-pressed', String(value === target));
    });
  }

  taskForm.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-due]');
    if (!chip) return;
    const d = chip.dataset.due;
    taskForm.elements.dueDate.value = d === 'none' ? '' : U.addDays(U.dateKey(), Number(d));
    updateDueChips();
  });
  taskForm.elements.dueDate.addEventListener('input', updateDueChips);
  taskForm.elements.dueDate.addEventListener('change', updateDueChips);
  taskForm.elements.title.addEventListener('input', () => showFieldError(taskForm, 'title', false));

  taskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = taskForm.elements.title.value.trim();
    if (!title) {
      showFieldError(taskForm, 'title', true);
      taskForm.elements.title.focus();
      return;
    }
    const quadrant = new FormData(taskForm).get('quadrant');
    const data = {
      title,
      memo: taskForm.elements.memo.value,
      dueDate: U.isDateKey(taskForm.elements.dueDate.value) ? taskForm.elements.dueDate.value : null,
      quadrant: quadrant === 'none' ? null : quadrant,
    };
    if (taskEditingId) {
      S.updateTodo(taskEditingId, data);
    } else {
      if (dialogSourceForm) dialogSourceForm.elements.title.value = '';
      if (ui.view === 'todo') ui.todoFilter = 'open';
      S.addTodo(data);
      toast(`「${U.truncate(title, 18)}」を追加しました`);
    }
    taskDialog.close();
  });

  taskDialog.addEventListener('close', () => { dialogSourceForm = null; });

  /* ------------------------------------------------------------------
   * Daily ダイアログ
   * ------------------------------------------------------------------ */
  const dailyDialog = $('#daily-dialog');
  const dailyForm = $('#daily-form');
  let dailyEditingId = null;

  function setDays(days) {
    $$('input[name="days"]', dailyForm).forEach((cb) => { cb.checked = days.includes(Number(cb.value)); });
    updateDayPresets();
  }

  function getDays() {
    return $$('input[name="days"]:checked', dailyForm).map((cb) => Number(cb.value)).sort((a, b) => a - b);
  }

  function updateDayPresets() {
    const current = getDays().join(',');
    $$('[data-days]', dailyForm).forEach((chip) => {
      const preset = chip.dataset.days.split(',').map(Number).sort((a, b) => a - b).join(',');
      chip.setAttribute('aria-pressed', String(current === preset));
    });
  }

  function openDailyDialog({ id = null, defaults = {} } = {}) {
    const d = id ? S.getDaily(id) : null;
    dailyEditingId = d ? d.id : null;
    $('#daily-dialog-title').textContent = d ? 'Dailyタスクを編集' : 'Dailyタスクを追加';
    dailyForm.elements.title.value = d ? d.title : (defaults.title || '');
    setDays(d ? d.days : S.ALL_DAYS);
    $('#daily-delete').hidden = !d;
    showFieldError(dailyForm, 'title', false);
    showFieldError(dailyForm, 'days', false);
    $('[data-meta="daily"]', dailyForm).textContent = d
      ? `開始 ${U.formatShort(d.startDate)}　累計 ${d.doneDates.length} 回完了`
      : '完了チェックは日付が変わると自動でリセットされます。';
    dailyDialog.showModal();
    focusFirstField(dailyForm, { force: !d });
  }

  dailyForm.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-days]');
    if (!chip) return;
    setDays(chip.dataset.days.split(',').map(Number));
    showFieldError(dailyForm, 'days', false);
  });
  dailyForm.addEventListener('change', (e) => {
    if (e.target.name === 'days') {
      updateDayPresets();
      showFieldError(dailyForm, 'days', false);
    }
  });
  dailyForm.elements.title.addEventListener('input', () => showFieldError(dailyForm, 'title', false));

  dailyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = dailyForm.elements.title.value.trim();
    const days = getDays();
    showFieldError(dailyForm, 'title', !title);
    showFieldError(dailyForm, 'days', !days.length);
    if (!title) { dailyForm.elements.title.focus(); return; }
    if (!days.length) return;
    if (dailyEditingId) {
      S.updateDaily(dailyEditingId, { title, days });
    } else {
      if (dialogSourceForm) dialogSourceForm.elements.title.value = '';
      S.addDaily({ title, days });
      toast(`「${U.truncate(title, 18)}」を追加しました`);
    }
    dailyDialog.close();
  });

  dailyDialog.addEventListener('close', () => { dialogSourceForm = null; });

  /* ------------------------------------------------------------------
   * 日記（自動保存）
   * ------------------------------------------------------------------ */
  const journal = { timer: null, dirty: false };

  function readJournalForm(form) {
    const f = form.elements;
    const mood = $('input[name="mood"]:checked', form);
    return {
      mood: mood ? Number(mood.value) : null,
      growth: f.growth.value,
      good: [f.good0.value, f.good1.value, f.good2.value],
      tomorrow: f.tomorrow.value,
      memo: f.memo.value,
    };
  }

  function fillJournalForm(form, entry) {
    const j = entry || { mood: null, growth: '', good: ['', '', ''], tomorrow: '', memo: '' };
    const f = form.elements;
    const set = (el, value) => { if (el.value !== value) el.value = value; };
    set(f.growth, j.growth);
    set(f.good0, j.good[0]);
    set(f.good1, j.good[1]);
    set(f.good2, j.good[2]);
    set(f.tomorrow, j.tomorrow);
    set(f.memo, j.memo);
    $$('input[name="mood"]', form).forEach((r) => {
      r.checked = Number(r.value) === j.mood;
      r.dataset.wasChecked = String(r.checked);
    });
  }

  function setJournalStatus(text) {
    const el = $('[data-journal-status]', viewEl);
    if (el) el.textContent = text;
  }

  function flushJournal() {
    clearTimeout(journal.timer);
    journal.timer = null;
    if (!journal.dirty) return;
    journal.dirty = false;
    const form = $('#journal-form', viewEl);
    if (!form) return;
    const saved = S.saveJournal(form.dataset.date, readJournalForm(form));
    const time = new Date().toTimeString().slice(0, 5);
    setJournalStatus(saved ? `保存しました（${time}）` : '入力すると自動で保存されます');
  }

  function scheduleJournalSave() {
    journal.dirty = true;
    setJournalStatus('入力中…');
    clearTimeout(journal.timer);
    journal.timer = setTimeout(flushJournal, JOURNAL_SAVE_DELAY);
  }

  viewEl.addEventListener('input', (e) => {
    if (e.target.closest('#journal-form') && e.target.name !== 'mood') scheduleJournalSave();
  });
  viewEl.addEventListener('change', (e) => {
    if (!e.target.closest('#journal-form')) return;
    journal.dirty = true;
    flushJournal();
  });
  viewEl.addEventListener('focusout', (e) => {
    if (e.target.closest('#journal-form')) flushJournal();
  });
  // 選択中の気分をもう一度押したら選択を外す
  viewEl.addEventListener('click', (e) => {
    const input = e.target.closest('.mood input');
    if (!input) return;
    if (input.dataset.wasChecked === 'true') {
      input.checked = false;
      journal.dirty = true;
      flushJournal();
    }
    $$('.mood input', viewEl).forEach((r) => { r.dataset.wasChecked = String(r.checked); });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushJournal(); });
  window.addEventListener('pagehide', flushJournal);

  function setJournalDate(date) {
    flushJournal();
    const today = U.dateKey();
    const next = date > today ? today : date;
    ui.journalDate = next;
    ui.journalMonth = next.slice(0, 7);
    render();
  }

  function shiftJournalMonth(step) {
    const [y, m] = ui.journalMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + step, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (month > U.dateKey().slice(0, 7)) return;
    ui.journalMonth = month;
    render();
  }

  /* ------------------------------------------------------------------
   * 目標
   * ------------------------------------------------------------------ */
  const goalDialog = $('#goal-dialog');
  const goalForm = $('#goal-form');
  const DEFAULT_THEMES = ['Body', 'Mind', 'Work', 'Travel', 'Life'];
  const DEFAULT_DAILY_TARGET = { week: 4, month: 15, year: 200 };
  let goalEditingId = null;
  let goalTarget = null; // { period, key }

  function updateMeasureFields() {
    const measure = new FormData(goalForm).get('measure');
    $$('[data-measure-fields]', goalForm).forEach((el) => { el.hidden = el.dataset.measureFields !== measure; });
    showFieldError(goalForm, 'measure', false);
  }

  /** つながる目標の候補：週 → その週を含む月・年、月 → その年 */
  function parentCandidates(period, key) {
    const goals = S.getState().goals;
    if (period === 'year') return [];
    const [start, end] = S.periodRange(period, key);
    const months = new Set([start.slice(0, 7), end.slice(0, 7)]);
    const years = new Set([start.slice(0, 4), end.slice(0, 4)]);
    return goals.filter((g) => (period === 'week' && g.period === 'month' && months.has(g.periodKey))
      || (g.period === 'year' && years.has(g.periodKey)));
  }

  function openGoalDialog({ id = null } = {}) {
    const g = id ? S.getGoal(id) : null;
    goalEditingId = g ? g.id : null;
    goalTarget = g ? { period: g.period, key: g.periodKey } : { ...ui.goalPeriod };
    const f = goalForm.elements;
    const dailies = S.getState().dailies;
    $('#goal-dialog-title').textContent = g ? '目標を編集' : '目標を追加';
    $('[data-goal-period]', goalForm).textContent = `対象：${V.periodTitle(goalTarget.period, goalTarget.key)}（${V.PERIOD_NAMES[goalTarget.period]}の目標）`;
    f.title.value = g ? g.title : '';
    f.theme.value = g ? g.theme : '';
    const themes = new Set([...S.getState().goals.map((x) => x.theme).filter(Boolean), ...DEFAULT_THEMES]);
    $('#goal-themes').innerHTML = [...themes].map((t) => `<option value="${U.escapeHtml(t)}"></option>`).join('');

    const measure = g ? g.measure : (dailies.length ? 'daily' : 'count');
    $$('input[name="measure"]', goalForm).forEach((r) => { r.checked = r.value === measure; });
    $('[data-daily-list]', goalForm).innerHTML = dailies.length
      ? dailies.map((d) => `<label class="daily-pick"><input type="checkbox" name="dailyIds" value="${U.escapeHtml(d.id)}"${g && g.dailyIds.includes(d.id) ? ' checked' : ''}><span>${U.escapeHtml(d.title)}</span></label>`).join('')
      : '<p class="help">Daily がまだありません。「タスク」→「Daily」で登録すると選べるようになります。</p>';
    f.targetDaily.value = g && g.measure === 'daily' ? g.target : DEFAULT_DAILY_TARGET[goalTarget.period];
    f.targetCount.value = g && g.measure === 'count' ? g.target : '';
    f.unit.value = g && g.measure === 'count' ? g.unit : '';
    f.current.value = g && g.measure === 'count' ? g.current : 0;

    const candidates = parentCandidates(goalTarget.period, goalTarget.key).filter((x) => x.id !== goalEditingId);
    f.parentId.innerHTML = '<option value="">なし</option>'
      + candidates.map((x) => `<option value="${U.escapeHtml(x.id)}">${V.periodTitle(x.period, x.periodKey)}：${U.escapeHtml(x.title)}</option>`).join('');
    f.parentId.value = g && g.parentId && candidates.some((x) => x.id === g.parentId) ? g.parentId : '';
    $('[data-parent-field]', goalForm).hidden = goalTarget.period === 'year';

    $('#goal-delete').hidden = !g;
    showFieldError(goalForm, 'title', false);
    updateMeasureFields();
    goalDialog.showModal();
    focusFirstField(goalForm, { force: !g });
  }

  goalForm.addEventListener('change', (e) => {
    if (e.target.name === 'measure') updateMeasureFields();
  });
  goalForm.elements.title.addEventListener('input', () => showFieldError(goalForm, 'title', false));

  function goalFormError(message) {
    const el = $('[data-error="measure"]', goalForm);
    el.textContent = message;
    el.hidden = false;
  }

  goalForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = goalForm.elements;
    const title = f.title.value.trim();
    if (!title) {
      showFieldError(goalForm, 'title', true);
      f.title.focus();
      return;
    }
    const measure = new FormData(goalForm).get('measure');
    const data = { title, theme: f.theme.value, measure, parentId: f.parentId.value || null };
    if (measure === 'daily') {
      data.dailyIds = $$('input[name="dailyIds"]:checked', goalForm).map((cb) => cb.value);
      data.target = Number(f.targetDaily.value);
      if (!data.dailyIds.length) { goalFormError('数える Daily を1つ以上選んでください'); return; }
      if (!(data.target >= 1)) { goalFormError('目標回数は1以上にしてください'); return; }
    } else if (measure === 'count') {
      data.target = Number(f.targetCount.value);
      data.unit = f.unit.value;
      data.current = Number(f.current.value) || 0;
      if (!(data.target > 0)) { goalFormError('目標値を入力してください'); return; }
    }
    const before = snapshotProgress();
    if (goalEditingId) {
      S.updateGoal(goalEditingId, data);
    } else {
      S.addGoal({ ...data, period: goalTarget.period, periodKey: goalTarget.key });
      toast(`「${U.truncate(title, 18)}」を追加しました`);
    }
    goalDialog.close();
    if (goalEditingId) celebrateChanges(before);
  });

  function deleteGoal(id) {
    const entry = S.deleteGoal(id);
    if (!entry) return;
    toast(`「${U.truncate(entry.item.title, 16)}」を削除しました`, { action: '元に戻す', onAction: () => S.restoreGoal(entry) });
  }

  function changeGoalCount(id, delta) {
    const before = snapshotProgress();
    S.changeGoalCount(id, delta);
    if (delta > 0) vibrate(10);
    celebrateChanges(before);
  }

  function setGoalPeriod(period) {
    ui.goalPeriod = { period, key: S.periodKeyOf(period, U.dateKey()) };
    render();
  }

  function shiftGoalPeriod(step) {
    ui.goalPeriod = { ...ui.goalPeriod, key: S.shiftPeriod(ui.goalPeriod.period, ui.goalPeriod.key, step) };
    render();
  }

  /* ------------------------------------------------------------------
   * メモ（書く・話す）
   * ------------------------------------------------------------------ */
  const memoDialog = $('#memo-dialog');
  const memoForm = $('#memo-form');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const memo = { source: 'text' };
  const voice = { rec: null, active: false, base: '', failed: false };
  let memoEditingId = null;

  const memoInput = () => $('#memo-text', viewEl);

  function setMemoStatus(message, isError = false) {
    const el = $('[data-memo-status]', viewEl);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('is-error', Boolean(message) && isError);
  }

  function updateMemoTools() {
    const voiceBtn = $('[data-action="memo-voice"]', viewEl);
    if (voiceBtn) {
      voiceBtn.setAttribute('aria-pressed', String(voice.active));
      voiceBtn.classList.toggle('is-recording', voice.active);
      $('[data-voice-label]', voiceBtn).textContent = voice.active ? '停止' : '音声';
    }
  }

  const VOICE_ERRORS = {
    'not-allowed': 'マイクの使用が許可されていません。ブラウザ（またはアプリ）の設定でマイクを許可してください。',
    'service-not-allowed': 'この端末では音声入力を使えません。キーボードのマイクボタンからお試しください。',
    'no-speech': '声が聞き取れませんでした。もう一度「音声」を押して話してください。',
    'audio-capture': 'マイクが見つかりません。マイクの接続を確認してください。',
    network: '音声入力にはインターネット接続が必要です。接続を確認してください。',
  };

  function stopVoice() {
    if (voice.active && voice.rec) voice.rec.stop();
  }

  function toggleVoice() {
    if (voice.active) {
      stopVoice();
      return;
    }
    if (!SpeechRecognition) {
      setMemoStatus('このブラウザは音声入力に対応していません。キーボードのマイクボタンから音声で入力できます。', true);
      return;
    }
    const input = memoInput();
    if (!input) return;
    const rec = new SpeechRecognition();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    rec.continuous = true;
    voice.rec = rec;
    voice.failed = false;
    const current = input.value.replace(/\s+$/, '');
    voice.base = current ? `${current}\n` : '';
    rec.onstart = () => {
      voice.active = true;
      memo.source = 'voice';
      updateMemoTools();
      setMemoStatus('聞き取っています…（話し終えたら「停止」を押してください）');
      vibrate(12);
    };
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i += 1) text += e.results[i][0].transcript;
      const el = memoInput();
      if (el) el.value = voice.base + text;
    };
    rec.onerror = (e) => {
      if (e.error === 'aborted') return;
      voice.failed = true;
      setMemoStatus(VOICE_ERRORS[e.error] || `音声入力でエラーが起きました（${e.error}）。`, true);
    };
    rec.onend = () => {
      voice.active = false;
      updateMemoTools();
      const el = memoInput();
      if (!voice.failed) setMemoStatus(el && el.value.trim() ? '音声を入力しました。内容を確認して「追加」を押してください。' : '');
    };
    try {
      rec.start();
    } catch (e) {
      setMemoStatus('音声入力を開始できませんでした。もう一度お試しください。', true);
    }
  }

  function addMemo() {
    const input = memoInput();
    if (!input) return;
    const text = input.value.trim();
    if (!text) {
      setMemoStatus('メモを入力してください。', true);
      input.focus();
      return;
    }
    stopVoice();
    const source = memo.source;
    input.value = '';
    memo.source = 'text';
    S.addMemo({ text, source, date: ui.memoDate });
    setMemoStatus('追加しました。');
    vibrate(10);
  }

  function setMemoDate(date) {
    stopVoice();
    const today = U.dateKey();
    ui.memoDate = date > today ? today : date;
    memo.source = 'text';
    render();
  }

  function openMemoDialog(id) {
    const m = S.getMemo(id);
    if (!m) return;
    memoEditingId = m.id;
    const time = new Date(m.createdAt).toTimeString().slice(0, 5);
    const src = { text: 'タイピング', voice: '音声' }[m.source] || '';
    $('[data-memo-meta]', memoForm).textContent = `${U.formatShort(m.date)} ${time}・${src}で入力`;
    memoForm.elements.text.value = m.text;
    showFieldError(memoForm, 'text', false);
    memoDialog.showModal();
    if (!isTouch()) memoForm.elements.text.focus();
  }

  memoForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = memoForm.elements.text.value.trim();
    if (!text) {
      showFieldError(memoForm, 'text', true);
      return;
    }
    if (memoEditingId) S.updateMemo(memoEditingId, { text });
    memoDialog.close();
  });

  function deleteMemo(id) {
    const entry = S.deleteMemo(id);
    if (!entry) return;
    toast('メモを削除しました', { action: '元に戻す', onAction: () => S.restoreMemo(entry) });
  }

  // PC：メモ欄で Ctrl（Mac は ⌘）＋ Enter を押すと追加
  viewEl.addEventListener('keydown', (e) => {
    if (e.target.id === 'memo-text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      addMemo();
    }
  });

  /* ------------------------------------------------------------------
   * Vision
   * ------------------------------------------------------------------ */
  const visionDialog = $('#vision-dialog');
  const visionForm = $('#vision-form');
  const visionFile = $('#vision-file');
  const lightbox = $('#vision-lightbox');

  function updateVisionThumb() {
    const img = S.getState().visionImage;
    const thumb = $('.vision-thumb', visionForm);
    thumb.hidden = !img;
    if (img) thumb.src = img.dataUrl;
    else thumb.removeAttribute('src');
    $('[data-vision-remove]', visionForm).hidden = !img;
  }

  function openVisionDialog() {
    const v = S.getState().vision;
    const f = visionForm.elements;
    const titleYear = v && v.title && v.title.match(/20\d{2}/);
    f.title.value = v ? v.title : '';
    f.year.value = (v && v.year) || (titleYear ? titleYear[0] : new Date().getFullYear() + 1);
    f.keywords.value = v ? v.keywords.join('\n') : '';
    f.statement.value = v ? v.statement : '';
    showFieldError(visionForm, 'year', false);
    updateVisionThumb();
    visionDialog.showModal();
  }

  visionForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = visionForm.elements;
    const yearText = f.year.value.trim();
    const year = yearText ? Number(yearText) : null;
    if (yearText && !(Number.isInteger(year) && year >= 2000 && year <= 2100)) {
      showFieldError(visionForm, 'year', true);
      f.year.focus();
      return;
    }
    S.saveVision({
      title: f.title.value,
      year,
      keywords: f.keywords.value.split('\n'),
      statement: f.statement.value,
    });
    visionDialog.close();
    toast('Vision を保存しました');
  });

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  /** 画像を JPEG に変換し、目安のサイズに収まるまで画質・大きさを下げる */
  async function compressImage(file, { maxSide = 1800, maxChars = IMAGE_TARGET_CHARS, startQuality = 0.86 } = {}) {
    const { img, url } = await loadImage(file);
    try {
      let scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      let quality = startQuality;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      for (let i = 0; i < 14; i += 1) {
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length <= maxChars) return { dataUrl, width: w, height: h };
        if (quality > 0.62) quality -= 0.08;
        else scale *= 0.85;
      }
      throw new Error('too-large');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  visionFile.addEventListener('change', async () => {
    const file = visionFile.files && visionFile.files[0];
    visionFile.value = '';
    if (!file) return;
    try {
      const image = await compressImage(file);
      if (!S.setVisionImage(image)) throw new Error('invalid');
      updateVisionThumb();
      toast('ビジョンボードを設定しました');
    } catch (e) {
      toast('この画像は読み込めませんでした。JPEG または PNG の画像を選んでください。', { duration: 6000 });
    }
  });

  function removeVisionImage() {
    if (!window.confirm(`ビジョンボードの画像を削除しますか？${syncNote()}`)) return;
    S.setVisionImage(null);
    updateVisionThumb();
    toast('画像を削除しました');
  }

  function openLightbox() {
    const img = S.getState().visionImage;
    if (!img) return;
    $('.lightbox-img', lightbox).src = img.dataUrl;
    lightbox.showModal();
  }

  lightbox.addEventListener('click', (e) => {
    if (!e.target.closest('.lightbox-close')) lightbox.close();
  });

  /* ------------------------------------------------------------------
   * 設定ダイアログ
   * ------------------------------------------------------------------ */
  const settingsDialog = $('#settings-dialog');
  const importInput = $('#import-file');

  function setStorageMeta(message, isError = false) {
    const el = $('[data-meta="storage"]', settingsDialog);
    if (message) {
      el.textContent = message;
    } else {
      const s = S.getState();
      const kb = (new Blob([JSON.stringify(s)]).size / 1024).toFixed(1);
      el.textContent = `現在のデータ：ToDo ${s.todos.length}件・Daily ${s.dailies.length}件・目標 ${s.goals.length}件・日記 ${s.journals.length}件・メモ ${s.memos.length}件（約 ${kb} KB）`;
    }
    el.classList.toggle('is-error', isError);
  }

  function openSettings() {
    const { theme, startView } = S.getState().settings;
    $$('input[name="theme"]', settingsDialog).forEach((r) => { r.checked = r.value === theme; });
    $$('input[name="startView"]', settingsDialog).forEach((r) => { r.checked = r.value === startView; });
    setStorageMeta();
    settingsDialog.showModal();
  }

  settingsDialog.addEventListener('change', (e) => {
    if (e.target.name === 'theme') {
      S.setTheme(e.target.value);
      applyTheme();
    } else if (e.target.name === 'startView') {
      S.setStartView(e.target.value);
    }
  });

  function exportData() {
    const blob = new Blob([S.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `kojintodo-backup-${U.dateKey()}.json`;
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStorageMeta(`エクスポートしました（${filename}）`);
  }

  const syncNote = () => (K.sync.getStatus().user ? '\n（同期中のため、クラウドと他の端末のデータにも反映されます）' : '');

  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const textContent = await file.text();
      JSON.parse(textContent); // 形式チェック（確認ダイアログの前に）
      if (!window.confirm(`現在のデータは、読み込むファイルの内容で置き換えられます。よろしいですか？${syncNote()}`)) return;
      const result = S.importJson(textContent);
      applyTheme();
      settingsDialog.close();
      toast(`インポートしました（ToDo ${result.todos}件・Daily ${result.dailies}件・目標 ${result.goals}件・日記 ${result.journals}件・メモ ${result.memos}件）`);
    } catch (err) {
      setStorageMeta('読み込めませんでした。Kojin ToDo からエクスポートした JSON ファイルを選択してください。', true);
    }
  });

  function resetAll() {
    if (!window.confirm(`すべての Daily・ToDo・目標・日記・メモ・Vision を削除します。この操作は元に戻せません。よろしいですか？${syncNote()}`)) return;
    S.resetAll();
    settingsDialog.close();
    toast('すべてのデータを削除しました');
  }

  function addSample() {
    S.addSampleData();
    if (settingsDialog.open) settingsDialog.close();
    if (ui.view !== 'today') location.hash = '#today';
    toast('サンプルデータを追加しました');
  }

  /* ------------------------------------------------------------------
   * 同期（ログイン）
   * ------------------------------------------------------------------ */
  const SYNC_LABELS = {
    loading: '同期を準備中', signedOut: '同期オフ', syncing: '同期中', synced: '同期済み', offline: 'オフライン', error: '同期エラー',
  };
  const SYNC_DETAILS = {
    syncing: '同期しています…', synced: '最新の状態です', offline: 'オフラインです（接続が戻ると自動で同期します）', error: '同期エラー',
  };
  let syncPanelKey = '';
  let lastSyncState = null;

  function showSyncMessage(message, isError = true) {
    const el = $('#sync-message');
    el.textContent = message || '';
    el.hidden = !message;
    el.classList.toggle('is-error', Boolean(message) && isError);
  }

  function syncPanelHtml(st) {
    if (st.user) {
      return `<div class="sync-account" data-sync-state="${st.state}">
          <span class="sync-dot"></span>
          <div class="sync-account-text">
            <p class="sync-user">${U.escapeHtml(st.user.email || st.user.name || 'ログイン中')}</p>
            <p class="help">${st.user.provider}でログイン中・<span data-sync-detail></span></p>
          </div>
        </div>
        <div class="btn-row"><button type="button" class="btn btn-secondary btn-sm" data-action="sync-logout">ログアウト</button></div>`;
    }
    if (st.state === 'disabled') {
      return '<p class="help">同期機能は未設定です。設定すると、PC とスマホで同じデータを使えます（設定方法は README の「同期機能の設定」をご覧ください）。</p>';
    }
    if (st.state === 'unsupported') {
      return '<p class="help">同期機能は、公開したページ（https:// で始まるURL）で開いたときに使えます。ファイルを直接開いている間は、この端末だけに保存されます。</p>';
    }
    if (st.state === 'loading') return '<p class="help">同期機能を準備しています…</p>';
    if (st.state === 'error') return '<p class="help">現在、同期機能を利用できません。</p>';
    return `<p class="help">ログインすると、PC とスマホで同じデータを使えます。<strong>すべての端末で同じログイン方法</strong>を使ってください。</p>
      <div class="btn-row"><button type="button" class="btn btn-secondary" data-action="sync-google">${V.icon('login')}Google でログイン</button></div>
      <details class="sync-email">
        <summary>メールアドレスでログイン</summary>
        <form id="sync-email-form" class="sync-email-form" novalidate>
          <input class="input" id="sync-email" name="email" type="email" autocomplete="username" placeholder="メールアドレス" aria-label="メールアドレス">
          <input class="input" id="sync-password" name="password" type="password" autocomplete="current-password" placeholder="パスワード（6文字以上）" aria-label="パスワード">
          <div class="btn-row">
            <button type="submit" class="btn btn-primary btn-sm">ログイン</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="sync-signup">新規登録</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="sync-reset">パスワードを忘れた場合</button>
          </div>
        </form>
        <p class="help">iPhone の「ホーム画面に追加」から起動したときに Google ログインがうまくいかない場合は、こちらをご利用ください。</p>
      </details>`;
  }

  function updateSyncUi(st) {
    const visible = st.state !== 'disabled' && st.state !== 'unsupported';
    $$('[data-sync-pill]').forEach((el) => {
      el.hidden = !visible;
      el.dataset.syncState = st.state;
      el.title = st.error || `${SYNC_LABELS[st.state] || ''}（クリックで設定）`;
    });
    $$('[data-sync-label]').forEach((el) => { el.textContent = SYNC_LABELS[st.state] || ''; });

    const key = st.user ? `user:${st.user.email}:${st.user.provider}` : st.state;
    if (key !== syncPanelKey) {
      $('#sync-panel').innerHTML = syncPanelHtml(st);
      syncPanelKey = key;
    }
    const account = $('.sync-account', settingsDialog);
    if (account) account.dataset.syncState = st.state;
    const detail = $('[data-sync-detail]', settingsDialog);
    if (detail) detail.textContent = SYNC_DETAILS[st.state] || '';

    if (st.error) showSyncMessage(st.error);
    else if (lastSyncState === 'error') showSyncMessage('');
    if (lastSyncState === 'signedOut' && st.user) toast('ログインしました。データを同期しています');
    lastSyncState = st.state;
  }

  async function syncAction(fn, successMessage = '') {
    showSyncMessage('');
    try {
      await fn();
      if (successMessage) showSyncMessage(successMessage, false);
    } catch (e) {
      if (e.message) showSyncMessage(e.message);
    }
  }

  function syncCredentials() {
    const email = $('#sync-email', settingsDialog);
    const password = $('#sync-password', settingsDialog);
    return { email: email ? email.value.trim() : '', password: password ? password.value : '' };
  }

  function syncLogout() {
    const ok = window.confirm('ログアウトすると、この端末からデータ（タスク・目標・日記・メモ・Vision）が消去されます（クラウドには残り、再度ログインすると表示されます）。ログアウトしますか？');
    if (!ok) return;
    syncAction(async () => {
      flushJournal();
      await K.sync.signOut();
      settingsDialog.close();
      toast('ログアウトしました');
    });
  }

  settingsDialog.addEventListener('submit', (e) => {
    if (e.target.id !== 'sync-email-form') return;
    e.preventDefault();
    const { email, password } = syncCredentials();
    syncAction(() => K.sync.signInWithEmail(email, password));
  });

  /* ------------------------------------------------------------------
   * 操作
   * ------------------------------------------------------------------ */
  function deleteTodo(id) {
    const entry = S.deleteTodo(id);
    if (!entry) return;
    toast(`「${U.truncate(entry.item.title, 16)}」を削除しました`, { action: '元に戻す', onAction: () => S.restoreTodo(entry) });
  }

  function deleteDaily(id) {
    const entry = S.deleteDaily(id);
    if (!entry) return;
    toast(`「${U.truncate(entry.item.title, 16)}」を削除しました`, { action: '元に戻す', onAction: () => S.restoreDaily(entry) });
  }

  function clearCompleted() {
    const removed = S.clearCompletedTodos();
    if (!removed.length) return;
    toast(`完了済みのタスク ${removed.length} 件を削除しました`, { action: '元に戻す', onAction: () => S.restoreTodos(removed) });
  }

  function quickAdd(form) {
    const input = form.elements.title;
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    const kind = form.dataset.quick;
    input.value = '';
    pendingFocus = `[data-quick="${kind}"] input[name="title"]`;
    if (kind === 'daily') S.addDaily({ title, days: S.ALL_DAYS });
    else if (kind === 'today') S.addTodo({ title, dueDate: U.dateKey() });
    else if (S.QUADRANTS.includes(kind)) S.addTodo({ title, quadrant: kind });
    else {
      ui.todoFilter = 'open';
      S.addTodo({ title });
    }
  }

  function openQuickDetail(form) {
    const kind = form.dataset.quick;
    const title = form.elements.title.value.trim();
    dialogSourceForm = form;
    if (kind === 'daily') openDailyDialog({ defaults: { title } });
    else if (kind === 'today') openTaskDialog({ defaults: { title, dueDate: U.dateKey() } });
    else openTaskDialog({ defaults: { title } });
  }

  function toggleWithAnimation(input, commitFn) {
    const item = input.closest('.item');
    if (item) item.classList.toggle('is-done', input.checked);
    const { checked } = input;
    if (checked) {
      vibrate(14);
      const check = input.closest('.check');
      if (check && !reducedMotion.matches) {
        check.classList.remove('is-burst');
        void check.offsetWidth; // アニメーションを最初から再生する
        check.classList.add('is-burst');
      }
    }
    window.setTimeout(() => commitFn(checked), checked ? CHECK_ANIMATION_MS : 0);
  }

  function setMode(mode) {
    if (VIEW_MODE[ui.view] === mode) return;
    location.hash = `#${ui.lastByMode[mode]}`;
  }

  const ACTIONS = {
    'edit-todo': (el) => openTaskDialog({ id: el.dataset.id }),
    'delete-todo': (el) => deleteTodo(el.dataset.id),
    'edit-daily': (el) => openDailyDialog({ id: el.dataset.id }),
    'delete-daily': (el) => deleteDaily(el.dataset.id),
    'quick-detail': (el) => openQuickDetail(el.closest('form')),
    'set-filter': (el) => { ui.todoFilter = el.dataset.filter; render(); },
    'set-mode': (el) => setMode(el.dataset.mode),
    'clear-completed': () => clearCompleted(),
    'open-settings': () => openSettings(),
    'add-sample': () => addSample(),
    export: () => exportData(),
    import: () => importInput.click(),
    'reset-all': () => resetAll(),
    'vision-edit': () => openVisionDialog(),
    'vision-pick-image': () => visionFile.click(),
    'vision-remove-image': () => removeVisionImage(),
    'vision-full': () => openLightbox(),
    'journal-prev': () => setJournalDate(U.addDays(ui.journalDate, -1)),
    'journal-next': () => setJournalDate(U.addDays(ui.journalDate, 1)),
    'journal-today': () => setJournalDate(U.dateKey()),
    'journal-date': (el) => setJournalDate(el.dataset.date),
    'journal-month': (el) => shiftJournalMonth(Number(el.dataset.step)),
    'memo-add': () => addMemo(),
    'memo-voice': () => toggleVoice(),
    'memo-prev': () => setMemoDate(U.addDays(ui.memoDate, -1)),
    'memo-next': () => setMemoDate(U.addDays(ui.memoDate, 1)),
    'memo-today': () => setMemoDate(U.dateKey()),
    'edit-memo': (el) => openMemoDialog(el.dataset.id),
    'dialog-delete-memo': () => {
      const id = memoEditingId;
      memoDialog.close();
      if (id) deleteMemo(id);
    },
    'add-goal': () => openGoalDialog(),
    'edit-goal': (el) => openGoalDialog({ id: el.dataset.id }),
    'goal-inc': (el) => changeGoalCount(el.dataset.id, 1),
    'goal-dec': (el) => changeGoalCount(el.dataset.id, -1),
    'goal-period': (el) => setGoalPeriod(el.dataset.period),
    'goal-shift': (el) => shiftGoalPeriod(Number(el.dataset.step)),
    'goal-current': () => setGoalPeriod(ui.goalPeriod.period),
    'dialog-delete-goal': () => {
      const id = goalEditingId;
      goalDialog.close();
      if (id) deleteGoal(id);
    },
    'sync-google': () => syncAction(() => K.sync.signInWithGoogle()),
    'sync-signup': () => {
      const { email, password } = syncCredentials();
      syncAction(() => K.sync.signUpWithEmail(email, password));
    },
    'sync-reset': () => {
      const { email } = syncCredentials();
      if (!email) {
        showSyncMessage('メールアドレスを入力してから押してください。');
        return;
      }
      syncAction(() => K.sync.resetPassword(email), `${email} にパスワード再設定用のメールを送信しました。`);
    },
    'sync-logout': () => syncLogout(),
    'dialog-delete-todo': () => {
      const id = taskEditingId;
      taskDialog.close();
      if (id) deleteTodo(id);
    },
    'dialog-delete-daily': () => {
      const id = dailyEditingId;
      dailyDialog.close();
      if (id) deleteDaily(id);
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.matches('input')) return;
    const handler = ACTIONS[el.dataset.action];
    if (handler) {
      e.preventDefault();
      handler(el);
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.action === 'toggle-todo') {
      toggleWithAnimation(el, (checked) => S.setTodoCompleted(el.dataset.id, checked));
    } else if (el.dataset.action === 'toggle-daily') {
      const today = U.dateKey();
      toggleWithAnimation(el, (checked) => {
        const before = snapshotProgress();
        S.setDailyDone(el.dataset.id, today, checked);
        if (checked) celebrateChanges(before);
      });
    } else if (el.dataset.action === 'toggle-goal') {
      toggleWithAnimation(el, (checked) => {
        const before = snapshotProgress();
        S.setGoalDone(el.dataset.id, checked);
        if (checked) celebrateChanges(before);
      });
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-quick]');
    if (!form) return;
    e.preventDefault();
    quickAdd(form);
  });

  // 折りたたみ（今日完了）の開閉状態を再描画後も保つ
  document.addEventListener('toggle', (e) => {
    const el = e.target;
    if (el instanceof HTMLDetailsElement && el.dataset.fold) ui.folds[el.dataset.fold] = el.open;
  }, true);

  /* ------------------------------------------------------------------
   * ドラッグ＆ドロップ（マトリクス画面・PC）
   * ------------------------------------------------------------------ */
  let dragId = null;

  function clearDropHighlight() {
    $$('.is-drop-over', viewEl).forEach((el) => el.classList.remove('is-drop-over'));
  }

  viewEl.addEventListener('dragstart', (e) => {
    const item = e.target.closest && e.target.closest('[data-drag-id]');
    if (!item) return;
    dragId = item.dataset.dragId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    requestAnimationFrame(() => item.classList.add('is-dragging'));
    viewEl.classList.add('is-dragging-any');
  });

  viewEl.addEventListener('dragend', () => {
    dragId = null;
    clearDropHighlight();
    viewEl.classList.remove('is-dragging-any');
    $$('.is-dragging', viewEl).forEach((el) => el.classList.remove('is-dragging'));
  });

  viewEl.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const zone = e.target.closest('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!zone.classList.contains('is-drop-over')) {
      clearDropHighlight();
      zone.classList.add('is-drop-over');
    }
  });

  viewEl.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-drop]');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('is-drop-over');
  });

  viewEl.addEventListener('drop', (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone || !dragId) return;
    e.preventDefault();
    const id = dragId;
    const q = zone.dataset.drop === 'none' ? null : zone.dataset.drop;
    dragId = null;
    clearDropHighlight();
    const todo = S.getTodo(id);
    if (todo && todo.quadrant !== q) S.updateTodo(id, { quadrant: q });
  });

  /* ------------------------------------------------------------------
   * キーボードショートカット（PC）
   *   N: 新規追加欄へ移動 / 1〜8: 画面切り替え / Esc: 入力欄から抜ける
   * ------------------------------------------------------------------ */
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    // role="button" の要素（マトリクスのタスク）を Enter / Space で操作できるようにする
    if ((e.key === 'Enter' || e.key === ' ') && target.matches && target.matches('[role="button"][data-action]')) {
      e.preventDefault();
      target.click();
      return;
    }
    const typing = target.matches && target.matches('input, textarea, select, [contenteditable="true"]');
    if (typing) {
      if (e.key === 'Escape' && (target.closest('[data-quick]') || target.closest('#journal-form') || target.id === 'memo-text')) target.blur();
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'n' || e.key === 'N') {
      const input = $('[data-quick] input[name="title"]', viewEl);
      if (input) {
        e.preventDefault();
        input.focus();
      }
    } else if (/^[1-8]$/.test(e.key)) {
      location.hash = `#${VIEWS[Number(e.key) - 1]}`;
    }
  });

  /* ------------------------------------------------------------------
   * 初期化
   * ------------------------------------------------------------------ */
  function init() {
    const loaded = S.load();
    applyTheme();
    hydrateIcons();
    [taskDialog, dailyDialog, settingsDialog, visionDialog, goalDialog, memoDialog, lightbox].forEach(setupDialog);

    // URL に画面の指定がなければ、設定した「最初に開く画面」を表示する
    const startView = S.getState().settings.startView;
    if (!location.hash && startView && startView !== 'today') {
      history.replaceState(null, '', `#${startView}`);
    }
    ui.view = viewFromHash();
    S.subscribe(render);
    render();

    // PC・スマホ間の同期（firebase-config.js が設定されている場合のみ動作）
    K.sync.onStatus(updateSyncUi);
    K.sync.init();

    window.addEventListener('hashchange', () => {
      flushJournal();
      const next = viewFromHash();
      if (next !== 'memo') stopVoice();
      if (next === 'journal' && ui.view !== 'journal') {
        ui.journalDate = U.dateKey();
        ui.journalMonth = ui.journalDate.slice(0, 7);
      }
      if (next === 'memo' && ui.view !== 'memo') ui.memoDate = U.dateKey();
      ui.view = next;
      render();
      window.scrollTo(0, 0);
    });

    // 別タブでの変更を反映
    window.addEventListener('storage', (e) => {
      if (e.key !== S.STORAGE_KEY && e.key !== S.IMAGE_KEY) return;
      S.load();
      applyTheme();
      render();
    });

    // 日付が変わったら（深夜0時をまたいだら）Daily の状態を更新
    const refreshIfDayChanged = () => { if (U.dateKey() !== ui.renderedDay) render(); };
    window.setInterval(refreshIfDayChanged, 30 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfDayChanged(); });
    window.addEventListener('focus', refreshIfDayChanged);

    darkQuery.addEventListener('change', applyTheme);
    touchQuery.addEventListener('change', render); // タブレットにマウスを接続した場合など、案内文を切り替える

    if (loaded.status === 'corrupt') {
      toast('保存データを読み込めなかったため、新しい状態で開始しました（元のデータは退避済みです）', { duration: 8000 });
    }
  }

  init();
})(window.Kojin = window.Kojin || {});
