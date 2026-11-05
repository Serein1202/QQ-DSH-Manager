// app.js — 渲染层：五个视图（检测 / 服务 / 配置 / 链接 / 设置）
'use strict';
const $content = document.getElementById('content');
const $foot = document.getElementById('sidebar-foot');
let currentView = 'home';
let pollTimer = null;
let selectedTab = 'qqbridge';

/* ---------- 小工具 ---------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') node[k] = v; // 布尔走属性赋值：setAttribute('disabled', false) 仍会禁用按钮
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
function toast(msg, isErr = false) {
  const box = document.getElementById('toast');
  const t = el('div', { class: 'toast-item' + (isErr ? ' err' : '') }, msg);
  box.append(t);
  setTimeout(() => t.remove(), 4000);
}
function setStateBadge(state) {
  const map = { ok: '正常', warn: '待修复', missing: '未安装', off: '未运行' };
  return el('span', { class: 'dot ' + state, title: map[state] || state });
}

// 同频道只保留一个订阅：视图反复进出不会叠加监听器
const chanSubs = {};
function onChan(channel, cb) {
  if (chanSubs[channel]) chanSubs[channel]();
  chanSubs[channel] = window.api.on(channel, cb);
}

/* ---------- 视图 1：环境检测 / 安装 ---------- */
async function renderHome() {
  $content.innerHTML = '';
  const headRow = el('div', { style: 'display:flex;align-items:center;gap:12px' });
  headRow.append(el('h1', {}, '环境检测'));
  headRow.append(el('button', { class: 'btn', onclick: async () => {
    await window.api.invoke('detect:all', { force: true });
    renderHome();
  } }, '刷新环境'));
  $content.append(headRow);
  $content.append(el('p', { class: 'sub' }, '自动检测电脑里的组件；缺什么点什么。安装过程在下方滚动显示。'));

  const d = await window.api.invoke('detect:all');
  const installBox = el('div', { class: 'log', style: 'height:150px' });

  function card(name, comp, actions) {
    return el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        setStateBadge(comp.state),
        el('h3', {}, name),
        el('span', { class: 'detail', style: 'flex:1' }, comp.detail || ''),
        actions
      )
    );
  }
  function actBtn(label, primary, fn) {
    return el('button', { class: 'btn' + (primary ? ' primary' : ''), onclick: fn }, label);
  }

  // 指定路径：选目录 → 存入设置 → 重新检测
  function specDirBtn(key) {
    return el('button', { class: 'btn', onclick: async () => {
      const dir = await window.api.invoke('pick:dir');
      if (!dir) return;
      await window.api.invoke('settings:set', { components: { [key]: { dir } } });
      toast('已保存路径：' + dir);
      renderHome();
    } }, '指定路径');
  }

  // Node
  const nodeCard = card('Node.js', d.node, [
    d.node.state !== 'ok'
      ? actBtn('一键下载便携版', true, () => runInstall('node', null))
      : el('span', { class: 'detail' }, `v${d.node.version} · ${d.node.path}`),
  ]);

  // SnowLuma
  const snowCard = card('SnowLuma（QQ 协议端）', d.snowluma, [
    d.snowluma.state === 'missing'
      ? actBtn('下载 / 官网页面', true, () => runInstall('snowluma', null))
      : el('span', { class: 'detail' }, d.snowluma.dir),
    specDirBtn('snowluma'),
    d.snowluma.state !== 'missing' ? actBtn('打开目录', false, () => window.api.invoke('shell:openPath', d.snowluma.dir)) : null,
  ]);

  // DSH
  const dshCard = card('DSH（DeepSeek Harness）', d.dsh, [
    actBtn('打开官网下载页', true, async () => {
      const r = await window.api.invoke('dl:openPage', 'dsh');
      if (!r.ok) toast(r.error, true);
      else toast('已在浏览器打开下载页，下载解压后到"高级设置"里指定 DSH 目录');
    }),
    specDirBtn('dsh'),
    d.dsh.dir ? actBtn('打开目录', false, () => window.api.invoke('shell:openPath', d.dsh.dir)) : null,
  ]);

  // qq-bridge
  const qbActions = [];
  if (d.qqbridge.state === 'missing') qbActions.push(actBtn('一键下载安装', true, () => runInstall('qqbridge', null)));
  if (d.qqbridge.state === 'warn' && d.qqbridge.detail.includes('node_modules'))
    qbActions.push(actBtn('修复（npm install）', true, () => fixNpm(d.qqbridge.dir)));
  const qbCard = card('qq-bridge（桥接）', d.qqbridge, [
    ...qbActions,
    specDirBtn('qqbridge'),
    d.qqbridge.dir ? actBtn('打开目录', false, () => window.api.invoke('shell:openPath', d.qqbridge.dir)) : null,
  ]);

  function runInstall(key, targetDir) {
    installBox.textContent += `\n[开始] ${key}\n`;
    window.api.invoke('dl:install', { key, targetDir }).then((r) => {
      if (!r.ok && r.error) {
        installBox.textContent += `[提示] ${r.error}\n`;
        installBox.scrollTop = installBox.scrollHeight;
      }
    });
  }
  function fixNpm(dir) {
    installBox.textContent += `\n[修复] npm install @ ${dir}\n`;
    window.api.invoke('fix:npmInstall', { dir });
  }

  onChan('dl:step', ({ key, msg }) => {
    installBox.textContent += `[${key}] ${msg}\n`;
    installBox.scrollTop = installBox.scrollHeight;
  });
  onChan('dl:progress', ({ key, received, total }) => {
    if (key === 'update') {
      const pct = total ? Math.min(100, Math.round((received / total) * 100)) : null;
      setUpdateProgress(pct, `${(received / 1048576).toFixed(1)} MB / ${total ? (total / 1048576).toFixed(1) + ' MB' : '?'}`);
      return;
    }
    installBox.textContent += `[${key}] 进度 ${(received / 1048576).toFixed(1)}MB / ${total ? (total / 1048576).toFixed(1) + 'MB' : '?'}\n`;
    installBox.scrollTop = installBox.scrollHeight;
  });
  onChan('dl:done', ({ key, ok, error }) => {
    if (key === 'update') {
      hideUpdateProgress();
      return;
    }
    installBox.textContent += `[${key}] ${ok ? '✅ 完成' : '❌ ' + (error || '失败')}\n`;
    installBox.scrollTop = installBox.scrollHeight;
    if (ok && currentView === 'home') renderHome();
  });

  $content.append(
    nodeCard,
    snowCard,
    dshCard,
    qbCard,
    el('div', { class: 'card' }, el('h3', {}, '安装日志'), installBox),
    el('p', { class: 'sub' }, `自动扫描目录：${(d.scanRoots || [d.scanRoot]).join('　')}（可在高级设置里更改）`)
  );

  // SnowLuma 首次登录提示
  if (d.snowluma.state === 'ok') {
    $content.append(
      el(
        'div',
        { class: 'card' },
        el('h3', {}, '📱 SnowLuma 扫码登录'),
        el('p', { class: 'detail', style: 'margin:6px 0 10px' }, '首次使用需要扫码登录 QQ。点击下面按钮打开 SnowLuma 官方启动器，按提示扫码。'),
        el('button', { class: 'btn primary', onclick: async () => {
          const r = await window.api.invoke('snowluma:launchScan');
          if (!r.ok) toast(r.error, true);
        } }, '打开扫码窗口')
      )
    );
  }
}

