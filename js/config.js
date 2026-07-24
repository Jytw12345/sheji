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
    { key: 'menu_customers', label: '客户', group: 'menu', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'menu_analytics', label: '经营分析', group: 'menu', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'menu_settings', label: '设置', group: 'menu', def: { 管理员: true, 店长: false, 设计师: false } },

    // —— 订单 ——
    { key: 'orders_create', label: '新建订单', group: 'order', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'orders_edit', label: '查看/编辑订单详情', group: 'order', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'orders_delete', label: '删除订单', group: 'order', def: { 管理员: true, 店长: false, 设计师: false } },
    { key: 'orders_export', label: '导出订单', group: 'order', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'flow_advance', label: '推进流程（派单/提案/定稿等）', group: 'order', def: { 管理员: true, 店长: true, 设计师: true } },
    { key: 'complaint_add', label: '记录投诉 / 修改原因', group: 'order', def: { 管理员: true, 店长: true, 设计师: false } },

    // —— 客户 ——
    { key: 'customers_create', label: '新建客户', group: 'customer', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'customers_edit', label: '编辑 / 删除客户', group: 'customer', def: { 管理员: true, 店长: true, 设计师: false } },

    // —— 数据范围 ——
    { key: 'analytics_export', label: '导出经营分析（含业绩指标）', group: 'data', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'orders_view_all', label: '查看全部订单（否则仅本人参与）', group: 'data', def: { 管理员: true, 店长: true, 设计师: false } },
    { key: 'analytics_view_all', label: '经营分析看全部（否则仅本人）', group: 'data', def: { 管理员: true, 店长: true, 设计师: false } },

    // —— 系统管理 ——
    { key: 'manage_designers', label: '管理设计师 / 分组', group: 'system', def: { 管理员: true, 店长: false, 设计师: false } },
    { key: 'manage_settings', label: '系统设置（云端 / 考核参数）', group: 'system', def: { 管理员: true, 店长: false, 设计师: false } },
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
  // 流程顺序（用于“推进流程”按钮的下一步）
  const FLOW = ['接单', '派单', '提案', '设计中', '初稿', '客户反馈', '修改中', '已定稿'];
  const STATUS = {
    '接单':     { label: '接单',       color: '#64748b' },
    '派单':     { label: '派单',       color: '#0ea5e9' },
    '设计中':   { label: '设计中',     color: '#8b5cf6' },
    '初稿':     { label: '初稿待审',   color: '#f59e0b' },
    '提案':     { label: '提案中',     color: '#06b6d4' },
    '提案不通过': { label: '提案不通过', color: '#f97316' },
    '客户反馈': { label: '客户反馈',   color: '#ec4899' },
    '修改中':   { label: '修改中',     color: '#ef4444' },
    '已定稿':   { label: '已定稿',     color: '#22c55e' },
    '已换人':   { label: '已换人',     color: '#94a3b8' }
  };

  // 默认设置（可在“设置”页修改，保存到 settings 表 / localStorage）
  const DEFAULT_SETTINGS = {
    small_order_max: 300,    // 小单：金额 ≤ 此值（含）
    large_order_min: 2000,   // 大单：金额 > 此值；之间为普通单
    base_perf_salary: 2000,  // 基础绩效工资（×绩效系数）
    team_award_t1: 40000, team_award_a1: 300,
    team_award_t2: 50000, team_award_a2: 500,
    small_order_target: 3    // 小单奖励达标线：每人平均不少于 3 单
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
    TASK_TYPES, ROLES, ACCESS_ROLES, FLOW, STATUS, REWORK_CATEGORIES,
    PERM_GROUPS, PERMISSIONS, defaultPermissions,
    DEFAULT_SETTINGS, perfCoefficient, orderCategory, normUrl, participants,
    SUPABASE_URL, SUPABASE_ANON_KEY
  };
})();
