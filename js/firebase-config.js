/**
 * firebase-config.js — PC・スマホ間の同期機能の設定
 *
 * Firebase コンソールの「プロジェクトの設定 > マイアプリ」に表示される firebaseConfig の値を貼り付けると、
 * 同期機能（ログイン）が使えるようになります。null のままなら同期はオフで、これまでどおりこの端末だけに保存されます。
 *
 * ※ ここに書く値は Web アプリに公開される前提の識別子で、パスワードではありません。
 *    データは Firestore のセキュリティルール（README 参照）で「本人だけが読み書きできる」ように保護します。
 *
 * 例:
 * window.KOJIN_FIREBASE_CONFIG = {
 *   apiKey: 'AIza...',
 *   authDomain: 'your-project.firebaseapp.com',
 *   projectId: 'your-project',
 *   storageBucket: 'your-project.appspot.com',
 *   messagingSenderId: '000000000000',
 *   appId: '1:000000000000:web:xxxxxxxxxxxx',
 * };
 */
window.KOJIN_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDXTrJlsPK0kxXGCWzyrMwWZSV6wneS25E',
  authDomain: 'kojintodo.firebaseapp.com',
  projectId: 'kojintodo',
  storageBucket: 'kojintodo.firebasestorage.app',
  messagingSenderId: '291234355808',
  appId: '1:291234355808:web:436038c679b147da314105',
};
