/* 设计部工作台 · Service Worker
 * 离线缓存策略：
 *  - 同源核心静态资源：install 时预缓存，运行时 SWR（缓存秒回 + 后台刷新，启动不等网络）
 *  - 页面导航(/、/index.html)：network-first 带 2.5s 超时竞速，慢网络立即回退缓存外壳（保证总能快速启动）
 *  - 跨域 CDN（Supabase / Chart.js / xlsx）：Supabase 数据 network-first，其余 stale-while-revalidate
 * 注意：所有预缓存路径使用相对路径，自动适配 GitHub Pages 子路径部署。
 */
const CACHE = 'dw-pwa-v583';

/* 版本参数说明（两套，互相独立）
 *  APPV —— 自研代码（js/*.js、css/styles.css）。每次改前端代码发版都要 +1，
 *          必须与 index.html 里的 ?vNNN 保持一致。
 *  LIBV —— 第三方库（vendor/*.js，约 1.3MB）。这些文件平时不动，
 *          只有真的替换/升级库文件时才 +1。URL 不变 → 浏览器与 SW 都直接复用
 *          已有副本，发版时零重复下载。
 * PRECACHE 里的 URL 必须与 index.html 中的请求 URL 逐字一致，
 * 否则同一个文件会被下载两次（一次 SW 预缓存、一次页面请求），且缓存 key 对不上。
 */
const APPV = 'v583';
const LIBV = 'lib2';

