/* ============================================================
 * export.js  —  报表导出
 *  Excel（绩效汇总 + 订单明细 双表，依赖 SheetJS/XLSX）
 *  CSV（XLSX 不可用时自动降级）
 * ============================================================ */
window.Exporter = (function () {

  function pct(v) { return (Math.round(v * 1000) / 10) + '%'; }
  function money(v) { return Math.round((v || 0) * 100) / 100; }
  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 触发浏览器下载
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  function csvFromAOA(aoa) {
    return aoa.map(row => row.map(c => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
  }

  function downloadCSV(aoa, filename) {
    const csv = '﻿' + csvFromAOA(aoa); // BOM 防中文乱码
    triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), filename);
  }

  /* ---------- 月度 Excel（双表） ---------- */
  async function monthlyExcel(report, ordersAll, monthLabel) {
    const settings = report.settings;
    const win = report.win;
    const winStart = fmtTime(win.start).slice(0, 10);
    const winEnd = fmtTime(win.end).slice(0, 10);

    // —— Sheet1 绩效汇总 ——
    const head1 = ['设计师', '角色', '接单数', '定稿数', '定稿率', '完成率', '绩效系数',
      '小单有效数', '小单提成(元)', '小单扣减(元)', '基础绩效(元)', '总绩效(元)'];
    const rows1 = report.rows.map(r => [
      r.designerName, r.role, r.total, r.finalizedCount, pct(r.rate), pct(r.completion),
      r.coef, r.smallCount, money(r.smallBonus), money(r.smallDeduction),
      money(r.basePerf), money(r.totalPerf)
    ]);
    rows1.push([]);
    rows1.push(['团队汇总', '', '', '', '', '', '',
      '团队营收(元): ' + money(report.team.revenue),
      '团队奖(元): ' + money(report.team.award),
      '人均小单: ' + report.team.avgSmall,
      '绩效合计(元): ' + money(report.team.totalPerfSum),
      '小单提成合计: ' + money(report.team.totalSmallBonus)]);
    const aoa1 = [['设计部绩效月报表 — ' + monthLabel + '（考核窗口：' + winStart + ' ~ ' + winEnd + '）'], head1].concat(rows1);

    // —— Sheet2 订单明细（窗口内）——
    const head2 = ['订单号', '标题', '客户', '任务类型', '金额(元)', '分类',
      '设计师', '状态', '修改次数', '是否定稿', '接单时间', '派单时间', '截稿时间', '定稿时间'];
    const winOrders = ordersAll.filter(o => window.Cfg && o.intake_at &&
      new Date(o.intake_at) >= win.start && new Date(o.intake_at) <= win.end);
    const designerName = id => (report.designers?.find(d => d.id === id)?.name) || id || '';
    // 需要设计师名字映射
    const rows2 = winOrders.map(o => [
      o.order_no, o.title, o.customer_name || '', o.task_type, money(o.amount),
      window.Cfg.orderCategory(Number(o.amount) || 0, settings),
      designerName(o.assigned_designer_id), o.status, o.revision_count || 0,
      (o.status === '已定稿' && (o.revision_count || 0) <= 1) ? '是' : '否',
      fmtTime(o.intake_at), fmtTime(o.dispatch_at), fmtTime(o.deadline), fmtTime(o.finalized_at)
    ]).sort((a, b) => (a[10] < b[10] ? -1 : 1));
    const aoa2 = [['订单明细（考核窗口内）'], head2].concat(rows2);

    if (typeof window.XLSX !== 'undefined') {
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(aoa1), '绩效汇总');
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(aoa2), '订单明细');
      window.XLSX.writeFile(wb, '设计部绩效_' + monthLabel + '.xlsx');
      return 'excel';
    }
    // 降级：导出两个 CSV（压缩为 zip 不可行，改为分别下载）
    downloadCSV(aoa1, '设计部绩效汇总_' + monthLabel + '.csv');
    setTimeout(() => downloadCSV(aoa2, '设计部订单明细_' + monthLabel + '.csv'), 300);
    return 'csv';
  }

  /* ---------- 订单列表 CSV（可按筛选导出） ---------- */
  async function ordersCSV(orders, designers, settings, filename) {
    const head = ['订单号', '标题', '客户', '任务类型', '金额(元)', '分类', '设计师',
      '状态', '修改次数', '是否定稿', '接单时间', '派单时间', '截稿时间', '定稿时间', '备注'];
    const dName = id => (designers.find(d => d.id === id)?.name) || '';
    const rows = orders.map(o => [
      o.order_no, o.title, o.customer_name || '', o.task_type, money(o.amount),
      window.Cfg.orderCategory(Number(o.amount) || 0, settings),
      dName(o.assigned_designer_id), o.status, o.revision_count || 0,
      (o.status === '已定稿' && (o.revision_count || 0) <= 1) ? '是' : '否',
      fmtTime(o.intake_at), fmtTime(o.dispatch_at), fmtTime(o.deadline),
      fmtTime(o.finalized_at), o.notes || ''
    ]);
    const aoa = [head].concat(rows);
    if (typeof window.XLSX !== 'undefined') {
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(aoa), '订单列表');
      window.XLSX.writeFile(wb, filename || '订单列表.csv');
      return 'excel';
    }
    downloadCSV(aoa, filename || '订单列表.csv');
    return 'csv';
  }

  return { monthlyExcel, ordersCSV };
})();
