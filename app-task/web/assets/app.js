'use strict';
/* ============================================================
   app-task 控制台 SPA（无框架，hash 路由）
   ============================================================ */

// ── 全局状态 ────────────────────────────────────────────────
// 登录会话由服务端 HttpOnly Cookie 携带（本页只为已登录会话服务，
// 未登录会被服务端 302 到 /login），前端不持有任何令牌。
const state = {
  autoRefresh: localStorage.getItem('apptask_auto') !== '0',
  timer: null,
  // 列表页分页/过滤状态（按视图名保存，切页不丢）
  page: {
    tasks: { status: '', offset: 0, limit: 50 },
    emails: { status: '', offset: 0, limit: 50 },
    logs: { taskId: '', limit: 100 },
  },
};

// ── 基础工具 ────────────────────────────────────────────────
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

function fmtTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return esc(s);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const STATUS_MAP = {
  pending: ['待执行', 'amber'], running: ['执行中', 'blue'], completed: ['已完成', 'green'],
  failed: ['失败', 'red'], success: ['成功', 'green'], accepted: ['已接收', 'blue'],
  timeout: ['超时', 'red'], retry: ['重试', 'amber'], sent: ['已发送', 'green'],
  dry_run: ['模拟', 'gray'], queued: ['已入队', 'blue'],
};
function badge(status) {
  const [label, color] = STATUS_MAP[status] || [status, 'gray'];
  return `<span class="badge ${color}">${esc(label)}</span>`;
}

// 脚本审计动作徽章：直接显示动作文本
function actionBadge(action) {
  const color = action === 'create' ? 'green' : action === 'toggle' ? 'gray' : 'blue';
  return `<span class="badge ${color}">${esc(action)}</span>`;
}

function truncate(s, n) {
  s = String(s === undefined || null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 日志错误/响应单元格：默认截断显示，悬停 title 可看完整内容；n<=0 时
// 全量展示并自动换行（任务详情页用）。注意先 esc() 再放进 title/HTML，
// 避免把原始错误文本注入成 HTML。
function logCell(v, n) {
  if (v === undefined || v === null || v === '') return '—';
  const s = String(v);
  const safe = esc(s);
  if (n > 0 && s.length > n) {
    return `<span title="${safe}">${esc(truncate(s, n))}</span>`;
  }
  return `<span class="log-wrap" title="${safe}">${safe}</span>`;
}

function prettyJSON(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch (e) { return v; }
  }
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

// ── API 客户端（会话由 HttpOnly Cookie 自动携带）────────────
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  // 会话失效/过期：回到独立登录页（服务端也会对页面请求做同样拦截）
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.detail || detail; } catch (e) { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

// ── 登录 / 登出（页面由服务端门禁，这里只处理退出与开发模式提示）──
$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch (e) { /* already signed out */ }
  location.href = '/login';
});

// ── 弹窗通用 ───────────────────────────────────────────────
function openModal(id) { $('#' + id).classList.add('open'); }
function closeModal(id) { $('#' + id).classList.remove('open'); }
$$('[data-close]').forEach((b) => {
  b.addEventListener('click', () => closeModal(b.dataset.close));
});
$$('.overlay').forEach((o) => {
  o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('open'); });
});

// ── 服务状态 ───────────────────────────────────────────────
async function refreshServiceInfo() {
  const el = $('#svc-status');
  try {
    const info = await api('/api/info');
    el.className = 'svc-status ok';
    $('#svc-status-text').textContent = '运行中 (' + esc(info.status) + ')';
    $('#svc-version').textContent = 'v' + esc(info.version);
    if (info.user) {
      const isAdmin = !!info.user.is_admin;
      $('#current-user').textContent = info.user.username + (isAdmin ? ' · admin' : '');
      $('#nav-users').hidden = !isAdmin;
    }
  } catch (e) {
    el.className = 'svc-status err';
    $('#svc-status-text').textContent = '不可达';
    $('#svc-version').textContent = '';
  }
}

