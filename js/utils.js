/**
 * utils.js — 日付・文字列などの共通ユーティリティ
 *
 * 日付は "YYYY-MM-DD" 形式の文字列（以下「日付キー」）で扱う。
 * toISOString() は UTC になり日本時間の朝9時前に日付がずれるため、必ずローカル時刻から生成する。
 */
(function (K) {
  'use strict';

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const pad = (n) => String(n).padStart(2, '0');

  /** Date → 日付キー（ローカル時刻基準） */
  function dateKey(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 日付キー → Date（ローカル時刻の 0:00） */
  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  /** 実在する日付キーかどうか */
  function isDateKey(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    return dateKey(parseKey(v)) === v;
  }

  function addDays(key, n) {
    const d = parseKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }

  /** from から to までの日数（to が未来なら正） */
  function diffDays(from, to) {
    return Math.round((parseKey(to) - parseKey(from)) / 86400000);
  }

  /** 曜日番号（0 = 日曜） */
  function weekday(key) {
    return parseKey(key).getDay();
  }

  /** 例: 11/26(木) */
  function formatShort(key) {
    const d = parseKey(key);
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  }

  /** 例: 11月26日（木） */
  function formatMonthDay(key) {
    const d = parseKey(key);
    return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
  }

  /** ISO 日時文字列 → 日付キー */
  function isoToKey(iso) {
    return dateKey(new Date(iso));
  }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** ユーザー入力を HTML に埋め込む前に必ず通す */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  function truncate(s, max) {
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  K.utils = {
    WEEKDAYS,
    dateKey,
    parseKey,
    isDateKey,
    addDays,
    diffDays,
    weekday,
    formatShort,
    formatMonthDay,
    isoToKey,
    escapeHtml,
    truncate,
    uid,
  };
})(window.Kojin = window.Kojin || {});
