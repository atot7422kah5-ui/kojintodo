/**
 * views.js — 画面の HTML を組み立てる（データは変更しない）
 *
 * ユーザーが入力した文字列は必ず esc() を通して埋め込む。
 * 操作は data-action 属性で表し、app.js がまとめて受け取る。
 */
(function (K) {
  'use strict';

  const { escapeHtml: esc, formatShort, formatMonthDay, diffDays, isoToKey, WEEKDAYS } = K.utils;
  const S = K.store;

  /* ------------------------------------------------------------------
   * アイコン（インライン SVG）
   * ------------------------------------------------------------------ */
  const ICONS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    repeat: '<path d="m17 2.5 3.5 3.5L17 9.5"/><path d="M3.5 11.5v-1A4.5 4.5 0 0 1 8 6h12.5"/><path d="m7 21.5-3.5-3.5L7 14.5"/><path d="M20.5 12.5v1A4.5 4.5 0 0 1 16 18H3.5"/>',
    list: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="m3.5 6.5 1.5 1.5 2.5-2.5M3.5 12l1.5 1.5L7.5 11M3.5 17.5 5 19l2.5-2.5"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M18 7l-.8 12.2a1.5 1.5 0 0 1-1.5 1.3H8.3a1.5 1.5 0 0 1-1.5-1.3L6 7"/><path d="M10 11v6M14 11v6"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    note: '<path d="M5 6h14M5 10.5h14M5 15h9"/>',
    flame: '<path d="M12 21a6 6 0 0 0 6-6c0-3.6-2.6-5.9-4.2-8.8-.4 2.2-1.3 3.4-2.6 4.2C11 7.8 9.6 5 9 3c-.8 3.8-3 6.4-3 10.5A7.5 7.5 0 0 0 12 21z"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>',
    upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 20h14"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    alert: '<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    login: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="m10 16 4-4-4-4"/><path d="M14 12H4"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  };

  function icon(name, cls = '') {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  }

  /* ------------------------------------------------------------------
   * 表示用の定義・補助関数
   * ------------------------------------------------------------------ */
  const QUADRANT_INFO = {
    q1: { title: '今すぐやる', axis: '重要 × 緊急', hint: '締切が迫った重要な仕事' },
    q2: { title: '計画してやる', axis: '重要 × 緊急でない', hint: '成果につながる仕事。時間を確保して進める' },
    q3: { title: '任せる・手早く', axis: '重要でない × 緊急', hint: '依頼・割り込み。短時間で片付けるか任せる' },
    q4: { title: 'やらない・後回し', axis: '重要でない × 緊急でない', hint: '本当に必要か見直す' },
  };
  const Q_ORDER = { q1: 0, q2: 1, q3: 2, q4: 3 };
  const qRank = (t) => (t.quadrant ? Q_ORDER[t.quadrant] : 4);

  const byDue = (a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31')
    || qRank(a) - qRank(b)
    || a.createdAt.localeCompare(b.createdAt);
  const byQuadrant = (a, b) => qRank(a) - qRank(b) || byDue(a, b);
  const byCompletedDesc = (a, b) => (b.completedAt || '').localeCompare(a.completedAt || '');

  function dueInfo(due, today, completed) {
    if (!due) return null;
    const diff = diffDays(today, due);
    if (completed) return { label: formatShort(due), cls: '' };
    if (diff < 0) return { label: `${formatShort(due)}・${-diff}日超過`, cls: 'is-overdue' };
    if (diff === 0) return { label: '今日まで', cls: 'is-today' };
    if (diff === 1) return { label: '明日まで', cls: 'is-soon' };
    if (diff < 7) return { label: `${formatShort(due)}まで`, cls: 'is-soon' };
    return { label: `${formatShort(due)}まで`, cls: '' };
  }

  function daysLabel(days) {
    const key = days.join(',');
    if (days.length === 7) return '毎日';
    if (key === '1,2,3,4,5') return '平日';
    if (key === '0,6') return '週末';
    return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => WEEKDAYS[d]).join('・');
  }

  const firstLine = (s) => s.trim().split('\n')[0];

  /** 縦書きラベル。writing-mode はフォントによって文字が重なるため、1文字ずつ縦に並べる */
  const verticalText = (s) => Array.from(s).map((c) => `<span aria-hidden="true">${c}</span>`).join('');

  /** 画面全体で使う集計（ナビの件数表示にも使う） */
  function summarize(state, today) {
    const scheduled = state.dailies.filter((d) => S.isScheduled(d, today));
    const dailyDone = scheduled.filter((d) => S.isDone(d, today)).length;
    const open = state.todos.filter((t) => !t.completed);
    const dueNow = open.filter((t) => t.dueDate && t.dueDate <= today);
    const doneToday = state.todos.filter((t) => t.completed && t.completedAt && isoToKey(t.completedAt) === today);
    return { scheduled, dailyDone, open, dueNow, doneToday };
  }

  /* ------------------------------------------------------------------
   * 部品
   * ------------------------------------------------------------------ */
  function viewHeader(title, { eyebrow = '', desc = '' } = {}) {
    return `<header class="view-header">
      ${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}
      <h1 class="view-title">${title}</h1>
      ${desc ? `<p class="view-desc">${desc}</p>` : ''}
    </header>`;
  }

  function quickAdd(kind, placeholder) {
    return `<form class="quick-add" data-quick="${kind}" autocomplete="off">
      ${icon('plus', 'quick-icon')}
      <input name="title" type="text" maxlength="${S.LIMITS.title}" placeholder="${placeholder}" aria-label="${placeholder}" enterkeyhint="enter">
      <button type="button" class="btn btn-ghost btn-sm" data-action="quick-detail">詳細</button>
      <button type="submit" class="btn btn-primary btn-sm">追加</button>
    </form>`;
  }

  function sectionHead(title, count, extra = '') {
    return `<div class="section-head">
      <h2 class="section-title">${title}</h2>
      ${count !== undefined && count !== null ? `<span class="section-count">${count}</span>` : ''}
      ${extra ? `<span class="spacer"></span>${extra}` : ''}
    </div>`;
  }

  function emptyState(iconName, title, textHtml, actionHtml = '') {
    return `<div class="empty">
      ${icon(iconName)}
      <p class="empty-title">${title}</p>
      ${textHtml ? `<p class="empty-text">${textHtml}</p>` : ''}
      ${actionHtml}
    </div>`;
  }

  function todoItem(t, today, { draggable = false, showQuadrant = true } = {}) {
    const id = esc(t.id);
    const due = dueInfo(t.dueDate, today, t.completed);
    const meta = [];
    if (due) meta.push(`<span class="badge due ${due.cls}">${icon('calendar')}${esc(due.label)}</span>`);
    if (showQuadrant && t.quadrant) {
      meta.push(`<span class="badge quad" data-q="${t.quadrant}"><i class="dot"></i>${QUADRANT_INFO[t.quadrant].title}</span>`);
    }
    if (t.memo.trim()) meta.push(`<span class="badge memo">${icon('note')}<span class="memo-text">${esc(firstLine(t.memo))}</span></span>`);
    const drag = draggable ? ` draggable="true" data-drag-id="${id}"` : '';
    // Firefox は draggable 要素内の <button> からドラッグを開始できないため、ドラッグ対象では div を使う
    const bodyOpen = draggable
      ? `<div role="button" tabindex="0" class="item-body" data-action="edit-todo" data-id="${id}">`
      : `<button type="button" class="item-body" data-action="edit-todo" data-id="${id}">`;
    return `<li class="item${t.completed ? ' is-done' : ''}" data-id="${id}"${drag}>
      <label class="check">
        <input type="checkbox" data-action="toggle-todo" data-id="${id}"${t.completed ? ' checked' : ''} aria-label="「${esc(t.title)}」を完了にする">
        <span class="check-ui">${icon('check')}</span>
      </label>
      ${bodyOpen}
        <span class="item-title">${esc(t.title)}</span>
        ${meta.length ? `<span class="item-meta">${meta.join('')}</span>` : ''}
      ${draggable ? '</div>' : '</button>'}
      <button type="button" class="icon-btn item-del" data-action="delete-todo" data-id="${id}" aria-label="「${esc(t.title)}」を削除" title="削除">${icon('trash')}</button>
    </li>`;
  }

  const HISTORY_LABEL = { done: '完了', missed: '未完了', pending: '未完了（今日）', off: '対象外の曜日', before: '開始前' };

  function dailyItem(d, today, { showHistory = true } = {}) {
    const id = esc(d.id);
    const scheduled = S.isScheduled(d, today);
    const done = S.isDone(d, today);
    const streak = S.streak(d, today);
    const meta = [`<span class="badge">${icon('repeat')}${daysLabel(d.days)}</span>`];
    if (!scheduled) meta.push('<span class="badge">今日は対象外</span>');
    if (streak >= 2) {
      const unit = d.days.length === 7 ? '日' : '回';
      meta.push(`<span class="badge streak">${icon('flame')}${streak}${unit}連続</span>`);
    }
    if (showHistory) {
      const dots = S.history(d, today, 7)
        .map((h) => `<i class="hd hd-${h.status}" title="${formatShort(h.key)} ${HISTORY_LABEL[h.status]}"></i>`)
        .join('');
      meta.push(`<span class="history" aria-hidden="true">${dots}</span>`);
    }
    return `<li class="item daily${done ? ' is-done' : ''}${scheduled ? '' : ' is-off'}" data-id="${id}">
      <label class="check">
        <input type="checkbox" data-action="toggle-daily" data-id="${id}"${done ? ' checked' : ''}${!scheduled && !done ? ' disabled' : ''} aria-label="「${esc(d.title)}」を今日完了にする">
        <span class="check-ui">${icon('check')}</span>
      </label>
      <button type="button" class="item-body" data-action="edit-daily" data-id="${id}">
        <span class="item-title">${esc(d.title)}</span>
        <span class="item-meta">${meta.join('')}</span>
      </button>
      <button type="button" class="icon-btn item-del" data-action="delete-daily" data-id="${id}" aria-label="「${esc(d.title)}」を削除" title="削除">${icon('trash')}</button>
    </li>`;
  }

  function list(items, renderItem) {
    return `<ul class="list">${items.map(renderItem).join('')}</ul>`;
  }

  function progressRing(pct) {
    const r = 27;
    const c = 2 * Math.PI * r;
    const fg = pct > 0
      ? `<circle class="ring-fg" cx="32" cy="32" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(2)}"/>`
      : '';
    return `<div class="ring" role="img" aria-label="今日の進捗 ${pct}%">
      <svg viewBox="0 0 64 64"><circle class="ring-bg" cx="32" cy="32" r="${r}"/>${fg}</svg>
      <span class="ring-label"><span>${pct}<small>%</small></span></span>
    </div>`;
  }

  function storageBanner(ctx) {
    if (ctx.storageOk) return '';
    return `<div class="banner" role="alert">${icon('alert')}<span>このブラウザではデータを保存できません（プライベートブラウズや容量不足の可能性があります）。ページを閉じると変更が失われます。</span></div>`;
  }

  /* ------------------------------------------------------------------
   * 画面：今日
   * ------------------------------------------------------------------ */
  function viewToday(ctx) {
    const { state, today, ui } = ctx;
    const sum = summarize(state, today);
    const dueNow = sum.dueNow.slice().sort(byDue);
    const dueIds = new Set(dueNow.map((t) => t.id));
    const focusAll = sum.open.filter((t) => !dueIds.has(t.id) && (t.quadrant === 'q1' || t.quadrant === 'q2')).sort(byQuadrant);
    const FOCUS_LIMIT = 5;
    const focus = focusAll.slice(0, FOCUS_LIMIT);
    const doneToday = sum.doneToday.slice().sort(byCompletedDesc);

    const total = sum.scheduled.length + dueNow.length + doneToday.length;
    const done = sum.dailyDone + doneToday.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const remaining = total - done;
    let message = '今日の予定はまだありません';
    if (total && remaining === 0) message = '今日のタスクはすべて完了しました';
    else if (total) message = `残り ${remaining} 件`;

    const hasAnyData = state.todos.length > 0 || state.dailies.length > 0;
    const hour = new Date().getHours();
    const greeting = hour < 5 ? 'おつかれさまです' : hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'おつかれさまです';

    let body = '';
    if (!hasAnyData) {
      body = emptyState('sparkle', 'ようこそ！まずはタスクを追加しましょう',
        '上の入力欄から「今日やること」を追加できます。<br>毎日のルーティンは <a href="#daily">Daily</a>、優先順位の整理は <a href="#matrix">マトリクス</a> へ。',
        '<button type="button" class="btn btn-secondary btn-sm" data-action="add-sample">サンプルデータで試す</button>');
    } else {
      // Daily
      body += `<section class="section">${sectionHead('Daily', sum.scheduled.length ? `${sum.dailyDone}/${sum.scheduled.length}` : null, '<a class="link" href="#daily">管理する</a>')}
        ${sum.scheduled.length
          ? list(sum.scheduled, (d) => dailyItem(d, today, { showHistory: false }))
          : `<p class="muted-box">今日のDailyタスクはありません。<a href="#daily">Daily</a> で登録できます。</p>`}
      </section>`;

      // 今日やること（期限切れ・今日まで）
      body += `<section class="section">${sectionHead('今日やること', dueNow.length)}
        ${dueNow.length
          ? list(dueNow, (t) => todoItem(t, today))
          : '<p class="muted-box">今日が締切のタスクはありません。</p>'}
      </section>`;

      // 重要タスク
      if (focusAll.length) {
        const more = focusAll.length > FOCUS_LIMIT ? `<a class="link" href="#matrix">ほか${focusAll.length - FOCUS_LIMIT}件</a>` : '<a class="link" href="#matrix">マトリクス</a>';
        body += `<section class="section">${sectionHead('重要なタスク', focusAll.length, more)}
          <p class="section-desc">締切はまだ先でも、成果につながる仕事です。時間を確保して進めましょう。</p>
          ${list(focus, (t) => todoItem(t, today))}
        </section>`;
      }

      // 今日完了
      if (doneToday.length) {
        body += `<details class="section fold" data-fold="doneToday"${ui.folds.doneToday ? ' open' : ''}>
          <summary class="section-head">
            <h2 class="section-title">今日完了</h2><span class="section-count">${doneToday.length}</span>
            <span class="spacer"></span>${icon('chevron', 'fold-chevron')}
          </summary>
          ${list(doneToday, (t) => todoItem(t, today))}
        </details>`;
      }
    }

    const summaryCard = hasAnyData ? `<div class="summary">
        ${progressRing(pct)}
        <div class="summary-main">
          <p class="summary-msg">${message}</p>
          <div class="stats">
            <div class="stat"><span class="stat-value">${sum.scheduled.length ? `${sum.dailyDone}<small>/${sum.scheduled.length}</small>` : '–'}</span><span class="stat-label">Daily</span></div>
            <div class="stat"><span class="stat-value">${dueNow.length}</span><span class="stat-label">今日やること</span></div>
            <div class="stat"><span class="stat-value">${doneToday.length}</span><span class="stat-label">ToDo完了</span></div>
          </div>
        </div>
      </div>` : '';

    return `<div class="view view-today">
      ${storageBanner(ctx)}
      ${viewHeader('今日', { eyebrow: `${formatMonthDay(today)}　${greeting}` })}
      ${summaryCard}
      ${quickAdd('today', '今日やることを追加')}
      ${body}
    </div>`;
  }

  /* ------------------------------------------------------------------
   * 画面：Daily
   * ------------------------------------------------------------------ */
  function viewDaily(ctx) {
    const { state, today } = ctx;
    const sum = summarize(state, today);
    const dailies = state.dailies;
    const body = dailies.length
      ? `<section class="section">${sectionHead('すべてのDaily', dailies.length, '<span class="legend"><i class="hd hd-done"></i>完了 <i class="hd hd-missed"></i>未完了 <i class="hd hd-off"></i>対象外</span>')}
          ${list(dailies, (d) => dailyItem(d, today))}
        </section>`
      : emptyState('repeat', 'Dailyタスクはまだありません', '毎日（または指定した曜日に）繰り返すルーティンを登録しましょう。<br>完了チェックは日付が変わると自動でリセットされます。');

    return `<div class="view view-daily">
      ${storageBanner(ctx)}
      ${viewHeader('Daily', {
        eyebrow: formatMonthDay(today),
        desc: sum.scheduled.length ? `今日の対象 ${sum.scheduled.length} 件中 ${sum.dailyDone} 件完了` : '毎日繰り返すルーティン',
      })}
      ${quickAdd('daily', 'Dailyタスクを追加')}
      ${body}
    </div>`;
  }

  /* ------------------------------------------------------------------
   * 画面：ToDo
   * ------------------------------------------------------------------ */
  function groupByDue(todos, today) {
    const groups = [
      { key: 'overdue', title: '期限切れ', items: [] },
      { key: 'today', title: '今日', items: [] },
      { key: 'tomorrow', title: '明日', items: [] },
      { key: 'week', title: '7日以内', items: [] },
      { key: 'later', title: 'それ以降', items: [] },
      { key: 'none', title: '期限なし', items: [] },
    ];
    const pick = (k) => groups.find((g) => g.key === k).items;
    todos.forEach((t) => {
      if (!t.dueDate) return pick('none').push(t);
      const diff = diffDays(today, t.dueDate);
      if (diff < 0) return pick('overdue').push(t);
      if (diff === 0) return pick('today').push(t);
      if (diff === 1) return pick('tomorrow').push(t);
      if (diff < 7) return pick('week').push(t);
      return pick('later').push(t);
    });
    groups.forEach((g) => g.items.sort(byDue));
    return groups.filter((g) => g.items.length);
  }

  function viewTodo(ctx) {
    const { state, today, ui } = ctx;
    const open = state.todos.filter((t) => !t.completed);
    const done = state.todos.filter((t) => t.completed).sort(byCompletedDesc);
    const filter = ui.todoFilter;

    const seg = (key, label, count) => `<button type="button" class="seg" data-action="set-filter" data-filter="${key}" aria-pressed="${filter === key}">${label}<span class="seg-count">${count}</span></button>`;
    const toolbar = `<div class="toolbar">
      <div class="segmented" role="group" aria-label="表示切り替え">${seg('open', '未完了', open.length)}${seg('done', '完了', done.length)}</div>
      ${filter === 'done' && done.length ? '<button type="button" class="btn btn-ghost btn-sm" data-action="clear-completed">完了済みを削除</button>' : ''}
    </div>`;

    let body;
    if (filter === 'done') {
      body = done.length
        ? `<section class="section">${list(done, (t) => todoItem(t, today))}</section>`
        : emptyState('check', '完了したタスクはまだありません', 'チェックを付けたタスクがここに表示されます。');
    } else if (!open.length) {
      body = emptyState('list', done.length ? '未完了のタスクはありません' : 'ToDoはまだありません',
        done.length ? 'すべて完了しました。おつかれさまです！' : '上の入力欄にタスク名を入れて Enter で追加。<br>締切日や重要度は「詳細」から設定できます。');
    } else {
      body = groupByDue(open, today).map((g) => `<section class="section" data-group="${g.key}">
          ${sectionHead(g.title, g.items.length)}
          ${list(g.items, (t) => todoItem(t, today))}
        </section>`).join('');
    }

    return `<div class="view view-todo">
      ${storageBanner(ctx)}
      ${viewHeader('ToDo', { desc: '締切日ごとに整理されたタスク一覧' })}
      ${quickAdd('todo', 'タスクを追加')}
      ${toolbar}
      ${body}
    </div>`;
  }

  /* ------------------------------------------------------------------
   * 画面：マトリクス（重要度 × 緊急度）
   * ------------------------------------------------------------------ */
  function quadrant(q, items, today) {
    const info = QUADRANT_INFO[q];
    return `<section class="quadrant" data-q="${q}" data-drop="${q}" style="grid-area:${q}" aria-label="${info.title}（${info.axis}）">
      <header class="quad-head">
        <div>
          <h2 class="quad-title"><i class="dot"></i>${info.title}</h2>
          <p class="quad-axis">${info.axis}<span class="quad-hint">　${info.hint}</span></p>
        </div>
        <span class="quad-count">${items.length}</span>
      </header>
      ${items.length
        ? `<ul class="quad-list">${items.map((t) => todoItem(t, today, { draggable: true, showQuadrant: false })).join('')}</ul>`
        : '<p class="quad-empty">タスクはありません</p>'}
      <form class="quad-add" data-quick="${q}" autocomplete="off">
        ${icon('plus', 'quick-icon')}
        <input name="title" type="text" maxlength="${S.LIMITS.title}" placeholder="追加" aria-label="「${info.title}」にタスクを追加" enterkeyhint="enter">
      </form>
    </section>`;
  }

  function viewMatrix(ctx) {
    const { state, today } = ctx;
    const open = state.todos.filter((t) => !t.completed);
    const by = (q) => open.filter((t) => t.quadrant === q).sort(byDue);
    const unclassified = by(null);

    const tray = unclassified.length
      ? `<section class="tray" data-drop="none" aria-label="未分類">
          ${sectionHead('未分類', unclassified.length, `<span class="tray-hint">${ctx.touch ? 'タップして象限を選択' : 'ドラッグして象限へ移動'}</span>`)}
          <ul class="quad-list">${unclassified.map((t) => todoItem(t, today, { draggable: true, showQuadrant: false })).join('')}</ul>
        </section>`
      : '';

    return `<div class="view view-matrix view--wide">
      ${storageBanner(ctx)}
      ${viewHeader('マトリクス', { desc: `重要度 × 緊急度で優先順位を整理します。${ctx.touch ? 'タスクをタップすると象限を変更できます。' : 'タスクはドラッグ＆ドロップで移動できます。'}` })}
      ${tray}
      <div class="matrix">
        <span class="axis" style="grid-area:x1">緊急</span>
        <span class="axis" style="grid-area:x2">緊急でない</span>
        <span class="axis axis-side" style="grid-area:y1" aria-label="重要">${verticalText('重要')}</span>
        <span class="axis axis-side" style="grid-area:y2" aria-label="重要でない">${verticalText('重要でない')}</span>
        ${['q1', 'q2', 'q3', 'q4'].map((q) => quadrant(q, by(q), today)).join('')}
      </div>
    </div>`;
  }

  /* ------------------------------------------------------------------ */
  const VIEWS = { today: viewToday, daily: viewDaily, todo: viewTodo, matrix: viewMatrix };

  K.views = {
    icon,
    summarize,
    QUADRANT_INFO,
    render: (name, ctx) => (VIEWS[name] || viewToday)(ctx),
  };
})(window.Kojin = window.Kojin || {});