/* ---------- 视图 2：服务管理 ---------- */
// 状态刷新模型：
//   每 2s 拉一次 svc:list（主进程侧是缓存 detect + 异步端口探活，不阻塞、不扫盘）。
//   只有「状态签名」变化时才重建卡片 DOM，其余轮询只就地更新运行时长/端口图标，
//   避免每 2s 重建整页导致的闪烁与按钮丢失焦点。
const SVC_POLL_MS = 2000;
const SVC_ACTION_TEXT = { start: '启动中…', stop: '停止中…', restart: '重启中…', startAll: '启动中…', stopAll: '停止中…' };

function fmtUptime(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60}分`;
}

async function renderServices() {
  $content.innerHTML = '';

  const statusLine = el('span', { class: 'detail' }, '正在读取状态…');
  const autoChk = el('input', { type: 'checkbox', checked: true });
  const refreshBtn = el('button', { class: 'btn' }, '🔄 刷新');
  const head = el(
    'div',
    { class: 'svc-head' },
    el('h1', {}, '服务管理'),
    refreshBtn,
    el('label', { class: 'check', style: 'margin:0' }, autoChk, '自动刷新'),
    statusLine
  );
  $content.append(head);
  $content.append(el('p', { class: 'sub' }, '状态每 2 秒自动刷新；菜单里点「刷新」会重新扫描组件目录。'));

  const startAllBtn = el('button', { class: 'btn primary' }, '🚀 一键全部启动');
  const stopAllBtn = el('button', { class: 'btn danger' }, '全部停止');
  const bulkRow = el('div', { class: 'row', style: 'display:flex;gap:10px;margin-bottom:16px' }, startAllBtn, stopAllBtn);
  $content.append(bulkRow);

  const listWrap = el('div');
  const logBox = el('div', { class: 'log', style: 'display:none' });
  const logTail = el('div', { class: 'log-tools', style: 'display:none' },
    el('span', { class: 'detail' }, '只显示最近 1200 行'),
    el('button', { class: 'btn', onclick: () => { logFor = ''; logBox.style.display = 'none'; logTail.style.display = 'none'; } }, '关闭日志')
  );
  $content.append(listWrap, logTail, logBox);

  let logFor = '';
  let logLines = [];
  const busy = new Map(); // id -> 'start' | 'stop' | 'restart'
  let lastSig = '';
  let lastList = [];
  let ticking = false;

  // ---- 日志：主进程按 100ms 批量推送，这里一次 append，不重建整块 ----
  function dealLog(id, lines) {
    if (id !== logFor) return;
    logLines.push(...lines);
    if (logLines.length > 1200) logLines.splice(0, logLines.length - 1200);
    logBox.textContent = logLines.join('\n');
    logBox.scrollTop = logBox.scrollHeight;
  }
  async function showLog(id) {
    logFor = id;
    const logs = await window.api.invoke('svc:logs', id);
    logLines = logs.slice(-1200);
    logBox.style.display = 'block';
    logTail.style.display = 'flex';
    logBox.textContent = logLines.join('\n') || '（暂无日志）';
    logBox.scrollTop = logBox.scrollHeight;
  }
  function toggleLog(id) {
    if (logFor === id) {
      logFor = '';
      logBox.style.display = 'none';
      logTail.style.display = 'none';
    } else showLog(id);
  }

  // ---- 卡片 ----
  function signature(list) {
    return JSON.stringify(
      list.map((s) => [
        s.id,
        s.running,
        s.managed,
        s.startable,
        s.blockedReason,
        s.ports,
        s.webLinks.map((l) => [l.url, l.open]),
        busy.get(s.id) || '',
      ])
    );
  }

  function draw(list) {
    listWrap.innerHTML = '';
    for (const svc of list) {
      const op = busy.get(svc.id);
      const dot = el('span', { class: 'dot ' + (op ? 'warn' : svc.running ? 'ok' : 'off') });
      const meta = el('span', { class: 'detail', style: 'flex:1' });
      const btns = [];

      if (op) {
        // 操作进行中：按钮全禁用 + 文案变成「重启中…」，让用户知道没卡住
        btns.push(el('button', { class: 'btn', disabled: true }, SVC_ACTION_TEXT[op] || '处理中…'));
      } else if (svc.running) {
        btns.push(el('button', { class: 'btn', onclick: () => doSvc('svc:stop', svc.id, 'stop') }, '停止'));
        btns.push(el('button', { class: 'btn', onclick: () => doSvc('svc:restart', svc.id, 'restart') }, '重启'));
      } else if (svc.startable) {
        btns.push(el('button', { class: 'btn primary', onclick: () => doSvc('svc:start', svc.id, 'start') }, '启动'));
      }

      // Web 入口：端口真的在监听才可点，URL 里带主进程捕获的 token
      const links = svc.webLinks.map((l) =>
        el(
          'button',
          {
            class: 'btn' + (l.open ? ' primary' : ''),
            disabled: !l.open,
            title: l.url,
            onclick: async () => {
              if (!l.open) return;
              const r = await window.api.invoke('shell:openExternal', l.url);
              if (r && !r.ok) toast(r.error || '打开浏览器失败', true);
            },
          },
          '🌐 ' + l.label + (l.open ? '' : '（未就绪）')
        )
      );

      const row = el('div', { class: 'card', 'data-svc': svc.id },
        el('div', { class: 'row' }, dot, el('h3', {}, svc.name), meta, ...links, ...btns),
        !svc.running && !svc.startable && svc.blockedReason
          ? el('p', { class: 'detail', style: 'margin-top:8px;color:var(--warn)' }, '⚠ ' + svc.blockedReason)
          : null,
        el('div', { class: 'row', style: 'margin-top:8px' },
          svc.managed ? el('button', { class: 'btn', onclick: () => toggleLog(svc.id) }, logFor === svc.id ? '收起日志' : '查看日志') : null,
          el('span', { class: 'detail' }, svc.pid ? `pid ${svc.pid}` : '')
        )
      );
      row._meta = meta;
      row._svc = svc;
      listWrap.append(row);
      paintMeta(row);
    }
  }

  // 就地更新可变文案（运行时长每秒都在变，不属于签名）
  function paintMeta(row) {
    const svc = row._svc;
    const op = busy.get(svc.id);
    const portInfo = Object.entries(svc.ports).map(([p, up]) => `:${p} ${up ? '✅' : '❌'}`).join(' ');
    const mode = svc.managed ? '· 由管理器托管' : svc.running ? '· 外部进程' : '';
    const up = svc.uptimeMs ? `· 已运行 ${fmtUptime(svc.uptimeMs)}` : '';
    const state = op ? `· ${SVC_ACTION_TEXT[op] || '处理中'}` : svc.running ? '· 运行中' : '· 已停止';
    const cpHint = svc.companionHint ? ' · ' + svc.companionHint : '';
    row._meta.textContent = `${svc.desc} ${portInfo} ${state} ${mode} ${up}${cpHint}`.replace(/\s+/g, ' ');
  }

  async function tick(manual = false) {
    if (ticking) return;
    ticking = true;
    try {
      const list = manual ? (await window.api.invoke('svc:refresh')).list : await window.api.invoke('svc:list');
      lastList = list;
      const sig = signature(list);
      if (sig !== lastSig) {
        lastSig = sig;
        draw(list);
      } else {
        for (const row of listWrap.children) {
          const s = list.find((x) => x.id === row.dataset.svc);
          if (s) {
            row._svc = s;
            paintMeta(row);
          }
        }
      }
      statusLine.textContent = `状态已同步 ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      statusLine.textContent = '状态刷新失败：' + (e && e.message ? e.message : e);
    } finally {
      ticking = false;
    }
  }

  const svcOpKeys = new Set(); // 操作互斥：进行中的服务操作 (channel|id)，防止快速连点并发重复 spawn
  async function doSvc(channel, id, kind) {
    const key = channel + '|' + id;
    if (svcOpKeys.has(key)) {
      toast('该操作正在执行中，请稍候', true);
      return;
    }
    svcOpKeys.add(key);
    busy.set(id, kind);
    lastSig = ''; // 强制重绘（按钮切到「重启中…」且禁用）
    draw(lastList);
    let r = null;
    try {
      r = await window.api.invoke(channel, id);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '调用失败' };
    } finally {
      svcOpKeys.delete(key);
      busy.delete(id);
    }
    if (!r) r = { ok: false, error: '未知错误' };
    if (!r.ok && r.error) toast(r.error, true);
    else if (r.reused && r.message) toast(r.message);
    // 进程起来了但端口还没就绪：必须提示，否则界面显示「未运行」会被当成操作失败
    else if (r.warn) toast(r.warn, true);
    // 附属服务启动失败单独提示（主服务仍然成功时不打断）
    const bad = (r.companions || []).filter((c) => !c.ok && c.error);
    if (bad.length) toast('附属服务启动失败：' + bad.map((c) => `${c.name}（${c.error}）`).join('、'), true);
    lastSig = '';
    tick();
    // 端口打开有延迟：1s / 3s / 6s 各补刷一次，状态和链接按钮尽快点亮
    for (const d of [1000, 3000, 6000]) setTimeout(() => { if (currentView === 'services') tick(); }, d);
  }

  // ---- 顶部批量按钮 ----
  startAllBtn.addEventListener('click', async () => {
    startAllBtn.disabled = true;
    const old = startAllBtn.textContent;
    startAllBtn.textContent = '🚀 启动中…';
    try {
      const results = await window.api.invoke('svc:startAll');
      for (const r of results) {
        if (r.warn) toast(r.warn, true);
        else if (!r.ok && !r.skipped) toast(`${r.id}: ${r.error || '未启动'}`, true);
      }
      if (!results.some((r) => !r.ok && !r.skipped)) toast('一键启动执行完毕');
    } finally {
      startAllBtn.disabled = false;
      startAllBtn.textContent = old;
      lastSig = '';
      tick();
    }
  });
  stopAllBtn.addEventListener('click', async () => {
    stopAllBtn.disabled = true;
    const old = stopAllBtn.textContent;
    stopAllBtn.textContent = '停止中…';
    try {
      await window.api.invoke('svc:stopAll');
      toast('已全部停止');
    } finally {
      stopAllBtn.disabled = false;
      stopAllBtn.textContent = old;
      lastSig = '';
      tick();
    }
  });
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '扫描中…';
    statusLine.textContent = '正在重新扫描组件目录…';
    try {
      await tick(true);
      toast('已刷新');
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 刷新';
    }
  });

  onChan('proc:log', (payload) => {
    if (currentView !== 'services') return;
    if (Array.isArray(payload.lines)) dealLog(payload.id, payload.lines);
    else if (payload.line) dealLog(payload.id, [payload.line]);
  });
  onChan('proc:exit', () => {
    if (currentView === 'services') {
      lastSig = '';
      tick();
    }
  });

  await tick();
  if (pollTimer) clearInterval(pollTimer);
  // 每次轮询都会带回新的 uptimeMs，paintMeta 就地更新，不需要重建卡片
  pollTimer = setInterval(() => {
    if (currentView !== 'services') return;
    if (!autoChk.checked) return;
    tick();
  }, SVC_POLL_MS);
}

