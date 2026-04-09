/* =============================================================
   Mono Planner - service-worker.js
   PWA 오프라인 지원 서비스 워커
   ============================================================= */

const CACHE_NAME = 'mono-planner-v1.0.0';

// 캐시할 파일 목록
const CACHE_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json'
];

/* ── 설치 이벤트: 캐시 생성 ─── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching app shell');
        return cache.addAll(CACHE_FILES);
      })
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Cache install failed:', err))
  );
});

/* ── 활성화 이벤트: 이전 캐시 정리 ─── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch 이벤트: 캐시 우선(Cache First) 전략 ─── */
self.addEventListener('fetch', event => {
  // POST 요청, IndexedDB 요청 등은 무시
  if (event.request.method !== 'GET') return;

  // Chrome Extension, data URL 등 무시
  const url = event.request.url;
  if (!url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) {
          // 캐시에 있으면 즉시 반환, 백그라운드에서 업데이트
          fetch(event.request)
            .then(response => {
              if (response && response.status === 200) {
                caches.open(CACHE_NAME).then(cache => {
                  cache.put(event.request, response);
                });
              }
            })
            .catch(() => {}); // 네트워크 오류 무시
          return cached;
        }

        // 캐시에 없으면 네트워크 요청
        return fetch(event.request)
          .then(response => {
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            // 응답을 캐시에 저장
            const toCache = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, toCache);
            });
            return response;
          })
          .catch(() => {
            // 네트워크도 없으면 오프라인 폴백
            if (event.request.destination === 'document') {
              return caches.match('./index.html');
            }
          });
      })
  );
});

/* ── 메시지 이벤트 ─── */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
