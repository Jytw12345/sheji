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
    _subscribed: false,
    orderPage: 1,
    customerPage: 1,
    customerPageSize: null,       // 客户页每页条数（可自定义，存 localStorage）
    orderPageSize: null,          // 订单页每页条数（可自定义，存 localStorage）
    customerFilter: { q: '', type: 'all' },
    customerSort: { key: 'name', dir: 'asc' }, // 客户列表列排序
    sortDir: 'desc',
    orderSort: { key: 'intake_at', dir: 'desc' }, // 订单列表列排序
    _ordersDefaulted: false,
    _overdueOnly: false,   // 订单列表：仅显示截稿逾期
    _dueTodayOnly: false,  // 订单列表：仅显示今日截稿
    autoHideFinalized: true,   // 工作台：定稿满1天自动隐藏已完成卡片
    wbView: 'personal',        // 工作台视图：personal（个人）/ team（团队看板）
    dashboardPeriod: 'current', // 仪表盘考核窗口：current / previous
    anaMode: 'current',         // 经营分析统计方式：current / previous / custom
    _riskMap: null,             // 逾期风险缓存（数据刷新后失效）
    _riskOnly: false            // 订单列表：仅显示红色风险单
  };
  const ORDER_PAGE_SIZE = 50;
  const CUSTOMER_PAGE_SIZE = 50;
  const ARCHIVE_AFTER_HOURS = 24;  // 定稿满 24 小时后在工作台默认隐藏

  // 客户页每页条数：默认 CUSTOMER_PAGE_SIZE，用户可在页面下拉框自定义，存 localStorage
  state.customerPageSize = parseInt(localStorage.getItem('ds_cust_pagesize'), 10) || CUSTOMER_PAGE_SIZE;
  // 订单页每页条数：默认 ORDER_PAGE_SIZE，用户可在页面下拉框自定义，存 localStorage
  state.orderPageSize = parseInt(localStorage.getItem('ds_order_pagesize'), 10) || ORDER_PAGE_SIZE;
  // 客户列表排序方式记忆
  try {
    const savedCustSort = localStorage.getItem('ds_cust_sort');
    if (savedCustSort) state.customerSort = JSON.parse(savedCustSort);
  } catch (e) {}

  /* ---------- 防重复操作 ---------- */
  // 同一 key 同时只允许一个进行中；重复触发直接忽略，彻底杜绝"保存两次/重复提交"。
  const _opLocks = Object.create(null);
  function lockOp(key) { if (_opLocks[key]) return false; _opLocks[key] = true; return true; }
  function unlockOp(key) { delete _opLocks[key]; }

  /* ---------- 工具 ---------- */
  function fmtTime(t) {
    if (!t) return '—';
    const d = new Date(t); if (isNaN(d)) return '—';
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtDeadline(t) {
    if (!t) return '';
    const d = new Date(t); if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
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
  /* 平均定稿时间：按数值大小智能切换单位（天 / 小时 / 分钟），避免小单显示成 0.2 天 */
  function fmtCycle(days) {
    if (days == null || isNaN(days)) return '—';
    if (days >= 1) return days.toFixed(1) + ' 天';
    const hours = days * 24;
    if (hours >= 1) return hours.toFixed(1) + ' 小时';
    return Math.round(hours * 60) + ' 分钟';
  }
  // 颜色工具：十六进制与指定色按比例混合（用于生成浅底/深字）
  function mixHex(hex, withHex, ratio) {
    const h = hex.replace('#', ''), w = withHex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    const m = parseInt(w.length === 3 ? w.split('').map(c => c + c).join('') : w, 16);
    const r1 = (n >> 16) & 255, g1 = (n >> 8) & 255, b1 = n & 255;
    const r2 = (m >> 16) & 255, g2 = (m >> 8) & 255, b2 = m & 255;
    const mix = (a, b) => Math.round(a + (b - a) * ratio);
    return '#' + [mix(r1, r2), mix(g1, g2), mix(b1, b2)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  // 实心标签：深底 + 自动字色。浅色底（黄/橙/浅灰）用深色字，深色底用白字，保证可读性
  function softBadge(color, text, extraClass) {
    const c = (color || '#64748b').replace('#', '');
    const n = parseInt(c.length === 3 ? c.split('').map(x => x + x).join('') : c, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // 相对亮度
    const fg = L > 0.6 ? '#1f2937' : '#ffffff';
    return '<span class="' + (extraClass || 'pill') + '" style="background:#' + c + ';color:' + fg + '">' + text + '</span>';
  }
  function pill(status) {
    const cfg = window.Cfg.STATUS[status] || {};
    const c = cfg.color || '#64748b';
    return softBadge(c, esc(cfg.label || status));
  }
  function catPill(cat) { return '<span class="cat-pill cat-' + cat + '">' + cat + '</span>'; }
  // 手机端「每页 N 条」下拉浮层：避免 <select> 被 overflow:hidden 父容器截断
  // 浮层用 position:fixed 脱离文档流，根据按钮位置自动向上/向下弹出
  function showPageSizePicker(opts) {
    const { current, options, onSelect, anchor, placement } = opts;
    const rect = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : null;
    const pop = document.createElement('div');
    pop.className = 'page-size-pop';
    let html = '';
    options.forEach(v => {
      html += '<button class="page-size-pop-item' + (v === current ? ' active' : '') + '" data-val="' + v + '">' +
        (v === current ? '✓ ' : '') + v + ' 条</button>';
    });
    pop.innerHTML = html;
    document.body.appendChild(pop);
    // 定位：placement='top' 强制向上；'bottom' 强制向下；默认自动判断
    const vw = window.innerWidth, vh = window.innerHeight;
    const popW = Math.max(rect ? rect.width : 120, 116);
    const estH = options.length * 44 + 8;
    let left = rect ? rect.left : (vw - popW) / 2;
    left = Math.max(8, Math.min(left, vw - popW - 8));
    pop.style.left = left + 'px';
    pop.style.width = popW + 'px';
    if (rect) {
      const below = vh - rect.bottom;
      if (placement === 'top') {
        pop.style.top = Math.max(8, rect.top - estH - 6) + 'px';
      } else if (placement === 'bottom') {
        pop.style.top = (rect.bottom + 6) + 'px';
      } else if (below >= estH + 8) {
        pop.style.top = (rect.bottom + 6) + 'px';
      } else {
        pop.style.top = Math.max(8, rect.top - estH - 6) + 'px';
      }
    } else {
      pop.style.top = ((vh - estH) / 2) + 'px';
    }
    function close() { if (pop.parentNode) pop.remove(); document.removeEventListener('click', onDoc, true); }
    function onDoc(e) { if (!pop.contains(e.target) && e.target !== anchor) close(); }
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
    pop.addEventListener('click', e => {
      const opt = e.target.closest('[data-val]');
      if (!opt) return;
      const val = parseInt(opt.dataset.val, 10);
      close(); onSelect(val);
    });
  }
  // 是否参与设计（派单/协作/工作台等）：管理员默认不参与；非管理员默认参与，除非显式关闭 active_design
  function isActiveDesign(d) { return d.role === '管理员' ? false : (d.active_design !== false); }
  // 视图范围：由权限点 view_all_orders 决定（管理员/店长默认开；设计师默认关，管理员可在权限配置按设计师开启）
  function isViewAll() {
    return !!(state.currentUser && can('view_all_orders'));
  }
  function cmpOrders(a, b, key, dir) {
    let va, vb;
    if (key === 'amount') { va = Number(a.amount) || 0; vb = Number(b.amount) || 0; }
    else if (key === 'category') { va = window.Cfg.orderCategory(Number(a.amount) || 0, state._settings); vb = window.Cfg.orderCategory(Number(b.amount) || 0, state._settings); }
    else if (key === 'intake_at' || key === 'deadline') { va = a[key] ? new Date(a[key]).getTime() : 0; vb = b[key] ? new Date(b[key]).getTime() : 0; }
    else { va = (a[key] || '').toString(); vb = (b[key] || '').toString(); }
    const r = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === 'asc' ? r : -r;
  }
  // 流程回退 / 推进时记录审计（复用已存在的 flow_history jsonb 列）
  // byOverride 可选：传入后覆盖默认的 currentUser.name（如自动派单时传 '系统'）
  function recordFlow(o, action, toStatus, byOverride) {
    o.flow_history = Array.isArray(o.flow_history) ? o.flow_history : [];
    o.flow_history.push({ ts: new Date().toISOString(), action, to: toStatus, by: byOverride || (state.currentUser && state.currentUser.name) || '' });
  }
  const FLOW_ACTION_LABEL = {
    dispatch: '派单', start: '开始设计', proposal: '提交提案',
    proposal_pass: '提案通过', proposal_fail: '提案不通过', proposal_again: '二次提案',
    draft: '提交初稿', feedback: '提交客户反馈', revise: '开始修改',
    finalize: '客户定稿', switch: '更换设计师', revert: '回退'
  };
  function flowActionName(action) { return FLOW_ACTION_LABEL[action] || action; }
  function flowLogHtml(log) {
    if (!log || !log.length) return '<span class="muted">暂无流程变更记录</span>';
    return '<ul class="flow-log-list">' + log.slice().reverse().map(e =>
      '<li><span class="fl-ts">' + fmtTime(e.ts) + '</span> <b>' + esc(flowActionName(e.action)) + '</b> → ' + esc(e.to || '') +
      (e.by ? ' <span class="fl-by">(' + esc(e.by) + ')</span>' : '') + '</li>'
    ).join('') + '</ul>';
  }
  function toggleOrderSort(key) {
    if (state.orderSort.key === key) state.orderSort.dir = state.orderSort.dir === 'asc' ? 'desc' : 'asc';
    else state.orderSort = { key, dir: 'asc' };
    state.orderPage = 1; renderOrders();
  }
  function toggleCustomerSort(key) {
    if (state.customerSort.key === key) state.customerSort.dir = state.customerSort.dir === 'asc' ? 'desc' : 'asc';
    else state.customerSort = { key, dir: 'asc' };
    try { localStorage.setItem('ds_cust_sort', JSON.stringify(state.customerSort)); } catch (e) {}
    state.customerPage = 1; renderCustomers();
  }
  function cmpCustomers(a, b, key, dir) {
    const orders = state._orders || [];
    const coA = orders.filter(o => o.customer_id === a.id);
    const coB = orders.filter(o => o.customer_id === b.id);
    let r = 0;
    if (key === 'name') {
      r = String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    } else if (key === 'amount') {
      const amtA = coA.reduce((s, o) => s + (Number(o.amount) || 0), 0);
      const amtB = coB.reduce((s, o) => s + (Number(o.amount) || 0), 0);
      r = amtA - amtB;
    } else if (key === 'orders') {
      r = coA.length - coB.length;
    } else if (key === 'lastOrder') {
      const lastA = coA.map(o => o.intake_at || '').filter(Boolean).sort().slice(-1)[0] || '';
      const lastB = coB.map(o => o.intake_at || '').filter(Boolean).sort().slice(-1)[0] || '';
      r = lastA > lastB ? 1 : lastA < lastB ? -1 : 0;
    }
    return dir === 'asc' ? r : -r;
  }
  // 从仪表盘待办卡片跳订单列表并套用对应筛选
  function gotoOrders(filterKey) {
    switchTab('orders');
    state.filters = {}; state.orderPage = 1; state._overdueOnly = false; state._dueTodayOnly = false; state._riskOnly = false;
    const setF = (id, v) => { const el = $(id); if (el) el.value = v; };
    if (filterKey === 'status=接单') setF('#fStatus', '接单');
    else if (filterKey === 'status=派单') setF('#fStatus', '派单');
    else if (filterKey === 'due=today') { state._dueTodayOnly = true; setQuickRange('all'); }
    else if (filterKey === 'overdue=1') { state._overdueOnly = true; }
    else if (filterKey === 'risk=red') { state._riskOnly = true; setQuickRange('all'); }
    readFilters(); renderOrders(); updateFilterBadge();
  }
  function updateOverdueBadge() {
    const badge = $('#overdueBadge'), cntEl = $('#overdueCount');
    if (!badge || !cntEl) return;
    const nowTs = Date.now();
    const isFin = s => s === '已定稿' || s === '已换人';
    const n = (state._orders || []).filter(o => o.deadline && new Date(o.deadline).getTime() < nowTs && !isFin(o.status)).length;
    cntEl.textContent = n;
    badge.style.display = n ? '' : 'none';
  }
  function updateFilterBadge() {
    const $badge = $('#filterBadge');
    if (!$badge) return;
    const fields = ['fCustomer','fDesigner','fStatus','fCategory','fTaskType','fDateFrom','fDateTo'];
    const count = fields.filter(id => $('#' + id) && $('#' + id).value).length;
    if (count > 0) { $badge.textContent = count; $badge.style.display = ''; }
    else { $badge.style.display = 'none'; }
  }
  function renderGlobalSearch(q) {
    const box = $('#globalSearchResult'); if (!box) return;
    if (!q) { box.style.display = 'none'; return; }
    const od = (state._orders || []).filter(o => (o.title || '').toLowerCase().includes(q) || (o.order_no || '').toLowerCase().includes(q) || (o.customer_name || '').toLowerCase().includes(q)).slice(0, 8);
    const cu = (state._customers || []).filter(c => (c.name || '').toLowerCase().includes(q)).slice(0, 5);
    let html = '';
    if (od.length) html += '<div class="gs-sec">订单</div>' + od.map(o => '<div class="gs-item" data-go="order" data-id="' + o.id + '">📄 ' + esc(o.title) + ' <span class="gs-sub">' + esc(o.order_no || '') + '</span></div>').join('');
    if (cu.length) html += '<div class="gs-sec">客户</div>' + cu.map(c => '<div class="gs-item" data-go="customer" data-id="' + c.id + '">👤 ' + esc(c.name) + '</div>').join('');
    if (!html) html = '<div class="gs-empty">无匹配结果</div>';
    box.innerHTML = html; box.style.display = '';
    // 动态定位到搜索框正下方（fixed 定位，脱离文档流避免撑高顶部栏）
    const input = $('#globalSearch');
    if (input) {
      const r = input.getBoundingClientRect();
      box.style.top = (r.bottom + 4) + 'px';
      box.style.left = r.left + 'px';
      box.style.width = r.width + 'px';
    }
    $$('#globalSearchResult .gs-item').forEach(el => el.addEventListener('click', () => {
      box.style.display = 'none';
      const id = el.dataset.id;
      if (el.dataset.go === 'order') { switchTab('orders'); openOrder(id); }
      else { switchTab('customers'); viewCustomer(id); }
    }));
  }
  // 是否参与绩效/经营分析统计：管理员默认不参与；非管理员默认参与，除非 exclude_perf === true
  function isActivePerf(d) { return d.role === '管理员' ? false : (d.exclude_perf !== true); }
  // 是否纳入团队平均/排名分母：管理员默认不参与；非管理员默认参与，除非 active_avg === false
  function isActiveAvg(d) { return d.role === '管理员' ? false : (d.active_avg !== false); }

  /* ---------- 逾期/延期风险预测 ---------- */
  // 返回全量风险映射（orderId → { level, reason, estFinish, daysLeft, avgCycleUsed }），带缓存
  function riskMap() {
    if (!state._riskMap) {
      const d = Array.isArray(state._designers) ? state._designers : [];
      const o = Array.isArray(state._orders) ? state._orders : [];
      state._riskMap = window.Calc.assessRisk(o, d, state._settings || {});
    }
    return state._riskMap;
  }
  function riskInfo(o) { return riskMap()[o.id] || { level: 'none', reason: '' }; }
  function isFinishedStatus(s) { return s === '已定稿' || s === '已换人'; }
  // 风险标签 HTML（红/黄/绿圆点 + 文案；无风险返回空）
  function riskBadge(o) {
    const r = riskInfo(o);
    if (!r.level || r.level === 'none') return '';
    const txt = { red: r.reason, yellow: r.reason, green: '正常' };
    return '<span class="risk-badge risk-' + r.level + '" title="预计完成：' + fmtTime(r.estFinish).slice(0, 10) +
      (r.daysLeft != null ? ' · 剩余 ' + r.daysLeft + ' 天' : '') + '">' +
      '<span class="risk-dot"></span>' + (txt[r.level] || '') + '</span>';
  }

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
    const t = $('#toast'), icon = $('#toastIcon'), txt = $('#toastText');
    if (icon) icon.textContent = (msg === '已刷新数据' || msg === '已刷新') ? '✓' : '';
    if (txt) txt.textContent = msg; else t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
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

  /* ---------- 版本更新提示 ----------
     设计原则：更新过程必须「可见、可中止、有回执」。
     绝不无提示直接 reload —— 页面凭空重载会被用户误认为程序闪退。
       1) 检测到新版本 → 弹浮层；自动模式下倒计时若干秒，期间可点「稍后」中止；
       2) 真正刷新前 → 浮层切到「正在更新…」过渡态，让重载有前因；
       3) 重载完成后 → 显示「已更新到最新版本」回执（见 showUpdatedNotice）。 */
  let _auCountTimer = null;
  function clearAuCount() { if (_auCountTimer) { clearInterval(_auCountTimer); _auCountTimer = null; } }

  // 执行更新：先切过渡态，再唤醒等待中的新 SW（由 controllerchange 触发 reload）
  function applyAppUpdate() {
    clearAuCount();
    // 打标记：重载后由 showUpdatedNotice() 读取并给出回执，明确"这是更新不是崩溃"
    try { localStorage.setItem('ds_just_updated', String(Date.now())); } catch (e) {}
    const el = $('#appUpdate');
    if (el) {
      const t = el.querySelector('.au-title'), s = el.querySelector('.au-sub');
      const ico = el.querySelector('.au-ico'), foot = el.querySelector('.au-foot');
      if (ico) ico.textContent = '⏳';
      if (t) t.textContent = '正在更新…';
      if (s) s.textContent = '正在载入新版本，页面稍后会自动重新加载，请勿关闭。';
      if (foot) foot.innerHTML = '<div style="font-size:12.5px;color:#64748b;padding:2px 0">请稍候…</div>';
      el.classList.add('show');
    }
    if (window.__swPendingUpdate) window.__swPendingUpdate();   // 新 SW 接管时触发 reload
    const reg = window.__swReg;
    const wake = (w) => { try { w.postMessage({ type: 'SKIP_WAITING' }); } catch (e) {} };
    const fallbackReload = (ms) => setTimeout(() => { try { window.location.reload(); } catch (e) {} }, ms);
    if (reg && reg.waiting) {
      wake(reg.waiting);
      fallbackReload(3000);        // 个别浏览器不触发 controllerchange，兜底刷新，避免卡在「正在更新…」
    } else if (reg && reg.installing) {
      const nw = reg.installing;   // 还在下载新版本：装好再唤醒
      nw.addEventListener('statechange', () => { if (nw.state === 'installed') wake(nw); });
      fallbackReload(5000);
    } else {
      fallbackReload(600);
    }
  }

  // 新版本可用提示。auto=true → 倒计时后自动更新；auto=false → 必须用户点击
  function showAppUpdate(auto) {
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
      $('#auNow').addEventListener('click', applyAppUpdate);
      // 「稍后」：中止倒计时并收起。新 SW 仍在 waiting，下次进入应用或手动检查时会再提示
      $('#auLater').addEventListener('click', () => { clearAuCount(); el.classList.remove('show'); });
    }
    requestAnimationFrame(() => el.classList.add('show'));

    clearAuCount();
    const sub = el.querySelector('.au-sub'), btn = el.querySelector('#auNow');
    if (!auto) {
      if (sub) sub.textContent = '已部署更新，点「立即更新」重新加载以应用。';
      if (btn) btn.textContent = '立即更新';
      return;
    }
    let left = Math.max(3, Number(window.Cfg && window.Cfg.UPDATE_DELAY_SEC) || 6);
    const tick = () => {
      if (left <= 0) { applyAppUpdate(); return; }
      if (sub) sub.textContent = '已部署更新，' + left + ' 秒后自动重新加载；不想现在更新可点「稍后」。';
      if (btn) btn.textContent = '立即更新（' + left + '）';
      left--;
    };
    tick();
    _auCountTimer = setInterval(tick, 1000);
  }
  window.showAppUpdate = showAppUpdate;

  // 更新完成回执：重载后告知用户「刚才的重新加载是版本更新」，消除"闪退"错觉
  function showUpdatedNotice() {
    let flag = null;
    try { flag = localStorage.getItem('ds_just_updated'); } catch (e) {}
    if (!flag) return;
    try { localStorage.removeItem('ds_just_updated'); } catch (e) {}
    // 陈旧标记不提示：例如更新途中被关掉，隔天再打开时弹「已更新」反而误导
    const ts = Number(flag);
    if (ts && Date.now() - ts > 5 * 60 * 1000) return;
    const el = document.createElement('div');
    el.className = 'app-update';
    el.innerHTML =
      '<div class="au-top"></div>' +
      '<div class="au-body">' +
        '<div class="au-ico">✅</div>' +
        '<div class="au-text">' +
          '<div class="au-title">已更新到最新版本</div>' +
          '<div class="au-sub">刚才的重新加载是版本更新，不是程序异常。</div>' +
        '</div>' +
      '</div>' +
      '<div class="au-foot"><button class="au-btn primary">知道了</button></div>';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    const close = () => { el.classList.remove('show'); setTimeout(() => { try { el.remove(); } catch (e) {} }, 400); };
    const okBtn = el.querySelector('.au-btn');
    if (okBtn) okBtn.addEventListener('click', close);
    setTimeout(close, 6000);
    // 附上版本号（异步读 sw.js，读不到就保持默认文案）
    if (window.__readResVersion) {
      window.__readResVersion().then(v => {
        const s = el.querySelector('.au-sub');
        if (s && v && v.indexOf('未知') < 0) s.textContent = '当前版本 ' + v + '，刚才的重新加载是版本更新，不是程序异常。';
      }).catch(() => {});
    }
  }

  /* ---------- 模态框 ---------- */
  function openModal(html) { $('#modalBox').innerHTML = html; $('#modalBox').classList.remove('detail-modal'); $('#modalMask').classList.add('show'); }
  async function closeModal(force) {
    if (!force) {
      const o = state.editingOrder;
      if (o && !o.id) {
        const t = id => document.getElementById(id);
        const has = (t('oTitle') && t('oTitle').value.trim()) || (t('oNotes') && t('oNotes').value.trim()) ||
                    (t('oCustomer') && t('oCustomer').value) || (t('oCustomerText') && t('oCustomerText').value.trim()) ||
                    (t('oNewCName') && t('oNewCName').value.trim()) ||
                    (t('oAmount') && Number(t('oAmount').value) > 0) || (t('oFilePaths') && t('oFilePaths').value.trim()) ||
                    (t('oDesignPaths') && t('oDesignPaths').value.trim());
        if (has) {
          const ok = window.confirm('订单尚未保存，关闭后将自动保留为草稿（下次新建自动恢复）。确定关闭？');
          if (!ok) return false;
        }
      } else if (o && o.id && o._dirty && $('#modalBox').classList.contains('detail-modal')) {
        // 方案B：详情弹窗有未保存的信息改动，关闭前二次确认，防误丢
        const ok = await uiConfirm('有未保存的修改，确定不保存并关闭？\n点「取消」可返回继续编辑，或点底部的「保存信息」保留改动。');
        if (!ok) return false;
      }
    }
    $('#modalMask').classList.remove('show');
    state.editingOrder = null;
    state.editingOrderId = null;
    return true;
  }

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
    // 流程推进 / 投诉记录 / 手动补记修改次数（详情弹窗内动态生成）
    $$('[data-flow]').forEach(el => { if (!can('flow_advance')) el.style.display = 'none'; });
    $$('[data-complaint="inc"]').forEach(el => { if (!can('complaint_add')) el.style.display = 'none'; });
    $$('[data-revision="inc"]').forEach(el => { if (!can('orders_edit')) el.style.display = 'none'; });
    // 若当前激活页被隐藏，切到首个可见页
    const active = $('#tabs button.active');
    if (active && active.style.display === 'none') {
      const first = $$('#tabs button').find(b => b.style.display !== 'none');
      if (first) switchTabQuiet(first.dataset.tab);
    }
    syncSwipeStripVisibility(); // 同步条带显隐（隐藏无权限页，保持 flow 顺序 = 可见顺序）
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
  // 是否处于移动端横向滑动轨道模式：与 css @media max-width:760px 对齐。
  // 调试：?mobile=1 / ?swipe=1 强制开启；?mobile=0 / ?swipe=0 强制关闭。
  function isSwipeMode() {
    if (/[?&](mobile|swipe)=0\b/.test(location.search)) { swipeLog('isSwipeMode=false (forced off)'); return false; }
    if (/[?&](mobile|swipe)=1\b/.test(location.search)) { swipeLog('isSwipeMode=true (forced on)'); return true; }
    const r = window.innerWidth <= 760;
    swipeLog('isSwipeMode=' + r + ' (w=' + window.innerWidth + ')');
    return r;
  }
  // 滑动调试日志：默认静默，地址栏加 ?debug=1 时才输出（避免污染线上控制台）
  function swipeLog(...a) {
    if (!/[?&]debug=1\b/.test(location.search)) return;
    console.log('[swipe]', ...a);
  }
  // 当前可见（未被权限隐藏）的菜单 tab 顺序列表
  function visibleTabs() {
    return $$('#tabs button').filter(b => b.style.display !== 'none').map(b => b.dataset.tab);
  }
  // 下拉刷新时的滚动根：移动端轨道模式下读当前激活页内部 scrollTop，桌面读整页
  function getScrollRoot() {
    if (isSwipeMode()) {
      const sec = document.querySelector('#swipeTrack > section.active');
      return sec || (document.scrollingElement || document.documentElement);
    }
    return document.scrollingElement || document.documentElement;
  }
  // 同步滑动条带中各页显隐：移动端让“可见（有权限）页”全部参与横向并排，隐藏无权限页，
  // 保持 flow 顺序 = 可见顺序，使 transform 的 -curIdx*W 偏移能正确对位当前页。
  function syncSwipeStripVisibility() {
    const secs = $$('#swipeTrack > section');
    if (!isSwipeMode()) {
      secs.forEach(s => { s.style.display = ''; });
      // 清除移动端轨道残留的 transform/transition：小窗口(≤760px)时 switchTab 给 #swipeTrack
      // 设了 translateX，放大到桌面后这些内联样式不再需要却未被清除，
      // transform 会创建新包含块 → 子元素无法正确撑满宽度 → 内容卡在窄尺寸。
      const track = $('#swipeTrack');
      if (track) { track.style.transform = ''; track.style.transition = ''; }
      swipeLog('syncSwipe: desktop mode, reset displays + track transform');
      return;
    }
    const activeId = 'tab-' + state.tab;
    const map = {};
    $$('#tabs button').forEach(b => {
      const sec = document.getElementById('tab-' + b.dataset.tab);
      if (sec) {
        // 当前激活页必须显示；其余页按 tab 按钮显隐控制（完整条带中所有可见页都 display:block 横向并排）
        const show = (b.style.display !== 'none') || (sec.id === activeId);
        sec.style.display = show ? 'block' : 'none';
        map[b.dataset.tab] = sec.style.display;
      }
    });
    // 兜底：如果遍历后 active section 仍未被设置，强制 block（防扩展/异常状态导致隐藏）
    const activeSec = document.getElementById(activeId);
    if (activeSec && activeSec.style.display !== 'block') activeSec.style.display = 'block';
    swipeLog('syncSwipe:', map, 'active=', state.tab);
  }
  // 渲染看门狗：动画/状态对齐后若当前页未成功渲染（无 data-rendered 标记），自动重渲染一次。
  function ensureTabRendered(tab) {
    if (!tab) return;
    const sec = document.getElementById('tab-' + tab);
    if (!sec) return;
    if (sec.dataset.rendered === '1') return; // 已成功渲染，无需处理
    swipeLog('ensureTabRendered: retry', tab, 'children=', sec.childElementCount, 'err=', sec.dataset.renderError);
    // 最多重试一次（带 preload=false 避免递归预渲染邻居），失败则保留错误提示
    renderTabContent(tab, { force: true, preload: false }).catch(e => showRenderError(tab, e));
  }
  // 强制当前页内容可见：抵御外部扩展/样式注入把内容隐藏成“空白”
  function forceContentVisible(tab) {
    const sec = document.getElementById('tab-' + tab);
    if (!sec) return;
    // 只保护当前 section 的直接子元素（page-head、.card 等骨架），不动深层业务样式
    // 跳过布局容器（grid/flex），避免 !important 覆盖 grid-template-columns 导致图表等从多列变单列
    const SKIP_DISPLAY = ['charts-grid', 'kpi-grid', 'todo-panel', 'grid2', 'grid3', 'grid3-sm', 'workbenchKpis', 'workbenchStats'];
    for (let i = 0; i < sec.childElementCount; i++) {
      const c = sec.children[i];
      if (c.tagName !== 'STYLE' && !SKIP_DISPLAY.some(cls => c.classList.contains(cls))) {
        c.style.setProperty('display', 'block', 'important');
      }
      c.style.setProperty('visibility', 'visible', 'important');
      c.style.setProperty('opacity', '1', 'important');
    }
    // 关键业务容器兜底
    sec.querySelectorAll('.page-head, .card, .kpi-grid, .empty, table, .toolbar, .pager').forEach(el => {
      el.style.setProperty('display', '', ''); // 清除可能由扩展加的内联 display:none
      el.style.removeProperty('display');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
    });
  }
  // 把渲染异常显示在对应 section 顶部，便于无 Console 时直接看到问题（而不是静默空白）
  function showRenderError(tab, e) {
    const sec = document.getElementById('tab-' + tab);
    if (!sec) return;
    sec.dataset.renderError = (e && e.message) || String(e);
    let box = sec.querySelector('.render-error');
    if (!box) {
      box = document.createElement('div');
      box.className = 'render-error';
      sec.insertBefore(box, sec.firstChild);
    }
    box.textContent = '⚠ 本页渲染失败：' + ((e && e.message) ? e.message : e) + '（' + tab + '）';
  }
  // ?debug=1 时显示诊断浮层，便于无 Console 时排查当前 tab/显隐/transform 状态
  function updateSwipeDiag() {
    if (!/[?&]debug=1\b/.test(location.search)) return;
    let box = document.getElementById('swipeDiag');
    if (!box) {
      box = document.createElement('div');
      box.id = 'swipeDiag';
      box.style.cssText = 'position:fixed;left:4px;top:70px;z-index:99999;background:rgba(0,0,0,.78);color:#0f0;font:11px/1.4 monospace;padding:6px 8px;border-radius:6px;max-width:260px;pointer-events:none;white-space:pre-wrap;';
      document.body.appendChild(box);
    }
    const sec = document.getElementById('tab-' + state.tab);
    const track = $('#swipeTrack');
    const childInfo = [];
    if (sec) {
      for (let i = 0; i < Math.min(sec.childElementCount, 4); i++) {
        const c = sec.children[i];
        childInfo.push('c' + i + '=' + c.tagName + '.' + c.className + ' h=' + c.clientHeight);
      }
    }
    const table = sec ? sec.querySelector('.tbl, table') : null;
    const keyIds = ['ordersTable', 'workbenchStats', 'workbenchKpis', 'workbenchCards', 'customersTable', 'anaTable', 'settingsDesignersTable'];
    const keyInfo = keyIds.map(id => {
      const el = document.getElementById(id);
      const inSec = el && sec && sec.contains(el);
      return id + '=' + (el ? (inSec ? 'in' : 'out') + ':' + el.childElementCount : 'null');
    });
    const cs = sec ? getComputedStyle(sec) : null;
    box.textContent = [
      'tab=' + state.tab,
      'swipe=' + isSwipeMode() + ' w=' + window.innerWidth,
      'sec=' + (sec ? sec.id : 'null') + ' disp=' + (sec ? sec.style.display : '—'),
      'children=' + (sec ? sec.childElementCount : '—'),
      'sh=' + (sec ? sec.scrollHeight : '—') + ' ch=' + (sec ? sec.clientHeight : '—'),
      'cs=' + (cs ? cs.display + '|' + cs.visibility + '|' + cs.opacity : '—'),
      ...childInfo,
      'table=' + (table ? table.id + ':' + table.childElementCount : 'null'),
      ...keyInfo,
      'rendered=' + (sec ? sec.dataset.rendered : '—'),
      'trackW=' + (track ? track.clientWidth : '—'),
      'transform=' + (track ? track.style.transform : '—')
    ].join('\n');
  }
  // 仅切换标签高亮 + 显示对应 section，不做登录判断（供 applyPermissions 内部调用）
  function switchTabQuiet(tab) {
    state.tab = tab;
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const track = $('#swipeTrack');
    if (track && isSwipeMode()) {
      // 移动端轨道：常驻 transform 把当前页定位到视口（弹窗/日历在 track 外，不受影响）
      const idx = visibleTabs().indexOf(tab);
      const W = track.clientWidth || window.innerWidth;
      track.style.transition = 'none';
      track.style.transform = 'translateX(' + (-idx * W) + 'px)';
      $$('#swipeTrack > section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
      swipeLog('switchTabQuiet', tab, 'idx=' + idx, 'W=' + W, 'transform=' + track.style.transform);
    } else {
      $$('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
      swipeLog('switchTabQuiet desktop', tab);
    }
    syncSwipeStripVisibility();
    ensureTabRendered(tab);
    updateSwipeDiag();
  }
  // tab 渲染入口。opts.force=false 时若已渲染过则跳过；opts.preload=false 时不触发邻居预渲染。
  function renderTabContent(tab, opts) {
    opts = opts || {};
    if (!tab) return Promise.resolve();
    swipeLog('renderTabContent START', tab, 'force=' + opts.force);
    if (!state._renderedTabs) state._renderedTabs = new Set();
    const already = state._renderedTabs.has(tab);
    if (already && opts.force === false) { swipeLog('renderTabContent SKIP', tab, 'already rendered'); return Promise.resolve(); }
    state._renderedTabs.add(tab);
    let p;
    try {
      p = _renderTabContentCore(tab);
    } catch (e) {
      // 渲染同步抛错：清掉“已渲染”标记，允许后续点击重试，避免该页永久空白
      state._renderedTabs.delete(tab);
      if (!state._renderedOk) state._renderedOk = new Set();
      state._renderedOk.delete(tab);
      console.error('[renderTabContent] 渲染失败（同步）：', tab, e);
      showRenderError(tab, e);
      return Promise.reject(e);
    }
    const clear = () => { state._renderedTabs.delete(tab); if (state._renderedOk) state._renderedOk.delete(tab); };
    const after = () => {
      if (!state._renderedOk) state._renderedOk = new Set();
      state._renderedOk.add(tab); // 标记该页已完成渲染（供滑动时判断是否可立即跟手）
      const sec = $('#tab-' + tab);
      if (sec) { sec.dataset.rendered = '1'; sec.removeAttribute('data-render-error'); }
      swipeLog('renderTabContent DONE', tab, 'children=' + (sec ? sec.childElementCount : 'missing'));
      if (opts.preload !== false) preRenderNeighbors(tab);
    };
    const onErr = (e) => {
      // 渲染异步失败：同样清掉标记，允许重试；不影响其他页
      clear();
      console.error('[renderTabContent] 渲染失败（异步）：', tab, e);
      showRenderError(tab, e);
    };
    if (p && typeof p.then === 'function') p.then(after, onErr);
    else after();
    return p || Promise.resolve();
  }
  function _renderTabContentCore(tab) {
    if (tab === 'dashboard') return renderDashboard();
    if (tab === 'orders') return renderOrders();
    if (tab === 'designers') return renderWorkbench();
    if (tab === 'customers') return renderCustomers();
    if (tab === 'analytics') return renderAnalytics();
    if (tab === 'settings') return renderSettings();
  }
  // 移动端轨道模式下，当前页渲染完成后预渲染左右邻居，避免滑动时出现空白
  function preRenderNeighbors(tab) {
    if (!isSwipeMode()) return;
    const vis = visibleTabs();
    const idx = vis.indexOf(tab);
    if (idx < 0) return;
    const prev = vis[idx - 1], next = vis[idx + 1];
    const preload = (t) => { if (t) renderTabContent(t, { force: false, preload: false }); };
    preload(prev);
    preload(next);
  }
  function renderUserBox() {
    const u = state.currentUser;
    const box = $('#userBox');
    if (!box) return;
    if (!u) { box.innerHTML = ''; return; }
    box.innerHTML = '<button type="button" class="ub-name" id="btnIdentity" title="点击查看身份">'
        + esc(u.name) + '</button>'
      + '<span class="ub-role role-' + esc(u.role) + ' desktop-only">' + esc(u.role) + '</span>';
    const ib = $('#btnIdentity'); if (ib) ib.addEventListener('click', openIdentity);
  }

  // 点击顶栏人名 → 弹出身份详情（含退出登录、修改密码入口）
  function openIdentity() {
    const u = state.currentUser;
    if (!u) return;
    const gMap = Object.fromEntries((state._groups || []).map(g => [g.id, g.name]));
    const role = u.role || '—';
    const group = (u.group_id && gMap[u.group_id]) || '—';
    const email = u.email || '—';
    const status = u.active === false ? '已停用' : '启用中';
    const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('zh-CN') : '—';
    const initial = (u.name || '?').slice(0, 1);
    const html =
      '<h3>我的身份</h3>'
      + '<div class="id-card">'
        + '<div class="id-avatar">' + esc(initial) + '</div>'
        + '<div class="id-meta">'
          + '<div class="id-name-row">'
            + '<span class="id-name">' + esc(u.name) + '</span>'
            + '<button type="button" class="id-edit-pw" id="btnOpenPw" title="修改登录密码">修改密码</button>'
          + '</div>'
          + '<div class="id-role role-' + esc(role) + '">' + esc(role) + '</div>'
        + '</div>'
      + '</div>'
      + '<ul class="id-list">'
        + '<li><span>所属小组</span><b>' + esc(group) + '</b></li>'
        + '<li><span>邮箱</span><b>' + esc(email) + '</b></li>'
        + '<li><span>账号状态</span><b>' + esc(status) + '</b></li>'
        + '<li><span>加入时间</span><b>' + esc(joined) + '</b></li>'
      + '</ul>'
      + '<div class="row" style="margin-top:16px">'
        + '<button type="button" class="btn danger" id="idLogout" style="flex:1">退出登录</button>'
        + '<button type="button" class="btn secondary" data-close style="flex:1">关闭</button>'
      + '</div>';
    openModal(html);
    const lo = $('#idLogout'); if (lo) lo.addEventListener('click', async () => { const closed = await closeModal(); if (!closed) return; logout(); });
    const op = $('#btnOpenPw'); if (op) op.addEventListener('click', openChangePassword);
    const cs = $('#modalBox [data-close]'); if (cs) cs.addEventListener('click', () => closeModal());
  }

  // 修改登录密码弹窗（从身份弹窗点击入口打开）
  function openChangePassword() {
    closeModal();
    const html =
      '<h3>修改登录密码</h3>'
      + '<div class="mypw-row" style="margin-top:4px">'
        + '<div class="field" style="flex:1;min-width:160px"><label>当前密码</label><input type="password" id="myPwOld" autocomplete="current-password" placeholder="请输入当前密码" /></div>'
        + '<div class="field" style="flex:1;min-width:160px"><label>新密码（至少 6 位）</label><input type="password" id="myPwNew" autocomplete="new-password" placeholder="请输入新密码" /></div>'
        + '<div class="field" style="flex:1;min-width:160px"><label>确认新密码</label><input type="password" id="myPwConfirm" autocomplete="new-password" placeholder="再次输入" /></div>'
      + '</div>'
      + '<div class="login-err" id="myPwErr" style="margin-top:8px;min-height:18px"></div>'
      + '<div class="modal-foot">'
        + '<button type="button" class="btn secondary" data-close>取消</button>'
        + '<button class="btn" id="btnMyPwSave">保存</button>'
      + '</div>';
    openModal(html);
    const ps = $('#btnMyPwSave'); if (ps) ps.addEventListener('click', updateMyPassword);
    const cs = $('#modalBox [data-close]'); if (cs) cs.addEventListener('click', () => closeModal());
    setTimeout(() => { const o = $('#myPwOld'); if (o) o.focus(); }, 50);
  }

  async function logout() {
    logOp('登出', '账户');
    try { await DB.auth.signOut(); } catch (e) {}
    state.currentUser = null;
    try { localStorage.removeItem('lastLoginEmail'); } catch (e) {}   // 退出后清除上次邮箱，避免登录页泄露
    try { localStorage.removeItem('ds_logged_in'); localStorage.removeItem('ds_biz_cache_v1'); } catch (e) {}  // 清除离线优先标记与缓存
    bootAuth();
  }

  // 操作日志：从当前登录用户取操作人，旁路写入（失败不影响主操作）
  function logOp(action, targetType, targetId, targetLabel, detail) {
    const u = state.currentUser;
    if (!u) return;
    try {
      window.DB.logOperation({
        designerId: u.id, designerName: u.name,
        action, targetType, targetId, targetLabel, detail
      });
    } catch (e) { console.warn('logOp 失败', e); }
  }

  // Auth 登录成功后：根据会话匹配设计师档案；无档案则进入「绑定档案」（首个管理员）
  async function afterAuthLogin() {
    const session = await DB.auth.getSession();
    if (!session || !session.user) { renderLogin(); return; }
    // 关键：登录成功后用「已认证身份」重拉全量数据。
    // 页面刚打开时 loadAll 以匿名身份执行，RLS 下拉到的是空数据，
    // 若直接用旧缓存匹配档案会误判「无档案」而弹出绑定页（导致重复建档案）。
    // reload(loadAll) 与 loadSettingsRobust 互不依赖，并行执行可省去一次顺序等待（实测约 ~0.5~1s）。
    // 此前担心并行会让 loadSettingsRobust 在 JWT 未传播时重试烧光预算，但实测并行版登录同样 ~2s 进入，
    // 故恢复并行（v420 回退顺序属误判，已还原）。下游「未匹配到设计师档案则 loadDesignersRobust 重试」不变。
    try {
      await Promise.all([DB.reload(), DB.loadSettingsRobust()]);
      await loadData();
    } catch (e) { console.warn('登录后重载数据失败', e); }
    updateSync();   // 【v441】登录同步完成，刷新同步时钟（loadAll 内部已 markSynced）
    let me = (state._designers || []).find(d => d.auth_id && d.auth_id === session.user.id);
    // 首登时序竞态：新建会话 JWT 偶发未对 RLS 生效，designers 查询返回空 → 误判「无档案」而弹出
    // 绑定页（表现为「获取不到职位」）；刷新后会话稳定才正常。此处健壮重试一次，确认确无档案才弹绑定页，
    // 避免误弹 / 重复建档。
    if (!me) {
      try { await DB.loadDesignersRobust(); await loadData(); } catch (e) { console.warn('重试拉取设计师失败', e); }
      me = (state._designers || []).find(d => d.auth_id && d.auth_id === session.user.id);
    }
    if (me) { state.currentUser = me; await afterLogin(); return; }
    renderBindProfile(session.user);
  }

  // ---------- 登录图形验证码（失败 3 次后启用，拖慢公网爆破、避免正常用户被锁死）----------
  // 说明：验证码为纯前端生成，仅作「人类验证」辅助，真正的限流仍由服务端 login_attempts 负责。
  let _captchaAnswer = '';
  let _loginNeedCaptcha = false;
  function genCaptcha() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 排除易混字符 0/O/1/I/L
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    _captchaAnswer = code;
    const cv = document.getElementById('captchaCanvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, w, h);
    // 干扰线
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = 'rgba(' + [Math.floor(Math.random() * 160), Math.floor(Math.random() * 160), Math.floor(Math.random() * 160)].join(',') + ',0.5)';
      ctx.beginPath();
      ctx.moveTo(Math.random() * w, Math.random() * h);
      ctx.lineTo(Math.random() * w, Math.random() * h);
      ctx.stroke();
    }
    // 字符（随机旋转、彩色）
    for (let i = 0; i < code.length; i++) {
      ctx.save();
      ctx.translate(14 + i * 26, h / 2);
      ctx.rotate((Math.random() - 0.5) * 0.5);
      ctx.font = 'bold 24px Georgia, serif';
      ctx.fillStyle = ['#1d4ed8', '#047857', '#b91c1c', '#7c3aed', '#c2410c'][i % 5];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(code[i], 0, 0);
      ctx.restore();
    }
    // 噪点
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
  }
  function showCaptchaBox() {
    const box = document.getElementById('captchaBox');
    if (box) box.style.display = '';
    genCaptcha();
  }
  function hideCaptchaBox() {
    const box = document.getElementById('captchaBox');
    if (box) box.style.display = 'none';
    const inp = document.getElementById('captchaInput');
    if (inp) inp.value = '';
  }
  function verifyCaptcha() {
    const inp = document.getElementById('captchaInput');
    if (!inp) return false;
    return inp.value.trim().toUpperCase() === _captchaAnswer.toUpperCase();
  }

  async function doLogin(email, pw) {
    if (!lockOp('login')) return;
    const errEl = $('#loginErr');
    try {
      // 失败 3 次后进入验证码模式：必须先通过图形验证才允许继续尝试（不消耗失败配额）
      if (_loginNeedCaptcha) {
        if (!verifyCaptcha()) {
          if (errEl) errEl.textContent = '请先正确完成图形验证（点击图片可换一张）';
          const ci = document.getElementById('captchaInput'); if (ci) ci.value = '';
          genCaptcha();
          return;
        }
      }
      // 登录前检查账户锁定（防公网爆破）。阈值与服务端一致：15 分钟内失败 ≥5 次锁定 15 分钟。
      // 网络异常时 loginLockMinutes 返回 0，不阻断正常登录，仅失效限流保护。
      try {
        const remain = await DB.auth.loginLockMinutes(email);
        if (remain > 0) {
          if (errEl) errEl.textContent = '该账户登录尝试过于频繁，请于 ' + remain + ' 分钟后再试';
          hideCaptchaBox(); _loginNeedCaptcha = false;
          return;
        }
      } catch (e) {}
      try {
        await DB.auth.signIn(email, pw);
        // 登录成功：清空失败计数，解除锁定与验证码模式
        try { await DB.auth.clearLoginFailures(email); } catch (e) {}
        _loginNeedCaptcha = false; hideCaptchaBox();
        logOp('登录', '账户'); // 仅在真正用密码登录时记录，避免刷新恢复会话被误记为登录
      } catch (e) {
        // 登录失败：记录一次失败；达阈值则账户锁定
        let cnt = 0;
        try { cnt = await DB.auth.recordLoginFailure(email); } catch (err) {}
        if (cnt >= 3) {
          // 进入（或保持）验证码模式，避免被无限爆破把正常用户锁死
          _loginNeedCaptcha = true;
          showCaptchaBox();
        }
        if (cnt >= 5) {
          _loginNeedCaptcha = false; hideCaptchaBox();
          if (errEl) errEl.textContent = '密码错误次数过多，账户已锁定 15 分钟，请稍后再试';
        } else {
          const left = 5 - cnt;
          if (errEl) errEl.textContent = (e && e.message ? e.message : '登录失败') +
            (cnt >= 3 ? '（需完成图形验证再试）' : '（还可尝试 ' + left + ' 次）');
        }
        return;
      }
      await afterAuthLogin();
    } finally { unlockOp('login'); }
  }

  // 登录后确保云端权限配置已加载：新建会话后 PostgREST 偶发尚未识别身份，
  // settings 查询可能返回空/错误，导致权限回退到内置默认值（表现：登录后权限是默认的，刷新才正确）。
  // 每次循环都「先补拉一次再判断」（不信任可能陈旧的 loadAll 结果），最多 6 次、间隔 500ms（≈3s 兜底）。
  async function ensureSettingsLoaded(tries) {
    tries = tries || 6;
    for (let i = 0; i < tries; i++) {
      const s = await DB.getSettings();          // 注意：getSettings 是 async，必须 await，否则拿到 Promise
      if (s && s.permissions) return;            // 已拿到云端权限配置
      try { await DB.reloadSettings(); } catch (e) { console.warn('补拉 settings 失败', e); }
      const s2 = await DB.getSettings();
      if (s2 && s2.permissions) return;          // 补拉后再次确认
      if (i < tries - 1) await new Promise(r => setTimeout(r, 500)); // 给会话生效一点时间
    }
  }

  async function afterLogin() {
    const ov = document.getElementById('loginOverlay'); if (ov) ov.remove();
    // 【关键修复 v432】启动路径（bootAuth）不经过 afterAuthLogin，缺少 DB.reload() 调用，
    // 导致 db.js 内 cache.customers / cache.orders / cache.groups 永远为空数组（DB.init() 仅 loadDesignersOnly）。
    // 结果：loadData() 读到空数据 → persistBusinessCache 存入空缓存 → 下次冷启动显示全零。
    // 此处用 fire-and-forget 补拉全量数据，不阻塞首屏渲染；拉到后自动刷新 state + 重渲染 + 更新离线缓存。
    // 注意：是否有「已注入的完整缓存」用 _bootHadCache 标志（bootApp 设定），
    // 不能用 state._orders.length —— init()→loadData() 会先填好 state._orders，
    // 会让无缓存路径被误判为「有缓存」而跳过 hideSplash（Splash 永久挂起）。
    const hadCachedData = _bootHadCache;
    // 登录成功后（已认证身份）探测云端 schema 缺字段（后台 fire-and-forget）
    // 解决首次启动 / F5 / 首次登录时，init 阶段以匿名身份探测误报"云端数据表缺字段"的问题。
    // 点顶部「重新连接云端」时 reconnectSupabase 也会探测（已登录态），逻辑一致、不会重复误报。
    // 注意：改为后台 fire-and-forget，不再 await 阻塞首屏——探测完若缺字段再 toast 提示，
    // 避免多一次 RPC 往返把进入桌面的时间往后推（桌面 PWA 跨区明显）。
    DB.probeSupabaseSchema().then(async () => {
      try { const s = await DB.getSettings(); if (s && s._schemaError) toast(s._schemaError); } catch (e) {}
    }).catch(e => console.warn('schema 探测失败', e));
    // 关键修复（消除登录「慢半拍」）：不再阻塞 await 等待云端 settings。
    // 启动阶段 init() 已从 localStorage(ds_settings) 合并了「上一次成功加载的真实权限」
    // （含管理员对职务/设计师的覆盖，见 db.js persistSettings()）。这里立即以其渲染，
    // 云端对账放到后台，结果不同再无感重算权限——首屏即时、无需手刷、也无需苦等。
    // 【关键】DB.getSettings() 是 async 函数，必须 await。
    // 历史 bug：此处漏写 await，state._settings 被赋成一个 Promise 对象，
    // 于是 permConfig() 读 state._settings.permissions 恒为 undefined → 回退 config.js 内置默认权限，
    // 表现为「登录后是默认权限、刷新才是真实权限」（刷新时 loadData 用 Promise.all 隐式 await 了，故正常）。
    state._settings = await DB.getSettings(); // 刷新副本，确保读到探测写入的最新 _schemaError
    try { localStorage.setItem('ds_logged_in', '1'); } catch (e) {}  // 标记已登录：离线优先，下次冷启动即时上屏
    renderUserBox();
    applyPermissions();
    // 登录后工作台默认显示本人看板：把当前设计师设为默认选中（无 view_all 时强制锁定本人，
    // 有 view_all 时下拉仍可选其他人）。这避免了「带查看全部权限的设计师」默认落到列表第一人。
    if (state.currentUser && state.currentUser.id) state.currentDesignerId = state.currentUser.id;
    if (!state._subscribed) {
      DB.subscribe(() => { updateSync(); refreshAll(); });
      state._subscribed = true;
    }
    // 若记住的页无权限，落到仪表盘（仪表盘默认全开）
    if (!state.tab || !can(tabPermKey(state.tab))) state.tab = 'dashboard';
    // ═══════════════════════════════════════════════════
    // 核心分叉：有缓存 vs 无缓存 → 决定何时 hideSplash
    // ═══════════════════════════════════════════════════
    if (hadCachedData) {
      // ── Path A：bootApp 已用离线缓存即时上屏（Splash 已关）──
      // DB.reload 在后台补拉最新数据，完成后静默刷新。用户无感更新。
      // Path A：跳过同步重渲染，等 DB.reload 后台刷新
      DB.reload().then(async () => {
        // 全量数据补拉完成，刷新状态与视图
        state._designers = await DB.listDesigners(); state._customers = await DB.listCustomers();
        state._orders = await DB.listOrders(); state._groups = await DB.listGroups();
        state._settings = await DB.getSettings(); state._riskMap = null;
        fillSelects();
        persistBusinessCache();
        // 【v435】比对「离线缓存」与「服务端」数据指纹：没变化则跳过重绘，
        // 避免图表/数字在后台刷新时无谓地闪重绘一次（秒进秒开后体验闭环）。
        const newSig = dataSignature(state._designers, state._customers, state._orders, state._groups);
        if (newSig === state._cacheSig) {
          // 缓存与服务端数据一致，跳过重绘（仅静默更新缓存/权限）
          applyPermissions();
        } else {
          // 数据有变化，重绘视图
          await renderTabContent(state.tab);
        }
        // 【v441】后台自动同步完成，刷新「已同步」时钟（loadAll 内部已 markSynced）
        updateSync();
      }).catch(e => console.warn('后台全量补拉失败（保留当前视图）', e));
    } else {
      // ── Path B：无缓存（首装/升级后旧残缺缓存被拒）──
      // 必须等 DB.reload 完成拿到完整数据后才 hideSplash + 渲染，
      // 否则用户看到「Splash 闪没 → 空白/残缺仪表盘 → 2秒后数据闪出」。
      // Path B：无缓存，等待 DB.reload 完成后再揭开 Splash
      try {
        await DB.reload();
        state._designers = await DB.listDesigners(); state._customers = await DB.listCustomers();
        state._orders = await DB.listOrders(); state._groups = await DB.listGroups();
        state._settings = await DB.getSettings(); state._riskMap = null;
        fillSelects();
        persistBusinessCache();   // 写入完整缓存，下次冷启动走 Path A 秒进
      } catch (e) {
        console.warn('DB.reload 失败，使用 loadData 已加载数据', e);
      }
      await renderTabContent(state.tab);   // 用完整数据渲染
      hideSplash();                        // 数据就绪后才揭 Splash
    }
    // 移动端轨道模式下，确保 track transform 与当前页对齐（避免初始状态或旋转后错位）
    if (isSwipeMode()) switchTabQuiet(state.tab);
    updateOverdueBadge();
    updateSync();
    // 后台对账（非阻塞）：用稳健方式再补拉一次云端 settings（已认证会话就绪 + 重试），
    // 与当前权限不同则无感重算并刷新。即便是首次启动无本地缓存，也能在登录流程内
    // 由 loadSettingsRobust 直接拿到真实权限，此处作为边缘兜底（如服务端权限被改）。
    DB.loadSettingsRobust().then(async () => {
      try {
        const before = JSON.stringify((state._settings && state._settings.permissions) || null);
        const fresh = await DB.getSettings();   // 必须 await：漏写会把 Promise 存进 state._settings
        const after = JSON.stringify((fresh && fresh.permissions) || null);
        state._settings = fresh;
        if (after !== 'null' && after !== before) {
          renderUserBox();
          applyPermissions();
          renderTabContent(state.tab);
          toast('权限配置已自动同步');
        }
      } catch (e) { console.warn('后台对账 settings 失败', e); }
    }).catch(() => {});
  }

  // 首次进入（无会话）：有会话则进桌面，无会话则登录页
  async function bootAuth() {
    let session = null;
    try { session = await DB.auth.getSession(); } catch (e) { session = null; }
    if (session && session.user) {
      // 业务数据已由 init() 内的 loadData() 全量加载，此处不再重复拉取
      let me = (state._designers || []).find(d => d.auth_id && d.auth_id === session.user.id);
      // 边缘：init 阶段匿名/网络抖动导致设计师未就绪（cache.designers 仍空），
      // 此时若直接判「无档案」会误弹绑定页。用稳健重试补拉一次再判定，与 afterAuthLogin 保持一致。
      if (!me) {
        try { await DB.loadDesignersRobust(); state._designers = await DB.listDesigners(); } catch (e) {}
        me = (state._designers || []).find(d => d.auth_id && d.auth_id === session.user.id);
      }
      if (me) { state.currentUser = me; await afterLogin(); return; }
      // 已通过 Auth 登录但尚无设计师档案（通常是首个管理员首次进入）
      renderBindProfile(session.user);
      return;
    }
    // 会话已失效（令牌彻底过期/被踢）：清除本地登录标记与业务缓存，下次启动不再误显缓存数据
    try { localStorage.removeItem('ds_logged_in'); localStorage.removeItem('ds_biz_cache_v1'); } catch (e) {}
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
    hideSplash();
    $('#bpSubmit').addEventListener('click', async () => {
      if (existing && !can('customers_edit')) { toast('无编辑客户权限'); return; }
      if (!existing && !can('customers_create')) { toast('无新建客户权限'); return; }
      if (!lockOp('bindProfile')) return;
      try {
        const name = ($('#bpName').value || '').trim();
        if (!name) { $('#loginErr').textContent = '请填写姓名'; return; }
        const d = await DB.auth.bindProfile({ name, role: $('#bpRole').value, email: user.email || '' });
        state._designers = await DB.listDesigners();
        state.currentUser = d;
        await afterLogin();
      } catch (e) { $('#loginErr').textContent = (e && e.message) || '绑定失败'; }
      finally { unlockOp('bindProfile'); }
    });
  }

  function renderLogin() {
    const avatarColor = (name) => {
      const PALETTE = ['#7c3aed', '#2563eb', '#db2777', '#059669', '#d97706', '#dc2626', '#0891b2', '#65a30d', '#9333ea', '#0d9488'];
      let s = 0; const n = name || '';
      for (let i = 0; i < n.length; i++) s += n.charCodeAt(i);
      return PALETTE[s % PALETTE.length];
    };
    const greeting = () => {
      const h = new Date().getHours();
      if (h < 6 || h >= 22) return '夜深了';
      if (h < 12) return '早上好';
      if (h < 14) return '中午好';
      if (h < 18) return '下午好';
      return '晚上好';
    };
    const lastEmail = (() => { try { return localStorage.getItem('lastLoginEmail') || ''; } catch (e) { return ''; } })();
    // 已绑定 Auth 账号的设计师（在职，或管理员始终显示），作为快捷选择；最近登录者置前
    let all = (state._designers || []).filter(d => d.auth_id && (d.role === '管理员' || d.active !== false));
    if (lastEmail) {
      all = all.slice().sort((a, b) => ((a.email || '') === lastEmail ? -1 : 0) - ((b.email || '') === lastEmail ? -1 : 0));
    }
    const VISIBLE_USERS = 8;
    const visibleUsers = all.slice(0, VISIBLE_USERS);
    const hiddenUsers = all.slice(VISIBLE_USERS);
    const renderUserBtn = (d) => {
      const initial = esc((d.name || '?').trim().slice(0, 1));
      const color = avatarColor(d.name);
      const last = (d.email || '') === lastEmail;
      return '<button type="button" class="login-user' + (d.active === false ? ' is-inactive' : '') + (last ? ' is-last' : '') + '" data-did="' + esc(d.id) + '" title="' + esc(d.name) + '">' +
        '<span class="lu-avatar" style="background:' + color + '">' + initial + '</span>' +
        '<span class="lu-name">' + esc(d.name) + '</span>' +
        (last ? '<span class="lu-badge">最近</span>' : '') +
        '</button>';
    };
    const ov = document.createElement('div');
    ov.id = 'loginOverlay'; ov.className = 'login-overlay';
    ov.innerHTML =
      '<div class="login-card">' +
        '<aside class="login-aside">' +
          '<div class="login-aside-logo">🎨</div>' +
          '<div class="login-aside-brand">设计部工作台</div>' +
          '<div class="login-aside-slogan">让设计流程<br>更清晰 · 更高效</div>' +
          '<ul class="login-aside-feats"><li>📊 流程管理</li><li>🏆 绩效统计</li><li>📲 一键安装</li></ul>' +
        '</aside>' +
        '<div class="login-main">' +
          '<div class="login-brand login-brand-top">🎨 设计部工作台</div>' +
          '<div class="login-sub" id="loginHello"></div>' +
          '<div class="login-form" style="display:block">' +
            '<div class="field" id="loginEmailField"><label>邮箱</label><input id="loginEmail" type="email" value="" placeholder="name@studio.com" autocomplete="username" /></div>' +
            '<div class="field" id="loginSelectedUser" style="display:none">' +
              '<label>已选择账号</label>' +
              '<div class="login-selected-user" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line,#d1d5db);border-radius:8px;background:var(--panel,#fff)">' +
                '<span id="loginSelectedAvatar" style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:14px;flex-shrink:0"></span>' +
                '<span id="loginSelectedName" style="font-weight:500;color:var(--ink,#1f2937);flex:1"></span>' +
                '<button type="button" id="loginSwitchUser" style="font-size:12px;color:var(--primary,#4f46e5);background:none;border:none;cursor:pointer;padding:0;text-decoration:underline">切换账号</button>' +
              '</div>' +
            '</div>' +
            '<div class="field"><label>密码</label><div class="login-pw-wrap"><input id="loginPw" type="password" placeholder="请输入密码" autocomplete="current-password" /><button type="button" class="login-pw-eye" id="loginPwEye" aria-label="显示密码" title="显示/隐藏密码">👁</button></div></div>' +
            '<div class="login-err" id="loginErr"></div>' +
            '<div class="captcha-box" id="captchaBox" style="display:none">' +
              '<label class="captcha-label">图形验证（区分大小写不敏感）</label>' +
              '<div class="captcha-row">' +
                '<input id="captchaInput" type="text" maxlength="4" autocomplete="off" placeholder="输入右侧字符" class="captcha-input" />' +
                '<canvas id="captchaCanvas" width="120" height="40" class="captcha-canvas" title="点击可刷新"></canvas>' +
                '<button type="button" id="captchaRefresh" class="captcha-refresh" title="换一张">↻</button>' +
              '</div>' +
            '</div>' +
            '<button class="btn" id="loginSubmit" style="width:100%;margin-top:8px">登录</button>' +
            '<div class="login-foot">密码问题请联系管理员重置</div>' +
          '</div>' +
          (all.length ? '<div class="login-quick"><div class="login-quick-label">快捷登录</div><div class="login-quick-grid" id="loginQuickGrid">' +
            visibleUsers.map(renderUserBtn).join('') +
            (hiddenUsers.length ? '<button type="button" class="login-user login-more" id="loginMoreUsers" title="展开更多"><span class="lu-avatar" style="background:#e2e8f0;color:#475569">+' + hiddenUsers.length + '</span><span class="lu-name">更多</span></button>' : '') +
            '</div>' +
            (hiddenUsers.length ? '<div id="loginHiddenUsers" style="display:none">' + hiddenUsers.map(renderUserBtn).join('') + '</div>' : '') +
            '<div class="login-quick-hint" id="quickLoginHint" style="display:none;color:var(--error);font-size:12px;margin-top:6px">请输入密码后点击登录</div></div>' : '') +
          '<div class="login-install" id="loginInstallBox">' +
            '<button type="button" class="login-install-btn" id="loginInstallBtn">📲 安装到桌面 / 主屏幕</button>' +
            '<div class="login-install-hint" id="loginInstallHint"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    const old = document.getElementById('loginOverlay'); if (old) old.remove();
    document.body.appendChild(ov);
    const submit = $('#loginSubmit');
    if (submit) submit.addEventListener('click', () => { if (window._doLogin) window._doLogin($('#loginEmail').value, $('#loginPw').value); else doLogin($('#loginEmail').value, $('#loginPw').value); });
    const pw = $('#loginPw');
    if (pw) pw.addEventListener('keydown', e => { if (e.key === 'Enter') { if (window._doLogin) window._doLogin($('#loginEmail').value, $('#loginPw').value); else doLogin($('#loginEmail').value, $('#loginPw').value); } });
    // 密码框显示 / 隐藏
    const eye = $('#loginPwEye');
    if (eye && pw) eye.addEventListener('click', () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      eye.textContent = show ? '🙈' : '👁';
      eye.classList.toggle('on', show);
      pw.focus();
    });
    // 图形验证码：触发验证码模式后，刷新图片换一张；重新渲染登录界面时若处于验证码模式则恢复显示
    const capCanvas = document.getElementById('captchaCanvas');
    if (capCanvas) capCanvas.addEventListener('click', genCaptcha);
    const capRefresh = document.getElementById('captchaRefresh');
    if (capRefresh) capRefresh.addEventListener('click', () => {
      genCaptcha();
      const ci = document.getElementById('captchaInput');
      if (ci) { ci.value = ''; ci.focus(); }
    });
    if (_loginNeedCaptcha) showCaptchaBox();
    // 邮箱输入框引用（手动输入时用于解除快捷选择态）
    const emInput = $('#loginEmail');
    // 手动改邮箱 = 放弃快捷选择：取消高亮并清空密码，避免残留上一个人的密码被提交。
    // 仅在「已有快捷选择态且邮箱框可见可编辑」时才介入；快捷登录态下邮箱框已被禁用并隐藏，
    // 浏览器自动填充不会（也不应）触发此处，避免把正确的快捷选择态误清掉、导致又退回隐藏的错误邮箱。
      if (emInput) emInput.addEventListener('input', () => {
      if (!_quickLoginEmail || emInput.disabled) return; // 无选择态或快捷登录态：不干预
      _quickLoginEmail = '';
      clearSelectedUser();                              // 切回邮箱输入框并取消高亮
      clearLoginPw();
    });
    // 清空密码框并复位「显示密码」眼睛状态（切换登录账号时必须调用）
    function clearLoginPw() {
      const p = $('#loginPw');
      if (!p) return;
      p.value = '';
      p.type = 'password';
      const e2 = $('#loginPwEye');
      if (e2) { e2.textContent = '👁'; e2.classList.remove('on'); }
    }
    // 快捷登录：显示「已选择账号」卡片，隔离并隐藏邮箱输入框
    function showSelectedUser(d) {
      const emailField = $('#loginEmailField');
      const selectedBox = $('#loginSelectedUser');
      const emailInput = $('#loginEmail');
      const avatar = $('#loginSelectedAvatar');
      const name = $('#loginSelectedName');
      if (emailField) emailField.style.display = 'none';
      // 关键修复：快捷登录态下把邮箱框清空、禁用、并关闭自动填充，
      // 彻底切断浏览器「记忆的（可能过期/错误）邮箱」与本账号提交之间的联系，
      // 避免隐藏的错误邮箱被提交导致「用户名无效」。
      if (emailInput) { emailInput.value = ''; emailInput.disabled = true; emailInput.setAttribute('autocomplete', 'off'); }
      if (selectedBox) selectedBox.style.display = '';
      if (avatar) {
        avatar.textContent = esc((d.name || '?').trim().slice(0, 1));
        avatar.style.background = avatarColor(d.name);
      }
      if (name) name.textContent = esc(d.name || '');
    }
    // 取消快捷选择态，切回手动输入（恢复邮箱框可编辑与自动填充）
    function clearSelectedUser() {
      const emailField = $('#loginEmailField');
      const selectedBox = $('#loginSelectedUser');
      const emInput = $('#loginEmail');
      if (emailField) emailField.style.display = '';
      if (selectedBox) selectedBox.style.display = 'none';
      if (emInput) { emInput.disabled = false; emInput.setAttribute('autocomplete', 'username'); emInput.value = ''; emInput.focus(); }
      $$('.login-quick .login-user').forEach(x => x.classList.remove('is-selected'));
      const hint = $('#quickLoginHint'); if (hint) hint.style.display = 'none';
    }
    // 密码重置改为「管理员代设」：登录页不再提供自助重置入口，引导联系管理员
    const loginFoot = $('.login-foot');
    if (loginFoot) loginFoot.title = '如忘记密码，请联系管理员在「设置 → 设计师管理」中代设新密码';
    // 切换账号：回到手动输入邮箱
    const switchBtn = $('#loginSwitchUser');
    if (switchBtn) switchBtn.addEventListener('click', () => { _quickLoginEmail = ''; clearSelectedUser(); clearLoginPw(); });
    // 安全：点击头像快捷登录时，绝不把真实邮箱回显到输入框（公网部署会泄露账号）。
    // 真实邮箱只保存在内存变量 _quickLoginEmail，提交登录时再使用。
    // 同时规避了旧版「掩码串被密码管理器当成同一账号、A/B 密码串号」的坑：
    // 现在邮箱框不写任何假用户名，浏览器自然不会把不同人的密码关联到同一个用户名。
    // 切换账号仍须清空密码框，否则上一个人已填入的密码会残留并被提交，导致登录失败。
    let _quickLoginEmail = '';
    $$('.login-quick .login-user').forEach(b => b.addEventListener('click', () => {
      const did = b.dataset.did;
      const d = (state._designers || []).find(x => x.id === did);
      if (d && d.email) {
        const switching = _quickLoginEmail && _quickLoginEmail !== d.email;
        _quickLoginEmail = d.email;          // 仅存内存，不回显
        showSelectedUser(d);                 // 显示「已选择账号」卡片，不显示邮箱明文
        clearLoginPw();                       // 关键修复：切人即清空，杜绝串号密码
        $('#loginPw').focus();
        const hint = $('#quickLoginHint');
        if (hint) {
          hint.style.display = '';
          hint.textContent = switching
            ? '已切换到「' + d.name + '」，密码已清空，请输入其密码'
            : '已选择「' + d.name + '」，请输入密码后点登录';
        }
        // 高亮选中按钮
        $$('.login-quick .login-user').forEach(x => x.classList.remove('is-selected'));
        b.classList.add('is-selected');
      }
    }));
    // 快捷登录：超出 6 人时折叠为「更多」按钮，点击展开剩余人员
    const moreBtn = $('#loginMoreUsers');
    const hiddenBox = $('#loginHiddenUsers');
    if (moreBtn && hiddenBox) moreBtn.addEventListener('click', () => {
      const grid = $('#loginQuickGrid');
      if (!grid) return;
      $$('#loginHiddenUsers .login-user').forEach(b => grid.appendChild(b));
      hiddenBox.remove();
      moreBtn.remove();
    });
    // 登录时如果邮箱是掩码则用内部真实值；登录期间按钮进入 Loading，成功后记住账号，失败则抖动提示
    const origDoLogin = doLogin;
    window._doLogin = async function(email, pw) {
      // 优先使用快捷登录选中的内存邮箱；否则用输入框内容（手动输入或浏览器自动填充）
      const actualEmail = _quickLoginEmail || (email || '').trim();
      const btn = $('#loginSubmit');
      if (btn) { btn.disabled = true; btn.classList.add('is-loading'); btn.textContent = '登录中…'; }
      try { await origDoLogin(actualEmail, pw); }
      finally {
        const stillLogin = document.getElementById('loginOverlay');
        if (!stillLogin) {
          try { localStorage.setItem('lastLoginEmail', actualEmail); } catch (e) {}
        } else {
          if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); btn.textContent = '登录'; }
          const card = ov.querySelector('.login-main');
          if (card) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
        }
      }
    };
    // PWA 安装按钮：始终显示；浏览器支持 beforeinstallprompt（Chrome/Edge/Android）时点击直接安装，
    // 否则点击后展开手动安装指引，避免依赖「有时不触发」的安装事件而让用户看不到入口。
    const instBtn = $('#loginInstallBtn');
    const instHint = $('#loginInstallHint');
    function showInstall(isAvailable) {
      if (instBtn) { instBtn.style.display = ''; instBtn.textContent = isAvailable ? '📲 安装到桌面 / 主屏幕' : '💡 如何安装到桌面'; }
      if (instHint) {
        // 默认收起安装提示，减少登录页高度；点击按钮后展开
        instHint.style.display = 'none';
        instHint.textContent = isAvailable
          ? '可像 App 一样从桌面打开、离线使用、自动更新。'
          : '当前浏览器未提供一键安装入口，点击查看手动安装方法。';
      }
    }
    showInstall(!!window.__deferredPrompt);
    if (instBtn) instBtn.addEventListener('click', () => {
      if (window.__deferredPrompt && window.__promptInstall) { window.__promptInstall(); return; }
      // 无原生安装入口：展开详细手动安装步骤
      if (instHint) { instHint.style.display = ''; instHint.textContent = '手动安装方法：\n• Chrome / Edge：右上角菜单 →「安装应用 / 安装 设计部工作台」\n• 手机 Chrome / Edge：浏览器菜单 →「安装应用」\n• iOS Safari：底部「分享」→「添加到主屏幕」'; }
    });
    window.__refreshInstallBtn = showInstall;
    const helloEl = $('#loginHello'); if (helloEl) helloEl.textContent = greeting() + '，请登录';
    hideSplash();
  }

  // 启动 Splash：界面首次出现时移除（消除白屏，无感加载）
  function hideSplash() {
    const sp = document.getElementById('bootSplash');
    if (!sp || sp.dataset.hidden) return;
    sp.dataset.hidden = '1';
    sp.style.opacity = '0';
    sp.style.pointerEvents = 'none';
    setTimeout(() => sp.remove(), 320);
    // 若本次加载是由版本更新触发的重载，给出回执（避免被当成程序闪退）
    setTimeout(() => { try { showUpdatedNotice(); } catch (e) {} }, 900);
  }

  /* ---------------- 第三方库按需动态加载 ---------------- */
  // 首屏只加载 supabase-js / chart.js（本地 vendor，已在 <head> 以 defer 预载），xlsx(861k) 体积大且非首屏，仅在导出时按需加载。
  const _libCache = {};
  function loadScriptOnce(src) {
    if (_libCache[src]) return _libCache[src];
    _libCache[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => res(); s.onerror = () => rej(new Error('加载失败: ' + src));
      document.head.appendChild(s);
    });
    return _libCache[src];
  }
  async function ensureChartLib() {
    if (typeof window.Chart !== 'undefined') return true;
    // 版本参数必须与 index.html / sw.js PRECACHE 中的对应 URL 逐字一致。
    // chart/supabase 仍用 ?lib1；xlsx 因换支持样式的库已升为 ?lib2。
    // 不一致会变成另一个 URL：既命不中 SW 预缓存（离线时加载失败），又会重复下载一份。
    try { await loadScriptOnce('vendor/chart.js?lib1'); } catch (e) { console.warn(e); }
    return typeof window.Chart !== 'undefined';
  }
  async function ensureXlsxLib() {
    if (typeof window.XLSX !== 'undefined') return true;
    try { await loadScriptOnce('vendor/xlsx.js?lib2'); } catch (e) { console.warn(e); }
    return typeof window.XLSX !== 'undefined';
  }

  /* ============================================================
   * 初始化
   * ============================================================ */
  // ---------- 启动健壮性辅助 ----------
  // Promise 超时：超时后若有 fallback 则 resolve(fallback)，否则 reject（避免启动链路无限挂起）。
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (Object.prototype.hasOwnProperty.call(arguments, 2)) resolve(fallback);
        else reject(new Error('timeout after ' + ms + 'ms'));
      }, ms);
      Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
  async function init() {
    // file:// 协议下 Service Worker / Fetch / CORS 都不工作，必须走 http(s) 才能正常测试
    if (location.protocol === 'file:') {
      console.warn('[设计部工作台] 当前以 file:// 协议打开，PWA 缓存与网络请求受限，请通过本地服务器访问（如 npx serve 或 vscode Live Server）。');
    }
    await DB.init();
    // 会话失效自动跳登录：① token 过期/被踢时 Supabase 会触发 SIGNED_OUT（session=null）；
    // ② 写操作返回 401/JWT 失效时由 db.js 统一回调触发。两者都直接回到登录页，避免「保存失败」却不知已掉线。
    try { DB.onAuthError(() => { if (state.currentUser) renderLogin(); }); } catch (e) {}
    try { DB.auth.onChange(s => { if (!s || !s.user) renderLogin(); }); } catch (e) {}
    bindTabs();
    bindGlobal();
    // 全量加载业务数据（一次）；异常由 bootApp 的最外层超时兜底接住，不会永久卡死首屏
    await loadData();
    await bootAuth();
    // 启动后立即巡检一次：自动派单设置开启时，接单超过 5 分钟且已有设计师+截稿时间的订单直接推进到派单
    checkAutoDispatch().catch(() => {});
  }
  async function loadData() {
    const [designers, customers, orders, settings, groups] = await Promise.all([
      DB.listDesigners(), DB.listCustomers(), DB.listOrders(), DB.getSettings(), DB.listGroups()
    ]);
    state._designers = designers || [];
    state._customers = customers || [];
    state._orders = orders || [];
    state._settings = settings;
    state._groups = groups || [];
    state._riskMap = null;
    fillSelects();
    // ⚠️ 注意：此处【不】写离线缓存！init() 阶段 DB.init() 仅 loadDesignersOnly，
    // orders/customers 此时还是空数组（db.js 内部 cache 未填充）。若在此 persistBusinessCache，
    // 会用「空业务表」覆盖掉上次成功写入的好缓存 → 下次冷启动/F5 读到空缓存 → 走等网络的 Path B。
    // 离线缓存只在 afterLogin 的 DB.reload() 完成后写（那时 orders/customers 已真正就绪）。
  }

  // —— 本地业务数据缓存（离线优先）——
  // 把最近一次成功加载的设计师/客户/订单/分组/设置写入 localStorage；下次冷启动先用这份缓存
  // 同步即时上屏，后台再静默刷新覆盖。这样无论网络多慢（长后台冷启动首次请求要 8~30s 建连），
  // 用户打开就能看到数据，几秒后自动更新成最新——真正的「秒进秒开」。
  const BIZ_CACHE_KEY = 'ds_biz_cache_v1';
  function persistBusinessCache() {
    // 防御：业务表（orders/customers）都为空时【绝不写入】。
    // 否则若在某次 loadData 时机（db.js 仅加载 designers、业务表尚未就绪）误调用，
    // 会用空数据覆盖 localStorage 里已有的好缓存 → 后续冷启动/F5 读到空缓存 → 退化成等网络的 Path B。
    const bizEmpty = !((state._orders && state._orders.length) || (state._customers && state._customers.length));
    if (bizEmpty) { console.warn('[cache] 业务表为空，跳过本地缓存写入（避免覆盖已有好缓存）'); return; }
    try {
      const payload = {
        designers: state._designers, customers: state._customers,
        orders: state._orders, groups: state._groups, settings: state._settings,
        currentUser: state.currentUser, ts: Date.now()
      };
      const str = JSON.stringify(payload);
      if (str.length > 4 * 1024 * 1024) { console.warn('[cache] 业务数据过大，跳过本地缓存'); return; }
      localStorage.setItem(BIZ_CACHE_KEY, str);
    } catch (e) { /* 配额超限等，忽略 */ }
  }
  function restoreBusinessCache() {
    try {
      const raw = localStorage.getItem(BIZ_CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.designers)) return obj;
    } catch (e) {}
    return null;
  }
  // 轻量内容指纹：行数 + id/updated_at 滚动哈希，用于判断「离线缓存」与「服务端」数据是否真有变化。
  // 后台静默刷新时若指纹一致则跳过重绘，避免图表/数字无谓地闪重绘一次。
  function dataSignature(designers, customers, orders, groups) {
    const hashTable = (arr) => {
      let h = 0; const n = arr ? arr.length : 0;
      for (let i = 0; i < n; i++) {
        const r = arr[i] || {};
        const k = String(r.id || '') + '|' + String(r.updated_at || r.updatedAt || '');
        for (let j = 0; j < k.length; j++) { h = (h * 31 + k.charCodeAt(j)) | 0; }
      }
      return n + ':' + h;
    };
    return hashTable(designers) + '#' + hashTable(customers) + '#' + hashTable(orders) + '#' + hashTable(groups);
  }
  // 用缓存数据填充内存状态并即时渲染菜单/账户（不触发任何网络请求）
  function applyCache(obj) {
    state._designers = obj.designers || [];
    state._customers = obj.customers || [];
    state._orders = obj.orders || [];
    state._groups = obj.groups || [];
    if (obj.settings) state._settings = obj.settings;
    if (obj.currentUser) state.currentUser = obj.currentUser;  // 离线缓存恢复身份信息，renderUserBox 即时出名字
    state._riskMap = null;
    // 记录本次离线缓存的数据指纹，供后台刷新后比对「数据是否真有变化」（没变化就跳过重绘）
    state._cacheSig = dataSignature(state._designers, state._customers, state._orders, state._groups);
    // 关键修复（消除「打开后约1秒空白/全零」）：把离线缓存同步注入 db.js 内部 cache
    // （仅空表才填）。否则 dashboardSummary 读 DB.list* 时 db.js cache 还空（init/DB.reload
    // 尚未跑）→ 仪表盘先渲染全零，~1秒后 DB.reload 才补真数据并整页重渲染。
    try { DB.primeCache(obj); } catch (e) { console.warn('[applyCache] primeCache 失败', e); }
    fillSelects();
    applyPermissions();   // 用缓存权限即时渲染菜单
    renderUserBox();     // 用缓存账户信息即时渲染头像
  }

  function updateSync() {
    const t = DB.getLastSync();
    const p = n => String(n).padStart(2, '0');
    const now = new Date();
    const elClock = $('#syncClock');
    const elLabel = $('#syncLabel');
    if (elClock) {
      // 显示相对同步时间，例如「2分钟前」「今天 17:33」，更直观
      elClock.textContent = fmtRelativeSync(t);
      const titleEl = $('#syncStatus');
      if (titleEl) titleEl.title = '当前时间 ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ' · 上次同步 ' + fmtTime(t);
    }
    if (elLabel) {
      const stale = now - (t || 0) > 5 * 60 * 1000; // 超过5分钟认为未同步
      elLabel.textContent = stale ? '未同步' : '已同步';
      elLabel.style.color = stale ? '#fde68a' : '';
    }
  }
  function fmtRelativeSync(t) {
    if (!t) return '—';
    const d = new Date(t); if (isNaN(d)) return '—';
    const now = new Date();
    const diff = Math.max(0, now - d);
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + '分钟前';
    if (hours < 24) return hours + '小时前';
    const p = n => String(n).padStart(2, '0');
    return d.getMonth() + 1 + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function refreshAll() {
    const [designers, customers, orders, settings, groups] = await Promise.all([
      DB.listDesigners(), DB.listCustomers(), DB.listOrders(), DB.getSettings(), DB.listGroups()
    ]);
    state._designers = designers; state._customers = customers; state._orders = orders;
    state._settings = settings; state._groups = groups;
    state._riskMap = null;
    fillSelects();
    if (!state.currentUser) return; // 未登录不渲染业务内容
    await renderTabContent(state.tab);
    applyPermissions();
    // 刷新后重新对齐滑动轨道位置，防止权限变化/旋转后当前页偏移
    if (isSwipeMode()) switchTabQuiet(state.tab);
    updateOverdueBadge();
  }

  // 统一刷新入口：顶部按钮（btnRefresh / btnDashRefresh）与下拉刷新（bindPullRefresh）共用，
  // 刷新同一批数据（订单/客户/设计师/设置/分组）并同步时钟、给出明确反馈。
  async function doRefresh(silent) {
    await refreshAll();
    DB.markSynced();
    updateSync();
    if (!silent) toast('已刷新数据');
  }

  /* ---------- 标签导航 ---------- */
  function bindTabs() {
    const btns = $$('#tabs button');
    swipeLog('bindTabs binding', btns.length, 'buttons');
    btns.forEach(b => b.addEventListener('click', () => {
      swipeLog('bindTabs click', b.dataset.tab);
      switchTab(b.dataset.tab);
    }));
  }
  async function switchTab(tab, opts) {
    opts = opts || {};
    if (!can(tabPermKey(tab))) { toast('当前账号无「' + tabLabel(tab) + '」菜单权限'); return; }
    const track = $('#swipeTrack');
    const W = track ? (track.clientWidth || window.innerWidth) : 0;
    const vis = visibleTabs();
    const fromIdx = vis.indexOf(state.tab);
    const toIdx = vis.indexOf(tab);
    swipeLog('switchTab START', tab, 'fromIdx=' + fromIdx, 'toIdx=' + toIdx, 'W=' + W, 'isSwipeMode=' + isSwipeMode());
    if (toIdx < 0) { swipeLog('switchTab ABORT tab not visible'); return; }
    // 顶部按钮高亮 + 记录当前
    state.tab = tab;
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

    if (track && isSwipeMode() && toIdx !== fromIdx) {
      // 移动端：相邻页横向滑动（完整条带，translateX(-toIdx*W) 把目标页定位到视口；常驻 transform 不清除）
      const tSec = document.getElementById('tab-' + tab);
      if (tSec) tSec.classList.add('swipe-peer'); // 参与渲染（当前页已在上次进入时预渲染）
      // 显式切 tab 时强制重渲染目标页，保证内容一定存在（预渲染若失败也已清标记可重试）
      if (opts.render !== false) {
        try { await renderTabContent(tab, { force: true }); }
        catch (e) { console.error('[switchTab] 渲染目标页失败：', tab, e); }
      }
      track.style.transition = 'transform .28s cubic-bezier(.22,.61,.36,1)';
      track.style.transform = 'translateX(' + (-toIdx * W) + 'px)';
      swipeLog('switchTab animate', tab, 'transform=' + track.style.transform);
      // 动画结束后仅保留目标页 .active（不再清除 transform，弹窗/日历在 track 外不受影响）
      setTimeout(() => {
        track.style.transition = 'none';
        $$('#swipeTrack > section').forEach(s => {
          s.classList.toggle('active', s.id === 'tab-' + tab);
          s.classList.remove('swipe-peer');
        });
        syncSwipeStripVisibility();
        ensureTabRendered(tab);
        forceContentVisible(tab);
        updateSwipeDiag();
        swipeLog('switchTab animate END', tab, 'active section children=', $('#tab-' + tab) ? $('#tab-' + tab).childElementCount : 'missing');
      }, 340);
    } else {
      // 桌面 / 同页 / 轨道模式定位
      if (track && isSwipeMode()) {
        track.style.transition = 'none';
        track.style.transform = 'translateX(' + (-toIdx * W) + 'px)';
        $$('#swipeTrack > section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
        swipeLog('switchTab direct track', tab, 'transform=' + track.style.transform);
      } else {
        $$('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
        swipeLog('switchTab direct desktop', tab);
      }
      // 显式切 tab 强制重渲染目标页，保证内容一定存在
      if (opts.render !== false) {
        try { await renderTabContent(tab, { force: true }); swipeLog('switchTab rendered', tab); }
        catch (e) { console.error('[switchTab] 渲染目标页失败：', tab, e); }
      }
      forceContentVisible(tab);
    }
    applyPermissions();
    swipeLog('switchTab END', tab);
  }

  /* ============================================================
   * 自定义日期选择器（不调系统弹窗）
   * ============================================================ */
  let _dpActive = null; // 当前激活的 input id
  let _dpYear, _dpMonth; // 日历显示的年/月
  function initDatePicker() {
    const panel = $('#datePickerPanel');
    // 点击 date-field 打开日历
    document.addEventListener('click', e => {
      const df = e.target.closest('.date-field[data-datepicker]');
      if (df) {
        e.stopPropagation();
        openDatePicker(df.dataset.datepicker, df);
        return;
      }
      // 点击面板外部关闭
      if (_dpActive && !e.target.closest('.dp-panel')) closeDatePicker();
    });
    // 面板内按钮委托（阻止冒泡，避免重新 render 后旧节点被移除，document 关闭监听器误判为点外面）
    panel.addEventListener('click', e => {
      const t = e.target.closest ? e.target.closest('.dp-prev, .dp-next, .dp-day') : e.target;
      if (!t) return;
      if (t.classList.contains('dp-prev')) { e.stopPropagation(); --_dpMonth; if (_dpMonth < 0) { _dpMonth = 11; _dpYear--; } renderDp(); return; }
      if (t.classList.contains('dp-next')) { e.stopPropagation(); ++_dpMonth; if (_dpMonth > 11) { _dpMonth = 0; _dpYear++; } renderDp(); return; }
      if (t.classList.contains('dp-day') && !t.classList.contains('dp-off') && !t.classList.contains('dp-dis')) {
        e.stopPropagation();
        const d = parseInt(t.dataset.d);
        const val = _dpYear + '-' + String(_dpMonth + 1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
        const inp = document.getElementById(_dpActive);
        if (inp) {
          inp.value = val;
          inp.dispatchEvent(new Event('change', {bubbles:true}));
        }
        closeDatePicker();
      }
    });
  }
  function openDatePicker(inputId, anchor) {
    _dpActive = (inputId || '').replace(/^#/, '');
    const panel = $('#datePickerPanel');
    const inp = document.getElementById(_dpActive);
    const val = inp ? inp.value : '';
    const now = new Date();
    if (val && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const p = val.split('-'); _dpYear = parseInt(p[0]); _dpMonth = parseInt(p[1]) - 1;
    } else { _dpYear = now.getFullYear(); _dpMonth = now.getMonth(); }
    renderDp();
    panel.style.display = '';
    // 定位：桌面端在输入框下方；移动端由 CSS fixed 底部处理
    if (window.innerWidth > 760) {
      const r = anchor.getBoundingClientRect();
      panel.style.left = Math.max(4, r.left) + 'px';
      panel.style.top = (r.bottom + 4) + 'px';
      panel.style.bottom = 'auto';
    }
  }
  function closeDatePicker() {
    _dpActive = null;
    $('#datePickerPanel').style.display = 'none';
  }
  function renderDp() {
    const panel = $('#datePickerPanel');
    const y = _dpYear, m = _dpMonth;
    const today = new Date(), todayStr = fmtISO(today);
    const selInp = _dpActive ? document.getElementById(_dpActive) : null;
    const selVal = selInp ? selInp.value : '';
    const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    const wk = ['日','一','二','三','四','五','六'];
    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let html = '<div class="dp-hd">';
    html += '<button type="button" class="dp-prev" aria-label="上一月">◀</button>';
    html += '<span>' + y + '年 ' + (monthNames[m]) + '</span>';
    html += '<button type="button" class="dp-next" aria-label="下一月">▶</button></div>';
    html += '<div class="dp-wk">' + wk.map(w => '<div>'+w+'</div>').join('') + '</div>';
    html += '<div class="dp-ds">';
    // 空白填充
    for (let i = 0; i < firstDay; i++) html += '<button class="dp-dis"></button>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = y + '-' + String(m+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
      const cls = ['dp-day'];
      if (ds === todayStr) cls.push('dp-today');
      if (ds === selVal) cls.push('dp-sel');
      html += '<button type="button" class="' + cls.join(' ') + '" data-d="' + d + '">' + d + '</button>';
    }
    html += '</div>';
    panel.innerHTML = html;
  }
  function fmtISO(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }

  /* ============================================================
   * 自定义下拉（替换原生 select，不调系统选择界面）
   * ============================================================ */
  function enhanceSelect(sel) {
    if (!sel || sel.dataset.cst) return;
    sel.dataset.cst = '1';
    const wrap = document.createElement('div');
    wrap.className = 'cst';
    const btn = document.createElement('div');
    btn.className = 'cst-select'; btn.tabIndex = 0;
    const list = document.createElement('div');
    list.className = 'cst-list';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(btn);
    wrap.appendChild(sel);
    wrap.appendChild(list);
    sel.style.position = 'absolute'; sel.style.opacity = '0';
    sel.style.pointerEvents = 'none'; sel.style.width = '100%';
    sel.style.height = '100%'; sel.style.top = '0'; sel.style.left = '0';
    function render() {
      btn.textContent = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
      list.innerHTML = '';
      Array.from(sel.options).forEach(opt => {
        const o = document.createElement('div');
        o.className = 'cst-opt' + (opt.value === sel.value ? ' sel' : '');
        o.textContent = opt.text;
        o.addEventListener('click', () => {
          if (opt.value !== sel.value) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          close();
        });
        list.appendChild(o);
      });
    }
    function open() {
      render();
      list.classList.add('open');
      btn.classList.add('open');
      // 展开后滚动到当前选中项，避免默认只看到顶部（如 00）
      requestAnimationFrame(() => {
        const selOpt = list.querySelector('.cst-opt.sel');
        if (selOpt) selOpt.scrollIntoView({ block: 'nearest' });
      });
    }
    function close() { list.classList.remove('open'); btn.classList.remove('open'); }
    btn.addEventListener('click', e => { e.stopPropagation(); list.classList.contains('open') ? close() : open(); });
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); list.classList.contains('open') ? close() : open(); } });
    sel.addEventListener('change', render);
    // 监听 <select> 选项变化（如 fill() 重新填充），同步刷新自定义下拉显示
    new MutationObserver(render).observe(sel, { childList: true });
    document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
    render();
  }
  // 自动增强：页面上任何 <select>（含弹窗内动态生成的）都会被替换
  function observeSelects() {
    const obs = new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'SELECT' && !n.dataset.cst) enhanceSelect(n);
        if (n.querySelectorAll) n.querySelectorAll('select:not([data-cst])').forEach(enhanceSelect);
      }));
    });
    obs.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('select:not([data-cst])').forEach(enhanceSelect);
  }

  /* ============================================================
   * 自定义确认弹窗（替换原生 confirm，不调系统对话框）
   * ============================================================ */
  // 把 ISO / "YYYY-MM-DDTHH:MM" 的截稿时间格式化为「8月10日 12:00」中文提示
  function fmtDeadlineCn(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    const p = n => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function uiConfirm(msg) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'modal-mask';
      ov.innerHTML =
        '<div class="modal" style="max-width:340px">' +
          '<div class="modal-body" style="padding:18px 16px;font-size:14px;line-height:1.6">' + esc(msg).replace(/\n/g, '<br>') + '</div>' +
          '<div class="modal-foot" style="padding:0 16px 16px">' +
            '<button class="btn secondary" data-no>取消</button>' +
            '<button class="btn" data-yes>确定</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.classList.add('show');
      const done = v => { ov.remove(); resolve(v); };
      ov.addEventListener('click', e => {
        if (e.target === ov) done(false);
        if (e.target.closest('[data-no]')) done(false);
        if (e.target.closest('[data-yes]')) done(true);
      });
    });
  }

  // 危险操作专用：需用户输入指定文字才放行的二次确认（如彻底删除）。
  // 比单纯点「确定」多一道防误删屏障——必须原样输入 keyword 才能解锁「确定删除」按钮。
  function uiConfirmType(msg, keyword) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'modal-mask';
      ov.innerHTML =
        '<div class="modal" style="max-width:360px">' +
          '<div class="modal-body" style="padding:18px 16px;font-size:14px;line-height:1.6">' + esc(msg) +
            '<div style="margin-top:12px"><input id="ucfInput" type="text" autocomplete="off" spellcheck="false" ' +
              'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:8px;' +
              'font-size:14px;color:var(--ink);background:transparent" ' +
              'placeholder="请输入「' + esc(keyword) + '」以确认"></div>' +
          '</div>' +
          '<div class="modal-foot" style="padding:0 16px 16px">' +
            '<button class="btn secondary" data-no>取消</button>' +
            '<button class="btn danger" data-yes disabled>确定删除</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.classList.add('show');
      const input = ov.querySelector('#ucfInput');
      const yesBtn = ov.querySelector('[data-yes]');
      input.addEventListener('input', () => { yesBtn.disabled = input.value.trim() !== keyword; });
      const done = v => { ov.remove(); resolve(v); };
      ov.addEventListener('click', e => {
        if (e.target === ov) done(false);
        if (e.target.closest('[data-no]')) done(false);
        if (e.target.closest('[data-yes]') && !yesBtn.disabled) done(true);
      });
      setTimeout(() => input.focus(), 50);
    });
  }

  // 通用文本输入弹窗：返回用户输入字符串；点取消/遮罩返回 null。required=true 时为空不允许确认。
  function uiInput(title, placeholder, required) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'modal-mask';
      ov.innerHTML =
        '<div class="modal" style="max-width:380px">' +
          '<div class="modal-body" style="padding:18px 16px">' +
            '<div style="font-size:14px;font-weight:600;margin-bottom:10px">' + esc(title) + '</div>' +
            '<textarea id="uiInputArea" rows="3" placeholder="' + esc(placeholder || '') + '" ' +
              'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:8px;' +
              'font-size:14px;color:var(--ink);background:transparent;resize:vertical;font-family:inherit"></textarea>' +
          '</div>' +
          '<div class="modal-foot" style="padding:0 16px 16px">' +
            '<button class="btn secondary" data-no>取消</button>' +
            '<button class="btn danger" data-yes' + (required ? ' disabled' : '') + '>确定</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.classList.add('show');
      const area = ov.querySelector('#uiInputArea');
      const yesBtn = ov.querySelector('[data-yes]');
      if (required) area.addEventListener('input', () => { yesBtn.disabled = !area.value.trim(); });
      const done = v => { ov.remove(); resolve(v); };
      ov.addEventListener('click', e => {
        if (e.target === ov) done(null);
        if (e.target.closest('[data-no]')) done(null);
        if (e.target.closest('[data-yes]') && !yesBtn.disabled) done(area.value.trim());
      });
      setTimeout(() => area.focus(), 50);
    });
  }

  /* 校验「原因」：至少 4 个字，且不能仅用数字（含中文数字）替代，必须含文字说明。
     通用：取消订单 / 删除订单 / 删除客户 等需留痕操作共用。 */
  function validReason(s, label) {
    label = label || '原因';
    const CN_DIGITS = '零〇一二三四五六七八九十百千万两';
    const t = (s || '').trim();
    if (t.length < 4) return label + '至少需填写 4 个字';
    const core = t.split('').filter(c => !/[0-9]/.test(c) && !CN_DIGITS.includes(c) && !/\s/.test(c)).join('');
    if (core.length < 2) return label + '不能仅用数字替代，请填写文字说明';
    return null;
  }

  /* ---------- 应用内下拉刷新：仅当滚动到顶部下拉时触发，调用 refreshAll()（不重载页面，故不闪启动遮罩） ---------- */
  function bindPullRefresh() {
    const THRESHOLD = 60;
    const el = document.createElement('div');
    el.className = 'ptr-indicator';
    el.innerHTML = '<span class="ptr-spin"></span><span class="ptr-text">下拉刷新</span>';
    document.body.appendChild(el);
    const txt = () => el.querySelector('.ptr-text');
    let startX = 0, startY = 0, pull = 0, active = false, refreshing = false;

    // 当前是否打开了模态框/抽屉/下拉浮层等可滚动覆盖层
    function isInsideOverlay(el) {
      return !!(el && el.closest && el.closest('.modal-mask, .modal, .customer-suggest, .gs-result, .cst-list, .dropdown-list, .login-overlay'));
    }
    // 表格/列表等内容区滑动时不接管下拉刷新，避免滚动订单列表等时被截断
    function isInsideScrollContent(el) {
      return !!(el && el.closest && el.closest('table, tbody, thead, tr, td, th, .scrollable, .no-ptr'));
    }

    window.addEventListener('touchstart', (e) => {
      if (refreshing) return;
      // 在弹窗/抽屉/下拉浮层内部滑动时，全局下拉刷新不应接管，避免覆盖层滚动到底后继续下拉触发刷新
      if (isInsideOverlay(e.target) || isInsideScrollContent(e.target)) { active = false; return; }
      const root = getScrollRoot();
      startX = e.touches[0].clientX;
      if (root.scrollTop <= 0) { startY = e.touches[0].clientY; active = true; pull = 0; }
      else active = false;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!active || refreshing) return;
      if (isInsideOverlay(e.target) || isInsideScrollContent(e.target)) return;
      const root = getScrollRoot();
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      // 横向意图时让位给左右切菜单，不触发下拉刷新
      if (Math.abs(dx) > Math.abs(dy)) { el.classList.remove('show'); el.style.transform = ''; return; }
      if (dy > 0 && root.scrollTop <= 0) {
        pull = Math.min(dy * 0.5, 80);
        el.style.transform = 'translateX(-50%) translateY(' + (pull - 64) + 'px)';
        el.classList.add('show');
        txt().textContent = pull >= THRESHOLD ? '释放立即刷新' : '下拉刷新';
        if (e.cancelable) e.preventDefault(); // 阻止浏览器原生下拉重载
      } else {
        el.classList.remove('show');
        el.style.transform = '';
      }
    }, { passive: false });

    window.addEventListener('touchend', () => {
      if (!active) return;
      active = false;
      if (pull >= THRESHOLD) {
        refreshing = true;
        el.style.transform = 'translateX(-50%) translateY(0)';
        el.classList.add('refreshing');
        txt().textContent = '刷新中…';
        doRefresh(true).then(() => { txt().textContent = '已刷新'; })
          .catch(() => { txt().textContent = '刷新失败'; })
          .finally(() => {
            setTimeout(() => {
              refreshing = false;
              el.classList.remove('show', 'refreshing');
              el.style.transform = '';
            }, 450);
          });
      } else {
        el.classList.remove('show');
        el.style.transform = '';
      }
    });
  }

  /* ---------- 移动端左右滑动切换菜单（跟手 transform + 松手吸附；仅触摸设备） ----------
   * 横向意图时接管手势，手指位移实时驱动 #swipeTrack 的 translateX；
   * 滑动前预渲染相邻页（避免空白），松手按位移/速度吸附到相邻页；
   * 吸附动画结束后收起为 .active 单页显示，track 不留持久 transform（不污染内部 fixed 弹层）。
   * 与下拉刷新（纵向 dy>0）通过 |dx|>|dy| 天然区分，互不干扰。 */
  function bindSwipeTabs() {
    const track = $('#swipeTrack');
    if (!track) return;
    swipeLog('bindSwipeTabs attached');
    // 屏幕尺寸/方向变化（含跨 760px 阈值）：重对齐显隐并重新定位当前页
    // 同时处理 PWA 桌面窗口缩放后放大时内容不自适应的问题：
    //   窗口缩小后某些元素（Chart.js canvas、表格容器）拿到固定计算宽度，
    //   放大后浏览器不会自动重新计算 → 内容卡在窄宽度。此处强制 Chart.resize + 触发 reflow。
    let _rzT, _lastRzW = window.innerWidth;
    window.addEventListener('resize', () => {
      clearTimeout(_rzT);
      _rzT = setTimeout(() => {
        const newW = window.innerWidth;
        syncSwipeStripVisibility();
        if (isSwipeMode()) switchTabQuiet(state.tab);
        // 安全兜底：清除 #swipeTrack 残留的移动端 transform（跨 760px 阈值时尤其关键）
        if (track) { track.style.transform = ''; track.style.transition = ''; }
        // 强制所有 Chart.js 实例重绘（响应新容器尺寸）
        if (window.Chart && window.Chart.instances) {
          Object.values(window.Chart.instances).forEach(c => { try { c.resize(); } catch (_) {} });
        }
        // 窗口大幅变宽（>150px）时强制重渲染当前 tab：table-layout:fixed 表格、
        // Chart canvas 等元素在窄窗口时拿到固定计算宽度，放大后不会自动重算。
        if (newW - _lastRzW > 150) {
          renderTabContent(state.tab, { force: true }).catch(e => console.warn('resize 重渲染失败', e));
        }
        _lastRzW = newW;
        // 强制活跃 tab 内容区 reflow（消除固定计算宽度残留）
        const activeSec = document.querySelector('section.active');
        if (activeSec) { void activeSec.offsetHeight; }  // 触发 layout reflow
      }, 150);
    });
    const TH = 0.18; // 吸附阈值（占屏宽比例）
    let startX = 0, startY = 0, curIdx = 0, mode = null, tracking = false, prerendered = '', peerReady = true, lastMx = 0;

    window.addEventListener('touchstart', (e) => {
      if (!isSwipeMode()) return;
      swipeLog('touchstart', 'touches=' + e.touches.length, 'target=' + (e.target && e.target.tagName), 'isSwipeMode=' + isSwipeMode());
      if (e.touches.length !== 1) { mode = null; tracking = false; return; }
      // 内部可横向滚动/交互元素不触发切菜单，避免误触（表格、输入框、按钮、弹层等）
      if (e.target.closest && e.target.closest('table, .scroll-x, .no-swipe, input, textarea, select, button, a, .modal-mask')) { swipeLog('touchstart blocked by element'); mode = null; tracking = false; return; }
      tracking = true; mode = null; prerendered = ''; peerReady = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swipeLog('touchstart tracking', 'x=' + startX, 'y=' + startY);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!isSwipeMode()) return;
      if (!tracking) return;
      const mx = e.touches[0].clientX - startX;
      const my = e.touches[0].clientY - startY;
      lastMx = mx;
      if (mode === null) {
        swipeLog('touchmove decide', 'mx=' + mx, 'my=' + my);
        if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) {
          // 判定为横向滑动 -> 接管；先确保条带显隐正确（防初始未对齐或 CSS 缓存导致非 active 页隐藏）
          mode = 'h';
          syncSwipeStripVisibility();
          const vis = visibleTabs();
          curIdx = vis.indexOf(state.tab);
          const dir = mx < 0 ? 1 : -1; // 左滑(负) -> 下一页；右滑(正) -> 上一页
          const nb = vis[curIdx + dir];
          swipeLog('touchmove horizontal', 'curIdx=' + curIdx, 'dir=' + dir, 'neighbor=' + nb);
          // 临时展开相邻页；若邻居尚未渲染完成，先不跟随手指（避免空白），渲染完再跟手
          if (nb && nb !== prerendered) {
            const nbSec = document.getElementById('tab-' + nb);
            if (nbSec) {
              nbSec.classList.add('swipe-peer');
              void nbSec.offsetHeight; // 强制布局，让浏览器先绘制 peer 页再随 transform 移动
            }
            prerendered = nb;
            const alreadyOk = state._renderedOk && state._renderedOk.has(nb);
            if (!alreadyOk) {
              // 邻居还没渲染好：开始渲染并暂挂跟手，渲染完成前本帧不移动，避免空白闪出
              const p = renderTabContent(nb, { force: false, preload: false });
              peerReady = false;
              const done = () => {
                peerReady = true;
                // 渲染完成即刻把 track 定位到当前手指位置，衔接后续跟手（避免突兀跳变）
                const W = track.clientWidth;
                track.style.transform = 'translateX(' + (-curIdx * W + lastMx) + 'px)';
              };
              if (p && typeof p.then === 'function') p.then(done, done); else done();
              track.style.transition = 'none';
              if (e.cancelable) e.preventDefault(); // 等待期间仍拦截原生滚动，但不跟随手指
              return; // 本帧不移动，等邻居渲染完成
            }
          }
          track.style.transition = 'none';
        } else if (Math.abs(my) > Math.abs(mx)) {
          // 纵向意图 -> 放弃，交给页面内部纵向滚动
          swipeLog('touchmove vertical -> release');
          mode = 'v'; tracking = false; return;
        } else return;
      }
      // 邻居还在渲染中：本帧不跟随手指（已在上方面部 return 过，这里兜底），渲染完再滑动
      if (mode === 'h' && !peerReady) { if (e.cancelable) e.preventDefault(); return; }
      if (mode !== 'h') return;
      const W = track.clientWidth;
      let nx = -curIdx * W + mx;
      // 边界橡皮筋：首/尾页额外拉力衰减
      if ((curIdx === 0 && mx > 0) || (curIdx === visibleTabs().length - 1 && mx < 0)) nx = (-curIdx * W) + mx * 0.35;
      track.style.transform = 'translateX(' + nx + 'px)';
      swipeLog('touchmove transform', 'nx=' + nx, 'mx=' + mx, 'W=' + W);
      if (e.cancelable) e.preventDefault(); // 阻止页面原生横向回弹/纵向误滚
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      swipeLog('touchend', 'tracking=' + tracking, 'mode=' + mode);
      if (!tracking) { mode = null; return; }
      tracking = false;
      if (mode !== 'h') { swipeLog('touchend not horizontal'); mode = null; return; }
      mode = null;
      const vis = visibleTabs();
      const W = track.clientWidth;
      const mx = e.changedTouches[0].clientX - startX;
      let target = curIdx;
      if (mx < -W * TH && curIdx < vis.length - 1) target = curIdx + 1;       // 左滑过阈值 -> 下一页
      else if (mx > W * TH && curIdx > 0) target = curIdx - 1;                // 右滑过阈值 -> 上一页
      const tab = vis[target];
      swipeLog('touchend snap', 'mx=' + mx, 'W=' + W, 'target=' + target, 'tab=' + tab);
      // 顶部高亮 + 状态
      $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      state.tab = tab;
      // 吸附动画（用 px，与跟手连贯，避免 % 跳变）
      track.style.transition = 'transform .28s cubic-bezier(.22,.61,.36,1)';
      track.style.transform = 'translateX(' + (-target * W) + 'px)';
      // 动画结束后仅保留目标页 .active（保留定位 transform，弹窗在 track 外不受影响）
      setTimeout(() => {
        track.style.transition = 'none';
        $$('#swipeTrack > section').forEach(s => {
          s.classList.toggle('active', s.id === 'tab-' + tab);
          s.classList.remove('swipe-peer');
        });
        syncSwipeStripVisibility();
        applyPermissions();
        ensureTabRendered(tab);
        updateSwipeDiag();
      }, 320);
    });
  }

  /* ---------- 自动派单巡检：每 60 秒检查一次，接单超过 5 分钟且已指定设计师+截稿时间的订单自动推进到派单 ---------- */
  async function checkAutoDispatch() {
    const st = state._settings || {};
    if (!st.auto_dispatch) return;
    if (state._autoCheckBusy) return; // 防并发（上次检查未结束则跳过本轮）
    state._autoCheckBusy = true;
    try {
      const orders = await DB.listOrders();
      const now = new Date();
      const mins = (st.auto_dispatch_minutes != null ? st.auto_dispatch_minutes : 5);
      const waitMs = mins * 60 * 1000;
      let dispatched = 0;
      for (const o of orders) {
        if (o.status !== '接单') continue;
        if (!o.assigned_designer_id || !o.deadline) continue;
        if (!o.intake_at) continue;
        if (now - new Date(o.intake_at) < waitMs) continue;
        applyFlowAction(o, 'dispatch', { designerId: o.assigned_designer_id, deadline: o.deadline, by: '系统' });
        await DB.saveOrder(o);
        logOp('超时自动派单', '订单', o.id, o.order_no, 'dispatch');
        dispatched++;
      }
      if (dispatched > 0) {
        state._orders = orders;
        await refreshAll();
        toast('系统已自动派单 ' + dispatched + ' 个超时订单');
      }
    } catch (e) {
      console.warn('[自动派单巡检] 出错:', e);
    } finally {
      state._autoCheckBusy = false;
    }
  }

  function bindGlobal() {
    // 全局事件探测：仅 ?debug=1 时绑定，用于诊断扩展/遮罩拦截事件问题；默认不挂载，零性能影响
    if (/[?&]debug=1\b/.test(location.search)) {
      document.addEventListener('click', e => {
        swipeLog('DOCUMENT click', e.target.tagName, e.target.className, e.target.id);
      }, true);
      document.addEventListener('touchstart', e => {
        swipeLog('DOCUMENT touchstart', 'touches=' + e.touches.length, 'target=' + e.target.tagName, 'class=' + e.target.className, 'id=' + e.target.id);
      }, true);
    }
    bindPullRefresh();
    bindSwipeTabs();
    $('#btnRefresh').addEventListener('click', () => {
      doRefresh().catch(e => toast('刷新失败：' + (e && e.message || e)));
    });
    // 顶部同步时钟每 1 秒走一次（仅刷新文本，不重新查云端）
    if (!state._clockTimer) state._clockTimer = setInterval(updateSync, 1000);
    // 自动派单巡检：每 60 秒扫一次，接单超过 5 分钟且已指定设计师+截稿时间的自动派单
    if (!state._autoTimer) state._autoTimer = setInterval(() => checkAutoDispatch().catch(() => {}), 60000);
    $('#btnDashRefresh').addEventListener('click', () => {
      doRefresh().catch(e => toast('刷新失败：' + (e && e.message || e)));
    });
    // 不允许点击遮罩关闭弹窗，避免误触；只能通过弹窗内的关闭/取消/保存按钮关闭
    // $('#modalMask').addEventListener('click', e => { if (e.target.id === 'modalMask') closeModal(); });
    // 订单
    $('#btnNewOrder').addEventListener('click', newOrder);
    $('#btnExportOrders').addEventListener('click', exportOrdersCSV);
    // 下拉/搜索自动筛选（关键字防抖 200ms）；任何筛选变化都回到第 1 页
    let kwTimer;
    const autoFilter = () => { state.orderPage = 1; state._overdueOnly = false; state._dueTodayOnly = false; state._riskOnly = false; readFilters(); renderOrders(); };
    ['fStatus', 'fDesigner', 'fCustomer', 'fCategory', 'fTaskType'].forEach(id => {
      $('#' + id).addEventListener('change', autoFilter);
    });
    // 手动改日期 → 视为自定义范围，并把快捷下拉切到「自定义」
    ['fDateFrom', 'fDateTo'].forEach(id => {
      $('#' + id).addEventListener('change', () => {
        const fr = $('#fRange'); if (fr) fr.value = 'custom';
        toggleCustomDate(true);
        autoFilter();
      });
    });
    $('#fKeyword').addEventListener('input', () => {
      clearTimeout(kwTimer);
      kwTimer = setTimeout(autoFilter, 200);
    });
    // 快捷时间范围（本月/上月/近3月/全部）
    const $range = $('#fRange');
    if ($range) $range.addEventListener('change', () => {
      state.orderPage = 1; state._riskOnly = false; setQuickRange($range.value); renderOrders(); updateFilterBadge();
    });
    // 排序方向（最新优先/最早优先）——统一写入列排序状态
    const $sort = $('#fSort');
    if ($sort) $sort.addEventListener('change', () => {
      state.orderSort = { key: 'intake_at', dir: $sort.value }; state.orderPage = 1; renderOrders();
    });
    $('#btnResetFilter').addEventListener('click', () => {
      state.filters = {};
      state.orderPage = 1;
      state._overdueOnly = false; state._dueTodayOnly = false; state._riskOnly = false;
      ['fStatus','fDesigner','fCustomer','fCategory','fTaskType','fDateFrom','fDateTo','fKeyword'].forEach(id => { $('#' + id).value = ''; });
      const fr = $('#fRange'); if (fr) fr.value = 'all';
      renderOrders(); updateFilterBadge();
    });
    // 筛选面板折叠/展开（仅移动端生效，桌面端始终展示）
    const $toggle = $('#btnToggleFilter');
    if ($toggle) {
      $toggle.addEventListener('click', () => {
        const $main = $toggle.closest('.toolbar-main');
        if (!$main) return;
        // 用 class 切换，避免内联 style 被 CSS 的 !important 规则压制
        const open = $main.classList.toggle('show-filters');
        $toggle.style.background = open ? 'var(--primary)' : '';
        $toggle.style.color = open ? '#fff' : '';
        $toggle.style.borderColor = open ? 'var(--primary)' : '';
      });
    }
    // 筛选项变化时更新角标
    ['fStatus', 'fDesigner', 'fCustomer', 'fCategory', 'fTaskType', 'fDateFrom', 'fDateTo'].forEach(id => {
      $('#' + id).addEventListener('change', updateFilterBadge);
    });
    // 设计师管理（在设置页）
    $('#btnAddDesigner').addEventListener('click', addDesigner);
    $('#btnAddGroup').addEventListener('click', addGroup);
    $('#btnCloseGroupEdit').addEventListener('click', closeGroupEdit);
    $('#btnGroupAddMember').addEventListener('click', addMemberToGroup);
    $('#btnDeleteGroup').addEventListener('click', async () => {
      if (!editingGroupId) return;
      if (!can('groups_delete')) { toast('无权限删除分组'); return; }
      if (!lockOp('delGroup:' + editingGroupId)) return;
      try {
        if (!(await uiConfirm('删除分组？分组内人员将变为未分组。'))) return;
        await DB.deleteGroup(editingGroupId);
        toast('已删除');
        closeGroupEdit();
        await refreshAll();
      } finally { unlockOp('delGroup:' + editingGroupId); }
    });
    // 工作台
    $('#wDesigner').addEventListener('change', () => { state.currentDesignerId = $('#wDesigner').value; renderWorkbench(); });
    // 工作台视图切换：个人视图 / 团队看板
    const wbVT = $('#wbViewToggle');
    if (wbVT) wbVT.addEventListener('click', e => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      state.wbView = b.dataset.view;
      $$('#wbViewToggle .wb-view-btn').forEach(x => x.classList.toggle('active', x === b));
      renderWorkbench();
    });
    // 工作台筛选
    ['wbStatus', 'wbPeriod'].forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('change', renderWorkbench);
    });
    // 工作台：自动隐藏已完成（定稿满1天）
    const wbHide = $('#wbAutoHide');
    if (wbHide) {
      wbHide.addEventListener('change', e => { state.autoHideFinalized = e.target.checked; renderWorkbench(); });
      wbHide.checked = state.autoHideFinalized;
    }
    // 经营分析
    $('#anaModeGroup').addEventListener('click', async e => {
      const b = e.target.closest('button[data-mode]');
      if (!b || b.dataset.mode === state.anaMode) return;
      state.anaMode = b.dataset.mode;
      updatePeriodButtons('#anaModeGroup', state.anaMode);
      $('#anaRangeBox').style.display = state.anaMode === 'custom' ? '' : 'none';
      const g = $('#anaModeGroup');
      g.classList.add('loading');
      try { await renderAnalytics(); }
      catch (err) { toast('切换失败：' + (err && err.message || err)); }
      finally { g.classList.remove('loading'); }
    });
    $('#anaRangeBox').style.display = state.anaMode === 'custom' ? '' : 'none';
    // 仪表盘/经营分析：本期/上期切换
    $('#dashPeriodGroup').addEventListener('click', async e => {
      const b = e.target.closest('button[data-period]');
      if (!b || b.dataset.period === state.dashboardPeriod) return;
      state.dashboardPeriod = b.dataset.period;
      updatePeriodButtons('#dashPeriodGroup', state.dashboardPeriod);
      const g = $('#dashPeriodGroup');
      g.classList.add('loading');
      try { await renderDashboard(); }
      catch (err) { toast('切换失败：' + (err && err.message || err)); }
      finally { g.classList.remove('loading'); }
    });
    updatePeriodButtons('#dashPeriodGroup', state.dashboardPeriod);
    updatePeriodButtons('#anaModeGroup', state.anaMode);
    // 自定义日期选择器
    initDatePicker();
    // 自定义下拉（替换原生 select）
    observeSelects();
    $('#btnAnaRefresh').addEventListener('click', renderAnalytics);
    $('#btnAnaMonth').addEventListener('click', renderConcurrencyDaily);
    $('#anaMonth').addEventListener('change', renderConcurrencyDaily);
    // 客户
    $('#btnNewCustomer').addEventListener('click', newCustomer);
    // 经营分析导出
    $('#btnAnaCSV').addEventListener('click', exportAnaCSV);
    // 设置
    $('#btnSaveParams').addEventListener('click', saveParams);
    $('#btnExportAll').addEventListener('click', exportAll);
    // 操作日志：查询按钮 + 筛选条件变更即刷新
    const bq = $('#btnLogQuery'); if (bq) bq.addEventListener('click', renderOpLogs);
    ['logDesigner', 'logAction', 'logFrom', 'logTo'].forEach(id => {
      const el = $('#' + id); if (el) el.addEventListener('change', renderOpLogs);
    });
    // 操作日志下拉框：桌面端兜底防压缩；移动端由 css/styles.css 媒体查询排两列
    (() => {
      const s = document.createElement('style');
      s.textContent = '@media (min-width: 481px) { ' +
        '.log-filters .field, .log-filters .field select, .log-filters .field input { flex: 0 0 auto !important; }' +
        '.log-filters .field select, .log-filters .field input { width: 240px !important; min-width: 240px !important; }' +
        '}';
      document.head.appendChild(s);
    })();

    // 全局搜索（订单 / 客户）
    const gs = $('#globalSearch'), gsRes = $('#globalSearchResult');
    if (gs) {
      const doSearch = () => renderGlobalSearch(gs.value.trim());
      gs.addEventListener('input', doSearch);
      gs.addEventListener('focus', () => { if (gs.value.trim()) doSearch(); });
      document.addEventListener('click', e => { if (!e.target.closest('.topbar-search')) gsRes.style.display = 'none'; });
    }
    // 顶栏逾期角标 → 跳订单列表逾期筛选
    const ob = $('#overdueBadge');
    if (ob) ob.addEventListener('click', () => gotoOrders('overdue=1'));
    // 初始化「接单时间」日期输入框显隐（仅自定义范围时显示）
    const frInit = $('#fRange');
    if (frInit) toggleCustomDate(frInit.value === 'custom');

    // 系统深色/浅色主题切换时，若当前在图表页则自动重绘以应用新配色
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) {
        mq.addEventListener('change', () => {
          if (state.tab === 'dashboard') renderDashboard();
          if (state.tab === 'analytics') renderAnalytics();
        });
      }
    }

    // ===== PWA 后台恢复：前台可见时重拉云端数据并重渲染 =====
    let _fgWasHidden = false;
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) { _fgWasHidden = true; return; }
      if (!_fgWasHidden || !state.currentUser) return;
      _fgWasHidden = false;
      try {
        await DB.reload();
        await loadData();
        updateSync();
        if (state.tab) switchTab(state.tab, { render: true });
        checkAutoDispatch().catch(() => {});
      } catch (e) { console.warn('前台恢复失败（网络可能仍不可用）', e); }
    });
    // bfcache 恢复（iOS Safari 长时间后台后切回前台，event.persisted === true）
    window.addEventListener('pageshow', async (e) => {
      if (!e.persisted || !state.currentUser) return;
      try {
        await DB.reload();
        await loadData();
        updateSync();
        if (state.tab) switchTab(state.tab, { render: true });
        checkAutoDispatch().catch(() => {});
      } catch (e) { console.warn('bfcache 恢复失败', e); }
    });
  }

  function fillSelects() {
    const ds = state._designers || [], cs = state._customers || [];
    // 订单筛选：只显示参与设计的人，但保留当前已筛选项（历史数据兼容）
    fill('#fDesigner', ds.filter(d => isActiveDesign(d) || d.id === state.filters.designerId).map(d => [d.id, d.name]), state.filters.designerId);
    fill('#fCustomer', cs.map(c => [c.id, c.name]), state.filters.customerId);
    fill('#fStatus', Object.keys(window.Cfg.STATUS).map(s => [s, s]), state.filters.status);
    fill('#fCategory', [['小单','小单'],['普通','普通'],['大单','大单']], state.filters.category);
    fill('#fTaskType', window.Cfg.TASK_TYPES.map(t => [t, t]), state.filters.taskType);
    // 日期输入直接赋值
    const df = $('#fDateFrom'), dt = $('#fDateTo');
    if (df) df.value = state.filters.dateFrom || '';
    if (dt) dt.value = state.filters.dateTo || '';
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

  // 更新分段按钮组（本期/上期/自定义 或 本期/上期）的激活状态
  function updatePeriodButtons(groupSelector, value) {
    const group = $(groupSelector);
    if (!group) return;
    $$('button[data-period], button[data-mode]', group).forEach(b => {
      const key = b.hasAttribute('data-period') ? 'period' : 'mode';
      const active = b.dataset[key] === value;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  /* ============================================================
   * 仪表盘
   * ============================================================ */
  async function renderDashboard() {
    const reportMonth = state.dashboardPeriod === 'previous'
      ? window.Calc.addMonths(new Date(), -1)
      : new Date();
    const sum = await window.Calc.dashboardSummary(reportMonth);
    const win = sum.win;
    const periodLabel = state.dashboardPeriod === 'previous' ? '上期' : '本期';
    $('#dashWindow').textContent = periodLabel + '考核窗口：' + fmtTime(win.start).slice(0, 10) + ' ~ ' + fmtTime(win.end).slice(0, 10);
    const c = sum.counts;
    // KPI 卡片（图标+左侧色条+横向布局）
    const kpi = (label, value, hint, icon, accent) =>
      '<div class="kpi" data-accent="' + (accent || '#6366f1') + '">' +
        '<div class="kpi-icon">' + (icon || '📊') + '</div>' +
        '<div class="kpi-body"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="hint">' + hint + '</div></div>' +
      '</div>';
    $('#kpiGrid').innerHTML =
      kpi('总接单量', c.orders, '全部订单累计', '📋', '#6366f1') +
      kpi('客户 / 复购', c.customers + ' / ' + c.repeat, '复购=下单≥2次', '🔄', '#f59e0b') +
      kpi(periodLabel + '订单数', c.winOrders, '考核期内接单数', '📦', '#0ea5e9') +
      kpi(periodLabel + '应收', '¥' + money(c.totalRevenue), '考核期内应收合计', '💰', '#f59e0b') +
      kpi('活跃设计师', c.designers, '在岗人数', '👥', '#8b5cf6');

    // 应用 KPI 主题色
    $$('#kpiGrid .kpi[data-accent]').forEach(el => {
      const color = el.dataset.accent;
      el.style.setProperty('--kpi-accent', color);
      el.style.setProperty('--kpi-bg', color + '18');
    });

    // 待办 / 逾期面板：进系统第一眼看到「该干什么」
    const allO = sum.orders;
    const nowTs = Date.now();
    const tdy = new Date().toISOString().slice(0, 10);
    const isFin = s => s === '已定稿' || s === '已换人';
    const todo = [
      ['待派单', allO.filter(o => o.status === '接单').length, 'status=接单'],
      ['待提案', allO.filter(o => o.status === '派单').length, 'status=派单'],
      ['今日截稿', allO.filter(o => o.deadline && o.deadline.slice(0, 10) === tdy && !isFin(o.status)).length, 'due=today'],
      ['风险预警', allO.filter(o => { const r = riskInfo(o); return r.level === 'red' && !isFin(o.status); }).length, 'risk=red'],
      ['已逾期', allO.filter(o => o.deadline && new Date(o.deadline).getTime() < nowTs && !isFin(o.status)).length, 'overdue=1']
    ];
    $('#dashTodo').innerHTML = todo.map(t =>
      '<button class="todo-card' + ((t[2] === 'overdue=1' || t[2] === 'risk=red') && t[1] ? ' danger' : '') + '" data-todo="' + t[2] + '">' +
      '<div class="todo-num">' + t[1] + '</div><div class="todo-label">' + t[0] + '</div></button>'
    ).join('');
    $$('#dashTodo [data-todo]').forEach(b => b.addEventListener('click', () => gotoOrders(b.dataset.todo)));

    // 图表（最后才加载图库：上面文字数字已即时上屏，图库加载/解析不阻塞仪表盘可见性）
    await ensureChartLib();
    const ds = sum.designerPerf;
    const names = ds.map((d, i) => {
      const raw = d && d.designerName;
      const s = String(raw != null ? raw : '').trim();
      return s && s !== '0' ? s : '设计师' + (i + 1);
    });
    const revenue = ds.map(d => {
      return sum.orders.filter(o => window.Cfg.participants(o).includes(d.designerId) && window.Calc.inWindow(o, win))
        .reduce((s, o) => s + (window.Cfg.revenueSplit(o, state._settings || {})[d.designerId] || 0), 0);
    });
    Charts.bar($('#chartPerf'), {
      title: '设计师业绩（' + periodLabel + '应收）', horizontal: true,
      labels: names,
      datasets: [
        { label: '应收(元)', data: revenue.map(v => Math.round(v)), color: '#4f46e5' }
      ]
    });
    Charts.bar($('#chartRate'), {
      title: '定稿率 / 完成率', horizontal: false,
      labels: names,
      datasets: [
        { label: '定稿率(%)', data: ds.map(d => Math.round(d.rate * 1000) / 10), color: '#06b6d4' },
        { label: '完成率(%)', data: ds.map(d => Math.round(d.completion * 1000) / 10), color: '#f59e0b' }
      ]
    });
    // 窗口内分布（随本期/上期切换）
    const swd = sum.statusDistWin, swk = Object.keys(swd);
    const TYPE_COLOR = { '小单': '#64748b', '普通': '#0ea5e9', '大单': '#8b5cf6' };
    Charts.doughnut($('#chartStatusWin'), { title: '订单状态分布（' + periodLabel + '窗口）', labels: swk, values: swk.map(k => swd[k]), colors: swk.map(k => (window.Cfg.STATUS[k] || {}).color || '#64748b') });
    const twd = sum.typeDistWin, twk = Object.keys(twd);
    Charts.doughnut($('#chartTypeWin'), { title: '订单类型分布（' + periodLabel + '窗口）', labels: twk, values: twk.map(k => twd[k]), colors: twk.map(k => TYPE_COLOR[k] || '#64748b') });
    // 全部累计分布（不随窗口切换）
    const sd = sum.statusDist, sk = Object.keys(sd);
    Charts.doughnut($('#chartStatus'), { title: '订单状态分布（全部累计）', labels: sk, values: sk.map(k => sd[k]), colors: sk.map(k => (window.Cfg.STATUS[k] || {}).color || '#64748b') });
    const td = sum.typeDist, tk = Object.keys(td);
    Charts.doughnut($('#chartType'), { title: '订单类型分布（全部累计）', labels: tk, values: tk.map(k => td[k]), colors: tk.map(k => TYPE_COLOR[k] || '#64748b') });

    // 速览表
    $('#dashPerfTable').innerHTML =
      '<thead><tr><th>设计师</th><th>接单</th><th>定稿数</th><th>定稿率</th><th>完成率</th><th>系数</th><th>小单</th></tr></thead><tbody>' +
      (ds.length ? ds.map(d =>
        '<tr><td>' + esc(d.designerName) + '</td><td>' + d.total + '</td><td>' + d.finalizedCount + '</td><td>' + pct(d.rate) +
        '</td><td>' + pct(d.completion) + '</td><td>' + d.coef + '</td><td>' + d.smallCount + '</td></tr>'
      ).join('') : '<tr><td colspan="7" class="empty">暂无数据，请先在“设计师”与“订单”中录入</td></tr>') + '</tbody>';
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
      customerId: $('#fCustomer').value, keyword: $('#fKeyword').value,
      category: $('#fCategory').value, taskType: $('#fTaskType').value,
      dateFrom: $('#fDateFrom').value, dateTo: $('#fDateTo').value
    };
  }
  // 把日期输入框（fDateFrom/fDateTo）按快捷范围写入，并同步 state.filters（不触发重渲染）
  function toggleCustomDate(show) {
    const g = $('#customDateGroup');
    if (g) g.classList.toggle('show', !!show);
  }
  function setQuickRange(val) {
    const now = new Date();
    let from = '', to = '';
    const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (val === 'month') { from = ymd(new Date(now.getFullYear(), now.getMonth(), 1)); to = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)); }
    else if (val === 'lastmonth') { from = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)); to = ymd(new Date(now.getFullYear(), now.getMonth(), 0)); }
    else if (val === '3m') { const d = new Date(now); d.setMonth(d.getMonth() - 3); from = ymd(d); to = ymd(now); }
    else if (val === 'current' || val === 'previous') {
      const ref = val === 'previous' ? window.Calc.addMonths(now, -1) : now;
      const win = window.Calc.windowOf(ref, state._settings || {});
      from = ymd(win.start); to = ymd(win.end);
    }
    const df = $('#fDateFrom'), dt = $('#fDateTo');
    if (df) df.value = from; if (dt) dt.value = to;
    const fr = $('#fRange'); if (fr) fr.value = val;
    toggleCustomDate(val === 'custom');
    readFilters();
  }
  async function renderOrders() {
    const sec = $('#tab-orders');
    // 首次进入：默认显示「全部」订单；用户可通过时间范围快捷筛选切换
    if (!state._ordersDefaulted) { setQuickRange('all'); state._ordersDefaulted = true; }
    // 数据范围：能否看全部由 isViewAll()（权限点 view_all_orders）决定；设计师默认仅本人，可由管理员开启
    let list = await DB.listOrders(state.filters || {});
    if (!isViewAll() && state.currentUser) {
      const me = state.currentUser.id;
      list = list.filter(o => window.Cfg.participants(o).includes(me) || tempAssistIds(o).includes(me));
    }
    let orders = list;
    // 列排序（默认按接单时间倒序）
    orders.sort((a, b) => cmpOrders(a, b, state.orderSort.key, state.orderSort.dir));
    // 待办面板联动筛选：仅逾期 / 仅今日截稿 / 仅红色风险
    if (state._overdueOnly) orders = orders.filter(o => o.deadline && new Date(o.deadline).getTime() < Date.now() && !isFinishedStatus(o.status));
    if (state._dueTodayOnly) { const t = new Date().toISOString().slice(0, 10); orders = orders.filter(o => o.deadline && o.deadline.slice(0, 10) === t); }
    if (state._riskOnly) orders = orders.filter(o => { const r = riskInfo(o); return r.level === 'red' && !isFinishedStatus(o.status); });
    // 分页：每页条数取用户自定义的 orderPageSize（默认 ORDER_PAGE_SIZE），避免几千行一次性渲染导致卡顿
    const pageSize = state.orderPageSize || ORDER_PAGE_SIZE;
    const total = orders.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (state.orderPage < 1) state.orderPage = 1;
    if (state.orderPage > totalPages) state.orderPage = totalPages;
    const page = state.orderPage;
    const start = (page - 1) * pageSize;
    const pageItems = orders.slice(start, start + pageSize);
    const dsMap = Object.fromEntries((state._designers || []).map(d => [d.id, d.name]));
    const rows = pageItems.map(o => {
      const cat = window.Cfg.orderCategory(Number(o.amount) || 0, state._settings);
      const collabNames = (Array.isArray(o.collab_designer_ids) ? o.collab_designer_ids : [])
        .map(id => dsMap[id]).filter(Boolean);
      const taNames = (Array.isArray(o.temp_assist_log) ? o.temp_assist_log : [])
        .map(r => r && r.name).filter(Boolean);
      const designerCell = (esc(dsMap[o.assigned_designer_id]) || softBadge('#64748b', '未派')) +
        (collabNames.length ? ' <span class="collab-tag">+' + collabNames.map(esc).join('/') + '</span>' : '') +
        (taNames.length ? ' <span class="collab-tag ta-tag">🤝' + taNames.map(esc).join('/') + '</span>' : '');
      const reworkCell = o.rework_category
        ? ' <span class="badge ' + (o.rework_category === '设计原因' ? 'bad' : 'warn') + '">' + esc(o.rework_category) + '</span>' : '';
      return '<tr data-id="' + o.id + '">' +
        '<td>' + esc(o.order_no || '') + '</td>' +
        '<td>' + esc(o.title) + (o.notes ? ' <span title="' + esc(o.notes) + '">📝</span>' : '') + '</td>' +
        '<td>' + esc(o.customer_name || '') + '</td>' +
        '<td>' + esc(o.task_type) + '</td>' +
        '<td class="num">¥' + money(o.amount) + '</td>' +
        '<td class="center">' + catPill(cat) + (o.complaint_count ? ' <span class="badge bad">投诉' + o.complaint_count + '</span>' : '') + '</td>' +
        '<td>' + designerCell + reworkCell + '</td>' +
        '<td class="center">' + pill(o.status) + '</td>' +
        '<td>' + fmtDeadline(o.deadline) + '</td>' +
        '<td class="center">' + riskBadge(o) + '</td>' +
        '<td class="center"><button class="btn sm secondary" data-act="open" data-id="' + o.id + '">流程/详情</button> ' +
        '<button class="btn sm danger" data-act="del" data-id="' + o.id + '" data-perm="orders_delete">删除</button></td>' +
        '</tr>';
    }).join('');
    const sk = state.orderSort.key, sd = state.orderSort.dir;
    const sortable = (key, label, cls) => '<th class="' + (cls || '') + (key ? ' sortable' : '') + (key === sk ? ' sorted' : '') + '"' + (key ? ' data-sort="' + key + '"' : '') + '>' + label + (key === sk ? (sd === 'asc' ? ' ▲' : ' ▼') : '') + '</th>';
    $('#ordersTable').innerHTML =
      '<thead><tr>' +
      sortable('order_no', '单号') + sortable('title', '项目') + sortable('customer_name', '客户') +
      sortable('task_type', '类型') + sortable('amount', '金额', 'num') + sortable('category', '分类', 'center') +
      '<th>设计师</th>' +       sortable('status', '状态', 'center') + sortable('deadline', '截稿') +
      '<th class="center">风险</th>' +
      '<th class="center">操作</th></tr></thead><tbody>' +
      (pageItems.length ? rows :
        '<tr><td colspan="11" class="empty">' +
        '当前条件下暂无订单' +
        '</td></tr>') + '</tbody>';
    // 使用事件委托绑定操作列按钮，避免 innerHTML 重绘后事件丢失
    const table = $('#ordersTable');
    if (!table._actBound) {
      table.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (b) { e.stopPropagation(); if (b.dataset.act === 'open') openOrder(b.dataset.id); if (b.dataset.act === 'del') delOrder(b.dataset.id); return; }
        const th = e.target.closest('[data-sort]'); if (th) { toggleOrderSort(th.dataset.sort); return; }
        const row = e.target.closest('tr[data-id]'); if (row) openOrder(row.dataset.id);
      });
      table._actBound = true;
    }
    // 红色风险筛选提示条
    const rbar = $('#ordersRiskBar');
    if (rbar) {
      if (state._riskOnly) {
        rbar.style.display = '';
        rbar.innerHTML = '🔴 仅显示红色风险单（已逾期/预计超期）· <a href="javascript:;" id="clearRiskFilter">清除筛选</a>';
        const cl = $('#clearRiskFilter');
        if (cl) cl.addEventListener('click', () => { state._riskOnly = false; renderOrders(); });
      } else {
        rbar.style.display = 'none';
      }
    }
    renderOrdersPager(total, page, totalPages);
    applyPermissions();
    updateSwipeDiag();
  }

  // 订单列表分页控件
  function renderOrdersPager(total, page, totalPages) {
    const pg = $('#ordersPager');
    if (!pg) return;
    pg._totalPages = totalPages;
    if (total <= 0) { pg.innerHTML = ''; return; }
    const curSize = state.orderPageSize || ORDER_PAGE_SIZE;
    const sizeOptions = [20, 50, 100, 200];
    const sizeCtl = '<button class="btn sm page-size-btn" data-ps="orders">每页 ' + curSize + ' 条 ▼</button>';
    pg.innerHTML =
      '<span class="pager-info">共 ' + total + ' 单 · 第 ' + page + ' / ' + totalPages + ' 页</span>' +
      sizeCtl +
      '<button class="btn sm" data-pg="first"' + (page <= 1 ? ' disabled' : '') + '>« 首页</button>' +
      '<button class="btn sm" data-pg="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<button class="btn sm" data-pg="next"' + (page >= totalPages ? ' disabled' : '') + '>下一页</button>' +
      '<button class="btn sm" data-pg="last"' + (page >= totalPages ? ' disabled' : '') + '>末页 »</button>';
    if (!pg._bound) {
      pg.addEventListener('click', e => {
        const btn = e.target.closest('.page-size-btn');
        if (btn && btn.dataset.ps === 'orders') {
          showPageSizePicker({ current: state.orderPageSize || ORDER_PAGE_SIZE, options: sizeOptions, anchor: btn, placement: 'top', onSelect: v => {
            state.orderPageSize = v;
            try { localStorage.setItem('ds_order_pagesize', String(v)); } catch (err) {}
            state.orderPage = 1; renderOrders();
          }});
          return;
        }
        const b = e.target.closest('[data-pg]');
        if (!b || b.disabled) return;
        const tp = pg._totalPages || 1;
        if (b.dataset.pg === 'first') state.orderPage = 1;
        else if (b.dataset.pg === 'prev') state.orderPage = Math.max(1, state.orderPage - 1);
        else if (b.dataset.pg === 'next') state.orderPage = Math.min(tp, state.orderPage + 1);
        else if (b.dataset.pg === 'last') state.orderPage = tp;
        renderOrders();
      });
      pg._bound = true;
    }
  }

  async function newOrder() {
    const no = await DB.genOrderNo();
    state.editingOrder = {
      id: null, order_no: no, title: '', customer_id: '', customer_name: '',
      task_type: '名片', amount: 0, status: '接单', assigned_designer_id: (state.currentUser && state.currentUser.role === '设计师') ? state.currentUser.id : '',
      revision_count: 0, is_finalized: false, revision_note: '',
      intake_at: new Date().toISOString(), dispatch_at: null, deadline: null,
      design_started_at: null, draft_at: null, feedback_at: null,
      feedback_failed_at: null, feedback_pass_at: null,
      revision_at: null, redraft_at: null, finalized_at: null,
      switched_at: null, switch_reason: '', notes: '',
      proposal_log: [], proposal_failed_log: [], draft_log: [], revision_log: [],
      redraft_log: [], feedback_failed_log: []
    };
    // 恢复上次未保存的草稿
    const draft = loadOrderDraft();
    if (draft) {
      state.editingOrder.title = draft.title || '';
      state.editingOrder.customer_id = draft.customer_id || '';
      state.editingOrder.task_type = draft.task_type || '名片';
      state.editingOrder.amount = draft.amount || 0;
      state.editingOrder.assigned_designer_id = draft.assigned_designer_id || '';
      state.editingOrder.deadline = draft.deadline ? fromLocalInput(draft.deadline) : null;
      state.editingOrder.notes = draft.notes || '';
      state.editingOrder.file_paths = (draft.file_paths || '').split('\n').map(l => normalizePath(l)).filter(Boolean);
      state.editingOrder.design_paths = (draft.design_paths || '').split('\n').map(l => normalizePath(l)).filter(Boolean);
      state.editingOrder.collab_designer_ids = draft.collab || [];
      state._orderDraftRestored = true;
      state._orderDraftTs = draft.ts;
      state._orderDraftNewCust = (draft.customer_id === '__new__' && draft.newCust && draft.newCust.name) ? draft.newCust : null;
    } else {
      state._orderDraftRestored = false;
      state._orderDraftTs = null;
      state._orderDraftNewCust = null;
      // 新建订单默认截稿：从今天起算 default_deadline_days 天，固定 18:00（设置页可配，默认 1 天=明天）
      const defs = window.Cfg.DEFAULT_SETTINGS || {};
      const sset = (state._settings && typeof state._settings === 'object') ? state._settings : {};
      const dlDays = (sset.default_deadline_days != null ? sset.default_deadline_days
        : (defs.default_deadline_days != null ? defs.default_deadline_days : 1));
      const tmr = new Date();
      tmr.setDate(tmr.getDate() + (Number(dlDays) || 1));
      tmr.setHours(18, 0, 0, 0);
      state.editingOrder.deadline = tmr.toISOString();
    }
    renderOrderModal();
  }
  // 从客户列表/详情「为该客户新建订单」：复用 newOrder 构造默认订单，再预填客户并打开弹窗
  async function newOrderForCustomer(cid) {
    const c = (state._customers || []).find(x => x.id === cid);
    await newOrder();
    if (c) {
      state.editingOrder.customer_id = c.id;
      state.editingOrder.customer_name = c.name;
    }
    renderOrderModal();
  }
  async function openOrder(id) {
    const o = (state._orders || []).find(x => x.id === id);
    if (!o) return;
    state.editingOrder = Object.assign({}, o);
    renderOrderModal();
  }

  function customerInfoHtml(cs, customerId, compact) {
    if (!customerId || customerId === '__new__') return '<span style="color:var(--muted)">请选择客户或新建客户</span>';
    const c = (cs || []).find(x => x.id === customerId);
    if (!c) return '<span style="color:var(--muted)">客户未找到</span>';
    const extra = Array.isArray(c.contacts_json) ? c.contacts_json : [];
    // 当前订单选中的联系人（从编辑中订单取）
    const o = state.editingOrder;
    const selContactName = o ? (o._contactName || '') : '';
    if (compact) {
      const parts = [];
      parts.push('<b>' + esc(c.name) + '</b>');
      // 主联系人 + 额外联系人全部渲染为可选胶囊
      const allContacts = [];
      if (c.company) allContacts.push({ name: c.company, phone: c.phone || '', role: '主联系人', isMain: true });
      extra.forEach(ct => allContacts.push({ name: ct.name || '', phone: ct.phone || '', role: ct.role || '联系人', isMain: false }));
      if (allContacts.length > 0) {
        const pills = allContacts.map(ct => {
          const isActive = ct.name && (ct.name === selContactName || (!selContactName && ct.isMain));
          return '<span class="cust-contact-pill' + (isActive ? ' active' : '') + '" data-cname="' + esc(ct.name) + '" data-cphone="' + esc(ct.phone) + '" title="' + esc(ct.role + (ct.phone ? ' · ' + ct.phone : '')) + '">' +
            '<span class="ccp-role">' + esc(ct.role) + '</span>' + esc(ct.name) + (ct.phone ? ' <span class="ccp-phone">' + esc(ct.phone) + '</span>' : '') +
            '</span>';
        });
        parts.push('<div class="cust-contacts-row">' + pills.join('') + '</div>');
        // 快捷添加联系人按钮
        parts.push('<button type="button" class="btn-quick-add-contact" id="btnQuickAddContact" title="为该客户快速添加新联系人">＋ 添加联系人</button>');
      } else {
        if (c.company) parts.push('联系人 ' + esc(c.company));
        if (c.phone) parts.push('电话 ' + esc(c.phone));
        parts.push('<button type="button" class="btn-quick-add-contact" id="btnQuickAddContact" title="为该客户添加联系人">＋ 添加联系人</button>');
      }
      // 始终显示电话和地址（有联系人时也展示）
      if (c.phone && !parts.some(p => p.includes(esc(c.phone)))) parts.push('<span class="cust-detail">📞 ' + esc(c.phone) + '</span>');
      if (c.address) parts.push('<span class="cust-detail">📍 ' + esc(c.address) + '</span>');
      if (c.tag) parts.push('<span class="cust-tag">' + esc(c.tag) + '</span>');
      return '<span class="cust-line">' + parts.join('') + '</span>';
    }
    const parts = [];
    if (c.company) parts.push('<span class="cust-pill"><b>联系人：</b>' + esc(c.company) + '</span>');
    parts.push('<span class="cust-pill"><b>电话：</b>' + esc(c.phone || '—') + '</span>');
    parts.push('<span class="cust-pill"><b>地址：</b>' + esc(c.address || '—') + '</span>');
    if (c.tag) parts.push('<span class="cust-pill tag"><b>标注：</b>' + esc(c.tag) + '</span>');
    extra.forEach(ct => parts.push('<span class="cust-pill"><b>' + esc(ct.role || '联系人') + '：</b>' + esc(ct.name || '—') + (ct.phone ? ' ' + esc(ct.phone) : '') + '</span>'));
    return parts.join('');
  }

  // 订单弹窗内：联系人胶囊选择 + 快捷添加联系人（不跳转客户页）
  function bindOrderContactPicker(cs) {
    const custInfo = $('#oCustInfo');
    if (!custInfo) return;
    // 点击联系人胶囊 → 切换选中
    custInfo.addEventListener('click', (e) => {
      const pill = e.target.closest('.cust-contact-pill');
      if (pill) {
        $$('.cust-contact-pill', custInfo).forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const o = state.editingOrder;
        if (o) {
          o._contactName = pill.dataset.cname || '';
          o._contactPhone = pill.dataset.cphone || '';
        }
        return;
      }
      // 点击「＋ 添加联系人」按钮
      const btn = e.target.closest('.btn-quick-add-contact');
      if (!btn) return;
      const cid = $('#oCustomer') ? $('#oCustomer').value : '';
      if (!cid || cid === '__new__') { toast('请先选择一个已有客户'); return; }
      const c = (cs || []).find(x => x.id === cid);
      if (!c) return;
      // 在按钮下方展开内联添加表单
      const existingForm = custInfo.querySelector('.quick-contact-form');
      if (existingForm) { existingForm.remove(); return; } // 再次点击收起
      const form = document.createElement('div');
      form.className = 'quick-contact-form card light';
      form.innerHTML = '<div class="qcf-row qcf-row-main">' +
        '<input placeholder="姓名" id="qcName">' +
        '<input placeholder="电话" id="qcPhone">' +
        '</div>' +
        '<div class="qcf-row qcf-row-actions">' +
        '<input placeholder="角色（选填）" id="qcRole" class="qcf-role">' +
        '<button type="button" class="btn qcf-save" id="qcSave">保存</button>' +
        '<button type="button" class="btn secondary qcf-cancel" id="qcCancel">取消</button>' +
        '</div>';
      btn.parentNode.insertBefore(form, btn.nextSibling);
      $('#qcName').focus();
      $('#qcCancel').addEventListener('click', () => form.remove());
      $('#qcSave').addEventListener('click', async () => {
        const name = ($('#qcName').value || '').trim();
        if (!name) { toast('请输入联系人姓名'); return; }
        if (!validContactName(name)) { toast('联系人姓名至少 2 个字符'); return; }
        const phone = ($('#qcPhone').value || '').trim();
        if (phone && !validPhone(phone)) { toast('联系电话格式不正确（需为 7-15 位数字）'); return; }
        const role = ($('#qcRole').value || '').trim() || '联系人';
        // 读出当前 contacts_json，追加新联系人
        const existing = Array.isArray(c.contacts_json) ? [...c.contacts_json] : [];
        existing.push({ name, phone, role });
        // 更新到数据库
        try {
          await DB.saveCustomerContacts(cid, existing);
          // 同步更新本地缓存
          c.contacts_json = existing;
          // 同时更新 state._customers 里对应的记录
          const csRec = (state._customers || []).find(x => x.id === cid);
          if (csRec) csRec.contacts_json = existing;
          logOp('添加联系人', '客户', cid, name);
          toast('已添加联系人「' + name + '」');
          // 自动选中新联系人
          const o = state.editingOrder;
          if (o) { o._contactName = name; o._contactPhone = phone; }
          // 重新渲染联系人区域
          if (custInfo.querySelector('.cust-meta')) {
            custInfo.querySelector('.cust-meta').innerHTML = customerInfoHtml(cs, cid, true);
          }
          form.remove();
          // 重新绑定（因为 innerHTML 重写了 DOM）
          bindOrderContactPicker(cs);
        } catch (err) {
          toast('保存联系人失败：' + (err.message || err));
        }
      });
    });
  }

  // 客户组合选择：可输入匹配、可下拉选择、匹配后下方显示客户信息
  function bindCustomerCombo(cs) {
    const hid = $('#oCustomer');
    const txt = $('#oCustomerText');
    const suggest = $('#oCustomerSuggest');
    const newBox = $('#oNewCustomer');
    const custInfo = $('#oCustInfo');
    const arrow = $('#oCustomerArrow');
    if (!txt || !hid) return;

    let activeIdx = -1;
    let committedName = '';  // 记录最近一次提交（选中/新建）的客户名，避免 input 事件误清空已选
    let fromArrow = false;   // 标记本次 focus 来自点击下拉箭头，避免清空已选客户

    function updateUi() {
      const cid = hid.value;
      if (custInfo) custInfo.querySelector('.cust-meta').innerHTML = customerInfoHtml(cs, cid, true);
      const isNew = cid === '__new__';
      if (newBox) newBox.style.display = isNew ? '' : 'none';
    }

    function filtered(q) {
      const qv = (q || '').trim().toLowerCase();
      if (!qv) return cs.slice();
      return cs.filter(c => (c.name || '').toLowerCase().includes(qv));
    }

    function positionSuggest() {
      const r = txt.getBoundingClientRect();
      suggest.style.left = r.left + 'px';
      suggest.style.width = r.width + 'px';
      const below = window.innerHeight - r.bottom;
      if (below >= 200) { suggest.style.top = (r.bottom + 4) + 'px'; suggest.style.bottom = 'auto'; }
      else { suggest.style.bottom = (window.innerHeight - r.top + 4) + 'px'; suggest.style.top = 'auto'; }
    }

    function renderList(list, q) {
      const qv = (q || '').trim();
      let html = '';
      if (list.length) {
        html = list.map((c, i) => '<div class="customer-suggest-item" data-cid="' + esc(c.id) + '" data-idx="' + i + '">' + esc(c.name) + '</div>').join('');
      }
      // 始终提供「新建客户」入口；无匹配时不显示负面的「无匹配客户」空状态，避免提示一直挂着
      html += '<div class="customer-suggest-item suggest-new" data-new="1">➕ 使用' + (qv ? '「' + esc(qv) + '」' : '') + '作为新客户 ↓</div>';
      suggest.innerHTML = html;
      positionSuggest();
      suggest.style.display = 'block';
      activeIdx = -1;
    }

    function setActive(i) {
      $$('.customer-suggest-item').forEach((el, idx) => el.classList.toggle('active', idx === i));
      activeIdx = i;
    }

    function selectCustomer(cid, name) {
      hid.value = cid;
      txt.value = name || '';
      committedName = txt.value.trim();
      suggest.style.display = 'none';
      activeIdx = -1;
      updateUi();
      txt.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function switchToNew(name) {
      hid.value = '__new__';
      committedName = '';
      suggest.style.display = 'none';
      activeIdx = -1;
      updateUi();
      const nc = $('#oNewCName'); if (nc && name) nc.value = name;
      txt.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function autoMatch(q) {
      const qv = (q || '').trim();
      if (!qv) { hid.value = ''; updateUi(); renderList(cs.slice(), ''); return; }
      const matches = filtered(qv);
      if (matches.length) {
        // 输入时自动绑定第一个匹配项，但保留用户输入内容，下方实时显示客户信息
        hid.value = matches[0].id;
        updateUi();
        renderList(matches, qv);
      } else {
        // 无匹配 → 切换到新建
        hid.value = '__new__';
        const nc = $('#oNewCName'); if (nc) nc.value = qv;
        updateUi();
        renderList([], qv);
      }
    }

    txt.addEventListener('input', () => {
      // 由 selectCustomer 提交的、与已选名一致的输入：保留已选客户，不重置
      if (committedName && txt.value.trim() === committedName) return;
      committedName = '';
      autoMatch(txt.value);
    });

    txt.addEventListener('focus', () => {
      const q = txt.value.trim();
      if (fromArrow) { fromArrow = false; renderList(cs.slice(), q); return; }
      if (committedName && q === committedName) {
        // 已选中客户，focus 时展示全部客户供切换
        renderList(cs.slice(), q);
        return;
      }
      autoMatch(q);
    });

    // 点击下拉箭头：展开/收起全部客户列表
    if (arrow) {
      arrow.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      arrow.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const visible = suggest.style.display !== 'none';
        if (visible) { suggest.style.display = 'none'; activeIdx = -1; return; }
        fromArrow = true;
        txt.focus();
        renderList(cs.slice(), txt.value);
      });
    }

    txt.addEventListener('keydown', (e) => {
      const items = $$('.customer-suggest-item[data-cid], .customer-suggest-item[data-new]');
      if (!items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, items.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) {
          const item = items[activeIdx];
          if (item.dataset.new) { switchToNew(txt.value.trim()); return; }
          const cid = item.dataset.cid;
          const c = cs.find(x => x.id === cid);
          if (c) selectCustomer(c.id, c.name);
        }
      } else if (e.key === 'Escape') {
        suggest.style.display = 'none'; activeIdx = -1;
      }
    });

    txt.addEventListener('blur', () => {
      setTimeout(() => {
        suggest.style.display = 'none';
        activeIdx = -1;
        const q = txt.value.trim();
        if (!q) { committedName = ''; hid.value = ''; updateUi(); return; }
        // 精确匹配
        const exact = cs.find(c => (c.name || '').toLowerCase() === q.toLowerCase());
        if (exact) { selectCustomer(exact.id, exact.name); return; }
        // 模糊匹配：有候选则选中第一个，无任何匹配才新建
        const matches = filtered(q);
        if (matches.length) { selectCustomer(matches[0].id, matches[0].name); return; }
        switchToNew(q);
      }, 150);
    });

    suggest.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.customer-suggest-item');
      if (!item) return;
      e.preventDefault();
      if (item.dataset.new) { switchToNew(txt.value.trim()); return; }
      const cid = item.dataset.cid;
      const c = cs.find(x => x.id === cid);
      if (c) selectCustomer(c.id, c.name);
    });
  }

  // 截稿时间选择器：日期 + 小时/分钟双下拉（仅内部字段，不含外层布局/快捷按钮）
  function deadlineFieldsHtml(o, disabled) {
    const v = o.deadline ? toLocalInput(o.deadline) : '';
    const [date, time] = v ? v.split('T') : ['', ''];
    // 未设置时间时默认聚焦 18:00，提升新建订单效率
    const hh = time ? time.slice(0, 2) : '18';
    const mm = time ? time.slice(3, 5) : '00';
    let hOpts = '', mOpts = '';
    // 截稿时间可选范围排除夜间睡觉时段（07:00 ~ 22:00）
    // 若已有订单时间落在夜间（旧数据），仍保留该选项避免被改丢
    if (hh && (Number(hh) < 7 || Number(hh) > 22)) {
      hOpts += '<option value="' + hh + '" selected>' + hh + ' 时（原值）</option>';
    }
    for (let h = 7; h <= 22; h++) {
      const val = String(h).padStart(2, '0');
      hOpts += '<option value="' + val + '"' + (val === hh ? ' selected' : '') + '>' + val + ' 时</option>';
    }
    ['00', '10', '20', '30', '40', '50'].forEach(val => {
      mOpts += '<option value="' + val + '"' + (val === mm ? ' selected' : '') + '>' + val + ' 分</option>';
    });
    const presets = [['今天', 'today'], ['明天', 'tomorrow'], ['3天后', 'plus3'], ['7天后', 'plus7']];
    const hidden = (date && hh && mm) ? (date + 'T' + hh + ':' + mm) : '';
    const dis = disabled ? ' disabled' : '';
    return {
      fields: ''
        + '<div class="dl-field"><label>截稿日期</label><input id="oDeadlineDate" type="date" value="' + date + '"' + dis + '></div>'
        + '<div class="dl-time"><label>截稿时间</label><div class="dl-time-pair">'
        +   '<select id="oDeadlineHour"' + dis + '>' + hOpts + '</select>'
        +   '<span class="dl-colon">:</span>'
        +   '<select id="oDeadlineMin"' + dis + '>' + mOpts + '</select>'
        + '</div></div>'
        + '<input id="oDeadline" type="hidden" value="' + hidden + '">',
      presets: presets
    };
  }
  // 截稿时间是否被用户改过（派单前改过则直接派单、跳过默认提示）
  let dlModified = false;
  function syncDeadline() {
    dlModified = true;
    const d = $('#oDeadlineDate'), hh = $('#oDeadlineHour'), mm = $('#oDeadlineMin'), h = $('#oDeadline');
    if (!d || !hh || !mm || !h) return;
    if (d.value && !hh.value) hh.value = '12';
    if (d.value && !mm.value) mm.value = '00';
    h.value = (d.value && hh.value && mm.value) ? (d.value + 'T' + hh.value + ':' + mm.value) : '';
    updateDeadlineWarn();
  }
  // 截稿过长提醒：实时显示「距今天 N 天」，超过设置阈值（deadline_warn_days，默认 30）时变警示样式
  function updateDeadlineWarn() {
    const h = $('#oDeadline'), warn = $('#oDeadlineWarn');
    if (!h || !warn) return;
    const val = h.value;
    if (!val) { warn.textContent = ''; warn.className = 'dl-warn'; return; }
    const ts = new Date(val).getTime();
    if (isNaN(ts)) { warn.textContent = ''; warn.className = 'dl-warn'; return; }
    const now = new Date();
    const nowTs = now.getTime();
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dlDate0 = new Date(new Date(ts).getFullYear(), new Date(ts).getMonth(), new Date(ts).getDate()).getTime();
    const days = Math.floor((dlDate0 - today0) / 86400000);
    const dl = new Date(ts);
    const dlMinutes = dl.getHours() * 60 + dl.getMinutes();
    const st = (state._settings && typeof state._settings === 'object') ? state._settings : {};
    const defs = window.Cfg.DEFAULT_SETTINGS || {};
    const threshold = (st.deadline_warn_days != null ? st.deadline_warn_days : (defs.deadline_warn_days != null ? defs.deadline_warn_days : 30));

    // 过期（红）
    if (ts < nowTs) {
      const hours = Math.max(1, Math.ceil((nowTs - ts) / 3600000));
      warn.className = 'dl-warn warn';
      warn.textContent = days === 0 ? '今天截稿（已过期 ' + hours + ' 小时）' : '已逾期 ' + days + ' 天，请修正';
      return;
    }

    // 今天 12:00 前 => 中午之前（红，今天截止紧迫）
    if (days === 0 && dlMinutes <= 12 * 60) {
      warn.className = 'dl-warn warn';
      warn.textContent = '中午之前';
      return;
    }

    // 今天剩余小时 => 红（今天截止紧迫）
    if (days === 0) {
      const hours = Math.max(1, Math.ceil((ts - nowTs) / 3600000));
      warn.className = 'dl-warn warn';
      warn.textContent = '剩余 ' + hours + ' 小时';
      return;
    }

    // 明天 => 明天 HH:MM 前（橙，较近但不紧迫）
    if (days === 1) {
      const hh = dl.getHours(), mm = dl.getMinutes();
      const tLabel = mm === 0 ? (hh + ' 点') : (hh + ':' + String(mm).padStart(2, '0'));
      warn.className = 'dl-warn soon';
      warn.textContent = '明天 ' + tLabel + ' 前';
      return;
    }

    // 超过阈值提醒（红）
    if (days > threshold) {
      warn.className = 'dl-warn warn';
      warn.textContent = '⚠ 距今天 ' + days + ' 天，截稿时间过长（> ' + threshold + ' 天），请确认';
      return;
    }

    // 其余 1 天以上 => 绿色（正常宽松）
    warn.className = 'dl-warn ok';
    warn.textContent = '距今天 ' + days + ' 天';
  }
  function applyDeadlinePreset(kind) {
    const d = new Date();
    if (kind === 'tomorrow') d.setDate(d.getDate() + 1);
    if (kind === 'plus3') d.setDate(d.getDate() + 3);
    if (kind === 'plus7') d.setDate(d.getDate() + 7);
    const ds = $('#oDeadlineDate'), hh = $('#oDeadlineHour'), mm = $('#oDeadlineMin');
    if (!ds || !hh || !mm) return;
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    ds.value = y + '-' + m + '-' + day;
    hh.value = '18'; hh.dispatchEvent(new Event('change', { bubbles: true }));
    mm.value = '00'; mm.dispatchEvent(new Event('change', { bubbles: true }));
    syncDeadline();
  }

  // 订单字段锁定规则（分节点、分字段，避免一刀切）
  //  - 派单设计师 / 协作设计师：派单那一刻占用产能，从「派单」起锁定（改走换人流程）
  //  - 客户 / 金额 / 任务类型 / 项目名 / 截稿日期：交付后入账依据，「已定稿」定格；
  //    「已换人」仅锁定设计师/协作（产能占用），截稿/金额等放开给新接手设计师重约
  //  - 备注 / 文件路径 / 设计稿路径 / 投诉记录：永不锁定（交付后常需补录、投诉）
  const LOCK_MID = ['派单', '提案', '提案不通过', '设计中', '初稿', '客户反馈', '修改中'];
  function orderLockRules(status) {
    if (LOCK_MID.includes(status)) return { level: 'mid', locked: new Set(['designer']) };
    if (status === '已定稿') return { level: 'terminal', locked: new Set(['designer', 'collab', 'customer', 'amount', 'type', 'title', 'deadline']) };
    if (status === '已换人') return { level: 'switched', locked: new Set(['designer', 'collab']) };
    return { level: 'open', locked: new Set() };
  }
  let _orderLockSnapshot = null;
  function applyOrderLock(o) {
    const rules = orderLockRules(o.status);
    _orderLockSnapshot = (rules.level === 'open') ? null : {
      level: rules.level, status: o.status, locked: rules.locked,
      fields: {
        title: o.title, task_type: o.task_type, customer_id: o.customer_id,
        amount: o.amount, deadline: o.deadline,
        assigned_designer_id: o.assigned_designer_id,
        collab_designer_ids: Array.isArray(o.collab_designer_ids) ? o.collab_designer_ids.slice() : []
      }
    };
    if (rules.level === 'open') return;
    const lock = (el) => { if (!el) return; el.disabled = true; el.classList.add('locked'); };
    if (rules.locked.has('designer')) {
      lock(document.getElementById('oDesigner'));
    }
    if (rules.locked.has('collab')) {
      $$('#modalBox .oCollab').forEach(c => { c.disabled = true; c.classList.add('locked'); });
    }
    if (rules.locked.has('customer')) {
      lock(document.getElementById('oCustomerText'));
      const ar = document.getElementById('oCustomerArrow');
      if (ar) { ar.disabled = true; ar.classList.add('locked'); }
    }
    if (rules.locked.has('amount')) lock(document.getElementById('oAmount'));
    if (rules.locked.has('type')) lock(document.getElementById('oType'));
    if (rules.locked.has('title')) lock(document.getElementById('oTitle'));
    if (rules.locked.has('deadline')) {
      lock(document.getElementById('oDeadlineDate'));
      lock(document.getElementById('oDeadlineHour'));
      lock(document.getElementById('oDeadlineMin'));
      $$('#modalBox [data-dl-preset]').forEach(b => { b.disabled = true; b.classList.add('locked'); });
    }
  }

  function renderOrderModal() {
    const o = state.editingOrder;
    const ds = state._designers || [], cs = state._customers || [];
    const customerText = (cs.find(c => c.id === o.customer_id) || {}).name || '';
    const collabIds = Array.isArray(o.collab_designer_ids) ? o.collab_designer_ids : [];
    const settingsDef = state._settings || {};
    const collabShareDefault = Number(settingsDef.collab_share_default) || 0.3;
    const collabShareVal = (o && Number(o.collab_share_ratio) > 0) ? Number(o.collab_share_ratio) : collabShareDefault;
    const otherDs = ds.filter(d => d.id !== o.assigned_designer_id && (isActiveDesign(d) || collabIds.includes(d.id)));
    const collabHtml = otherDs.map(d =>
      '<label class="chk"><input type="checkbox" class="oCollab" value="' + d.id + '"' +
      (collabIds.includes(d.id) ? ' checked' : '') + '> ' + esc(d.name) + '</label>').join('');
    const FLOW = window.Cfg.FLOW;
    const idx = s => FLOW.indexOf(s);
    const cur = idx(o.status);
    const isTerminal = (o.status === '已定稿' || o.status === '已换人');
    const steps = FLOW.map((s, i) => {
      let cls = 'st';
      // 终态之后的步骤不显示（已定稿后不需要看到"已换人"，反之亦然）
      if (isTerminal && i > cur) return '';
      if (o.status === '已换人') { cls = (i < idx('客户反馈')) ? 'st done' : 'st'; }
      else if (i < cur) cls = 'st done'; else if (i === cur) cls = 'st cur';
      return '<span class="' + cls + '">' + s + '</span>';
    }).join('');

    // 流程操作按钮
    let flow = '';
    if (o.status === '接单') flow = '<button class="btn" data-flow="dispatch" title="需指定设计师与截稿时间">派单</button>';
    else if (o.status === '派单') flow = '<button class="btn" data-flow="proposal">提交提案</button>';
    else if (o.status === '提案') {
      flow = '<button class="btn ok" data-flow="proposal_pass">提案通过</button>' +
        '<button class="btn warn" data-flow="proposal_fail">不通过</button>';
    } else if (o.status === '提案不通过') {
      flow = '<button class="btn" data-flow="proposal_again">二次提案</button>' +
        '<button class="btn danger" data-flow="switch">换人</button>';
    } else if (o.status === '设计中') flow = '<button class="btn" data-flow="draft">提交初稿</button>';
    else if (o.status === '初稿') flow = '<button class="btn" data-flow="feedback">送审客户</button>';
    else if (o.status === '客户反馈') {
      flow = '<button class="btn ok" data-flow="finalize">定稿</button>' +
        '<button class="btn warn" data-flow="revise">需要修改</button>';
    } else if (o.status === '修改中') flow = '<button class="btn ok" data-flow="finalize">客户定稿</button>' +
      '<button class="btn danger" data-flow="switch">换人</button>';
    else if (o.status === '已定稿') flow = softBadge((window.Cfg.STATUS['已定稿'] || {}).color || '#15803d', '已完成定稿');
    else if (o.status === '已换人') flow = softBadge('#94a3b8', '已更换设计师');
    else if (o.status === '已取消') flow = softBadge('#94a3b8', '已取消（客户终止）');
    // 取消订单（客户中途取消/终止）：非终态且有权限时显示「取消订单」按钮
    if (can('orders_cancel') && o.id && !['已定稿', '已换人', '已取消'].includes(o.status)) {
      flow += '<button class="btn danger ghost" data-flow="cancel" title="客户中途取消/终止订单，需填写原因">取消订单</button>';
    }
    // 流程回退（按 flow_revert 权限开放）：误推进一步时可撤销（接单为最初状态不显示）
    // 终态（已定稿/已换人）下回退按钮用低调文字链接，避免与完成标签视觉冲突
    if (can('flow_revert') && canRevert(o.status)) {
      const isTerminal = (o.status === '已定稿' || o.status === '已换人' || o.status === '已取消');
      if (isTerminal) {
        flow += '<span class="revert-link" data-flow="revert" title="撤销最近一步流程推进">↩ 回退</span>';
      } else {
        flow += '<button class="btn warn ghost" data-flow="revert" title="撤销最近一步流程推进（按权限开放）">↩ 回退</button>';
      }
    }

    // 订单信息表单（客户/金额/设计师/备注等）—— 详情模式下默认收起，不干扰流程查看
    const lockRules = orderLockRules(o.status);
    const dl = deadlineFieldsHtml(o, lockRules.locked.has('deadline'));
    const dTitle = lockRules.locked.has('title') ? ' disabled' : '';
    const dType = lockRules.locked.has('type') ? ' disabled' : '';
    const dCustomer = lockRules.locked.has('customer') ? ' disabled' : '';
    const dAmount = lockRules.locked.has('amount') ? ' disabled' : '';
    const dDesigner = lockRules.locked.has('designer') ? ' disabled' : '';
    const dCollab = lockRules.locked.has('collab') ? ' disabled' : '';
    const dDeadline = lockRules.locked.has('deadline') ? ' disabled' : '';
    // 锁定状态通过禁用态控件本身表达，不再额外显示黄色提示横幅
    const lockBanner = '';
    const infoForm = `
      <div class="compact-form order-detail-form">
        ${lockBanner}
        <div class="form-section order-info-sec">
          <div class="form-sec-title">基础信息</div>
          <div class="order-info-row">
            <div class="field oi-title"><label>项目</label><input id="oTitle" value="${esc(o.title)}" placeholder="如：XX公司名片设计"${dTitle}></div>
            <div class="field oi-type"><label>任务类型</label><select id="oType"${dType}>${window.Cfg.TASK_TYPES.map(t => '<option' + (t === o.task_type ? ' selected' : '') + '>' + t + '</option>').join('')}</select></div>
            <div class="field oi-customer customer-combo"><label>客户</label><div class="combo-input-wrap"><input type="hidden" id="oCustomer" value="${esc(o.customer_id || '')}"><input type="text" id="oCustomerText" value="${esc(customerText)}" placeholder="输入客户名，未找到则自动新建" autocomplete="off"${dCustomer}><button type="button" class="combo-arrow" id="oCustomerArrow" title="选择客户" tabindex="-1"${dCustomer}>▼</button></div><div class="customer-suggest" id="oCustomerSuggest" style="display:none"></div></div>
            <div class="field oi-amount"><label>金额（元）</label><input id="oAmount" type="number" value="${o.amount || 0}" placeholder="元"${dAmount}></div>
            <div class="field oi-status"><label>状态</label><div class="ro-box">${softBadge((window.Cfg.STATUS[o.status] || {}).color || '#64748b', esc((window.Cfg.STATUS[o.status] || {}).detail || o.status), 'status-badge')}</div></div>
          </div>
          <div class="field cust-info-line" id="oCustInfo" style="margin-top:4px"><div class="cust-meta">${customerInfoHtml(cs, o.customer_id, true)}</div></div>
          <div id="oNewCustomer" class="card light" style="display:none;margin:8px 0 0;padding:10px">
            <div class="grid2-sm">
              <div class="field"><label>客户名称</label><input id="oNewCName" placeholder="如：XX公司"></div>
              <div class="field"><label>联系人</label><input id="oNewCCompany" placeholder="联系人姓名"></div>
              <div class="field"><label>电话</label><input id="oNewCPhone" type="tel" inputmode="numeric" placeholder="如：13800138000"></div>
              <div class="field"><label>地址</label><input id="oNewCAddress"></div>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">派单与协作</div>
          <div class="dispatch-row">
            <div class="field dl-des"><label>派单设计师</label><select id="oDesigner"${dDesigner}><option value="">未派单</option>${ds.filter(d => isActiveDesign(d) || d.id === o.assigned_designer_id).map(d => '<option value="' + d.id + '"' + (d.id === o.assigned_designer_id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('')}</select></div>
            <div class="field collab-field"><label>协作设计师 <span class="muted" style="font-weight:400;font-size:11px">（各计 1 单）</span></label><div class="chips">${collabHtml ? collabHtml.replace(/class="oCollab"/g, 'class="oCollab"' + dCollab) : '<span style="color:var(--muted);font-size:12px">无其他设计师可选</span>'}</div></div>
          </div>
          <div class="dl-row collab-share-row">
            <label class="collab-share-label">协作分成比例</label>
            <div style="display:inline-flex;align-items:center;gap:6px">
              <input type="number" id="collabShare" min="0" max="1" step="0.05" value="${collabShareVal}"${dCollab} placeholder="如 0.3" style="width:70px" /> <span class="muted">默认 ${Math.round(collabShareDefault * 100)}%</span>
            </div>
          </div>
          <div class="dl-row deadline-row" style="margin-top:8px">
            ${dl.fields}
            <div class="dl-presets"><label>快捷</label><div class="chips">${dl.presets.map(p => '<button type="button" class="chip" data-dl-preset="' + p[1] + '"' + dDeadline + '>' + p[0] + '</button>').join('')}</div></div>
          </div>
          <div id="oDeadlineWarn" class="dl-warn"></div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">临时协助记录 <span class="muted" style="font-weight:400;font-size:11px">（临时替班/帮忙，仅留痕，不计入业绩）</span></div>
          <div id="tempAssistList" class="temp-assist-list">${tempAssistHtml(o)}</div>
          <button type="button" class="btn sm secondary" id="oAddAssist">＋ 添加协助</button>
          <div id="tempAssistForm" class="temp-assist-form" style="display:none;margin-top:8px">
            <div class="grid2-sm">
              <div class="field"><label>协助设计师</label><select id="taDesigner">${ds.filter(d => isActiveDesign(d) || tempAssistIds(o).includes(d.id)).map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('')}</select></div>
              <div class="field"><label>日期</label><input type="date" id="taDate" value="${todayStr()}"></div>
            </div>
            <div class="field" style="margin-top:6px"><label>备注（可选）</label><input id="taNote" placeholder="如：A 休班，帮忙改了初稿" maxlength="60"></div>
            <div style="margin-top:8px">
              <button type="button" class="btn sm" id="taConfirm">确认</button>
              <button type="button" class="btn sm ghost" id="taCancel">取消</button>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">修改与投诉 <span class="muted" style="font-weight:400;font-size:12px">（自动累计）</span></div>
          <div class="grid2-sm">
            <div class="field"><label>修改次数</label><div class="ro-box"><span id="revVal" class="ro-val">${o.revision_count || 0}</span><button type="button" class="btn-mini" data-revision="inc" title="手动补记一次修改（客户反复修改时 +1）">＋1</button><span class="muted" style="font-size:11px"> 流程自动累计</span></div></div>
            <div class="field"><label>客户投诉笔数</label><div class="ro-box"><span id="complaintVal" class="ro-val">${o.complaint_count || 0}</span><button type="button" class="btn-mini" data-complaint="inc" title="记录一次客户投诉（+1）">＋投诉</button></div></div>
          </div>
          <div class="field" style="margin-top:10px"><label>投诉原因</label>
            ${(o.complaint_log && o.complaint_log.length)
              ? '<div class="complaint-list">' + o.complaint_log.map((c, i) => '<div class="complaint-item"><span class="muted">#' + (i + 1) + '</span> <span class="badge ' + (c.reason === '设计原因' ? 'bad' : 'warn') + '">' + esc(c.reason || '—') + '</span> <span class="muted">' + (c.ts ? fmtTime(c.ts) : '') + '</span>' + (c.note ? '<div class="cmp-note">' + esc(c.note) + '</div>' : '') + '</div>').join('') + '</div>'
              : '<span class="muted" style="font-size:12px">暂无投诉，点击上方「＋投诉」记录</span>'}
          </div>
        </div>

        <details class="info-collapse"><summary>文件路径 / 备注 / 时间戳</summary>
          <div class="form-section" style="margin-top:10px">
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
          <div class="form-section">
            <div class="form-sec-title">流程时间戳（自动记录，不可修改）</div>
            <div class="grid3-sm" style="margin-top:8px">
              <div class="field"><label>接单时间</label><div class="ro-box"><span class="ro-val">${o.intake_at ? fmtTime(o.intake_at) : '—'}</span></div></div>
              <div class="field"><label>派单时间</label><div class="ro-box"><span class="ro-val">${o.dispatch_at ? fmtTime(o.dispatch_at) : '—'}</span></div></div>
              <div class="field"><label>提案时间</label><div class="ro-box"><span class="ro-val">${o.proposal_at ? fmtTime(o.proposal_at) : '—'}</span></div></div>
              <div class="field"><label>提案不通过</label><div class="ro-box"><span class="ro-val">${o.proposal_failed_at ? fmtTime(o.proposal_failed_at) : '—'}</span></div></div>
              <div class="field"><label>提案通过</label><div class="ro-box"><span class="ro-val">${o.proposal_pass_at ? fmtTime(o.proposal_pass_at) : '—'}</span></div></div>
              <div class="field"><label>设计开始</label><div class="ro-box"><span class="ro-val">${o.design_started_at ? fmtTime(o.design_started_at) : '—'}</span></div></div>
              <div class="field"><label>初稿提交</label><div class="ro-box"><span class="ro-val">${o.draft_at ? fmtTime(o.draft_at) : '—'}</span></div></div>
              <div class="field"><label>等客户反馈</label><div class="ro-box"><span class="ro-val">${o.feedback_at ? fmtTime(o.feedback_at) : '—'}</span></div></div>
              <div class="field"><label>客户反馈需修改</label><div class="ro-box"><span class="ro-val">${o.feedback_failed_at ? fmtTime(o.feedback_failed_at) : '—'}</span></div></div>
              <div class="field"><label>修改/返工开始</label><div class="ro-box"><span class="ro-val">${o.revision_at ? fmtTime(o.revision_at) : '—'}</span></div></div>
              <div class="field"><label>二次看稿</label><div class="ro-box"><span class="ro-val">${o.redraft_at ? fmtTime(o.redraft_at) : '—'}</span></div></div>
              <div class="field"><label>定稿时间</label><div class="ro-box"><span class="ro-val">${o.finalized_at ? fmtTime(o.finalized_at) : '—'}</span></div></div>
              <div class="field"><label>已换人</label><div class="ro-box"><span class="ro-val">${o.switched_at ? fmtTime(o.switched_at) : '—'}</span></div></div>
            </div>
          </div>
        </details>
        <div class="form-section">
          <div class="form-sec-title">流程变更记录</div>
          <div class="flow-log">${flowLogHtml(o.flow_history)}</div>
        </div>
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
          <div class="order-info-row">
            <div class="field oi-title"><label>项目</label><input id="oTitle" value="${esc(o.title)}" placeholder="如：XX公司名片设计"></div>
            <div class="field oi-type"><label>任务类型</label><select id="oType">${window.Cfg.TASK_TYPES.map(t => '<option' + (t === o.task_type ? ' selected' : '') + '>' + t + '</option>').join('')}</select></div>
            <div class="field oi-customer customer-combo"><label>客户</label><div class="combo-input-wrap"><input type="hidden" id="oCustomer" value="${esc(o.customer_id || '')}"><input type="text" id="oCustomerText" value="${esc(customerText)}" placeholder="输入客户名，未找到则自动新建" autocomplete="off"><button type="button" class="combo-arrow" id="oCustomerArrow" title="选择客户" tabindex="-1">▼</button></div><div class="customer-suggest" id="oCustomerSuggest" style="display:none"></div></div>
            <div class="field oi-amount"><label>金额（元）</label><input id="oAmount" type="number" value="${o.amount || 0}" placeholder="元"></div>
          </div>
          <div class="field cust-info-line" id="oCustInfo" style="margin-top:4px"><div class="cust-meta">${customerInfoHtml(cs, o.customer_id, true)}</div></div>
          <div id="oNewCustomer" class="card light" style="display:none;margin:8px 0 0;padding:10px">
            <div class="grid2-sm">
              <div class="field"><label>客户名称</label><input id="oNewCName" placeholder="如：XX公司"></div>
              <div class="field"><label>联系人</label><input id="oNewCCompany" placeholder="联系人姓名"></div>
              <div class="field"><label>电话</label><input id="oNewCPhone" type="tel" inputmode="numeric" placeholder="如：13800138000"></div>
              <div class="field"><label>地址</label><input id="oNewCAddress"></div>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-sec-title">派单与协作 <span class="muted" style="font-weight:400;font-size:11px">（可稍后在流程中派单）</span></div>
          <div class="dispatch-row">
            <div class="field dl-des"><label>派单设计师</label><select id="oDesigner"><option value="">未派单</option>${ds.filter(d => isActiveDesign(d) || d.id === o.assigned_designer_id).map(d => '<option value="' + d.id + '"' + (d.id === o.assigned_designer_id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('')}</select></div>
            <div class="field collab-field"><label>协作设计师 <span class="muted" style="font-weight:400;font-size:11px">（2~3 人协同，各计 1 单）</span></label><div class="chips">${collabHtml || '<span style="color:var(--muted);font-size:12px">无其他设计师可选</span>'}</div></div>
          </div>
          <div class="dl-row deadline-row" style="margin-top:8px">
            ${dl.fields}
            <div class="dl-presets"><label>快捷</label><div class="chips">${dl.presets.map(p => '<button type="button" class="chip" data-dl-preset="' + p[1] + '">' + p[0] + '</button>').join('')}</div></div>
          </div>
          <div id="oDeadlineWarn" class="dl-warn"></div>
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
      <button class="close modal-close-outside" data-close title="关闭">×</button>
      <div class="order-detail-header">
        <button class="close" data-close>×</button>
        <div class="odh-title">流程详情</div>
        <div class="odh-project-wrap">
          <span class="odh-project">${esc(o.title)}</span>
          <span class="order-no-tag">${esc(o.order_no)}</span>
        </div>
      </div>
      <div class="modal-scroll">
        <div class="flow-detail">${flowBlock}</div>
        <details class="info-collapse" open><summary>订单信息（客户 / 金额 / 设计师 / 截稿时间）</summary>
          ${infoForm}
        </details>
      </div>
      <div class="modal-actionbar">
        ${o.id && can('orders_delete') ? '<button class="btn danger" id="oDelete">删除</button>' : ''}
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
    if (isDetail) $('#modalBox').classList.add('detail-modal');
    dlModified = false;
    applyOrderLock(o);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', () => closeModal()));
    if ($('#oDelete')) $('#oDelete').addEventListener('click', () => { delOrder(o.id); });
    $('#oSave').addEventListener('click', () => saveOrderFromModal());
    // 方案B：详情弹窗中任何表单控件改动都标记「未保存」，关闭时据此二次确认
    if (isDetail) {
      const markDirty = () => { const ed = state.editingOrder; if (ed) ed._dirty = true; };
      $$('#modalBox input, #modalBox select, #modalBox textarea').forEach(el => {
        el.addEventListener('input', markDirty);
        el.addEventListener('change', markDirty);
      });
      $$('#modalBox [data-dl-preset]').forEach(b => b.addEventListener('click', markDirty));
    }
    // 新建订单：草稿自动暂存 + 恢复提示
    if (!o.id) {
      const draftInputs = ['oTitle','oCustomerText','oType','oAmount','oDesigner','oDeadline','oNotes','oFilePaths','oDesignPaths','oNewCName','oNewCCompany','oNewCPhone','oNewCAddress'];
      let dTimer = null;
      const onInput = () => { clearTimeout(dTimer); dTimer = setTimeout(saveOrderDraft, 400); };
      draftInputs.forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', onInput); });
      $$('#modalBox .oCollab').forEach(c => c.addEventListener('change', onInput));
      // 回填新建客户字段（模板未带 value，需手动设置）
      if (state._orderDraftNewCust && state._orderDraftNewCust.name) {
        const t = id => document.getElementById(id);
        if (t('oNewCName')) t('oNewCName').value = state._orderDraftNewCust.name;
        if (t('oNewCCompany')) t('oNewCCompany').value = state._orderDraftNewCust.company || '';
        if (t('oNewCPhone')) t('oNewCPhone').value = state._orderDraftNewCust.phone || '';
        if (t('oNewCAddress')) t('oNewCAddress').value = state._orderDraftNewCust.address || '';
        const oc = t('oCustomer'); if (oc) oc.value = '__new__';
        const oct = t('oCustomerText'); if (oct) oct.value = state._orderDraftNewCust.name;
        const ocust = t('oNewCustomer'); if (ocust) ocust.style.display = '';
        const ci = t('oCustInfo'); if (ci) ci.querySelector('.cust-meta').innerHTML = customerInfoHtml(cs, '__new__', true);
      }
      // 恢复草稿横幅
      if (state._orderDraftRestored) {
        const banner = document.createElement('div');
        banner.className = 'draft-banner';
        const ts = state._orderDraftTs ? new Date(state._orderDraftTs).toLocaleString() : '';
        banner.innerHTML = '📝 已恢复上次未保存的草稿（' + ts + '）<button type="button" class="btn ghost sm" id="oDiscardDraft">丢弃草稿</button>';
        const box = document.getElementById('modalBox');
        box.insertBefore(banner, box.firstChild);
        const dbtn = document.getElementById('oDiscardDraft');
        if (dbtn) dbtn.addEventListener('click', () => { clearOrderDraft(); state._orderDraftRestored = false; if (banner.parentNode) banner.parentNode.removeChild(banner); toast('已丢弃草稿'); });
      }
    }
    bindCustomerCombo(cs);
    // 订单弹窗内：联系人选择 + 快捷添加
    bindOrderContactPicker(cs);
    $$('#modalBox [data-flow]').forEach(b => b.addEventListener('click', () => advanceFlow(b.dataset.flow)));
    // 客户投诉笔数：只读 +1，点击弹出自定义窗口选择原因并填写备注
    const cInc = $('#modalBox [data-complaint="inc"]');
    if (cInc) cInc.addEventListener('click', () => complaintModal());
    // 修改次数：流程自动累计 + 手动补记（修改中反复修改时可 +1）
    const rInc = $('#modalBox [data-revision="inc"]');
    if (rInc) rInc.addEventListener('click', () => addRevisionModal());
    // 临时协助记录：添加 / 删除（不受订单锁定状态影响，任何阶段可记，保存订单时一并入库）
    if (!Array.isArray(state.editingOrder.temp_assist_log)) state.editingOrder.temp_assist_log = [];
    const taAdd = $('#oAddAssist');
    if (taAdd) taAdd.addEventListener('click', () => {
      const f = $('#tempAssistForm');
      if (f) f.style.display = (f.style.display === 'none' || !f.style.display) ? '' : 'none';
    });
    const taCancel = $('#taCancel');
    if (taCancel) taCancel.addEventListener('click', () => { const f = $('#tempAssistForm'); if (f) f.style.display = 'none'; });
    const taConfirm = $('#taConfirm');
    if (taConfirm) taConfirm.addEventListener('click', () => {
      const did = $('#taDesigner') ? $('#taDesigner').value : '';
      if (!did) { toast('请选择协助设计师'); return; }
      const d = (state._designers || []).find(x => x.id === did);
      const entry = {
        did,
        name: d ? d.name : '',
        date: ($('#taDate') ? $('#taDate').value : '') || todayStr(),
        note: ($('#taNote') ? ($('#taNote').value || '').trim() : '')
      };
      state.editingOrder.temp_assist_log = (state.editingOrder.temp_assist_log || []).concat(entry);
      state.editingOrder._dirty = true;
      const list = $('#tempAssistList'); if (list) list.innerHTML = tempAssistHtml(state.editingOrder);
      const f = $('#tempAssistForm'); if (f) f.style.display = 'none';
      if ($('#taNote')) $('#taNote').value = '';
      toast('已记录临时协助（点「保存信息」后生效）');
    });
    $$('#modalBox [data-ta-del]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.taDel);
      const log = (state.editingOrder.temp_assist_log || []).slice();
      log.splice(i, 1);
      state.editingOrder.temp_assist_log = log;
      state.editingOrder._dirty = true;
      const list = $('#tempAssistList'); if (list) list.innerHTML = tempAssistHtml(state.editingOrder);
    }));
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
      $('#oDeadlineHour').addEventListener('change', syncDeadline);
      $('#oDeadlineMin').addEventListener('change', syncDeadline);
      updateDeadlineWarn();
      $$('#modalBox [data-dl-preset]').forEach(b => b.addEventListener('click', () => applyDeadlinePreset(b.dataset.dlPreset)));
    }
    $('#modalBox').addEventListener('click', (e) => {
      const of = e.target.closest('[data-openfolder]');
      if (of) { openInExplorer(of.dataset.openfolder); return; }
      const cp = e.target.closest('[data-fpcopy]');
      if (cp) { copyText(cp.dataset.fpcopy); toast('已复制：' + cp.dataset.fpcopy); }
    });
    applyPermissions();
    // 双保险：在所有 bind 完成后再应用一次锁定，防止任何后续逻辑意外覆盖 disabled 状态；
    // 另加 requestAnimationFrame 兜底，确保异步 DOM 操作后锁定仍生效。
    applyOrderLock(o);
    requestAnimationFrame(() => { if (state.editingOrder === o) applyOrderLock(o); });
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
    add('等客户反馈', o.feedback_at, r++);
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
    // 显示名映射：数据库 status 值与时间轴/流程条显示名不一致时同步
    if (o.status === '客户反馈') curName = '等客户反馈';
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
      // 已定稿 / 已换人均为终态，不再显示后续待推进步骤
      if (o.status === '已换人' || o.status === '已定稿') curIdx = FLOW.length;
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
    if (changed) recordFlow(o, action, o.status, opts.by);
  }

  // 流程回退（按 flow_revert 权限开放）：撤销「最近一步推进」写入的副作用（时间戳 / 计数 / 日志 / 换人），
  // 只做单步反操作，不跨多步，降低误回退风险。返回 { ok, target, msg }。
  function revertFlow(o) {
    const popLog = (k) => { if (Array.isArray(o[k]) && o[k].length) o[k].pop(); };
    const decCount = (k) => { o[k] = Math.max(0, (Number(o[k]) || 0) - 1); };
    const st = o.status;
    let target = null;
    if (st === '派单') {
      o.dispatch_at = null;
      target = '接单';
    } else if (st === '提案') {
      o.proposal_at = null; decCount('proposal_count'); popLog('proposal_log');
      // 二次提案（来自「提案不通过」）回退到「提案不通过」；首次提案回退到「派单」
      target = o.proposal_failed_at ? '提案不通过' : '派单';
    } else if (st === '提案不通过') {
      o.proposal_failed_at = null; decCount('proposal_count'); popLog('proposal_failed_log');
      target = '提案';
    } else if (st === '设计中') {
      o.design_started_at = null;
      target = o.proposal_pass_at ? (o.proposal_pass_at = null, '提案') : '派单';
    } else if (st === '初稿') {
      if (o.redraft_at) { o.redraft_at = null; popLog('redraft_log'); target = '修改中'; }
      else { o.draft_at = null; popLog('draft_log'); target = '设计中'; }
    } else if (st === '客户反馈') {
      o.feedback_at = null; target = '初稿';
    } else if (st === '修改中') {
      decCount('revision_count');
      o.revision_at = null; o.feedback_failed_at = null;
      popLog('revision_log'); popLog('feedback_failed_log');
      target = '客户反馈';
    } else if (st === '已定稿') {
      o.finalized_at = null; o.is_finalized = false;
      target = o.feedback_pass_at ? (o.feedback_pass_at = null, '客户反馈') : '修改中';
    } else if (st === '已换人') {
      const collab = Array.isArray(o.collab_designer_ids) ? o.collab_designer_ids : [];
      if (collab.length) {
        // 换人前的主负责人被移入了协作列表末尾，回退时取回作主负责人
        o.assigned_designer_id = collab.pop();
        o.switched_at = null; o.switch_reason = null;
        target = '客户反馈';
      } else {
        return { ok: false, msg: '无法确定换人前的负责人，请在「派单与协作」中手动改回设计师。' };
      }
    } else if (st === '已取消') {
      // 误标「已取消」可恢复：回到取消前的状态，并清空取消相关字段（区别于删除，记录仍保留）
      target = o.pre_cancel_status || '接单';
      o.pre_cancel_status = null;
      o.cancel_reason = null;
      o.cancel_at = null;
    } else {
      return { ok: false, msg: '当前状态「' + st + '」已是最初状态，无法回退。' };
    }
    o.status = target;
    recordFlow(o, '回退', target);
    return { ok: true, target };
  }
  // 当前状态是否可回退（用于按钮显隐）：除最初的「接单」外均可回退一步
  function canRevert(st) { return !!st && st !== '接单'; }

  // 订单弹窗内的流程推进（需先同步表单字段、处理新建客户）
  async function advanceFlow(action) {
    const o = state.editingOrder;
    if (action === 'switch') {
      // 换人弹窗会用 openModal 替换整个弹窗内容，详情输入框随后从 DOM 移除；
      // 因此先在详情输入框仍在时把改动同步进内存对象，并落库新建客户，避免改动丢失。
      try { syncFieldsFromModal(); } catch (e) { console.error(e); }
      try { await ensureCustomerFromModal(); } catch (e) { return; }
      switchDesignerModal(o, { onApplied: () => renderOrderModal(), closeAfter: false });
      return;
    }
    // 流程回退（按 flow_revert 权限开放，默认仅管理员）：撤销最近一步误推进
    if (action === 'revert') {
      if (!can('flow_revert')) { toast('无回退流程权限（仅授权职务可操作）'); return; }
      // 先确认再执行：revertFlow 会直接改内存对象，必须先确认以免取消后产生脏数据
      if (!(await uiConfirm('确定要回退这一步吗？\n将撤销最近一步流程推进，恢复到上一步状态，并保存当前订单信息。'))) return;
      const r = revertFlow(o);
      if (!r.ok) { toast(r.msg); return; }
      const lk = 'revert:' + (o.id || 'new');
      if (!lockOp(lk)) return;
      try {
        syncFieldsFromModal(); // 回退时一并保存详情里改过的字段（金额/截稿/备注等）
        await DB.saveOrder(o);
        logOp('回退流程', '订单', o.id, o.order_no);
        await refreshAll();
        o._dirty = false;
        renderOrderModal();
        toast('已回退至「' + r.target + '」（' + esc(state.currentUser.role) + '操作）');
      } catch (e) { console.error(e); toast('回退失败：' + e.message); }
      finally { unlockOp(lk); }
      return;
    }
    // 取消订单（客户中途取消/终止）：置「已取消」终态，需填原因，保留记录可复盘（区别于删除）
    if (action === 'cancel') {
      if (!can('orders_cancel')) { toast('无取消订单权限（仅店长/管理员可操作）'); return; }
      let reason = null;
      while (true) {
        const r = await uiInput('客户取消 / 终止此订单', '请填写取消原因（至少 4 个字，需含文字说明，不可用数字替代；如：客户预算不足 / 需求变更 / 长期无反馈）', true);
        if (r === null) return; // 用户取消输入
        const err = validReason(r, '取消原因');
        if (err) { toast(err); continue; }
        reason = r;
        break;
      }
      const prevStatus = (o.status === '已取消') ? (o.pre_cancel_status || '接单') : o.status;
      o.pre_cancel_status = prevStatus;
      o.status = '已取消';
      o.cancel_reason = reason;
      o.cancel_at = new Date().toISOString();
      const lk = 'cancel:' + (o.id || 'new');
      if (!lockOp(lk)) return;
      try {
        syncFieldsFromModal();
        try { await ensureCustomerFromModal(); } catch (e) { return; }
        await DB.saveOrder(o);
        logOp('取消订单', '订单', o.id, o.order_no, reason);
        await refreshAll();
        o._dirty = false;
        renderOrderModal();
        toast('订单已标记为「已取消」');
      } catch (e) { console.error(e); toast('保存失败：' + e.message); }
      finally { unlockOp(lk); }
      return;
    }
    // 三次改稿（三稿修改中）后，禁止再点「不通过（修改）」默默推进；引导用换人按钮
    if (action === 'revise' && o.status === '修改中' && (o.revision_count || 0) >= 2) {
      toast('已修改 3 次（三稿修改中），请点击「换人」按钮更换设计师');
      return;
    }
    // 派单：设计师必选；截稿新建单已默认明天18:00，仍有值时提示默认值，确认或去修改
    if (action === 'dispatch') {
      const dEl = $('#oDesigner'), dlHidden = $('#oDeadline'), dateEl = $('#oDeadlineDate');
      const hasDesigner = dEl && dEl.value;
      const hasDeadline = dlHidden && dlHidden.value;
      if (!hasDesigner) {
        if (dEl) { const box = dEl.closest('.field'); if (box) { box.classList.add('flash-field'); box.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => box.classList.remove('flash-field'), 1800); } dEl.focus(); }
        toast('请先选择派单设计师，再点「派单」');
        return;
      }
      if (!hasDeadline) {
        const dr = $('#modalBox .deadline-row');
        if (dr) { dr.classList.add('flash-field'); dr.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => dr.classList.remove('flash-field'), 1800); }
        if (dateEl) dateEl.focus();
        toast('请先填写截稿日期与时间，再点「派单」');
        return;
      }
      // 设计师已选、截稿已有（默认或手动）：
      //  - 用户改过截稿时间 → 直接派单，不再提示；
      //  - 仍是默认/原值 → 弹确认框，确认派单或去修改
      if (!dlModified) {
        const ok = await uiConfirm('截稿时间已默认为：' + fmtDeadlineCn(dlHidden.value) + '\n如需修改可在订单详情的「截稿时间」处调整。\n\n确认按此截稿时间派单？', '确认派单');
        if (!ok) {
          const dr = $('#modalBox .deadline-row');
          if (dr) { dr.classList.add('flash-field'); dr.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => dr.classList.remove('flash-field'), 1800); }
          if (dateEl) dateEl.focus();
          return;
        }
      }
    }
    const lk = 'flow:' + (o.id || 'new');
    if (!lockOp(lk)) return;
    try {
      syncFieldsFromModal();
      applyFlowAction(o, action, {
        designerId: $('#oDesigner').value,
        deadline: $('#oDeadline').value ? fromLocalInput($('#oDeadline').value) : null
      });
      try { await ensureCustomerFromModal(); } catch (e) { return; }
      try {
        await DB.saveOrder(o);
        logOp('推进流程', '订单', o.id, o.order_no, action);
        await refreshAll();
        o._dirty = false; // 推进流程已全量保存，清除未保存标记，避免关闭时误报
        renderOrderModal();
      } catch (e) { console.error(e); toast('保存失败：' + e.message); }
    } finally { unlockOp(lk); }
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
      <div class="modal-foot" style="position:relative;z-index:1">
        <button class="btn secondary" data-close>取消</button>
        <button class="btn" id="swConfirm">确认换人</button>
      </div>`;
    openModal(html);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', () => closeModal()));
    $('#swConfirm').addEventListener('click', async () => {
      const newId = $('#swNew').value;
      if (!newId) { toast('请选择新设计师'); return; }
      if (!lockOp('switch:' + (o.id || 'x'))) return;
      try {
        const reason = ($('#swReason').value || '').trim() || '更换设计师';
        applyFlowAction(o, 'switch', { switchReason: reason, newDesignerId: newId });
        await DB.saveOrder(o);
        await refreshAll();
        o._dirty = false;
        const nm = (state._designers || []).find(d => d.id === newId);
        if (onApplied) onApplied();
        if (closeAfter) closeModal();
        toast('已换人 → ' + (nm ? nm.name : '新设计师'));
      } catch (e) { console.error(e); toast('换人失败：' + e.message); }
      finally { unlockOp('switch:' + (o.id || 'x')); }
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
      if (!lockOp('complaint:' + (o.id || 'x'))) return;
      try {
        const note = ($('#cmpNote').value || '').trim();
        o.complaint_count = (Number(o.complaint_count) || 0) + 1;
        o.complaint_log = Array.isArray(o.complaint_log) ? o.complaint_log : [];
        o.complaint_log.push({ ts: new Date().toISOString(), reason: selectedReason, note });
        await DB.saveOrder(o);
        await refreshAll();
        renderOrderModal();
        toast('已记录 1 次客户投诉');
      } catch (e) { console.error(e); toast('保存失败：' + e.message); }
      finally { unlockOp('complaint:' + (o.id || 'x')); }
    });
  }

  // 手动补记修改次数：客户反复在修改中提要求时，流程动作不会重复触发，可手动 +1
  function addRevisionModal() {
    const o = state.editingOrder;
    const html = `
      <button class="close" data-close>×</button>
      <h3>补记修改次数</h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 10px">当前修改次数：<b>${o.revision_count || 0}</b>，确认后再加 1 次？</p>
      <div class="field"><label>修改备注（可选）</label>
        <textarea id="revNote" rows="3" placeholder="如：客户要求调整整体配色 / 文案大改 / 加急二改等"></textarea>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn secondary" id="revCancel">取消</button>
        <button class="btn" id="revConfirm">确认 +1</button>
      </div>`;
    openModal(html);
    $('#revCancel').addEventListener('click', () => renderOrderModal());
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', () => renderOrderModal()));
    $('#revConfirm').addEventListener('click', async () => {
      if (!lockOp('revision:' + (o.id || 'x'))) return;
      try {
        const note = ($('#revNote').value || '').trim();
        const now = new Date().toISOString();
        o.revision_count = (Number(o.revision_count) || 0) + 1;
        o.revision_log = Array.isArray(o.revision_log) ? o.revision_log : [];
        o.revision_log.push(now);
        o.revision_log.sort();
        o.revision_at = now;
        // 顺手把本次手动补记也存到 revision_note，方便后续查看批次原因
        if (note) {
          const prev = (o.revision_note || '').trim();
          o.revision_note = prev ? (prev + '\n' + now.slice(0, 10) + '：' + note) : (now.slice(0, 10) + '：' + note);
        }
        await DB.saveOrder(o);
        await refreshAll();
        renderOrderModal();
        toast('已补记 1 次修改');
      } catch (e) { console.error(e); toast('保存失败：' + e.message); }
      finally { unlockOp('revision:' + (o.id || 'x')); }
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
    if (action === 'switch') {
      switchDesignerModal(o, { onApplied: () => renderWorkbench(), closeAfter: true });
      return;
    }
    // 流程回退（按 flow_revert 权限开放，默认仅管理员）：撤销最近一步误推进
    if (action === 'revert') {
      if (!can('flow_revert')) { toast('无回退流程权限（仅授权职务可操作）'); return; }
      if (!(await uiConfirm('确定要回退该订单的流程吗？\n将撤销最近一步流程推进，恢复到上一步状态。'))) return;
      const r = revertFlow(o);
      if (!r.ok) { toast(r.msg); return; }
      const lk = 'wb:revert:' + id;
      if (!lockOp(lk)) return;
      try {
        await DB.saveOrder(o);
        logOp('回退流程', '订单', o.id, o.order_no);
        await refreshAll();
        renderWorkbench();
        toast('已回退至「' + r.target + '」（' + esc(state.currentUser.role) + '操作）');
      } catch (e) { console.error(e); toast('回退失败：' + e.message); }
      finally { unlockOp(lk); }
      return;
    }
    const lk = 'wb:' + id + ':' + action;
    if (!lockOp(lk)) return;
    try {
      if (action === 'revise') {
        if (o.status === '修改中' && (o.revision_count || 0) >= 2) {
          toast('已修改 3 次（三稿修改中），请点击「换人」按钮更换设计师');
          return;
        }
        // 客户反馈 → 修改中：一键推进，无需选择返工原因
        applyFlowAction(o, action, {});
        await DB.saveOrder(o);
        logOp('推进流程', '订单', o.id, o.order_no, action);
        await refreshAll();
        renderWorkbench();
        toast('已转为修改中');
        return;
      }
      applyFlowAction(o, action, {});
      await DB.saveOrder(o);
      logOp('推进流程', '订单', o.id, o.order_no, action);
      await refreshAll();
      renderWorkbench();
      toast('已推进：' + ((window.Cfg.STATUS[o.status] || {}).label || o.status));
    } catch (e) { console.error(e); toast('推进失败：' + e.message); }
    finally { unlockOp(lk); }
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
    // 协作分成比例：读取输入框（仅当该单有协作设计师时生效；无协作则比例无意义，归位默认）
    const collabShareRaw = $('#collabShare') ? Number($('#collabShare').value) : NaN;
    o.collab_share_ratio = (o.collab_designer_ids.length && isFinite(collabShareRaw) && collabShareRaw >= 0 && collabShareRaw <= 1)
      ? collabShareRaw : (state._settings && Number(state._settings.collab_share_default) || 0.3);
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

  // 联系人与电话格式校验（防止用 "1" 等占位符糊弄）
  function validContactName(v) {
    const s = (v || '').trim();
    return s.length >= 2; // 至少 2 个字符（排除单字符占位）
  }
  function validPhone(v) {
    const s = (v || '').replace(/[\s\-]/g, '');
    return /^(\+?\d{7,15})$/.test(s); // 7-15 位数字，可含国家码/空格/横线
  }
  async function ensureCustomerFromModal() {
    const o = state.editingOrder;
    if (o.customer_id !== '__new__') return;
    const name = $('#oNewCName').value.trim();
    if (!name) { toast('请输入新客户名称'); throw new Error('新客户名称必填'); }
    const company = $('#oNewCCompany').value.trim();
    const phone = $('#oNewCPhone').value.trim();
    if (!company) { toast('请输入联系人姓名'); throw new Error('联系人必填'); }
    if (!validContactName(company)) { toast('联系人姓名至少 2 个字符'); throw new Error('联系人格式不正确'); }
    // 同名查重：避免误操作重复创建客户；保留合法重名（确认放行）
    const dup = (state._customers || []).find(c => (c.name || '').trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      const ok = await uiConfirm('已存在同名客户「' + dup.name + '」，确定要再新建一个吗？\n（点「取消」可在客户框直接选用已有的）');
      if (!ok) throw new Error('已取消：存在同名客户');
    }
    const cust = await DB.saveCustomer({
      name, company, phone, address: $('#oNewCAddress').value.trim(),
      created_by: (state.currentUser && state.currentUser.id) || undefined
    });
    logOp('新建客户', '客户', cust.id, name);
    o.customer_id = cust.id;
    o.customer_name = cust.name;
  }

  // ——— 新建订单草稿自动暂存（防止误关丢失已填内容）———
  const ORDER_DRAFT_KEY = 'dw_order_draft_v1';
  function saveOrderDraft() {
    const o = state.editingOrder;
    if (!o || o.id) return;
    const t = id => document.getElementById(id);
    const draft = {
      ts: Date.now(),
      order_no: o.order_no,
      title: t('oTitle') ? t('oTitle').value : '',
      customer_id: t('oCustomer') ? t('oCustomer').value : '',
      task_type: t('oType') ? t('oType').value : '名片',
      amount: t('oAmount') ? (Number(t('oAmount').value) || 0) : 0,
      assigned_designer_id: t('oDesigner') ? (t('oDesigner').value || '') : '',
      deadline: t('oDeadline') ? t('oDeadline').value : '',
      notes: t('oNotes') ? t('oNotes').value : '',
      file_paths: t('oFilePaths') ? t('oFilePaths').value : '',
      design_paths: t('oDesignPaths') ? t('oDesignPaths').value : '',
      collab: Array.from(document.querySelectorAll('#modalBox .oCollab')).filter(c => c.checked).map(c => c.value),
      newCust: {
        name: t('oNewCName') ? t('oNewCName').value : '',
        company: t('oNewCCompany') ? t('oNewCCompany').value : '',
        phone: t('oNewCPhone') ? t('oNewCPhone').value : '',
        address: t('oNewCAddress') ? t('oNewCAddress').value : ''
      }
    };
    const hasContent = draft.title || draft.customer_id || draft.notes || draft.file_paths ||
                       draft.design_paths || draft.newCust.name || draft.amount || draft.assigned_designer_id;
    if (!hasContent) { clearOrderDraft(); return; }
    try { localStorage.setItem(ORDER_DRAFT_KEY, JSON.stringify(draft)); } catch (e) {}
  }
  function loadOrderDraft() {
    try { const r = localStorage.getItem(ORDER_DRAFT_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; }
  }
  function clearOrderDraft() {
    try { localStorage.removeItem(ORDER_DRAFT_KEY); } catch (e) {}
  }

  async function saveOrderFromModal() {
    // 防重复：正在保存时忽略后续点击，避免一次新建产生两条重复订单
    if (state._savingOrder) return;
    const btn = $('#oSave');
    if (btn) { btn.disabled = true; btn.dataset._txt = btn.textContent; btn.textContent = '保存中…'; }
    state._savingOrder = true;
    try {
      syncFieldsFromModal();
      const o = state.editingOrder;
      // 截稿过长提醒：保存时若距今天超过阈值，给出一次 toast 提示（不阻断保存）
      if (o.deadline) {
        const ts = new Date(o.deadline).getTime();
        const today0 = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
        const days = Math.round((ts - today0) / 86400000);
        const st = (state._settings && typeof state._settings === 'object') ? state._settings : {};
        const defs = window.Cfg.DEFAULT_SETTINGS || {};
        const threshold = (st.deadline_warn_days != null ? st.deadline_warn_days : (defs.deadline_warn_days != null ? defs.deadline_warn_days : 30));
        if (days > threshold) toast('⚠ 截稿时间距今 ' + days + ' 天，过长（> ' + threshold + ' 天），请确认');
      }
      // 双保险：锁定字段以快照原值覆盖，防止绕过 UI 改动核心数据
      if (_orderLockSnapshot && _orderLockSnapshot.status === o.status) {
        const f = _orderLockSnapshot.fields, L = _orderLockSnapshot.locked;
        if (L.has('title')) o.title = f.title;
        if (L.has('type')) o.task_type = f.task_type;
        if (L.has('customer')) o.customer_id = f.customer_id;
        if (L.has('amount')) o.amount = f.amount;
        if (L.has('deadline')) o.deadline = f.deadline;
        if (L.has('designer')) {
          o.assigned_designer_id = f.assigned_designer_id;
          o.collab_designer_ids = f.collab_designer_ids.slice();
        }
      }
      _orderLockSnapshot = null;
      try { await ensureCustomerFromModal(); } catch (e) { return; }
      // 剥离 UI 临时状态（联系人选择等），避免传给数据库不存在的列
      delete o._contactName;
      delete o._contactPhone;
      let cust = (state._customers || []).find(c => c.id === o.customer_id);
      o.customer_name = cust ? cust.name : (o.customer_name || '');
      if (!o.title) { toast('请填写项目'); return; }
      // 单号为空时自动生成（格式 YYYYMMDD-NN），避免列表出现空白单号
      if (!o.order_no) {
        try { o.order_no = await DB.genOrderNo(); } catch (e) { o.order_no = ''; }
      }
      // 订单必须归属客户：未选且未新建则拦截，避免脏数据
      if (!o.customer_id) { toast('请选择或填写客户'); return; }
      let saved;
      if (o.id) { saved = await DB.saveOrder(o); logOp('编辑订单', '订单', o.id, o.order_no); toast('已保存'); }
      else {
        const { id, ...rest } = o;
        saved = await DB.saveOrder(rest);
        logOp('新建订单', '订单', saved && saved.id, rest.order_no);
        toast('已新建订单');
      }
      // 把新生成的 id 写回，确保任何后续操作都走「更新」而非「再建一条」
      if (saved && saved.id) o.id = saved.id;
      clearOrderDraft();
      o._dirty = false;
      closeModal(true); await refreshAll();
    } catch (e) { toast('保存失败：' + e.message); }
    finally {
      state._savingOrder = false;
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset._txt || '保存'; }
    }
  }

  async function delOrder(id) {
    if (!can('orders_delete')) { toast('无删除订单权限'); return; }
    if (!lockOp('delOrder:' + id)) return;   // 防重复点击（连点/双击）
    const o = (state._orders || []).find(x => x.id === id);
    const label = o && o.order_no ? '「' + o.order_no + '」' : '';
    // 删除订单需填写原因（与取消订单一致，留痕可复盘）；移入回收站可还原
    let reason = null;
    while (true) {
      const r = await uiInput('删除订单（移入回收站）' + label,
        '请填写删除原因（至少 4 个字，需含文字说明，不可用数字替代；如：信息重复 / 录入错误 / 客户要求撤销）。可在「设置 → 回收站」中还原。', true);
      if (r === null) { unlockOp('delOrder:' + id); return; }  // 用户取消输入 → 中止删除
      const err = validReason(r, '删除原因');
      if (err) { toast(err); continue; }
      reason = r; break;
    }
    try {
      await DB.deleteOrder(id, reason); logOp('删除订单', '订单', id, o && o.order_no || '', reason);
      closeModal(true);
      renderOrders();           // 立即乐观重渲染（cache 已无该单），不等 loadAll 网络往返，避免“删了还显示”
      await refreshAll();       // 后台静默同步云端
    }
    catch (e) { toast('移入回收站失败：' + e.message); }
    finally { unlockOp('delOrder:' + id); }
  }

  /* ============================================================
   * 工作台（个人订单卡片视图）
   * ============================================================ */
  // 临时协助记录：返回订单 temp_assist_log 里的设计师 id 列表（用于展示/过滤，不参与任何统计）
  function tempAssistIds(o) {
    return (o && Array.isArray(o.temp_assist_log)) ? o.temp_assist_log.map(r => r && r.did).filter(Boolean) : [];
  }
  function tempAssistHtml(o) {
    const log = (o && Array.isArray(o.temp_assist_log)) ? o.temp_assist_log : [];
    if (!log.length) return '<div class="muted" style="font-size:12px">暂无临时协助记录</div>';
    return log.map((r, i) =>
      '<div class="ta-item"><span>🤝 ' + esc(r.name || '未知') + ' · ' + esc(r.date || '') +
      (r.note ? ' · ' + esc(r.note) : '') + '</span>' +
      '<button type="button" class="btn-mini ta-del" data-ta-del="' + i + '" title="删除此条">×</button></div>'
    ).join('');
  }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function renderWorkbench() {
    if ((state.wbView || 'personal') === 'team') { renderTeamBoard(); return; }
    if (state.wbView === 'load') { renderLoadBoard(); return; }
    const sec = $('#tab-designers');
    if (sec) sec.classList.remove('team');
    const ds = state._designers || [];
    if (!ds.length) {
      fill('#wDesigner', []);
      $('#workbenchStats').innerHTML = '<div class="kpi" style="flex:1"><div class="label">提示</div><div class="value" style="font-size:16px">请先在设置页添加设计师</div></div>';
      $('#workbenchKpis').innerHTML = '';
      $('#workbenchCards').innerHTML = '<div class="empty">暂无设计师</div>';
      return;
    }
    // 数据范围：能否看全部由 isViewAll()（权限点 view_all_orders）决定
    let viewAll = isViewAll();
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

    // 工作台筛选：状态 + 时间周期，仅影响下方订单卡片列表，统计/KPI 仍显示总览
    const fStatus = $('#wbStatus') ? $('#wbStatus').value : '';
    const fPeriod = $('#wbPeriod') ? $('#wbPeriod').value : '';
    const now = new Date();
    let cardOrders = orders.slice();
    // 临时协助订单也展示给协助设计师（便于打开修改），但 `orders`（统计口径）仍只含 participants，故不计入任何业绩
    const taOrders = (state._orders || []).filter(o => d && tempAssistIds(o).includes(d.id) && !window.Cfg.participants(o).includes(d.id));
    cardOrders = cardOrders.concat(taOrders);
    if (fStatus === 'active') cardOrders = cardOrders.filter(o => ['派单', '设计中', '初稿', '客户反馈', '修改中', '提案'].includes(o.status));
    else if (fStatus) cardOrders = cardOrders.filter(o => o.status === fStatus);
    if (fPeriod) {
      cardOrders = cardOrders.filter(o => {
        const t = o.intake_at ? new Date(o.intake_at) : null;
        if (!t) return false;
        if (fPeriod === 'current' || fPeriod === 'previous') {
          const ref = fPeriod === 'previous' ? window.Calc.addMonths(now, -1) : now;
          const win = window.Calc.windowOf(ref, state._settings || {});
          return t.getTime() >= win.start.getTime() && t.getTime() <= win.end.getTime();
        }
        if (fPeriod === 'thisMonth') return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth();
        if (fPeriod === 'lastMonth') {
          const lm = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
          const ly = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
          return t.getFullYear() === ly && t.getMonth() === lm;
        }
        if (fPeriod === 'thisQuarter') {
          const q = Math.floor(now.getMonth() / 3), tq = Math.floor(t.getMonth() / 3);
          return t.getFullYear() === now.getFullYear() && q === tq;
        }
        if (fPeriod === 'thisYear') return t.getFullYear() === now.getFullYear();
        return true;
      });
    }
    // 自动隐藏已定稿（定稿满 24 小时）：聚焦进行中订单。
    // 仅当未显式筛选“已定稿”时生效；选“已定稿”即视为主动调取归档单。
    let hiddenArchived = 0;
    if (state.autoHideFinalized && fStatus !== '已定稿' && fStatus !== '已换人') {
      const before = cardOrders.length;
      cardOrders = cardOrders.filter(o => {
        if (o.status === '已定稿') return !(o.finalized_at && (now.getTime() - new Date(o.finalized_at).getTime()) > ARCHIVE_AFTER_HOURS * 3600000);
        if (o.status === '已换人') return !(o.switched_at && (now.getTime() - new Date(o.switched_at).getTime()) > ARCHIVE_AFTER_HOURS * 3600000);
        return true;
      });
      hiddenArchived = before - cardOrders.length;
    }
    cardOrders.sort((a, b) => {
      const sa = statusOrder(a.status), sb = statusOrder(b.status);
      if (sa !== sb) return sa - sb;
      return (b.intake_at || '').localeCompare(a.intake_at || '');
    });

    // 统计
    const inProgress = orders.filter(o => ['派单', '设计中', '初稿', '客户反馈', '修改中'].includes(o.status));
    const finalized = orders.filter(o => o.status === '已定稿');
    // 顶部设计师信息卡：单行横排（左人名 + 右统计数字）；「已换人」为业务终态，仅在订单列表/详情/卡片体现，个人工作台顶部卡不重复展示
    $('#workbenchStats').innerHTML =
      '<div class="wb-designer-bar">' +
        '<div class="wb-db-left"><span class="wb-db-icon">👤</span><span class="wb-db-name">' + esc(d ? d.name : '未选择') + '</span></div>' +
        '<div class="wb-db-nums">' +
          '<span class="wb-num wb-num-blue">' + inProgress.length + ' 进行中</span>' +
          '<span class="wb-num wb-num-green">' + finalized.length + ' 已定稿</span>' +
        '</div>' +
      '</div>';

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
    const revenue = orders.reduce((sum, o) => {
      const split = window.Cfg.revenueSplit(o, state._settings || {});
      return sum + (split[d.id] || 0);
    }, 0);

    const mk = (icon, value, label, accent) =>
      '<div class="kpi wb-mk-compact" data-accent="' + (accent || '#6366f1') + '">' +
        '<div class="kpi-icon">' + icon + '</div>' +
        '<div class="value">' + value + '</div>' +
        '<div class="label">' + esc(label) + '</div>' +
      '</div>';
    let kpisHtml =
      mk('📋', dispatchCount, '派单量', '#0ea5e9') +
      mk('📊', pct(finalizeRate), '定稿率', '#06b6d4') +
      mk('🎯', pct(firstProposalPassRate), '提案通过率', '#f59e0b') +
      mk('🎨', pct(draftToFinalizeRate), '初稿定稿率', '#4f46e5') +
      mk('⏱', avgCycle ? fmtCycle(avgCycle) : '—', '平均定稿时间', '#14b8a6') +
      mk('💰', '¥' + money(revenue), '个人营收', '#f59e0b');
    // 返工率 > 0 时才显示（零值不占空间）
    if (reworkRate > 0) kpisHtml += mk('⚠️', pct(reworkRate), '设计返工率', '#ef4444');
    $('#workbenchKpis').innerHTML = kpisHtml;

    // 应用 KPI 主题色
    $$('#workbenchKpis .kpi[data-accent]').forEach(el => {
      const color = el.dataset.accent;
      el.style.setProperty('--kpi-accent', color);
      el.style.setProperty('--kpi-bg', color + '18');
    });

    if (!orders.length) {
      $('#workbenchCards').innerHTML = '<div class="empty">该设计师暂无订单</div>';
      return;
    }
    const archiveHint = hiddenArchived
      ? '<div class="wb-archive-hint"><span class="wb-hint-ico">📂</span>已隐藏 ' + hiddenArchived + ' 个已完成订单（定稿满1天）· <a href="javascript:;" id="wbShowArchived">点击显示全部</a></div>'
      : '';
    if (!cardOrders.length) {
      $('#workbenchCards').innerHTML = archiveHint || '<div class="empty">没有符合筛选条件的订单</div>';
      bindShowArchived();
      return;
    }
    $('#workbenchCards').innerHTML = archiveHint + cardOrders.map(o => workbenchCard(o, d)).join('');
    bindWorkbenchCards();
    bindShowArchived();
    applyPermissions();
    updateSwipeDiag();
  }

  // 团队看板横向滚动提示：滚动到尽头后隐藏提示
  function bindTeamBoardScroll() {
    const board = $('#teamBoard');
    const hint = $('#teamScrollHint');
    if (!board || !hint) return;
    const check = () => {
      const hasOverflow = board.scrollWidth > board.clientWidth;
      const atEnd = board.scrollLeft + board.clientWidth >= board.scrollWidth - 2;
      hint.classList.toggle('hide', !hasOverflow || atEnd);
    };
    board.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check, { passive: true });
    check();
  }

  // 工作台卡片事件绑定（个人视图与团队看板共用）：流程推进、打开详情、打开/复制文件夹
  function bindWorkbenchCards() {
    $$('#workbenchCards [data-wb-act]').forEach(b => b.addEventListener('click', () => wbAdvance(b.dataset.wbId, b.dataset.wbAct)));
    $$('#workbenchCards [data-open]').forEach(b => b.addEventListener('click', () => openOrder(b.dataset.open)));
    $$('#workbenchCards [data-openfolder]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openInExplorer(b.dataset.openfolder); }));
    $$('#workbenchCards [data-fpcopy]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); copyText(b.dataset.fpcopy); toast('已复制路径'); }));
  }

  // 「我的工作台 → 团队看板」：所有设计师各占一列（管理员/店长看全团队，普通设计师仅看自己那一列），
  // 列内为该设计师当前进行中的任务卡，使用简化卡片以便一屏浏览更多列。
  function renderTeamBoard() {
    const sec = $('#tab-designers');
    if (sec) sec.classList.add('team');
    const ds = state._designers || [];
    const viewAll = isViewAll();
    let list = ds.filter(d => isActiveDesign(d));
    if (!viewAll) {
      list = ds.filter(d => state.currentUser && d.id === state.currentUser.id && isActiveDesign(d));
      if (!list.length && state.currentUser) list = [state.currentUser];
    }
    if (!list.length) {
      $('#workbenchStats').innerHTML = '';
      $('#workbenchKpis').innerHTML = '';
      $('#workbenchCards').innerHTML = '<div class="empty">暂无设计师</div>';
      return;
    }
    const ACTIVE = ['派单', '设计中', '初稿', '客户反馈', '修改中', '提案', '提案不通过'];
    let html = '<div class="team-scroll-hint" id="teamScrollHint">← 左右滑动 / 滚动查看更多设计师 →</div><div class="team-board" id="teamBoard">';
    list.forEach(d => {
      const orders = (state._orders || []).filter(o => (window.Cfg.participants(o).includes(d.id) || tempAssistIds(o).includes(d.id)) && ACTIVE.includes(o.status));
      orders.sort((a, b) => (b.intake_at || '').localeCompare(a.intake_at || ''));
      const cards = orders.length
        ? orders.map(o => teamBoardCard(o, d)).join('')
        : '<div class="team-empty">暂无进行中任务</div>';
      html += '<div class="team-col"><div class="team-col-head"><span class="team-col-name">' + esc(d.name) + '</span>' +
        '<span class="team-col-count">' + orders.length + ' 进行中</span></div>' +
        '<div class="team-col-body">' + cards + '</div></div>';
    });
    html += '</div>';
    $('#workbenchStats').innerHTML = '';
    $('#workbenchKpis').innerHTML = '';
    $('#workbenchCards').innerHTML = html;
    bindTeamBoardScroll();
    bindWorkbenchCards();
    applyPermissions();
    updateSwipeDiag();
  }

  // 「我的工作台 → 负荷」：设计师负荷看板。
  // 按进行中单数（主责+协作）排序，一眼看出谁忙谁闲，辅助派单决策。
  function renderLoadBoard() {
    const sec = $('#tab-designers');
    if (sec) sec.classList.add('team'); // 复用 team 模式布局（workbench-cards 铺满）
    const ds = state._designers || [];
    const viewAll = isViewAll();
    let list = ds.filter(d => isActiveDesign(d));
    if (!viewAll) {
      list = ds.filter(d => state.currentUser && d.id === state.currentUser.id && isActiveDesign(d));
      if (!list.length && state.currentUser) list = [state.currentUser];
    }
    if (!list.length) {
      $('#workbenchStats').innerHTML = '';
      $('#workbenchKpis').innerHTML = '';
      $('#workbenchCards').innerHTML = '<div class="empty">暂无设计师</div>';
      return;
    }
    const ACTIVE = ['派单', '设计中', '初稿', '客户反馈', '修改中', '提案', '提案不通过'];
    const now = Date.now();
    const rows = list.map(d => {
      const orders = (state._orders || []).filter(o => (window.Cfg.participants(o).includes(d.id) || tempAssistIds(o).includes(d.id)) && ACTIVE.includes(o.status));
      let nearDue = 0, overdue = 0, amt = 0; const dls = [];
      orders.forEach(o => {
        amt += Number(o.amount) || 0;
        if (!o.deadline) return;
        const t = new Date(o.deadline).getTime();
        if (isNaN(t)) return;
        dls.push(t);
        const diff = t - now;
        if (diff < 0) overdue++;
        else if (diff <= 24 * 3600000) nearDue++;
      });
      const maxDl = dls.length ? Math.max.apply(null, dls) : null;
      return { d, activeCount: orders.length, nearDue, overdue, amt, maxDl };
    });
    const maxCount = Math.max.apply(null, rows.map(r => r.activeCount).concat([0]));
    const scale = Math.max(maxCount, 5); // 条形满刻度（至少 5，避免单人时条拉满）
    const level = (n) => n >= 5 ? 'heavy' : (n >= 3 ? 'medium' : 'light');
    rows.sort((a, b) => (b.activeCount - a.activeCount) || (b.overdue - a.overdue) || a.d.name.localeCompare(b.d.name));
    let html = '<div class="load-board-head">设计师负荷看板 · 按进行中单数排序（含主责与协作）</div><div class="load-board" id="loadBoard">';
    rows.forEach(r => {
      const pctW = scale ? Math.round(r.activeCount / scale * 100) : 0;
      const lvl = level(r.activeCount);
      const freeText = r.maxDl ? ('预计 ' + fmtLoadDur(r.maxDl - now) + ' 后可接新单') : '立即可接新单';
      const tags = [];
      if (r.overdue) tags.push('<span class="load-tag danger">🔴 超期 ' + r.overdue + '</span>');
      if (r.nearDue) tags.push('<span class="load-tag warn">⏳ 临期 ' + r.nearDue + '</span>');
      html += '<div class="load-row" data-load-id="' + r.d.id + '">' +
        '<div class="load-row-top">' +
          '<span class="load-name">' + esc(r.d.name) + '</span>' +
          '<span class="load-count ' + lvl + '">' + r.activeCount + ' 单进行中</span>' +
        '</div>' +
        '<div class="load-bar-wrap"><div class="load-bar ' + lvl + '" style="width:' + pctW + '%"></div>' +
          '<span class="load-bar-cap">' + r.activeCount + ' / ' + scale + '</span></div>' +
        '<div class="load-row-foot">' +
          (tags.length ? tags.join('') : '<span class="load-tag ok">✓ 无临期/超期</span>') +
          '<span class="load-free">' + freeText + '</span>' +
          '<span class="load-amt">¥' + money(r.amt) + '</span>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    $('#workbenchStats').innerHTML = '';
    $('#workbenchKpis').innerHTML = '';
    $('#workbenchCards').innerHTML = html;
    bindLoadBoard();
    applyPermissions();
    updateSwipeDiag();
  }

  // 负荷看板：点击某设计师行 → 下钻到该设计师个人视图
  function bindLoadBoard() {
    $$('#loadBoard .load-row').forEach(r => r.addEventListener('click', () => {
      const id = r.dataset.loadId;
      state.wbView = 'personal';
      state.currentDesignerId = id;
      $$('#wbViewToggle .wb-view-btn').forEach(x => x.classList.toggle('active', x.dataset.view === 'personal'));
      renderWorkbench();
    }));
  }

  // 毫秒 → “X 天 Y 时 / Y 时 Z 分 / Z 分”
  function fmtLoadDur(ms) {
    const absMin = Math.max(0, Math.round(Math.abs(ms) / 60000));
    const d = Math.floor(absMin / 1440), h = Math.floor((absMin % 1440) / 60), m = absMin % 60;
    if (d > 0) return d + ' 天 ' + h + ' 时';
    if (h > 0) return h + ' 时 ' + m + ' 分';
    return m + ' 分';
  }

  // 点击"显示全部"→关闭自动隐藏并刷新工作台
  function bindShowArchived() {
    const link = $('#wbShowArchived');
    if (!link) return;
    link.addEventListener('click', () => {
      state.autoHideFinalized = false;
      const cb = $('#wbAutoHide');
      if (cb) cb.checked = false;
      renderWorkbench();
    });
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
      // 已完成：弱化展示完成周期提示（复盘用，不抢眼）
      if (diff < 0) return { badge: '<span class="wb-dl-badge dl-muted">⏱ 超期 ' + span + ' 完成</span>', cardClass: '', footClass: '' };
      return { badge: '<span class="wb-dl-badge dl-muted">✓ 按期完成</span>', cardClass: '', footClass: '' };
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

  function ringColor(o, progress, dl) {
    if (progress >= 100) return '#22c55e';                         // 已完成：绿
    if (dl.cardClass === 'wb-overdue') return '#ef4444';           // 超期：红
    if (dl.cardClass === 'wb-urgent') return '#f59e0b';           // 临期：橙
    return (window.Cfg.STATUS[o.status] || {}).color || '#6366f1'; // 跟随状态色
  }

  function workbenchCard(o, designer) {
    const dsMap = Object.fromEntries((state._designers || []).map(d => [d.id, d.name]));
    const isMeMain = o.assigned_designer_id === designer.id;
    const isMeCollab = Array.isArray(o.collab_designer_ids) && o.collab_designer_ids.includes(designer.id);
    const isMeTA = tempAssistIds(o).includes(designer.id);
    const roleTag = isMeMain ? '<span class="card-role main">负责人</span>' : isMeCollab ? '<span class="card-role collab">协作</span>' : isMeTA ? '<span class="card-role ta">临时协助</span>' : '<span class="card-role collab">协作</span>';
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
    const ringColorVal = ringColor(o, progress, dl);
    const ringSvg = '<div class="wb-ring"><svg class="wb-ring-svg" viewBox="0 0 44 44">' +
        '<circle class="wb-ring-bg" cx="22" cy="22" r="19"></circle>' +
        '<circle class="wb-ring-fg" cx="22" cy="22" r="19" pathLength="100" style="stroke:' + ringColorVal + ';stroke-dasharray:' + progress + ' ' + (100 - progress) + '"></circle>' +
        '</svg><div class="wb-ring-txt">' + progress + '%</div></div>';
    const statusPill = softBadge((window.Cfg.STATUS[o.status] || {}).color || '#64748b', esc((window.Cfg.STATUS[o.status] || {}).label || o.status));
    const done = (o.status === '已定稿' || o.status === '已换人');
    const finishTime = done ? (o.finalized_at || o.switched_at) : null;
    const nextHint = done
      ? '<span title="完成时间">' + (finishTime ? fmtTime(finishTime).slice(0, 10) : '—') + ' 完成</span>'
      : '<span title="下一步">' + esc(nextActionText(o.status)) + '</span>';
    const amountClass = (!o.amount || Number(o.amount) === 0) ? 'wb-hint-amount zero' : 'wb-hint-amount';
    const headRight = `
      <div class="wb-head-right">
        <div class="wb-head-status">${statusPill}</div>
        <div class="${amountClass}">¥${money(o.amount)}</div>
        <div class="wb-hint-next">${nextHint}</div>
      </div>`;
    const sameAsTitle = (o.customer_name || '').trim() === (o.title || '').trim();
    const clientPart = sameAsTitle ? '' : '<b>客户：</b>' + esc(o.customer_name || '—') + ' · ';
    const mainOwnerLine = isMeMain
      ? '<div class="wb-row wb-client-type">' + clientPart + '<b>类型：</b>' + esc(o.task_type) + '</div>'
      : '<div class="wb-row wb-client-type">' + clientPart + '<b>类型：</b>' + esc(o.task_type) + ' · <b>主负责人：</b>' + esc(dsMap[o.assigned_designer_id] || '未派') + '</div>';
    const myTa = (o.temp_assist_log || []).filter(r => r.did === designer.id);
    const taLine = myTa.length ? '<div class="wb-ta-line">🤝 临时协助：' + myTa.map(r => esc(r.date || '') + (r.note ? ' ' + esc(r.note) : '')).join('；') + '</div>' : '';
    return `
      <div class="wb-card ${dl.cardClass}">
        <div class="wb-head-ring">
          ${ringSvg}
          <div class="wb-head-main">
            <div class="wb-head-top">
              <div class="wb-head-left">
                <div class="wb-title">${esc(o.title)} ${roleTag}</div>
                <div class="wb-meta">
                  <span>${esc(o.order_no || '')}</span>
                  ${riskBadge(o)}
                </div>
              </div>
              ${headRight}
            </div>
          </div>
        </div>
        ${dl.badge ? '<div class="wb-dl-row">' + dl.badge + '</div>' : ''}
        <div class="wb-body">
          ${mainOwnerLine}
          ${taLine}
          <div class="wb-timeline">${timelineSummary}</div>
          ${o.file_paths && o.file_paths.length ? '<div class="wb-files">📂 素材：' + o.file_paths.map(p => '<a class="wb-fp" data-openfolder="' + esc(p) + '" title="' + esc(p) + '">' + esc(p.split('/').pop() || p) + '</a>').join(' ') + ' <button class="wb-open-folder" data-fpcopy="' + esc(o.file_paths.join('\n')) + '">复制路径</button></div>' : ''}
          ${(o.design_paths && o.design_paths.length) ? '<div class="wb-design"><span class="wb-design-lbl">🎨 设计稿：</span>' + o.design_paths.map(p => '<a class="wb-fp" data-openfolder="' + esc(p) + '" title="' + esc(p) + '">' + esc(p.split('/').pop() || p) + '</a>').join(' ') + ' <button class="wb-open-folder" data-fpcopy="' + esc(o.design_paths.join('\n')) + '">复制路径</button></div>' : ''}
        </div>
        <div class="wb-foot">
          <span class="wb-deadline">截稿：${fmtDeadline(o.deadline) || '未设置'}</span>
          <div class="wb-actions">${cardFlowButtons(o)}<button class="btn sm secondary" data-open="${o.id}">详情</button></div>
        </div>
      </div>`;
  }

  // 团队看板专用简化卡片：只保留最关键信息，整卡可点打开详情
  function teamBoardCard(o, designer) {
    const dsMap = Object.fromEntries((state._designers || []).map(d => [d.id, d.name]));
    const isMeMain = o.assigned_designer_id === designer.id;
    const isMeCollab = Array.isArray(o.collab_designer_ids) && o.collab_designer_ids.includes(designer.id);
    const isMeTA = tempAssistIds(o).includes(designer.id);
    const roleTag = isMeMain ? '<span class="card-role main">负责人</span>' : isMeCollab ? '<span class="card-role collab">协作</span>' : isMeTA ? '<span class="card-role ta">临时协助</span>' : '<span class="card-role collab">协作</span>';
    const FLOW = window.Cfg.FLOW;
    const curIdx = FLOW.indexOf(o.status);
    const totalSteps = FLOW.length;
    let progress = 0;
    if (o.status === '已定稿') progress = 100;
    else if (o.status === '已换人') progress = 100;
    else if (curIdx >= 0) progress = Math.max(0, Math.min(100, Math.round((curIdx / (totalSteps - 1)) * 100)));
    const dl = deadlineInfo(o);
    const color = ringColor(o, progress, dl);
    const statusCfg = window.Cfg.STATUS[o.status] || {};
    const statusPill = softBadge(statusCfg.color || '#64748b', esc(statusCfg.label || o.status));
    const sameAsTitle = (o.customer_name || '').trim() === (o.title || '').trim();
    const clientPart = sameAsTitle ? '' : esc(o.customer_name || '—') + ' · ';
    const myTa = (o.temp_assist_log || []).filter(r => r.did === designer.id);
    const taLine = myTa.length ? '<div class="wb-ta-line">🤝 临时协助：' + myTa.map(r => esc(r.date || '') + (r.note ? ' ' + esc(r.note) : '')).join('；') + '</div>' : '';
    return `
      <div class="team-card ${dl.cardClass}" data-open="${o.id}" title="点击查看详情">
        <div class="team-card-head">
          <div class="team-title">${esc(o.title)} ${roleTag}</div>
          <div class="team-meta"><span>${esc(o.order_no || '')}</span>${statusPill}</div>
        </div>
        <div class="team-progress"><div class="team-progress-bar" style="width:${progress}%;background:${color}"></div><span>${progress}%</span></div>
        <div class="team-client">${clientPart}${esc(o.task_type)}</div>
        ${dl.badge ? '<div class="team-dl">' + dl.badge + '</div>' : ''}
        ${taLine}
      </div>`;
  }

  // 卡片底部按当前状态直接给出流程推进按钮（无需打开详情）
  function cardFlowButtons(o) {
    const b = (act, label, cls) => '<button class="btn sm ' + (cls || '') + '" data-wb-act="' + act + '" data-wb-id="' + o.id + '">' + label + '</button>';
    // 按 flow_revert 权限可见的回退按钮（误推进一步时撤销）
    const rv = (can('flow_revert') && canRevert(o.status)) ? b('revert', '↩ 回退', 'ghost') : '';
    switch (o.status) {
      case '接单': return '<span class="wb-hint">等待管理员派单</span>' + rv;
      case '派单': return b('proposal', '提交提案', 'primary') + rv;
      case '提案': return b('proposal_pass', '提案通过', 'ok') + b('proposal_fail', '不通过', 'warn') + rv;
      case '提案不通过': return b('proposal_again', '二次提案', '') + b('switch', '换人', 'danger') + rv;
      case '设计中': return b('draft', '提交初稿', 'primary') + rv;
      case '初稿': return b('feedback', '送审客户', 'primary') + rv;
      case '客户反馈': return b('finalize', '定稿', 'ok') + b('revise', '需要修改', 'warn') + rv;
      case '修改中': return b('finalize', '客户定稿', 'ok') + b('switch', '换人', 'danger') + rv;
      case '已定稿':
      case '已换人': return '<span class="wb-hint">已完成</span>' + rv;
      default: return rv;
    }
  }

  function nextActionText(status) {
    const map = {
      '接单': '等待派单', '派单': '提交提案', '提案': '提案通过或不通过', '提案不通过': '继续提案或换人',
      '设计中': '提交初稿', '初稿': '送审客户', '客户反馈': '定稿或修改', '修改中': '修改完成后定稿',
      '已定稿': '已完成', '已换人': '已换人'
    };
    return map[status] || status;
  }

  function cardTimelineSummary(o) {
    const items = [
      { n: '接单', t: o.intake_at }, { n: '派单', t: o.dispatch_at },
      { n: '提案', t: o.proposal_at }, { n: '设计中', t: o.design_started_at },
      { n: '初稿', t: o.draft_at }, { n: '等客户反馈', t: o.feedback_at },
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
        return '<tr><td>' + esc(d.name) + '</td><td>' + esc(d.role) + '</td><td>' + esc(gMap[d.group_id] || '—') + '</td>' +
        '<td class="num">' + inProgress(d.id) + '</td>' +
        '<td><button class="btn sm status-toggle ' + (d.active === false ? 'off' : 'on') + '" data-act="' + d.id + '"' + (disabled ? ' disabled' : '') + '>' + (d.active === false ? '停用' : '在岗') + '</button></td>' +
        '<td style="text-align:center"><label class="tbl-cb"><input type="checkbox" class="design-cb" data-design="' + d.id + '"' + (designOn ? ' checked' : '') + (disabled ? ' disabled' : '') + ' title="' + designTitle + '"><span class="box"></span></label></td>' +
        '<td style="text-align:center"><label class="tbl-cb"><input type="checkbox" class="perf-cb" data-perf="' + d.id + '"' + (perfOn ? ' checked' : '') + (disabled ? ' disabled' : '') + ' title="' + perfTitle + '"><span class="box"></span></label></td>' +
        '<td style="text-align:center"><label class="tbl-cb"><input type="checkbox" class="avg-cb" data-avg="' + d.id + '"' + (avgOn ? ' checked' : '') + (disabled ? ' disabled' : '') + ' title="' + avgTitle + '"><span class="box"></span></label></td>' +
        '<td><button class="btn sm" data-rename="' + d.id + '">改名</button> ' +
        '<button class="btn sm" data-pw="' + d.id + '">改密码</button> ' +
        '<button class="btn sm danger" data-del="' + d.id + '">删除</button></td></tr>';
      }).join('') : '<tr><td colspan="9" class="empty">暂无人员</td></tr>') + '</tbody>';
    $$('#settingsDesignersTable [data-pw]').forEach(b => b.addEventListener('click', () => setDesignerPassword(b.dataset.pw)));
    $$('#settingsDesignersTable [data-rename]').forEach(b => b.addEventListener('click', () => renameDesigner(b.dataset.rename)));
    $$('#settingsDesignersTable [data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!can('manage_designers')) { toast('无权限'); return; }
      if (!lockOp('delDesigner:' + b.dataset.del)) return;
      try {
        if (!(await uiConfirm('删除人员？其 Auth 登录账号将被一并注销，订单将变为“未派”。'))) return;
        const d = (state._designers || []).find(x => x.id === b.dataset.del);
        if (d && d.auth_id) {
          try { await DB.auth.deleteUser(d.auth_id); } catch (e) { toast((e && e.message) || '注销 Auth 账号失败'); }
        }
        await DB.deleteDesigner(b.dataset.del); logOp('删除人员', '设计师', b.dataset.del, d ? d.name : ''); toast('已删除'); await refreshAll();
      } finally { unlockOp('delDesigner:' + b.dataset.del); }
    }));
    async function renameDesigner(id) {
      if (!can('manage_designers')) { toast('无权限'); return; }
      const d = (state._designers || []).find(x => x.id === id);
      if (!d) return;
      openModal(
        '<div class="modal"><h3>修改姓名</h3>' +
        '<div class="modal-body" style="padding:6px 0">' +
        '<label class="field"><span>姓名</span><input id="renameInput" class="input" value="' + esc(d.name) + '"></label>' +
        '</div>' +
        '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="renameSave">保存</button></div></div>'
      );
      const input = $('#renameInput');
      if (input) { input.focus(); input.select(); }
      const saveBtn = $('#renameSave');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) { toast('姓名不能为空'); return; }
        try {
          await DB.saveDesigner({ id, name });
          state._designers = await DB.listDesigners();
          closeModal(true);
          toast('已保存');
          renderSettings();
        } catch (e) { toast('保存失败：' + (e && e.message || e)); }
      });
      $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', () => closeModal(true)));
    }
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
    $$('#settingsDesignersTable .status-toggle').forEach(b => b.addEventListener('click', async () => {
      if (!can('manage_designers')) { toast('无权限'); return; }
      const d = (state._designers || []).find(x => x.id === b.dataset.act);
      const willDisable = d && d.active !== false;
      if (willDisable && !(await uiConfirm('停用该人员？其将不再出现在登录 / 派单 / 统计中（历史数据保留，可随时重新启用）。'))) return;
      await DB.saveDesigner({ id: b.dataset.act, active: !willDisable });
      state._designers = await DB.listDesigners();
      toast(!willDisable ? '已启用（在岗）' : '已停用');
      await refreshAll();
    }));
    // 渲染分组卡片
    $('#settingsGroupsCards').innerHTML = gs.length ? gs.map(g => {
      const members = ds.filter(d => d.group_id === g.id);
      const show = members.slice(0, 6).map(d => '<span class="group-member-chip">' + esc(d.name) + '</span>').join('');
      const more = members.length > 6 ? '<span class="group-member-chip muted">+' + (members.length - 6) + '</span>' : '';
      return '<div class="group-card" data-gid="' + g.id + '">' +
        '<div class="group-card-head">' +
          '<div class="group-card-title">' + esc(g.name) + '</div>' +
          '<div class="group-card-count">' + members.length + ' 人</div>' +
        '</div>' +
        '<div class="group-card-members">' + (members.length ? (show + more) : '<span class="group-empty">暂无成员</span>') + '</div>' +
        '<div class="group-card-foot">' +
          '<button class="btn sm" data-gedit="' + g.id + '">管理成员</button>' +
        '</div>' +
      '</div>';
    }).join('') : '<div class="empty">暂无分组，请在下方新建。</div>';

    // 卡片点击/管理成员按钮 → 打开编辑抽屉
    $$('#settingsGroupsCards .group-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('[data-gedit]')) openGroupEdit(card.dataset.gid);
      });
    });
    $$('#settingsGroupsCards [data-gedit]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      openGroupEdit(b.dataset.gedit);
    }));

    // 同步分组下拉
    fill('#dGroup', gs.map(g => [g.id, g.name]));
  }

  let editingGroupId = null;
  function openGroupEdit(gid) {
    const g = (state._groups || []).find(x => x.id === gid);
    if (!g) return;
    editingGroupId = gid;
    $('#groupEditTitle').textContent = '管理成员 · ' + g.name;
    $('#groupEditPanel').style.display = '';
    renderGroupMemberList();
    renderGroupAddSelect();
  }
  function closeGroupEdit() {
    editingGroupId = null;
    $('#groupEditPanel').style.display = 'none';
  }
  function renderGroupMemberList() {
    const ds = state._designers || [];
    const members = ds.filter(d => d.group_id === editingGroupId);
    $('#groupMemberList').innerHTML = members.length ? members.map(d =>
      '<div class="group-member-row">' +
        '<span>' + esc(d.name) + '</span>' +
        '<button class="btn sm danger" data-rm="' + d.id + '">移除</button>' +
      '</div>'
    ).join('') : '<div class="empty">该分组暂无成员</div>';
    $$('#groupMemberList [data-rm]').forEach(b => b.addEventListener('click', async () => {
      if (!lockOp('rmMember:' + b.dataset.rm)) return;
      try {
        await DB.saveDesigner({ id: b.dataset.rm, group_id: null });
        toast('已移出分组');
        state._designers = await DB.listDesigners();
        await refreshAll();
        renderGroupMemberList();
        renderGroupAddSelect();
      } finally { unlockOp('rmMember:' + b.dataset.rm); }
    }));
  }
  function renderGroupAddSelect() {
    const ds = state._designers || [];
    const available = ds.filter(d => d.group_id !== editingGroupId);
    const s = $('#groupAddMemberSelect');
    s.innerHTML = '<option value="">选择人员</option>' +
      available.map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('');
  }
  async function addMemberToGroup() {
    const sid = $('#groupAddMemberSelect').value;
    if (!sid) { toast('请选择人员'); return; }
    if (!lockOp('addMember:' + sid)) return;
    try {
      await DB.saveDesigner({ id: sid, group_id: editingGroupId });
      toast('已加入分组');
      state._designers = await DB.listDesigners();
      await refreshAll();
      renderGroupMemberList();
      renderGroupAddSelect();
    } finally { unlockOp('addMember:' + sid); }
  }
  async function addDesigner() {
    if (!lockOp('addDesigner')) return;
    try {
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
      logOp('新增人员', '设计师', row.id, name);
      $('#dName').value = ''; if ($('#dEmail')) $('#dEmail').value = ''; if ($('#dAuthPw')) $('#dAuthPw').value = '';
      toast('已添加（Auth 账号已创建）'); await refreshAll();
    } finally { unlockOp('addDesigner'); }
  }
  async function addGroup() {
    if (!lockOp('addGroup')) return;
    try {
      const name = $('#gName').value.trim();
      if (!name) { toast('请输入分组名'); return; }
      await DB.saveGroup({ name }); $('#gName').value = ''; toast('已添加'); await refreshAll();
    } finally { unlockOp('addGroup'); }
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
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', () => closeModal()));
    $('#pwSave').addEventListener('click', async () => {
      if (!lockOp('setPw:' + d.id)) return;
      try {
        const a = $('#pwNew').value || '', b = $('#pwConfirm').value || '';
        if (a.length < 6) { $('#pwErr').textContent = '密码至少 6 位'; return; }
        if (a !== b) { $('#pwErr').textContent = '两次输入不一致'; return; }
        if (!d.auth_id) { $('#pwErr').textContent = '该设计师尚未创建登录账号（auth_id 为空），无法代设密码'; return; }
        try {
          await DB.auth.setPassword({ auth_id: d.auth_id, password: a });
        } catch (e) { $('#pwErr').textContent = (e && e.message) || '更新失败'; return; }
        logOp('重置密码', '设计师', d.id, d.name);
        closeModal(); toast('密码已更新'); await refreshAll();
      } finally { unlockOp('setPw:' + d.id); }
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
      if (!lockOp('permSave')) return;
      try {
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
      } finally { unlockOp('permSave'); }
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
      if (!lockOp('permClear')) return;
      try {
        const id = $('#permOverrideSel').value; if (!id) return;
        const overrides = Object.assign({}, cfg.overrides); delete overrides[id];
        await DB.saveSettings({ permissions: Object.assign({}, cfg, { overrides }) });
        await refreshAll(); toast('已清除该设计师的个性化覆盖');
      } finally { unlockOp('permClear'); }
    });
  }

  /* ============================================================
   * 客户
   * ============================================================ */
  async function renderCustomers() {
    // 绑定客户搜索 / 类型筛选栏（仅一次）
    if (!state._custFilterBound) {
      const ci = $('#custSearch');
      if (ci) ci.addEventListener('input', () => {
        clearTimeout(state._custFilterTimer);
        state._custFilterTimer = setTimeout(() => {
          state.customerFilter.q = ci.value; state.customerPage = 1; renderCustomers();
        }, 250);
      });
      const ct = $('#custTypeFilter');
      if (ct) ct.addEventListener('change', () => { state.customerFilter.type = ct.value; state.customerPage = 1; renderCustomers(); });
      if (ci && state.customerFilter.q) ci.value = state.customerFilter.q;
      if (ct && state.customerFilter.type) ct.value = state.customerFilter.type;
      state._custFilterBound = true;
    }
    const orders = state._orders || [];
    const rawCs = state._customers || [];
    const f = state.customerFilter || { q: '', type: 'all' };
    const q = (f.q || '').trim().toLowerCase();
    // 分页前先按搜索关键字 / 类型筛选
    let cs = rawCs.filter(c => {
      const co = orders.filter(o => o.customer_id === c.id);
      if (f.type === 'repeat' && co.length < 2) return false;
      if (f.type === 'new' && co.length >= 2) return false;
      if (q) {
        const hay = [c.name, c.company, c.phone, c.tag, c.address].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    // 按当前排序规则排序（默认名称拼音升序）
    const custSort = state.customerSort || { key: 'name', dir: 'asc' };
    cs.sort((a, b) => cmpCustomers(a, b, custSort.key, custSort.dir));
    // 分页：每页数量取用户自定义的 customerPageSize（默认 CUSTOMER_PAGE_SIZE），避免客户量过大时一次性渲染导致卡顿
    const pageSize = state.customerPageSize || CUSTOMER_PAGE_SIZE;
    const total = cs.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (state.customerPage < 1) state.customerPage = 1;
    if (state.customerPage > totalPages) state.customerPage = totalPages;
    const page = state.customerPage;
    const start = (page - 1) * pageSize;
    const pageItems = cs.slice(start, start + pageSize);
    const sk = custSort.key, sd = custSort.dir;
    const sortable = (key, label, cls) => '<th class="' + (cls || '') + (key ? ' sortable' : '') + (key === sk ? ' sorted' : '') + '"' + (key ? ' data-sort="' + key + '"' : '') + '>' + label + (key === sk ? (sd === 'asc' ? ' ▲' : ' ▼') : '') + '</th>';
    $('#customersTable').innerHTML =
      '<thead><tr>' +
      sortable('name', '客户') +
      sortable('', '联系人') +
      sortable('', '电话') +
      sortable('', '标注') +
      sortable('amount', '累计金额', 'num') +
      sortable('orders', '订单数', 'num') +
      sortable('lastOrder', '最近下单') +
      sortable('', '类型') +
      sortable('', '操作') +
      '</tr></thead><tbody>' +
      (pageItems.length ? pageItems.map(c => {
        const co = orders.filter(o => o.customer_id === c.id);
        const amt = co.reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const repeat = co.length >= 2;
        const lastTs = co.length ? co.map(o => o.intake_at || '').filter(Boolean).sort().slice(-1)[0] : '';
        return '<tr style="cursor:pointer" data-cid="' + c.id + '">' +
          '<td>' + esc(c.name) + (repeat ? ' <span class="repeat-tag">复购</span>' : '') + '</td>' +
          '<td>' + esc(c.company || '—') + '</td><td>' + esc(c.phone || '—') + '</td>' +
          '<td>' + (c.tag ? '<span class="cust-pill tag">🏷 ' + esc(c.tag) + '</span>' : '—') + '</td>' +
          '<td class="num">¥' + money(amt) + '</td><td class="num">' + co.length + '</td>' +
          '<td>' + (lastTs ? fmtTime(lastTs).slice(0, 10) : '—') + '</td>' +
          '<td>' + (repeat ? '复购' : '新客') + '</td>' +
          '<td><button class="btn sm secondary" data-view="' + c.id + '">详情</button> ' +
          '<button class="btn sm danger" data-cdel="' + c.id + '" data-perm="customers_delete">删除</button></td></tr>';
      }).join('') : '<tr><td colspan="9" class="empty">暂无客户，点击“新建客户”</td></tr>') + '</tbody>';
    // 使用事件委托绑定操作列按钮与表头排序，避免 innerHTML 重绘后事件丢失
    const table = $('#customersTable');
    if (!table._actBound) {
      table.addEventListener('click', e => {
        const th = e.target.closest('[data-sort]');
        if (th) { e.stopPropagation(); toggleCustomerSort(th.dataset.sort); return; }
        const vb = e.target.closest('[data-view]');
        if (vb) { e.stopPropagation(); viewCustomer(vb.dataset.view); return; }
        const db = e.target.closest('[data-cdel]');
        if (db) { e.stopPropagation(); delCustomer(db.dataset.cdel); return; }
        const row = e.target.closest('tr[data-cid]'); if (row) viewCustomer(row.dataset.cid);
      });
      table._actBound = true;
    }
    renderCustomersPager(total, page, totalPages, rawCs.length);
    applyPermissions();
    updateSwipeDiag();
  }

  // 客户列表分页控件
  function renderCustomersPager(total, page, totalPages, all) {
    const pg = $('#customersPager');
    if (!pg) return;
    pg._totalPages = totalPages;
    if (total <= 0) { pg.innerHTML = ''; return; }
    const allCount = all == null ? total : all;
    const stat = (total < allCount) ? ('筛选后 ' + total + ' / 共 ' + allCount) : ('共 ' + allCount);
    const curSize = state.customerPageSize || CUSTOMER_PAGE_SIZE;
    const sizeOptions = [20, 50, 100, 200, 500];
    const sizeCtl = '<button class="btn sm page-size-btn" data-ps="customers">每页 ' + curSize + ' 条 ▼</button>';
    pg.innerHTML =
      '<span class="pager-info">' + stat + ' · 第 ' + page + ' / ' + totalPages + ' 页</span>' +
      sizeCtl +
      '<button class="btn sm" data-pg="first"' + (page <= 1 ? ' disabled' : '') + '>« 首页</button>' +
      '<button class="btn sm" data-pg="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<button class="btn sm" data-pg="next"' + (page >= totalPages ? ' disabled' : '') + '>下一页</button>' +
      '<button class="btn sm" data-pg="last"' + (page >= totalPages ? ' disabled' : '') + '>末页 »</button>';
    if (!pg._bound) {
      pg.addEventListener('click', e => {
        const btn = e.target.closest('.page-size-btn');
        if (btn && btn.dataset.ps === 'customers') {
          showPageSizePicker({ current: state.customerPageSize || CUSTOMER_PAGE_SIZE, options: sizeOptions, anchor: btn, placement: 'top', onSelect: v => {
            state.customerPageSize = v;
            try { localStorage.setItem('ds_cust_pagesize', String(v)); } catch (err) {}
            state.customerPage = 1; renderCustomers();
          }});
          return;
        }
        const b = e.target.closest('[data-pg]');
        if (!b || b.disabled) return;
        const tp = pg._totalPages || 1;
        if (b.dataset.pg === 'first') state.customerPage = 1;
        else if (b.dataset.pg === 'prev') state.customerPage = Math.max(1, state.customerPage - 1);
        else if (b.dataset.pg === 'next') state.customerPage = Math.min(tp, state.customerPage + 1);
        else if (b.dataset.pg === 'last') state.customerPage = tp;
        renderCustomers();
      });
      pg._bound = true;
    }
  }

  // 删除客户（事件委托调用），删除后回到第 1 页
  async function delCustomer(cid) {
    if (!can('customers_delete')) { toast('无权限'); return; }
    if (!lockOp('delCustomer:' + cid)) return;
    try {
      const cn = (state._customers || []).find(x => x.id === cid);
      // 删除客户需填写原因（与取消订单一致，留痕可复盘）；移入回收站可还原
      let reason = null;
      while (true) {
        const r = await uiInput('删除客户（移入回收站）' + (cn ? '「' + cn.name + '」' : ''),
          '请填写删除原因（至少 4 个字，需含文字说明，不可用数字替代；如：信息重复 / 录入错误 / 客户长期无合作）。可在「设置 → 回收站」中还原。', true);
        if (r === null) { unlockOp('delCustomer:' + cid); return; }  // 用户取消输入 → 中止删除
        const err = validReason(r, '删除原因');
        if (err) { toast(err); continue; }
        reason = r; break;
      }
      await DB.deleteCustomer(cid, reason); logOp('删除客户', '客户', cid, cn ? cn.name : '', reason);
      toast('已删除'); state.customerPage = 1;
      renderCustomers();        // 立即乐观重渲染（cache 已无该客户），避免“删了还显示”
      await refreshAll();       // 后台静默同步云端
    } finally { unlockOp('delCustomer:' + cid); }
  }
  function newCustomer() { openCustomerModal(null); }
  // 新建/编辑客户共用：传入已有客户对象即进入编辑模式，保存时级联更新其历史订单的客户名
  function openCustomerModal(existing) {
    const c = existing || {};
    const extra0 = Array.isArray(c.contacts_json) ? c.contacts_json.slice() : [];
    openModal(`<button class="close" data-close>×</button><h3>${existing ? '编辑客户' : '新建客户'}</h3>
      <div class="grid2">
        <div class="field"><label>客户名称</label><input id="cName" value="${esc(c.name || '')}" placeholder="如：XX公司"></div>
        <div class="field"><label>主联系人</label><input id="cCompany" value="${esc(c.company || '')}" placeholder="联系人姓名"></div>
        <div class="field"><label>电话</label><input id="cPhone" type="tel" inputmode="numeric" value="${esc(c.phone || '')}"></div>
        <div class="field"><label>地址</label><input id="cAddress" value="${esc(c.address || '')}"></div>
        <div class="field"><label>文字标注</label><input id="cTag" value="${esc(c.tag || '')}" placeholder="如：重点客户 / 价格敏感 / 急单优先"></div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>更多联系人（可选）</label>
        <div id="cExtraContacts"></div>
        <button type="button" class="btn secondary" id="cAddContact" style="margin-top:6px;font-size:12px;padding:4px 10px">＋ 添加联系人</button>
      </div>
      <div class="field" style="margin-top:10px"><label>备注</label><textarea id="cNotes" rows="2">${esc(c.notes || '')}</textarea></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn secondary" data-close>取消</button>
        <button class="btn" id="cSave">保存</button>
      </div>`);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', () => closeModal()));
    // 多联系人维护（主联系人仍走 company 字段，contacts_json 存额外联系人）
    let extraContacts = extra0.map(x => ({ name: x.name || '', phone: x.phone || '', role: x.role || '' }));
    function syncExtraFromDom() {
      const rows = $$('#cExtraContacts .c-contact-row');
      extraContacts = rows.map(r => ({
        name: (r.querySelector('.cc-name').value || '').trim(),
        phone: (r.querySelector('.cc-phone').value || '').trim(),
        role: (r.querySelector('.cc-role').value || '').trim()
      }));
    }
    function renderExtra() {
      const box = $('#cExtraContacts'); if (!box) return;
      box.innerHTML = extraContacts.map((ct, i) =>
        '<div class="c-contact-row">' +
          '<input class="cc-name" placeholder="姓名" value="' + esc(ct.name) + '">' +
          '<input class="cc-phone" placeholder="电话" value="' + esc(ct.phone) + '">' +
          '<input class="cc-role" placeholder="如：设计/采购" value="' + esc(ct.role) + '">' +
          '<button type="button" class="cc-del" data-i="' + i + '">×</button>' +
        '</div>'
      ).join('');
    }
    renderExtra();
    $('#cAddContact').addEventListener('click', () => { syncExtraFromDom(); extraContacts.push({ name: '', phone: '', role: '' }); renderExtra(); });
    $('#cExtraContacts').addEventListener('click', e => {
      const btn = e.target.closest('.cc-del'); if (!btn) return;
      syncExtraFromDom(); extraContacts.splice(Number(btn.dataset.i), 1); renderExtra();
    });
    $('#cSave').addEventListener('click', async () => {
      if (!lockOp('saveCustomer')) return;
      try {
        const name = $('#cName').value.trim(); if (!name) { toast('请输入名称'); return; }
        // 联系人与电话校验：新建客户必填，编辑客户若填写则校验格式（防止 "1" 占位）
        const company = $('#cCompany').value.trim();
        const phone = $('#cPhone').value.trim();
        if (!existing) {
          if (!company) { toast('请输入主联系人'); return; }
          if (!validContactName(company)) { toast('主联系人至少 2 个字符'); return; }
          if (!phone) { toast('请输入联系电话'); return; }
          if (!validPhone(phone)) { toast('联系电话格式不正确（需为 7-15 位数字）'); return; }
        } else if (phone && !validPhone(phone)) {
          toast('联系电话格式不正确（需为 7-15 位数字）'); return;
        }
        // 同名查重：编辑自身时排除自己；新建时若已有同名客户则确认（保留合法重名）
        const dup = (state._customers || []).find(x => x.id !== c.id && (x.name || '').trim().toLowerCase() === name.toLowerCase());
        if (dup) {
          const ok = await uiConfirm('已存在同名客户「' + dup.name + '」，确定要再新建一个吗？');
          if (!ok) return;
        }
        syncExtraFromDom();
        const contacts_json = extraContacts.filter(x => x.name || x.phone || x.role);
        const savedC = await DB.saveCustomer({
          id: c.id || undefined,
          name, company: $('#cCompany').value, phone: $('#cPhone').value, address: $('#cAddress').value, notes: $('#cNotes').value,
          contacts_json,
          // 新建客户写入归属人；编辑时不动 created_by（保留原始创建者）
          created_by: existing ? undefined : ((state.currentUser && state.currentUser.id) || undefined)
        });
        logOp(existing ? '编辑客户' : '新建客户', '客户', savedC.id, name);
        toast(existing ? '已更新客户（历史订单客户名已同步）' : '已添加客户');
        closeModal(); state.customerPage = 1; await refreshAll();
      } finally { unlockOp('saveCustomer'); }
    });
  }
  async function viewCustomer(id) {
    const c = (state._customers || []).find(x => x.id === id); if (!c) return;
    const orders = (state._orders || []).filter(o => o.customer_id === id);
    const orderCount = orders.length;
    const amt = orders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const repurchaseCount = orderCount >= 2 ? orderCount - 1 : 0;
    const avgAmt = orderCount ? Math.round(amt / orderCount) : 0;
    const lastOrder = orderCount ? orders.reduce((m, o) => (o.intake_at || '') > m ? (o.intake_at || '') : m, '') : '';
    const totalComplaints = orders.reduce((s, o) => s + (Number(o.complaint_count) || 0), 0);
    // 客户分层：沉睡（90天无新单）/ 重点（≥3单）/ 新（1单）/ 普通 / 潜在（0单）
    let seg = { label: '普通客户', cls: 'seg-normal' };
    if (orderCount === 0) seg = { label: '潜在客户', cls: 'seg-dorm' };
    else {
      const days = lastOrder ? Math.floor((Date.now() - new Date(lastOrder).getTime()) / 86400000) : 0;
      if (days > 90) seg = { label: '沉睡客户', cls: 'seg-dorm' };
      else if (orderCount >= 3) seg = { label: '重点客户', cls: 'seg-key' };
      else if (orderCount === 1) seg = { label: '新客户', cls: 'seg-new' };
    }
    // 投诉记录：跨订单聚合 complaint_log（每条带来源单号/项目）
    const compRows = [];
    orders.forEach(o => { (Array.isArray(o.complaint_log) ? o.complaint_log : []).forEach(cmp => compRows.push(Object.assign({}, cmp, { orderNo: o.order_no, title: o.title }))); });
    compRows.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    const compHtml = totalComplaints === 0
      ? '<div class="cust-comp-empty">暂无投诉记录 ✓</div>'
      : '<div class="cust-comp-list">' + compRows.map(cmp =>
          '<div class="cust-comp-item"><div class="cust-comp-top"><span class="badge ' + (cmp.reason === '设计原因' ? 'bad' : 'warn') + '">' + esc(cmp.reason || '—') + '</span> <span class="muted">' + (cmp.ts ? fmtTime(cmp.ts) : '') + '</span></div>' +
          '<div class="cust-comp-order muted">单号 ' + esc(cmp.orderNo) + ' · ' + esc(cmp.title) + '</div>' +
          (cmp.note ? '<div class="cust-comp-note">' + esc(cmp.note) + '</div>' : '') +
          '</div>').join('') + '</div>';
    const html = `<button class="close" data-close>×</button>
      <div class="cust-head"><h3>${esc(c.name)}</h3><div class="cust-seg"><span class="seg-tag ${seg.cls}">${seg.label}</span></div></div>
      <div class="cust-metrics">
        <div class="cm"><div class="cm-val">¥${money(amt)}</div><div class="cm-label">累计消费</div></div>
        <div class="cm"><div class="cm-val">${repurchaseCount} 次</div><div class="cm-label">复购次数</div></div>
        <div class="cm"><div class="cm-val">¥${money(avgAmt)}</div><div class="cm-label">平均客单价</div></div>
        <div class="cm"><div class="cm-val">${lastOrder ? fmtTime(lastOrder) : '—'}</div><div class="cm-label">最近下单</div></div>
      </div>
      <div class="grid2">
        <div><b>联系人：</b>${esc(c.company || '—')}</div><div><b>电话：</b>${esc(c.phone || '—')}</div>
        <div><b>地址：</b>${esc(c.address || '—')}</div><div><b>文字标注：</b>${esc(c.tag || '—')}</div>
      </div>
      ${ (Array.isArray(c.contacts_json) && c.contacts_json.length) ? '<div style="margin-top:10px"><b>更多联系人：</b><div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px">' + c.contacts_json.map(ct => '<span class="cust-pill">' + esc(ct.role || '联系人') + '：' + esc(ct.name || '') + (ct.phone ? ' ' + esc(ct.phone) : '') + '</span>').join('') + '</div></div>' : '' }
      <p style="color:var(--muted)">${esc(c.notes || '')}</p>
      <h3>投诉记录（${totalComplaints}）</h3>
      <div class="cust-complaints">${compHtml}</div>
      <h3>历史订单（${orderCount}）</h3>
      <div class="table-scroll"><table class="tbl" id="custHistoryTable"><thead><tr><th>单号</th><th>项目</th><th>金额</th><th>状态</th><th>接单</th></tr></thead><tbody>` +
      (orderCount ? orders.slice().sort((a, b) => (a.intake_at || '').localeCompare(b.intake_at || '')).map(o =>
        '<tr style="cursor:pointer" data-oid="' + o.id + '" title="点击查看该订单"><td>' + esc(o.order_no) + '</td><td>' + esc(o.title) + '</td><td class="num">¥' + money(o.amount) + '</td><td>' + pill(o.status) + '</td><td>' + fmtTime(o.intake_at) + '</td></tr>'
      ).join('') : '<tr><td colspan="5" class="empty">暂无订单</td></tr>') + '</tbody></table></div>' +
      '<div class="modal-foot">' + (can('customers_edit') ? '<button class="btn" id="cEdit">编辑</button>' : '') +
        (can('orders_create') ? '<button class="btn primary" id="cNewOrder">为该客户新建订单</button>' : '') +
        '<button class="btn secondary" id="cClose" data-close>关闭</button></div>';
    openModal(html);
    $$('#modalBox [data-close]').forEach(b => b.addEventListener('click', () => closeModal()));
    const cEdit = $('#cEdit'); if (cEdit) cEdit.addEventListener('click', () => { closeModal(); openCustomerModal(c); });
    const cNewOrder = $('#cNewOrder'); if (cNewOrder) cNewOrder.addEventListener('click', () => { closeModal(); newOrderForCustomer(c.id); });
    const cClose = $('#cClose'); if (cClose) cClose.addEventListener('click', () => closeModal());
    // 历史订单行点击 → 直接打开对应订单详情（#custHistoryTable 每次 openModal 都重建，不会重复绑定）
    const histTable = $('#custHistoryTable');
    if (histTable) histTable.addEventListener('click', e => {
      const tr = e.target.closest('tr[data-oid]');
      if (tr) openOrder(tr.dataset.oid);
    });
  }

  /* ============================================================
   * 经营分析导出（含业绩指标）
   * ============================================================ */
  async function exportAnaCSV() {
    if (!lockOp('exportAna')) return;
    try {
      if (!state._ana) await renderAnalytics();
      const rep = state._ana;
      const hasXlsx = await ensureXlsxLib();
      const period = state.anaMode === 'custom' ? '自定义'
        : (state.anaMode === 'previous' ? '上期' : '本期');
      const rangeText = fmtTime(rep.range.start).slice(0, 10) + ' ~ ' + fmtTime(rep.range.end).slice(0, 10);
      const fnBase = '经营分析_' + fmtTime(rep.range.start).slice(0, 10) + '_' + fmtTime(rep.range.end).slice(0, 10);
      const n = v => Number(v) || 0;

      // ---------- Excel 样式（xlsx 库支持时生效；不支持则静默忽略） ----------
      const C_TITLE = '1F2937', C_SUB = '6B7280', C_HEAD = 'FFFFFF', C_HEAD_BG = '4F46E5',
            C_SEC_BG = 'E0E7FF', C_BORDER = 'D1D5DB', C_MUTED = '6B7280';
      const border = { top: { style: 'thin', color: { rgb: C_BORDER } }, bottom: { style: 'thin', color: { rgb: C_BORDER } }, left: { style: 'thin', color: { rgb: C_BORDER } }, right: { style: 'thin', color: { rgb: C_BORDER } } };
      const S = {
        title: { font: { bold: true, sz: 16, color: { rgb: C_TITLE } }, alignment: { horizontal: 'center', vertical: 'center' } },
        subtitle: { font: { sz: 11, color: { rgb: C_SUB } }, alignment: { horizontal: 'right', vertical: 'center' } },
        label: { font: { bold: true, sz: 11, color: { rgb: C_HEAD } }, fill: { fgColor: { rgb: C_HEAD_BG }, patternType: 'solid' }, alignment: { horizontal: 'center', vertical: 'center' }, border },
        section: { font: { bold: true, sz: 12, color: { rgb: C_TITLE } }, fill: { fgColor: { rgb: C_SEC_BG }, patternType: 'solid' }, alignment: { horizontal: 'left', vertical: 'center' }, border },
        text: { alignment: { horizontal: 'left', vertical: 'center' } },
        textC: { alignment: { horizontal: 'center', vertical: 'center' } },
        num: { numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' } },
        money: { numFmt: '¥#,##0.00', alignment: { horizontal: 'right', vertical: 'center' } },
        pct: { numFmt: '0.0%', alignment: { horizontal: 'right', vertical: 'center' } },
        muted: { font: { color: { rgb: C_MUTED } }, alignment: { horizontal: 'left', vertical: 'center' } },
        cycle: { alignment: { horizontal: 'left', vertical: 'center' } }
      };
      const cell = (v, s) => v == null ? null : { v, s };
      const txt = v => cell(v, S.text);
      const txtC = v => cell(v, S.textC);
      const num = v => cell(n(v), S.num);
      const moneyCell = v => cell(n(v), S.money);
      const pctCell = v => cell(n(v), S.pct);
      const muted = v => cell(v, S.muted);
      const cycle = v => cell(v, S.cycle);

      // ---------- Sheet1 总览 KPI ----------
      const t = rep.totals, sm = rep.small;
      const overview = [
        [cell('经营分析报表', S.title), null, null],
        [cell(period, S.subtitle), cell(rangeText, S.subtitle), null],
        [],
        [cell('KPI', S.section), cell('数值', S.section), cell('说明', S.section)],
        [txt('总接单量'), num(t.intakeCount), muted('范围内接单总数')],
        [txt('规定时间总营收'), moneyCell(t.revenue), muted('范围内全部单子金额合计')],
        [txt('客户投诉笔数'), num(t.complaints), muted('范围内投诉合计')],
        [txt('派单订单数'), num(t.dispatchOrders), muted('范围内派发（唯一单）')],
        [txt('平均定稿时间'), txt(t.avgCycleTeam ? fmtCycle(t.avgCycleTeam) : '—'), muted('派单→定稿均值')],
        [txt('提案通过率'), pctCell(t.proposalPassRate), muted('提案通过 ÷ 已决提案')],
        [txt('一次提案通过率'), pctCell(t.firstProposalPassRate), muted('首次提案一次过 ÷ 已决提案')],
        [txt('初稿定稿率'), pctCell(t.draftToFinalizeRate), muted('已定稿且修改 0 次')],
        [txt('定稿率'), pctCell(t.dispatchOrders ? t.finalizedCount / t.dispatchOrders : 0), muted('定稿 ÷ 派单总数')],
        [txt('设计返工率'), pctCell(t.reworkRate), muted('设计责任返工 ÷ 已定稿')],
        [txt('当前在制'), num(t.currentInProgress), muted('全组实时未结案')],
        [txt('峰值并发(单人最高)'), num(t.peakConcurrency), muted('范围内单人同时最多')],
        [txt('小单达标'), txt(sm.smallOkCount + '/' + sm.designerCount + ' 人'), muted('≥' + sm.target + '单/人 · 人均 ' + sm.avgSmallTeam)],
        [txt('已取消订单数'), num(t.cancelCount), muted('范围内客户中途终止')],
        [txt('客户取消率'), pctCell(t.cancelRate), muted('已取消 ÷ (已取消+已定稿+已换人)')],
        [],
        [cell('工资核算（团队）', S.section), cell('数值', S.section), cell('说明', S.section)],
        [txt('团队营收'), moneyCell(t.teamRevenue), muted('范围内全部单子金额合计')],
        [txt('团队奖'), moneyCell(t.teamAward), muted('')],
        [txt('绩效合计'), moneyCell(t.totalPerfSum), muted('所有设计师总绩效')],
        [txt('人均小单'), num(t.teamAvgSmall), muted('参与平均的设计师均值')]
      ];
      const overviewMerges = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
        { s: { r: 1, c: 1 }, e: { r: 1, c: 2 } }
      ];
      const overviewCols = [{ wch: 22 }, { wch: 16 }, { wch: 45 }];
      const overviewRows = [{ hpt: 32 }, { hpt: 22 }];

      // ---------- Sheet2 设计师明细（含工资核算） ----------
      const designerHead = ['设计师', '角色', '派单量', '定稿率', '一次提案通过率', '初稿定稿率', '平均定稿时间',
        '设计返工率', '定稿数', '完成率', '当前在制', '峰值并发', '小单有效', '小单达标', '营收',
        '基础绩效', '绩效系数', '小单提成', '小单扣减', '总绩效'];
      const designerRows = rep.rows.map(r => [
        txt(r.designerName), txt(r.role), num(r.dispatchCount),
        pctCell(r.finalizeRate), pctCell(r.firstProposalPassRate), pctCell(r.draftToFinalizeRate),
        cycle(r.avgCycle ? fmtCycle(r.avgCycle) : '—'), pctCell(r.reworkRate),
        num(r.finalizedCount), pctCell(r.completion), num(r.currentLoad), num(r.peakLoad),
        num(r.smallCount), txtC(r.smallOk ? '达标' : '未达标'), moneyCell(r.revenue),
        moneyCell(r.basePerf), r.coef != null ? num(r.coef) : txt(''), moneyCell(r.smallBonus), moneyCell(r.smallDeduction), moneyCell(r.totalPerf)
      ]);
      const designerHeadStyled = designerHead.map(h => cell(h, S.label));
      const designerRowsStyled = [designerHeadStyled].concat(designerRows);
      const designerCols = [12, 10, 10, 12, 14, 14, 14, 14, 10, 10, 12, 12, 12, 12, 14, 12, 12, 12, 12, 12].map(w => ({ wch: w }));
      const designerFreeze = { xSplit: 0, ySplit: 1, topLeftCell: 'A2' };

      // ---------- Sheet3 项目明细 ----------
      const orderHead = ['单号', '项目', '客户', '任务类型', '金额', '状态', '参与设计师',
        '改稿次数', '返工原因', '投诉次数', '周期(天)', '接单时间', '派单时间', '截稿时间', '定稿时间', '换人时间'];
      const orderRows = (rep.perOrder || []).map(o => [
        txt(o.order_no), txt(o.title), txt(o.customer_name || ''), txt(o.task_type || ''), moneyCell(o.amount),
        txt((window.Cfg.STATUS[o.status] || {}).label || o.status),
        txt(o.participantNames.join(' / ')), num(o.revision_count),
        txt(o.rework_category || ''), num(o.complaint_count),
        cycle(o.cycleDays != null ? fmtCycle(o.cycleDays) : '—'),
        txt(fmtTime(o.intake_at)), txt(fmtTime(o.dispatch_at)), txt(fmtTime(o.deadline)),
        txt(fmtTime(o.finalized_at)), txt(fmtTime(o.switched_at))
      ]);
      const orderHeadStyled = orderHead.map(h => cell(h, S.label));
      const orderRowsStyled = [orderHeadStyled].concat(orderRows);
      const orderCols = [18, 28, 18, 12, 12, 12, 22, 10, 14, 10, 10, 16, 16, 16, 16, 16].map(w => ({ wch: w }));
      const orderFreeze = { xSplit: 0, ySplit: 1, topLeftCell: 'A2' };

      if (hasXlsx) {
        const wb = window.XLSX.utils.book_new();
        const wsOverview = window.XLSX.utils.aoa_to_sheet(overview);
        wsOverview['!merges'] = overviewMerges;
        wsOverview['!cols'] = overviewCols;
        wsOverview['!rows'] = overviewRows;
        window.XLSX.utils.book_append_sheet(wb, wsOverview, '总览');

        const wsDesigner = window.XLSX.utils.aoa_to_sheet(designerRowsStyled);
        wsDesigner['!cols'] = designerCols;
        wsDesigner['!freeze'] = designerFreeze;
        window.XLSX.utils.book_append_sheet(wb, wsDesigner, '设计师明细');

        const wsOrder = window.XLSX.utils.aoa_to_sheet(orderRowsStyled);
        wsOrder['!cols'] = orderCols;
        wsOrder['!freeze'] = orderFreeze;
        window.XLSX.utils.book_append_sheet(wb, wsOrder, '项目明细');

        window.XLSX.writeFile(wb, fnBase + '.xlsx', { cellStyles: true });
        toast('已导出 Excel（含总览/设计师/项目三表）');
      } else {
        // CSV 降级：无样式，保持简单文本
        const overviewCSV = [
          ['经营分析报表', period, rangeText],
          [],
          ['KPI', '数值', '说明'],
          ['总接单量', t.intakeCount, '范围内接单总数'],
          ['规定时间总营收', n(t.revenue), '范围内全部单子金额合计'],
          ['客户投诉笔数', t.complaints, '范围内投诉合计'],
          ['派单订单数', t.dispatchOrders, '范围内派发（唯一单）'],
          ['平均定稿时间', t.avgCycleTeam ? fmtCycle(t.avgCycleTeam) : '—', '派单→定稿均值'],
          ['提案通过率', pct(t.proposalPassRate), '提案通过 ÷ 已决提案'],
          ['一次提案通过率', pct(t.firstProposalPassRate), '首次提案一次过 ÷ 已决提案'],
          ['初稿定稿率', pct(t.draftToFinalizeRate), '已定稿且修改 0 次'],
          ['定稿率', pct(t.dispatchOrders ? t.finalizedCount / t.dispatchOrders : 0), '定稿 ÷ 派单总数'],
          ['设计返工率', pct(t.reworkRate), '设计责任返工 ÷ 已定稿'],
          ['当前在制', t.currentInProgress, '全组实时未结案'],
          ['峰值并发(单人最高)', t.peakConcurrency, '范围内单人同时最多'],
          ['小单达标', sm.smallOkCount + '/' + sm.designerCount + ' 人', '≥' + sm.target + '单/人 · 人均 ' + sm.avgSmallTeam],
          ['已取消订单数', t.cancelCount, '范围内客户中途终止'],
          ['客户取消率', pct(t.cancelRate), '已取消 ÷ (已取消+已定稿+已换人)'],
          [],
          ['工资核算（团队）', '数值', '说明'],
          ['团队营收', n(t.teamRevenue), '范围内全部单子金额合计'],
          ['团队奖', n(t.teamAward), ''],
          ['绩效合计', n(t.totalPerfSum), '所有设计师总绩效'],
          ['人均小单', t.teamAvgSmall, '参与平均的设计师均值']
        ];
        downloadAOA(overviewCSV, fnBase + '_总览.csv');
        setTimeout(() => downloadAOA([designerHead].concat(designerRows.map(r => r.map(c => c && c.v != null ? c.v : c ?? ''))), fnBase + '_设计师.csv'), 300);
        setTimeout(() => downloadAOA([orderHead].concat(orderRows.map(r => r.map(c => c && c.v != null ? c.v : c ?? ''))), fnBase + '_项目.csv'), 600);
        toast('已导出 CSV（XLSX 不可用，已拆分为三个 CSV）');
      }
    } finally {
      unlockOp('exportAna');
    }
  }
  function downloadAOA(aoa, filename) {
    const csv = '﻿' + aoa.map(r => r.map(c => { const s = String(c ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  async function exportOrdersCSV() {
    await ensureXlsxLib(); // 确保 XLSX 可用，否则导出降级为 CSV
    const orders = await DB.listOrders(state.filters || {});
    const mode = await window.Exporter.ordersCSV(orders, state._designers || [], state._settings, '订单列表_' + Date.now() + '.csv');
    toast(mode === 'excel' ? '已导出 Excel' : '已导出 CSV');
  }

  /* ============================================================
   * 设置
   * ============================================================ */
  // 操作日志：填充人员下拉并查询渲染
  function fillLogDesigners() {
    const sel = $('#logDesigner'); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部</option>'
      + (state._designers || []).map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('');
    if (cur && (state._designers || []).some(d => d.id === cur)) sel.value = cur;
  }
  async function renderOpLogs() {
    const tbl = $('#logTable'); if (!tbl) return;
    const designer = $('#logDesigner').value;
    const action = $('#logAction').value;
    const from = $('#logFrom').value;
    const to = $('#logTo').value;
    tbl.innerHTML = '<tr><td colspan="5" class="empty">查询中…</td></tr>';
    try {
      const rows = await DB.queryLogs({
        designerId: designer || undefined,
        action: action || undefined,
        from: from || undefined,
        to: to || undefined
      });
      if (!rows.length) { tbl.innerHTML = '<tr><td colspan="5" class="empty">暂无操作记录</td></tr>'; return; }
      const head = '<tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>详情</th></tr>';
      const body = rows.map(r => {
        const t = r.created_at ? fmtTime(r.created_at) : '';
        const who = esc(r.designer_name || (r.designer_id ? '未知' : '系统'));
        const act = esc(r.action || '');
        const obj = r.target_label ? (esc(r.target_type || '') + '：' + esc(r.target_label)) : (esc(r.target_type || '') || '—');
        const dt = (r.action === '推进流程' || r.action === '回退流程') ? esc(flowActionName(r.detail) || '') : esc(r.detail || '');
        return '<tr><td>' + t + '</td><td>' + who + '</td><td>' + act + '</td><td>' + obj + '</td><td>' + dt + '</td></tr>';
      }).join('');
      tbl.innerHTML = head + body;
    } catch (e) {
      tbl.innerHTML = '<tr><td colspan="5" class="empty">加载失败：' + esc((e && e.message) || e) + '</td></tr>';
    }
  }
  async function renderSettings() {
    const s = state._settings || await DB.getSettings();
    // 降级保护：如果 settings 关键字段缺失（loadAll 未完成/RLS 返回空行），回退到默认值避免全空输入框
    const defs = window.Cfg.DEFAULT_SETTINGS || {};
    const v = (k, fb) => (s[k] != null ? s[k] : (defs[k] != null ? defs[k] : fb));
    $('#sSmallMax').value = v('small_order_max', 300);
    $('#sLargeMin').value = v('large_order_min', 2000);
    $('#sBase').value = v('base_perf_salary', 2000);
    $('#sCollabShare').value = v('collab_share_default', 0.3);
    $('#sTa1').value = v('team_award_t1', 40000); $('#sAa1').value = v('team_award_a1', 300);
    $('#sTa2').value = v('team_award_t2', 50000); $('#sAa2').value = v('team_award_a2', 500);
    $('#sTarget').value = v('small_order_target', 3);
    $('#sWinStart').value = v('win_start_day', 26);
    $('#sWinEnd').value = v('win_end_day', 25);
    $('#sRiskBuf').value = v('risk_buffer_days', 1.5);
    $('#sDeadlineWarn').value = v('deadline_warn_days', 30);
    $('#sDefaultDeadlineDays').value = v('default_deadline_days', 1);
    $('#sAutoDispatch').checked = !!s.auto_dispatch;
    $('#sAutoDispatchMin').value = v('auto_dispatch_minutes', 5);
    await renderDesignerAdmin();
    renderPermConfig();
    fillLogDesigners();
    // 操作日志改为懒加载：默认折叠，仅当日志卡片已展开时才查询（首次展开由折叠交互触发），避免进设置页就拉一长串日志
    const logCard = document.querySelector('#tab-settings .card[data-perm="view_logs"]');
    if (can('view_logs') && logCard && logCard.classList.contains('open')) {
      try { await renderOpLogs(); } catch (e) { console.warn('初始加载操作日志失败', e); }
    }
    renderRecycleBin();   // 不 await：回收站需查询已删记录
    renderLoginSecurity(); // 不 await：仅管理员查询被锁账号
    renderAbout();   // 不 await：读版本要发一次网络请求，不该拖慢设置页渲染
    updateLastBackupHint();
    applyPermissions();
    bindSettingsCollapse(); // 折叠交互只绑一次
  }
  // 设置页可折叠卡片（权限配置 / 操作日志）：点标题展开/收起；操作日志首次展开时才查询
  let _settingsCollapseBound = false;
  function bindSettingsCollapse() {
    if (_settingsCollapseBound) return;
    const sec = $('#tab-settings');
    if (!sec) return;
    sec.addEventListener('click', e => {
      const h = e.target.closest('.card-toggle');
      if (!h) return;
      const card = h.closest('.card');
      const willOpen = !card.classList.contains('open');
      card.classList.toggle('open');
      if (willOpen && card.dataset.perm === 'view_logs' && !card.dataset.logsLoaded) {
        card.dataset.logsLoaded = '1';
        renderOpLogs();
      }
    });
    _settingsCollapseBound = true;
  }
  // 「设置 → 回收站」：列出已软删除的订单/客户，可还原或彻底删除。
  // 入口仅对具备 orders_delete / customers_delete 权限的人可见（管理员/店长）。
  let _recycleBound = false;
  async function renderRecycleBin() {
    const card = $('#settingsRecycle');
    if (!card) return;
    if (!can('orders_delete') && !can('customers_delete') && !can('groups_delete')) { card.style.display = 'none'; return; }
    card.style.display = '';
    const box = $('#recycleBinList');
    if (!box) return;
    box.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const tasks = [DB.listDeleted('orders'), DB.listDeleted('customers')];
      if (can('groups_delete')) tasks.push(DB.listDeleted('groups'));
      const [ods, cs, gs] = await Promise.all(tasks);
      const rows = [];
      const ordersAll = state._orders || [];
      const designersAll = state._designers || [];
      (ods || []).forEach(o => rows.push({ type: '订单', table: 'orders', id: o.id, title: (o.order_no || '') + ' ' + (o.title || ''), deleted_at: o.deleted_at, raw: o, reason: o.delete_reason || '' }));
      (cs || []).forEach(c => rows.push({ type: '客户', table: 'customers', id: c.id, title: c.name || '', deleted_at: c.deleted_at, raw: c, reason: c.delete_reason || '', meta: ordersAll.filter(o => o.customer_id === c.id).length + ' 个关联订单' }));
      (gs || []).forEach(g => rows.push({ type: '分组', table: 'groups', id: g.id, title: g.name || '', deleted_at: g.deleted_at, raw: g, reason: g.delete_reason || '', meta: designersAll.filter(d => d.group_id === g.id).length + ' 名设计师' }));
      if (!rows.length) { box.innerHTML = '<div class="empty">回收站为空</div>'; return; }
      box.innerHTML = '<table class="tbl"><thead><tr><th>类型</th><th>名称</th><th>删除时间</th><th>操作</th></tr></thead><tbody>' +
        rows.map(r => {
          const canRestore = r.table === 'orders' ? can('orders_delete')
            : r.table === 'customers' ? can('customers_delete')
            : can('groups_delete');
          const canPurge = r.table === 'orders' ? can('orders_delete')
            : r.table === 'customers' ? can('customers_delete')
            : can('groups_delete');
          // 彻底删除前的「波及范围」提示：让用户看清不可逆操作会带走什么
          let meta = r.meta || '';
          if (r.table === 'orders' && r.raw) {
            const o = r.raw;
            const steps = Array.isArray(o.flow_history) ? o.flow_history.length : 0;
            const files = (Array.isArray(o.file_paths) ? o.file_paths.length : 0) + (Array.isArray(o.design_paths) ? o.design_paths.length : 0);
            const parts = [];
            if (steps) parts.push(steps + ' 步流程');
            if (files) parts.push(files + ' 个附件');
            if (o.complaint_count) parts.push(o.complaint_count + ' 次投诉');
            if (o.revision_count) parts.push(o.revision_count + ' 次修订');
            meta = parts.length ? parts.join(' · ') : '无附加数据';
          }
          const metaHtml = (meta ? '<div class="rc-meta">' + esc(meta) + '</div>' : '')
            + (r.reason ? '<div class="rc-reason">' + esc('删除原因：' + r.reason) + '</div>' : '');
          return '<tr><td>' + r.type + '</td><td>' + esc(r.title) + metaHtml + '</td><td>' + (r.deleted_at ? fmtTime(r.deleted_at) : '—') + '</td><td>' +
            (canRestore ? '<button class="btn sm" data-restore="' + r.table + '|' + r.id + '">还原</button>' : '') +
            (canPurge ? '<button class="btn sm danger" data-purge="' + r.table + '|' + r.id + '" style="margin-left:10px">彻底删除</button>' : '') +
            '</td></tr>';
        }).join('') + '</tbody></table>';
      if (!_recycleBound) {
        box.addEventListener('click', async e => {
          const rb = e.target.closest('[data-restore]');
          const pb = e.target.closest('[data-purge]');
          if (rb) {
            const key = 'restore:' + rb.dataset.restore;
            if (!lockOp(key)) return;   // 防重复点击（连点同一行还原）
            const [t, id] = rb.dataset.restore.split('|');
            try {
              await DB.restoreDeleted(t, id);
              logOp('还原记录', t === 'orders' ? '订单' : t === 'customers' ? '客户' : '分组', id);
              toast('已还原');
              if (t === 'orders') renderOrders(); else if (t === 'customers') renderCustomers();  // 立即乐观重渲染主列表
              renderRecycleBin();
              await refreshAll();
            }
            catch (err) { toast('还原失败：' + err.message); }
            finally { unlockOp(key); }
          } else if (pb) {
            const key = 'purge:' + pb.dataset.purge;
            if (!lockOp(key)) return;   // 防重复点击（连点同一行彻底删除）
            const [t, id] = pb.dataset.purge.split('|');
            if (!(await uiConfirmType('彻底删除后将无法恢复，此操作不可撤销。', '彻底删除'))) { unlockOp(key); return; }
            try {
              await DB.purgeDeleted(t, id);
              logOp('彻底删除', t === 'orders' ? '订单' : t === 'customers' ? '客户' : '分组', id);
              toast('已彻底删除');
              const row = pb.closest('tr'); if (row) row.remove();   // 乐观移除该行，不等重查，避免"删了还显示"
              renderRecycleBin();   // 后台重查已删列表，保证最终一致
              await refreshAll();
            }
            catch (err) { toast('彻底删除失败：' + err.message); }
            finally { unlockOp(key); }
          }
        });
        _recycleBound = true;
      }
    } catch (e) { box.innerHTML = '<div class="empty">加载回收站失败：' + esc(e.message) + '</div>'; }
  }

  // 「设置 → 登录安全管理」：管理员查看被锁定的账号并可手动解锁（清空失败记录，立即解除锁定）。
  // 仅管理员可见；即便前端显示，非管理员调用后端 RPC 也会被 current_designer_role() 拒绝，双重保险。
  let _loginSecBound = false;
  async function renderLoginSecurity() {
    const card = $('#settingsLoginSec');
    if (!card) return;
    const role = (state.currentUser && state.currentUser.role) || '';
    if (role !== '管理员') { card.style.display = 'none'; return; }
    card.style.display = '';
    const box = $('#loginSecList');
    if (!box) return;
    box.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const list = await DB.auth.listLockedAccounts();
      if (!list || !list.length) { box.innerHTML = '<div class="empty">当前没有账号被锁定</div>'; return; }
      box.innerHTML = '<table class="tbl"><thead><tr><th>账号邮箱</th><th>失败次数</th><th>锁定至</th><th>操作</th></tr></thead><tbody>' +
        list.map(r => '<tr><td>' + esc(r.email) + '</td><td>' + (r.failed_count || 0) + '</td><td>' + (r.locked_until ? fmtTime(r.locked_until) : '—') + '</td>' +
          '<td><button class="btn sm" data-unlock="' + esc(r.email) + '">解锁</button></td></tr>').join('') +
        '</tbody></table>';
      if (!_loginSecBound) {
        box.addEventListener('click', async e => {
          const ub = e.target.closest('[data-unlock]');
          if (ub) {
            const email = ub.dataset.unlock;
            if (!(await uiConfirm('确认解锁账号 ' + email + '？将清空其登录失败记录，立即解除锁定。'))) return;
            try { await DB.auth.unlockAccount(email); logOp('解锁账号', '账户', email); toast('已解锁 ' + email); renderLoginSecurity(); }
            catch (err) { toast('解锁失败：' + err.message); }
          }
        });
        _loginSecBound = true;
      }
    } catch (e) { box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; }
  }

  // 「设置 → 关于」：显示当前运行的资源版本 + 手动检查更新。
  // 原先是右下角对所有人常驻的浮层，移到设置页后受 menu_settings 权限保护（默认仅管理员）。
  let _aboutBound = false;
  async function renderAbout() {
    const el = $('#resVersionText');
    const hint = $('#checkUpdateHint');
    if (el) {
      el.textContent = '读取中…';
      try { el.textContent = window.__readResVersion ? await window.__readResVersion() : '未知'; }
      catch (e) { el.textContent = '未知'; }
    }
    // 若已有待应用的 SW 更新（页面还跑在旧版本），给出明确提示，避免「显示旧版」造成困惑
    if (hint) {
      const reg = window.__swReg;
      if (reg && (reg.waiting || reg.installing)) {
        hint.textContent = '新版本已就绪，点「检查更新」应用';
      }
    }
    if (_aboutBound) return;   // 事件只绑一次，renderSettings 每次进设置页都会调用
    _aboutBound = true;
    const btn = $('#btnCheckUpdate');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!window.__swCheckUpdate) { if (hint) hint.textContent = '当前环境不支持后台更新'; return; }
      btn.disabled = true;
      if (hint) hint.textContent = '正在检查…';
      try {
        await window.__swCheckUpdate();
        await new Promise(r => setTimeout(r, 1500));   // 给新 SW 留出 install 时间
        const reg = window.__swReg;
        if (reg && (reg.waiting || reg.installing)) {
          if (hint) hint.textContent = '发现新版本，正在应用…';
          applyAppUpdate();   // 统一走更新流程：打回执标记 → 唤醒新 SW → 兜底刷新
        } else {
          if (hint) hint.textContent = '已是最新版本';
          if (el && window.__readResVersion) { try { el.textContent = await window.__readResVersion(); } catch (e) {} }
        }
      } catch (e) {
        if (hint) hint.textContent = '检查失败，请确认网络';
      } finally { btn.disabled = false; }
    });
  }
  async function saveParams() {
    if (!lockOp('saveParams')) return;
    try {
      const num = (id) => Number($(id).value) || 0;
      const clampDay = (id, fb) => { const v = Number($(id).value); return (v >= 1 && v <= 31) ? v : fb; };
      const bufVal = Number($('#sRiskBuf').value);
      const riskBuffer = (bufVal >= 0 && !isNaN(bufVal)) ? bufVal : 1.5;
      await DB.saveSettings({
        small_order_max: num('#sSmallMax'), large_order_min: num('#sLargeMin'),
        base_perf_salary: num('#sBase'), team_award_t1: num('#sTa1'), team_award_a1: num('#sAa1'),
        collab_share_default: (() => { const x = Number($('#sCollabShare').value); return (isFinite(x) && x >= 0 && x <= 1) ? x : 0.3; })(),
        team_award_t2: num('#sTa2'), team_award_a2: num('#sAa2'),
        small_order_target: num('#sTarget') || 3,
        win_start_day: clampDay('#sWinStart', 26), win_end_day: clampDay('#sWinEnd', 25),
        risk_buffer_days: riskBuffer,
        auto_dispatch: $('#sAutoDispatch').checked,
        auto_dispatch_minutes: num('#sAutoDispatchMin') || 5,
        deadline_warn_days: (Number($('#sDeadlineWarn').value) >= 1 && Number($('#sDeadlineWarn').value) <= 365) ? Number($('#sDeadlineWarn').value) : 30,
        default_deadline_days: (Number($('#sDefaultDeadlineDays').value) >= 0 && Number($('#sDefaultDeadlineDays').value) <= 365) ? Number($('#sDefaultDeadlineDays').value) : 1
      });
      logOp('保存参数', '设置');
      toast('参数已保存'); await refreshAll();
    } finally { unlockOp('saveParams'); }
  }
  async function exportAll() {
    if (!lockOp('exportAll')) return;
    const btn = $('#btnExportAll'); if (btn) btn.disabled = true;
    try {
      const me = state._me || {};
      const exportedAt = new Date().toISOString();
      const timestamp = exportedAt.slice(0, 19).replace(/[-:T]/g, '');
      const logs = can('view_logs') ? await DB.queryLogs({ limit: 5000 }) : [];
      const data = {
        meta: {
          app: '设计部工作台',
          version: (typeof CACHE !== 'undefined' ? CACHE : ''),
          exportedAt,
          exportedBy: me.name || me.email || '',
          exportedById: me.id || ''
        },
        settings: state._settings || {},
        designers: state._designers || [],
        groups: state._groups || [],
        customers: state._customers || [],
        orders: state._orders || [],
        operation_logs: logs
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '设计部数据备份-' + timestamp + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      try { localStorage.setItem('ds_last_backup', exportedAt); } catch (e) {}
      updateLastBackupHint();
      toast('已导出全部数据(JSON)');
      logOp('导出备份', '数据管理');
    } catch (e) {
      toast('导出失败：' + ((e && e.message) || e));
    } finally {
      if (btn) btn.disabled = false;
      unlockOp('exportAll');
    }
  }
  function updateLastBackupHint() {
    const el = $('#lastBackupHint'); if (!el) return;
    const raw = (() => { try { return localStorage.getItem('ds_last_backup'); } catch (e) { return null; } })();
    if (!raw) { el.textContent = '尚未备份'; return; }
    try {
      const d = new Date(raw);
      el.textContent = '上次备份：' + d.toLocaleString('zh-CN', { hour12: false }) + '（本设备）';
    } catch (e) { el.textContent = '上次备份：' + raw; }
  }
  // 本人修改登录密码：校验当前密码 + 两次新密码一致，调用 Supabase 客户端 API
  async function updateMyPassword() {
    if (!lockOp('updateMyPw')) return;
    const errEl = $('#myPwErr'); if (errEl) errEl.textContent = '';
    try {
      const oldPw = ($('#myPwOld') && $('#myPwOld').value) || '';
      const a = ($('#myPwNew') && $('#myPwNew').value) || '';
      const b = ($('#myPwConfirm') && $('#myPwConfirm').value) || '';
      if (!oldPw) { if (errEl) errEl.textContent = '请输入当前密码'; return; }
      if (a.length < 6) { if (errEl) errEl.textContent = '新密码至少 6 位'; return; }
      if (a !== b) { if (errEl) errEl.textContent = '两次输入的新密码不一致'; return; }
      await DB.auth.updateSelfPassword(oldPw, a);
      logOp('修改密码', '账户');
      closeModal();
      toast('密码已修改，下次登录请使用新密码');
    } catch (e) {
      if (errEl) errEl.textContent = (e && e.message) || '修改失败';
    } finally {
      unlockOp('updateMyPw');
    }
  }

  /* ============================================================
   * 经营分析（需求 1~10）
   * ============================================================ */
  async function renderAnalytics() {
    await ensureChartLib(); // 确保 Chart.js 就绪
    const mode = state.anaMode;
    let opts;
    if (mode === 'custom') {
      const start = $('#anaStart').value, end = $('#anaEnd').value;
      if (!start || !end) { toast('请选择起止日期'); return; }
      opts = { mode: 'custom', start, end };
    } else {
      opts = { mode: 'window', period: mode };
    }
    const scope = isViewAll() ? null : (state.currentUser && state.currentUser.id);
    const rep = await window.Calc.analytics(opts, scope);
    state._ana = rep;
    const win = rep.range, t = rep.totals, sm = rep.small;
    const periodLabel = mode === 'custom' ? '自定义' : (mode === 'previous' ? '上期' : '本期');
    $('#anaWindow').textContent = periodLabel + ' ' + fmtTime(win.start).slice(0, 10) + ' ~ ' + fmtTime(win.end).slice(0, 10);

    const finalizeRateTeam = t.dispatchOrders ? t.finalizedCount / t.dispatchOrders : 0;
    const kpi = (label, value, hint, icon, accent) =>
      '<div class="kpi" data-accent="' + (accent || '#6366f1') + '">' +
        '<div class="kpi-icon">' + (icon || '📊') + '</div>' +
        '<div class="kpi-body"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="hint">' + hint + '</div></div>' +
      '</div>';
    $('#kpiAna').innerHTML =
      kpi('总接单量', t.intakeCount, '范围内接单总数', '📋', '#6366f1') +
      kpi('规定时间总营收', '¥' + money(t.revenue), '范围内全部单子', '💰', '#f59e0b') +
      kpi('客户投诉笔数', t.complaints, '范围内投诉合计', '⚠️', '#ef4444') +
      kpi('派单订单数', t.dispatchOrders, '范围内派发（唯一单）', '📦', '#0ea5e9') +
      kpi('平均定稿时间', t.avgCycleTeam ? fmtCycle(t.avgCycleTeam) : '—', '派单→定稿均值', '⏱', '#14b8a6') +
      kpi('提案通过率', pct(t.proposalPassRate), '提案通过 ÷ 已决提案', '🎯', '#f59e0b') +
      kpi('一次提案通过率', pct(t.firstProposalPassRate), '首次提案一次过 ÷ 已决提案', '🎯', '#8b5cf6') +
      kpi('初稿定稿率', pct(t.draftToFinalizeRate), '已定稿且修改 0 次', '🎨', '#4f46e5') +
      kpi('定稿率', pct(finalizeRateTeam), '定稿 ÷ 派单总数', '✅', '#06b6d4') +
      kpi('设计返工率', pct(t.reworkRate), '设计责任返工 ÷ 已定稿', '🔴', '#f97316') +
      kpi('当前在制', t.currentInProgress, '全组实时未结案', '⚡', '#3b82f6') +
      kpi('峰值并发(单人最高)', t.peakConcurrency, '范围内单人同时最多', '📈', '#64748b') +
      kpi('小单达标', sm.smallOkCount + '/' + sm.designerCount + ' 人', '≥' + sm.target + '单/人 · 人均' + sm.avgSmallTeam, '🏆', '#eab308') +
      kpi('已取消订单数', t.cancelCount, '范围内客户中途终止', '🚫', '#94a3b8') +
      kpi('客户取消率', pct(t.cancelRate), '已取消 ÷ (已取消+已定稿+已换人)', '📉', '#64748b');

    // 应用 KPI 主题色
    $$('#kpiAna .kpi[data-accent]').forEach(el => {
      const c = el.dataset.accent;
      el.style.setProperty('--kpi-accent', c);
      el.style.setProperty('--kpi-bg', c + '18');
    });

    const rows = rep.rows;
    const names = rows.map((r, i) => {
      const raw = r && r.designerName;
      const s = String(raw != null ? raw : '').trim();
      return s && s !== '0' ? s : '设计师' + (i + 1);
    });
    Charts.bar($('#chartDispatch'), {
      title: '每位设计师派单量（含协同，各计 1 单）', horizontal: true,
      labels: names,
      datasets: [{ label: '派单量', data: rows.map(r => r.dispatchCount), color: '#0ea5e9' }]
    });
    Charts.bar($('#chartConcurrency'), {
      title: '并发：当前在制 vs 窗口峰值', horizontal: true,
      labels: names,
      datasets: [
        { label: '当前在制', data: rows.map(r => r.currentLoad), color: '#3b82f6' },
        { label: '窗口峰值', data: rows.map(r => r.peakLoad), color: '#ef4444' }
      ]
    });
    Charts.bar($('#chartPass'), {
      title: '提案通过率 / 一次提案通过率 / 初稿定稿率(%)', horizontal: false,
      labels: names,
      datasets: [
        { label: '提案通过率(%)', data: rows.map(r => Math.round(r.proposalPassRate * 1000) / 10), color: '#f59e0b' },
        { label: '一次提案通过率(%)', data: rows.map(r => Math.round(r.firstProposalPassRate * 1000) / 10), color: '#8b5cf6' },
        { label: '初稿定稿率(%)', data: rows.map(r => Math.round(r.draftToFinalizeRate * 1000) / 10), color: '#4f46e5' }
      ]
    });
    Charts.bar($('#chartRework'), {
      title: '设计返工率(%)（设计责任 ÷ 已定稿）', horizontal: false,
      labels: names,
      datasets: [{ label: '设计返工率(%)', data: rows.map(r => Math.round(r.reworkRate * 1000) / 10), color: '#f97316' }]
    });

    // 设计师明细表（运营指标 + 工资核算，与绩效月报同源）
    $('#anaTable').innerHTML =
      '<thead><tr>' +
      '<th title="设计师姓名">设计师</th>' +
      '<th title="设计师角色">角色</th>' +
      '<th title="窗口内参与订单数">派单量</th>' +
      '<th title="定稿单数 ÷ 派单总数">定稿率</th>' +
      '<th title="一次提案通过率">一次提案<br>通过率</th>' +
      '<th title="初稿定稿率">初稿<br>定稿率</th>' +
      '<th title="平均定稿时间（天/小时/分钟自适应）">平均定稿<br>时间</th>' +
      '<th title="设计返工率">设计<br>返工率</th>' +
      '<th title="已定稿单数">定稿数</th>' +
      '<th title="完成率">完成率</th>' +
      '<th title="小单达标情况">小单<br>(达标)</th>' +
      '<th title="窗口内营收（主负责）">营收</th>' +
      '<th title="绩效系数">系数</th>' +
      '</tr></thead><tbody>' +
      (rows.length ? rows.map(r =>
        '<tr><td>' + esc(r.designerName) + '</td><td>' + esc(r.role) + '</td><td>' + r.dispatchCount + '</td>' +
        '<td>' + pct(r.finalizeRate) + '</td><td>' + pct(r.firstProposalPassRate) + '</td><td>' + pct(r.draftToFinalizeRate) + '</td><td>' + (r.avgCycle ? fmtCycle(r.avgCycle) : '—') + '</td><td>' + pct(r.reworkRate) + '</td>' +
        '<td>' + r.finalizedCount + '</td><td>' + pct(r.completion) + '</td>' +
        '<td>' + r.smallCount + ' <span class="badge ' + (r.smallOk ? 'ok' : 'bad') + '">' + (r.smallOk ? '达标' : '未达标') + '</span></td>' +
        '<td class="num">¥' + money(r.revenue) + '</td>' +
        '<td><b>' + (r.coef != null ? r.coef : '—') + '</b></td></tr>'
      ).join('') : '<tr><td colspan="13" class="empty">暂无设计师或数据</td></tr>') + '</tbody>';

    renderAnaProjects(rep);
    await renderConcurrencyDaily();
    applyPermissions();
  }

  // 项目改稿 / 返工 / 投诉明细
  function renderAnaProjects(rep) {
    const list = rep.perOrder.slice().sort((a, b) => (b.revision_count - a.revision_count));
    $('#anaProjects').innerHTML =
      '<thead><tr><th>单号</th><th>项目</th><th>客户</th><th>参与设计师</th><th>状态</th><th>改稿次数</th><th>返工原因</th><th>投诉</th><th>周期(天)</th><th>金额</th></tr></thead><tbody>' +
      (list.length ? list.map(o =>
        '<tr><td>' + esc(o.order_no) + '</td><td>' + esc(o.title) + '</td><td>' + esc(o.customer_name || '') + '</td>' +
        '<td>' + esc(o.participantNames.join(' / ')) + '</td><td>' + pill(o.status) + '</td><td class="num">' + o.revision_count + '</td>' +
        '<td>' + (o.rework_category ? '<span class="badge ' + (o.rework_category === '设计原因' ? 'bad' : 'warn') + '">' + esc(o.rework_category) + '</span>' : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td class="num">' + (o.complaint_count ? '<span class="badge bad">' + o.complaint_count + '</span>' : '0') + '</td>' +
        '<td class="num">' + (o.cycleDays != null ? fmtCycle(o.cycleDays) : '—') + '</td>' +
        '<td class="num">¥' + money(o.amount) + '</td></tr>'
      ).join('') : '<tr><td colspan="10" class="empty">范围内暂无订单</td></tr>') + '</tbody>';
  }

  // 设计师每日未完工并发曲线（按所选月份）
  const CONCURRENCY_PALETTE = ['#4f46e5', '#0ea5e9', '#22c55e', '#f59e0b',
    '#8b5cf6', '#ef4444', '#14b8a6', '#64748b', '#06b6d4', '#f97316'];
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
    const scope = isViewAll() ? null : (state.currentUser && state.currentUser.id);
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
  // 启动异常卡死时的可恢复重试浮层（替代原来的"裸关 Splash 露出空白"）。
  // 点重试直接重跑 init()：网络若已就绪即可正常进入（等价于"杀进程重开就好"的体内版本）。
  function showBootRetry() {
    const old = document.getElementById('bootRetryOverlay');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'bootRetryOverlay'; ov.className = 'login-overlay';
    ov.innerHTML =
      '<div class="login-card">' +
        '<div class="login-brand">🎨 设计部工作台</div>' +
        '<div class="login-sub">数据加载失败，可能是网络尚未就绪</div>' +
        '<button class="btn" id="bootRetryBtn" style="width:100%;margin-top:8px">点击重试</button>' +
      '</div>';
    document.body.appendChild(ov);
    const btn = document.getElementById('bootRetryBtn');
    if (btn) btn.addEventListener('click', async () => {
      ov.remove();
      try { await init(); }
      catch (e) { console.error('[boot] 重试仍失败', e); showBootRetry(); }
    });
  }

  // 启动入口：日常路径与改之前完全一致（init 内依次 loadData → bootAuth → afterLogin 才 hideSplash），
  // 因此正常网络下仍是秒进秒出。仅在「启动链路整体卡死」（如长后台冷启动令牌刷新挂起）时，
  // 最外层 25s 超时兜底强制关闭首屏并给出「点击重试」浮层——25s 远大于正常网络耗时（<2s），
  // 日常永远碰不到，只是防止极端情况下永久卡首屏这一原始 bug 的兜底。
  // 启动入口（v430 离线优先）：
  // 本地有「登录态标记 + 缓存业务数据」→ 同步即时上屏（hideSplash 同步调用，绝不 await 网络），
  //   后台再静默校验会话 + 拉最新数据，完成后 afterLogin 自动重渲染成最新内容。
  //   这样无论网络多慢（长后台冷启动首次请求要 8~30s 建连），打开即见数据 → 真正的「秒进秒开」。
  // 首装 / 清缓存 / 未登录 → 走原网络启动链路 networkBoot()，保留 25s 兜底防永久卡死（正常永远碰不到）。
  // 标记 bootApp 是否真的注入了「完整离线缓存」。用于 afterLogin 判断是否跳过同步重渲染，
  // 不能用 state._orders.length 判断——init()→loadData() 会先填好 state._orders，
  // 若用长度判断，无缓存路径会被误判为「有缓存」而跳过 hideSplash，导致 Splash 永久挂起。
  let _bootHadCache = false;
  function bootApp() {
    let loggedIn = false;
    try { loggedIn = !!localStorage.getItem('ds_logged_in'); } catch (e) {}
    const cached = restoreBusinessCache();
    // 有缓存且「业务表」非空 → 离线优先即时上屏。
    // ⚠️ 只看 designers 不够！DB.init() 的 loadDesignersOnly 就会填充 designers，
    // 而 v432 之前的 bug（bootAuth 不调 DB.reload）导致缓存里 orders/customers 永远为空。
    // 若接受 designers-only 缓存，用户会看到「设计师=5 但其他全零」的残缺仪表盘，1秒后真数据才闪出来。
    // 必须要求 orders 或 customers 至少一个有数据，才代表这是一份「真正用过」的完整缓存。
    const hasCache = cached && (
      (cached.orders && cached.orders.length) ||
      (cached.customers && cached.customers.length)
    );
    if (loggedIn && hasCache) {
      _bootHadCache = true;               // 标记：确实注入了完整离线缓存
      applyCache(cached);                 // 纯本地，填充状态 + 即时渲染菜单/账户
      state.tab = 'dashboard';
      hideSplash();                       // ← 同步关首屏，毫秒级，绝不等待网络
      // 【v432 关键】必须 await renderDashboard 完成后再启动 init()，
      // 否则 init() 内的 loadData() 会用 db.js 空 cache 覆盖 state（DB.init 仅 loadDesignersOnly），
      // 而 renderDashboard 是 async 函数（await ensureChartLib + dashboardSummary），
      // 其 await 期间 init() 的 loadData 抢先执行 → state 被清空 → 用户看到短暂空白。
      renderDashboard().then(() => {
        // 缓存仪表盘渲染完成，后台 init（套 25s 兜底，但 showRetry=false：
        // 首屏已即时揭开，挂起时无需弹重试，仅记录，用户仍可见缓存数据）。
        safeInit(false);
      }).catch(e => console.warn('缓存仪表盘渲染失败（后台刷新会补齐）', e));
      return;
    }
    // 已登录但无缓存（首装/v429清缓存后首次进入/本次v432升级后旧残缺缓存被拒）：
    // 保留 Splash 直到数据就绪，避免「闪一下空白再等1秒」的割裂感。
    // 后台跑 init()（→loadData→bootAuth→afterLogin），afterLogin 的 Path B 会
    // await DB.reload 完成后才 hideSplash + 渲染——Splash 自然停留到数据就绪。
    // 不再需要超时兜底：原始 bug（永久卡死）的根因是 refresh_token 旋转被 abort 杀死
    // 导致永久 401（v427 已修复），不再有「init 永远不完成」的情况。
    if (loggedIn) {
      _bootHadCache = false;              // 本路径未注入缓存，afterLogin 必须负责 hideSplash
      // 已登录无缓存路径：保留 Splash，等 init→afterLogin(Path B) 拿到数据后再显示
      state.tab = 'dashboard';
      // 给 state 填入最小可用数据避免渲染崩溃（后台 init 会用真数据覆盖）
      state._designers = state._designers || [];
      state._customers = state._customers || [];
      state._orders = state._orders || [];
      state._groups = state._groups || [];
      // 后台静默渲染（Splash 仍盖在上面，用户看不到空白），数据就绪后由 afterLogin 揭开
      renderDashboard().catch(e => console.warn('预渲染仪表盘失败', e));
      // 【修复长后台白屏】已登录但无/残缺缓存路径：init() 内 DB.reload / 会话刷新可能卡在
      // 冷 Radio 建连（8~30s）甚至挂起。套用 25s 最外层兜底 + 重试浮层（与 networkBoot 一致），
      // 否则 hideSplash 永不被调用 → 永久卡在启动画面（白屏）。
      safeInit(true);
      return;
    }
    networkBoot();
  }
  // 最外层兜底：25s 超时强制揭开首屏 + 可选「点击重试」浮层。
  // 防「长后台冷启动」卡死（v429 铁律：正确兜底只有最外层 25s 超时 + 重试浮层，
  // 绝不在正常路径塞 per-call 超时；25s 远大于正常网络耗时 <2s，日常永远碰不到）。
  // showRetry=true → 超时/异常时弹「点击重试」；=false → 仅强制揭首屏+记录（用于已即时上屏的 Path A）。
  function safeInit(showRetry) {
    let settled = false;
    const emergencyTimer = setTimeout(() => {
      if (settled) return;
      console.error('[boot] 启动超时兜底：强制关闭首屏' + (showRetry ? '并提示重试' : ''));
      try { hideSplash(); } catch (e) {}   // hideSplash 幂等：Path A 已揭过则无副作用
      if (showRetry) showBootRetry();
    }, 25000);
    Promise.resolve().then(async () => {
      try { await init(); }
      catch (e) {
        console.error('[boot] 初始化异常', e);
        try { hideSplash(); } catch (_) {}
        if (showRetry) showBootRetry();
      }
    }).finally(() => { settled = true; clearTimeout(emergencyTimer); });
  }
  // 原启动链路（首装/清缓存/未登录走这里）：25s 最外层兜底防长后台卡死
  function networkBoot() { safeInit(true); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootApp);
  else bootApp();
})();
