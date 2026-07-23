/* ============================================================
 * charts.js  —  可视化图表
 * 使用 Chart.js（CDN 加载）。若库未加载，自动降级为表格。
 * 提供：Charts.bar / Charts.doughnut / Charts.hasLib
 * ============================================================ */
window.Charts = (function () {
  const PALETTE = ['#4f46e5', '#0ea5e9', '#22c55e', '#f59e0b', '#ec4899',
                   '#8b5cf6', '#ef4444', '#14b8a6', '#64748b', '#a855f7'];
  // 浅色主题下，图表需浅色背景、深色文字
  const TEXT = '#1f2937', GRID = 'rgba(100,116,139,0.18)';

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
    const wrap = document.createElement('div');
    wrap.className = 'chart-box';
    const cv = document.createElement('canvas');
    wrap.appendChild(cv);
    if (opt.title) {
      const t = document.createElement('div'); t.className = 'chart-title'; t.textContent = opt.title;
      wrap.insertBefore(t, cv);
    }
    container.appendChild(wrap);
    const datasets = opt.datasets.map((d, i) => ({
      label: d.label,
      data: d.data,
      backgroundColor: (d.color || PALETTE[i % PALETTE.length]),
      borderRadius: 6, maxBarThickness: 46
    }));
    new window.Chart(cv.getContext('2d'), {
      type: opt.horizontal ? 'bar' : 'bar',
      data: { labels: opt.labels, datasets },
      options: {
        indexAxis: opt.horizontal ? 'y' : 'x',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: TEXT } },
          tooltip: { callbacks: { label: (c) => tooltip(c.dataset.label, fmt(c.parsed.y ?? c.parsed.x)) } }
        },
        scales: {
          x: { ticks: { color: TEXT }, grid: { color: GRID } },
          y: { ticks: { color: TEXT }, grid: { color: GRID }, beginAtZero: true }
        }
      }
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
          borderColor: '#fff', borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: TEXT } },
          tooltip: { callbacks: { label: (c) => tooltip(c.label, fmt(c.parsed)) } }
        }
      }
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
          legend: { labels: { color: TEXT } },
          tooltip: { callbacks: { label: (c) => tooltip(c.dataset.label, fmt(c.parsed.y)) } }
        },
        scales: {
          x: {
            ticks: { color: TEXT, maxTicksLimit: 31 },
            grid: { color: GRID },
            title: { display: true, text: '日期（日）', color: TEXT }
          },
          y: {
            ticks: { color: TEXT, stepSize: 1, precision: 0 },
            grid: { color: GRID }, beginAtZero: true,
            title: { display: true, text: '未完工并发数', color: TEXT }
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