const PRECACHE = [
  './',                                  // 导航入口不带参数（用户地址栏访问的就是它）
  './index.html',
  './manifest.webmanifest',
  './css/styles.css?' + APPV,
  // vendor 按实际文件版本硬编码，避免 LIBV 统一替换导致未改动的库被重复下载
  './vendor/supabase.js?lib1',
  './vendor/chart.js?lib1',
  './vendor/xlsx.js?lib2',
  './js/config.js?' + APPV,
  './js/db.js?' + APPV,
  './js/calc.js?' + APPV,
  './js/charts.js?' + APPV,
  './js/export.js?' + APPV,
  './js/app.js?' + APPV,
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  // 注意：这里不要调用 self.skipWaiting()。
  // 必须由页面在用户点击「立即更新」时通过 postMessage({type:'SKIP_WAITING'}) 来唤醒，
  // 否则新版 SW 会自行跳过 waiting 直接激活并 clients.claim() 接管页面，
  // 导致「发现新版本」提示来不及出现 —— 表现成静默直接更新。
  // 预缓存必须绕过浏览器 HTTP 缓存：GitHub Pages 对静态资源下发 Cache-Control: max-age=600，
  // 直接 c.addAll(PRECACHE) 会命中 10 分钟内的磁盘缓存，把「旧文件」写进新版本 CACHE，
  // 导致离线时拿到的是上一版代码。用 Request(url, {cache:'reload'}) 强制回源。
  // vendor 例外：它带独立的 LIBV，URL 不变即内容不变，用 'default' 允许命中浏览器
  // 磁盘缓存，避免每次发版白白重下 1.3MB 的第三方库。
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(
      PRECACHE.map((u) =>
        fetch(new Request(u, { cache: u.indexOf('/vendor/') >= 0 ? 'default' : 'reload' }))
          .then((res) => (res && res.ok ? c.put(u, res) : null))
          .catch(() => null)   // 单个资源失败不阻断整体安装（原 addAll 是全或无）
      )
    ))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  // 页面主动查询本 SW 的运行版本（用于「设置→关于」显示真实运行版本，避免显示磁盘最新版导致的困惑）
  if (event.data && event.data.type === 'GET_SW_VERSION' && event.source && event.source.postMessage) {
    event.source.postMessage({ type: 'SW_VERSION', v: CACHE });
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(async () => {
        // 激活后向所有受控页面上报本 SW 运行版本（About 据此显示真实运行版本）
        try {
          const cls = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
          cls.forEach((c) => c.postMessage({ type: 'SW_VERSION', v: CACHE }));
        } catch (e) {}
      })
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

  // 页面导航：network-first + 2.5s 超时竞速。
  // 原逻辑纯 network-first：网络挂起时 fetch 要等到浏览器放弃（可达几十秒）才回退缓存，
  // 表现为 PWA 启动卡在首屏。现在 2.5s 内网络没回来就先用缓存外壳启动（毫秒级进首屏），
  // 网络响应继续在后台跑完并写入缓存，供下次启动使用。
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./index.html'));
      const net = fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => null);
      const res = await Promise.race([net, new Promise((r) => setTimeout(r, 2500, null))]);
      if (res) return res;                       // 网络正常（2.5s 内返回最新页面）
      // 超时：后台网络请求继续跑完（waitUntil 防止被提前终止），本次先用缓存外壳
      event.waitUntil(net.catch(() => {}));
      return cached || Response.error();
    })());
    return;
  }

  // vendor 第三方库：cache-first。这些文件带独立的 LIBV 版本参数，
  // URL 一旦命中缓存就说明内容没变，直接返回本地副本 —— 首屏不必再等 3 个共 1.3MB 的
  // 网络请求。升级库时把 LIBV +1，URL 变化自然 miss 缓存并回源，不会拿到旧库。
  if (url.origin === self.location.origin && url.pathname.indexOf('/vendor/') >= 0) {
    event.respondWith(
      caches.match(req).then((m) => m || fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true })
          .then((f) => f || Response.error())))
    );
    return;
  }

  // 同源静态：SWR（cache-first + 后台刷新）。缓存命中立即返回（首屏秒开，不再等网络），
  // 同时后台回源拉最新写入缓存，下次启动生效。
  // 版本更新仍由 index.html 驱动：发版 bump APPV 后页面请求新 ?vNNN → 缓存必 miss →
  // 走 network 路径直接拿新文件，更新机制不受影响。原 network-first 的「漏 bump 安全网」
  // 代价是每次启动 7 个文件都等网络（网络差就卡首屏），权衡后改为 SWR：
  // 唯一代价是「URL 没变但内容变了」时新代码晚一次启动生效（后台已刷新完毕）。
  // 离线且无缓存时如实报错，绝不回退 index.html（把 HTML 当 JS/CSS 返回会直接让页面崩掉）。
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((m) => {
        const net = fetch(req)
          .then((res) => { cachePut(req, res.clone()); return res; })
          .catch(() => m || Response.error());
        return m || net;                          // 有缓存立即返回，network 后台静默刷新
      })
    );
    return;
  }

  // 跨域 Supabase 数据 API（*.supabase.co 的 /rest/v1、/auth/v1、/functions/v1）：
  // ⚠️ 必须始终取服务端最新结果，绝对不能走 stale-while-revalidate！
  // 旧逻辑把这类请求也归入「跨域 CDN」走了 SWR，导致三个典型症状：
  //   ① 进软件后读到的可能是上一次会话缓存的「旧 API 响应」（列表先显示旧数据）；
  //   ② 点「刷新」按钮显示「已刷新」却仍是老数据——因为后台 reload 也被 SW 返回了缓存旧值；
  //   ③ 要等冷连接（长后台首包 8~30s）建好、后台 fetch 偶然把缓存刷成新的，列表才悄悄变新。
  // 改为 network-first：联网即返回服务端最新数据并刷新缓存；仅当网络真的失败（纯云端模式极少）
  // 才回退到缓存兜底，避免瞬时抖动让读请求直接报错。绝不在「成功」路径上返回旧数据。
  if (url.hostname.endsWith('.supabase.co')) {
    event.respondWith(
      fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => caches.match(req).then((m) => m || Response.error()))
    );
    return;
  }

  // 跨域静态 CDN（cdn.jsdelivr.net / unpkg.com / esm.sh 等加载 supabase.js 等库文件）：
  // 这些才是 stale-while-revalidate 的适用场景——库文件不常变，旧版本也能跑，优先用缓存提速。
  event.respondWith(
    caches.match(req).then((m) => {
      const network = fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => m);
      return m || network;
    })
  );
});
