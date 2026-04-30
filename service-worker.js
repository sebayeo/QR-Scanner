/* 캐시 전략:
 *  - 같은 출처(앱 코드 = HTML/JS/CSS/JSON)는 network-first → 항상 최신 코드 적용
 *  - 외부 라이브러리(jsQR, Chart.js)는 cache-first → 빠른 재실행
 *  - GAS API 는 캐시 X (항상 최신 데이터)
 *
 * 업데이트 방법: CACHE_NAME 의 버전을 올리면 기존 캐시가 폐기되고 새 셸을 가져옵니다.
 */

const CACHE_NAME = 'event-scanner-v3';   // ← 변경 시 버전을 올리세요
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // GAS API 는 절대 캐시하지 않음
  if (url.hostname.includes('script.google.com') || url.hostname.includes('googleusercontent.com')) {
    return; // 브라우저 기본 동작
  }

  // 같은 출처 (앱 코드) → network-first. 업데이트가 즉시 반영됨.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 외부 (CDN 라이브러리) → cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