// ── 路由 ───────────────────────────────────────────────────
const PAGE_TITLES = { '#/': '仪表盘', '#/tasks': '任务管理', '#/logs': '执行日志', '#/scripts': 'Lua 脚本', '#/emails': '邮件队列', '#/users': '账户' };

function router() {
  const hash = location.hash || '#/';
  const path = hash.split('?')[0];
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === path));
  $('#page-title').textContent = PAGE_TITLES[path] || 'app-task';
  $('#main').innerHTML = '<div class="loading">加载中…</div>';

  let m;
  if ((m = hash.match(/^#\/tasks\/([^/]+)/))) return renderTaskDetail(decodeURIComponent(m[1]));
  if ((m = hash.match(/^#\/scripts\/([^/]+)/))) return renderScriptDetail(decodeURIComponent(m[1]));
  if (hash.startsWith('#/tasks')) return renderTasks();
  if (hash.startsWith('#/logs')) return renderLogs();
  if (hash.startsWith('#/scripts')) return renderScripts();
  if (hash.startsWith('#/emails')) return renderEmails();
  if (hash.startsWith('#/users')) return renderUsers();
  return renderDashboard();
}

window.addEventListener('hashchange', router);

// 自动刷新（每 10s；有弹窗打开时暂停）
function startAutoRefresh() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!state.autoRefresh) return;
    if ($('.overlay.open')) return;
    router();
  }, 10000);
}
$('#auto-refresh').checked = state.autoRefresh;
$('#auto-refresh').addEventListener('change', (e) => {
  state.autoRefresh = e.target.checked;
  localStorage.setItem('apptask_auto', e.target.checked ? '1' : '0');
});
$('#btn-refresh').addEventListener('click', () => { refreshServiceInfo(); router(); });

// ── 仪表盘 ─────────────────────────────────────────────────
async function renderDashboard() {
  const main = $('#main');
  try {
    const s = await api('/api/stats');
    const tk = s.tasks || {}, em = s.emails || {};
    main.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card">
          <div class="label">任务总数</div>
          <div class="value">${tk.total || 0}</div>
          <div class="sub">
            <span>待执行 ${tk.pending || 0}</span> ·
            <span>执行中 ${tk.running || 0}</span> ·
            <span>已完成 ${tk.completed || 0}</span> ·
            <span>失败 ${tk.failed || 0}</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="label">执行日志</div>
          <div class="value">${s.logs_total || 0}</div>
          <div class="sub">全部执行记录（task_log）</div>
        </div>
        <div class="stat-card">
          <div class="label">邮件队列</div>
          <div class="value">${em.total || 0}</div>
          <div class="sub">
            <span>待发送 ${em.pending || 0}</span> ·
            <span>已发送 ${em.sent || 0}</span> ·
            <span>失败 ${em.failed || 0}</span> ·
            <span>模拟 ${em.dry_run || 0}</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="label">Lua 脚本</div>
          <div class="value">${s.scripts || 0}</div>
          <div class="sub"><a href="#/scripts">进入脚本管理 →</a></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">最近任务</span><a class="btn sm" href="#/tasks">全部任务 →</a></div>
        <div class="panel-body">${await recentTasksTable()}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">最近执行日志</span><a class="btn sm" href="#/logs">全部日志 →</a></div>
        <div class="panel-body">${await recentLogsTable()}</div>
      </div>`;
  } catch (e) {
    if (e.message !== 'unauthorized') { main.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
}

async function recentTasksTable() {
  try {
    const r = await api('/api/tasks?limit=8');
    if (!r.tasks || !r.tasks.length) return '<div class="empty">暂无任务</div>';
    return `<table class="data"><thead><tr>
      <th>task_id</th><th>uid</th><th>类型</th><th>状态</th><th>触发时间</th><th>执行器</th>
    </tr></thead><tbody>
      ${r.tasks.map((t) => `<tr class="clickable" onclick="location.hash='#/tasks/${esc(t.task_id)}'">
        <td class="mono-cell">${esc(truncate(t.task_id, 14))}</td>
        <td>${esc(t.uid)}</td>
        <td>${esc(t.task_type)}</td><td>${badge(t.status)}</td>
        <td>${fmtTime(t.trigger_time)}</td>
        <td>${esc(truncate(t.executor_url || t.task_type, 30))}</td>
      </tr>`).join('')}
    </tbody></table>`;
  } catch (e) { return `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

async function recentLogsTable() {
  try {
    const r = await api('/api/logs?limit=8');
    if (!r.logs || !r.logs.length) return '<div class="empty">暂无执行记录</div>';
    return `<table class="data"><thead><tr>
      <th>触发时间</th><th>task_id</th><th>执行器</th><th>状态</th><th>耗时</th><th>结果/错误</th>
    </tr></thead><tbody>
      ${r.logs.map((l) => `<tr>
        <td>${fmtTime(l.trigger_at)}</td>
        <td class="mono-cell">${esc(truncate(l.task_id, 14))}</td>
        <td>${esc(truncate(l.executor, 26))}</td>
        <td>${badge(l.status)}</td>
        <td>${l.duration_ms ? l.duration_ms + ' ms' : '—'}</td>
        <td>${logCell(l.error || l.response || '', 60)}</td>
      </tr>`).join('')}
    </tbody></table>`;
  } catch (e) { return `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

// ── 任务列表 ───────────────────────────────────────────────
async function renderTasks() {
  const main = $('#main');
  const pg = state.page.tasks;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('status')) pg.status = params.get('status');

  const tabs = ['', 'pending', 'running', 'completed', 'failed']
    .map((s) => `<button class="filter-tab ${pg.status === s ? 'active' : ''}" data-status="${s}">${s || '全部'}</button>`).join('');

  main.innerHTML = `
    <div class="toolbar">
      <div class="filter-tabs">${tabs}</div>
      <div class="toolbar-right">
        <button class="btn primary" id="btn-new-task">＋ 新建任务</button>
      </div>
    </div>
    <div class="panel"><div class="panel-body" id="tasks-body"><div class="loading">加载中…</div></div>
    <div class="pagination" id="tasks-pager"></div></div>`;

  $('#btn-new-task').addEventListener('click', () => {
    $('#task-form').reset();
    $('#task-form').dataset.editing = '';
    openModal('task-modal');
  });

  $$('.filter-tab').forEach((b) => b.addEventListener('click', () => {
    pg.status = b.dataset.status;
    pg.offset = 0;
    router();
  }));

  await loadTasksPage();
}

async function loadTasksPage() {
  const pg = state.page.tasks;
  const body = $('#tasks-body'), pager = $('#tasks-pager');
  try {
    const r = await api(`/api/tasks?status=${encodeURIComponent(pg.status)}&limit=${pg.limit}&offset=${pg.offset}`);
    if (!r.tasks.length) {
      body.innerHTML = '<div class="empty">暂无任务</div>';
      pager.innerHTML = '';
      return;
    }
    body.innerHTML = `<table class="data"><thead><tr>
      <th>task_id</th><th>uid</th><th>类型</th><th>状态</th><th>触发时间</th><th>cron</th><th>执行器</th><th>重试</th>
    </tr></thead><tbody>
      ${r.tasks.map((t) => `<tr class="clickable" onclick="location.hash='#/tasks/${esc(t.task_id)}'">
        <td class="mono-cell">${esc(truncate(t.task_id, 16))}</td>
        <td>${esc(t.uid)}</td>
        <td>${esc(t.task_type)}</td>
        <td>${badge(t.status)}</td>
        <td>${fmtTime(t.trigger_time)}</td>
        <td>${esc(t.cron_expr || '—')}</td>
        <td>${esc(truncate(t.executor_url || '—', 28))}</td>
        <td>${esc(t.retry_count)}/${esc(t.max_retry)}</td>
      </tr>`).join('')}
    </tbody></table>`;
    const from = pg.offset + 1, to = Math.min(pg.offset + r.tasks.length, r.total);
    pager.innerHTML = `
      <span>共 ${r.total} 条 · 第 ${from}-${to} 条</span>
      <button class="btn sm" id="pg-prev" ${pg.offset === 0 ? 'disabled' : ''}>上一页</button>
      <button class="btn sm" id="pg-next" ${to >= r.total ? 'disabled' : ''}>下一页</button>`;
    $('#pg-prev').addEventListener('click', () => { pg.offset = Math.max(0, pg.offset - pg.limit); loadTasksPage(); });
    $('#pg-next').addEventListener('click', () => { pg.offset += pg.limit; loadTasksPage(); });
  } catch (e) {
    if (e.message !== 'unauthorized') { body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
}

// ── 任务详情 ───────────────────────────────────────────────
async function renderTaskDetail(taskId) {
  const main = $('#main');
  try {
    const r = await api('/api/tasks/' + encodeURIComponent(taskId));
    const t = r.task;
    const payload = prettyJSON(t.payload);
    main.innerHTML = `
      <div class="page-head">
        <button class="btn sm" onclick="location.hash='#/tasks'">← 返回</button>
        <h2>任务详情</h2>
        <span class="id-chip">${esc(t.task_id)}</span>
        ${badge(t.status)}
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">任务信息</span></div>
        <div class="detail-grid">
          ${detailItem('uid', t.uid)}${detailItem('任务类型', t.task_type)}
          ${detailItem('触发时间', fmtTime(t.trigger_time))}${detailItem('cron 表达式', t.cron_expr || '—')}
          ${detailItem('执行器', t.executor_url || '—')}${detailItem('异步', t.async ? '是（回调完成）' : '否（同步）')}
          ${detailItem('max_retry', t.max_retry)}${detailItem('retry_count', t.retry_count)}
          ${detailItem('下次重试', fmtTime(t.next_retry_at))}${detailItem('weight', t.weight)}
          ${detailItem('创建时间', fmtTime(t.created_at))}${detailItem('更新时间', fmtTime(t.updated_at))}
          ${detailItem('最近结果', t.last_result || '—', true)}
          ${t.cron_next_task_id ? detailItem('下次 cron 任务', t.cron_next_task_id) : ''}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">payload（透传给执行器）</span></div>
        ${payload ? `<pre class="code json">${esc(payload)}</pre>` : '<div class="empty">无 payload</div>'}
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">执行日志（task_log）</span></div>
        <div class="panel-body" id="detail-logs"></div>
      </div>`;
    renderTaskLogs(r.logs || []);
  } catch (e) {
    if (e.message !== 'unauthorized') { main.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
}

function detailItem(k, v, long) {
  return `<div class="detail-item"><div class="k">${esc(k)}</div><div class="v ${long ? 'long' : ''}">${v === undefined || v === null || v === '' ? '—' : esc(v)}</div></div>`;
}

function renderTaskLogs(logs) {
  const box = $('#detail-logs');
  if (!box) return;
  if (!logs.length) { box.innerHTML = '<div class="empty">暂无执行记录</div>'; return; }
  box.innerHTML = `<table class="data"><thead><tr>
    <th>触发时间</th><th>执行器</th><th>状态</th><th>耗时</th><th>响应</th><th>错误</th>
  </tr></thead><tbody>
    ${logs.map((l) => `<tr>
      <td>${fmtTime(l.trigger_at)}</td>
      <td>${esc(truncate(l.executor, 30))}</td>
      <td>${badge(l.status)}</td>
      <td>${l.duration_ms ? l.duration_ms + ' ms' : '—'}</td>
      <td class="mono-cell">${logCell(l.response, 0)}</td>
      <td class="mono-cell">${logCell(l.error, 0)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

// ── 任务表单提交 ───────────────────────────────────────────
$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const fd = new FormData(f);
  const cron = fd.get('cron_expr').trim();
  const trigger = fd.get('trigger_time');
  let triggerISO = '';
  if (trigger) {
    const d = new Date(trigger);
    if (!isNaN(d)) triggerISO = d.toISOString();
  }
  if (!cron && !triggerISO) { toast('cron 与触发时间至少填一个', true); return; }

  let payload = null;
  const raw = fd.get('payload').trim();
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch (err) { toast('payload 不是合法 JSON：' + err.message, true); return; }
  }

  const body = {
    uid: Number(fd.get('uid')) || 0,
    task_type: fd.get('task_type'),
    executor_url: fd.get('executor_url').trim(),
    async: fd.get('async') === 'on',
    cron_expr: cron,
    trigger_time: triggerISO,
    max_retry: Number(fd.get('max_retry')) || 0,
    weight: Number(fd.get('weight')) || 1,
    payload,
  };
  try {
    const r = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    closeModal('task-modal');
    toast('任务已创建：' + r.task_id);
    state.page.tasks.offset = 0;
    router();
  } catch (err) {
    toast('创建失败：' + err.message, true);
  }
});

// ── 执行日志 ───────────────────────────────────────────────
async function renderLogs() {
  const main = $('#main');
  const pg = state.page.logs;
  main.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-right" style="margin-left:auto">
        <input type="text" id="log-task-filter" placeholder="按 task_id 过滤" value="${esc(pg.taskId)}" style="width:280px">
        <button class="btn" id="btn-log-filter">筛选</button>
      </div>
    </div>
    <div class="panel"><div class="panel-body" id="logs-body"><div class="loading">加载中…</div></div></div>`;

  $('#btn-log-filter').addEventListener('click', () => {
    pg.taskId = $('#log-task-filter').value.trim();
    router();
  });
  $('#log-task-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { pg.taskId = $('#log-task-filter').value.trim(); router(); }
  });

  try {
    const q = pg.taskId ? `task_id=${encodeURIComponent(pg.taskId)}&` : '';
    const r = await api(`/api/logs?${q}limit=${pg.limit}`);
    const box = $('#logs-body');
    if (!r.logs.length) { box.innerHTML = '<div class="empty">暂无执行记录</div>'; return; }
    box.innerHTML = `<table class="data"><thead><tr>
      <th>触发时间</th><th>task_id</th><th>执行器</th><th>状态</th><th>耗时</th><th>响应</th><th>错误</th>
    </tr></thead><tbody>
      ${r.logs.map((l) => `<tr class="clickable" onclick="location.hash='#/tasks/${esc(l.task_id)}'">
        <td>${fmtTime(l.trigger_at)}</td>
        <td class="mono-cell">${esc(truncate(l.task_id, 16))}</td>
        <td>${esc(truncate(l.executor, 28))}</td>
        <td>${badge(l.status)}</td>
        <td>${l.duration_ms ? l.duration_ms + ' ms' : '—'}</td>
        <td class="mono-cell">${logCell(l.response, 80)}</td>
        <td class="mono-cell">${logCell(l.error, 80)}</td>
      </tr>`).join('')}
    </tbody></table>`;
  } catch (e) {
    if (e.message !== 'unauthorized') { $('#logs-body').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
}

// ── Lua 脚本列表 ───────────────────────────────────────────
async function renderScripts() {
  const main = $('#main');
  main.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-right" style="margin-left:auto">
        <button class="btn primary" id="btn-new-script">＋ 新建脚本</button>
      </div>
    </div>
    <div class="panel"><div class="panel-body" id="scripts-body"><div class="loading">加载中…</div></div></div>`;

  $('#btn-new-script').addEventListener('click', () => openScriptModal(null));

  try {
    const r = await api('/api/scripts');
    const box = $('#scripts-body');
    if (!r.scripts.length) { box.innerHTML = '<div class="empty">暂无脚本，点击右上角「新建脚本」创建</div>'; return; }
    box.innerHTML = `<table class="data"><thead><tr>
      <th>script_id</th><th>名称</th><th>描述</th><th>版本</th><th>启用</th><th>更新时间</th>
    </tr></thead><tbody>
      ${r.scripts.map((s) => `<tr class="clickable" onclick="location.hash='#/scripts/${esc(s.script_id)}'">
        <td class="mono-cell">${esc(s.script_id)}</td>
        <td>${esc(s.name)}</td>
        <td>${esc(truncate(s.description || '—', 40))}</td>
        <td>v${esc(s.version)}</td>
        <td>${switchHTML(s.script_id, s.enabled, false)}</td>
        <td>${fmtTime(s.updated_at)}</td>
      </tr>`).join('')}
    </tbody></table>`;
    wireToggles();
  } catch (e) {
    if (e.message !== 'unauthorized') { $('#scripts-body').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
}

function switchHTML(scriptId, enabled, stopPropagation) {
  return `<label class="switch-sm" ${stopPropagation ? 'onclick="event.stopPropagation()"' : ''} title="${enabled ? '点击停用' : '点击启用'}">
    <input type="checkbox" data-toggle="${esc(scriptId)}" ${enabled ? 'checked' : ''}><span class="track"></span>
  </label>`;
}

function wireToggles() {
  $$('input[data-toggle]').forEach((el) => {
    el.addEventListener('change', async () => {
      const scriptId = el.dataset.toggle;
      try {
        await api('/api/scripts/' + encodeURIComponent(scriptId) + '/toggle', {
          method: 'POST', body: JSON.stringify({ enabled: el.checked }),
        });
        toast(el.checked ? '已启用 ' + scriptId : '已停用 ' + scriptId);
      } catch (e) {
        toast('操作失败：' + e.message, true);
        el.checked = !el.checked;
      }
    });
  });
}

// ── 脚本详情 ───────────────────────────────────────────────
async function renderScriptDetail(scriptId) {
  const main = $('#main');
  try {
    const r = await api('/api/scripts/' + encodeURIComponent(scriptId));
    main.innerHTML = `
      <div class="page-head">
        <button class="btn sm" onclick="location.hash='#/scripts'">← 返回</button>
        <h2>脚本详情</h2>
        <span class="id-chip">${esc(r.script_id)}</span>
        <span class="badge blue">v${esc(r.version)}</span>
        <label class="switch-sm" style="margin-left:6px" title="启停开关">
          <input type="checkbox" id="detail-enabled" ${r.enabled ? 'checked' : ''}><span class="track"></span>
        </label>
        <button class="btn primary" id="btn-edit-script" style="margin-left:auto">✎ 编辑（新版本）</button>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">${esc(r.name)} <span class="muted" style="font-weight:400">${esc(r.description || '')}</span></span></div>
        <pre class="code">${esc(r.source)}</pre>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">版本历史</span></div>
        <div class="panel-body">
          <table class="data"><thead><tr><th>版本</th><th>名称</th><th>启用</th><th>更新时间</th></tr></thead><tbody>
          ${r.versions.map((v) => `<tr>
            <td>v${esc(v.version)}${v.version === r.version ? '（当前）' : ''}</td>
            <td>${esc(v.name)}</td><td>${v.enabled ? '是' : '否'}</td><td>${fmtTime(v.updated_at)}</td>
          </tr>`).join('')}
          </tbody></table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">审计日志</span></div>
        <div class="panel-body">
          <table class="data"><thead><tr><th>时间</th><th>动作</th><th>版本</th><th>操作人</th><th>来源 IP</th><th>摘要</th><th>request_id</th></tr></thead><tbody>
          ${r.logs.map((l) => `<tr>
            <td>${fmtTime(l.created_at)}</td><td>${actionBadge(l.action)}</td>
            <td>v${esc(l.version)}</td><td>${esc(l.operator || '—')}</td><td>${esc(l.source_ip || '—')}</td>
            <td>${esc(l.summary || '—')}</td><td class="mono-cell">${esc(truncate(l.request_id || '—', 16))}</td>
          </tr>`).join('')}
          </tbody></table>
        </div>
      </div>`;

    $('#detail-enabled').addEventListener('change', async (el) => {
      try {
        await api('/api/scripts/' + encodeURIComponent(scriptId) + '/toggle', {
          method: 'POST', body: JSON.stringify({ enabled: el.target.checked }),
        });
        toast(el.target.checked ? '已启用' : '已停用');
      } catch (e) {
        toast('操作失败：' + e.message, true);
        el.target.checked = !el.target.checked;
      }
    });
    $('#btn-edit-script').addEventListener('click', () => openScriptModal({
      script_id: r.script_id, name: r.name, description: r.description, source: r.source, enabled: r.enabled,
    }));
  } catch (e) {
    if (e.message !== 'unauthorized') { main.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
}

// ── 脚本表单（新建 / 编辑）────────────────────────────────
function openScriptModal(script) {
  const form = $('#script-form');
  form.reset();
  $('#script-modal-title').textContent = script ? '编辑脚本（保存为新版本）' : '新建脚本';
  $('#script-save-btn').textContent = script ? '保存新版本' : '保存脚本';
  $('#script-modal input[name="script_id"]').disabled = !!script;
  if (script) {
    form.elements.script_id.value = script.script_id;
    form.elements.name.value = script.name || '';
    form.elements.description.value = script.description || '';
    form.elements.source.value = script.source || '';
    form.elements.enabled.checked = script.enabled !== false;
  } else {
    form.elements.source.value = '-- 示例：任务触发时执行\nfunction handle(ctx)\n  ctx.log("hello from script")\n  return\nend\n';
  }
  openModal('script-modal');
}

$('#script-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const fd = new FormData(f);
  const body = {
    script_id: fd.get('script_id').trim(),
    name: fd.get('name').trim(),
    description: fd.get('description').trim(),
    source: fd.get('source'),
    enabled: fd.get('enabled') === 'on',
  };
  if (!body.script_id || !body.name || !body.source.trim()) { toast('script_id / 名称 / 源码 必填', true); return; }
  try {
    const r = await api('/api/scripts', { method: 'POST', body: JSON.stringify(body) });
    closeModal('script-modal');
    toast(`脚本已保存：${r.script_id} v${r.version}`);
    location.hash = '#/scripts/' + encodeURIComponent(r.script_id);
    router();
  } catch (err) {
    toast('保存失败：' + err.message, true);
  }
});

// ── 邮件队列 ───────────────────────────────────────────────
async function renderEmails() {
  const main = $('#main');
  const pg = state.page.emails;
  const tabs = ['', 'pending', 'sent', 'failed', 'dry_run']
    .map((s) => `<button class="filter-tab ${pg.status === s ? 'active' : ''}" data-status="${s}">${s || '全部'}</button>`).join('');

  main.innerHTML = `
    <div class="toolbar">
      <div class="filter-tabs">${tabs}</div>
    </div>
    <div class="panel"><div class="panel-body" id="emails-body"><div class="loading">加载中…</div></div>
    <div class="pagination" id="emails-pager"></div></div>`;

  $$('.filter-tab').forEach((b) => b.addEventListener('click', () => {
    pg.status = b.dataset.status;
    pg.offset = 0;
    router();
  }));

  try {
    const r = await api(`/api/emails?status=${encodeURIComponent(pg.status)}&limit=${pg.limit}&offset=${pg.offset}`);
    const box = $('#emails-body');
    if (!r.emails.length) {
      box.innerHTML = '<div class="empty">暂无邮件记录</div>';
      $('#emails-pager').innerHTML = '';
      return;
    }
    box.innerHTML = `<table class="data"><thead><tr>
      <th>email_id</th><th>收件人</th><th>主题</th><th>reference</th><th>状态</th><th>重试</th><th>创建时间</th><th>发送时间</th><th></th>
    </tr></thead><tbody>
      ${r.emails.map((m) => `<tr>
        <td class="mono-cell">${esc(truncate(m.email_id, 14))}</td>
        <td>${esc((m.to || []).join(', '))}</td>
        <td>${esc(truncate(m.subject, 30))}</td>
        <td class="mono-cell">${esc(m.reference_id || '—')}</td>
        <td>${badge(m.status)}</td>
        <td>${esc(m.retry_count)}${m.next_retry_at ? '<br><span style="color:var(--text-2);font-size:11px">' + fmtTime(m.next_retry_at) + '</span>' : ''}</td>
        <td>${fmtTime(m.created_at)}</td>
        <td>${fmtTime(m.sent_at)}</td>
        <td>${m.status === 'failed' ? `<button class="btn sm danger" data-retry="${esc(m.email_id)}">重试</button>` : ''}</td>
      </tr>`).join('')}
    </tbody></table>`;
    $$('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api('/api/emails/' + encodeURIComponent(b.dataset.retry) + '/retry', { method: 'POST', body: '{}' });
        toast('已重新入队：' + b.dataset.retry);
        router();
      } catch (e) { toast('重试失败：' + e.message, true); }
    }));
    const from = pg.offset + 1, to = Math.min(pg.offset + r.emails.length, r.total);
    $('#emails-pager').innerHTML = `
      <span>共 ${r.total} 条 · 第 ${from}-${to} 条</span>
      <button class="btn sm" id="ep-prev" ${pg.offset === 0 ? 'disabled' : ''}>上一页</button>
      <button class="btn sm" id="ep-next" ${to >= r.total ? 'disabled' : ''}>下一页</button>`;
    $('#ep-prev').addEventListener('click', () => { pg.offset = Math.max(0, pg.offset - pg.limit); router(); });
    $('#ep-next').addEventListener('click', () => { pg.offset += pg.limit; router(); });
  } catch (e) {
    if (e.message !== 'unauthorized') { $('#emails-body').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
}

// ── 账户管理（仅 admin，/api/users）───────────────────────
async function renderUsers() {
  const main = $('#main');
  main.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-right" style="margin-left:auto">
        <button class="btn primary" id="btn-new-user">＋ 添加账户</button>
      </div>
    </div>
    <div class="panel"><div class="panel-body" id="users-body"><div class="loading">加载中…</div></div></div>`;

  $('#btn-new-user').addEventListener('click', () => {
    $('#user-form').reset();
    openModal('user-modal');
  });

  try {
    const r = await api('/api/users');
    const box = $('#users-body');
    if (!r.users.length) { box.innerHTML = '<div class="empty">暂无账户</div>'; return; }
    box.innerHTML = `<table class="data"><thead><tr>
      <th>id</th><th>用户名</th><th>角色</th><th>创建时间</th><th></th>
    </tr></thead><tbody>
      ${r.users.map((u) => `<tr>
        <td>${esc(u.id)}</td>
        <td>${esc(u.username)}</td>
        <td>${u.role === 'admin' ? '<span class="badge blue">admin</span>' : '<span class="badge gray">member</span>'}</td>
        <td>${fmtTime(u.created_at)}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn sm" data-setpwd="${esc(u.id)}" data-name="${esc(u.username)}">改密</button>
          <button class="btn sm danger" data-deluser="${esc(u.id)}" data-name="${esc(u.username)}">删除</button>
        </td>
      </tr>`).join('')}
    </tbody></table>`;
    $$('[data-deluser]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('删除账户 ' + b.dataset.name + '？')) return;
      try {
        await api('/api/users/' + encodeURIComponent(b.dataset.deluser), { method: 'DELETE' });
        toast('已删除 ' + b.dataset.name);
        router();
      } catch (e) { toast('删除失败：' + e.message, true); }
    }));
    $$('[data-setpwd]').forEach((b) => b.addEventListener('click', () => {
      openPwdModal(b.dataset.setpwd, b.dataset.name);
    }));
  } catch (e) {
    if (e.message !== 'unauthorized') { $('#users-body').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
  }
}

let pwdTargetId = null, pwdTargetName = '';
function openPwdModal(id, name) {
  pwdTargetId = id; pwdTargetName = name;
  $('#pwd-modal-title').textContent = '修改密码 · ' + name;
  $('#pwd-form').reset();
  openModal('pwd-modal');
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    username: fd.get('username').trim(),
    password: fd.get('password'),
    role: fd.get('role'),
  };
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify(body) });
    closeModal('user-modal');
    toast('已创建账户：' + body.username);
    router();
  } catch (err) {
    toast('创建失败：' + err.message, true);
  }
});

$('#pwd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/users/' + encodeURIComponent(pwdTargetId) + '/password', {
      method: 'POST', body: JSON.stringify({ password: fd.get('password') }),
    });
    closeModal('pwd-modal');
    toast('已更新密码：' + pwdTargetName);
  } catch (err) {
    toast('更新失败：' + err.message, true);
  }
});

// ── 启动 ───────────────────────────────────────────────────
// 本页仅登录会话可达（未登录在服务端就被 302 到 /login）。
refreshServiceInfo();
startAutoRefresh();
router();
