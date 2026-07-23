/* ============================================================
 * app.js  —  主逻辑：渲染、交互、流程推进、实时同步
 * ============================================================ */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  let state = {
    tab: 'dashboard',
    filters: {},
    editingOrderId: null,
    editingOrder: null,
    currentUser: null,
    _subscribed: false
  };

  /* ---------- 工具 ---------- */
  function fmtTime(t) {
    if (!t) return '—';
    const d = new Date(t); if (isNaN(d)) return '—';
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso); const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fromLocalInput(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  function pct(v) { return (Math.round(v * 1000) / 10) + '%'; }
  function money(v) { return (Math.round((v || 0) * 100) / 100).toLocaleString('zh-CN'); }
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function pill(status) {
    const c = (window.Cfg.STATUS[status] || {}).color || '#64748b';
    return '<span class="pill" style="background:' + c + '">' + esc(status) + '</span>';
  }
  function catPill(cat) { return '<span class="pill cat-' + cat + '">' + cat + '</span>'; }
  // 是否参与设计（派单/协作/工作台等）：管理员默认不参与；非管理员默认参与，除非显式关闭 active_design
  function isActiveDesign(d) { return d.role === '管理员' ? false : (d.active_design !== false); }
  // 是否参与绩效/经营分析统计：管理员默认不参与；非管理员默认参与，除非 exclude_perf === true
  function isActivePerf(d) { return d.role === '管理员' ? false : (d.exclude_perf !== true); }
  // 是否纳入团队平均/排名分母：管理员默认不参与；非管理员默认参与，除非 active_avg === false
  function isActiveAvg(d) { return d.role === '管理员' ? false : (d.active_avg !== false); }

  /* ---------- 素材文件路径：设计师可直接访问客户文件 ---------- */
  // 规范化：去首尾引号、反斜杠转正斜杠、去 file:// 与前导斜杠
  function normalizePath(p) {
    if (!p) return '';
    p = String(p).trim().replace(/^["'‘’“”]+|["'‘’“”]+$/g, '');
    // 支持 macOS 风格的 smb:// 写法，统一转成 UNC 双斜杠
    p = p.replace(/^smb:\/\//i, '//');
    // 去掉 file:// 前缀：本地 file:///C:/... 直接去掉三段斜杠；UNC file://host/share 转成 //host/share
    p = p.replace(/^file:\/\/\//i, '');
    p = p.replace(/^file:\/\/([^/])/i, '//$1');
    // 反斜杠统一为正斜杠
    p = p.replace(/\\/g, '/');
    // 修复形如 /C:/foo 的情况（file:/// 去掉后残留的首斜杠，保留盘符）
    p = p.replace(/^\/([a-zA-Z]:)/, '$1');
    // 注意：绝不能再去头部的 //，否则 UNC 网络路径（\\server\share）会被破坏
    return p;
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
        return;
      }
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  }
  // 打开路径：当前采用「浏览器默认」方式（file://，交给浏览器自行处理）
  // ★ 如需改回「弹出 Windows 资源管理器」，把下方 url 改回 'openfolder://' + encodeURI(p)，
  //   并把 toast 文案恢复为「已尝试用资源管理器打开…（请运行 tools/register-openfolder.reg 注册协议）」即可。
  function openInExplorer(raw) {
    const p = normalizePath(raw);
    if (!p) return;
    copyText(p);
    const url = 'file:///' + encodeURI(p);
    // 浏览器/PWA 对自定义协议的响应差异很大，用多种方式尝试唤起
    const openByIframe = () => {
      try {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'display:none;width:0;height:0;border:0;';
        iframe.src = url;
        document.body.appendChild(iframe);
        setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 1200);
      } catch (e) {}
    };
    const openByWindow = () => {
      try { window.open(url, '_blank'); } catch (e) {}
    };
    openByIframe();
    setTimeout(openByWindow, 60);
    toast('已尝试在浏览器中打开：\n' + p + '\n（浏览器默认方式；若被拦截，可在资源管理器地址栏粘贴该路径）');
  }
  // 渲染可点击路径列表（直接吃路径数组，素材/设计稿共用，统一走资源管理器协议）
  function filePathItemsHtml(paths, dataAttr) {
    dataAttr = dataAttr || 'data-openfolder';
    paths = Array.isArray(paths) ? paths : [];
    if (!paths.length) return '';
    const title = '点击在浏览器中打开路径';
    return '<div class="fp-list">' + paths.map(p =>
      '<div class="fp-item"><a class="fp-link" ' + dataAttr + '="' + esc(p) + '" title="' + title + '">📂 ' + esc(p) + '</a>' +
      '<button class="fp-copy" data-fpcopy="' + esc(p) + '" title="复制路径">复制</button></div>'
    ).join('') + '</div>';
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  // 标量时间 → 日志数组：标量代表"当前"时间。已在日志中则保留；不在（通常是编辑框改过时间
  // 或旧数据迁移）则「替换末条」而非追加——否则会渲染出幽灵的"第N次提案 / 第N稿"。
  function syncScalarToLog(o, logKey, scalarKey) {
    const arr = o[logKey];
    const sc = o[scalarKey];
    if (!sc) return;
    if (!arr.length) o[logKey] = [sc];
    else if (!arr.includes(sc)) { arr[arr.length - 1] = sc; arr.sort(); }
  }

  // 确保流程日志数组存在，并把旧版 scalar 时间戳迁移到数组（兼容旧数据）
  function ensureFlowLogs(o) {
    if (!o) return o;
    o.proposal_log = Array.isArray(o.proposal_log) ? o.proposal_log : [];
    o.proposal_failed_log = Array.isArray(o.proposal_failed_log) ? o.proposal_failed_log : [];
    o.draft_log = Array.isArray(o.draft_log) ? o.draft_log : [];
    o.revision_log = Array.isArray(o.revision_log) ? o.revision_log : [];
    o.redraft_log = Array.isArray(o.redraft_log) ? o.redraft_log : [];
    o.feedback_failed_log = Array.isArray(o.feedback_failed_log) ? o.feedback_failed_log : [];
    // 兼容旧数据：draft_log 里除第一条外的再投稿，应属于 redraft_log
    if (o.draft_log && o.draft_log.length > 1 && !o.redraft_log.length) {
      o.draft_log.slice(1).forEach(t => { if (!o.redraft_log.includes(t)) o.redraft_log.push(t); });
    }
    // 旧 scalar → log（去重、按时间先后）。标量代表"当前"时间，已在日志中则保留，
    // 不在则替换末条（绝不追加），避免渲染出幽灵的"第N次提案 / 第N稿"。
    syncScalarToLog(o, 'proposal_log', 'proposal_at');
    syncScalarToLog(o, 'proposal_failed_log', 'proposal_failed_at');
    syncScalarToLog(o, 'draft_log', 'draft_at');
    syncScalarToLog(o, 'redraft_log', 'redraft_at');
    syncScalarToLog(o, 'revision_log', 'revision_at');
    syncScalarToLog(o, 'feedback_failed_log', 'feedback_failed_at');
    o.proposal_log.sort();
    o.proposal_failed_log.sort();
    o.draft_log.sort();
    o.redraft_log.sort();
    o.revision_log.sort();
    o.feedback_failed_log.sort();
    return o;
  }
  // 把 scalar 字段更新为最近一次日志时间（保持兼容）
  function syncScalarFromLogs(o) {
    if (!o) return o;
    if (o.proposal_log && o.proposal_log.length) o.proposal_at = o.proposal_log[o.proposal_log.length - 1];
    if (o.draft_log && o.draft_log.length) {
      o.draft_at = o.draft_log[0];
      if (o.draft_log.length > 1 && !o.redraft_log.length) {
        // 旧数据兼容：draft_log 里只有初稿 + 再稿，拆到 redraft_log
        o.draft_log.slice(1).forEach(t => { if (!o.redraft_log.includes(t)) o.redraft_log.push(t); });
        o.redraft_log.sort();
      }
    }
    if (o.redraft_log && o.redraft_log.length) o.redraft_at = o.redraft_log[o.redraft_log.length - 1];
    else o.redraft_at = null;
    if (o.revision_log && o.revision_log.length) o.revision_at = o.revision_log[o.revision_log.length - 1];
    return o;
  }

  // 新版本可用提示（带动态效果），由 index.html 的 Service Worker 更新检测调用
  function showAppUpdate() {
    let el = $('#appUpdate');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appUpdate';
      el.className = 'app-update';
      el.innerHTML =
        '<div class="au-top"></div>' +
        '<div class="au-body">' +
          '<div class="au-ico">🚀</div>' +
          '<div class="au-text">' +
            '<div class="au-title">发现新版本</div>' +
            '<div class="au-sub">已部署更新，点击立即体验新功能与修复。</div>' +
          '</div>' +
        '</div>' +
        '<div class="au-foot">' +
          '<button class="au-btn ghost" id="auLater">稍后</button>' +
          '<button class="au-btn primary" id="auNow">立即更新</button>' +
        '</div>';
      document.body.appendChild(el);
      $('#auNow').addEventListener('click', () => {
        if (window.__swPendingUpdate) window.__swPendingUpdate();
        const reg = window.__swReg;
        if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        else window.location.reload();
      });
      $('#auLater').addEventListener('click', () => el.classList.remove('show'));
    }
    requestAnimationFrame(() => el.classList.add('show'));
  }
  window.showAppUpdate = showAppUpdate;

  /* ---------- 模态框 ---------- */
  function openModal(html) { $('#modalBox').innerHTML = html; $('#modalMask').classList.add('show'); }
  function closeModal() { $('#modalMask').classList.remove('show'); state.editingOrder = null; state.editingOrderId = null; }

  /* ============================================================
   * 权限引擎
   * ============================================================ */
  // 合并「已保存配置」与「内置默认」，保证任何职务/权限点都有确定值
  function permConfig() {
    const def = window.Cfg.defaultPermissions();
    const s = state._settings || {};
    const saved = s.permissions;
    if (!saved) return def;
    const roleDefaults = {};
    window.Cfg.ROLES.forEach(r => {
      roleDefaults[r] = Object.assign({}, def.roleDefaults[r], (saved.roleDefaults && saved.roleDefaults[r]) || {});
    });
    return { roleDefaults, overrides: saved.overrides || {} };
  }
  // 判定某权限点是否对当前用户开放：个人覆盖 > 职务默认 > 内置默认
  function can(key) {
    const u = state.currentUser;
    if (!u) return false;
    // 管理员始终拥有全部权限，避免被权限配置误锁在外面
    if (u.role === '管理员') return true;
    const cfg = permConfig();
    const ov = cfg.overrides && cfg.overrides[u.id];
    if (ov && typeof ov[key] === 'boolean') return ov[key];
    const rd = cfg.roleDefaults && cfg.roleDefaults[u.role];
    if (rd && typeof rd[key] === 'boolean') return rd[key];
    const p = window.Cfg.PERMISSIONS.find(x => x.key === key);
    if (p && p.def) return !!(p.def[u.role]);
    return false;
  }
  // 依据权限隐藏/显示带 data-perm 的元素；隐藏的标签页自动切到首个可见页
  function applyPermissions() {
    if (!state.currentUser) return;
    // 标签页
    $$('#tabs button[data-perm]').forEach(b => { b.style.display = can(b.dataset.perm) ? '' : 'none'; });
    // 其余带 data-perm 的元素（按钮 / 卡片）
    $$('[data-perm]').forEach(el => {
      if (el.closest('#tabs')) return;
      el.style.display = can(el.dataset.perm) ? '' : 'none';
    });
    // 流程推进 / 投诉记录（详情弹窗内动态生成，用 data-flow / data-complaint 标识）
    $$('[data-flow]').forEach(el => { if (!can('flow_advance')) el.style.display = 'none'; });
    $$('[data-complaint="inc"]').forEach(el => { if (!can('complaint_add')) el.style.display = 'none'; });
    // 若当前激活页被隐藏，切到首个可见页
    const active = $('#tabs button.active');
    if (active && active.style.display === 'none') {
      const first = $$('#tabs button').find(b => b.style.display !== 'none');
      if (first) switchTabQuiet(first.dataset.tab);
    }
  }
  // 取某个 tab 对应的权限 key（优先用按钮上的 data-perm，避免 tab id 与权限 key 不一致）
  function tabPermKey(tab) {
    const btn = $('#tabs button[data-tab="' + tab + '"]');
    return (btn && btn.dataset.perm) || ('menu_' + tab);
  }
  function tabLabel(tab) {
    const btn = $('#tabs button[data-tab="' + tab + '"]');
    return (btn && btn.textContent) || tab;
  }
  // 仅切换标签高亮 + 显示对应 section，不做登录判断（供 applyPermissions 内部调用）
  function switchTabQuiet(tab) {
    state.tab = tab;
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  }
  function renderTabContent(tab) {
    if (tab === 'dashboard') return renderDashboard();
    if (tab === 'orders') return renderOrders();
    if (tab === 'designers') return renderWorkbench();
    if (tab === 'customers') return renderCustomers();
    if (tab === 'analytics') return renderAnalytics();
    if (tab === 'settings') return renderSettings();
    return Promise.resolve();
  }
  function renderUserBox() {
    const u = state.currentUser;
    const box = $('#userBox');
    if (!box) return;
    if (!u) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="ub-name">' + esc(u.name) + '</span>' +
      '<span class="ub-role role-' + esc(u.role) + '">' + esc(u.role) + '</span>' +
      '<button class="ub-logout" id="btnLogout" title="退出登录">退出</button>';
    const lb = $('#btnLogout'); if (lb) lb.addEventListener('click', logout);
  }

  async function logout() {
    try { await DB.auth.signOut(); } catch (e) {}
    state.currentUser = null;
    bootAuth();
  }

  // Auth 登录成功后：根据会话匹配设计师档案；无档案则进入「绑定档案」（首个管理员）
  async function afterAuthLogin() {
    const session = await DB.auth.getSession();
    if (!session || !session.user) { renderLogin(); return; }
    const me = (state._designers || []).find(d => d.auth_id && d.auth_id === session.user.id);
    if (me) { state.currentUser = me; await afterLogin(); return; }
    renderBindProfile(session.user);
  }

  async function doLogin(email, pw) {
    try {
      await DB.auth.signIn(email, pw);
    } catch (e) {
      const el = $('#loginErr'); if (el) el.textContent = (e && e.message) ? e.message : '登录失败';
      return;
    }
    await afterAuthLogin();
  }

  async function afterLogin() {
    const ov = document.getElementById('loginOverlay'); if (ov) ov.remove();
    renderUserBox();
    applyPermissions();
    if (!state._subscribed) {
      DB.subscribe(() => { updateSync(); refreshAll(); });
      state._subscribed = true;
    }
    // 若记住的页无权限，落到仪表盘（仪表盘默认全开）
    if (!state.tab || !can(tabPermKey(state.tab))) state.tab = 'dashboard';
    await renderTabContent(state.tab);
    if (state._settings && state._settings._schemaError) {
      toast('云端表缺字段，部分保存会失败：请打开「设置」查看并执行迁移 SQL');
    }
    updateSync();
  }

  // 首次进入（无会话）：有设计师则登录；无设计师则初始化首个管理员
  async function bootAuth() {
    let session = null;
    try { session = await DB.auth.getSession(); } catch (e) {}
    if (session && session.user) {
      const me = (state._designers || []).find(d => d.auth_id && d.auth_id === session.user.id);
      if (me) { state.currentUser = me; await afterLogin(); return; }
      // 已通过 Auth 登录但尚无设计师档案（通常是首个管理员首次进入）
      renderBindProfile(session.user);
      return;
    }
    renderLogin();
  }

  // 已登录 Auth 但无设计师档案者（首个管理员）补全档案
  function renderBindProfile(user) {
    const ov = document.createElement('div');
    ov.id = 'loginOverlay'; ov.className = 'login-overlay';
    ov.innerHTML =
      '<div class="login-card">' +
        '<div class="login-brand">🎨 设计部工作台</div>' +
        '<div class="login-sub">欢迎，' + esc(user.email || '') + '。请补全设计师档案以继续</div>' +
        '<div class="login-form" style="display:block">' +
          '<div class="field"><label>姓名</label><input id="bpName" placeholder="如：王店长" autocomplete="name" /></div>' +
          '<div class="field"><label>职务</label><select id="bpRole">' +
            window.Cfg.ROLES.map(r => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('') +
          '</select></div>' +
          '<div class="login-err" id="loginErr"></div>' +
          '<button class="btn" id="bpSubmit" style="margin-top:8px;width:100%">保存并进入</button>' +
        '</div>' +
      '</div>';
    const old = document.getElementById('loginOverlay'); if (old) old.remove();
    document.body.appendChild(ov);
    $('#bpSubmit').addEventListener('click', async () => {
      const name = ($('#bpName').value || '').trim();
      if (!name) { $('#loginErr').textContent = '请填写姓名'; return; }
      try {
        const d = await DB.auth.bindProfile({ name, role: $('#bpRole').value, email: user.email || '' });
        state._designers = await DB.listDesigners();
        state.currentUser = d;
        await afterLogin();
      } catch (e) { $('#loginErr').textContent = (e && e.message) || '绑定失败'; }
    });
  }

  function renderLogin() {
    // 已绑定 Auth 账号的设计师（在职，或管理员始终显示），作为快捷选择
    const all = (state._designers || []).filter(d => d.auth_id && (d.role === '管理员' || d.active !== false));
    const ov = document.createElement('div');
    ov.id = 'loginOverlay'; ov.className = 'login-overlay';
    ov.innerHTML =
      '<div class="login-card">' +
        '<div class="login-brand">🎨 设计部工作台</div>' +
        '<div class="login-sub">请输入邮箱与密码登录</div>' +
        '<div class="login-form" style="display:block">' +
          '<div class="field"><label>邮箱</label><input id="loginEmail" type="email" placeholder="name@studio.com" autocomplete="username" /></div>' +
          '<div class="field"><label>密码</label><input id="loginPw" type="password" placeholder="请输入密码" autocomplete="current-password" /></div>' +
          '<div class="login-err" id="loginErr"></div>' +
          '<button class="btn" id="loginSubmit" style="width:100%;margin-top:8px">登录</button>' +
          '<div class="login-foot"><a href="#" id="loginForgot">忘记密码？</a></div>' +
        '</div>' +
        (all.length ? '<div class="login-quick"><div class="login-quick-label">快捷选择</div>' +
          all.map(d => '<button type="button" class="login-user' + (d.active === false ? ' is-inactive' : '') + '" data-email="' + esc(d.email) + '">' +
            '<span class="lu-name">' + esc(d.name) + '</span>' +
            (d.active === false ? '<span class="lu-tag">已停用</span>' : '') +
            '<span class="lu-role role-' + esc(d.role) + '">' + esc(d.role) + '</span></button>').join('') +
          '</div>' : '') +
      '</div>';
    const old = document.getElementById('loginOverlay'); if (old) old.remove();
    document.body.appendChild(ov);
    const submit = $('#loginSubmit');
    if (submit) submit.addEventListener('click', () => doLogin($('#loginEmail').value, $('#loginPw').value));
    const pw = $('#loginPw');
    if (pw) pw.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin($('#loginEmail').value, $('#loginPw').value); });
    const forgot = $('#loginForgot');
    if (forgot) forgot.addEventListener('click', async (e) => {
      e.preventDefault();
      const email = ($('#loginEmail').value || '').trim();
      if (!email) { const el = $('#loginErr'); if (el) el.textContent = '请先填写邮箱'; return; }
      try { await DB.auth.resetPassword(email); toast('重置链接已发送至 ' + email); }
      catch (err) { const el = $('#loginErr'); if (el) el.textContent = (err && err.message) || '发送失败'; }
    });
    $$('.login-quick .login-user').forEach(b => b.addEventListener('click', () => {
      const em = b.dataset.email;
      if (em) { $('#loginEmail').value = em; $('#loginPw').focus(); }
    }));
  }

  /* ============================================================
   * 初始化
   * ============================================================ */
  async function init() {
    await DB.init();
    bindTabs();
    bindGlobal();
    await loadData();
    await bootAuth();
  }
  async function loadData() {
    const [designers, customers, orders, settings, groups] = await Promise.all([
      DB.listDesigners(), DB.listCustomers(), DB.listOrders(), DB.getSettings(), DB.listGroups()
    ]);
    state._designers = designers; state._customers = customers; state._orders = orders;
    state._settings = settings; state._groups = groups;
    fillSelects();
  }

  function updateSync() {
    const t = DB.getLastSync();
    const p = n => String(n).padStart(2, '0');
    $('#syncStatus').textContent = '已同步 ' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
    const badge = $('#modeBadge');
    if (DB.getMode() === 'supabase') { badge.textContent = '☁ 云端同步'; badge.classList.add('cloud'); }
    else { badge.textContent = '💾 本地模式'; badge.classList.remove('cloud'); }
    updateConnStatus();
  }

  async function refreshAll() {
    const [designers, customers, orders, settings, groups] = await Promise.all([
      DB.listDesigners(), DB.listCustomers(), DB.listOrders(), DB.getSettings(), DB.listGroups()
    ]);
    state._designers = designers; state._customers = customers; state._orders = orders;
    state._settings = settings; state._groups = groups;
    fillSelects();
    if (!state.currentUser) return; // 未登录不渲染业务内容
    await renderTabContent(state.tab);
    applyPermissions();
  }

  /* ---------- 标签导航 ---------- */
  function bindTabs() {
    $$('#tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  }
  async function switchTab(tab) {
    if (!can(tabPermKey(tab))) { toast('当前账号无「' + tabLabel(tab) + '」菜单权限'); return; }
    switchTabQuiet(tab);
    await renderTabContent(tab);
    applyPermissions();
  }

  function bindGlobal() {
    $('#btnRefresh').addEventListener('click', () => { refreshAll(); toast('已刷新'); });
    $('#btnDashRefresh').addEventListener('click', () => { refreshAll(); toast('已刷新'); });
    $('#modalMask').addEventListener('click', e => { if (e.target.id === 'modalMask') closeModal(); });
    // 订单
    $('#btnNewOrder').addEventListener('click', newOrder);
    $('#btnExportOrders').addEventListener('click', exportOrdersCSV);
    // 下拉/搜索自动筛选（关键字防抖 200ms）
    let kwTimer;
    const autoFilter = () => { readFilters(); renderOrders(); };
    ['fStatus', 'fDesigner', 'fCustomer'].forEach(id => {
      $('#' + id).addEventListener('change', autoFilter);
    });
    $('#fKeyword').addEventListener('input', () => {
      clearTimeout(kwTimer);
      kwTimer = setTimeout(autoFilter, 200);
    });
    $('#btnResetFilter').addEventListener('click', () => {
      state.filters = {}; $('#fStatus').value = ''; $('#fDesigner').value = ''; $('#fCustomer').value = ''; $('#fKeyword').value = '';
      renderOrders();
    });
    // 设计师管理（在设置页）
    $('#btnAddDesigner').addEventListener('click', addDesigner);
    $('#btnAddGroup').addEventListener('click', addGroup);
    // 工作台
    $('#wDesigner').addEventListener('change', () => { state.currentDesignerId = $('#wDesigner').value; renderWorkbench(); });
    // 经营分析
    $('#anaMode').addEventListener('change', () => {
      $('#anaRangeBox').style.display = $('#anaMode').value === 'custom' ? '' : 'none';
    });
    $('#btnAnaRefresh').addEventListener('click', renderAnalytics);
    $('#btnAnaMonth').addEventListener('click', renderConcurrencyDaily);
    $('#anaMonth').addEventListener('change', renderConcurrencyDaily);
    // 客户
    $('#btnNewCustomer').addEventListener('click', newCustomer);
    // 经营分析导出
    $('#btnAnaCSV').addEventListener('click', exportAnaCSV);
    // 设置
    $('#btnSaveSupabase').addEventListener('click', saveSupabase);
    $('#btnTestSupabase').addEventListener('click', testSupabase);
    $('#btnReconnectSupabase').addEventListener('click', () => DB.reconnectSupabase());
    $('#btnSaveParams').addEventListener('click', saveParams);
    $('#btnExportAll').addEventListener('click', exportAll);
  }

  function fillSelects() {
    const ds = state._designers || [], cs = state._customers || [];
    // 订单筛选：只显示参与设计的人，但保留当前已筛选项（历史数据兼容）
    fill('#fDesigner', ds.filter(d => isActiveDesign(d) || d.id === state.filters.designerId).map(d => [d.id, d.name]), state.filters.designerId);
    fill('#fCustomer', cs.map(c => [c.id, c.name]), state.filters.customerId);
    fill('#fStatus', Object.keys(window.Cfg.STATUS).map(s => [s, s]), state.filters.status);
    // 设计师表单（设置页）
    fill('#dRole', window.Cfg.ROLES.map(r => [r, r]));
    fill('#dGroup', (state._groups || []).map(g => [g.id, g.name]));
    // 工作台当前设计师：只显示参与设计的人
    fill('#wDesigner', ds.filter(d => isActiveDesign(d)).map(d => [d.id, d.name]), state.currentDesignerId);
  }
  function fill(sel, pairs, selected) {
    const el = $(sel);
    if (!el) return; // 元素不存在（如当前 tab 未渲染该 select）时跳过，避免空引用崩溃
    const keep = el.dataset.keepFirst;
    el.innerHTML = (el.querySelector('option[value=""]') ? '<option value="">' + (el.options[0].textContent) + '</option>' : '') +
      pairs.map(p => '<option value="' + p[0] + '"' + (p[0] == selected ? ' selected' : '') + '>' + esc(p[1]) + '</option>').join('');
  }

  /* ============================================================
   * 仪表盘
   * ============================================================ */
  async function renderDashboard() {
    const sum = await window.Calc.dashboardSummary();
    const win = sum.win;
    $('#dashWindow').textContent = '考核窗口：' + fmtTime(win.start).slice(0, 10) + ' ~ ' + fmtTime(win.end).slice(0, 10);
    // KPI
    const c = sum.counts;
    const kpis = [
      ['总接单量', c.orders, '全部订单累计'],
      ['窗口营收', '¥' + money(c.totalRevenue), '全部订单累计'],
      ['窗口订单数', c.winOrders, '本月考核期内接单'],
      ['活跃设计师', c.designers, '在岗人数'],
      ['客户 / 复购', c.customers + ' / ' + c.repeat, '复购=下单≥2次'],
      ['团队奖', '¥' + money(await teamAwardNow(sum)), '按窗口营收']
    ];
    $('#kpiGrid').innerHTML = kpis.map(k =>
      '<div class="kpi"><div class="label">' + k[0] + '</div><div class="value">' + k[1] + '</div><div class="label">' + k[2] + '</div></div>'
    ).join('');

    // 图表
    const ds = sum.designerPerf;
    const names = ds.map(d => d.designerName);
    const revenue = ds.map(d => {
      const mine = sum.orders.filter(o => o.assigned_designer_id === d.designerId && window.Calc.inWindow(o, win));
      return mine.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    });
    Charts.bar($('#chartPerf'), {
      title: '设计师业绩（窗口营收）与总绩效', horizontal: true,
      labels: names,
      datasets: [
        { label: '窗口营收(元)', data: revenue.map(v => Math.round(v)), color: '#4f46e5' },
        { label: '总绩效(元)', data: ds.map(d => Math.round(d.totalPerf)), color: '#22c55e' }
      ]
    });
    Charts.bar($('#chartRate'), {
      title: '定稿率 / 完成率', horizontal: false,
      labels: names,
      datasets: [
        { label: '定稿率(%)', data: ds.map(d => Math.round(d.rate * 1000) / 10), color: '#0ea5e9' },
        { label: '完成率(%)', data: ds.map(d => Math.round(d.completion * 1000) / 10), color: '#f59e0b' }
      ]
    });
    const sd = sum.statusDist, sk = Object.keys(sd);
    Charts.doughnut($('#chartStatus'), { title: '订单状态分布', labels: sk, values: sk.map(k => sd[k]) });
    const td = sum.typeDist, tk = Object.keys(td);
    Charts.doughnut($('#chartType'), { title: '订单类型分布（小单/普通/大单）', labels: tk, values: tk.map(k => td[k]) });

    // 速览表
    $('#dashPerfTable').innerHTML =
      '<thead><tr><th>设计师</th><th>接单</th><th>定稿数</th><th>定稿率</th><th>完成率</th><th>系数</th><th>小单</th><th>总绩效</th></tr></thead><tbody>' +
      (ds.length ? ds.map(d =>
        '<tr><td>' + esc(d.designerName) + '</td><td>' + d.total + '</td><td>' + d.finalizedCount + '</td><td>' + pct(d.rate) +
        '</td><td>' + pct(d.completion) + '</td><td>' + d.coef + '</td><td>' + d.smallCount + '</td><td class="num">¥' + money(d.totalPerf) + '</td></tr>'
      ).join('') : '<tr><td colspan="8" class="empty">暂无数据，请先在“设计师”与“订单”中录入</td></tr>') + '</tbody>';
    applyPermissions();
  }
  async function teamAwardNow(sum) {
    const s = sum.settings;
    return sum.counts.totalRevenue > s.team_award_t2 ? s.team_award_a2 :
      sum.counts.totalRevenue > s.team_award_t1 ? s.team_award_a1 : 0;
  }

  /* ============================================================
   * 订单
   * ============================================================ */
  function readFilters() {
    state.filters = {
      status: $('#fStatus').value, designerId: $('#fDesigner').value,
      customerId: $('#fCustomer').value, keyword: $('#fKeyword').value
    };
  }
  async function renderOrders() {
    // 数据范围：无 orders_view_all 时仅显示本人参与的订单
    let list = await DB.listOrders(state.filters || {});
    if (!can('orders_view_all') && state.currentUser) {
      const me = state.currentUser.id;
      list = list.filter(o => window.Cfg.participants(o).includes(me));
    }
    const orders = list;
    orders.sort((a, b) => (a.intake_at || '').localeCompare(b.intake_at || ''));
    const dsMap = Object.fromEntries((state._designers || []).map(d => [d.id, d.name]));
    const rows = orders.map(o => {
      const cat = window.Cfg.orderCategory(Number(o.amount) || 0, state._settings);
      const collabNames = (Array.isArray(o.collab_designer_ids) ? o.collab_designer_ids : [])
        .map(id => dsMap[id]).filter(Boolean);
      const designerCell = (dsMap[o.assigned_designer_id] || '<span style="color:var(--muted)">未派</span>') +
        (collabNames.length ? ' <span class="collab-tag">+' + collabNames.join('/') + '</span>' : '');
      const reworkCell = o.rework_category
        ? ' <span class="badge ' + (o.rework_category === '设计原因' ? 'bad' : 'warn') + '">' + o.rework_category + '</span>' : '';
      return '<tr>' +
        '<td>' + esc(o.order_no || '') + '</td>' +
        '<td>' + esc(o.title) + (o.notes ? ' <span title="' + esc(o.notes) + '">📝</span>' : '') + '</td>' +
        '<td>' + esc(o.customer_name || '') + '</td>' +
        '<td>' + esc(o.task_type) + '</td>' +
        '<td class="num">¥' + money(o.amount) + '</td>' +
        '<td>' + catPill(cat) + (o.complaint_count ? ' <span class="badge bad">投诉' + o.complaint_count + '</span>' : '') + '</td>' +
        '<td>' + designerCell + reworkCell + '</td>' +
        '<td>' + pill(o.status) + '</td>' +
        '<td class="num">' + (o.revision_count || 0) + '</td>' +
        '<td>' + fmtTime(o.deadline) + '</td>' +
        '<td><button class="btn sm" data-act="open" data-id="' + o.id + '">流程/详情</button> ' +
        '<button class="btn sm danger" data-act="del" data-id="' + o.id + '" data-perm="orders_delete">删除</button></td>' +
        '</tr>';
    }).join('');
    $('#ordersTable').innerHTML =
      '<thead><tr><th>单号</th><th>标题</th><th>客户</th><th>类型</th><th>金额</th><th>分类</th><th>设计师</th><th>状态</th><th>修改</th><th>截稿</th><th>操作</th></tr></thead><tbody>' +
      (orders.length ? rows :
        '<tr><td colspan="11" class="empty">' +
        '暂无订单，点击“新建订单”开始' +
        '</td></tr>') + '</tbody>';
    $$('#ordersTable [data-act]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.act === 'open') openOrder(b.dataset.id);
      if (b.dataset.act === 'del') delOrder(b.dataset.id);
    }));
    applyPermissions();
  }

  async function newOrder() {
    const no = await DB.genOrderNo();
    state.editingOrder = {
      id: null, order_no: no, title: '', customer_id: '', customer_name: '',
      task_type: '名片', amount: 0, status: '接单', assigned_designer_id: '',
      revision_count: 0, is_finalized: false, revision_note: '',
      intake_at: new Date().toISOString(), dispatch_at: null, deadline: null,
      design_started_at: null, draft_at: null, feedback_at: null,
      feedback_failed_at: null, feedback_pass_at: null,
      revision_at: null, redraft_at: null, finalized_at: null,
      switched_at: null, switch_reason: '', notes: '',
      proposal_log: [], proposal_failed_log: [], draft_log: [], revision_log: [],
      redraft_log: [], feedback_failed_log: []
    };
    renderOrderModal();
  }
  async function openOrder(id) {
    const o = (state._orders || []).find(x => x.id === id);
    if (!o) return;
    state.editingOrder = Object.assign({}, o);
    renderOrderModal();
  }

  function customerInfoHtml(cs, customerId) {
    if (!customerId || customerId === '__new__') return '<span style="color:var(--muted)">请选择客户或新建客户</span>';
    const c = (cs || []).find(x => x.id === customerId);
    if (!c) return '<span style="color:var(--muted)">客户未找到</span>';
    const parts = [];
    if (c.company) parts.push('<span class="cust-pill">👤 ' + esc(c.company) + '</span>');
    parts.push('<span class="cust-pill">☎ ' + esc(c.phone || '—') + '</span>');
    parts.push('<span class="cust-pill">📍 ' + esc(c.address || '—') + '</span>');
    if (c.tag) parts.push('<span class="cust-pill tag">🏷 ' + esc(c.tag) + '</span>');
    return parts.join('');
  }

  // 截稿时间选择器：日期 + 每 10 分钟的时间下拉 + 快捷预设；隐藏 #oDeadline 承载组合值
  function deadlinePickerHtml(o) {
    const v = o.deadline ? toLocalInput(o.deadline) : '';
    const [date, time] = v ? v.split('T') : ['', ''];
    const timeMM = time ? time.slice(0, 5) : '';
    let opts = '<option value="">选择时间</option>';
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 10) {
        const hh = String(h).padStart(2, '0'), mm = String(m).padStart(2, '0');
        const val = hh + ':' + mm;
        opts += '<option value="' + val + '"' + (val === timeMM ? ' selected' : '') + '>' + val + '</option>';
      }
    }
    const presets = [['今天 18:00', 'today1800'], ['明天 18:00', 'tom1800'], ['3 天后', 'plus3']];
    const hidden = (date && timeMM) ? (date + 'T' + timeMM) : '';
    return ''
      + '<div class="grid2-sm" style="margin-top:6px">'
      +   '<div><label>截稿日期</label><input id="oDeadlineDate" type="date" value="' + date + '"></div>'
      +   '<div><label>截稿时间（每 10 分钟）</label><select id="oDeadlineTime">' + opts + '</select></div>'
      + '</div>'
      + '<div style="margin-top:8px"><label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px">快捷设置</label>'
      +   '<div class="chips">' + presets.map(p => '<button type="button" class="chip" data-dl-preset="' + p[1] + '">' + p[0] + '</button>').join('') + '</div></div>'
      + '<input id="oDeadline" type="hidden" value="' + hidden + '">';
  }
  function syncDeadline() {
    const d = $('#oDeadlineDate'), t = $('#oDeadlineTime'), h = $('#oDeadline');
    if (!d || !t || !h) return;
    if (d.value && !t.value) t.value = '18:00'; // 选了日期但没选时间，默认 18:00
    h.value = (d.value && t.value) ? (d.value + 'T' + t.value) : '';
  }
  function applyDeadlinePreset(kind) {
    const d = new Date();
    if (kind === 'tom1800') d.setDate(d.getDate() + 1);
    if (kind === 'plus3') d.setDate(d.getDate() + 3);
    const ds = $('#oDeadlineDate'), ts = $('#oDeadlineTime');
    if (!ds || !ts) return;
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    ds.value = y + '-' + m + '-' + day; ts.value = '18:00';
    syncDeadline();
  }

  function renderOrderModal() {
    const o = state.editingOrder;
    const ds = state._designers || [], cs = state._customers || [];
    const collabIds = Array.isArray(o.collab_designer_ids) ? o.collab_designer_ids : [];
    const otherDs = ds.filter(d => d.id !== o.assigned_designer_id && (isActiveDesign(d) || collabIds.includes(d.id)));
    const collabHtml = otherDs.map(d =>
      '<label class="chk"><input type="checkbox" class="oCollab" value="' + d.id + '"' +
      (collabIds.includes(d.id) ? ' checked' : '') + '> ' + esc(d.name) + '</label>').join('');
    const FLOW = window.Cfg.FLOW;
    const idx = s => FLOW.indexOf(s);
    const cur = idx(o.status);
    const steps = FLOW.map((s, i) => {
      let cls = 'st';
      if (o.status === '已换人') { cls = (i < idx('客户反馈')) ? 'st done' : 'st'; }
      else if (i < cur) cls = 'st done'; else if (i === cur) cls = 'st cur';
      return '<span class="' + cls + '">' + s + '</span>';
    }).join('');

    // 流程操作按钮
    let flow = '';
    if (o.status === '接单') flow = '<button class="btn" data-flow="dispatch">派单（指定设计师与截稿时间）</button>';
    else if (o.status === '派单') flow = '<button class="btn" data-flow="proposal">提交提案</button>';
    else if (o.status === '提案') {
      flow = '<button class="btn ok" data-flow="proposal_pass">提案通过（开始设计）</button>' +
        '<button class="btn warn" data-flow="proposal_fail">提案不通过</button>';
    } else if (o.status === '提案不通过') {
      flow = '<button class="btn" data-flow="proposal_again">二次提案</button>' +
        '<button class="btn danger" data-flow="switch">换人</button>';
    } else if (o.status === '设计中') flow = '<button class="btn" data-flow="draft">提交初稿</button>';
    else if (o.status === '初稿') flow = '<button class="btn" data-flow="feedback">提交客户反馈</button>';
    else if (o.status === '客户反馈') {
      flow = '<div class="revise-box">' +
        '<button class="btn ok" data-flow="finalize">通过（定稿）</button>' +
        '<button class="btn warn" data-flow="revise">需要修改</button></div>';
    } else if (o.status === '修改中') flow = '<button class="btn ok" data-flow="finalize">客户定稿</button>' +
      '<button class="btn danger" data-flow="switch">换人</button>';
    else if (o.status === '已定稿') flow = '<span class="pill cat-小单">已完成定稿</span>';
    else if (o.status === '已换人') flow = '<span class="pill">已更换设计师</span>';

    // 订单信息表单（客户/金额/设计师/备注等）—— 详情模式下默认收起，不干扰流程查看
    const infoForm = `
      <div class="compact-form">
        <div class="form-section">
          <div class="form-sec-title">基础信息</div>
          <div class="field"><label>标题</label><input id="oTitle" value="${esc(o.title)}" placeholder="如：XX公司名片设计"></div>
          <div class="grid2-sm" style="margin-top:8px">
            <div class="field"><label>客户</label><select id="oCustomer"><option value="">请选择客户</option><option value="__new__">+ 新建客户</option>${cs.map(c => '<option value="' + c.id + '"' + (c.id === o.customer_id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('')}</select></div>
            <div class="field"><label>任务类型</label><select id="oType">${window.Cfg.TASK_TYPES.map(t => '<option' + (t === o.task_type ? ' selected' : '') + '>' + t + '</option>').join('')}</select></div>
          </div>
          <div class="field" id="oCustInfo" style="margin-top:8px"><label>客户信息</label><div class="cust-meta">${customerInfoHtml(cs, o.customer_id)}</div></div>
          <div id="oNewCustomer" class="card light" style="display:none;margin:8px 0 0;padding:10px">
            <div class="grid2-sm">
              <div class="field"><label>客户名称</label><input id="oNewCName" placeholder="如：XX公司"></div>
              <div class="field"><label>联系人</label><input id="oNewCCompany" placeholder="联系人姓名"></div>
              <div class="field"><label>电话</label><input id="oNewCPhone"></div>
              <div class="field"><label>地址</label><input id="oNewCAddress"></div>
            </div>
          </div>
          <div class="grid2-sm" style="margin-top:8px">
            <div class="field"><label>金额/营收(元)</label><input id="oAmount" type="number" value="${o.amount || 0}"></div>
            <div class="field"><label>状态 <span class="muted" style="font-weight:400;font-size:11px">（只读 · 仅流程推进变更）</span></label><div class="ro-box">${pill(o.status)}</div></div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">派单与协作</div>
          <div class="grid2-sm">
            <div class="field"><label>派单设计师</label><select id="oDesigner"><option value="">未派单</option>${ds.filter(d => isActiveDesign(d) || d.id === o.assigned_designer_id).map(d => '<option value="' + d.id + '"' + (d.id === o.assigned_designer_id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('')}</select></div>
            <div class="field"><label>协作设计师 <span class="muted" style="font-weight:400;font-size:11px">（各计 1 单）</span></label><div class="chips">${collabHtml || '<span style="color:var(--muted);font-size:12px">无其他设计师可选</span>'}</div></div>
          </div>
          <div class="field" style="margin-top:8px"><label>截稿时间（每 10 分钟）</label>${deadlinePickerHtml(o)}</div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">修改与投诉 <span class="muted" style="font-weight:400;font-size:12px">（自动累计，不可手动改小）</span></div>
          <div class="grid2-sm">
            <div class="field"><label>修改次数</label><div class="ro-box"><span id="revVal" class="ro-val">${o.revision_count || 0}</span><span class="muted" style="font-size:11px"> 流程自动累计</span></div></div>
            <div class="field"><label>客户投诉笔数</label><div class="ro-box"><span id="complaintVal" class="ro-val">${o.complaint_count || 0}</span><button type="button" class="btn-mini" data-complaint="inc" title="记录一次客户投诉（+1）">＋投诉</button></div></div>
          </div>
          <div class="field" style="margin-top:10px"><label>投诉原因</label>
            ${(o.complaint_log && o.complaint_log.length)
              ? '<div class="complaint-list">' + o.complaint_log.map((c, i) => '<div class="complaint-item"><span class="muted">#' + (i + 1) + '</span> <span class="badge ' + (c.reason === '设计原因' ? 'bad' : 'warn') + '">' + esc(c.reason || '—') + '</span> <span class="muted">' + (c.ts ? fmtTime(c.ts) : '') + '</span>' + (c.note ? '<div class="cmp-note">' + esc(c.note) + '</div>' : '') + '</div>').join('') + '</div>'
              : '<span class="muted" style="font-size:12px">暂无投诉，点击上方「＋投诉」记录</span>'}
          </div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">文件路径</div>
          <div class="field"><label>素材文件路径（每行一个，可直接粘贴电脑路径）</label>
            <textarea id="oFilePaths" rows="2" placeholder="如：//DESKTOP-PC/share/素材/海报.psd&#10;D:/项目/客户A/原始文件">${esc((o.file_paths || []).join('\n'))}</textarea>
            <div id="filePathList" style="margin-top:6px">${filePathItemsHtml(o.file_paths || [], 'data-openfolder')}</div>
          </div>
          <div class="field" style="margin-top:8px"><label>设计稿路径（每行一个，可粘贴设计稿/设计文件夹路径）</label>
            <textarea id="oDesignPaths" rows="2" placeholder="如：D:/项目/客户A/设计稿&#10;//NAS/design/客户A">${esc((o.design_paths || []).join('\n'))}</textarea>
            <div id="designPathList" style="margin-top:6px">${filePathItemsHtml(o.design_paths || [], 'data-openfolder')}</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">备注</div>
          <div class="field"><textarea id="oNotes" rows="2" placeholder="订单补充说明…">${esc(o.notes)}</textarea></div>
        </div>

        <details style="margin:8px 0"><summary style="cursor:pointer;color:var(--muted)">流程时间戳（自动记录，仅流程推进写入，不可修改）</summary>
          <div class="grid3-sm" style="margin-top:8px">
            <div class="field"><label>接单时间</label><div class="ro-box"><span class="ro-val">${o.intake_at ? fmtTime(o.intake_at) : '—'}</span></div></div>
            <div class="field"><label>派单时间</label><div class="ro-box"><span class="ro-val">${o.dispatch_at ? fmtTime(o.dispatch_at) : '—'}</span></div></div>
            <div class="field"><label>提案时间</label><div class="ro-box"><span class="ro-val">${o.proposal_at ? fmtTime(o.proposal_at) : '—'}</span></div></div>
            <div class="field"><label>提案不通过</label><div class="ro-box"><span class="ro-val">${o.proposal_failed_at ? fmtTime(o.proposal_failed_at) : '—'}</span></div></div>
            <div class="field"><label>提案通过</label><div class="ro-box"><span class="ro-val">${o.proposal_pass_at ? fmtTime(o.proposal_pass_at) : '—'}</span></div></div>
            <div class="field"><label>设计开始</label><div class="ro-box"><span class="ro-val">${o.design_started_at ? fmtTime(o.design_started_at) : '—'}</span></div></div>
            <div class="field"><label>初稿提交</label><div class="ro-box"><span class="ro-val">${o.draft_at ? fmtTime(o.draft_at) : '—'}</span></div></div>
            <div class="field"><label>客户反馈</label><div class="ro-box"><span class="ro-val">${o.feedback_at ? fmtTime(o.feedback_at) : '—'}</span></div></div>
            <div class="field"><label>客户反馈需修改</label><div class="ro-box"><span class="ro-val">${o.feedback_failed_at ? fmtTime(o.feedback_failed_at) : '—'}</span></div></div>
            <div class="field"><label>修改/返工开始</label><div class="ro-box"><span class="ro-val">${o.revision_at ? fmtTime(o.revision_at) : '—'}</span></div></div>
            <div class="field"><label>二次看稿</label><div class="ro-box"><span class="ro-val">${o.redraft_at ? fmtTime(o.redraft_at) : '—'}</span></div></div>
            <div class="field"><label>定稿时间</label><div class="ro-box"><span class="ro-val">${o.finalized_at ? fmtTime(o.finalized_at) : '—'}</span></div></div>
            <div class="field"><label>已换人</label><div class="ro-box"><span class="ro-val">${o.switched_at ? fmtTime(o.switched_at) : '—'}</span></div></div>
          </div>
        </details>
      </div>`;

    // 流程区块（节点时间轴 + 推进按钮）—— 详情模式的主视图
    const flowBlock = `
      <div class="stage-steps">${steps}</div>
      ${renderTimeline(o)}
      <div class="flow-actions">${flow}</div>`;

    // 新建订单专用精简表单：只保留下单必要字段，去掉「修改与投诉 / 流程时间戳」等对新单无意义的区块，
    // 文件路径与备注折叠进「更多信息」，尽量压缩高度、保持美观。所有 id 与保存逻辑对齐。
    const newInfoForm = `
      <div class="compact-form order-new">
        <div class="form-section">
          <div class="form-sec-title">基础信息</div>
          <div class="field"><label>订单标题</label><input id="oTitle" value="${esc(o.title)}" placeholder="如：XX公司名片设计"></div>
          <div class="grid3-sm" style="margin-top:8px">
            <div class="field"><label>客户</label><select id="oCustomer"><option value="">请选择客户</option><option value="__new__">+ 新建客户</option>${cs.map(c => '<option value="' + c.id + '"' + (c.id === o.customer_id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('')}</select></div>
            <div class="field"><label>任务类型</label><select id="oType">${window.Cfg.TASK_TYPES.map(t => '<option' + (t === o.task_type ? ' selected' : '') + '>' + t + '</option>').join('')}</select></div>
            <div class="field"><label>金额/营收(元)</label><input id="oAmount" type="number" value="${o.amount || 0}"></div>
          </div>
          <div class="field" id="oCustInfo" style="margin-top:8px"><div class="cust-meta">${customerInfoHtml(cs, o.customer_id)}</div></div>
          <div id="oNewCustomer" class="card light" style="display:none;margin:8px 0 0;padding:10px">
            <div class="grid2-sm">
              <div class="field"><label>客户名称</label><input id="oNewCName" placeholder="如：XX公司"></div>
              <div class="field"><label>联系人</label><input id="oNewCCompany" placeholder="联系人姓名"></div>
              <div class="field"><label>电话</label><input id="oNewCPhone"></div>
              <div class="field"><label>地址</label><input id="oNewCAddress"></div>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">派单与协作 <span class="muted" style="font-weight:400;font-size:11px">（可稍后在流程中派单）</span></div>
          <div class="grid2-sm">
            <div class="field"><label>派单设计师</label><select id="oDesigner"><option value="">未派单</option>${ds.filter(d => isActiveDesign(d) || d.id === o.assigned_designer_id).map(d => '<option value="' + d.id + '"' + (d.id === o.assigned_designer_id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('')}</select></div>
            <div class="field"><label>截稿时间（每 10 分钟）</label>${deadlinePickerHtml(o)}</div>
          </div>
          <div class="field" style="margin-top:8px"><label>协作设计师 <span class="muted" style="font-weight:400;font-size:11px">（2~3 人协同，各计 1 单）</span></label><div class="chips">${collabHtml || '<span style="color:var(--muted);font-size:12px">无其他设计师可选</span>'}</div></div>
        </div>

        <details class="info-collapse"><summary>文件路径 / 备注（可选）</summary>
          <div class="field" style="margin-top:8px"><label>素材文件路径（每行一个，可直接粘贴电脑路径）</label>
            <textarea id="oFilePaths" rows="2" placeholder="如：//DESKTOP-PC/share/素材/海报.psd&#10;D:/项目/客户A/原始文件">${esc((o.file_paths || []).join('\n'))}</textarea>
            <div id="filePathList" style="margin-top:6px">${filePathItemsHtml(o.file_paths || [], 'data-openfolder')}</div>
          </div>
          <div class="field" style="margin-top:8px"><label>设计稿路径（每行一个）</label>
            <textarea id="oDesignPaths" rows="2" placeholder="如：D:/项目/客户A/设计稿&#10;//NAS/design/客户A">${esc((o.design_paths || []).join('\n'))}</textarea>
            <div id="designPathList" style="margin-top:6px">${filePathItemsHtml(o.design_paths || [], 'data-openfolder')}</div>
          </div>
          <div class="field" style="margin-top:8px"><label>备注</label><textarea id="oNotes" rows="2" placeholder="订单补充说明…">${esc(o.notes)}</textarea></div>
        </details>
      </div>`;

    const isDetail = !!o.id;
    let html;
    if (isDetail) {
      html = `
      <button class="close" data-close>×</button>
      <h3>流程详情 · 节点完成时间 <span style="font-size:14px;color:var(--muted)">${esc(o.order_no)} · ${esc(o.title)}</span></h3>
      <div class="flow-detail">${flowBlock}</div>
      <details class="info-collapse" open><summary>订单信息（客户 / 金额 / 设计师 / 截稿时间，派单前请填写）</summary>
        ${infoForm}
      </details>
      <div class="row" style="justify-content:flex-end">
        ${o.id ? '<button class="btn danger" id="oDelete">删除</button>' : ''}
        <button class="btn secondary" id="oCancel" data-close>关闭</button>
        <button class="btn" id="oSave">保存信息</button>
      </div>`;
    } else {
      html = `
      <button class="close" data-close>×</button>
      <h3>新建订单 <span class="order-no-tag">${esc(o.order_no)}</span></h3>
      ${newInfoForm}
      <div class="modal-foot">
        <button class="btn secondary" id="oCancel" data-close>取消</button>
        <button class="btn" id="oSave">保存订单</button>
      </div>`;
    }
    openModal(html);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', closeModal));
    if ($('#oDelete')) $('#oDelete').addEventListener('click', () => { delOrder(o.id); });
    $('#oSave').addEventListener('click', () => saveOrderFromModal());
    $('#oCustomer').addEventListener('change', () => {
      const cid = $('#oCustomer').value;
      $('#oCustInfo .cust-meta').innerHTML = customerInfoHtml(cs, cid);
      const isNew = cid === '__new__';
      $('#oNewCustomer').style.display = isNew ? '' : 'none';
    });
    $$('#modalBox [data-flow]').forEach(b => b.addEventListener('click', () => advanceFlow(b.dataset.flow)));
    // 客户投诉笔数：只读 +1，点击弹出自定义窗口选择原因并填写备注
    const cInc = $('#modalBox [data-complaint="inc"]');
    if (cInc) cInc.addEventListener('click', () => complaintModal());
    // 素材文件路径：实时预览 + 点击打开/复制
    const fpEl = $('#oFilePaths');
    if (fpEl) {
      const upd = () => {
        const paths = fpEl.value.split('\n').map(l => normalizePath(l)).filter(Boolean);
        $('#filePathList').innerHTML = filePathItemsHtml(paths, 'data-openfolder');
      };
      fpEl.addEventListener('input', upd);
    }
    const dpEl = $('#oDesignPaths');
    if (dpEl) {
      const upd = () => {
        const paths = dpEl.value.split('\n').map(l => normalizePath(l)).filter(Boolean);
        $('#designPathList').innerHTML = filePathItemsHtml(paths, 'data-openfolder');
      };
      dpEl.addEventListener('input', upd);
    }
    // 截稿时间选择器：日期/时间联动 + 快捷预设
    if ($('#oDeadlineDate')) {
      $('#oDeadlineDate').addEventListener('change', syncDeadline);
      $('#oDeadlineTime').addEventListener('change', syncDeadline);
      $$('#modalBox [data-dl-preset]').forEach(b => b.addEventListener('click', () => applyDeadlinePreset(b.dataset.dlPreset)));
    }
    $('#modalBox').addEventListener('click', (e) => {
      const of = e.target.closest('[data-openfolder]');
      if (of) { openInExplorer(of.dataset.openfolder); return; }
      const cp = e.target.closest('[data-fpcopy]');
      if (cp) { copyText(cp.dataset.fpcopy); toast('已复制：' + cp.dataset.fpcopy); }
    });
    applyPermissions();
  }

  // 流程时间轴（每个进度都有时间记忆）：已完成节点显示完成时间，当前节点高亮，未到达显示待推进
  function renderTimeline(o) {
    ensureFlowLogs(o);
    // 收集所有已发生节点（带时间戳），统一按"真实发生时间"升序排列。
    // 这样无论走哪条分支（提案不通过 / 二稿修改 / 换人），时间轴都严格按流程时间顺序展示，
    // 不再受写死的 put() 顺序影响。rank 作为同毫秒的兜底排序（已按流程先后分配）。
    const evts = [];
    const add = (name, ts, rank) => { if (ts) evts.push({ name, ts, rank, state: 'done' }); };
    let r = 0;
    add('接单', o.intake_at, r++);
    add('派单', o.dispatch_at, r++);

    // 提案循环：第 i 次提案 → 第 i 次提案不通过（如有）→ 提案通过
    // rank 按循环顺序递增，确保「二次提案」一定在「第一次提案不通过」之后。
    const propLog = o.proposal_log || [];
    const propFailLog = o.proposal_failed_log || [];
    propLog.forEach((t, i) => {
      const failuresBefore = propFailLog.filter(ft => ft <= t).length;
      let label;
      if (failuresBefore > 0) label = failuresBefore === 1 ? '二次提案' : (failuresBefore === 2 ? '三次提案' : '第' + (failuresBefore + 1) + '次提案');
      else if (i === 0) label = '提交提案';
      else label = '提案（第' + (i + 1) + '次）';
      add(label, t, r++);
      if (propFailLog[i]) add('提案不通过', propFailLog[i], r++);
    });
    add('提案通过', o.proposal_pass_at, r++);
    add('设计中', o.design_started_at, r++);

    // 初稿（仅第1次出稿）
    if ((o.draft_log || [])[0]) add('初稿', o.draft_log[0], r++);

    // 客户反馈 / 修改流程：客户反馈 → 客户反馈需修改 → 修改中 → 已定稿
    const fbFailLog = o.feedback_failed_log || [];
    const revLog = o.revision_log || [];
    add('客户反馈', o.feedback_at, r++);
    fbFailLog.forEach((t, j) => {
      add('客户反馈需修改', t, r++);
      if (revLog[j]) add('修改中', revLog[j], r++);
    });
    add('客户反馈通过', o.feedback_pass_at, r++);
    add('已定稿', o.finalized_at, r++);
    add('已换人', o.switched_at, r++);

    // 流程节点优先按业务阶段（rank）排序，同阶段再按真实时间排序。
    // 这样即使手动编辑或测试数据导致时间戳略有偏差，时间轴也不会出现
    // "设计中跑到提案通过前面"这种违反流程顺序的混乱。
    evts.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
    });

    // 当前节点高亮：状态名与节点标签不完全一致时做映射
    let curName = o.status;
    if (o.status === '提案') {
      const n = propLog.length;
      const failuresBefore = n > 0 ? propFailLog.filter(ft => ft <= propLog[n - 1]).length : 0;
      curName = failuresBefore > 0
        ? (failuresBefore === 1 ? '二次提案' : (failuresBefore === 2 ? '三次提案' : '第' + (failuresBefore + 1) + '次提案'))
        : (n === 1 ? '提交提案' : '提案（第' + n + '次）');
    } else if (o.status === '修改中') {
      curName = '修改中';
    }

    // 待推进节点（无时间戳，始终排在已发生节点之后）
    const FLOW = window.Cfg.FLOW;
    let pending = [];
    if (o.status === '提案不通过') {
      pending = [{ name: '二次提案', state: 'pending' }, { name: '换人', state: 'pending' }];
    } else if (o.status === '客户反馈') {
      pending = [{ name: '客户反馈通过', state: 'pending' }, { name: '客户反馈未通过', state: 'pending' }];
    } else if (o.status === '修改中') {
      pending = [{ name: '客户定稿', state: 'pending' }, { name: '换人', state: 'pending' }];
    } else {
      let curIdx = FLOW.indexOf(o.status);
      if (o.status === '已换人') curIdx = FLOW.length;
      pending = (curIdx >= 0 && curIdx < FLOW.length - 1)
        ? FLOW.slice(curIdx + 1).map(s => ({ name: s, state: 'pending' }))
        : [];
    }
    const all = evts.concat(pending);
    // 时间轴显示到秒，便于看清同分钟内多次操作的先后
    const fmtSec = t => {
      if (!t) return '—';
      const d = new Date(t); if (isNaN(d)) return '—';
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    };
    const html = '<div class="timeline"><div class="tl-title">流程节点与时间 · 共 ' + all.length + ' 步</div>' + all.map((it) => {
      let cls = 'tl-item';
      const isCur = it.name === curName;
      if (isCur) cls += ' cur';
      else if (it.state === 'pending') cls += ' pending';
      else cls += ' done';
      const timeTxt = it.state === 'pending'
        ? (isCur ? '<span class="tl-pending">进行中…</span>' : '<span class="tl-pending">待推进</span>')
        : fmtSec(it.ts);
      return '<div class="' + cls + '"><span class="tl-dot"></span><span class="tl-name">' + it.name + '</span><span class="tl-time">' + timeTxt + '</span></div>';
    }).join('') + '</div>';
    return html;
  }

  // 纯函数：根据动作推进订单状态（不碰 DOM、不弹窗），弹窗与工作台卡片共用。
  // 所有动作都带「状态转移守卫」：只有 prev 状态合法时才真正写入日志/时间戳，防止按钮连点或误触发导致重复记录。
  function applyFlowAction(o, action, opts) {
    opts = opts || {};
    const now = new Date().toISOString();
    const prev = o.status;
    const prevDesigner = o.assigned_designer_id;
    let changed = false;

    const ensureArr = (k) => { o[k] = Array.isArray(o[k]) ? o[k] : []; };
    const pushLog = (k, ts) => { ensureArr(k); if (!o[k].includes(ts)) o[k].push(ts); };

    if (action === 'dispatch') {
      if (prev === '接单') {
        o.status = '派单'; o.dispatch_at = now;
        if (!o.assigned_designer_id) o.assigned_designer_id = opts.designerId || null;
        if (!o.deadline && opts.deadline) o.deadline = opts.deadline;
        changed = true;
      }
    } else if (action === 'start') {
      if (prev === '派单') { o.status = '设计中'; o.design_started_at = now; changed = true; }
    } else if (action === 'proposal') {
      // 只有从「派单」推进来才是真正的首次提案，防止在「提案」状态重复提交
      if (prev === '派单') {
        o.status = '提案'; o.proposal_at = now;
        o.proposal_count = (o.proposal_count || 0) + 1;
        pushLog('proposal_log', now);
        changed = true;
      }
    } else if (action === 'proposal_pass') {
      if (prev === '提案') { o.status = '设计中'; o.design_started_at = now; o.proposal_pass_at = now; changed = true; }
    } else if (action === 'proposal_fail') {
      if (prev === '提案') {
        o.status = '提案不通过'; o.proposal_failed_at = now;
        pushLog('proposal_failed_log', now);
        o.proposal_count = (o.proposal_count || 0) + 1;
        changed = true;
      }
    } else if (action === 'proposal_again') {
      // 只有从「提案不通过」推进来才是真正的二次提案
      if (prev === '提案不通过') {
        o.status = '提案'; o.proposal_at = now;
        o.proposal_count = (o.proposal_count || 0) + 1;
        pushLog('proposal_log', now);
        changed = true;
      }
    } else if (action === 'draft') {
      // 初稿（设计中）或修改后再投稿（修改中）
      if (prev === '设计中' || prev === '修改中') {
        o.status = '初稿'; o.draft_at = now;
        if (prev === '设计中') pushLog('draft_log', now);
        if (prev === '修改中') { o.redraft_at = now; pushLog('redraft_log', now); }
        changed = true;
      }
    } else if (action === 'feedback') {
      if (prev === '初稿') { o.status = '客户反馈'; o.feedback_at = now; changed = true; }
    } else if (action === 'revise') {
      // 只有从「客户反馈」点不通过，才是真正的修改开始
      if (prev === '客户反馈') {
        o.revision_count = (o.revision_count || 0) + 1;
        // 修改不再记录返工原因（原因概念仅保留在「投诉」中）
        o.revision_at = now; o.feedback_failed_at = now;
        pushLog('revision_log', now); pushLog('feedback_failed_log', now);
        // 不再自动换人：三次修改后仍停留在「修改中」（三稿修改中），
        // 由用户主动点击「换人」按钮指派新设计师，避免默默换人却未真正指派负责人。
        o.status = '修改中';
        changed = true;
      }
    } else if (action === 'finalize') {
      // 客户反馈通过 → 定稿；或修改中（修改已全部完成）直接点「客户定稿」完成定稿
      if (prev === '客户反馈' || prev === '修改中') {
        o.status = '已定稿'; o.finalized_at = now;
        if (prev === '客户反馈') o.feedback_pass_at = now;
        o.is_finalized = (o.revision_count || 0) <= 1;
        changed = true;
      }
    } else if (action === 'switch') {
      if (prev !== '已换人') {
        // 更换主负责人：新设计师接手，旧主负责人移入协作列表（仍计协同单）
        if (opts && opts.newDesignerId && opts.newDesignerId !== o.assigned_designer_id) {
          const oldId = o.assigned_designer_id;
          o.assigned_designer_id = opts.newDesignerId;
          if (oldId) {
            o.collab_designer_ids = Array.isArray(o.collab_designer_ids) ? o.collab_designer_ids : [];
            if (!o.collab_designer_ids.includes(oldId)) o.collab_designer_ids.push(oldId);
          }
        }
        o.status = '已换人'; o.switched_at = now;
        o.switch_reason = opts.switchReason || '更换设计师';
        changed = true;
      }
    }

  }

  // 订单弹窗内的流程推进（需先同步表单字段、处理新建客户）
  async function advanceFlow(action) {
    const o = state.editingOrder;
    if (action === 'switch') {
      switchDesignerModal(o, { onApplied: () => renderOrderModal(), closeAfter: false });
      return;
    }
    // 三次改稿（三稿修改中）后，禁止再点「不通过（修改）」默默推进；引导用换人按钮
    if (action === 'revise' && o.status === '修改中' && (o.revision_count || 0) >= 2) {
      toast('已修改 3 次（三稿修改中），请点击「换人」按钮更换设计师');
      return;
    }
    // 派单前必须指定设计师与截稿时间：若未填，展开订单信息并聚焦对应字段，不推进
    if (action === 'dispatch') {
      const dEl = $('#oDesigner'), dlEl = $('#oDeadline');
      const hasDesigner = dEl && dEl.value;
      const hasDeadline = dlEl && dlEl.value;
      if (!hasDesigner || !hasDeadline) {
        const det = $('#modalBox .info-collapse');
        if (det) det.open = true;
        if (!hasDesigner && dEl) dEl.focus();
        else if (!hasDeadline && dlEl) dlEl.focus();
        toast('请先' + (!hasDesigner ? '选择派单设计师' : '填写截稿时间') + '，再点「派单」');
        return;
      }
    }
    syncFieldsFromModal();
    applyFlowAction(o, action, {
      designerId: $('#oDesigner').value,
      deadline: $('#oDeadline').value ? fromLocalInput($('#oDeadline').value) : null
    });
    try { await ensureCustomerFromModal(); } catch (e) { return; }
    try {
      await DB.saveOrder(o);
      await refreshAll();
      renderOrderModal();
    } catch (e) { console.error(e); toast('保存失败：' + e.message); }
  }
  // 换人弹窗：选择新主负责设计师 + 记录原因，自动把旧主负责人移入协作列表
  function switchDesignerModal(o, cb) {
    const onApplied = cb && cb.onApplied;
    const closeAfter = cb && cb.closeAfter;
    const ds = state._designers || [];
    const cur = ds.find(d => d.id === o.assigned_designer_id);
    const others = ds.filter(d => d.id !== o.assigned_designer_id && isActiveDesign(d));
    const options = others.length
      ? others.map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('')
      : '<option value="">无其他设计师</option>';
    const html = `
      <button class="close" data-close>×</button>
      <h3>更换设计师</h3>
      <div class="field" style="margin-bottom:10px"><label>当前负责</label>
        <div class="cust-meta"><span class="cust-pill">👤 ${esc(cur ? cur.name : '未派单')}</span></div>
      </div>
      <div class="field" style="margin-bottom:10px"><label>新设计师</label><select id="swNew">${options}</select></div>
      <div class="field"><label>换人原因</label>
        <textarea id="swReason" rows="2" placeholder="如：客户不满意，需更换设计师">客户不满意，需更换设计师</textarea>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn secondary" data-close>取消</button>
        <button class="btn" id="swConfirm">确认换人</button>
      </div>`;
    openModal(html);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', closeModal));
    $('#swConfirm').addEventListener('click', async () => {
      const newId = $('#swNew').value;
      if (!newId) { toast('请选择新设计师'); return; }
      const reason = ($('#swReason').value || '').trim() || '更换设计师';
      applyFlowAction(o, 'switch', { switchReason: reason, newDesignerId: newId });
      try {
        await DB.saveOrder(o);
        await refreshAll();
        const nm = (state._designers || []).find(d => d.id === newId);
        if (onApplied) onApplied();
        if (closeAfter) closeModal();
        toast('已换人 → ' + (nm ? nm.name : '新设计师'));
      } catch (e) { console.error(e); toast('换人失败：' + e.message); }
    });
  }

  // 投诉弹窗：自定义选择原因 + 填写备注，确认后 complaint_count+1 并记录到 complaint_log
  function complaintModal() {
    const o = state.editingOrder;
    const reasons = window.Cfg.REWORK_CATEGORIES || ['设计原因', '客户原因', '其他'];
    const html = `
      <button class="close" data-close>×</button>
      <h3>记录客户投诉</h3>
      <div class="field" style="margin-bottom:10px"><label>投诉原因（点击选择）</label>
        <div class="reason-chips" id="cmpReasonChips">
          ${reasons.map(r => `<button type="button" class="reason-chip" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}
        </div>
        <input type="hidden" id="cmpReason" value="${esc(reasons[0] || '')}">
      </div>
      <div class="field"><label>备注说明</label>
        <textarea id="cmpNote" rows="3" placeholder="请填写投诉详情，如：客户对配色不满意 / 交付延迟等"></textarea>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn secondary" id="cmpCancel">取消</button>
        <button class="btn" id="cmpConfirm">确认记录</button>
      </div>`;
    openModal(html);

    let selectedReason = reasons[0] || '';
    const chips = $$('#cmpReasonChips .reason-chip');
    function setReason(r) {
      selectedReason = r;
      $('#cmpReason').value = r;
      chips.forEach(c => c.classList.toggle('active', c.dataset.reason === r));
    }
    setReason(selectedReason);
    chips.forEach(c => c.addEventListener('click', () => setReason(c.dataset.reason)));

    $('#cmpCancel').addEventListener('click', () => renderOrderModal());
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', () => renderOrderModal()));
    $('#cmpConfirm').addEventListener('click', async () => {
      const note = ($('#cmpNote').value || '').trim();
      o.complaint_count = (Number(o.complaint_count) || 0) + 1;
      o.complaint_log = Array.isArray(o.complaint_log) ? o.complaint_log : [];
      o.complaint_log.push({ ts: new Date().toISOString(), reason: selectedReason, note });
      try {
        await DB.saveOrder(o);
        await refreshAll();
        renderOrderModal();
        toast('已记录 1 次客户投诉');
      } catch (e) { console.error(e); toast('保存失败：' + e.message); }
    });
  }

  // 工作台卡片：直接推进流程，无需打开订单详情
  async function wbAdvance(id, action) {
    const o = (state._orders || []).find(x => x.id === id);
    if (!o) { toast('订单不存在'); return; }
    // 派单需要设计师与截稿时间：工作台快速派单若缺失，转去订单弹窗填写
    if (action === 'dispatch' && (!o.assigned_designer_id || !o.deadline)) {
      toast('请先打开订单选择派单设计师' + (!o.deadline ? '并填写截稿时间' : '') + '，再点派单');
      openOrder(id);
      return;
    }
    const opts = {};
    if (action === 'revise') {
      if (o.status === '修改中' && (o.revision_count || 0) >= 2) {
        toast('已修改 3 次（三稿修改中），请点击「换人」按钮更换设计师');
        return;
      }
      // 客户反馈 → 修改中：一键推进，无需选择返工原因
      applyFlowAction(o, action, {});
      try {
        await DB.saveOrder(o);
        await refreshAll();
        renderWorkbench();
        toast('已转为修改中');
      } catch (e) { console.error(e); toast('保存失败：' + e.message); }
      return;
    }
    if (action === 'switch') {
      switchDesignerModal(o, { onApplied: () => renderWorkbench(), closeAfter: true });
      return;
    }
    applyFlowAction(o, action, opts);
    try {
      await DB.saveOrder(o);
      await refreshAll();
      renderWorkbench();
      toast('已推进：' + o.status);
    } catch (e) { console.error(e); toast('推进失败：' + e.message); }
  }

  function syncFieldsFromModal() {
    const o = state.editingOrder;
    o.title = $('#oTitle').value;
    o.customer_id = $('#oCustomer').value;
    o.customer_name = (state._customers || []).find(c => c.id === o.customer_id)?.name || '';
    o.task_type = $('#oType').value;
    o.amount = Number($('#oAmount').value) || 0;
    // 注意：status 不再从表单读取，仅由流程动作（applyFlowAction）推进，
    // 防止手动把状态跳到「已定稿」而绕过流程、漏记修改次数等绩效数据。
    o.assigned_designer_id = $('#oDesigner').value || null;
    o.deadline = fromLocalInput($('#oDeadline').value);
    // 注意：revision_count / complaint_count / rework_category 不再从表单读取，
    // 改为由流程动作自动累计（需要修改 +1 / ＋投诉 +1），防止手动改小篡改绩效。
    o.notes = $('#oNotes').value;
    o.file_paths = ($('#oFilePaths').value || '').split('\n').map(l => normalizePath(l)).filter(Boolean);
    o.design_paths = ($('#oDesignPaths').value || '').split('\n').map(l => normalizePath(l)).filter(Boolean);
    o.collab_designer_ids = $$('#modalBox .oCollab').filter(c => c.checked).map(c => c.value);
    // 注意：所有流程时间戳（intake_at / dispatch_at / proposal_at / proposal_failed_at /
    // proposal_pass_at / design_started_at / draft_at / feedback_at / feedback_failed_at /
    // revision_at / redraft_at / finalized_at / switched_at）均不再从表单读取，
    // 仅由流程动作（applyFlowAction）自动写入，防止人为篡改时间顺序与绩效口径。
    // 编辑弹窗只暴露单个标量时间，保存时同步到日志数组，避免产生幽灵的"第N次提案 / 第N稿"
    syncScalarToLog(o, 'proposal_log', 'proposal_at');
    syncScalarToLog(o, 'proposal_failed_log', 'proposal_failed_at');
    syncScalarToLog(o, 'draft_log', 'draft_at');
    syncScalarToLog(o, 'redraft_log', 'redraft_at');
    syncScalarToLog(o, 'revision_log', 'revision_at');
    syncScalarToLog(o, 'feedback_failed_log', 'feedback_failed_at');
  }

  async function ensureCustomerFromModal() {
    const o = state.editingOrder;
    if (o.customer_id !== '__new__') return;
    const name = $('#oNewCName').value.trim();
    if (!name) { toast('请输入新客户名称'); throw new Error('新客户名称必填'); }
    const cust = await DB.saveCustomer({
      name, company: $('#oNewCCompany').value,
      phone: $('#oNewCPhone').value, address: $('#oNewCAddress').value
    });
    o.customer_id = cust.id;
    o.customer_name = cust.name;
  }

  async function saveOrderFromModal() {
    syncFieldsFromModal();
    const o = state.editingOrder;
    try { await ensureCustomerFromModal(); } catch (e) { return; }
    let cust = (state._customers || []).find(c => c.id === o.customer_id);
    o.customer_name = cust ? cust.name : (o.customer_name || '');
    if (!o.title) { toast('请填写标题'); return; }
    try {
      if (o.id) { await DB.saveOrder(o); toast('已保存'); }
      else { const { id, ...rest } = o; await DB.saveOrder(rest); toast('已新建订单'); }
      closeModal(); await refreshAll();
    } catch (e) { toast('保存失败：' + e.message); }
  }

  async function delOrder(id) {
    if (!confirm('确认删除该订单？此操作不可撤销。')) return;
    try { await DB.deleteOrder(id); toast('已删除'); closeModal(); await refreshAll(); }
    catch (e) { toast('删除失败：' + e.message); }
  }

  /* ============================================================
   * 工作台（个人订单卡片视图）
   * ============================================================ */
  function renderWorkbench() {
    const ds = state._designers || [];
    if (!ds.length) {
      fill('#wDesigner', []);
      $('#workbenchStats').innerHTML = '<div class="kpi" style="flex:1"><div class="label">提示</div><div class="value" style="font-size:16px">请先在设置页添加设计师</div></div>';
      $('#workbenchKpis').innerHTML = '';
      $('#workbenchCards').innerHTML = '<div class="empty">暂无设计师</div>';
      return;
    }
    // 数据范围：无 orders_view_all 时，工作台强制只看本人，并锁定下拉
    let viewAll = can('orders_view_all');
    // 工作台只面向参与设计的人；管理员/未开启 active_design 的人员不进入可选列表
    let pickList = ds.filter(d => isActiveDesign(d));
    if (!viewAll && state.currentUser) {
      pickList = ds.filter(d => d.id === state.currentUser.id && isActiveDesign(d));
      if (!pickList.length) pickList = [state.currentUser];
      if (!state.currentDesignerId || !pickList.find(x => x.id === state.currentDesignerId)) state.currentDesignerId = pickList[0].id;
    } else {
      if (!state.currentDesignerId || !pickList.find(x => x.id === state.currentDesignerId)) state.currentDesignerId = pickList[0] ? pickList[0].id : null;
    }
    fill('#wDesigner', pickList.map(d => [d.id, d.name]), state.currentDesignerId);
    const wSel = $('#wDesigner'); if (wSel) wSel.disabled = !viewAll;
    const d = ds.find(x => x.id === state.currentDesignerId);
    const orders = (state._orders || []).filter(o => d && window.Cfg.participants(o).includes(d.id));
    orders.sort((a, b) => {
      const sa = statusOrder(a.status), sb = statusOrder(b.status);
      if (sa !== sb) return sa - sb;
      return (b.intake_at || '').localeCompare(a.intake_at || '');
    });

    // 统计
    const inProgress = orders.filter(o => ['派单', '设计中', '初稿', '客户反馈', '修改中'].includes(o.status));
    const finalized = orders.filter(o => o.status === '已定稿');
    const switched = orders.filter(o => o.status === '已换人');
    $('#workbenchStats').innerHTML =
      '<div class="kpi" style="flex:1"><div class="label">当前设计师</div><div class="value" style="font-size:18px">' + esc(d ? d.name : '未选择') + '</div></div>' +
      '<div class="kpi" style="flex:1"><div class="label">进行中</div><div class="value" style="font-size:18px">' + inProgress.length + '</div></div>' +
      '<div class="kpi" style="flex:1"><div class="label">已定稿</div><div class="value" style="font-size:18px">' + finalized.length + '</div></div>' +
      '<div class="kpi" style="flex:1"><div class="label">已换人</div><div class="value" style="font-size:18px">' + switched.length + '</div></div>';

    // 绩效指标（更多内容）
    const finalizedAny = orders.filter(o => o.status === '已定稿');
    const dispatchCount = orders.length;
    const finalizeRate = dispatchCount ? finalizedAny.length / dispatchCount : 0;
    const proposalDecided = orders.filter(o => o.proposal_pass_at || o.proposal_failed_at);
    const firstPass = proposalDecided.filter(o => (o.proposal_count || 0) <= 1 && !o.proposal_failed_at).length;
    const firstProposalPassRate = proposalDecided.length ? firstPass / proposalDecided.length : 0;
    const draftToFinalize = finalizedAny.filter(o => (o.revision_count || 0) === 0).length;
    const draftToFinalizeRate = finalizedAny.length ? draftToFinalize / finalizedAny.length : 0;
    const designError = finalizedAny.filter(o => o.rework_category === '设计原因').length;
    const reworkRate = finalizedAny.length ? designError / finalizedAny.length : 0;
    let cycSum = 0, cycN = 0;
    finalizedAny.forEach(o => {
      const start = o.dispatch_at || o.intake_at;
      if (start && o.finalized_at) {
        cycSum += (new Date(o.finalized_at).getTime() - new Date(start).getTime()) / 86400000;
        cycN++;
      }
    });
    const avgCycle = cycN ? cycSum / cycN : 0;
    const revenue = orders.filter(o => o.assigned_designer_id === d.id)
      .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);

    const kpi = (label, value, hint) => '<div class="kpi" style="flex:1" title="' + esc(hint) + '"><div class="label">' + esc(label) + '</div><div class="value" style="font-size:18px">' + value + '</div></div>';
    $('#workbenchKpis').innerHTML =
      kpi('派单量', dispatchCount, '参与订单总数') +
      kpi('定稿率', pct(finalizeRate), '已定稿 ÷ 派单量') +
      kpi('一次提案通过率', pct(firstProposalPassRate), '首次提案一次过 ÷ 已决提案') +
      kpi('初稿定稿率', pct(draftToFinalizeRate), '已定稿且零修改 ÷ 已定稿') +
      kpi('平均定稿时间', avgCycle ? avgCycle.toFixed(1) + ' 天' : '—', '派单→定稿平均天数') +
      kpi('设计返工率', pct(reworkRate), '设计责任返工 ÷ 已定稿') +
      kpi('个人营收', '¥' + money(revenue), '主负责订单金额合计');

    if (!orders.length) {
      $('#workbenchCards').innerHTML = '<div class="empty">该设计师暂无订单</div>';
      return;
    }
    $('#workbenchCards').innerHTML = orders.map(o => workbenchCard(o, d)).join('');
    $$('#workbenchCards [data-wb-act]').forEach(b => b.addEventListener('click', () => wbAdvance(b.dataset.wbId, b.dataset.wbAct)));
    $$('#workbenchCards [data-open]').forEach(b => b.addEventListener('click', () => openOrder(b.dataset.open)));
    $$('#workbenchCards [data-openfolder]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openInExplorer(b.dataset.openfolder); }));
    applyPermissions();
  }

  function statusOrder(s) {
    if (s === '已定稿') return 9;
    if (s === '已换人') return 8;
    if (['派单', '设计中', '初稿', '提案', '客户反馈', '修改中'].includes(s)) return 1;
    return 5;
  }

  // 计算截稿状态：返回 { badge, cardClass, footClass } 用于卡片标记与红色预警
  function deadlineInfo(o) {
    const done = (o.status === '已定稿' || o.status === '已换人');
    if (!o.deadline) return { badge: '', cardClass: '', footClass: '' };
    // 是否已提供初稿：有初稿时间戳，或状态已推进到初稿及之后
    const FLOW = window.Cfg.FLOW;
    const draftIdx = FLOW.indexOf('初稿');
    const curIdx = FLOW.indexOf(o.status);
    const hasDraft = !!o.draft_at || (draftIdx >= 0 && curIdx >= draftIdx && o.status !== '设计中');
    const now = Date.now();
    const dl = new Date(o.deadline).getTime();
    if (isNaN(dl)) return { badge: '', cardClass: '', footClass: '' };
    const diff = dl - now; // >0 剩余，<0 超期
    const absMin = Math.abs(Math.round(diff / 60000));
    const d = Math.floor(absMin / 1440), h = Math.floor((absMin % 1440) / 60), m = absMin % 60;
    const span = d > 0 ? (d + ' 天 ' + h + ' 时') : (h > 0 ? (h + ' 时 ' + m + ' 分') : (m + ' 分'));

    if (done) {
      // 已完成：只在超期定稿时给一个中性提示
      if (diff < 0) return { badge: '<span class="wb-dl-badge neutral">⏱ 超期 ' + span + ' 完成</span>', cardClass: '', footClass: '' };
      return { badge: '<span class="wb-dl-badge ok">✓ 按期完成</span>', cardClass: '', footClass: '' };
    }
    if (diff < 0) {
      // 已超截稿
      if (!hasDraft) {
        // 超期且未交初稿 —— 红色整卡预警
        return { badge: '<span class="wb-dl-badge danger">🔴 已超期 ' + span + ' · 未交初稿</span>', cardClass: 'wb-overdue', footClass: '' };
      }
      return { badge: '<span class="wb-dl-badge warn">⚠ 已超期 ' + span + '</span>', cardClass: '', footClass: '' };
    }
    // 未超期倒计时
    let lvl = 'safe';
    if (diff <= 2 * 3600000) lvl = 'danger';       // ≤2 小时：红
    else if (diff <= 24 * 3600000) lvl = 'warn';   // ≤24 小时：橙
    const icon = lvl === 'danger' ? '⏰' : (lvl === 'warn' ? '⏳' : '🕒');
    return { badge: '<span class="wb-dl-badge ' + lvl + '">' + icon + ' 距截稿 ' + span + '</span>', cardClass: lvl === 'danger' ? 'wb-urgent' : '', footClass: '' };
  }

  function workbenchCard(o, designer) {
    const dsMap = Object.fromEntries((state._designers || []).map(d => [d.id, d.name]));
    const isMeMain = o.assigned_designer_id === designer.id;
    const roleTag = isMeMain ? '<span class="card-role main">负责人</span>' : '<span class="card-role collab">协作者</span>';
    const FLOW = window.Cfg.FLOW;
    const curIdx = FLOW.indexOf(o.status);
    const totalSteps = FLOW.length;
    let progress = 0;
    if (o.status === '已定稿') progress = 100;
    else if (o.status === '已换人') progress = 100;
    else if (curIdx >= 0) progress = Math.max(0, Math.min(100, Math.round((curIdx / (totalSteps - 1)) * 100)));
    const nextAction = nextActionText(o.status);
    const timelineSummary = cardTimelineSummary(o);
    const dl = deadlineInfo(o);
    return `
      <div class="wb-card ${dl.cardClass}">
        <div class="wb-head">
          <div class="wb-title">${esc(o.title)} ${roleTag}</div>
          <div class="wb-meta">
            <span>${esc(o.order_no || '')}</span>
            <span class="pill" style="background:${(window.Cfg.STATUS[o.status] || {}).color || '#64748b'}">${esc(o.status)}</span>
          </div>
        </div>
        ${dl.badge ? '<div class="wb-dl-row">' + dl.badge + '</div>' : ''}
        <div class="wb-body">
          <div class="wb-row"><b>客户：</b>${esc(o.customer_name || '—')}</div>
          <div class="wb-row"><b>类型：</b>${esc(o.task_type)} · <b>金额：</b>¥${money(o.amount)} · <b>主负责人：</b>${esc(dsMap[o.assigned_designer_id] || '未派')}</div>
          <div class="wb-progress"><div class="wb-progress-bar ${o.status === '已换人' ? 'switched' : ''}" style="width:${progress}%"></div><span>${progress}%</span></div>
          <div class="wb-timeline">${timelineSummary}</div>
          ${o.file_paths && o.file_paths.length ? '<div class="wb-files">📂 素材：' + o.file_paths.map(p => '<a class="wb-fp" data-openfolder="' + esc(p) + '" title="' + esc(p) + '">' + esc(p.split('/').pop() || p) + '</a>').join(' ') + ' <button class="wb-open-folder" data-openfolder="' + esc(o.file_paths[0]) + '">打开素材文件夹</button></div>' : ''}
          ${(o.design_paths && o.design_paths.length) ? '<div class="wb-design"><span class="wb-design-lbl">🎨 设计稿：</span>' + o.design_paths.map(p => '<a class="wb-fp" data-openfolder="' + esc(p) + '" title="' + esc(p) + '">' + esc(p.split('/').pop() || p) + '</a>').join(' ') + ' <button class="wb-open-folder" data-openfolder="' + esc(o.design_paths[0]) + '">打开设计文件夹</button></div>' : ''}
        </div>
        <div class="wb-foot">
          <span class="wb-deadline">截稿：${fmtTime(o.deadline) || '未设置'}</span>
          <div class="wb-actions">${cardFlowButtons(o)}<button class="btn sm secondary" data-open="${o.id}">详情</button></div>
        </div>
      </div>`;
  }

  // 卡片底部按当前状态直接给出流程推进按钮（无需打开详情）
  function cardFlowButtons(o) {
    const b = (act, label, cls) => '<button class="btn sm ' + (cls || '') + '" data-wb-act="' + act + '" data-wb-id="' + o.id + '">' + label + '</button>';
    switch (o.status) {
      case '接单': return '<span class="wb-hint">等待管理员派单</span>';
      case '派单': return b('proposal', '提交提案', 'primary');
      case '提案': return b('proposal_pass', '提案通过', 'ok') + b('proposal_fail', '不通过', 'warn');
      case '提案不通过': return b('proposal_again', '二次提案', '') + b('switch', '换人', 'danger');
      case '设计中': return b('draft', '提交初稿', 'primary');
      case '初稿': return b('feedback', '客户反馈', 'primary');
      case '客户反馈': return b('finalize', '通过（定稿）', 'ok') + b('revise', '需要修改', 'warn');
      case '修改中': return b('finalize', '客户定稿', 'ok') + b('switch', '换人', 'danger');
      case '已定稿':
      case '已换人': return '<span class="wb-hint">已完成</span>';
      default: return '';
    }
  }

  function nextActionText(status) {
    const map = {
      '接单': '等待派单', '派单': '提交提案', '提案': '等待客户确认', '提案不通过': '继续提案或换人',
      '设计中': '提交初稿', '初稿': '客户反馈', '客户反馈': '定稿或修改', '修改中': '修改完点客户定稿',
      '已定稿': '已完成', '已换人': '已换人'
    };
    return map[status] || status;
  }

  function cardTimelineSummary(o) {
    const items = [
      { n: '接单', t: o.intake_at }, { n: '派单', t: o.dispatch_at },
      { n: '提案', t: o.proposal_at }, { n: '设计中', t: o.design_started_at },
      { n: '初稿', t: o.draft_at }, { n: '客户反馈', t: o.feedback_at },
      { n: '已定稿', t: o.finalized_at }
    ].filter(it => it.t);
    if (!items.length) return '<span style="color:var(--muted)">暂无时间节点</span>';
    const latest = items[items.length - 1];
    return '<span style="color:var(--muted)">最近节点：</span>' + esc(latest.n) + ' ' + fmtTime(latest.t);
  }

  /* ============================================================
   * 设计师 & 分组（管理入口，现位于设置页）
   * ============================================================ */
  async function renderDesignerAdmin() {
    const [ds, gs, orders] = [state._designers || [], state._groups || [], state._orders || []];
    const gMap = Object.fromEntries(gs.map(g => [g.id, g.name]));
    const inProgress = id => orders.filter(o => window.Cfg.participants(o).includes(id) &&
      ['派单', '设计中', '初稿', '客户反馈', '修改中'].includes(o.status)).length;
    $('#settingsDesignersTable').innerHTML =
      '<thead><tr><th>姓名</th><th>职务</th><th>分组</th><th>进行中</th><th>状态</th><th>参与设计</th><th>参与统计</th><th>参与平均</th><th>操作</th></tr></thead><tbody>' +
      (ds.length ? ds.map(d => {
        const isAdmin = d.role === '管理员';
        const designOn = isActiveDesign(d);
        const perfOn = isActivePerf(d);
        const avgOn = isActiveAvg(d);
        const disabled = isAdmin || !can('manage_designers');
        const designTitle = isAdmin ? '管理员默认不参与设计接单' : (can('manage_designers') ? '是否可派单/协作/出现在工作台' : '无权限');
        const perfTitle = isAdmin ? '管理员默认不计入团队统计' : (can('manage_designers') ? '是否计入绩效/经营分析统计' : '无权限');
        const avgTitle = isAdmin ? '管理员默认不计入团队平均' : (can('manage_designers') ? '是否纳入团队人均/排名分母' : '无权限');
        return '<tr><td>' + esc(d.name) + '</td><td>' + esc(d.role) + '</td><td>' + (gMap[d.group_id] || '—') + '</td>' +
        '<td class="num">' + inProgress(d.id) + '</td><td>' + (d.active === false ? '停用' : '在岗') + '</td>' +
        '<td style="text-align:center"><input type="checkbox" class="design-cb" data-design="' + d.id + '"' + (designOn ? ' checked' : '') + (disabled ? ' disabled' : '') + ' title="' + designTitle + '"></td>' +
        '<td style="text-align:center"><input type="checkbox" class="perf-cb" data-perf="' + d.id + '"' + (perfOn ? ' checked' : '') + (disabled ? ' disabled' : '') + ' title="' + perfTitle + '"></td>' +
        '<td style="text-align:center"><input type="checkbox" class="avg-cb" data-avg="' + d.id + '"' + (avgOn ? ' checked' : '') + (disabled ? ' disabled' : '') + ' title="' + avgTitle + '"></td>' +
        '<td><button class="btn sm" data-pw="' + d.id + '">改密码</button> ' +
        '<button class="btn sm danger" data-del="' + d.id + '">删除</button></td></tr>';
      }).join('') : '<tr><td colspan="9" class="empty">暂无人员</td></tr>') + '</tbody>';
    $$('#settingsDesignersTable [data-pw]').forEach(b => b.addEventListener('click', () => setDesignerPassword(b.dataset.pw)));
    $$('#settingsDesignersTable [data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!can('manage_designers')) { toast('无权限'); return; }
      if (!confirm('删除人员？其 Auth 登录账号将被一并注销，订单将变为“未派”。')) return;
      const d = (state._designers || []).find(x => x.id === b.dataset.del);
      if (d && d.auth_id) {
        try { await DB.auth.deleteUser(d.auth_id); } catch (e) { toast((e && e.message) || '注销 Auth 账号失败'); }
      }
      await DB.deleteDesigner(b.dataset.del); toast('已删除'); await refreshAll();
    }));
    $$('#settingsDesignersTable .design-cb').forEach(cb => cb.addEventListener('change', async () => {
      if (!can('manage_designers')) { cb.checked = !cb.checked; toast('无权限'); return; }
      await DB.saveDesigner({ id: cb.dataset.design, active_design: cb.checked });
      state._designers = await DB.listDesigners();
      toast(cb.checked ? '已纳入设计接单范围' : '已移出设计接单范围');
      await refreshAll();
    }));
    $$('#settingsDesignersTable .perf-cb').forEach(cb => cb.addEventListener('change', async () => {
      if (!can('manage_designers')) { cb.checked = !cb.checked; toast('无权限'); return; }
      await DB.saveDesigner({ id: cb.dataset.perf, exclude_perf: !cb.checked });
      state._designers = await DB.listDesigners();
      toast(cb.checked ? '已纳入绩效统计' : '已移出绩效统计');
    }));
    $$('#settingsDesignersTable .avg-cb').forEach(cb => cb.addEventListener('change', async () => {
      if (!can('manage_designers')) { cb.checked = !cb.checked; toast('无权限'); return; }
      await DB.saveDesigner({ id: cb.dataset.avg, active_avg: cb.checked });
      state._designers = await DB.listDesigners();
      toast(cb.checked ? '已纳入团队平均' : '已移出团队平均');
    }));
    $('#settingsGroupsTable').innerHTML =
      '<thead><tr><th>分组</th><th>人数</th><th>操作</th></tr></thead><tbody>' +
      (gs.length ? gs.map(g =>
        '<tr><td>' + esc(g.name) + '</td><td class="num">' + ds.filter(d => d.group_id === g.id).length + '</td>' +
        '<td><button class="btn sm danger" data-gdel="' + g.id + '">删除</button></td></tr>'
      ).join('') : '<tr><td colspan="3" class="empty">暂无分组</td></tr>') + '</tbody>';
    $$('#settingsGroupsTable [data-gdel]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('删除分组？')) return; await DB.deleteGroup(b.dataset.gdel); toast('已删除'); await refreshAll();
    }));
    // 同步分组下拉
    fill('#dGroup', gs.map(g => [g.id, g.name]));
  }
  async function addDesigner() {
    const name = $('#dName').value.trim();
    if (!name) { toast('请输入姓名'); return; }
    if (!can('manage_designers')) { toast('无权限管理设计师'); return; }
    const email = (($('#dEmail') && $('#dEmail').value) || '').trim();
    const pw = (($('#dAuthPw') && $('#dAuthPw').value) || '').trim();
    if (!email) { toast('请输入登录邮箱'); return; }
    if (pw.length < 6) { toast('Auth 登录密码至少 6 位'); return; }
    let authId = null;
    try {
      const r = await DB.auth.createUser({ email, password: pw, name });
      authId = r.id;
    } catch (e) { toast((e && e.message) || '创建 Auth 账号失败'); return; }
    const row = { name, email, auth_id: authId, role: $('#dRole').value, group_id: $('#dGroup').value || null };
    if ($('#dDesign')) row.active_design = !!($('#dDesign').checked);
    if ($('#dPerf')) row.exclude_perf = !$('#dPerf').checked;
    if ($('#dAvg')) row.active_avg = !!($('#dAvg').checked);
    await DB.saveDesigner(row);
    $('#dName').value = ''; if ($('#dEmail')) $('#dEmail').value = ''; if ($('#dAuthPw')) $('#dAuthPw').value = '';
    toast('已添加（Auth 账号已创建）'); await refreshAll();
  }
  async function addGroup() {
    const name = $('#gName').value.trim();
    if (!name) { toast('请输入分组名'); return; }
    await DB.saveGroup({ name }); $('#gName').value = ''; toast('已添加'); await refreshAll();
  }
  // 为指定设计师设置/修改登录密码（自定义弹窗）
  function setDesignerPassword(id) {
    const d = (state._designers || []).find(x => x.id === id);
    if (!d) return;
    if (!can('manage_designers')) { toast('无权限'); return; }
    const html = `
      <button class="close" data-close>×</button>
      <h3>修改密码 · ${esc(d.name)}</h3>
      <div class="field"><label>新密码（至少 4 位）</label><input type="password" id="pwNew" autocomplete="new-password" /></div>
      <div class="field"><label>确认密码</label><input type="password" id="pwConfirm" autocomplete="new-password" /></div>
      <div class="login-err" id="pwErr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn secondary" data-close>取消</button>
        <button class="btn" id="pwSave">保存</button>
      </div>`;
    openModal(html);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', closeModal));
    $('#pwSave').addEventListener('click', async () => {
      const a = $('#pwNew').value || '', b = $('#pwConfirm').value || '';
      if (a.length < 6) { $('#pwErr').textContent = '密码至少 6 位'; return; }
      if (a !== b) { $('#pwErr').textContent = '两次输入不一致'; return; }
      if (!d.auth_id) { $('#pwErr').textContent = '该账号尚未绑定 Auth，请让其在登录页用「忘记密码」设置密码'; return; }
      try {
        await DB.auth.setPassword({ auth_id: d.auth_id, password: a });
      } catch (e) { $('#pwErr').textContent = (e && e.message) || '更新失败'; return; }
      closeModal(); toast('密码已更新'); await refreshAll();
    });
  }

  /* ---------- 权限配置（管理员） ---------- */
  function renderPermConfig() {
    const box = $('#permConfigBox');
    if (!box) return;
    if (!can('manage_permissions')) { box.innerHTML = '<div class="empty">当前账号无权限配置权限</div>'; return; }
    const cfg = permConfig();
    const roles = window.Cfg.ROLES;
    const groups = window.Cfg.PERM_GROUPS;
    const perms = window.Cfg.PERMISSIONS;
    // 当前各职务默认值（来自 cfg）
    const valOf = (role, key) => {
      const ov = cfg.overrides && cfg.overrides[state.currentUser.id];
      if (ov && typeof ov[key] === 'boolean') return ov[key];
      return !!(cfg.roleDefaults[role] && cfg.roleDefaults[role][key]);
    };
    let html = '<div class="perm-matrix">';
    html += '<div class="perm-notice" style="margin-bottom:12px;color:var(--muted);font-size:13px">管理员默认拥有全部权限，下表中管理员列仅作展示，不可取消。</div>';
    groups.forEach(g => {
      const items = perms.filter(p => p.group === g.id);
      if (!items.length) return;
      html += '<div class="perm-group"><div class="perm-group-title">' + esc(g.label) + '</div><table class="tbl perm-tbl"><thead><tr><th>权限项</th>' +
        roles.map(r => '<th>' + esc(r) + '</th>').join('') + '</tr></thead><tbody>' +
        items.map(p => '<tr><td>' + esc(p.label) + '</td>' +
          roles.map(r => {
            const isAdmin = r === '管理员';
            return '<td style="text-align:center"><input type="checkbox" class="perm-cb" data-role="' + esc(r) + '" data-key="' + p.key + '"' + (valOf(r, p.key) ? ' checked' : '') + (isAdmin ? ' disabled title="管理员始终拥有该权限"' : '') + '></td>';
          }).join('') +
        '</tr>').join('') + '</tbody></table></div>';
    });
    html += '</div>';
    // 个人覆盖
    const ds = state._designers || [];
    const sel = '<select id="permOverrideSel"><option value="">— 选择设计师做个性化覆盖 —</option>' +
      ds.map(d => '<option value="' + d.id + '">' + esc(d.name) + '（' + esc(d.role) + '）</option>').join('') + '</select>';
    html += '<div class="perm-override"><div class="perm-group-title">按设计师个性化覆盖</div>' +
      '<div class="row" style="align-items:flex-end;gap:8px;margin-bottom:8px">' + sel +
      '<button class="btn secondary" id="permOverrideLoad">载入</button>' +
      '<button class="btn danger" id="permOverrideClear" style="display:none">清除该人覆盖</button></div>' +
      '<div id="permOverrideBox"></div></div>';
    html += '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="permSave">保存权限配置</button></div>';
    box.innerHTML = html;

    // 保存（职务默认 + 可选的个性化覆盖，一次提交）
    $('#permSave').addEventListener('click', async () => {
      const roleDefaults = JSON.parse(JSON.stringify(cfg.roleDefaults));
      $$('#permConfigBox .perm-cb').forEach(cb => {
        const r = cb.dataset.role, k = cb.dataset.key;
        roleDefaults[r] = roleDefaults[r] || {};
        roleDefaults[r][k] = cb.checked;
      });
      const overrides = Object.assign({}, cfg.overrides);
      const oid = $('#permOverrideSel').value;
      if (oid) {
        const ov = {};
        $$('#permOverrideBox .perm-ov-cb').forEach(cb => { ov[cb.dataset.key] = cb.checked; });
        overrides[oid] = ov;
      }
      const newCfg = Object.assign({}, cfg, { roleDefaults, overrides });
      await DB.saveSettings({ permissions: newCfg });
      await refreshAll();
      toast('权限配置已保存');
    });
    // 个人覆盖载入
    const loadOverride = () => {
      const id = $('#permOverrideSel').value;
      const ob = $('#permOverrideBox');
      $('#permOverrideClear').style.display = id ? '' : 'none';
      if (!id) { ob.innerHTML = ''; return; }
      const ov = (cfg.overrides && cfg.overrides[id]) || {};
      const d = ds.find(x => x.id === id);
      ob.innerHTML = '<table class="tbl perm-tbl"><thead><tr><th>权限项</th><th>允许（覆盖职务默认）</th></tr></thead><tbody>' +
        perms.map(p => {
          const checked = typeof ov[p.key] === 'boolean' ? ov[p.key] : (cfg.roleDefaults[d.role] && cfg.roleDefaults[d.role][p.key]);
          return '<tr><td>' + esc(p.label) + '</td><td style="text-align:center"><input type="checkbox" class="perm-ov-cb" data-key="' + p.key + '"' + (checked ? ' checked' : '') + '></td></tr>';
        }).join('') + '</tbody></table>';
    };
    $('#permOverrideLoad').addEventListener('click', loadOverride);
    $('#permOverrideClear').addEventListener('click', async () => {
      const id = $('#permOverrideSel').value; if (!id) return;
      const overrides = Object.assign({}, cfg.overrides); delete overrides[id];
      await DB.saveSettings({ permissions: Object.assign({}, cfg, { overrides }) });
      await refreshAll(); toast('已清除该设计师的个性化覆盖');
    });
  }

  /* ============================================================
   * 客户
   * ============================================================ */
  async function renderCustomers() {
    const [cs, orders] = [state._customers || [], state._orders || []];
    $('#customersTable').innerHTML =
      '<thead><tr><th>客户</th><th>联系人</th><th>电话</th><th>标注</th><th>累计金额</th><th>订单数</th><th>类型</th><th>操作</th></tr></thead><tbody>' +
      (cs.length ? cs.map(c => {
        const co = orders.filter(o => o.customer_id === c.id);
        const amt = co.reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const repeat = co.length >= 2;
        return '<tr style="cursor:pointer" data-cid="' + c.id + '">' +
          '<td>' + esc(c.name) + (repeat ? ' <span class="repeat-tag">复购</span>' : '') + '</td>' +
          '<td>' + esc(c.company || '—') + '</td><td>' + esc(c.phone || '—') + '</td>' +
          '<td>' + (c.tag ? '<span class="cust-pill tag">🏷 ' + esc(c.tag) + '</span>' : '—') + '</td>' +
          '<td class="num">¥' + money(amt) + '</td><td class="num">' + co.length + '</td>' +
          '<td>' + (repeat ? '复购' : '新客') + '</td>' +
          '<td><button class="btn sm" data-view="' + c.id + '">详情</button> ' +
          '<button class="btn sm danger" data-cdel="' + c.id + '" data-perm="customers_edit">删除</button></td></tr>';
      }).join('') : '<tr><td colspan="8" class="empty">暂无客户，点击“新建客户”</td></tr>') + '</tbody>';
    $$('#customersTable [data-view]').forEach(b => b.addEventListener('click', () => viewCustomer(b.dataset.view)));
    $$('#customersTable [data-cdel]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation(); if (!can('customers_edit')) { toast('无权限'); return; }
      if (!confirm('删除客户？')) return; await DB.deleteCustomer(b.dataset.cdel); toast('已删除'); await refreshAll();
    }));
    $$('#customersTable tr[data-cid]').forEach(tr => tr.addEventListener('click', () => viewCustomer(tr.dataset.cid)));
    applyPermissions();
  }
  function newCustomer() { openCustomerModal(null); }
  // 新建/编辑客户共用：传入已有客户对象即进入编辑模式，保存时级联更新其历史订单的客户名
  function openCustomerModal(existing) {
    const c = existing || {};
    openModal(`<button class="close" data-close>×</button><h3>${existing ? '编辑客户' : '新建客户'}</h3>
      <div class="grid2">
        <div class="field"><label>客户名称</label><input id="cName" value="${esc(c.name || '')}" placeholder="如：XX公司"></div>
        <div class="field"><label>联系人</label><input id="cCompany" value="${esc(c.company || '')}" placeholder="联系人姓名"></div>
        <div class="field"><label>电话</label><input id="cPhone" value="${esc(c.phone || '')}"></div>
        <div class="field"><label>地址</label><input id="cAddress" value="${esc(c.address || '')}"></div>
        <div class="field"><label>文字标注</label><input id="cTag" value="${esc(c.tag || '')}" placeholder="如：重点客户 / 价格敏感 / 急单优先"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>备注</label><textarea id="cNotes" rows="2">${esc(c.notes || '')}</textarea></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn secondary" data-close>取消</button>
        <button class="btn" id="cSave">保存</button>
      </div>`);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', closeModal));
    $('#cSave').addEventListener('click', async () => {
      const name = $('#cName').value.trim(); if (!name) { toast('请输入名称'); return; }
      await DB.saveCustomer({
        id: c.id || undefined,
        name, company: $('#cCompany').value, phone: $('#cPhone').value, address: $('#cAddress').value, notes: $('#cNotes').value
      });
      toast(existing ? '已更新客户（历史订单客户名已同步）' : '已添加客户');
      closeModal(); await refreshAll();
    });
  }
  async function viewCustomer(id) {
    const c = (state._customers || []).find(x => x.id === id); if (!c) return;
    const orders = (state._orders || []).filter(o => o.customer_id === id);
    const amt = orders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const repeat = orders.length >= 2;
    const html = `<button class="close" data-close>×</button><h3>${esc(c.name)} ${repeat ? '<span class="repeat-tag">复购客户</span>' : ''}</h3>
      <div class="grid2">
        <div><b>联系人：</b>${esc(c.company || '—')}</div><div><b>电话：</b>${esc(c.phone || '—')}</div>
        <div><b>地址：</b>${esc(c.address || '—')}</div><div><b>文字标注：</b>${esc(c.tag || '—')}</div>
      </div>
      <p style="color:var(--muted)">${esc(c.notes || '')}</p>
      <h3>历史订单（${orders.length}）</h3>
      <div class="table-scroll"><table class="tbl"><thead><tr><th>单号</th><th>标题</th><th>金额</th><th>状态</th><th>接单</th></tr></thead><tbody>` +
      (orders.length ? orders.slice().sort((a, b) => (a.intake_at || '').localeCompare(b.intake_at || '')).map(o =>
        '<tr><td>' + esc(o.order_no) + '</td><td>' + esc(o.title) + '</td><td class="num">¥' + money(o.amount) + '</td><td>' + pill(o.status) + '</td><td>' + fmtTime(o.intake_at) + '</td></tr>'
      ).join('') : '<tr><td colspan="5" class="empty">暂无订单</td></tr>') + '</tbody></table></div>' +
      '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="cEdit">编辑</button><button class="btn secondary" data-close>关闭</button></div>';
    openModal(html);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', closeModal));
    const cEdit = $('#cEdit'); if (cEdit) cEdit.addEventListener('click', () => { closeModal(); openCustomerModal(c); });
  }

  /* ============================================================
   * 经营分析导出（含绩效工资列）
   * ============================================================ */
  async function exportAnaCSV() {
    if (!state._ana) await renderAnalytics();
    const rep = state._ana;
    const head = ['设计师', '角色', '派单量', '定稿率', '一次提案通过率', '初稿定稿率', '平均定稿时间(天)', '设计返工率', '定稿数', '完成率', '当前在制', '峰值并发', '小单有效', '营收', '系数', '小单提成', '小单扣减', '总绩效'];
    const rows = rep.rows.map(r => [
      r.designerName, r.role, r.dispatchCount, pct(r.finalizeRate), pct(r.firstProposalPassRate),
      pct(r.draftToFinalizeRate), r.avgCycle ? r.avgCycle.toFixed(1) : '—', pct(r.reworkRate),
      r.finalizedCount, pct(r.completion), r.currentLoad, r.peakLoad, r.smallCount, money(r.revenue),
      r.coef != null ? r.coef : '', money(r.smallBonus || 0), money(r.smallDeduction || 0), money(r.totalPerf != null ? r.totalPerf : 0)
    ]);
    const t = rep.totals;
    rows.push(['团队汇总', '', '', '', '', '', '', '', '', '', '', '', '人均小单=' + t.teamAvgSmall, '营收=' + money(t.teamRevenue), '', '团队奖=' + money(t.teamAward), '', '绩效合计=' + money(t.totalPerfSum)]);
    const fn = '经营分析_' + rep.range.start.toISOString().slice(0, 10) + '_' + rep.range.end.toISOString().slice(0, 10) + '.csv';
    downloadAOA([head].concat(rows), fn);
    toast('已导出 CSV（含绩效工资）');
  }
  function downloadAOA(aoa, filename) {
    const csv = '﻿' + aoa.map(r => r.map(c => { const s = String(c ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  async function exportOrdersCSV() {
    const orders = await DB.listOrders(state.filters || {});
    const mode = await window.Exporter.ordersCSV(orders, state._designers || [], state._settings, '订单列表_' + Date.now() + '.csv');
    toast(mode === 'excel' ? '已导出 Excel' : '已导出 CSV');
  }

  /* ============================================================
   * 设置
   * ============================================================ */
  async function renderSettings() {
    const s = state._settings || await DB.getSettings();
    $('#sUrl').value = s.supabaseUrl || ''; $('#sKey').value = s.supabaseAnonKey || '';
    // 部署级固定凭据：检测到 config.js 预置则锁定输入框，避免被界面误改
    const presetUrl = (window.Cfg.SUPABASE_URL || '').trim();
    const presetKey = (window.Cfg.SUPABASE_ANON_KEY || '').trim();
    const presetActive = !!(presetUrl && presetKey);
    const fixedHint = $('#cloudFixedHint');
    $('#sUrl').disabled = presetActive; $('#sKey').disabled = presetActive;
    $('#btnSaveSupabase').disabled = presetActive; $('#btnTestSupabase').disabled = presetActive;
    if (fixedHint) fixedHint.style.display = presetActive ? '' : 'none';
    $('#sSmallMax').value = s.small_order_max; $('#sLargeMin').value = s.large_order_min;
    $('#sBase').value = s.base_perf_salary; $('#sTa1').value = s.team_award_t1; $('#sAa1').value = s.team_award_a1;
    $('#sTa2').value = s.team_award_t2; $('#sAa2').value = s.team_award_a2;
    $('#sTarget').value = s.small_order_target;
    await renderDesignerAdmin();
    renderPermConfig();
    applyPermissions();
    updateConnStatus();
  }
  // 设置页连接状态面板
  function updateConnStatus() {
    const el = $('#connStatus'); if (!el) return;
    const libOk = !!(window.supabase && window.supabase.createClient);
    const s = state._settings || {};
    const hasCred = !!(s.supabaseUrl && s.supabaseAnonKey);
    const mode = DB.getMode();
    const rows = [
      ['Supabase 库', libOk ? '✅ 已加载' : '⚠️ 未加载（自动重试备用 CDN）'],
      ['凭据配置', hasCred ? '✅ 已填写' : '⚠️ 未填写'],
      ['当前模式', mode === 'supabase' ? '☁ 云端同步' : '💾 本地模式'],
      ['上次同步', fmtTime(DB.getLastSync())]
    ];
    let html = rows.map(r => '<div class="kv"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('');
    if (s._schemaError) {
      html += '<div class="kv" style="margin-top:8px;padding:8px;background:#fef2f2;border-radius:8px"><span style="color:#b91c1c">⚠️ ' + esc(s._schemaError) + '</span></div>';
    }
    if (s._cloudError) {
      html += '<div class="kv" style="margin-top:8px;padding:8px;background:#fef2f2;border-radius:8px"><span style="color:#b91c1c">⚠️ ' + esc(s._cloudError) + '</span></div>';
    }
    el.innerHTML = html;
  }
  async function saveSupabase() {
    // 部署级固定凭据时，界面不可修改
    if ((window.Cfg.SUPABASE_URL || '').trim() && (window.Cfg.SUPABASE_ANON_KEY || '').trim()) {
      toast('云端凭据已由部署配置（config.js）固定，无法在界面修改');
      return;
    }
    const url = window.Cfg.normUrl($('#sUrl').value), key = $('#sKey').value.trim();
    if (!url || !key) { toast('请先填写 URL 与 Key'); return; }
    $('#sUrl').value = url; // 回写归一化后的 URL（去末尾斜杠）
    await DB.saveSettings({ supabaseUrl: url, supabaseAnonKey: key });
    toast('已保存，正在重新连接…');
    // 重新初始化连接（会自动从备用 CDN 补加载 Supabase 库）
    await DB.init();
    await refreshAll(); updateSync(); updateConnStatus();
    toast(DB.getMode() === 'supabase'
      ? '☁ 已连接云端（刷新页面也会自动重连）'
      : '仍使用本地模式（URL/Key 错误或网络异常）');
  }
  async function testSupabase() {
    const url = window.Cfg.normUrl($('#sUrl').value), key = $('#sKey').value.trim();
    if (!url || !key) { toast('请先填写 URL 与 Key'); return; }
    try {
      const tmp = window.supabase.createClient(url, key);
      const { error } = await tmp.from('designers').select('count').limit(1);
      if (error) toast('连接失败：' + error.message); else toast('连接成功 ✅');
    } catch (e) { toast('连接异常：' + e.message); }
  }
  async function saveParams() {
    const num = (id) => Number($(id).value) || 0;
    await DB.saveSettings({
      small_order_max: num('#sSmallMax'), large_order_min: num('#sLargeMin'),
      base_perf_salary: num('#sBase'), team_award_t1: num('#sTa1'), team_award_a1: num('#sAa1'),
      team_award_t2: num('#sTa2'), team_award_a2: num('#sAa2'),
      small_order_target: num('#sTarget') || 3
    });
    toast('参数已保存'); await refreshAll();
  }
  function exportAll() {
    const data = { designers: state._designers, groups: state._groups, customers: state._customers, orders: state._orders, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '设计部数据备份.json';
    document.body.appendChild(a); a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    toast('已导出全部数据(JSON)');
  }

  /* ============================================================
   * 经营分析（需求 1~10）
   * ============================================================ */
  async function renderAnalytics() {
    const mode = $('#anaMode').value;
    let opts = { mode: 'window' };
    if (mode === 'custom') {
      const start = $('#anaStart').value, end = $('#anaEnd').value;
      if (!start || !end) { toast('请选择起止日期'); return; }
      opts = { mode: 'custom', start, end };
    }
    const scope = can('analytics_view_all') ? null : (state.currentUser && state.currentUser.id);
    const rep = await window.Calc.analytics(opts, scope);
    state._ana = rep;
    const win = rep.range, t = rep.totals, sm = rep.small;
    $('#anaWindow').textContent = '范围：' + fmtTime(win.start).slice(0, 10) + ' ~ ' + fmtTime(win.end).slice(0, 10);

    const finalizeRateTeam = t.dispatchOrders ? t.finalizedCount / t.dispatchOrders : 0;
    const kpis = [
      ['总接单量', t.intakeCount, '范围内接单总数'],
      ['规定时间总营收', '¥' + money(t.revenue), '范围内全部单子'],
      ['客户投诉笔数', t.complaints, '范围内投诉合计'],
      ['派单订单数', t.dispatchOrders, '范围内派发（唯一单）'],
      ['平均定稿时间', (t.avgCycleTeam ? t.avgCycleTeam.toFixed(1) : '—') + ' 天', '派单→定稿均值'],
      ['提案通过率', pct(t.proposalPassRate), '提案通过 ÷ 已决提案'],
      ['一次提案通过率', pct(t.firstProposalPassRate), '首次提案一次过 ÷ 已决提案'],
      ['初稿定稿率', pct(t.draftToFinalizeRate), '已定稿且修改 0 次'],
      ['定稿率', pct(finalizeRateTeam), '定稿 ÷ 派单总数'],
      ['设计返工率', pct(t.reworkRate), '设计责任返工 ÷ 已定稿'],
      ['当前在制', t.currentInProgress, '全组实时未结案'],
      ['峰值并发(单人最高)', t.peakConcurrency, '范围内单人同时最多'],
      ['小单达标', sm.smallOkCount + '/' + sm.designerCount + ' 人', '≥' + sm.target + '单/人 · 人均' + sm.avgSmallTeam],
      ['团队奖', '¥' + money(t.teamAward), '范围内全组营收达门槛发放'],
      ['绩效合计', '¥' + money(t.totalPerfSum), '全员工资口径合计（系数+小单提成−扣减）']
    ];
    $('#kpiAna').innerHTML = kpis.map(k =>
      '<div class="kpi"><div class="label">' + k[0] + '</div><div class="value">' + k[1] + '</div><div class="label">' + k[2] + '</div></div>'
    ).join('');

    const rows = rep.rows;
    const names = rows.map(r => r.designerName);
    Charts.bar($('#chartDispatch'), {
      title: '每位设计师派单量（含协同，各计 1 单）', horizontal: true,
      labels: names,
      datasets: [{ label: '派单量', data: rows.map(r => r.dispatchCount), color: '#4f46e5' }]
    });
    Charts.bar($('#chartConcurrency'), {
      title: '并发：当前在制 vs 窗口峰值', horizontal: true,
      labels: names,
      datasets: [
        { label: '当前在制', data: rows.map(r => r.currentLoad), color: '#0ea5e9' },
        { label: '窗口峰值', data: rows.map(r => r.peakLoad), color: '#ef4444' }
      ]
    });
    Charts.bar($('#chartPass'), {
      title: '提案通过率 / 一次提案通过率 / 初稿定稿率(%)', horizontal: false,
      labels: names,
      datasets: [
        { label: '提案通过率(%)', data: rows.map(r => Math.round(r.proposalPassRate * 1000) / 10), color: '#22c55e' },
        { label: '一次提案通过率(%)', data: rows.map(r => Math.round(r.firstProposalPassRate * 1000) / 10), color: '#8b5cf6' },
        { label: '初稿定稿率(%)', data: rows.map(r => Math.round(r.draftToFinalizeRate * 1000) / 10), color: '#f59e0b' }
      ]
    });
    Charts.bar($('#chartRework'), {
      title: '设计返工率(%)（设计责任 ÷ 已定稿）', horizontal: false,
      labels: names,
      datasets: [{ label: '设计返工率(%)', data: rows.map(r => Math.round(r.reworkRate * 1000) / 10), color: '#f59e0b' }]
    });

    // 设计师明细表（运营指标 + 工资核算，与绩效月报同源）
    $('#anaTable').innerHTML =
      '<thead><tr><th>设计师</th><th>角色</th><th>派单量</th><th>定稿率</th><th>一次提案通过率</th><th>初稿定稿率</th><th>平均定稿时间(天)</th><th>设计返工率</th><th>定稿数</th><th>完成率</th><th>小单(达标)</th><th>营收</th><th>系数</th><th>小单提成</th><th>小单扣减</th><th>总绩效</th></tr></thead><tbody>' +
      (rows.length ? rows.map(r =>
        '<tr><td>' + esc(r.designerName) + '</td><td>' + esc(r.role) + '</td><td>' + r.dispatchCount + '</td>' +
        '<td>' + pct(r.finalizeRate) + '</td><td>' + pct(r.firstProposalPassRate) + '</td><td>' + pct(r.draftToFinalizeRate) + '</td><td>' + (r.avgCycle ? r.avgCycle.toFixed(1) : '—') + '</td><td>' + pct(r.reworkRate) + '</td>' +
        '<td>' + r.finalizedCount + '</td><td>' + pct(r.completion) + '</td>' +
        '<td>' + r.smallCount + ' <span class="badge ' + (r.smallOk ? 'ok' : 'bad') + '">' + (r.smallOk ? '达标' : '未达标') + '</span></td>' +
        '<td class="num">¥' + money(r.revenue) + '</td>' +
        '<td><b>' + (r.coef != null ? r.coef : '—') + '</b></td>' +
        '<td class="num">¥' + money(r.smallBonus || 0) + '</td>' +
        '<td class="num">¥' + money(r.smallDeduction || 0) + '</td>' +
        '<td class="num"><b>¥' + money(r.totalPerf != null ? r.totalPerf : 0) + '</b></td></tr>'
      ).join('') : '<tr><td colspan="16" class="empty">暂无设计师或数据</td></tr>') + '</tbody>';

    renderAnaGantt(rep);
    renderAnaProjects(rep);
    await renderConcurrencyDaily();
    // 系数阶梯说明（与绩效月报同源）
    const s0 = state._settings || {};
    $('#anaCoef').innerHTML = '<b>绩效系数阶梯（按定稿率）：</b><br>' +
      '定稿率 &lt;65% → 0.8 ｜ 65%~70% → 0.9 ｜ 70%~75% → 1.0 ｜ 75%~80% → 1.1 ｜ 80%~85% → 1.2 ｜ 85%~90% → 1.3 ｜ ≥90% → 1.4<br>' +
      '<span style="color:var(--muted)">总绩效 = 基础绩效工资（' + money(Number(s0.base_perf_salary) || 0) + '）× 系数 + 小单提成 − 小单扣减。' +
      '小单提成：窗口内有效小单 &gt;10单按30元/单，&gt;5单按20元/单；低于人均小单数每少1单扣20元。定稿判定：修改≥2次不计入定稿。</span>';
    applyPermissions();
  }

  // 并发甘特图（HTML/CSS，直观展示同一设计师同步推进的单子）
  function renderAnaGantt(rep) {
    const range = rep.range;
    const rStart = range.start.getTime(), rEnd = range.end.getTime();
    let span = rEnd - rStart; if (span <= 0) span = 86400000;
    const mid = new Date(rStart + span / 2);
    let html = '<div class="gantt">' +
      '<div class="g-axis"><span>' + fmtTime(range.start).slice(0, 10) + '</span>' +
      '<span>' + fmtTime(mid).slice(0, 10) + '</span>' +
      '<span>' + fmtTime(range.end).slice(0, 10) + '</span></div>';
    rep.rows.forEach(r => {
      const orders = rep.perOrder.filter(o => o.participantIds.includes(r.designerId));
      html += '<div class="g-row"><div class="g-label">' + esc(r.designerName) + '<i>在制' + r.currentLoad + '/峰' + r.peakLoad + '</i></div><div class="g-track">';
      orders.forEach(o => {
        const s = o.dispatch_at ? new Date(o.dispatch_at).getTime() : rStart;
        const e = o.finalized_at ? new Date(o.finalized_at).getTime()
          : (o.switched_at ? new Date(o.switched_at).getTime() : Math.min(rEnd, Date.now()));
        const ss = Math.max(s, rStart), ee = Math.min(e, rEnd);
        if (ee <= ss) return;
        const left = (ss - rStart) / span * 100;
        const w = (ee - ss) / span * 100;
        const color = (window.Cfg.STATUS[o.status] || {}).color || '#94a3b8';
        const title = esc(o.order_no + ' ' + o.title + '｜' + o.participantNames.join('/') + '｜' + o.status +
          (o.revision_count ? ('｜改' + o.revision_count) : '') + (o.complaint_count ? ('｜投诉' + o.complaint_count) : ''));
        html += '<div class="g-bar" style="left:' + left.toFixed(2) + '%;width:' + Math.max(w, 1.5).toFixed(2) + '%;background:' + color + '" title="' + title + '"></div>';
      });
      html += '</div></div>';
    });
    html += '</div>';
    $('#anaGantt').innerHTML = html;
  }

  // 项目改稿 / 返工 / 投诉明细
  function renderAnaProjects(rep) {
    const list = rep.perOrder.slice().sort((a, b) => (b.revision_count - a.revision_count));
    $('#anaProjects').innerHTML =
      '<thead><tr><th>单号</th><th>标题</th><th>客户</th><th>参与设计师</th><th>状态</th><th>改稿次数</th><th>返工原因</th><th>投诉</th><th>周期(天)</th><th>金额</th></tr></thead><tbody>' +
      (list.length ? list.map(o =>
        '<tr><td>' + esc(o.order_no) + '</td><td>' + esc(o.title) + '</td><td>' + esc(o.customer_name || '') + '</td>' +
        '<td>' + esc(o.participantNames.join(' / ')) + '</td><td>' + pill(o.status) + '</td><td class="num">' + o.revision_count + '</td>' +
        '<td>' + (o.rework_category ? '<span class="badge ' + (o.rework_category === '设计原因' ? 'bad' : 'warn') + '">' + o.rework_category + '</span>' : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td class="num">' + (o.complaint_count ? '<span class="badge bad">' + o.complaint_count + '</span>' : '0') + '</td>' +
        '<td class="num">' + (o.cycleDays != null ? o.cycleDays.toFixed(1) : '—') + '</td>' +
        '<td class="num">¥' + money(o.amount) + '</td></tr>'
      ).join('') : '<tr><td colspan="10" class="empty">范围内暂无订单</td></tr>') + '</tbody>';
  }

  // 设计师每日未完工并发曲线（按所选月份）
  const CONCURRENCY_PALETTE = ['#4f46e5', '#0ea5e9', '#22c55e', '#f59e0b',
    '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#64748b', '#a855f7'];
  async function renderConcurrencyDaily() {
    const elMonth = $('#anaMonth');
    if (!elMonth.value) {
      const n = new Date();
      elMonth.value = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
    }
    const [y, m] = elMonth.value.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const monthEndMs = new Date(y, m, 0, 23, 59, 59, 999).getTime();
    const now = Date.now();

    const [designers, ordersAll] = await Promise.all([
      window.DB.listDesigners(), window.DB.listOrders()
    ]);
    const scope = can('analytics_view_all') ? null : (state.currentUser && state.currentUser.id);
    const designersActive = designers.filter(d => d.active !== false && isActiveDesign(d) && (!scope || d.id === scope));

    const labels = [];
    for (let d = 1; d <= daysInMonth; d++) labels.push(d);

    const datasets = designersActive.map((des, idx) => {
      const data = new Array(daysInMonth).fill(0);
      ordersAll.forEach(o => {
        if (!window.Cfg.participants(o).includes(des.id)) return;
        let s = o.dispatch_at ? new Date(o.dispatch_at).getTime()
          : (o.intake_at ? new Date(o.intake_at).getTime() : null);
        if (s == null) return;
        let e = o.finalized_at ? new Date(o.finalized_at).getTime()
          : (o.switched_at ? new Date(o.switched_at).getTime() : null);
        if (e == null) e = Math.min(now, monthEndMs); // 仍未结案 → 视为进行到“现在/月末”
        for (let d = 1; d <= daysInMonth; d++) {
          const dayEnd = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
          const open = e > dayEnd; // 该日结束仍未完工
          if (s <= dayEnd && open) data[d - 1]++;
        }
      });
      return { label: des.name, data, color: CONCURRENCY_PALETTE[idx % CONCURRENCY_PALETTE.length] };
    });

    Charts.line($('#chartConcurrencyDaily'), {
      title: y + '年' + m + '月 · 每日未完工并发数',
      labels,
      datasets
    });
  }

  /* ---------- 启动 ---------- */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