/* ---------- 视图 3：凭证配置 ---------- */const QB_FIELDS = [
  { path: 'ownerQQ', label: '主人 QQ 号（ownerQQ）', type: 'text' },
  { path: 'allow.private', label: '允许私聊的 QQ 号（多个用英文逗号分隔）', type: 'list' },
  { path: 'allow.groups', label: '允许的群号（多个用英文逗号分隔）', type: 'list' },
  { path: 'dsh.baseUrl', label: 'DSH 地址（如 http://127.0.0.1:3080）' },
  { path: 'dsh.authToken', label: 'DSH 凭证 authToken', secret: true },
  { path: 'dsh.model', label: 'DSH 模型名' },
  { path: 'dsh.provider', label: 'DSH provider' },
  { path: 'snowluma.accessToken', label: 'SnowLuma accessToken（HTTP :3000 那个）', secret: true },
  { path: 'snowluma.wsUrl', label: 'SnowLuma WS 地址' },
  { path: 'snowluma.httpUrl', label: 'SnowLuma HTTP 地址' },
  { path: 'snowluma.homeDir', label: 'SnowLuma 所在目录' },
  { path: 'consolePort', label: 'bridge 控制台端口', type: 'number' },
  { path: 'consoleToken', label: 'bridge 控制台 token（可留空）', secret: true },
];

