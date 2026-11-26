/**
 * sync.js — Firebase（Authentication + Cloud Firestore）による PC・スマホ間の同期
 *
 * - firebase-config.js が未設定、またはファイルを直接開いている場合は何もしない（この端末だけに保存）
 * - ログイン中は、端末内の変更（store.onLocalChange）を Firestore に書き込み、
 *   Firestore 側の変更（onSnapshot）を store.replaceCollections で画面に反映する
 * - Firestore のオフライン保存を有効にしているため、圏外での変更はつながった時点で送信される
 * - Firebase の読み込み前など、まだ送れない変更は「送信待ち（outbox）」として localStorage に保管する
 *
 * クラウド上の保存場所: users/{uid}/todos/{id}, users/{uid}/dailies/{id}
 * （セキュリティルールで、本人の uid 以下だけを読み書きできるようにする）
 */
(function (K) {
  'use strict';

  const S = K.store;
  const SDK_BASE = 'https://www.gstatic.com/firebasejs/10.14.1';
  const SDK_FILES = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];
  const KINDS = ['todos', 'dailies'];
  const BATCH_LIMIT = 400; // Firestore の一括書き込みは 500 件まで
  const UID_KEY = `${S.STORAGE_KEY}:sync-uid`;
  const OUTBOX_KEY = `${S.STORAGE_KEY}:sync-outbox`;

  /**
   * state:
   *   disabled    … firebase-config.js が未設定
   *   unsupported … ファイルを直接開いている（file://）ため同期できない
   *   loading     … Firebase を読み込み中
   *   signedOut   … 未ログイン
   *   syncing / synced / offline … ログイン中
   *   error       … エラー（error にメッセージ）
   */
  const status = { state: 'disabled', user: null, error: '' };
  const statusListeners = new Set();

  let fb = null;
  let auth = null;
  let db = null;
  let uid = null;
  let starting = false; // ログイン直後の準備中
  let active = false;   // 変更をそのまま Firestore に書き込める状態
  let unsubscribers = [];
  let remote = emptyRemote();
  let received = { todos: false, dailies: false };
  let pendingWrites = { todos: false, dailies: false };

  function emptyRemote() {
    return { todos: new Map(), dailies: new Map() };
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    const snapshot = { ...status };
    statusListeners.forEach((fn) => fn(snapshot));
  }

  function onStatus(fn) {
    statusListeners.add(fn);
    fn({ ...status });
    return () => statusListeners.delete(fn);
  }

  /* ------------------------------------------------------------------
   * localStorage の補助（送信待ちの変更・最後にログインしたユーザー）
   * ------------------------------------------------------------------ */
  function readJson(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* noop */ }
  }

  function removeKey(key) {
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  }

  const lastUid = () => readJson(UID_KEY, null);
  const clearOutbox = () => removeKey(OUTBOX_KEY);

  function appendOutbox(ops) {
    writeJson(OUTBOX_KEY, readJson(OUTBOX_KEY, []).concat(ops));
  }

  /* ------------------------------------------------------------------
   * エラーメッセージ
   * ------------------------------------------------------------------ */
  const WRONG_CREDENTIAL = 'メールアドレスまたはパスワードが違います。';
  const ERRORS = {
    'auth/popup-closed-by-user': '',
    'auth/cancelled-popup-request': '',
    'auth/popup-blocked': 'ログイン画面がブロックされました。ポップアップを許可するか、メールアドレスでログインしてください。',
    'auth/operation-not-supported-in-this-environment': 'この環境では Google ログインを使えません。メールアドレスでログインしてください。',
    'auth/unauthorized-domain': 'このURLではログインが許可されていません。Firebase の「承認済みドメイン」にこのサイトのドメインを追加してください。',
    'auth/operation-not-allowed': 'このログイン方法が有効になっていません。Firebase の Authentication で有効にしてください。',
    'auth/invalid-email': 'メールアドレスの形式が正しくありません。',
    'auth/missing-email': 'メールアドレスを入力してください。',
    'auth/missing-password': 'パスワードを入力してください。',
    'auth/invalid-credential': WRONG_CREDENTIAL,
    'auth/invalid-login-credentials': WRONG_CREDENTIAL,
    'auth/wrong-password': WRONG_CREDENTIAL,
    'auth/user-not-found': WRONG_CREDENTIAL,
    'auth/email-already-in-use': 'このメールアドレスはすでに登録されています。「ログイン」を押してください。',
    'auth/weak-password': 'パスワードは6文字以上にしてください。',
    'auth/too-many-requests': '試行回数が多すぎます。しばらく待ってからもう一度お試しください。',
    'auth/network-request-failed': 'ネットワークに接続できません。接続を確認してください。',
    'permission-denied': 'クラウドへのアクセスが拒否されました。Firestore のセキュリティルールを確認してください。',
    unavailable: 'クラウドに接続できません。接続が戻ると自動で同期します。',
  };

  function describeError(e) {
    const code = e && e.code;
    if (code && Object.prototype.hasOwnProperty.call(ERRORS, code)) return ERRORS[code];
    return `エラーが発生しました（${code || (e && e.message) || '原因不明'}）`;
  }

  function describeUser(user) {
    const providerId = user.providerData && user.providerData[0] && user.providerData[0].providerId;
    return {
      email: user.email || '',
      name: user.displayName || '',
      provider: providerId === 'google.com' ? 'Google' : 'メールアドレス',
    };
  }

  /* ------------------------------------------------------------------
   * Firestore への書き込み
   * ------------------------------------------------------------------ */
  const col = (kind) => db.collection('users').doc(uid).collection(kind);

  function toDoc(item) {
    const { id, ...rest } = item;
    return rest;
  }

  function handleWriteError(e) {
    if (e && e.code === 'not-found') return; // 別の端末で削除済みの Daily へのチェックなど
    setStatus({ state: 'error', error: describeError(e) });
  }

  async function commitInBatches(writes) {
    for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      writes.slice(i, i + BATCH_LIMIT).forEach((w) => w(batch));
      await batch.commit(); // eslint-disable-line no-await-in-loop
    }
  }

  function replaceAllRemote(op) {
    const writes = [];
    KINDS.forEach((kind) => {
      const keep = new Set(op[kind].map((item) => item.id));
      remote[kind].forEach((_, id) => {
        if (!keep.has(id)) writes.push((b) => b.delete(col(kind).doc(id)));
      });
      op[kind].forEach((item) => writes.push((b) => b.set(col(kind).doc(item.id), toDoc(item))));
    });
    return commitInBatches(writes);
  }

  // 書き込みはサーバーの応答を待たない（圏外でも Firestore が保持し、つながった時点で送信する）
  function write(ops) {
    const FieldValue = fb.firestore.FieldValue;
    ops.forEach((op) => {
      let p = null;
      if (op.type === 'set') {
        p = col(op.kind).doc(op.item.id).set(toDoc(op.item));
      } else if (op.type === 'delete') {
        p = col(op.kind).doc(op.id).delete();
      } else if (op.type === 'done') {
        // 完了チェックは配列への追加・削除として送り、複数の端末での操作がぶつからないようにする
        p = col('dailies').doc(op.id).update({
          doneDates: op.done ? FieldValue.arrayUnion(op.key) : FieldValue.arrayRemove(op.key),
          updatedAt: op.updatedAt,
        });
      } else if (op.type === 'replaceAll') {
        p = replaceAllRemote(op);
      }
      if (p) p.catch(handleWriteError);
    });
  }

  function handleLocalChange(ops) {
    if (active) {
      write(ops);
    } else if (starting || lastUid()) {
      appendOutbox(ops); // ログイン済みだがまだ送れない変更は保管しておく
    }
  }

  /* ------------------------------------------------------------------
   * ログイン後の処理
   * ------------------------------------------------------------------ */
  async function fetchRemote() {
    const result = emptyRemote();
    const snaps = await Promise.all(KINDS.map((kind) => col(kind).get()));
    snaps.forEach((snap, i) => {
      snap.forEach((doc) => result[KINDS[i]].set(doc.id, { ...doc.data(), id: doc.id }));
    });
    return result;
  }

  const union = (a = [], b = []) => [...new Set([...a, ...b])].sort();

  /** この端末で初めてログインしたとき、端末内のデータをクラウドへ統合する */
  function mergeLocalIntoRemote() {
    const local = S.getState();
    const uploads = [];
    KINDS.forEach((kind) => {
      local[kind].forEach((item) => {
        const r = remote[kind].get(item.id);
        if (!r) {
          uploads.push({ kind, item });
        } else if ((item.updatedAt || '') > (r.updatedAt || '')) {
          const merged = kind === 'dailies' ? { ...item, doneDates: union(item.doneDates, r.doneDates) } : item;
          uploads.push({ kind, item: merged });
        }
      });
    });
    if (!uploads.length) return;
    const remoteCount = remote.todos.size + remote.dailies.size;
    if (remoteCount > 0) {
      const ok = window.confirm(
        `この端末に保存されているタスク ${uploads.length} 件を、クラウドのデータに追加しますか？\n\n`
        + 'OK：追加する\nキャンセル：追加せず、クラウドのデータを表示する',
      );
      if (!ok) return;
    }
    commitInBatches(uploads.map((u) => (b) => b.set(col(u.kind).doc(u.item.id), toDoc(u.item)))).catch(handleWriteError);
  }

  function refreshState() {
    if (!uid || starting) return;
    if (!navigator.onLine) {
      setStatus({ state: 'offline' });
      return;
    }
    if (status.error) {
      setStatus({ state: 'error' });
      return;
    }
    const busy = !received.todos || !received.dailies || pendingWrites.todos || pendingWrites.dailies;
    setStatus({ state: busy ? 'syncing' : 'synced' });
  }

  function listen() {
    remote = emptyRemote();
    received = { todos: false, dailies: false };
    unsubscribers = KINDS.map((kind) => col(kind).onSnapshot({ includeMetadataChanges: true }, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') remote[kind].delete(change.doc.id);
        else remote[kind].set(change.doc.id, { ...change.doc.data(), id: change.doc.id });
      });
      // 端末内のキャッシュが空でサーバーの応答がまだのときは、反映を待つ（一瞬データが消えて見えるのを防ぐ）
      if (snap.metadata.fromCache && remote[kind].size === 0 && navigator.onLine) return;
      received[kind] = true;
      pendingWrites[kind] = snap.metadata.hasPendingWrites;
      if (received.todos && received.dailies) {
        S.replaceCollections({ todos: [...remote.todos.values()], dailies: [...remote.dailies.values()] });
      }
      if (status.error && !snap.metadata.fromCache) setStatus({ error: '' });
      refreshState();
    }, (e) => setStatus({ state: 'error', error: describeError(e) })));
  }

  async function start(user) {
    const previousUid = lastUid();
    if (previousUid !== user.uid) clearOutbox(); // 別のアカウントの送信待ちは破棄
    uid = user.uid;
    starting = true;
    active = false;
    setStatus({ state: 'syncing', user: describeUser(user), error: '' });

    try {
      const fetched = await fetchRemote();
      if (uid !== user.uid) return; // 取得中にログアウトした
      remote = fetched;
    } catch (e) {
      remote = emptyRemote(); // 圏外などで取得できなくても続行する
    }
    if (previousUid !== user.uid) mergeLocalIntoRemote();

    writeJson(UID_KEY, user.uid);
    starting = false;
    active = true;
    const outbox = readJson(OUTBOX_KEY, []);
    clearOutbox();
    if (outbox.length) write(outbox);
    listen();
    refreshState();
  }

  function stop() {
    unsubscribers.forEach((fn) => fn());
    unsubscribers = [];
    const wasSignedIn = uid !== null;
    uid = null;
    starting = false;
    active = false;
    remote = emptyRemote();
    received = { todos: false, dailies: false };
    if (!wasSignedIn) {
      // 起動時にログインが切れていた場合は、この端末だけで使う状態に戻す
      removeKey(UID_KEY);
      clearOutbox();
    }
    setStatus({ state: 'signedOut', user: null, error: '' });
  }

  /* ------------------------------------------------------------------
   * 公開する操作
   * ------------------------------------------------------------------ */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`読み込みに失敗しました: ${src}`));
      document.head.append(el);
    });
  }

  async function init() {
    const config = window.KOJIN_FIREBASE_CONFIG;
    if (!config) {
      setStatus({ state: 'disabled' });
      return;
    }
    if (location.protocol === 'file:') {
      setStatus({ state: 'unsupported' });
      return;
    }
    setStatus({ state: 'loading' });
    S.onLocalChange(handleLocalChange);
    try {
      for (const file of SDK_FILES) await loadScript(`${SDK_BASE}/${file}`); // eslint-disable-line no-await-in-loop
      fb = window.firebase;
      fb.initializeApp(config);
      auth = fb.auth();
      db = fb.firestore();
      try {
        await db.enablePersistence({ synchronizeTabs: true });
      } catch (e) {
        // 対応していないブラウザでは、オフライン中の変更は送信待ち（outbox）でのみ保持される
      }
    } catch (e) {
      setStatus({ state: 'error', error: '同期機能を読み込めませんでした。ネットワーク接続を確認し、ページを再読み込みしてください。' });
      return;
    }
    auth.onAuthStateChanged((user) => {
      if (user) start(user);
      else stop();
    });
    window.addEventListener('online', refreshState);
    window.addEventListener('offline', refreshState);
  }

  function ensureAuth() {
    if (!auth) throw new Error('同期機能の準備ができていません。少し待ってからもう一度お試しください。');
  }

  async function run(fn) {
    ensureAuth();
    try {
      return await fn();
    } catch (e) {
      const err = new Error(describeError(e));
      err.code = e && e.code;
      throw err;
    }
  }

  K.sync = {
    init,
    onStatus,
    getStatus: () => ({ ...status }),
    signInWithGoogle: () => run(() => auth.signInWithPopup(new fb.auth.GoogleAuthProvider())),
    signInWithEmail: (email, password) => run(() => auth.signInWithEmailAndPassword(email, password)),
    signUpWithEmail: (email, password) => run(() => auth.createUserWithEmailAndPassword(email, password)),
    resetPassword: (email) => run(() => auth.sendPasswordResetEmail(email)),
    async signOut() {
      await run(() => auth.signOut());
      removeKey(UID_KEY);
      clearOutbox();
      S.clearLocalData(); // クラウドには残るので、再度ログインすれば表示される
    },
  };
})(window.Kojin = window.Kojin || {});
