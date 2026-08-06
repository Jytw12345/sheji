/* 设计部工作台 · Service Worker
 * 离线缓存策略：
 *  - 同源核心静态资源：install 时预缓存，运行时 cache-first（保证秒开/离线可用）
 *  - 页面导航(/、/index.html)：network-first，失败回退缓存（保证总能启动）
 *  - 跨域 CDN（Supabase / Chart.js / xlsx）：stale-while-revalidate
 * 注意：所有预缓存路径使用相对路径，自动适配 GitHub Pages 子路径部署。
 */
const CACHE = 'dw-pwa-v265';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './vendor/supabase.js',
  './vendor/chart.js',
  './vendor/xlsx.js',
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
  // 注意：这里不要调用 self.skipWaiting()。
  // 必须由页面在用户点击「立即更新」时通过 postMessage({type:'SKIP_WAITING'}) 来唤醒，
  // 否则新版 SW 会自行跳过 waiting 直接激活并 clients.claim() 接管页面，
  // 导致「发现新版本」提示来不及出现 —— 表现成静默直接更新。
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
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
  try {
    const u = new URL(req.url);
    // Cache API 仅支持 http(s) scheme；chrome-extension://、moz-extension:// 等扩展/内部
    // 资源直接跳过，否则 c.put 会抛 “Request scheme 'chrome-extension' is unsupported”。
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (res && res.status === 200 && res.type !== 'error') {
      const c = await caches.open(CACHE);
      await c.put(req, res);
    }
  } catch (e) { /* 缓存失败不影响响应返回 */ }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 非 http(s) 协议（chrome-extension://、moz-extension://、file:// 等）不由 SW 接管，
  // 交给浏览器原生处理，避免 Cache API 不支持这些 scheme 而报错。
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

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