async function renderConfig() {
  $content.innerHTML = '';
  $content.append(el('h1', {}, '凭证配置'));
  $content.append(el('p', { class: 'sub' }, '表单直接写入各组件的 config.json；保存前自动备份为 .bak。'));

  const tabs = el('div', { class: 'tabs' },
    el('button', { class: selectedTab === 'qqbridge' ? 'active' : '', onclick: () => { selectedTab = 'qqbridge'; renderConfig(); } }, 'qq-bridge'),
    el('button', { class: selectedTab === 'snowluma' ? 'active' : '', onclick: () => { selectedTab = 'snowluma'; renderConfig(); } }, 'SnowLuma')
  );
  $content.append(tabs);

  if (selectedTab === 'qqbridge') return renderQbForm();
  return renderSnowForm();
}

async function renderQbForm() {
  const cfg = await window.api.invoke('config:read', 'qqbridge');
  if (cfg.error) {
    $content.append(el('div', { class: 'card' }, el('p', { class: 'detail' }, cfg.error + '——请先在"环境检测"页安装 qq-bridge。')));
    return;
  }
  const inputs = [];
  const form = el('div', { class: 'card' });
  for (const f of QB_FIELDS) {
    const val = getList(cfg.data, f.path);
    let input;
    if (f.secret) {
      input = el('input', { type: 'password', value: val || '' });
      const eye = el('button', { class: 'btn', onclick: () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        eye.textContent = input.type === 'password' ? '👁' : '🙈';
      } }, '👁');
      form.append(el('div', { class: 'field' }, el('label', {}, f.label), el('div', { class: 'secret-row' }, input, eye)));
    } else {
      input = el('input', { type: f.type === 'number' ? 'number' : 'text', value: val === undefined || val === null ? '' : String(val) });
      form.append(el('div', { class: 'field' }, el('label', {}, f.label), input));
    }
    inputs.push({ f, input });
  }
  form.append(el('button', { class: 'btn primary', onclick: async () => {
    const apply = [];
    for (const { f, input } of inputs) {
      let v = input.value.trim();
      if (f.type === 'list') v = v ? v.split(/[,，\s]+/).map((x) => (Number(x) || x)).filter(Boolean) : [];
      else if (f.type === 'number') v = Number(v) || 0;
      apply.push({ path: f.path, value: v });
    }
    const r = await window.api.invoke('config:write', { file: cfg.file, apply });
    toast(r.ok ? '已保存（原文件备份为 config.json.bak）' : '保存失败', !r.ok);
  } }, '💾 保存配置'));
  $content.append(form);
}

