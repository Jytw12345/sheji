/* 设计部工作台 · Service Worker
 * 离线缓存策略：
 *  - 同源核心静态资源：install 时预缓存，运行时 cache-first（保证秒开/离线可用）
 *  - 页面导航(/、/index.html)：network-first，失败回退缓存（保证总能启动）
 *  - 跨域 CDN（Supabase / Chart.js / xlsx）：stale-while-revalidate
 * 注意：所有预缓存路径使用相对路径，自动适配 GitHub Pages 子路径部署。
 */
const CACHE = 'dw-pwa-v38';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/config.js',
  './js/db.js',
  './js/calc.js',
  './js/charts.js',
  './js/export.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())  // 立即激活，不等旧版退出
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cachePut(req, res) {
  if (res && res.status === 200 && res.type !== 'error') {
    const c = await caches.open(CACHE);
    await c.put(req, res);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 页面导航：network-first，回退缓存外壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // 同源静态：network-first（开发期每次取最新，离线回退缓存）
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // 跨域 CDN：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((m) => {
      const network = fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => m);
      return m || network;
    })
  );
});
