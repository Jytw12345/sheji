/* ============================================================
 * charts.js  —  可视化图表
 * 使用 Chart.js（本地 vendor/chart.js 加载，首屏 <head> defer 预载）。若库未加载，自动降级为表格。
 * 提供：Charts.bar / Charts.doughnut / Charts.line / Charts.hasLib
 * ============================================================ */
window.Charts = (function () {
  const PALETTE = ['#4f46e5', '#0ea5e9', '#22c55e', '#f59e0b', '#ec4899',
                   '#8b5cf6', '#ef4444', '#14b8a6', '#64748b', '#a855f7'];
  // 文字/网格颜色随系统主题切换：浅色背景用深色字，深色背景用浅色字
  function isDark() {
    return typeof window !== 'undefined' &&
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function chartText() { return isDark() ? '#e2e8f0' : '#1f2937'; }
  function chartGrid() { return isDark() ? 'rgba(148,163,184,0.18)' : 'rgba(100,116,139,0.18)'; }
  function chartBorder() { return isDark() ? 'rgba(255,255,255,0.10)' : '#fff'; }

  function hasLib() { return typeof window.Chart !== 'undefined'; }

  function clear(container) { container.innerHTML = ''; }

  function fallbackTable(container, title, headCells, rows) {
    let html = '<div class="chart-fallback"><div class="cf-title">' + title +
      ' <span class="cf-note">（图表库未加载，已降级为表格）</span></div><table class="tbl"><thead><tr>';
    headCells.forEach(h => html += '<th>' + h + '</th>');
    html += '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="' + headCells.length + '">暂无数据</td></tr>';
    rows.forEach(r => {
      html += '<tr>';
      r.forEach(c => html += '<td>' + c + '</td>');
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }

  function tooltip(label, val) { return label + ': ' + val; }

  // 统一全局外观：字体、文字色、圆角 tooltip（每次建图前调一次，库就绪后才生效）
  function applyDefaults() {
    if (!hasLib()) return;
    const def = window.Chart.defaults;
    def.font.family = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
    def.color = chartText();
    def.plugins.tooltip.cornerRadius = 8;
    def.plugins.tooltip.padding = 10;
    def.plugins.tooltip.boxPadding = 4;
    def.plugins.tooltip.titleFont = { weight: '600', size: 13 };
    def.plugins.tooltip.bodyFont = { size: 12 };
    def.plugins.tooltip.usePointStyle = false;
  }

  /* —— 数据标签插件（Chart.js v4 默认不显示数值，只有悬停提示；
   *    手机端无 hover，必须把数字直接画在图上）—— */
  const barValueLabels = {
    id: 'barValueLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const horizontal = chart.options.indexAxis === 'y';
      ctx.save();
      // 窄屏时缩小柱顶数值字号，避免多柱并列时重叠
      const narrow = (chart.width || 0) <= 480;
      ctx.font = (narrow ? '600 9px' : '600 11px') + ' system-ui, -apple-system, "Segoe UI", sans-serif';
      const textColor = chartText();
      ctx.fillStyle = textColor;
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach((el, i) => {
          const v = ds.data[i];
          if (v === null || v === undefined || v === 0) return; // 值为 0 不画标签，避免基线处出现误导性的「0」
          const txt = fmt(v);
          if (horizontal) {
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(txt, el.x + 4, el.y);
          } else {
            // 数值接近顶部（>=90%）时把数字画在柱子内部，避免与图例/标题重叠
            const nearTop = chart.scales.y.max && v >= chart.scales.y.max * 0.9;
            ctx.textAlign = 'center';
            ctx.textBaseline = nearTop ? 'top' : 'bottom';
            ctx.fillStyle = nearTop ? '#fff' : textColor;
            ctx.fillText(txt, el.x, nearTop ? el.y + 4 : el.y - 3);
          }
        });
      });
      ctx.restore();
    }
  };

  const pieValueLabels = {
    id: 'pieValueLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data || !meta.data.length) return;
      const data = chart.data.datasets[0].data.map(Number);
      const total = data.reduce((s, v) => s + (v || 0), 0);
      ctx.save();
      // 各扇区：类别名称 + 数值(百分比)，两行白字（占比太小的扇区不画，避免重叠）
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      meta.data.forEach((arc, i) => {
        const v = data[i];
        if (!v || !total) return;
        const pct = v / total;
        if (pct < 0.07) return; // <7% 的扇区放不下两行字，靠图例+悬停看
        const angle = (arc.startAngle + arc.endAngle) / 2;
        const r = (arc.innerRadius + arc.outerRadius) / 2;
        const x = arc.x + Math.cos(angle) * r;
        const y = arc.y + Math.sin(angle) * r;
        const name = String(chart.data.labels[i] || '');
        ctx.fillStyle = '#fff';
        ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(name, x, y - 7);
        ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(fmt(v) + ' (' + Math.round(pct * 100) + '%)', x, y + 7);
      });
      // 环心：合计
      const first = meta.data[0];
      if (first && first.innerRadius > 28) {
        ctx.fillStyle = chartText();
        ctx.font = '700 18px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(fmt(total), first.x, first.y - 8);
        ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillStyle = isDark() ? '#94a3b8' : '#64748b';
        ctx.fillText('合计', first.x, first.y + 10);
      }
      ctx.restore();
    }
  };

  /* 柱状图：支持多数据集 */
  function bar(container, opt) {
    clear(container);
    if (!hasLib()) {
      const head = ['项目'].concat(opt.datasets.map(d => d.label));
      const rows = opt.labels.map((lab, i) => {
        const row = [lab];
        opt.datasets.forEach(d => row.push(fmt(d.data[i])));
        return row;
      });
      fallbackTable(container, opt.title || '柱状图', head, rows);
      return;
    }
    applyDefaults();
    const wrap = document.createElement('div');
    wrap.className = 'chart-box';
    const inner = document.createElement('div');
    inner.className = 'chart-inner';
    const cv = document.createElement('canvas');
    inner.appendChild(cv);
    wrap.appendChild(inner);
    if (opt.title) {
      const t = document.createElement('div'); t.className = 'chart-title'; t.textContent = opt.title;
      wrap.insertBefore(t, inner);
    }
    container.appendChild(wrap);
    // 标签强制转字符串并兜底，避免后端/缓存数据异常导致坐标轴显示异常
    const labels = (opt.labels || []).map((l, i) => {
      const s = String(l != null ? l : '').trim();
      return s && s !== '0' && s !== 'undefined' && s !== 'null' ? s : '设计师' + (i + 1);
    });
    const narrow = (typeof window !== 'undefined' && window.innerWidth <= 480);
    const isHorizontal = !!opt.horizontal;
    const datasets = opt.datasets.map((d, i) => ({
      label: d.label,
      data: d.data,
      backgroundColor: (d.color || PALETTE[i % PALETTE.length]),
      borderRadius: 4,
      // 多数据集并列时让柱子更细，避免拥挤和顶部标签重叠
      maxBarThickness: isHorizontal ? (narrow ? 22 : 32) : (narrow ? 18 : 32),
      barPercentage: 0.65,
      categoryPercentage: 0.7
    }));
    new window.Chart(cv.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        indexAxis: isHorizontal ? 'y' : 'x',
        responsive: true, maintainAspectRatio: false,
        // 顶部留够空间，避免柱顶数值与图例/标题重叠；右侧留白给横向数值
        layout: { padding: isHorizontal ? { right: 40 } : { top: 26, bottom: narrow ? 46 : 28 } },
        plugins: {
          legend: { labels: { color: chartText(), boxWidth: 12, padding: 12 } },
          tooltip: { callbacks: { label: (c) => tooltip(c.dataset.label, fmt(c.parsed.y ?? c.parsed.x)) } }
        },
        scales: {
          x: {
            ticks: {
              color: chartText(),
              // 非横向柱状图在窄屏自动旋转，且强制显示全部设计师名（不自动跳过，避免名字被隐藏）
              maxRotation: isHorizontal ? 0 : (narrow ? 45 : 30),
              minRotation: 0,
              autoSkip: false
            },
            // 纵向图：x 是分类轴，不画网格线更干净；横向图：x 是数值轴，保留网格
            grid: isHorizontal ? { color: chartGrid(), drawTicks: false } : { display: false }
          },
          // 纵向图：y 是数值轴，保留淡网格；横向图：y 是分类轴，不画线
          y: {
            ticks: { color: chartText() },
            grid: isHorizontal ? { display: false } : { color: chartGrid(), drawTicks: false },
            beginAtZero: true,
            border: { display: false }
          }
        }
      },
      plugins: [barValueLabels]
    });
  }

  /* 环形/饼图 */
  function doughnut(container, opt) {
    clear(container);
    if (!hasLib()) {
      const rows = opt.labels.map((l, i) => [l, fmt(opt.values[i])]);
      fallbackTable(container, opt.title || '分布图', ['类别', '数量'], rows);
      return;
    }
    applyDefaults();
    const wrap = document.createElement('div');
    wrap.className = 'chart-box';
    const cv = document.createElement('canvas');
    wrap.appendChild(cv);
    if (opt.title) {
      const t = document.createElement('div'); t.className = 'chart-title'; t.textContent = opt.title;
      wrap.insertBefore(t, cv);
    }
    container.appendChild(wrap);
    new window.Chart(cv.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: opt.labels,
        datasets: [{
          data: opt.values,
          backgroundColor: opt.colors || opt.labels.map((_, i) => PALETTE[i % PALETTE.length]),
          borderColor: chartBorder(), borderWidth: 2,
          borderRadius: 3, hoverOffset: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: chartText(),
              // 图例文字带上数量：如「已定稿 12」
              generateLabels(chart) {
                const base = window.Chart.overrides.doughnut.plugins.legend.labels.generateLabels(chart);
                const data = chart.data.datasets[0].data;
                base.forEach((item, i) => { item.text = item.text + ' ' + fmt(data[i]); });
                return base;
              }
            }
          },
          tooltip: { callbacks: { label: (c) => tooltip(c.label, fmt(c.parsed)) } }
        }
      },
      plugins: [pieValueLabels]
    });
  }

  /* 折线图：支持多数据集（如每位设计师一条曲线） */
  function line(container, opt) {
    clear(container);
    if (!hasLib()) {
      const head = ['日'].concat(opt.datasets.map(d => d.label));
      const rows = opt.labels.map((lab, i) => {
        const row = [lab];
        opt.datasets.forEach(d => row.push(fmt(d.data[i])));
        return row;
      });
      fallbackTable(container, opt.title || '折线图', head, rows);
      return;
    }
    applyDefaults();
    const wrap = document.createElement('div');
    wrap.className = 'chart-box';
    const cv = document.createElement('canvas');
    wrap.appendChild(cv);
    if (opt.title) {
      const t = document.createElement('div'); t.className = 'chart-title'; t.textContent = opt.title;
      wrap.insertBefore(t, cv);
    }
    container.appendChild(wrap);
    const datasets = opt.datasets.map((d, i) => {
      const color = d.color || PALETTE[i % PALETTE.length];
      return {
        label: d.label,
        data: d.data,
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 4,
        fill: false
      };
    });
    new window.Chart(cv.getContext('2d'), {
      type: 'line',
      data: { labels: opt.labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: chartText() } },
          tooltip: { callbacks: { label: (c) => tooltip(c.dataset.label, fmt(c.parsed.y)) } }
        },
        scales: {
          x: {
            ticks: { color: chartText(), maxTicksLimit: 31 },
            grid: { color: chartGrid(), drawTicks: false },
            title: { display: true, text: '日期（日）', color: chartText() }
          },
          y: {
            ticks: { color: chartText(), stepSize: 1, precision: 0 },
            grid: { color: chartGrid(), drawTicks: false }, beginAtZero: true,
            border: { display: false },
            title: { display: true, text: '未完工并发数', color: chartText() }
          }
        }
      }
    });
  }

  function fmt(v) {
    if (v === null || v === undefined) return '0';
    if (typeof v === 'number') return (Math.round(v * 100) / 100).toLocaleString('zh-CN');
    return v;
  }

  return { hasLib, bar, doughnut, line };
})();