async function renderSnowForm() {
  const cfg = await window.api.invoke('config:read', 'snowluma');
  if (cfg.error) {
    $content.append(el('div', { class: 'card' }, el('p', { class: 'detail' }, cfg.error + '——请先在"环境检测"页安装 SnowLuma。')));
    return;
  }
  // runtime.json: webuiPort
  const rtInputs = [];
  const rtForm = el('div', { class: 'card' }, el('h3', {}, 'runtime.json'));
  for (const f of [{ path: 'webuiPort', label: 'WebUI 端口', type: 'number' }]) {
    const input = el('input', { type: f.type, value: cfg.runtime[f.path] ?? '' });
    rtInputs.push({ f, input });
    rtForm.append(el('div', { class: 'field' }, el('label', {}, f.label), input));
  }
  rtForm.append(el('button', { class: 'btn primary', onclick: async () => {
    const apply = rtInputs.map(({ f, input }) => ({ path: f.path, value: Number(input.value) || input.value }));
    await window.api.invoke('config:write', { file: cfg.runtimeFile, apply });
    toast('已保存');
  } }, '💾 保存'));
  $content.append(rtForm);

  // onebot_*.json：每个登录账号的 token / 端口
  for (const ob of cfg.onebots || []) {
    const http0 = ob.data.networks?.httpServers?.[0] || {};
    const ws0 = ob.data.networks?.wsServers?.[0] || {};
    const fields = [
      { path: 'networks.httpServers.0.accessToken', label: 'HTTP accessToken（填到 qq-bridge 的 snowluma.accessToken）', value: http0.accessToken || '', secret: true },
      { path: 'networks.httpServers.0.port', label: 'HTTP 端口', value: http0.port || 3000 },
      { path: 'networks.wsServers.0.accessToken', label: 'WS accessToken', value: ws0.accessToken || '', secret: true },
      { path: 'networks.wsServers.0.port', label: 'WS 端口', value: ws0.port || 3001 },
    ];
    const inputs = [];
    const form = el('div', { class: 'card' }, el('h3', {}, `OneBot（${ob.name}）`));
    for (const f of fields) {
      const input = el('input', { type: f.secret ? 'password' : 'number', value: f.value });
      inputs.push({ f, input });
      const row = el('div', { class: 'field' }, el('label', {}, f.label), input);
      if (f.secret) {
        const eye = el('button', { class: 'btn', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } }, '👁');
        row.append(el('div', { class: 'secret-row' }, input, eye));
      }
      form.append(row);
    }
    form.append(el('button', { class: 'btn primary', onclick: async () => {
      const apply = inputs.map(({ f, input }) => ({ path: f.path, value: f.secret ? input.value.trim() : Number(input.value) || 0 }));
      await window.api.invoke('config:write', { file: ob.file, apply });
      toast('已保存（改端口需重启 SnowLuma 生效）');
    } }, '💾 保存'));
    $content.append(form);
  }
}

