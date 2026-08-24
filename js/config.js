/* ============================================================
 * config.js  —  全局配置与默认值
 * 订单类型、角色、流程状态、默认考核参数
 * ============================================================ */
window.Cfg = (function () {
  /* ============================================================
   * ☁ 云端数据库固定配置（部署级）
   * ------------------------------------------------------------
   * 把贵团队的 Supabase 项目「Project URL」与「anon public key」
   * 填到下面两行，全团队打开本网页即固定连到同一个云端库——
   * 无需每人在设置页手动填写，也不会因清浏览器缓存而丢失或连错库。
   *
   * 填写后：
   *   1. 在 Supabase 后台 SQL Editor 依次执行：sql/schema.sql（建表+字段）、sql/enable_rls.sql（细粒度 RLS）；
   *   2. 在 Supabase 后台 Auth 创建首位「管理员」邮箱账号；
   *   3. 部署 Edge Function：supabase functions deploy create-user / delete-user / set-password；
   *   4. 把这两行提交进版本库 / 部署包，分发给大家即可。
   *
   * anon key 是公开密钥（Supabase 设计为前端可用），放前端代码安全；
   * 真正的安全来自 enable_rls.sql 的行级策略 + Supabase Auth 会话。
   * service_role 仅存在于 Edge Function 运行时，绝不进本文件或前端。
   * ============================================================ */
  const SUPABASE_URL = 'https://menfionjslkqzueyrteb.supabase.co';        // 正式库（xuxiangxi123 账号，东京）
  const SUPABASE_ANON_KEY = 'sb_publishable_4jXSQSsr_qDFQeMiqJSCoA_YZy6sqsU';   // publishable key（公开安全，靠 RLS + Auth 保护）
  // 纯云端模式：登录与数据均走 Supabase Auth + 云端库，无本地降级（断网不可用）。
  // service_role 仅在 Supabase Edge Function 服务端使用，切勿写入本文件或前端。

  // ☁ 自动更新开关（仅前端部署相关，与云端数据无关）：
  //   true  = 部署新版本且用户当前没有打开弹窗时，弹「发现新版本」浮层并倒计时
  //           UPDATE_DELAY_SEC 秒后自动重新加载（用户可点「稍后」中止）。
  //           不再无提示静默重载——那样用户会误以为程序闪退。
  //           若用户正在填写订单/表单弹窗，则不倒计时，仅提示，避免丢失未保存数据。
  //   false = 纯提示式（弹浮层但不倒计时，必须用户点「立即更新」才刷新）。
  // 重载完成后会显示「已更新到最新版本」回执，明确告知这是版本更新而非异常。
  // 注意：每发布一次前端改动，需同步把 sw.js 的 CACHE 版本号 +1，浏览器才会检测到“新版本”。
  const FORCE_UPDATE = true;
  const UPDATE_DELAY_SEC = 6;
  // 外部应用入口（配置化，便于改地址 / 部署切换）。
  // 两套 PWA 同源但子路径相对 URL 在 PWA 独立窗口 / Service Worker / 带 query 的页面下可能解析错，
  // 这里直接写绝对 URL，部署变更需同步修改（GitHub Pages 同仓库子路径、同域名子路径两种皆可）。
  const EXTERNAL_APPS = {
    design_platform: {
      label: "抢单平台",
      // 当前部署：独立仓库 GitHub Pages https://jytw12345.github.io/xinxifabu/
      // （仓库名 xinxifabu，已从 sheji-main 拆出独立仓库，各自独立发版）
      // 若启用自定义子域（如 design.jytw12345.com），改为对应绝对 URL 即可。
      url: "https://jytw12345.github.io/xinxifabu/",
      tip: "将打开需求发布平台（共用账号体系，需在新页面重新登录）"
    }
  };
   // 自动更新前的倒计时秒数（给用户中止的机会，最小 3）

  const TASK_TYPES = ['名片', '画册', '展架', '喷绘', '标识', '文化墙', '展板', '门头', '设计', '排版', '其他'];
  // 职务（即权限角色）：管理员权限最大，可对各职务/各设计师配置显隐权限
  const ROLES = ['管理员', '店长', '设计师'];
  const ACCESS_ROLES = ROLES;

  // ---------------- 权限点定义 ----------------
  // 每个权限点控制一个菜单或一批按钮的显隐；管理员可在「权限配置」中按职务设默认值、按设计师做个人覆盖。
  const PERM_GROUPS = [
    { id: 'menu', label: '菜单' },
    { id: 'order', label: '订单' },
    { id: 'customer', label: '客户' },
    { id: 'data', label: '数据范围' },
    { id: 'system', label: '系统管理' }
  ];
  // def 为各职务的默认开关；未配置的职务/权限点回退到此值
  const PERMISSIONS = [
    // —— 菜单 ——
    { key: 'menu_dashboard', label: '仪表盘', group: 'menu', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'menu_orders', label: '订单', group: 'menu', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'menu_workbench', label: '工作台', group: 'menu', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'menu_customers', label: '客户', group: 'menu', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'menu_analytics', label: '经营分析', group: 'menu', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'menu_settings', label: '设置', group: 'menu', def: { 管理员: true, 店长: true, 设计师: false } },

    // —— 订单 ——
    { key: 'orders_create', label: '新建订单', group: 'order', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'orders_edit', label: '查看/编辑订单详情', group: 'order', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'orders_delete', label: '删除订单', group: 'order', def: { 管理员: true, 店长: false, 设计师: false } },
    { key: 'orders_cancel', label: '取消订单（客户中途取消/终止）', group: 'order', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'orders_export', label: '导出订单', group: 'order', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'flow_advance', label: '推进流程（派单/提案/定稿等）', group: 'order', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'flow_revert', label: '回退流程（撤销误推进，可按职务开放）', group: 'order', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'complaint_add', label: '记录投诉 / 修改原因', group: 'order', def: { 管理员: true, 店长: true, 设计师: true } },

    // —— 客户 ——
    { key: 'customers_create', label: '新建客户', group: 'customer', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'customers_edit', label: '编辑客户', group: 'customer', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'customers_delete', label: '删除客户', group: 'customer', def: { 管理员: true, 店长: true, 设计师: true } },

    // —— 数据范围 ——
    { key: 'analytics_export', label: '导出经营分析（含业绩指标）', group: 'data', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'view_all_orders', label: '查看全部订单（含他人，用于协同看板）', group: 'data', def: { 管理员: true, 店长: true, 设计师: true} },
    { key: 'view_logs', label: '查看操作日志（人员操作记录）', group: 'data', def: { 管理员: true, 店长: true, 设计师: false } },
    // 注：设计师默认只能看本人参与的单；管理员可在「权限配置」按设计师开启 view_all_orders，
    // 让其看到团队全部订单（协同/看板用）。底层依赖 enable_rls.sql 已放开 orders 读权限给所有登录用户，
    // 由本权限点做前端可见性校验（RLS 为地板，权限为 UX 开关）。详见 app.js 的 isViewAll()。

    // —— 系统管理 ——
    { key: 'manage_designers', label: '管理设计师 / 分组', group: 'system', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'groups_delete', label: '删除 / 还原分组（含回收站）', group: 'system', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'manage_settings', label: '系统设置（云端 / 考核参数）', group: 'system', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'manage_data', label: '数据管理（清空 / 导入）', group: 'system', def: { 管理员: true, 店长: false, 设计师: false } },
    { key: 'manage_permissions', label: '权限配置', group: 'system', def: { 管理员: true, 店长: false, 设计师: false } }
  ];

  // 由 PERMISSIONS 推导出「各职务默认全开/关」的配置对象
  function defaultPermissions() {
    const roleDefaults = {};
    ROLES.forEach(r => {
      roleDefaults[r] = {};
      PERMISSIONS.forEach(p => { roleDefaults[r][p.key] = !!(p.def && p.def[r]); });
    });
    return { roleDefaults, overrides: {} };
  }
  // 主流程（仅主干阶段，用于流程条 / 进度条）。分支结果「提案不通过」、终态「已换人」
  // 不在主干上，改用 flowStageIndex() 锚定到对应主干阶段；它们的真实发生记录仍由时间线展示。
  const FLOW = ['接单', '派单', '提案', '设计中', '初稿', '客户反馈', '修改中', '已定稿'];
  const STATUS = {
    '接单':     { label: '接单',       color: '#64748b', detail: '已接单，等待派单' },
    '派单':     { label: '派单',       color: '#4f46e5', detail: '已派单，设计中' },
    '设计中':   { label: '设计中',     color: '#8b5cf6', detail: '设计师制作中' },
    '初稿':     { label: '初稿待审',   color: '#f59e0b', detail: '初稿已出，等待客户确认' },
    '提案':     { label: '提案中',     color: '#fb923c', detail: '等待客户提案确认' },
    '提案不通过': { label: '提案不通过', color: '#f97316', detail: '提案未通过，需调整' },
    '客户反馈': { label: '等客户反馈',   color: '#fbbf24', detail: '等客户反馈意见' },
    '修改中':   { label: '修改中',     color: '#dc2626', detail: '修改中（按客户反馈调整）' },
    '已定稿':   { label: '已定稿',     color: '#15803d', detail: '已定稿完成' },
    '已换人':   { label: '已换人',     color: '#94a3b8', detail: '已更换设计师' },
    '已取消':   { label: '已取消',     color: '#94a3b8', detail: '客户取消/终止合作' }
  };

  // 把任意订单状态映射到主流程 FLOW 的索引：
  // 主干态直接返回其位置；分支态「提案不通过」锚定到「提案」阶段；终态「已换人」等同「已定稿」；
  // 其余（如「已取消」）返回 -1，由调用方按未识别处理。
  function flowStageIndex(status) {
    const i = FLOW.indexOf(status);
    if (i >= 0) return i;
    if (status === '提案不通过') return FLOW.indexOf('提案');
    if (status === '已换人') return FLOW.length - 1;
    return -1;
  }

  // 默认设置（可在“设置”页修改，保存到 settings 表 / localStorage）
  const DEFAULT_SETTINGS = {
    small_order_max: 2,    // 小单：金额 ≤ 此值（含）
    large_order_min: 300,   // 大单：金额 > 此值；之间为普通单
    base_perf_salary: 2000,  // 基础绩效工资（×绩效系数）
    team_award_t1: 40000, team_award_a1: 300,
    team_award_t2: 50000, team_award_a2: 500,
    small_order_target: 3,   // 小单奖励达标线：每人平均不少于 3 单
    win_start_day: 26,        // 考核窗口起始日（每月该日，取上月）
    win_end_day: 25,           // 考核窗口结束日（每月该日，取本月）
    auto_dispatch: true,      // 自动派单：新建订单时若已指定设计师+截稿时间，自动推进到「派单」
    auto_dispatch_minutes: 20,  // 自动派单等待分钟数：接单后超过该分钟数仍未派单则自动推进
    deadline_warn_days: 15,    // 截稿提醒阈值：截稿距今天超过该天数视为「时间过长」并提醒
    default_deadline_days: 1,  // 新建订单默认截稿天数（从今天起算，默认明天；时间固定 12:00）
    collab_share_default: 0.3  // 协作分成默认比例：每个协作设计师从该单金额中分走的比例（主负责人拿剩余 1−n×r）
  };

  // 修改原因分类（用于“设计返工率”区分设计责任 vs 客户原因）
  const REWORK_CATEGORIES = ['设计原因', '客户原因', '其他'];


  // 一个订单的参与设计师（主负责人 + 协作设计师）
  function participants(order) {
    const ids = [];
    if (order && order.assigned_designer_id) ids.push(order.assigned_designer_id);
    if (order && Array.isArray(order.collab_designer_ids)) {
      order.collab_designer_ids.forEach(id => {
        if (id && !ids.includes(id)) ids.push(id);
      });
    }
    return ids;
  }

  // 订单金额分成：主负责人拿剩余，每个协作设计师各分 r（默认取 settings.collab_share_default）
  // 返回 { [designerId]: 该人分得金额 }，所有参与人金额之和 == 订单金额（不重复、不丢失）。
  // 多人协作时约束 n·r ≤ 1，超出则自动把 r 压到 1/n，避免主负责人拿负数。
  function revenueSplit(order, settings) {
    const amount = Number(order && order.amount) || 0;
    const collab = (order && Array.isArray(order.collab_designer_ids)) ? order.collab_designer_ids : [];
    const n = collab.length;
    let r = Number(order && order.collab_share_ratio);
    if (!isFinite(r) || r <= 0) r = Number(settings && settings.collab_share_default) || 0;
    r = Math.max(0, Math.min(1, r));
    let perCollab = r;
    if (n > 0 && n * r > 1) perCollab = 1 / n; // 兜底：主负责人至少拿 0
    const mainShare = Math.max(0, amount - n * perCollab * amount);
    const map = {};
    if (order && order.assigned_designer_id) map[order.assigned_designer_id] = mainShare;
    collab.forEach(id => { if (id) map[id] = (map[id] || 0) + perCollab * amount; });
    return map;
  }

  // 绩效系数阶梯（按定稿率）
  // rate<0.65 ->0.8 ; 0.65<=r<0.70 ->0.9 ; 0.70<=r<0.75 ->1.0 ;
  // 0.75<=r<0.80 ->1.1 ; 0.80<=r<0.85 ->1.2 ; 0.85<=r<0.90 ->1.3 ; r>=0.90 ->1.4
  function perfCoefficient(rate) {
    if (rate >= 0.90) return 1.4;
    if (rate >= 0.85) return 1.3;
    if (rate >= 0.80) return 1.2;
    if (rate >= 0.75) return 1.1;
    if (rate >= 0.70) return 1.0;
    if (rate >= 0.65) return 0.9;
    return 0.8;
  }

  // 订单分类：小单 / 普通 / 大单
  function orderCategory(amount, s) {
    s = s || DEFAULT_SETTINGS;
    if (amount <= s.small_order_max) return '小单';
    if (amount > s.large_order_min) return '大单';
    return '普通';
  }

  // 归一化 Supabase URL：去空白、去末尾斜杠（避免 "...co//rest/v1" 导致 path invalid）
  function normUrl(u) {
    return (u || '').trim().replace(/\/+$/, '');
  }

  return {
    TASK_TYPES, ROLES, ACCESS_ROLES, FLOW, STATUS, REWORK_CATEGORIES, flowStageIndex,
    PERM_GROUPS, PERMISSIONS, defaultPermissions,
    DEFAULT_SETTINGS, perfCoefficient, orderCategory, normUrl, participants, revenueSplit,
    SUPABASE_URL, SUPABASE_ANON_KEY, FORCE_UPDATE, UPDATE_DELAY_SEC,
    EXTERNAL_APPS
  };
})();
