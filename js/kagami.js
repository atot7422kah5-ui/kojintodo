/**
 * kagami.js — 日記を GitHub のリポジトリ（自己理解パートナー「カガミ」）へ送る
 *
 * 設定ダイアログの「カガミ連携」で GitHub のトークン・リポジトリを保存すると、
 * 日記・メモを保存したとき（と、アプリを開いたとき）に、変更のあった日の日記を
 * `<path>/<YYYY-MM-DD>.md` として GitHub に書き込みます。
 * その日のメモ（メモ画面で書いたもの）は、同じファイルの「## 今日のメモ」に入ります。
 *
 * - トークンはこの端末の localStorage にだけ保存します（クラウド同期・エクスポートには含めません）。
 * - 通信先は https://api.github.com だけです。
 * - 送った内容のハッシュを端末に記録し、変わっていない日は送りません。
 * - 日記を消しても GitHub 側のファイルは消しません（誤削除を防ぐため）。
 */
(function (K) {
  'use strict';

  const S = K.store;
  const CONFIG_KEY = 'kojin-kagami-config';
  const PUSHED_KEY = 'kojin-kagami-pushed';
  const API = 'https://api.github.com';
  const SAVE_DELAY_MS = 15000; // 入力が止まってから送るまでの待ち時間
  const DEFAULTS = { repo: 'atot7422kah5-ui/jibunrikai', branch: 'main', path: 'journal/diary' };
  const MOOD_LABELS = { 1: 'しんどい', 2: 'いまいち', 3: 'ふつう', 4: 'いい感じ', 5: '最高' };
  const MEMO_SOURCE_LABELS = { text: '', voice: '（音声）' };
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  /* ---------------- 保存まわり ---------------- */
  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }
  const getConfig = () => {
    const c = readJson(CONFIG_KEY, null);
    return c && c.token ? { ...DEFAULTS, ...c } : null;
  };

  /* ---------------- 日記 → Markdown ---------------- */
  function weekday(date) {
    const [y, m, d] = date.split('-').map(Number);
    return WEEKDAYS[new Date(y, m - 1, d).getDay()];
  }
  const clean = (s) => String(s || '').replace(/\r\n?/g, '\n').trim();

  function timeOf(iso) {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** メモを時刻順の箇条書きにする（2行目以降は字下げして同じ項目に含める） */
  function memoSection(memos) {
    if (!memos.length) return [];
    const items = memos.map((m) => {
      const [first, ...rest] = clean(m.text).split('\n');
      return [`- ${timeOf(m.createdAt)}${MEMO_SOURCE_LABELS[m.source] || ''} ${first}`, ...rest.map((l) => `  ${l}`)].join('\n');
    });
    return ['## 今日のメモ', ...items, ''];
  }

  /** その日の日記（なければ null）とメモから、送る Markdown を作る */
  function buildMarkdown(date, journal, memos) {
    if (journal) return toMarkdown(journal, memos);
    return [
      '---',
      `date: ${date}`,
      'mood: ',
      'source: kojintodo',
      '---',
      '',
      `# ${date}（${weekday(date)}）の日記`,
      '',
      '（この日の日記はまだありません）',
      '',
      ...memoSection(memos),
    ].join('\n');
  }

  function toMarkdown(j, memos = []) {
    const goods = (j.good || []).map(clean);
    const lines = [
      '---',
      `date: ${j.date}`,
      `mood: ${j.mood || ''}`,
      'source: kojintodo',
      '---',
      '',
      `# ${j.date}（${weekday(j.date)}）の日記`,
      '',
      '## 今日の気分',
      j.mood ? `${j.mood} / 5（${MOOD_LABELS[j.mood]}）` : '（未記入）',
      '',
      '## 今日の1%成長',
      clean(j.growth) || '（未記入）',
      '',
      '## 良かったこと',
      ...[0, 1, 2].map((i) => `${i + 1}. ${goods[i] || ''}`.trimEnd()),
      '',
      '## 明日の自分へ一言',
      clean(j.tomorrow) || '（未記入）',
      '',
      '## 自由メモ',
      clean(j.memo) || '（未記入）',
      '',
      ...memoSection(memos),
    ];
    return lines.join('\n');
  }

  // 内容が変わったかを見るための軽いハッシュ（FNV-1a）
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  // UTF-8 ⇄ base64
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function fromBase64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /* ---------------- GitHub API ---------------- */
  function request(cfg, method, url, body) {
    return fetch(`${API}${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      keepalive: method !== 'GET',
    });
  }

  function explain(status) {
    if (status === 401) return 'トークンが無効か、期限切れです。新しいトークンを保存してください。';
    if (status === 403) return 'トークンにこのリポジトリへの書き込み権限がありません（Contents: Read and write が必要です）。';
    if (status === 404) return 'リポジトリかブランチが見つかりません。名前と、トークンの対象リポジトリを確認してください。';
    if (status === 409 || status === 422) return '書き込みが競合しました。少し待ってからもう一度送ってください。';
    return `GitHub への送信に失敗しました（${status}）。`;
  }

  const filePath = (cfg, date) => `${cfg.path.replace(/^\/+|\/+$/g, '')}/${date}.md`;
  const contentsUrl = (cfg, date) => `/repos/${cfg.repo}/contents/${filePath(cfg, date).split('/').map(encodeURIComponent).join('/')}`;

  async function pushEntry(cfg, entry, markdown) {
    const url = contentsUrl(cfg, entry.date);
    const got = await request(cfg, 'GET', `${url}?ref=${encodeURIComponent(cfg.branch)}`);
    let sha;
    if (got.ok) {
      const file = await got.json();
      if (fromBase64(file.content || '') === markdown) return 'same';
      sha = file.sha;
    } else if (got.status !== 404) {
      throw new Error(explain(got.status));
    }
    const put = await request(cfg, 'PUT', url, {
      message: `diary: ${entry.date}`,
      content: toBase64(markdown),
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    });
    if (!put.ok) throw new Error(explain(put.status));
    return sha ? 'updated' : 'created';
  }

  /* ---------------- 同期 ---------------- */
  const status = { state: 'idle', message: '', at: null };
  let running = false;
  let again = false;
  let timer = null;

  function setStatus(state, message) {
    status.state = state;
    status.message = message;
    status.at = new Date();
    renderStatus();
  }

  async function syncAll() {
    const cfg = getConfig();
    if (!cfg || !cfg.enabled) return { sent: 0 };
    if (running) { again = true; return { sent: 0 }; }
    running = true;
    let sent = 0;
    try {
      const pushed = readJson(PUSHED_KEY, {});
      const journals = S.getState().journals || [];
      const memos = S.getState().memos || [];
      // 日記のある日と、メモだけの日の両方を送る
      const dates = [...new Set([...journals.map((j) => j.date), ...memos.map((m) => m.date)])].sort();
      for (const date of dates) {
        const journal = journals.find((j) => j.date === date) || null;
        const md = buildMarkdown(date, journal, memos.filter((m) => m.date === date));
        const h = hash(`${cfg.repo}|${cfg.branch}|${cfg.path}|${md}`);
        if (pushed[date] === h) continue;
        setStatus('sending', `${date} の日記を送っています…`);
        const result = await pushEntry(cfg, { date }, md);
        pushed[date] = h;
        writeJson(PUSHED_KEY, pushed);
        if (result !== 'same') sent += 1;
      }
      setStatus('ok', sent ? `${sent} 日分をカガミに送りました` : (dates.length ? 'カガミと同じ内容です' : '送る日記はまだありません'));
    } catch (e) {
      setStatus('error', e && e.message ? e.message : 'カガミへの送信に失敗しました。');
    } finally {
      running = false;
      if (again) { again = false; schedule(1000); }
    }
    return { sent };
  }

  function schedule(delay = SAVE_DELAY_MS) {
    clearTimeout(timer);
    timer = setTimeout(syncAll, delay);
  }

  function flush() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    syncAll();
  }

  /* ---------------- 設定 UI ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);

  function renderStatus() {
    const el = $('[data-kagami-status]');
    if (!el) return;
    const cfg = getConfig();
    if (!cfg) {
      el.textContent = '未設定です。トークンを保存すると、日記を書くたびにカガミへ送られます。';
    } else if (!cfg.enabled) {
      el.textContent = '送信は止めています。';
    } else if (status.message) {
      const t = status.at ? status.at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
      el.textContent = `${status.message}${t ? `（${t}）` : ''}`;
    } else {
      el.textContent = `送信先：${cfg.repo}（${cfg.branch}）/${cfg.path}`;
    }
    el.classList.toggle('is-error', status.state === 'error');
  }

  function fillForm() {
    const form = $('#kagami-form');
    if (!form) return;
    const cfg = { ...DEFAULTS, ...(readJson(CONFIG_KEY, {}) || {}) };
    form.elements.repo.value = cfg.repo;
    form.elements.branch.value = cfg.branch;
    form.elements.path.value = cfg.path;
    form.elements.token.value = '';
    form.elements.token.placeholder = cfg.token ? '保存済み（変更するときだけ入力）' : 'github_pat_...';
    form.elements.enabled.checked = cfg.token ? cfg.enabled !== false : true;
    renderStatus();
  }

  function saveForm(form) {
    const prev = readJson(CONFIG_KEY, {}) || {};
    const token = form.elements.token.value.trim() || prev.token || '';
    const next = {
      token,
      repo: form.elements.repo.value.trim() || DEFAULTS.repo,
      branch: form.elements.branch.value.trim() || DEFAULTS.branch,
      path: form.elements.path.value.trim() || DEFAULTS.path,
      enabled: form.elements.enabled.checked,
    };
    if (!next.token) {
      setStatus('error', 'トークンを入力してください。');
      return null;
    }
    writeJson(CONFIG_KEY, next);
    return next;
  }

  async function testConnection(cfg) {
    setStatus('sending', '接続を確かめています…');
    try {
      const res = await request(cfg, 'GET', `/repos/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`);
      if (!res.ok) throw new Error(explain(res.status));
      setStatus('ok', '接続できました');
      return true;
    } catch (e) {
      setStatus('error', e.message);
      return false;
    }
  }

  function setupUi() {
    const form = $('#kagami-form');
    if (!form) return;
    fillForm();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cfg = saveForm(form);
      if (!cfg) return;
      fillForm();
      if (cfg.enabled && await testConnection(cfg)) {
        writeJson(PUSHED_KEY, {}); // 送信先が変わった場合に備えて、すべて確かめ直す
        syncAll();
      }
    });
    form.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-kagami]');
      if (!btn) return;
      const cfg = getConfig();
      if (btn.dataset.kagami === 'send-now') {
        if (!cfg) { setStatus('error', '先にトークンを保存してください。'); return; }
        writeJson(PUSHED_KEY, {});
        syncAll();
      } else if (btn.dataset.kagami === 'forget') {
        if (!window.confirm('この端末に保存したトークンを削除します。よろしいですか？')) return;
        writeJson(CONFIG_KEY, null);
        writeJson(PUSHED_KEY, null);
        status.message = '';
        fillForm();
      }
    });
    const dialog = $('#settings-dialog');
    if (dialog) {
      new MutationObserver(() => { if (dialog.open) fillForm(); })
        .observe(dialog, { attributes: true, attributeFilter: ['open'] });
    }
  }

  /* ---------------- 起動 ---------------- */
  S.subscribe(() => { if (getConfig()) schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
  setupUi();
  if (getConfig()) schedule(5000); // 開いたときに、ほかの端末で書いた分も含めて確かめる

  K.kagami = { toMarkdown, buildMarkdown, syncAll, getConfig };
})(window.Kojin = window.Kojin || {});
