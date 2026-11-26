/**
 * app.js — 画面の切り替え・操作イベント・ダイアログ・ドラッグ＆ドロップ
 */
(function (K) {
  'use strict';

  const U = K.utils;
  const S = K.store;
  const V = K.views;

  const VIEWS = ['today', 'daily', 'todo', 'matrix'];
  const VIEW_TITLES = { today: '今日', daily: 'Daily', todo: 'ToDo', matrix: 'マトリクス' };
  const CHECK_ANIMATION_MS = 220;

  const ui = {
    view: 'today',
    todoFilter: 'open',
    folds: { doneToday: false },
    renderedDay: U.dateKey(),
  };
  let pendingFocus = null; // 再描画後にフォーカスを戻す要素のセレクタ

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const viewEl = $('#view');
  const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
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

  function render() {
    const today = U.dateKey();
    ui.renderedDay = today;
    const focus = pendingFocus ? { selector: pendingFocus, value: '' } : captureFocus();
    pendingFocus = null;

    const ctx = { state: S.getState(), today, ui, storageOk: S.isStorageAvailable(), touch: isTouch() };
    viewEl.innerHTML = V.render(ui.view, ctx);
    updateNav(ctx);
    restoreFocus(focus);
  }

  function updateNav(ctx) {
    const sum = V.summarize(ctx.state, ctx.today);
    const remainingToday = (sum.scheduled.length - sum.dailyDone) + sum.dueNow.length;
    const counts = {
      today: remainingToday || '',
      daily: sum.scheduled.length ? `${sum.dailyDone}/${sum.scheduled.length}` : '',
      todo: sum.open.length || '',
      matrix: '',
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
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    const dark = theme === 'dark' || (theme === 'auto' && darkQuery.matches);
    $('meta[name="theme-color"]').setAttribute('content', dark ? '#0f1115' : '#f5f6f8');
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
      el.textContent = `現在のデータ：ToDo ${s.todos.length}件・Daily ${s.dailies.length}件（約 ${kb} KB）`;
    }
    el.classList.toggle('is-error', isError);
  }

  function openSettings() {
    const theme = S.getState().settings.theme;
    $$('input[name="theme"]', settingsDialog).forEach((r) => { r.checked = r.value === theme; });
    setStorageMeta();
    settingsDialog.showModal();
  }

  settingsDialog.addEventListener('change', (e) => {
    if (e.target.name === 'theme') {
      S.setTheme(e.target.value);
      applyTheme();
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

  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const textContent = await file.text();
      JSON.parse(textContent); // 形式チェック（確認ダイアログの前に）
      if (!window.confirm('現在のデータは、読み込むファイルの内容で置き換えられます。よろしいですか？')) return;
      const result = S.importJson(textContent);
      applyTheme();
      settingsDialog.close();
      toast(`インポートしました（ToDo ${result.todos}件・Daily ${result.dailies}件）`);
    } catch (err) {
      setStorageMeta('読み込めませんでした。Kojin ToDo からエクスポートした JSON ファイルを選択してください。', true);
    }
  });

  function resetAll() {
    if (!window.confirm('すべてのDaily・ToDoを削除します。この操作は元に戻せません。よろしいですか？')) return;
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
    window.setTimeout(() => commitFn(checked), checked ? CHECK_ANIMATION_MS : 0);
  }

  const ACTIONS = {
    'edit-todo': (el) => openTaskDialog({ id: el.dataset.id }),
    'delete-todo': (el) => deleteTodo(el.dataset.id),
    'edit-daily': (el) => openDailyDialog({ id: el.dataset.id }),
    'delete-daily': (el) => deleteDaily(el.dataset.id),
    'quick-detail': (el) => openQuickDetail(el.closest('form')),
    'set-filter': (el) => { ui.todoFilter = el.dataset.filter; render(); },
    'clear-completed': () => clearCompleted(),
    'open-settings': () => openSettings(),
    'add-sample': () => addSample(),
    export: () => exportData(),
    import: () => importInput.click(),
    'reset-all': () => resetAll(),
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
      toggleWithAnimation(el, (checked) => S.setDailyDone(el.dataset.id, today, checked));
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
   *   N: 新規追加欄へ移動 / 1〜4: 画面切り替え / Esc: 入力欄から抜ける
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
      if (e.key === 'Escape' && target.closest('[data-quick]')) target.blur();
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'n' || e.key === 'N') {
      const input = $('[data-quick] input[name="title"]', viewEl);
      if (input) {
        e.preventDefault();
        input.focus();
      }
    } else if (['1', '2', '3', '4'].includes(e.key)) {
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
    [taskDialog, dailyDialog, settingsDialog].forEach(setupDialog);

    ui.view = viewFromHash();
    S.subscribe(render);
    render();

    window.addEventListener('hashchange', () => {
      ui.view = viewFromHash();
      render();
      window.scrollTo(0, 0);
    });

    // 別タブでの変更を反映
    window.addEventListener('storage', (e) => {
      if (e.key !== S.STORAGE_KEY) return;
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