// 统一取值：点路径 + 数组下标
function getList(obj, dotted) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined) return '';
    cur = cur[k];
  }
  if (Array.isArray(cur)) return cur.join(',');
  return cur;
}

/* ---------- 视图 4：高级设置 ---------- */
async function renderSettings() {
  const s = await window.api.invoke('settings:get');
  $content.innerHTML = '';
  $content.append(el('h1', {}, '高级设置'));
  $content.append(el('p', { class: 'sub' }, '组件目录、DSH 启动命令、下载地址都在这里改。'));

  const dirInputs = {};
  function dirField(key, label, val) {
    const input = el('input', { type: 'text', value: val || '', placeholder: '留空 = 自动扫描' });
    dirInputs[key] = input;
    return el('div', { class: 'field' }, el('label', {}, label),
      el('div', { class: 'secret-row' }, input,
        el('button', { class: 'btn', onclick: async () => {
          const d = await window.api.invoke('pick:dir');
          if (d) input.value = d;
        } }, '选择…')));
  }

  const cardComp = el('div', { class: 'card' }, el('h3', {}, '组件目录'));
  cardComp.append(dirField('snowluma', 'SnowLuma 目录', s.components.snowluma?.dir));
  cardComp.append(dirField('dsh', 'DSH 目录', s.components.dsh?.dir));
  cardComp.append(dirField('qqbridge', 'qq-bridge 目录', s.components.qqbridge?.dir));

  const dshCmd = el('input', { type: 'text', value: s.components.dsh?.startCommand || '', placeholder: '留空 = 自动用 DSH 自带 CLI 跑 dsh web（3080 端口）' });
  const dshPort = el('input', { type: 'number', value: s.components.dsh?.port || 3080 });
  const dshWs = el('input', { type: 'text', value: s.components.dsh?.workspace || '', placeholder: '留空 = 自动（~/Documents/deepseek-harness）' });
  cardComp.append(
    el('div', { class: 'field' }, el('label', {}, 'DSH 启动命令（留空自动：exe + 内嵌 CLI 跑 web profile；不要填桌面 exe 路径——那只开 GUI 不开 3080）'), dshCmd),
    el('div', { class: 'field' }, el('label', {}, 'DSH 端口（留空时以 qq-bridge 配置里的 dsh.baseUrl 为准）'), dshPort),
    el('div', { class: 'field' }, el('label', {}, 'DSH 工作区目录（agent 读写文件的根目录）'), dshWs)
  );

  const dlInputs = {};
  const cardDl = el('div', { class: 'card' }, el('h3', {}, '下载地址'));
  for (const [key, label] of [
    ['snowluma', 'SnowLuma（官网/zip 直链）'],
    ['dsh', 'DSH（官网/zip 直链）'],
    ['qqbridge', 'qq-bridge（GitHub zip）'],
    ['node', 'Node 便携版（zip）'],
  ]) {
    const input = el('input', { type: 'text', value: s.downloads?.[key] || '', placeholder: 'zip 直链 = 自动下载解压；网页地址 = 打开浏览器' });
    dlInputs[key] = input;
    cardDl.append(el('div', { class: 'field' }, el('label', {}, label), input));
  }

  const cardMisc = el('div', { class: 'card' }, el('h3', {}, '行为'));
  const chkClose = el('input', { type: 'checkbox' });
  chkClose.checked = !!s.closeStopServices;
  cardMisc.append(el('label', { class: 'check' }, chkClose, '关闭软件时停止所有由管理器启动的服务'));

  // GitHub 加速镜像：留空=官方直连（失败自动走内置镜像兜底）
  const ghMirror = el('input', { type: 'text', value: s.githubMirror || '', placeholder: '留空=直连（失败自动走内置镜像）；如 https://ghfast.top' });
  cardMisc.append(el('div', { class: 'field' }, el('label', {}, 'GitHub 加速镜像（检查更新/下载用）'), ghMirror));

  $content.append(cardComp, cardDl, cardMisc);
  $content.append(el('button', { class: 'btn primary', onclick: async () => {
    await window.api.invoke('settings:set', {
      components: {
        snowluma: { dir: dirInputs.snowluma.value.trim() },
        dsh: { dir: dirInputs.dsh.value.trim(), startCommand: dshCmd.value.trim(), port: Number(dshPort.value) || 3080, workspace: dshWs.value.trim() },
        qqbridge: { dir: dirInputs.qqbridge.value.trim() },
      },
      downloads: Object.fromEntries(Object.entries(dlInputs).map(([k, i]) => [k, i.value.trim()])),
      closeStopServices: chkClose.checked,
      githubMirror: ghMirror.value.trim(),
    });
    toast('设置已保存');
  } }, '💾 保存设置'));
}

