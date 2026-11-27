/**
 * ocr.js — 手書きメモの写真を Claude API で文字に起こす
 *
 * - Anthropic 公式 SDK（js/vendor/anthropic-sdk-1.8.0.js）を、写真を読み取るときだけ読み込む
 * - API キーはこの端末の localStorage（kojin-claude-config）にだけ保存する（同期・エクスポートには含めない）
 * - 写真は読み取りのために Anthropic（api.anthropic.com）へ送信する。読み取った文字は画面で確認してから保存する
 * - 安全上の理由で断られた場合は、サーバー側の自動切り替え（fallbacks）で別のモデルが引き継ぐ
 */
(function (K) {
  'use strict';

  const CONFIG_KEY = 'kojin-claude-config';
  const MODEL = 'claude-opus-5-5';
  const SDK_PATH = 'js/vendor/anthropic-sdk-1.8.0.js';

  const SYSTEM = '手書きメモの写真を、書かれているとおりのテキストに書き起こします。';
  const PROMPT = [
    'この写真の手書きメモを、日本語のテキストに書き起こしてください。',
    '改行・箇条書き・番号は、メモの見た目のとおりに残してください。',
    '読めない文字は［?］と書いてください。',
    '前置きや説明は付けず、書き起こした本文だけを出力してください。',
    '文字が写っていない場合は「（文字が見つかりませんでした）」とだけ出力してください。',
  ].join('\n');

  let sdkPromise = null;

  /* ---------------- API キー（この端末だけに保存） ---------------- */
  function readKey() {
    try {
      const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      return c && typeof c.apiKey === 'string' ? c.apiKey : '';
    } catch (e) {
      return '';
    }
  }

  function saveKey(apiKey) {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ apiKey }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function forgetKey() {
    try { localStorage.removeItem(CONFIG_KEY); } catch (e) { /* noop */ }
  }

  /* ---------------- SDK ---------------- */
  function userError(message) {
    const err = new Error(message);
    err.userMessage = message;
    return err;
  }

  function loadSdk() {
    if (location.protocol === 'file:') {
      return Promise.reject(userError('写真の読み取りは、公開したページ（https:// で始まるURL）で開いたときに使えます。'));
    }
    if (!sdkPromise) {
      sdkPromise = import(new URL(SDK_PATH, document.baseURI).href).catch(() => {
        sdkPromise = null;
        throw userError('読み取りの準備ができませんでした。ネットワーク接続を確認して、もう一度お試しください。');
      });
    }
    return sdkPromise;
  }

  function newClient(Anthropic, apiKey, maxRetries) {
    // ブラウザから直接呼び出す（キーは利用者本人の端末にだけ保存している）
    return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries });
  }

  /** SDK の例外の種類ごとに、利用者向けの説明に置き換える */
  function describeError(Anthropic, e) {
    if (e && e.userMessage) return e.userMessage;
    if (Anthropic) {
      if (e instanceof Anthropic.AuthenticationError) return 'API キーが正しくないか、無効になっています。新しいキーを保存してください。';
      if (e instanceof Anthropic.PermissionDeniedError) return 'この API キーでは利用できません。Claude Console でキーの権限を確認してください。';
      if (e instanceof Anthropic.RateLimitError) return '利用の上限に達しました。少し待ってから、もう一度お試しください。';
      if (e instanceof Anthropic.BadRequestError) return '読み取りを受け付けられませんでした。写真の形式と、Claude Console のクレジット残高を確認してください。';
      if (e instanceof Anthropic.InternalServerError) return 'Claude が一時的に混み合っています。少し待ってから、もう一度お試しください。';
      if (e instanceof Anthropic.APIConnectionError) return 'Claude API に接続できません。ネットワーク接続を確認してください。';
      if (e instanceof Anthropic.APIError) return `読み取りに失敗しました（エラー ${e.status || '不明'}）。`;
    }
    return '読み取りに失敗しました。もう一度お試しください。';
  }

  /* ---------------- 読み取り ---------------- */
  /** 画像（base64）を文字に起こす。失敗時は userMessage 付きの Error を投げる */
  async function transcribe({ data, mediaType }) {
    const apiKey = readKey();
    if (!apiKey) throw userError('先に「設定・データ」→「手書きメモの読み取り」で Claude の API キーを保存してください。');
    let Anthropic = null;
    try {
      ({ Anthropic } = await loadSdk());
      const client = newClient(Anthropic, apiKey, 2);
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: PROMPT },
          ],
        }],
      });
      if (response.stop_reason === 'refusal') {
        throw userError('この写真は読み取りを断られました。別の写真でお試しください。');
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text) throw userError('文字を読み取れませんでした。明るい場所で、メモ全体が写るように撮り直してください。');
      return text;
    } catch (e) {
      throw userError(describeError(Anthropic, e));
    }
  }

  /** API キーが使えるかを確かめる（モデル情報の取得だけで、料金はかからない） */
  async function testKey(apiKey) {
    const key = apiKey || readKey(); // 省略したときは保存済みのキーを確かめる
    if (!key) throw userError('API キーを入力してください。');
    let Anthropic = null;
    try {
      ({ Anthropic } = await loadSdk());
      await newClient(Anthropic, key, 0).models.retrieve(MODEL);
      return true;
    } catch (e) {
      throw userError(describeError(Anthropic, e));
    }
  }

  K.ocr = {
    MODEL,
    hasKey: () => Boolean(readKey()),
    saveKey,
    forgetKey,
    testKey,
    transcribe,
  };
})(window.Kojin = window.Kojin || {});
