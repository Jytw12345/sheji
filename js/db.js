/* ============================================================
 * db.js  —  统一数据层（纯 Supabase 云端模式）
 *  认证：Supabase Auth（邮箱 + 密码）
 *  数据：Supabase + Realtime 实时同步
 *  对外暴露统一异步接口 DB.*，业务代码无需关心底层。
 *  说明：已移除本地降级模式（纯云端，断网不可用）；service_role 仅存在于
 *        Edge Function 服务端，前端永不持有。
 * ============================================================ */
window.DB = (function () {
  const TABLES = ['designers', 'groups', 'customers', 'orders', 'settings'];

  let sb = null;               // supabase client（始终连接云端）
  let settings = Object.assign({}, window.Cfg.DEFAULT_SETTINGS);
  const cache = { designers: [], groups: [], customers: [], orders: [] };
  const listeners = new Set();
  // 乐观更新防护：避免云端复制延迟把本端刚做的删除/修改被旧数据覆盖
  const pendingDeleteIds = new Set();
  const recentSaves = new Map();
  const reconcileTimers = {};
  let lastSync = new Date();
  let unsubRealtime = null;

  /* ---------------- 工具 ---------------- */
  function uid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  function nowISO() { return new Date().toISOString(); }
  function lsGet(k, def) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  // 持久化 settings（含 permissions 权限配置）到 localStorage：
  // 解决「登录瞬间会话未对 RLS 生效 → settings 查询返回空 → 权限回退 config.js 写死的默认值，
  // 必须手动 F5 才能拿到云端真实权限（含管理员对个人/职务的覆盖）」的问题。
  // 启动时 init() 会把 ds_settings 合并进内存 settings，因此即便云端首查失败，
  // 登录瞬间也能用「上一次成功加载的权限」立即生效，后台再与云端对账。
  function persistSettings() {
    try {
      const s = Object.assign({}, settings);
      delete s._schemaError; delete s._cloudError;   // 不缓存瞬时错误标记
      localStorage.setItem('ds_settings', JSON.stringify(s));
    } catch (e) {}
  }

  function emit() {
    lastSync = new Date();
    listeners.forEach(fn => { try { fn(lastSync); } catch (e) { console.error(e); } });
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function getLastSync() { return lastSync; }
  // 主动标记一次成功同步（手动刷新 / 重新连上云端时调用），用于更新同步时间显示
  function markSynced() { lastSync = new Date(); }
  function getMode() { return 'supabase'; }

  /* ---------------- Supabase 库动态加载 ---------------- */
  async function ensureSupabaseLib() {
    if (window.supabase && window.supabase.createClient) return true;
    // 优先加载本地 vendor（首屏已通过 <script defer> 预载，此处仅作兜底/离线保障，避免外网 CDN 延迟）
    try {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'vendor/supabase.js?lib1'; s.async = true;
        s.onload = () => res(); s.onerror = () => rej(new Error('load fail vendor/supabase.js'));
        document.head.appendChild(s);
      });
      if (window.supabase && window.supabase.createClient) return true;
    } catch (e) { console.warn('本地 Supabase UMD 加载失败，转 CDN 兜底:', e); }
    const umd = [
      'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
      'https://unpkg.com/@supabase/supabase-js@2'
    ];
    for (const src of umd) {
      try {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = src; s.async = true;
          s.onload = () => res(); s.onerror = () => rej(new Error('load fail ' + src));
          document.head.appendChild(s);
        });
        if (window.supabase && window.supabase.createClient) return true;
      } catch (e) { console.warn('Supabase UMD CDN 加载失败:', src); }
    }
    try {
      const mod = await import('https://esm.sh/@supabase/supabase-js@2');
      window.supabase = mod.default || mod;
      if (window.supabase && window.supabase.createClient) return true;
    } catch (e) { console.warn('Supabase ESM 加载失败:', e); }
    return false;
  }

  // 带超时兜底的网络请求封装：任何 Supabase SDK 调用（数据 / 鉴权令牌刷新）都不会无限挂起。
  // 合并外部已有的 AbortSignal（若 SDK 自行取消），超时后 abort，使其 reject 而非永远 pending。
  function makeTimeoutFetch(timeoutMs) {
    return (input, init) => {
      init = init || {};
      const ctrl = new AbortController();
      const outer = init.signal;
      if (outer) {
        if (outer.aborted) ctrl.abort();
        else outer.addEventListener('abort', () => ctrl.abort(), { once: true });
      }
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      return fetch(input, Object.assign({}, init, { signal: ctrl.signal }))
        .finally(() => clearTimeout(t));
    };
  }

  // Promise 超时：超时后若传入了 fallback 则 resolve(fallback)，否则 reject。
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (Object.prototype.hasOwnProperty.call(arguments, 2)) resolve(fallback);
        else reject(new Error('timeout after ' + ms + 'ms'));
      }, ms);
      Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
    if (unsubRealtime) { try { unsubRealtime(); } catch (e) {} unsubRealtime = null; }
    const saved = lsGet('ds_settings', null);
    if (saved && typeof saved === 'object') {
      settings = Object.assign({}, window.Cfg.DEFAULT_SETTINGS, saved);
    }
    delete settings._cloudError;
    const presetUrl = (window.Cfg && window.Cfg.SUPABASE_URL || '').trim();
    const presetKey = (window.Cfg && window.Cfg.SUPABASE_ANON_KEY || '').trim();
    const url = window.Cfg.normUrl(presetUrl || settings.supabaseUrl);
    const key = (presetKey || settings.supabaseAnonKey || '').trim();
    if (!url || !key) throw new Error('缺少 Supabase 配置：请在 config.js 填写 SUPABASE_URL / SUPABASE_ANON_KEY');
    const ok = await ensureSupabaseLib();
    if (!ok || !window.supabase || !window.supabase.createClient) throw new Error('Supabase 库加载失败，请检查网络');
    // 重要：createClient 不注入自定义 fetch（不主动 abort 底层请求）。
    // 原因（v426→v427 纠错）：长后台冷启动令牌过期时，Supabase 会静默刷新 refresh_token；
    // 若在 45s 把刷新请求 abort 掉，会让 refresh_token 轮换失效，导致后续所有数据查询 401、
    // 数据永远加载不出（现象：启动 60s 仍无数据，杀进程重开才好——重开等于重新完整登录）。
    // 「不无限卡」改由 app.js 的应用层 withTimeout（仅 reject promise、不 abort 底层请求）兜底：
    // 刷新请求可在后台继续完成，用户点重试即恢复，不会破坏令牌轮换。
    sb = window.supabase.createClient(url, key, { realtime: { params: { eventsPerSecond: 20 } } });
    settings.supabaseUrl = url; settings.supabaseAnonKey = key;
    try { await loadDesignersOnly(); }
    catch (e) { console.warn('初始设计师数据加载失败，将依赖实时同步补全', e); }
    setupRealtime();
    // 注意：schema 探测不再放在 init 里。
    // 原因：init 阶段 Supabase 会话尚未恢复，前端以匿名身份调用会查不到 information_schema
    //       （PostgREST 对系统视图的暴露/权限限制），导致"云端数据表缺字段"误报。
    //       改为登录成功后由 app.js 的 afterLogin() 以「已认证身份」调用 DB.probeSupabaseSchema()。
  }

  // 匿名登录前只拉 designers（登录页快捷登录用）；大表(orders/customers/groups/settings)受 RLS 限制
  // 匿名读不到，留待登录后 afterAuthLogin/bootAuth 调 reload() 时再全量拉取，避免白拉大表拖累启动
  async function loadDesignersOnly() {
    const { data } = await sb.from('designers').select('*');
    cache.designers = mergeServer('designers', data);
  }

  // 各表独立加载，避免单表查询失败（如 orders 偶发超时 / RLS 抖动）连累 settings 等核心配置读不出。
  // 之前用 Promise.all 一并拉取，任意一张表失败就会整体抛错，导致 F5 后 settings 回退到默认值
  // （表现为「权限保存了但刷新又还原」「考核参数有时刷不出来」）。
  async function loadAll() {
    async function safe(table, fn) {
      try { return await fn(); }
      catch (e) { console.warn('[' + table + '] 加载失败，已隔离：', e && e.message); return null; }
    }
    // 并行拉取 5 张表：跨区（东京）RTT 明显，顺序 await 会累积成 0.7~1.5s 的首屏延迟。
    // 各表仍用 safe() 单独兜底，单表失败只返回 null 不影响其余表。
    const [designers, groups, customers, orders, st] = await Promise.all([
      safe('designers', () => sb.from('designers').select('*')),
      safe('groups', () => sb.from('groups').select('*').is('deleted_at', null)),
      // 软删除：拉取时过滤掉已移入回收站（deleted_at 非空）的记录，已删数据不出现在主列表
      safe('customers', () => sb.from('customers').select('*').is('deleted_at', null)),
      safe('orders', () => sb.from('orders').select('*').is('deleted_at', null)),
      safe('settings', () => sb.from('settings').select('*').eq('id', 1).maybeSingle())
    ]);
    cache.designers = mergeServer('designers', designers && designers.data);
    cache.groups = mergeServer('groups', groups && groups.data);
    cache.customers = mergeServer('customers', customers && customers.data);
    cache.orders = mergeServer('orders', orders && orders.data);
    if (st && st.data) { settings = Object.assign({}, settings, st.data); persistSettings(); }
    markSynced();   // 【v441】一次完整拉取即一次同步：更新同步时钟（realtime 路径还会再 emit 一次，无害）
  }

  // 与服务端数据对账：剔除本端已删除项、优先保留本端 3s 内刚保存的项
  function mergeServer(table, serverData) {
    const now = Date.now();
    let data = (serverData || []).filter(r => !pendingDeleteIds.has(r.id));
    const arr = data.map(r => {
      if (recentSaves.has(r.id) && now - recentSaves.get(r.id) < 3000) {
        const local = cache[table].find(x => x.id === r.id);
        if (local) return local;
      }
      return r;
    });
    cache[table].forEach(local => {
      if (!arr.find(r => r.id === local.id) && recentSaves.has(local.id) && now - recentSaves.get(local.id) < 3000) arr.push(local);
    });
    return arr;
  }

  // 探测云端 schema 是否已包含本程序新增字段；若迁移未执行则给出明确提示
  // 注意：并行探测 + 不阻塞启动（init 里不 await，后台运行），缺字段时通过 settings._schemaError 提示
  // 实现：调用服务端 RPC 函数 public.probe_schema_missing()
  //   —— 原先前端直查 information_schema.columns 受 PostgREST REST 限制（不暴露 information_schema）
  //      返回空/不全，导致"云端缺字段"误报。改由服务端函数直查，结果可靠。
  async function probeSupabaseSchema() {
    try {
      const { data, error } = await sb.rpc('probe_schema_missing');
      if (error) {
        console.warn('[schema probe] rpc 调用失败，跳过探测（不影响正常使用）', error);
        return; // 无法确认 → 不报错
      }
      const missing = Array.isArray(data) ? data : [];
      if (missing.length) {
        settings._schemaError =
          '云端数据表缺字段，部分保存可能失败。请在 Supabase 后台 SQL Editor 中执行 sql/schema.sql 与 sql/enable_rls.sql（已含 add column if not exists，可重复执行）。' +
          '执行后点顶部「重新连接云端」或刷新云端缓存。缺字段：' + missing.join('、') + '。';
      } else {
        delete settings._schemaError;
      }
    } catch (e) {
      console.warn('[schema probe] 探测失败，跳过（不影响正常使用）', e);
    }
  }

  function setupRealtime() {
    const ch = sb.channel('ds-changes');
    // 节流：同一时刻多张表变动合并为一次 loadAll（800ms 内只拉一次），避免抖动与浪费配额
    let pending = false, timer = null;
    TABLES.forEach(t => {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t },
        () => {
          if (pending) return;
          pending = true;
          clearTimeout(timer);
          timer = setTimeout(async () => { pending = false; try { await loadAll(); } catch (e) {} emit(); }, 800);
        });
    });
    let retries = 0;
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') { retries = 0; return; }
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[Realtime] 频道异常(' + status + ')，尝试重建', err);
        if (retries < 5) {
          retries++;
          setTimeout(() => {
            try { sb.removeChannel(ch); } catch (e) {}
            setupRealtime();
          }, retries * 2000); // 递增退避
        }
      }
    });
    unsubRealtime = () => { try { sb.removeChannel(ch); } catch (e) {} };
  }

  /* ---------------- 设置 ---------------- */
  // 设置字段白名单：saveSettings 只写传入的字段（部分更新），
  // 避免"保存权限"时把内存中未加载的考核参数等字段以 undefined/null 覆盖库中正确值。
  const SETTINGS_COLS = [
    'small_order_max','large_order_min','base_perf_salary',
    'team_award_t1','team_award_a1','team_award_t2','team_award_a2',
    'small_order_target','win_start_day','win_end_day','risk_buffer_days',
    'auto_dispatch','auto_dispatch_minutes','permissions'
  ];
  async function getSettings() { return Object.assign({}, settings); }
  async function saveSettings(obj) {
    settings = Object.assign({}, settings, obj);
    persistSettings();   // 立即落盘，保证下次登录/刷新可即时用上最新权限配置
    const payload = { id: 1 };
    for (const k of SETTINGS_COLS) {
      if (k in obj) payload[k] = obj[k];   // 只写调用方显式传入的字段
    }
    const { error } = await sb.from('settings').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
    emit();
  }
  // 单独补拉 settings：登录瞬间会话刚建立，PostgREST 偶发尚未识别身份，
  // 导致 loadAll 里的 settings 查询返回 {data:null, error}（非抛错，safe 捕获不到），
  // settings 停留内置默认值，表现为「登录后权限是默认的，刷新才正确」。
  // 这里单独重试一次，确保权限配置以云端为准。
  async function reloadSettings() {
    try {
      const { data, error } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
      if (error) { console.warn('[settings] 补拉失败：', error.message); return settings; }
      if (data) { settings = Object.assign({}, settings, data); persistSettings(); }
      return settings;
    } catch (e) { console.warn('[settings] 补拉异常：', e && e.message); return settings; }
  }
  // 登录后稳健加载云端真实权限：根除「登录即默认、刷新才真实」的时序竞态（根因修复版）。
  // 根因：signInWithPassword 刚成功时，新建会话的 JWT 偶发尚未被 PostgREST 识别
  // （RLS 的 to authenticated 把它当匿名 → settings 查询返回空），要等会话在 GoTrue/PostgREST
  // 侧完全生效（通常数百毫秒 ~ 数秒）查询才成功；而 F5 时会话早已稳定，所以一次就成功。
  // 本函数：先轮询确认已认证会话就绪（最多 ~1.5s），再多次重试拉取 settings，
  // 一旦拿到含 permissions 的真实配置立即返回，绝不回退到内置默认。
  // 即使 localStorage 无缓存（首次登录），也能在登录流程内直接拿到真实权限渲染，无需手动刷新。
  async function loadSettingsRobust() {
    // 1) 确认已认证会话就绪：signIn 后客户端会话已设，但服务端 JWT 可能尚未对 PostgREST 生效，
    //    轮询 getSession 直到拿到 user（最多约 1.5s），确保首个查询携带有效身份。
    for (let i = 0; i < 6; i++) {
      try {
        const { data } = await sb.auth.getSession();
        if (data && data.session && data.session.user) break;
      } catch (e) {}
      if (i < 5) await new Promise(r => setTimeout(r, 250));
    }
    // 2) 重试拉取 settings，拿到含 permissions 的真实配置即返回（上限约 1.6s）。
    for (let i = 0; i < 4; i++) {
      try {
        const { data, error } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
        if (!error && data) {
          settings = Object.assign({}, settings, data);
          persistSettings();
          if (data.permissions) return settings;   // 拿到真实权限，立即返回
        } else if (error) {
          console.warn('[settings] 拉取失败(' + (i + 1) + ')：', error.message);
        }
      } catch (e) { console.warn('[settings] 拉取异常(' + (i + 1) + ')', e); }
      if (i < 3) await new Promise(r => setTimeout(r, 400));
    }
    return settings;
  }
  // 登录后稳健加载设计师档案：根除「首次登录匹配不到档案 → 误弹绑定页 / 获取不到职位」的时序竞态。
  // 与 loadSettingsRobust 同源：signInWithPassword 刚成功时新建会话的 JWT 偶发尚未被 PostgREST 识别，
  // designers 表的 RLS 查询返回空 → afterAuthLogin 用 auth_id 找不到本人档案（me 为 undefined）→
  // 弹出「补全设计师档案」页（要求重新选职位）。刷新时会话已稳定，查询成功才正常进入。
  // 本函数：先确认已认证会话就绪，再多次重试拉取 designers，拿到非空结果即返回；确为空才留给上层判「无档案」。
  async function loadDesignersRobust() {
    // 1) 确认已认证会话就绪（最多约 1.5s）
    for (let i = 0; i < 6; i++) {
      try {
        const { data } = await sb.auth.getSession();
        if (data && data.session && data.session.user) break;
      } catch (e) {}
      if (i < 5) await new Promise(r => setTimeout(r, 250));
    }
    // 2) 重试拉取 designers，拿到非空即返回（上限约 1.6s）
    for (let i = 0; i < 4; i++) {
      try {
        const { data, error } = await sb.from('designers').select('*');
        if (!error && data) {
          cache.designers = mergeServer('designers', data);
          if (cache.designers.length) return cache.designers;   // 拿到档案，立即返回
        } else if (error) {
          console.warn('[designers] 拉取失败(' + (i + 1) + ')：', error.message);
        }
      } catch (e) { console.warn('[designers] 拉取异常(' + (i + 1) + ')', e); }
      if (i < 3) await new Promise(r => setTimeout(r, 400));
    }
    return cache.designers;
  }

  /* ---------------- 通用 CRUD ---------------- */
  // 离线优先预热：把 app.js 的离线缓存（localStorage 业务缓存）同步注入内部 cache，
  // 使 dashboardSummary / monthlyReport 等在 init()→DB.reload 跑完之前就能拿到真实数据，
  // 避免「缓存已就绪但仪表盘先渲染全零、~1秒后 DB.reload 才补真数据」的空白期。
  // 仅在对应表当前为空时注入（init/DB.reload 后续会用云端权威数据覆盖，无害）。
  async function primeCache(obj) {
    if (!obj) return;
    ['designers', 'groups', 'customers', 'orders'].forEach(t => {
      const arr = obj[t];
      if (Array.isArray(arr) && arr.length && (!cache[t] || cache[t].length === 0)) {
        cache[t] = arr.slice();
      }
    });
    if (obj.settings && typeof obj.settings === 'object') {
      settings = Object.assign({}, settings, obj.settings);
    }
  }
  async function list(table) { return cache[table].slice(); }

  async function save(table, row) {
    // 记录已存在 → 部分更新（只写传入字段，避免 upsert 整行覆盖导致 NOT NULL 列 400 错误）
    const exists = cache[table] && cache[table].some(r => r.id === row.id);
    let error;
    if (exists) {
      const { id, ...patch } = row;
      const res = await sb.from(table).update(patch).eq('id', id);
      error = res.error;
    } else {
      const res = await sb.from(table).upsert(row, { onConflict: 'id' });
      error = res.error;
      // 订单号唯一约束冲突（并发新建场景）：重算单号后重试一次，避免产生重复单号
      if (error && table === 'orders' && /duplicate|23505|order_no/.test(error.message || '') && row.order_no) {
        try { row.order_no = await genOrderNo(); } catch (e) {}
        const r2 = await sb.from(table).upsert(row, { onConflict: 'id' });
        error = r2.error;
      }
    }
    if (error) {
      const msg = error.message || '';
      // 两类同源问题：① 列从未建过（缺字段）② 建了但 PostgREST 缓存未刷新。
      // 都靠「重跑 schema.sql + Refresh schema cache」解决，给出明确指引而非笼统的"缓存未刷新"。
      if (msg.includes('schema cache') || /could not find the .* column|column .* does not exist/i.test(msg)) {
        const m = msg.match(/['"]([^'"]+)['"]\s+column/i) || msg.match(/column\s+([^\s]+)\s+of/i);
        const col = m ? m[1] : '';
        throw new Error((col ? '云端缺少字段「' + col + '」' : '云端缺少字段') +
          '或 PostgREST 缓存未刷新，无法保存。请在 Supabase 后台 SQL Editor 重新执行 sql/schema.sql' +
          '（均为 add column if not exists，可重复执行、安全），然后点击「Refresh schema cache」并刷新本页面。');
      }
      fireAuthError(error);
      throw error;
    }
    upsertCache(table, row);
    recentSaves.set(row.id, Date.now());
    scheduleReconcile(table);
    emit();
    return row;
  }

  async function remove(table, id, reason) {
    // orders / customers 走软删除（移入回收站，可由管理员/店长还原）；其余表保持物理删除。
    // 软删除经由 DB 层 RPC（soft_delete_record）校验角色，避免退回「任何登录用户可改」的漏洞。
    if (table === 'orders' || table === 'customers' || table === 'groups') {
      const { error } = await sb.rpc('soft_delete_record', { p_table: table, p_id: id, p_reason: reason || null });
      if (error) { fireAuthError(error); throw error; }
      cache[table] = cache[table].filter(x => x.id !== id);
      // 注意：软删除不写 pendingDeleteIds。pendingDeleteIds 是永久集合（永不清理），
      // 仅用于已物理删除(purge)的 id；软删靠 deleted_at 在服务端/拉取时过滤，
      // 若写入则还原后该 id 会被永久过滤，反而造成“还原后订单消失”。
      scheduleReconcile(table);
      emit();
      return;
    }
    const { error } = await sb.from(table).delete().eq('id', id);
    if (error) { fireAuthError(error); throw error; }
    pendingDeleteIds.add(id);
    cache[table] = cache[table].filter(r => r.id !== id);
    scheduleReconcile(table);
    emit();
  }

  function upsertCache(table, row) {
    const arr = cache[table];
    const i = arr.findIndex(r => r.id === row.id);
    if (i >= 0) arr[i] = Object.assign({}, arr[i], row); else arr.push(row);
  }

  // 延迟 1.5s 与服务端对账（非阻塞），纠正其他端/服务端的改动
  function scheduleReconcile(table) {
    clearTimeout(reconcileTimers[table]);
    reconcileTimers[table] = setTimeout(() => reconcile(table), 1500);
  }
  async function reconcile(table) {
    try {
      let q = sb.from(table).select('*');
      if (table === 'orders' || table === 'customers' || table === 'groups') q = q.is('deleted_at', null);
      const res = await q;
      cache[table] = mergeServer(table, res.data);
      emit();
    } catch (e) { console.warn('后台对账失败（不影响本端显示）', e); }
  }

  /* ---------------- 实体便捷方法 ---------------- */
  async function listDesigners() { return list('designers'); }
  async function saveDesigner(d) {
    // 仅新建时补默认值；已存在记录（如勾选框部分更新）不覆盖 active 等字段
    const exists = cache.designers && cache.designers.some(x => x.id === d.id);
    if (!exists) d = Object.assign({ id: uid(), created_at: nowISO(), active: true }, d);
    return save('designers', d);
  }
  async function deleteDesigner(id) { return remove('designers', id); }

  async function listGroups() { return list('groups'); }
  async function saveGroup(g) {
    g = Object.assign({ id: uid(), created_at: nowISO() }, g);
    return save('groups', g);
  }
  async function deleteGroup(id, reason) { return remove('groups', id, reason); }

  async function listCustomers() { return list('customers'); }
  async function saveCustomer(c) {
    const isEdit = !!c.id;
    c = Object.assign({ id: uid(), created_at: nowISO() }, c);
    try {
      const saved = await save('customers', c);
      if (isEdit) await cascadeCustomerName(c.id, c.name);
      return saved;
    } catch (e) {
      // 兼容旧库尚未执行 schema.sql（缺 tag 列）：去掉 tag 重试，保证客户保存不被阻断
      if (e && String(e.message || '').includes('tag') && c.tag !== undefined) {
        delete c.tag;
        const saved = await save('customers', c);
        if (isEdit) await cascadeCustomerName(c.id, c.name);
        return saved;
      }
      throw e;
    }
  }
  async function cascadeCustomerName(customerId, name) {
    if (!customerId) return;
    try {
      const { error } = await sb.from('orders').update({ customer_name: name }).eq('customer_id', customerId);
      if (error) console.warn('级联更新订单客户名失败', error);
    } catch (e) { console.warn('级联更新订单客户名失败', e); }
    cache.orders.forEach(o => { if (o.customer_id === customerId) o.customer_name = name; });
    emit();
  }
  async function deleteCustomer(id, reason) { return remove('customers', id, reason); }

  // 仅更新某客户的 contacts_json（供 app.js 在订单弹窗内快捷添加联系人时调用，
  // 避免直接访问未导出的内部 supabase client `sb`）
  async function saveCustomerContacts(cid, contacts) {
    const { error } = await sb.from('customers').update({ contacts_json: contacts }).eq('id', cid);
    if (error) throw error;
    return true;
  }

  async function listOrders(filter) {
    let arr = cache.orders.slice();
    if (filter) {
      const kw = (filter.keyword || '').trim().toLowerCase();
      arr = arr.filter(o => {
        if (filter.status && o.status !== filter.status) return false;
        if (filter.designerId && o.assigned_designer_id !== filter.designerId) return false;
        if (filter.customerId && o.customer_id !== filter.customerId) return false;
        if (filter.taskType && o.task_type !== filter.taskType) return false;
        if (filter.category) {
          const cat = window.Cfg.orderCategory(Number(o.amount) || 0, settings);
          if (cat !== filter.category) return false;
        }
        if (filter.dateFrom || filter.dateTo) {
          const t = o.intake_at ? o.intake_at.slice(0, 10) : '';
          if (filter.dateFrom && t < filter.dateFrom) return false;
          if (filter.dateTo && t > filter.dateTo) return false;
        }
        if (kw && !((o.title || '').toLowerCase().includes(kw) ||
                   (o.order_no || '').toLowerCase().includes(kw) ||
                   (o.customer_name || '').toLowerCase().includes(kw))) return false;
        return true;
      });
    }
    return arr;
  }
  async function saveOrder(o) {
    const id = (o && o.id) ? o.id : uid();
    o = Object.assign({ created_at: nowISO(), revision_count: 0, is_finalized: false,
      collab_designer_ids: [], rework_category: '', revision_note: '', complaint_count: 0, proposal_count: 0, file_paths: [], design_paths: [],
      revision_at: null, redraft_at: null, feedback_failed_at: null, feedback_pass_at: null,
      proposal_log: [], proposal_failed_log: [], draft_log: [], revision_log: [],
      redraft_log: [], feedback_failed_log: [], complaint_log: [] }, o, { id });
    // 剥离前端临时字段（如下划线开头的脏标记 _dirty），避免被当作数据库列写入
    Object.keys(o).forEach(k => { if (k.startsWith('_')) delete o[k]; });
    return save('orders', o);
  }
  async function deleteOrder(id, reason) { return remove('orders', id, reason); }

  // ---------- 回收站（软删除）相关 ----------
  // 还原：清空 deleted_at，并把该记录重新并入主列表缓存
  async function restoreDeleted(table, id) {
    const { error } = await sb.rpc('restore_record', { p_table: table, p_id: id });
    if (error) throw error;
    const { data } = await sb.from(table).select('*').eq('id', id).maybeSingle();
    if (data) upsertCache(table, data);
    scheduleReconcile(table);
    emit();
  }
  // 彻底删除：物理删除（仅管理员，由 RPC 校验）
  async function purgeDeleted(table, id) {
    const { error } = await sb.rpc('purge_record', { p_table: table, p_id: id });
    if (error) throw error;
    pendingDeleteIds.add(id);
    cache[table] = cache[table].filter(x => x.id !== id);
    scheduleReconcile(table);
    emit();
  }
  // 列出已软删除（回收站）的记录，按删除时间倒序
  async function listDeleted(table) {
    const { data, error } = await sb.from(table).select('*').not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /* ---------------- 操作日志 ---------------- */
  // 旁路写入：不阻塞主流程，写入失败只告警不抛错
  function logOperation(entry) {
    if (!sb) return;
    if (!entry || !entry.action) return;
    const row = {
      id: uid(),
      designer_id: entry.designerId || null,
      designer_name: entry.designerName || '',
      action: entry.action,
      target_type: entry.targetType || null,
      target_id: entry.targetId || null,
      target_label: entry.targetLabel || null,
      detail: entry.detail || null,
      created_at: nowISO()
    };
    sb.from('operation_logs').insert(row)
      .then(() => {})
      .catch(e => console.warn('操作日志写入失败（不影响主操作）', e));
  }
  async function queryLogs(filter) {
    if (!sb) return [];
    filter = filter || {};
    let q = sb.from('operation_logs').select('*')
      .order('created_at', { ascending: false })
      .limit(filter.limit || 300);
    if (filter.designerId) q = q.eq('designer_id', filter.designerId);
    if (filter.action) q = q.eq('action', filter.action);
    if (filter.from) q = q.gte('created_at', filter.from + 'T00:00:00');
    if (filter.to) q = q.lte('created_at', filter.to + 'T23:59:59');
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function reconnectSupabase() {
    await probeSupabaseSchema();
    const err = settings._schemaError;
    if (err) toast(err); else toast('云端 schema 探测正常 ✅');
  }

  // 生成订单号 YYMMDD-序号（年份取后两位，如 260728-001）
  // 优先查 Supabase 实时最大号（防并发冲突），离线时降级本地缓存
  async function genOrderNo() {
    const d = new Date();
    const prefix = String(d.getFullYear()).slice(-2) +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '-';
    let max = 0;

    // 1) 查询 Supabase 今天已有的最大订单号（最权威，避免多人并发拿到相同序号）
    try {
      const { data, error } = await sb.from('orders')
        .select('order_no')
        .like('order_no', prefix + '%')
        .order('order_no', { ascending: false })
        .limit(1);
      if (!error && data && data.length > 0) {
        const n = parseInt(data[0].order_no.slice(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    } catch (e) { /* 查询失败时降级 */ }

    // 2) 合并本地缓存（可能存在尚未同步到 Supabase 的离线新建订单）
    cache.orders.forEach(o => {
      if (o.order_no && o.order_no.startsWith(prefix)) {
        const n = parseInt(o.order_no.slice(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    });

    return prefix + String(max + 1).padStart(3, '0');
  }

  /* ---------------- 认证（Supabase Auth） ---------------- */
  async function authSignIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }
  async function authSignOut() {
    const { error } = await sb.auth.signOut();
    if (error) throw error;
  }
  async function authGetSession() {
    // 直接读会话（含必要时静默令牌刷新）。不在此层做 fetch 级 abort——
    // 主动 abort 刷新请求会让 Supabase 的 refresh_token 轮换失效，导致后续所有查询 401、数据永远加载不出。
    // 「不无限卡」由 app.js 的 bootAuth（withTimeout 会话，promise 级超时只 reject 不 abort 底层请求）兜底，
    // 刷新可在后台继续完成，重试即可恢复。
    const { data } = await sb.auth.getSession();
    return data.session;
  }
  function authOnChange(cb) {
    const { data } = sb.auth.onAuthStateChange((_event, session) => cb(session));
    return data; // subscription，可 .unsubscribe()
  }
  // ---------- 会话失效统一回调（token 过期时由 app.js 跳登录）----------
  let _authErrorHandler = null;
  function onAuthError(cb) { _authErrorHandler = cb; }
  function isAuthError(err) {
    if (!err) return false;
    if (err.status === 401) return true;
    const msg = String(err.message || err.error_description || '').toLowerCase();
    if (/(jwt|expired|invalid token|unauthorized|not authenticated|auth session missing)/.test(msg)) return true;
    return false;
  }
  function fireAuthError(err) {
    if (_authErrorHandler && isAuthError(err)) { try { _authErrorHandler(err); } catch (e) {} }
  }
  // 首次登录后绑定设计师档案（auth_id = 当前登录用户）
  async function authBindProfile(row) {
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) throw new Error('未登录，无法绑定档案');
    const d = Object.assign({ id: uid(), created_at: nowISO(), active: true,
      auth_id: user.id, email: user.email || '' }, row);
    return save('designers', d);
  }
  async function authResetPassword(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    if (error) throw error;
  }
  // ---------- 登录失败限流 / 账户锁定 ----------
  // 阈值：同一邮箱 15 分钟内失败 ≥5 次 → 锁定 15 分钟（与服务端 RPC 保持一致）。
  async function loginLockMinutes(email) {
    try { const { data, error } = await sb.rpc('login_attempt_state', { p_email: email }); if (error) return 0; return data || 0; }
    catch (e) { return 0; }   // 网络异常时不阻断登录，仅失效限流保护
  }
  async function recordLoginFailure(email) {
    try { const { data } = await sb.rpc('record_login_failure', { p_email: email }); return data || 0; }
    catch (e) { return 0; }
  }
  async function clearLoginFailures(email) {
    try { await sb.rpc('clear_login_failures', { p_email: email }); } catch (e) {}
  }
  // 管理员查看当前被锁定的账号（同一邮箱 15 分钟内失败 ≥5 次）。仅管理员可调。
  async function listLockedAccounts() {
    try { const { data, error } = await sb.rpc('list_locked_accounts'); if (error) throw error; return data || []; }
    catch (e) { return []; }
  }
  // 管理员手动解锁账号（清空其登录失败记录，立即解除锁定）。仅管理员可调。
  async function unlockAccount(email) {
    try { const { error } = await sb.rpc('unlock_account', { p_email: email }); if (error) throw error; return true; }
    catch (e) { throw e; }
  }
  // 本人修改自己的登录密码：先校验当前密码（重新登录验证身份），再用客户端 API 更新。
  // 不依赖 service_role / Edge Function，任何已登录用户（设计师 / 店长 / 管理员）均可使用。
  async function authUpdateSelfPassword(oldPw, newPw) {
    const { data: { session } } = await sb.auth.getSession();
    const email = session && session.user && session.user.email;
    if (!email) throw new Error('未获取到登录邮箱，无法修改密码');
    if (!oldPw) throw new Error('请输入当前密码');
    // 先以当前密码重新登录，验证身份
    const { error: signErr } = await sb.auth.signInWithPassword({ email, password: oldPw });
    if (signErr) throw new Error('当前密码不正确');
    // 验证通过后更新密码（沿用当前会话的已认证身份）
    const { error } = await sb.auth.updateUser({ password: newPw });
    if (error) throw error;
    return true;
  }
  // 管理员新增人员：调 Edge Function 建 Auth 账号（service_role 在服务端）
  async function authCreateUser(payload) {
    const { data: { session } } = await sb.auth.getSession();
    const token = session && session.access_token;
    if (!token) throw new Error('未登录');
    const base = (settings.supabaseUrl || '').replace(/\/$/, '');
    const res = await fetch(base + '/functions/v1/create-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'apikey': settings.supabaseAnonKey || ''
      },
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || '创建账号失败');
    return j; // { id, email }
  }
  // 删除设计师时连带删除 Auth 账号
  async function authDeleteUser(authId) {
    const { data: { session } } = await sb.auth.getSession();
    const token = session && session.access_token;
    if (!token) throw new Error('未登录');
    const base = (settings.supabaseUrl || '').replace(/\/$/, '');
    const res = await fetch(base + '/functions/v1/delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'apikey': settings.supabaseAnonKey || ''
      },
      body: JSON.stringify({ auth_id: authId })
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || '删除账号失败');
    return j;
  }

  // 管理员修改设计师密码：调 Edge Function（service_role 更新 Auth 用户）
  async function authSetPassword(payload) {
    const { data: { session } } = await sb.auth.getSession();
    const token = session && session.access_token;
    if (!token) throw new Error('未登录');
    const base = (settings.supabaseUrl || '').replace(/\/$/, '');
    const res = await fetch(base + '/functions/v1/set-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'apikey': settings.supabaseAnonKey || ''
      },
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || '修改密码失败');
    return j;
  }

  const auth = {
    signIn: authSignIn,
    signOut: authSignOut,
    getSession: authGetSession,
    onChange: authOnChange,
    bindProfile: authBindProfile,
    resetPassword: authResetPassword,
    loginLockMinutes, recordLoginFailure, clearLoginFailures, listLockedAccounts, unlockAccount,
    updateSelfPassword: authUpdateSelfPassword,
    createUser: authCreateUser,
    deleteUser: authDeleteUser,
    setPassword: authSetPassword
  };

  return {
    init, subscribe, getLastSync, getMode, markSynced, reload: loadAll,
    getSettings, saveSettings, reloadSettings, loadSettingsRobust, loadDesignersRobust, probeSupabaseSchema,
    primeCache, listDesigners, saveDesigner, deleteDesigner,
    listGroups, saveGroup, deleteGroup,
    listCustomers, saveCustomer, saveCustomerContacts, deleteCustomer, cascadeCustomerName,
    listOrders, saveOrder, deleteOrder, restoreDeleted, purgeDeleted, listDeleted, genOrderNo, reconnectSupabase,
    logOperation, queryLogs,
    auth, onAuthError
  };
})();
