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

  function emit() {
    lastSync = new Date();
    listeners.forEach(fn => { try { fn(lastSync); } catch (e) { console.error(e); } });
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function getLastSync() { return lastSync; }
  function getMode() { return 'supabase'; }

  /* ---------------- Supabase 库动态加载 ---------------- */
  async function ensureSupabaseLib() {
    if (window.supabase && window.supabase.createClient) return true;
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
    sb = window.supabase.createClient(url, key, { realtime: { params: { eventsPerSecond: 20 } } });
    settings.supabaseUrl = url; settings.supabaseAnonKey = key;
    try { await loadAll(); }
    catch (e) { console.warn('初始数据加载失败，将依赖实时同步补全', e); }
    setupRealtime();
    await probeSupabaseSchema();
  }

  async function loadAll() {
    const [designers, groups, customers, orders, st] = await Promise.all([
      sb.from('designers').select('*'),
      sb.from('groups').select('*'),
      sb.from('customers').select('*'),
      sb.from('orders').select('*'),
      sb.from('settings').select('*').eq('id', 1).maybeSingle()
    ]);
    cache.designers = mergeServer('designers', designers.data);
    cache.groups = mergeServer('groups', groups.data);
    cache.customers = mergeServer('customers', customers.data);
    cache.orders = mergeServer('orders', orders.data);
    if (st && st.data) settings = Object.assign({}, settings, st.data);
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
  async function probeSupabaseSchema() {
    const checks = [
      ['orders', ['collab_designer_ids', 'rework_category', 'revision_note', 'complaint_count', 'proposal_count', 'complaint_log']],
      ['designers', ['auth_id', 'email', 'active']],
      ['settings', ['permissions']],
      ['customers', ['company', 'address', 'notes', 'tag']]
    ];
    const missing = [];
    for (const [tbl, cols] of checks) {
      try {
        const { error } = await sb.from(tbl).select(cols.join(',')).limit(1);
        if (error) {
          const msg = error.message || '';
          missing.push(tbl + '(' + cols.filter(c => msg.includes(c)).join('/') + ')');
        }
      } catch (e) {
        missing.push(tbl + '(探测失败)');
      }
    }
    if (missing.length) {
      settings._schemaError =
        '云端数据表缺字段，无法写入新字段订单/客户/设计师。请在 Supabase 后台 SQL Editor 中执行本项目 sql/schema.sql 与 sql/enable_rls.sql（已含 add column if not exists，可重复执行）。' +
        '缺字段：' + missing.join('、') + '。';
    } else {
      delete settings._schemaError;
    }
  }

  function setupRealtime() {
    const ch = sb.channel('ds-changes');
    TABLES.forEach(t => {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t },
        async () => { await loadAll(); emit(); });
    });
    ch.subscribe();
    unsubRealtime = () => { try { sb.removeChannel(ch); } catch (e) {} };
  }

  /* ---------------- 设置 ---------------- */
  async function getSettings() { return Object.assign({}, settings); }
  async function saveSettings(obj) {
    settings = Object.assign({}, settings, obj);
    const { error } = await sb.from('settings').upsert(
      Object.assign({ id: 1 }, pickSettings(settings)), { onConflict: 'id' });
    if (error) throw error;
    emit();
  }
  function pickSettings(s) {
    return {
      small_order_max: s.small_order_max, large_order_min: s.large_order_min,
      base_perf_salary: s.base_perf_salary,
      team_award_t1: s.team_award_t1, team_award_a1: s.team_award_a1,
      team_award_t2: s.team_award_t2, team_award_a2: s.team_award_a2,
      small_order_target: s.small_order_target,
      permissions: s.permissions || null
    };
  }

  /* ---------------- 通用 CRUD ---------------- */
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
    }
    if (error) {
      const msg = error.message || '';
      if (msg.includes('schema cache')) {
        throw new Error('云端 schema 缓存未刷新，无法保存。请在 Supabase 后台点击"Refresh schema"或等待 1~2 分钟后刷新页面。');
      }
      throw error;
    }
    upsertCache(table, row);
    recentSaves.set(row.id, Date.now());
    scheduleReconcile(table);
    emit();
    return row;
  }

  async function remove(table, id) {
    const { error } = await sb.from(table).delete().eq('id', id);
    if (error) throw error;
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
      const res = await sb.from(table).select('*');
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
  async function deleteGroup(id) { return remove('groups', id); }

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
  async function deleteCustomer(id) { return remove('customers', id); }

  async function listOrders(filter) {
    let arr = cache.orders.slice();
    if (filter) {
      const kw = (filter.keyword || '').trim().toLowerCase();
      arr = arr.filter(o => {
        if (filter.status && o.status !== filter.status) return false;
        if (filter.designerId && o.assigned_designer_id !== filter.designerId) return false;
        if (filter.customerId && o.customer_id !== filter.customerId) return false;
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
    return save('orders', o);
  }
  async function deleteOrder(id) { return remove('orders', id); }

  async function reconnectSupabase() {
    await probeSupabaseSchema();
    const err = settings._schemaError;
    if (err) toast(err); else toast('云端 schema 探测正常 ✅');
  }

  // 生成订单号 JY-DS-YYYYMM-序号
  async function genOrderNo() {
    const d = new Date();
    const ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
    const prefix = 'JY-DS-' + ym + '-';
    let max = 0;
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
    const { data } = await sb.auth.getSession();
    return data.session;
  }
  function authOnChange(cb) {
    const { data } = sb.auth.onAuthStateChange((_event, session) => cb(session));
    return data; // subscription，可 .unsubscribe()
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
    createUser: authCreateUser,
    deleteUser: authDeleteUser,
    setPassword: authSetPassword
  };

  return {
    init, subscribe, getLastSync, getMode,
    getSettings, saveSettings,
    listDesigners, saveDesigner, deleteDesigner,
    listGroups, saveGroup, deleteGroup,
    listCustomers, saveCustomer, deleteCustomer, cascadeCustomerName,
    listOrders, saveOrder, deleteOrder, genOrderNo, reconnectSupabase,
    auth
  };
})();
