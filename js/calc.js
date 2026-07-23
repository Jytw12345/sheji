/* ============================================================
 * calc.js  —  绩效计算引擎
 * 依赖：window.Cfg（阈值与系数）、window.DB（数据）
 *
 * 关键业务规则（来自用户需求 + 定稿率考核管理办法）：
 *  1) 定稿率考核窗口：上月26日 00:00  ~  本月25日 23:59（按接单时间）
 *  2) 定稿判定：status=已定稿 且 revision_count<=1（修改≥2次不计入定稿）
 *  3) 定稿率 = 窗口内“定稿”单数 / 窗口内接单总数
 *  4) 完成率 = 窗口内“已定稿”单数 / 窗口内接单总数
 *  5) 绩效系数：按定稿率阶梯（≥90%→1.4 … <65%→0.8）
 *  6) 小单提成：窗口内“已定稿的小单”数
 *        >10单 → 30元/单；>5单(且≤10) → 20元/单；≤5单 → 0
 *  7) 小单未达标扣减：本人小单 < 全组平均 → 每少1单扣20元
 *  8) 总绩效 = 基础绩效工资×系数 + 小单提成 − 小单扣减
 *  9) 团队奖：窗口内全组营收合计 >门槛2→500；>门槛1→300；否则0
 * ============================================================ */
