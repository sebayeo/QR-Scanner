/* 캐시 전략:
 *  - 정적 셸(HTML/CSS/JS/외부 라이브러리)은 cache-first → 빠른 재실행 + 약간의 오프라인 회복력
 *  - API 요청(GAS 도메인)은 캐시하지 않음 (항상 최신 데이터)
 */

const CACHE_NAME = 'event-scanner-v1';
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
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // GAS API 호출은 절대 캐시 X
  if (url.hostname.includes('script.google.com') || url.hostname.includes('googleusercontent.com')) {
    return; // 브라우저 기본 동작
  }

  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // 같은 출처거나 SHELL에 포함된 외부 라이브러리만 캐시
        const sameOrigin = url.origin === self.location.origin;
        const isShellExternal = SHELL.includes(req.url);
        if ((sameOrigin || isShellExternal) && res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
