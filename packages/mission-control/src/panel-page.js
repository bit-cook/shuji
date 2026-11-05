'use strict';
/**
 * 面板页面（单文件 HTML，零依赖）。
 *
 * 设计约束（来自数据可视化规范）：
 *   - 深色与浅色都是**挑选**出来的两套色值，不是把浅色反转；OS 偏好与页面内的
 *     主题切换分别由媒体查询与 data-theme 两个作用域提供，切换永远赢。
 *   - 状态色（在线/离线）固定不参与配色，且必须图标 + 文字同时出现，
 *     不允许只靠颜色传达状态——浅色面上的告警黄对比度只有 1.79:1。
 *   - 文字一律用文本色（主/次/弱），不穿数据色；数据色只属于图形标记。
 *   - 单序列图表不放图例（标题已经说明画的是什么），每条柱子在端头直接标数值。
 *   - 必须有一份表格视图，图表看得不爽的信息在表格里都在。
 *   - 表格与坐标刻度用 tabular-nums，其余数字用比例字形。
 */

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>枢机 · 控制面板</title>
<link rel="icon" href="data:,"><!-- 内联空图标：否则浏览器每次都要 /favicon.ico，在审计里留一串 404 -->
<style>
  :root { color-scheme: light; }
  .viz-root {
    --surface-1: #fcfcfb;
    --plane: #f9f9f7;
    --ink-1: #0b0b0b;
    --ink-2: #52514e;
    --ink-3: #898781;
    --grid: #e1e0d9;
    --rule: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #d03b3b;
    --on-fill: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root { color-scheme: dark;
      --surface-1: #1a1a19; --plane: #0d0d0d;
      --ink-1: #f0efec; --ink-2: #c3c2b7; --ink-3: #898781;
      --grid: #2c2c2a; --rule: #383835; --border: rgba(255,255,255,0.10);
      --series-1: #3987e5; --good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
    }
  }
  :root[data-theme="dark"] .viz-root { color-scheme: dark;
    --surface-1: #1a1a19; --plane: #0d0d0d;
    --ink-1: #f0efec; --ink-2: #c3c2b7; --ink-3: #898781;
    --grid: #2c2c2a; --rule: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5; --good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
  }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--plane); color: var(--ink-1);
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px; line-height: 1.5; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 48px; }

  header.top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  header.top h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
  header.top .sub { color: var(--ink-3); font-size: 13px; }
  header.top .spacer { flex: 1; }
  button { font: inherit; font-size: 13px; color: var(--ink-2); background: var(--surface-1);
    border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
  button:hover { color: var(--ink-1); }
  button:focus-visible { outline: 2px solid var(--series-1); outline-offset: 2px; }

  section.card { background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  section.card > h2 { font-size: 13px; font-weight: 600; color: var(--ink-2);
    margin: 0 0 14px; letter-spacing: 0.04em; }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
  .tile .label { font-size: 12px; color: var(--ink-3); }
  .tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; letter-spacing: -0.01em; }
  .tile .hint { font-size: 12px; color: var(--ink-3); margin-top: 2px; }

  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: grid; grid-template-columns: minmax(88px, 168px) 1fr auto; gap: 12px;
    align-items: center; }
  .bar-row .name { color: var(--ink-2); font-size: 13px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .bar-row .track { position: relative; height: 12px; background: transparent; }
  .bar-row .fill { height: 12px; background: var(--series-1);
    border-radius: 0 4px 4px 0; min-width: 2px; }
  .bar-row .val { color: var(--ink-2); font-size: 13px; font-variant-numeric: tabular-nums;
    min-width: 56px; text-align: right; }
  .bar-row[data-tip] { cursor: default; }
  .empty { color: var(--ink-3); font-size: 13px; padding: 8px 0; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--grid); }
  th { color: var(--ink-3); font-weight: 500; font-size: 12px; letter-spacing: 0.04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:last-child td { border-bottom: none; }

  .status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .status .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .status.online .dot { background: var(--good); }
  .status.offline .dot { background: var(--critical); }
  .status.unknown .dot { background: var(--warning); }

  .login { max-width: 360px; margin: 72px auto; }
  .login h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
  .login p { color: var(--ink-2); font-size: 13px; margin: 0 0 18px; }
  .login label { display: block; font-size: 12px; color: var(--ink-3); margin-bottom: 6px; }
  .login input { width: 100%; font: inherit; padding: 8px 10px; color: var(--ink-1);
    background: var(--surface-1); border: 1px solid var(--rule); border-radius: 6px; }
  .login input:focus-visible { outline: 2px solid var(--series-1); outline-offset: 1px; }
  .login .row { display: flex; gap: 10px; margin-top: 14px; align-items: center; }
  .login .err { color: var(--critical); font-size: 13px; }
  .login button.primary { color: var(--on-fill); background: var(--series-1); border-color: transparent; }

  .tip { position: fixed; z-index: 10; pointer-events: none; opacity: 0; transition: opacity .08s;
    background: var(--surface-1); color: var(--ink-1); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.14);
    max-width: 260px; }
  .tip.on { opacity: 1; }
  .tip .t-name { color: var(--ink-2); margin-bottom: 4px; }
  .tip .t-row { display: flex; justify-content: space-between; gap: 14px;
    font-variant-numeric: tabular-nums; }
  .tip .t-row span:last-child { color: var(--ink-2); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
</head>
<body>
<div class="viz-root">
  <div class="wrap" id="app" aria-busy="true"><p class="empty">正在载入…</p></div>
  <noscript><p class="empty">面板需要浏览器执行 JavaScript。启用后刷新本页。</p></noscript>
</div>
<div class="tip" id="tip" role="status" aria-live="off"></div>
<script>
(function () {
  'use strict';
  var app = document.getElementById('app');
  var tip = document.getElementById('tip');
  var REFRESH_MS = 10000;
  var timer = null;
  var BAIL_MS = 8000;

  // 载入自愈：render() 因任何原因没跑完（脚本被拦截、请求挂起、浏览器插件、
  // 端口转发的连接没建立），页面会永远停在初始的「正在载入…」上，用户看不出
  // 该重试还是该换浏览器。这里给一个可观测的出口。
  var bail = setTimeout(function () {
    var box = document.getElementById('app');
    if (!box || box.getAttribute('aria-busy') !== 'true') return;
    box.setAttribute('aria-busy', 'false');
    box.innerHTML = '<div class="login"><h1>枢机 · 控制面板</h1>'
      + '<p>面板载入超过预期时间。请确认这个浏览器允许执行 JavaScript，'
      + '再点重试；仍不行就按 F12 看 Console 里的报错。</p>'
      + '<div class="row"><button class="primary" id="retry">重试</button></div></div>';
    document.getElementById('retry').addEventListener('click', function () {
      location.reload();
    });
  }, BAIL_MS);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function compact(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\\.0$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\\.0$/, '') + 'K';
    return n.toLocaleString('en-US');
  }
  function full(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function money(n) { return '$' + (Number(n) || 0).toFixed(4); }
  function whenMs(ms) {
    if (!ms) return '—';
    var d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function theme() { return document.documentElement.getAttribute('data-theme') || 'auto'; }
  function setTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('cardinal-theme', t); } catch (e) {}
    render();
  }

  function statusCell(stale, status) {
    var s = String(status || 'unknown');
    if (stale) return '<span class="status offline"><span class="dot"></span>离线</span>';
    if (s === 'online') return '<span class="status online"><span class="dot"></span>在线</span>';
    return '<span class="status unknown"><span class="dot"></span>' + esc(s) + '</span>';
  }

  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.classList.add('on');
    var pad = 14;
    var x = ev.clientX + pad, y = ev.clientY + pad;
    var r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.classList.remove('on'); }

  function barChart(rows) {
    if (!rows.length) return '<p class="empty">还没有用量数据。</p>';
    var max = rows.reduce(function (m, r) { return Math.max(m, r.tokens); }, 0) || 1;
    var html = '<div class="bars">';
    rows.forEach(function (r, i) {
      var pct = Math.max(0.6, (r.tokens / max) * 100);
      var name = 'row-' + i;
      html += '<div class="bar-row" data-tip="' + name + '" tabindex="0" role="img" '
        + 'aria-label="' + esc(r.agentId) + '：' + full(r.tokens) + ' Token">'
        + '<span class="name" title="' + esc(r.agentId) + '">' + esc(r.agentId) + '</span>'
        + '<span class="track"><span class="fill" style="width:' + pct.toFixed(2) + '%"></span></span>'
        + '<span class="val">' + compact(r.tokens) + '</span></div>';
    });
    return html + '</div>';
  }

  function tipHtml(r) {
    return '<div class="t-name">' + esc(r.agentId) + '</div>'
      + '<div class="t-row"><span>Token</span><span>' + full(r.tokens) + '</span></div>'
      + '<div class="t-row"><span>成本</span><span>' + money(r.costUsd) + '</span></div>'
      + '<div class="t-row"><span>任务</span><span>' + full(r.tasks) + '</span></div>'
      + '<div class="t-row"><span>已完成</span><span>' + full(r.done) + '</span></div>'
      + '<div class="t-row"><span>待领取</span><span>' + full(r.pending) + '</span></div>';
  }

  function table(rows) {
    var head = '<thead><tr><th>Agent</th><th>状态</th><th>模型</th><th>来源</th>'
      + '<th>最近心跳</th><th class="num">任务</th><th class="num">Token</th></tr></thead>';
    var body = '<tbody>';
    rows.forEach(function (r) {
      body += '<tr><td>' + esc(r.agentId) + '</td><td>' + statusCell(r.stale, r.status) + '</td>'
        + '<td>' + esc(r.model || '—') + '</td><td>' + esc(r.source || '—') + '</td>'
        + '<td>' + whenMs(r.lastSeenAt) + '</td>'
        + '<td class="num">' + full(r.tasks) + '</td>'
        + '<td class="num">' + full(r.tokens) + '</td></tr>';
    });
    return '<table>' + head + body + '</tbody></table>';
  }

  function render() {
    // 面板端点一律用绝对路径：相对路径在 /panel/ （带尾斜杠）下会拼成
    // /panel/panel/... 全部 404，而 404 又会被误显示成「API Key 不正确」。
    clearTimeout(bail);
    fetch('/panel/api/session', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { loginForm(null); return null; }
        if (!r.ok) throw new Error('会话检查失败（HTTP ' + r.status + '）');
        return r.json();
      })
      .then(function (s) {
        // 未登录时服务端返回的是 200 + {"authenticated":false}，不是 401。
        // 少了这个分支，页面既不进登录表单也不报错，就永远停在「正在载入…」。
        if (s && s.authenticated) load();
        else loginForm(null);
      })
      .catch(function (e) { loginForm(e.message); });
  }

  function loginForm(err) {
    if (timer) { clearInterval(timer); timer = null; }
    clearTimeout(bail);
    document.getElementById('app').setAttribute('aria-busy', 'false');
    app.innerHTML = '<div class="login"><h1>枢机 · 控制面板</h1>'
      + '<p>输入控制面 API Key 进入。会话有效期 12 小时， Cookie 仅存在这个浏览器里。</p>'
      + '<label for="key">API Key</label>'
      + '<input id="key" type="password" autocomplete="current-password" spellcheck="false">'
      + '<div class="row"><button class="primary" id="go">进入</button>'
      + '<span class="err" id="err"></span></div></div>';
    var input = document.getElementById('key');
    var msg = document.getElementById('err');
    if (err) msg.textContent = err;
    input.focus();
    function submit() {
      msg.textContent = '';
      fetch('/panel/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: input.value }),
      }).then(function (r) {
        if (r.status === 429) return r.json().then(function (b) {
          throw new Error('尝试过于频繁，请 ' + Math.ceil((b.retryAfterMs || 60000) / 1000) + ' 秒后再试');
        });
        if (r.status === 401) throw new Error('API Key 不正确');
        if (r.status === 503) throw new Error('面板不可用：服务端未配置密钥');
        if (!r.ok) throw new Error('登录失败（HTTP ' + r.status + '）');
        load();
      }).catch(function (e) { msg.textContent = e.message; });
    }
    document.getElementById('go').addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function load() {
    fetch('/panel/api/snapshot', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { loginForm(null); return null; }
        if (!r.ok) throw new Error('快照读取失败（HTTP ' + r.status + '）');
        return r.json();
      })
      .then(function (d) { if (d) paint(d); })
      .catch(function (e) { app.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  function paint(d) {
    clearTimeout(bail);
    app.setAttribute('aria-busy', 'false');
    var t = d.totals;
    var rows = Object.keys(d.byAgent).map(function (id) {
      return { agentId: id, tokens: d.byAgent[id].tokens, costUsd: d.byAgent[id].costUsd,
        tasks: d.byAgent[id].tasks, done: d.byAgent[id].done, pending: d.byAgent[id].pending };
    }).sort(function (a, b) { return b.tokens - a.tokens; });

    var html = '<header class="top"><h1>枢机 · 控制面板</h1>'
      + '<span class="sub">更新于 ' + whenMs(Date.parse(d.generatedAt) || Date.now()) + '</span>'
      + '<span class="spacer"></span>'
      + '<button id="theme">主题：' + (theme() === 'auto' ? '跟随系统' : theme() === 'dark' ? '深色' : '浅色') + '</button>'
      + '<button id="out">退出</button></header>';

    html += '<section class="card"><div class="kpis">'
      + '<div class="tile"><div class="label">Agent 总数</div><div class="value">' + full(t.agents) + '</div>'
      + '<div class="hint">在线 ' + full(t.online) + ' · 离线 ' + full(t.agents - t.online) + '</div></div>'
      + '<div class="tile"><div class="label">待领取任务</div><div class="value">' + full(t.tasksByStatus.pending) + '</div>'
      + '<div class="hint">进行中 ' + full(t.tasksByStatus.running) + ' · 已完成 ' + full(t.tasksByStatus.done) + '</div></div>'
      + '<div class="tile"><div class="label">Token 总量</div><div class="value">' + compact(t.tokens) + '</div>'
      + '<div class="hint">' + full(t.tokens) + ' Token</div></div>'
      + '<div class="tile"><div class="label">累计成本</div><div class="value">' + money(t.costUsd) + '</div>'
      + '<div class="hint">共 ' + full(t.tasks) + ' 条任务</div></div>'
      + '</div></section>';

    html += '<section class="card"><h2>每个 Agent 的 Token 用量</h2>' + barChart(rows) + '</section>';
    html += '<section class="card"><h2>Agent 明细</h2>' + table(d.agents) + '</section>';
    app.innerHTML = html;

    document.getElementById('theme').addEventListener('click', function () {
      setTheme(theme() === 'auto' ? 'dark' : theme() === 'dark' ? 'light' : 'auto');
    });
    document.getElementById('out').addEventListener('click', function () {
      fetch('/panel/logout', { method: 'POST', credentials: 'same-origin' })
        .then(function () { loginForm(null); });
    });

    Array.prototype.forEach.call(app.querySelectorAll('.bar-row'), function (el) {
      var idx = Number(el.getAttribute('data-tip').replace('row-', ''));
      var r = rows[idx];
      if (!r) return;
      var show = function (ev) { showTip(tipHtml(r), ev); };
      el.addEventListener('mouseenter', show);
      el.addEventListener('mousemove', show);
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('focus', function () {
        var b = el.getBoundingClientRect();
        showTip(tipHtml(r), { clientX: b.left + b.width / 2, clientY: b.bottom });
      });
      el.addEventListener('blur', hideTip);
    });

    if (timer) clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  }

  try {
    var saved = localStorage.getItem('cardinal-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {}
  render();
})();
</script>
</body>
</html>
`;

module.exports = { PAGE_HTML };