window.Calc = (function () {

  // 是否纳入团队平均/排名分母：管理员默认不参与；非管理员默认参与，除非 active_avg === false
  function participatesAvg(d) { return d.role === '管理员' ? false : (d.active_avg !== false); }

  // 给定“报告月”的 Date，返回考核窗口 [start, end]
  function windowOf(reportMonthDate) {
    const y = reportMonthDate.getFullYear();
    const m = reportMonthDate.getMonth(); // 0-11
    // 上月26日
    const start = new Date(y, m - 1, 26, 0, 0, 0, 0);
    // 本月25日 23:59:59.999
    const end = new Date(y, m, 25, 23, 59, 59, 999);
    return { start, end };
  }

  function inWindow(order, win) {
    const t = order.intake_at ? new Date(order.intake_at).getTime() : NaN;
    return !isNaN(t) && t >= win.start.getTime() && t <= win.end.getTime();
  }

  function isFinalized(order) {
    return order.status === '已定稿' && (order.revision_count || 0) <= 1;
  }

  // 计算单设计师在指定范围内的绩效（工资口径）
  // inRange(order): 判定该订单是否计入本考核范围（基于 intake_at 的窗口/范围）
  // 绩效月报与经营分析共用此函数，保证工资语义一致
  function designerWage(designer, orders, inRange, settings, teamAvgSmall) {
    const mine = orders.filter(o => o.assigned_designer_id === designer.id && inRange(o));
    const total = mine.length;
    const finalizedOrders = mine.filter(isFinalized);
    const finalizedCount = finalizedOrders.length;
    const finalizedAny = mine.filter(o => o.status === '已定稿').length;

    const rate = total ? finalizedCount / total : 0;        // 定稿率
    const completion = total ? finalizedAny / total : 0;     // 完成率
    const coef = window.Cfg.perfCoefficient(rate);

    // 小单（已定稿的小单才算有效小单）
    const smallDone = finalizedOrders.filter(o =>
      window.Cfg.orderCategory(Number(o.amount) || 0, settings) === '小单');
    const smallCount = smallDone.length;

    let smallBonus = 0;
    if (smallCount > 10) smallBonus = smallCount * 30;
    else if (smallCount > 5) smallBonus = smallCount * 20;

    let smallDeduction = 0;
    if (teamAvgSmall > 0 && smallCount < teamAvgSmall) {
      smallDeduction = Math.round(teamAvgSmall - smallCount) * 20;
    }

    const base = Number(settings.base_perf_salary) || 0;
    const totalPerf = base * coef + smallBonus - smallDeduction;

    return {
      designerId: designer.id, designerName: designer.name, role: designer.role,
      total, finalizedCount, finalizedAny, rate, completion, coef,
      smallCount, smallBonus, teamAvgSmall, smallDeduction,
      basePerf: base, totalPerf: Math.round(totalPerf * 100) / 100
    };
  }

  // 兼容入口：月度报表专用（基于考核窗口）
  function computeDesigner(designer, orders, win, settings, teamAvgSmall) {
    return designerWage(designer, orders, o => inWindow(o, win), settings, teamAvgSmall);
  }

  // 月度报表：所有设计师 + 团队汇总
  async function monthlyReport(reportMonthDate, scopeDesignerId) {
    const [designers, ordersAll, settingsObj] = await Promise.all([
      DB.listDesigners(), DB.listOrders(), DB.getSettings()
    ]);
    const settings = settingsObj;
    const win = windowOf(reportMonthDate);
    const designersActive = designers.filter(d => d.active !== false && (!scopeDesignerId || d.id === scopeDesignerId) && (scopeDesignerId === d.id || (d.role !== '管理员' && d.exclude_perf !== true)));
    const src = scopeDesignerId ? ordersAll.filter(o => window.Cfg.participants(o).includes(scopeDesignerId)) : ordersAll;

    // 先算每个人的小单有效数，用于求均值（仅参与平均的人计入团队均值分母）
    const avgSet = designersActive.filter(participatesAvg);
    const pre = avgSet.map(d => {
      const mine = src.filter(o => o.assigned_designer_id === d.id && inWindow(o, win));
      const finalizedOrders = mine.filter(isFinalized);
      return finalizedOrders.filter(o =>
        window.Cfg.orderCategory(Number(o.amount) || 0, settings) === '小单').length;
    });
    const teamAvgSmall = pre.length
      ? Math.round(pre.reduce((a, b) => a + b, 0) / pre.length) : 0;

    const rows = designersActive.map(d =>
      computeDesigner(d, src, win, settings, teamAvgSmall));

    // 团队奖：窗口内全组营收合计
    const teamRevenue = src
      .filter(o => inWindow(o, win))
      .reduce((s, o) => s + (Number(o.amount) || 0), 0);
    let teamAward = 0;
    if (teamRevenue > settings.team_award_t2) teamAward = settings.team_award_a2;
    else if (teamRevenue > settings.team_award_t1) teamAward = settings.team_award_a1;

    const totalPerfSum = rows.reduce((s, r) => s + r.totalPerf, 0);
    const totalSmallBonus = rows.reduce((s, r) => s + r.smallBonus, 0);
    const totalSmallDeduction = rows.reduce((s, r) => s + r.smallDeduction, 0);

    return {
      win, settings,
      rows,
      team: {
        revenue: Math.round(teamRevenue * 100) / 100,
        award: teamAward,
        avgSmall: teamAvgSmall,
        totalPerfSum: Math.round(totalPerfSum * 100) / 100,
        totalSmallBonus, totalSmallDeduction
      }
    };
  }

  // 仪表盘用的“当前月”概览（含订单状态/类型分布）
  async function dashboardSummary() {
    const [designers, orders, customers, settings] = await Promise.all([
      DB.listDesigners(), DB.listOrders(), DB.listCustomers(), DB.getSettings()
    ]);
    const win = windowOf(new Date());
    const winOrders = orders.filter(o => inWindow(o, win));

    // 状态分布
    const statusDist = {};
    orders.forEach(o => { statusDist[o.status] = (statusDist[o.status] || 0) + 1; });

    // 类型分布（小单/普通/大单）
    const typeDist = { '小单': 0, '普通': 0, '大单': 0 };
    orders.forEach(o => {
      const c = window.Cfg.orderCategory(Number(o.amount) || 0, settings);
      typeDist[c] = (typeDist[c] || 0) + 1;
    });

    // 设计师业绩（窗口内营收）与提成
    const perf = await monthlyReport(new Date());
    const designerPerf = perf.rows;

    // 复购客户
    const repeat = customers.filter(c => {
      const n = orders.filter(o => o.customer_id === c.id).length;
      return n >= 2;
    }).length;

    const totalRevenue = orders.reduce((s, o) => s + (Number(o.amount) || 0), 0);

    return {
      win, settings,
      counts: {
        designers: designers.filter(d => d.active !== false && d.role !== '管理员' && d.active_design !== false).length,
        orders: orders.length,
        customers: customers.length,
        repeat,
        winOrders: winOrders.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100
      },
      statusDist, typeDist, designerPerf,
      designers, orders, customers
    };
  }

  /* ============================================================
   * 经营分析引擎（对应需求 1~10）
   * 口径（已与用户确认）：
   *  - 协同单：每位参与者各计 1 单（派单量/定稿率/并发），营收归主负责人
   *  - 并发：同时给「当前在制数」与「窗口内峰值并发」
   *  - 设计返工率 = 设计责任返工单 ÷ 已定稿数
   *  - 定稿率 = 当月定稿单数 ÷ 当月派单总数（按派单时间，含协同参与者）
   *  - 提案通过率 = 一次通过定稿(rev=0) ÷ 已决提案(定稿或至少修改一次或换人)
   *  - 小单达标线 = 每人平均不少于 3 单（settings.small_order_target）
   * ============================================================ */
  const IN_PROGRESS = ['派单', '设计中', '初稿', '客户反馈', '修改中'];

  function rangeOf(opts) {
    if (opts && opts.mode === 'custom' && opts.start && opts.end) {
      return {
        start: new Date(opts.start + 'T00:00:00'),
        end: new Date(opts.end + 'T23:59:59.999')
      };
    }
    return windowOf(new Date()); // 考核窗口
  }
  function inRangeAt(order, field, range) {
    const t = order[field]; if (!t) return false;
    const tt = new Date(t).getTime();
    return tt >= range.start.getTime() && tt <= range.end.getTime();
  }
  // 峰值并发：扫描该设计师在窗口内「进行区间」的最大重叠数
  function peakConcurrent(orders, range) {
    const events = [];
    const now = Date.now();
    orders.forEach(o => {
      let s = o.dispatch_at ? new Date(o.dispatch_at).getTime()
        : (o.intake_at ? new Date(o.intake_at).getTime() : null);
      if (s == null) return;
      let e = o.finalized_at ? new Date(o.finalized_at).getTime()
        : (o.switched_at ? new Date(o.switched_at).getTime() : null);
      if (e == null) e = Math.min(range.end.getTime(), now); // 未结案 → 视为进行到窗口末/现在
      const s2 = Math.max(s, range.start.getTime());
      const e2 = Math.min(e, range.end.getTime());
      if (e2 < s2) return;
      events.push([s2, 1]); events.push([e2, -1]);
    });
    events.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    let cur = 0, peak = 0;
    events.forEach(([, d]) => { cur += d; if (cur > peak) peak = cur; });
    return peak;
  }
  function cycleDays(order) {
    // 平均定稿时间：派单(无派单时取接单) → 定稿 的天数
    const start = order.dispatch_at || order.intake_at;
    const end = order.finalized_at;
    if (start && end) {
      return (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    }
    return null;
  }

  async function analytics(opts, scopeDesignerId) {
    const [designers, ordersAll, settings] = await Promise.all([
      DB.listDesigners(), DB.listOrders(), DB.getSettings()
    ]);
    const range = rangeOf(opts);
    const s = settings;
    const target = Number(s.small_order_target) || 3;
    const scope = scopeDesignerId;
    const src = scope ? ordersAll.filter(o => window.Cfg.participants(o).includes(scope)) : ordersAll;
    const designersActive = designers.filter(d => d.active !== false && (scope === d.id || (d.role !== '管理员' && d.exclude_perf !== true)) && (!scope || d.id === scope));
    const dName = id => (designers.find(d => d.id === id) || {}).name || '';

    const isSmall = o => window.Cfg.orderCategory(Number(o.amount) || 0, s) === '小单';

    // ---------- 团队级汇总 ----------
    const intakeOrders = src.filter(o => inRangeAt(o, 'intake_at', range));
    const revenue = intakeOrders.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    const complaints = intakeOrders.reduce((sum, o) => sum + (Number(o.complaint_count) || 0), 0);
    const dispatchOrders = src.filter(o => inRangeAt(o, 'dispatch_at', range));
    const finalizedAll = dispatchOrders.filter(isFinalized);

    // 提案（团队）
    const proposalResolvedAll = dispatchOrders.filter(o =>
      isFinalized(o) || (o.revision_count || 0) >= 1 || o.status === '已换人');
    const proposalPassAll = dispatchOrders.filter(o =>
      o.status === '已定稿' && (o.revision_count || 0) === 0).length;
    const designErrorAll = dispatchOrders.filter(o => o.rework_category === '设计原因').length;
    const finalizedAllAny = dispatchOrders.filter(o => o.status === '已定稿');

    // 一次提案通过率（团队）：首次提案就一次性通过 ÷ 已决提案
    //   已决提案 = 有过 proposal_pass_at 或 proposal_failed_at（提案环节已有明确结论）
    //   首单通过 = 提案次数<=1 且从未触发过「提案不通过」
    const proposalDecidedAll = dispatchOrders.filter(o => o.proposal_pass_at || o.proposal_failed_at);
    const firstPassAll = proposalDecidedAll.filter(o => (o.proposal_count || 0) <= 1 && !o.proposal_failed_at).length;
    const firstProposalPassRateAll = proposalDecidedAll.length ? firstPassAll / proposalDecidedAll.length : 0;

    // 初稿定稿率（团队）：已定稿且没有修改过（revision_count === 0）
    const draftToFinalizeAll = finalizedAllAny.filter(o => (o.revision_count || 0) === 0).length;
    const draftToFinalizeRate = finalizedAllAny.length ? draftToFinalizeAll / finalizedAllAny.length : 0;

    // 平均定稿时间（团队）
    let cycSum = 0, cycN = 0;
    finalizedAll.forEach(o => { const c = cycleDays(o); if (c != null) { cycSum += c; cycN++; } });
    const avgCycleTeam = cycN ? cycSum / cycN : 0;

    const currentInProgress = src.filter(o => IN_PROGRESS.includes(o.status)).length;

    // ---------- 每位设计师 ----------
    const rows = designersActive.map(d => {
      const mine = ordersAll.filter(o => window.Cfg.participants(o).includes(d.id));
      const mineDispatch = mine.filter(o => inRangeAt(o, 'dispatch_at', range));
      const dispatchCount = mineDispatch.length;
      const finalizedMine = mineDispatch.filter(isFinalized);
      const finalizedCount = finalizedMine.length;
      const finalizeRate = dispatchCount ? finalizedCount / dispatchCount : 0;

      const resolved = mineDispatch.filter(o =>
        isFinalized(o) || (o.revision_count || 0) >= 1 || o.status === '已换人');
      const pass = mineDispatch.filter(o => o.status === '已定稿' && (o.revision_count || 0) === 0).length;
      const proposalPassRate = resolved.length ? pass / resolved.length : 0;

      const designError = mineDispatch.filter(o => o.rework_category === '设计原因').length;
      const reworkRate = finalizedCount ? designError / finalizedCount : 0;

      const myFinalizedAny = mineDispatch.filter(o => o.status === '已定稿');
      const draftToFinalize = myFinalizedAny.filter(o => (o.revision_count || 0) === 0).length;
      const draftToFinalizeRate = myFinalizedAny.length ? draftToFinalize / myFinalizedAny.length : 0;

      // 一次提案通过率：首次提案一次性通过 ÷ 已决提案
      const proposalDecided = mineDispatch.filter(o => o.proposal_pass_at || o.proposal_failed_at);
      const firstPass = proposalDecided.filter(o => (o.proposal_count || 0) <= 1 && !o.proposal_failed_at).length;
      const firstProposalPassRate = proposalDecided.length ? firstPass / proposalDecided.length : 0;

      let cSum = 0, cN = 0;
      finalizedMine.forEach(o => { const c = cycleDays(o); if (c != null) { cSum += c; cN++; } });
      const avgCycle = cN ? cSum / cN : 0;

      const currentLoad = mine.filter(o => IN_PROGRESS.includes(o.status)).length;
      const peakLoad = peakConcurrent(mineDispatch, range);

      const smallCount = finalizedMine.filter(isSmall).length;
      const smallOk = smallCount >= target;

      // 营收：仅主负责人计（协同不重复计营收）
      const rev = mineDispatch.filter(o => o.assigned_designer_id === d.id)
        .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);

      return {
        designerId: d.id, designerName: d.name, role: d.role,
        dispatchCount, finalizedCount, finalizeRate,
        proposalPassRate, firstProposalPassRate, draftToFinalizeRate,
        reworkRate, avgCycle,
        currentLoad, peakLoad,
        smallCount, smallTarget: target, smallOk, revenue: Math.round(rev * 100) / 100,
        participatesAvg: participatesAvg(d)
      };
    });

    const peakConcurrency = rows.length ? Math.max.apply(null, rows.map(r => r.peakLoad)) : 0;
    // 团队平均仅统计「参与平均」的人（不参与平均的人个人行仍展示，但不进人均/排名分母）
    const avgRows = rows.filter(r => r.participatesAvg);
    const avgSmallTeam = avgRows.length
      ? Math.round(avgRows.reduce((a, r) => a + r.smallCount, 0) / avgRows.length) : 0;
    const smallOkCount = avgRows.filter(r => r.smallOk).length;

    // ---------- 工资核算（与绩效月报同源：系数 / 小单提成扣减 / 总绩效） ----------
    const wageRange = o => inRangeAt(o, 'intake_at', range);
    // 工资人均小单仅统计「参与平均」的人，用于小单扣减基准
    const avgWageSet = designersActive.filter(participatesAvg);
    const teamAvgSmallW = avgWageSet.length
      ? Math.round(avgWageSet.map(d => designerWage(d, src, wageRange, s, 0).smallCount).reduce((a, b) => a + b, 0) / avgWageSet.length) : 0;
    const wages = designersActive.map(d => designerWage(d, src, wageRange, s, teamAvgSmallW));
    const wageMap = {};
    wages.forEach(w => { wageMap[w.designerId] = w; });
    rows.forEach(r => {
      const w = wageMap[r.designerId]; if (!w) return;
      r.wageTotal = w.total;            // 接单（工资口径，按主负责人计）
      r.completion = w.completion;      // 完成率
      r.coef = w.coef;                  // 绩效系数
      r.smallBonus = w.smallBonus;      // 小单提成
      r.smallDeduction = w.smallDeduction; // 小单扣减
      r.totalPerf = w.totalPerf;        // 总绩效
      r.basePerf = w.basePerf;
    });
    // 团队奖：范围内全组营收合计（与月度报表口径一致）
    let teamAward = 0;
    if (revenue > s.team_award_t2) teamAward = s.team_award_a2;
    else if (revenue > s.team_award_t1) teamAward = s.team_award_a1;
    const totalPerfSum = wages.reduce((a, r) => a + r.totalPerf, 0);

    // ---------- 项目级明细（改稿/甘特用） ----------
    const perOrder = dispatchOrders.map(o => {
      const ids = window.Cfg.participants(o);
      const c = cycleDays(o);
      return {
        id: o.id, order_no: o.order_no, title: o.title, customer_name: o.customer_name,
        task_type: o.task_type, amount: Number(o.amount) || 0, status: o.status,
        participantIds: ids, participantNames: ids.map(dName),
        revision_count: o.revision_count || 0, rework_category: o.rework_category || '',
        complaint_count: Number(o.complaint_count) || 0,
        dispatch_at: o.dispatch_at, deadline: o.deadline,
        finalized_at: o.finalized_at, switched_at: o.switched_at,
        cycleDays: c
      };
    });

    return {
      range, settings: s,
      totals: {
        intakeCount: intakeOrders.length,
        revenue: Math.round(revenue * 100) / 100,
        complaints,
        dispatchOrders: dispatchOrders.length,
        finalizedCount: finalizedAll.length,
        avgCycleTeam: Math.round(avgCycleTeam * 100) / 100,
        proposalPassRate: proposalResolvedAll.length ? proposalPassAll / proposalResolvedAll.length : 0,
        firstProposalPassRate: firstProposalPassRateAll,
        draftToFinalizeRate,
        reworkRate: finalizedAll.length ? designErrorAll / finalizedAll.length : 0,
        designErrorCount: designErrorAll,
        currentInProgress,
        peakConcurrency,
        // 工资核算（与绩效月报同源）
        teamAward,
        totalPerfSum: Math.round(totalPerfSum * 100) / 100,
        teamAvgSmall: teamAvgSmallW,
        teamRevenue: Math.round(revenue * 100) / 100
      },
      small: { target, avgSmallTeam, smallOkCount, designerCount: avgRows.length },
      rows,
      perOrder
    };
  }

  return { windowOf, inWindow, isFinalized, monthlyReport, dashboardSummary, computeDesigner, analytics };
})();