/* ---------- 侧栏底部：版本 + 检查更新 ---------- */
function setUpdateProgress(pct, text) {
  const wrap = document.getElementById('update-progress');
  if (!wrap) return;
  wrap.style.display = 'block';
  const fill = document.getElementById('update-progress-fill');
  const label = document.getElementById('update-progress-label');
  if (fill && pct != null) fill.style.width = pct + '%';
  if (label) label.textContent = (pct != null ? `${pct}%　` : '') + (text || '');
}
function hideUpdateProgress() {
  const wrap = document.getElementById('update-progress');
  if (wrap) wrap.style.display = 'none';
}
async function checkUpdate() {
  const btn = document.getElementById('btn-update');
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    const r = await window.api.invoke('update:check');
    if (!r.ok) {
      toast('检查更新失败：' + r.error, true);
      return;
    }
    if (!r.newer) {
      toast(`已是最新版本 v${r.current}`);
      return;
    }
    // Release 只发 zip（解压即用的完整目录），没有 exe 资产可下载
    const target = r.zip;
    if (!target) {
      // 后端在 API 限流时走网页跳转兜底，只有版本号没有资产直链 → 直接打开 Release 页面
      toast(`发现新版本 v${r.latest}，将打开 Release 页面，请手动下载`);
      if (r.page) window.api.invoke('shell:openExternal', r.page);
      return;
    }
    toast(`发现新版本 v${r.latest}${r.notes ? '：' + r.notes : ''}，开始下载…`);
    {
      const res = await window.api.invoke('update:install', { url: target });
      if (res.ok) toast('下载完成，将替换旧版本并自动重启');
      else toast('下载失败：' + res.error, true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
  }
}

(function initFoot() {
  const status = el('div', { id: 'foot-status' }, '…');
  const btn = el('button', { id: 'btn-update', class: 'btn', style: 'margin-top:8px;width:100%;font-size:12px', onclick: checkUpdate }, '检查更新');
  const upWrap = el('div', { id: 'update-progress', style: 'display:none;margin-top:8px' },
    el('div', { class: 'progress' }, el('div', { id: 'update-progress-fill' })),
    el('div', { id: 'update-progress-label', style: 'margin-top:2px;font-size:11px;color:var(--muted)' })
  );
  const ver = el('div', { style: 'margin-top:6px;font-size:11px;color:var(--muted)' });
  $foot.append(status, btn, upWrap, ver);

  // 只有 Release 打包产物才显示版本号 + 更新入口。
  // 开发版（源码运行）的版本号没有发布语义，显示出来会让人误以为「已是最新版」，
  // 更新检测同理——直接不渲染，而不是渲染成「未知」。
  window.api.invoke('app:version').then((r) => {
    const packaged = !!(r && r.packaged);
    if (!packaged) {
      btn.remove();
      upWrap.remove();
      ver.remove();
      return;
    }
    ver.textContent = 'v' + (r.version || '');
  });
})();

async function footStatus() {
  const list = await window.api.invoke('svc:list');
  const running = list.filter((x) => x.running).length;
  const statusEl = document.getElementById('foot-status');
  if (statusEl) statusEl.textContent = `运行中服务：${running} / ${list.length}`;
}
footStatus();
setInterval(footStatus, 5000); // 任何页面都刷新（原来在服务管理页跳过，导致底部计数假死）

/* ---------- 路由 ---------- */
const VIEWS = { home: renderHome, services: renderServices, config: renderConfig, settings: renderSettings };

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  currentView = btn.dataset.view;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b === btn));
  if (pollTimer) clearInterval(pollTimer);
  VIEWS[currentView]();
});

VIEWS.home();
