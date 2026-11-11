/* 필기노트 서비스 워커 — 오프라인 캐시 + 📌 고정 알림 처리
   앱을 고치면 VERSION 숫자만 올려주세요 */
const VERSION = 'v1.1.0';
const CACHE = 'stylusnote-' + VERSION;
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // 캐시에서 바로 열고(빠른 실행), 뒤에서 새 버전을 받아 둠
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

/* ───── 앱과 같은 저장소(IndexedDB) ───── */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('stylusnote', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      ['memos', 'outbox', 'photos', 'meta'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(store, key) {
  const d = await idb();
  return new Promise((res, rej) => { const q = d.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function idbPut(store, val) {
  const d = await idb();
  return new Promise((res, rej) => { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(val); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

async function tellClients(msg) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach(c => c.postMessage(msg));
  return list;
}

/* ✅ 확인: 고정 해제 → 앱 저장소·서버에 반영 */
async function confirmMemo(id) {
  const at = Date.now();
  try {
    const m = await idbGet('memos', id);
    if (m) { m.pinned = false; m.pinAt = at; await idbPut('memos', m); }
  } catch (e) { /* 무시 */ }
  await tellClients({ type: 'unpinned', id, at });
  try {
    const conn = await idbGet('meta', 'conn');
    if (conn && conn.url && conn.pw) {
      await fetch(conn.url, { method: 'POST', body: JSON.stringify({ password: conn.pw, action: 'pin', id, pinned: false }) });
    }
  } catch (e) { /* 앱을 다음에 열면 저장하면서 반영됨 */ }
}

async function openMemo(id) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const scope = self.registration.scope;
  const win = list.find(c => c.url.startsWith(scope));
  if (win) {
    await win.focus();
    win.postMessage({ type: 'open', id });
    return;
  }
  await self.clients.openWindow(scope + '?memo=' + encodeURIComponent(id));
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification, id = n.data && n.data.id;
  n.close();
  if (!id) return;
  if (e.action === 'ok') e.waitUntil(confirmMemo(id));
  else e.waitUntil(openMemo(id));
});

/* 밀어서 지웠을 때: 아직 확인 전이면 다시 띄움 */
self.addEventListener('notificationclose', (e) => {
  const n = e.notification, id = n.data && n.data.id;
  if (!id) return;
  e.waitUntil((async () => {
    const m = await idbGet('memos', id).catch(() => null);
    if (!m || !m.pinned) return;
    await self.registration.showNotification(n.title, {
      body: n.body, tag: n.tag, icon: n.icon, badge: n.badge, data: n.data,
      requireInteraction: true, silent: true,
      actions: [{ action: 'ok', title: '✅ 확인' }, { action: 'open', title: '열기' }]
    });
  })());
});
