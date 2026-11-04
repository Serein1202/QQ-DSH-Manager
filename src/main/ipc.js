// ipc.js — 主进程 IPC 路由：检测 / 服务 / 配置 / 下载 / 设置 / Shell
'use strict';
const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { settings, updateSettings, defaultScanRoot, scanRoots } = require('./store');
const { detectAll, invalidateDetect, findNode } = require('./detect');
const { ProcessManager, probePort } = require('./procs');
const { buildServiceList, START_ORDER } = require('./services');
const { downloadFile, unzip, npmInstall, fetchJson, GITHUB_MIRRORS, githubMirrorUrl } = require('./downloader');

const pm = new ProcessManager();
const downloads = new Map(); // key -> { running: true } 防重复下载

// ---------- 版本号 ----------
// 约定：只有打包产物（Release 下载的安装版/便携版）才对外暴露版本号与更新检测；
// 源码运行（app.isPackaged === false，含 npm start / 启动.bat / electron <入口>）一律视为开发版，
// 界面不显示版本号、不提供更新入口 —— 开发版没有稳定的版本语义，暴露出来只会误导（见下方 getVersion 退化问题）。
//
// 打包态下版本号不直接信任 app.getVersion()：它只在「应用根目录有 package.json」时才返回本项目版本，
// 一旦以入口文件方式启动（electron src/main/index.js），Electron 把内置默认应用当根目录，
// 返回的是 Electron 自身版本（实测 33.4.11）。所以读 package.json 并校验 name，读不到才回退。
const PKG_NAME = 'qq-dsh-manager';
let _verCache = '';
function managerVersion() {
  if (_verCache) return _verCache;
  // 候选根目录按可靠性排序：打包态 app.asar → 源码目录（__dirname 上溯两级）→ resources/app
  const roots = [];
  try { roots.push(app.getAppPath()); } catch { /* 极端情况下取不到，跳过 */ }
  roots.push(path.join(__dirname, '..', '..'));
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'app'));
  for (const root of roots) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (pkg && pkg.name === PKG_NAME && pkg.version) {
        _verCache = String(pkg.version);
        return _verCache;
      }
    } catch {
      // 单个候选读不到不影响下一个
    }
  }
  return app.getVersion() || '0.0.0';
}

// 是否 Release 打包产物。开发版据此关闭版本号显示与更新检测。
function isReleaseBuild() {
  try { return app.isPackaged === true; } catch { return false; }
}

// 等一组端口至少有一个就绪：就绪返回空串，超时返回提示文案。
// 为什么要等：spawn 只代表进程创建成功，服务真正可用要等它监听端口。
// 不等就返回 ok，前端 1.5s 刷新时看到「未运行」，用户会认为启动/重启失败。
async function waitReady(ports, timeout = 15000) {
  const list = (ports || []).filter(Boolean);
  if (!list.length) return '';
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ups = await Promise.all(list.map((p) => probePort(p, '127.0.0.1', 500)));
    if (ups.some(Boolean)) return '';
    await new Promise((r) => setTimeout(r, 500));
  }
  return `进程已启动，但端口 ${list.join('/')} 在 ${Math.round(timeout / 1000)}s 内未就绪（可能仍在初始化，或需要登录/授权）`;
}

// 停止全部服务（含用户手动启动、未被托管的实例，靠端口 + 身份特征反查）。
// sync=true：只同步下达 taskkill、不等待退出，供 before-quit 这类同步钩子使用。
function stopAllServicesSync() {
  const { portsById, cwdById, optsById } = serviceTargets();
  return pm.stopAllSync(portsById, cwdById, optsById).stopped;
}

async function stopAllServices() {
  const { portsById, cwdById, optsById } = serviceTargets();
  return pm.stopAllAsync(portsById, cwdById, optsById);
}

function serviceTargets() {
  const portsById = {};
  const cwdById = {};
  const optsById = {};
  for (const svc of buildServiceList()) {
    portsById[svc.id] = svc.probePorts;
    cwdById[svc.id] = svc.run.cwd || '';
    optsById[svc.id] = { verify: svc.run.verify || [] };
  }
  return { portsById, cwdById, optsById };
}

function send(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// ---------- 日志推送批处理 ----------
// 服务（尤其 DSH 的插件）可能每秒刷几百行；逐行发 IPC + 渲染层逐行重建 textContent
// 会把渲染进程拖到无响应。这里按 100ms 合并成一次推送，渲染层一次 append。
const LOG_FLUSH_MS = 100;
const logBuf = new Map(); // id -> string[]
let logTimer = null;

function flushLogs() {
  logTimer = null;
  for (const [id, lines] of logBuf) {
    if (!lines.length) continue;
    const batch = lines.splice(0, lines.length);
    send('proc:log', { id, lines: batch });
  }
}

pm.onLog = (id, line) => {
  let arr = logBuf.get(id);
  if (!arr) {
    arr = [];
    logBuf.set(id, arr);
  }
  arr.push(line);
  if (arr.length > 2000) arr.splice(0, arr.length - 2000); // 主进程侧兜底，防止刷屏撑爆内存
  if (!logTimer) logTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
};
pm.onExit = (id) => {
  flushLogs(); // 先把残余日志推出去，渲染层才能看到「进程退出」这一行
  send('proc:exit', { id });
};

// ---------- 配置读写（带备份 + 深路径 set） ----------
function deepSet(obj, dottedPath, value) {
  const keys = dottedPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
function deepGet(obj, dottedPath, def) {
  let cur = obj;
  for (const k of dottedPath.split('.')) {
    if (cur === null || cur === undefined) return def;
    cur = cur[k];
  }
  return cur === undefined ? def : cur;
}
function backupAndWrite(file, data) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, file + '.bak');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// SnowLuma 的 onebot_*.json 按登录 QQ 号分文件，全部列出给前端编辑
function listOnebotFiles(snowDir) {
  const dir = path.join(snowDir, 'config');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^onebot_\d+\.json$/.test(f))
    .map((f) => path.join(dir, f));
}

// ---------- 主进程侧入参校验（防渲染层被 XSS 后滥用敏感 handler） ----------
const ALLOW_INSTALL_KEYS = new Set(['node', 'snowluma', 'dsh', 'qqbridge']);
const ALLOW_DOWNLOAD_KEYS = new Set(['snowluma', 'dsh', 'qqbridge', 'node']);
const ALLOW_RESTART_KEYS = new Set(['snowluma', 'dsh', 'qqbridge']);

// settings:set 白名单 schema：未知字段丢弃、类型不符丢弃（number 允许字符串数字）
const SETTINGS_SCHEMA = {
  scanRoot: 'string',
  closeStopServices: 'boolean',
  components: {
    snowluma: { dir: 'string' },
    dsh: { dir: 'string', startCommand: 'string', port: 'number', workspace: 'string' },
    qqbridge: { dir: 'string' },
  },
  downloads: { keySet: ALLOW_DOWNLOAD_KEYS, type: 'stringMap' },
  autoRestart: { keySet: ALLOW_RESTART_KEYS, type: 'booleanMap' },
  githubMirror: 'string',
};

function sanitizeBySchema(value, schema) {
  if (schema === 'string') return typeof value === 'string' ? value : undefined;
  if (schema === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (schema === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  }
  if (schema.type === 'stringMap') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const k of Object.keys(value)) {
      if (schema.keySet.has(k) && typeof value[k] === 'string') out[k] = value[k];
    }
    return out;
  }
  if (schema.type === 'booleanMap') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const k of Object.keys(value)) {
      if (schema.keySet.has(k) && typeof value[k] === 'boolean') out[k] = value[k];
    }
    return out;
  }
  // 嵌套对象
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const k of Object.keys(schema)) {
      const v = sanitizeBySchema(value[k], schema[k]);
      if (v !== undefined) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

// 路径是否位于任一扫描根目录内（dl:install 的 targetDir 限制）
function isUnderScanRoots(p) {
  if (!p) return false;
  const resolved = path.resolve(p);
  return scanRoots().some((root) => {
    const rel = path.relative(path.resolve(root), resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// config:write 只允许写这几个文件：qq-bridge config.json、SnowLuma runtime.json、onebot_*.json
function isAllowedConfigFile(file) {
  if (!file || typeof file !== 'string') return false;
  const resolved = path.resolve(file).toLowerCase();
  const d = detectAll();
  if (d.qqbridge.dir && path.resolve(path.join(d.qqbridge.dir, 'config.json')).toLowerCase() === resolved) return true;
  if (d.snowluma.dir) {
    const cfgDir = path.resolve(path.join(d.snowluma.dir, 'config'));
    if (path.resolve(path.join(cfgDir, 'runtime.json')).toLowerCase() === resolved) return true;
    const name = path.basename(resolved);
    if (path.dirname(path.resolve(resolved)) === path.resolve(cfgDir).toLowerCase() && /^onebot_\d+\.json$/.test(name)) {
      return true;
    }
  }
  return false;
}

// ---------- 安装流程 ----------
async function installComponent(key, targetDir, onStep) {
  const s = settings();
  const url = s.downloads[key];
  const step = (msg) => onStep && onStep(msg);

  if (key === 'node') {
    if (!url) throw new Error('未配置 Node 便携版下载地址');
    step('下载 Node 便携版…');
    const zip = path.join(defaultScanRoot(), 'tools', 'node-portable.zip');
    await downloadFile(url, zip, (r, t) => send('dl:progress', { key, received: r, total: t }), { verifyZip: true });
    step('解压…');
    unzip(zip, path.join(defaultScanRoot(), 'tools', '_runtime', 'node'));
    fs.unlinkSync(zip);
    step('完成');
    return;
  }

  if (!url || !/\.zip($|\?)/i.test(url)) {
    // 没有直链：打开官网/仓库页面，让用户手动下，目录放哪在设置里指定
    if (url) await shell.openExternal(url);
    throw new Error(
      key === 'snowluma'
        ? 'SnowLuma 未配置 zip 直链（可在高级设置填官网下载的 zip 路径/地址），已为你打开下载页'
        : '该组件未配置 zip 直链，已打开下载页；下载后解压并在"高级设置"里指定目录'
    );
  }

  step('下载压缩包…');
  const tmpZip = path.join(defaultScanRoot(), `__dl_${key}.zip`);
  await downloadFile(url, tmpZip, (r, t) => send('dl:progress', { key, received: r, total: t }), { verifyZip: true });
  step('解压…');
  unzip(tmpZip, targetDir);
  fs.unlinkSync(tmpZip);

  if (key === 'qqbridge') {
    // 仓库不含 config.json（只有 example），解压后先兜底生成，避免 npm 失败导致永远缺失
    const example = path.join(targetDir, 'config.example.json');
    const target = path.join(targetDir, 'config.json');
    if (fs.existsSync(example) && !fs.existsSync(target)) {
      fs.copyFileSync(example, target);
      step('已生成 config.json（去"配置"页填写凭证）');
    }
    step('安装依赖（npm install，可能要几分钟）…');
    const nodeDir = path.join(defaultScanRoot(), 'tools', '_runtime', 'node');
    const nodeExe = path.join(nodeDir, 'node.exe');
    const res = await npmInstall(targetDir, fs.existsSync(nodeExe) ? nodeDir : '');
    if (!res.ok) {
      throw new Error(res.error + (res.log && res.log.length ? '\n最近日志：\n' + res.log.slice(-15).join('\n') : ''));
    }
    step('依赖安装完成');
  }
  step('安装完成');
}

// 版本比较：返回 >0 表示 a 更新
function cmpVer(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ---------- IPC 注册 ----------
function registerIpc() {
  // 检测（force=true 时清 15s 缓存强制重扫）
  ipcMain.handle('detect:all', (_e, opts) => {
    if (opts && opts.force) invalidateDetect();
    return detectAll();
  });

  // 服务列表 + 状态（全部探活并发，单个 600ms 超时，5 个服务最坏 ~0.6s 出全量结果）
  // 这是前端 2s 轮询的「实时状态」接口：detect 结果走 5 分钟缓存，端口探活是异步的，
  // 所以稳定状态下这里不碰磁盘、不阻塞事件循环。
  async function listStatus() {
    const list = buildServiceList();
    // DSH Web 入口：进程启动时 mint 的 token 只出现在启动日志里，
    // 这里把捕获到的 token 拼进 URL，避免用户首次点击 3080 被认证拦截后手动翻日志
    const dshToken = pm.getWebToken('dsh');
    if (dshToken) {
      const dsh = list.find((x) => x.id === 'dsh');
      const link = dsh && dsh.webLinks[0];
      if (link) {
        const sep = link.url.includes('?') ? '&' : '?';
        link.url = link.url + sep + 'token=' + encodeURIComponent(dshToken);
      }
    }
    const out = await Promise.all(
      list.map(async (svc) => {
        const entries = await Promise.all(svc.probePorts.map(async (p) => [p, await probePort(p, '127.0.0.1', 600)]));
        const ports = Object.fromEntries(entries);
        const managed = pm.isRunning(svc.id);
        const alive = managed || (svc.probePorts.length > 0 && Object.values(ports).some(Boolean));
        return {
          id: svc.id,
          name: svc.name,
          desc: svc.desc,
          running: !!alive,
          managed,
          pid: managed ? pm.getPid(svc.id) : 0,
          uptimeMs: managed ? pm.getUptime(svc.id) : 0,
          ports,
          startable: svc.startable,
          blockedReason: svc.blockedReason,
          companionHint: svc.companionHint || '',
          webLinks: svc.webLinks.map((l) => ({ ...l, open: !!ports[l.port] })),
        };
      })
    );
    return out;
  }

  ipcMain.handle('svc:list', () => listStatus());

  // 手动刷新：强制重新扫描磁盘（组件目录可能被用户手动挪过 / 刚在外部装好）
  // 先让出一次事件循环，渲染层能把按钮切成「扫描中…」再开始同步扫描
  ipcMain.handle('svc:refresh', async () => {
    await new Promise((r) => setImmediate(r));
    invalidateDetect();
    const list = await listStatus();
    return { ok: true, list };
  });

  ipcMain.handle('svc:start', async (_e, id) => {
    const svc = buildServiceList().find((x) => x.id === id);
    if (!svc) return { ok: false, error: '未知服务' };
    if (!svc.startable) return { ok: false, error: svc.blockedReason || '无法启动' };
    // 管理器已托管该服务 → 直接复用。必须先查托管表再看端口：
    // 端口从 spawn 到 listen 有几百毫秒到数秒的空窗，只靠端口判断时连点两次「启动」会
    // 拉起第二个进程（DSH 这类单实例应用的新进程会立刻退出，界面上表现为「启动失败」）。
    if (pm.isRunning(id)) {
      return { ok: true, reused: true, message: `${svc.name} 已在运行，已复用现有进程` };
    }
    // 端口已在监听 = 已有实例在跑。DSH 是 Electron 单实例应用，重复启动的新进程会立刻退出
    // （退出码 0，界面上表现为"点了没反应/启动失败"）→ 直接复用，不再拉第二个进程
    if (svc.probePorts.length) {
      const ups = await Promise.all(svc.probePorts.map((p) => probePort(p)));
      if (ups.some(Boolean)) {
        return { ok: true, reused: true, message: `${svc.name} 已在运行（端口 ${svc.probePorts.join('/')} 在监听），已复用现有进程` };
      }
    }
    const r = pm.start(id, svc.run);
    // 附属服务（qq-bridge 的手机 MCP / QQ 空间）随主服务一起拉起，日志并入主面板
    const companions = [];
    for (const c of svc.companions || []) {
      const cr = pm.start(c.id, { ...c.run, logTo: id, logPrefix: c.name });
      companions.push({ id: c.id, name: c.name, ok: cr.ok, error: cr.error });
    }
    if (r.ok) pm.clearCrash(id); // 手动启动成功：清掉崩溃计数，重置自动重启退避
    const warn = r.ok ? await waitReady(svc.probePorts) : '';
    return { ...r, companions, ...(warn ? { warn } : {}) };
  });

  ipcMain.handle('svc:stop', async (_e, id) => {
    const svc = buildServiceList().find((x) => x.id === id);
    // 先停附属服务，再停主服务（顺序反了容易留孤儿进程）
    for (const c of (svc && svc.companions) || []) await pm.stopAsync(c.id);
    // 必须传 verify：非托管实例（管理器没托管，靠端口/命令行反查）要靠身份特征确认归属。
    // 不传时 verify 为空 → 端口命中的进程一律被判「无法确认是本服务」→ 停止按钮永远失败。
    const r = await pm.stopAsync(id, svc ? svc.probePorts : [], svc ? svc.run.cwd : '', {
      verify: (svc && svc.run.verify) || [],
    });
    // 等进程真正退出再返回，否则前端立刻刷新仍看到端口在线，状态反复跳
    if (r.ok) await pm.waitStopped(r.pids);
    return r;
  });
  ipcMain.handle('svc:logs', (_e, id) => pm.getLogs(id));

  ipcMain.handle('svc:restart', async (_e, id) => {
    const svc = buildServiceList().find((x) => x.id === id);
    if (!svc) return { ok: false, error: '未知服务' };
    // 先判可启动性，再做停止：反过来的话，服务不可启动时会被停掉却起不来
    if (!svc.startable) return { ok: false, error: svc.blockedReason || '无法启动' };

    for (const c of svc.companions || []) await pm.stopAsync(c.id);

    // 服务本来就没在运行时（崩溃过 / 首次启动），stop 会返回 notRunning。
    // 这不是错误，直接进启动分支。以前无条件当失败中止，导致「没运行 → 点重启 → 报停止失败」
    // → DSH 一旦崩过一次，重启按钮就永久失效。
    const verify = svc.run.verify || [];
    const stopR = await pm.stopAsync(id, svc.probePorts, svc.run.cwd, { verify });
    if (!stopR.ok && !stopR.notRunning) {
      return { ok: false, error: `停止失败，已中止重启：${stopR.error || '未知错误'}` };
    }
    // 等 PID 真正消失（taskkill 返回 0 不代表进程已终止，DSH 这类 Electron 程序退出更慢）
    if (stopR.ok) {
      const gone = await pm.waitStopped(stopR.pids, 8000);
      if (!gone) {
        return { ok: false, error: '旧进程在 8s 内未退出，已中止重启以避免残留多实例' };
      }
    }

    // 等端口真正释放（旧实例没退净就重启 → 抢端口失败，新进程立刻退出）
    const ports = svc.probePorts || [];
    const deadline = Date.now() + 10000;
    while (ports.length && Date.now() < deadline) {
      const ups = await Promise.all(ports.map((p) => probePort(p, '127.0.0.1', 400)));
      if (!ups.some(Boolean)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (ports.length) {
      const stillUp = await Promise.all(ports.map((p) => probePort(p, '127.0.0.1', 400)));
      if (stillUp.some(Boolean)) {
        return { ok: false, error: `端口 ${ports.join('/')} 在停止后仍未释放，已中止重启以避免残留多实例` };
      }
    }

    pm.clearCrash(id); // 手动重启：清崩溃计数，重开自动重启退避窗口
    const r = pm.start(id, svc.run);
    if (!r.ok) return r;
    const companions = [];
    for (const c of svc.companions || []) {
      const cr = pm.start(c.id, { ...c.run, logTo: id, logPrefix: c.name });
      companions.push({ id: c.id, name: c.name, ok: cr.ok, error: cr.error });
    }
    // 等端口就绪再返回：否则前端刷新看到「未运行」，会把成功重启误判成失败
    const warn = await waitReady(ports, 20000);
    return { ...r, companions, ...(warn ? { warn } : {}) };
  });

  // 一键全部启动：按依赖顺序，每个等端口就绪再起下一个
  ipcMain.handle('svc:startAll', async () => {
    const results = [];
    for (const id of START_ORDER) {
      const svc = buildServiceList().find((x) => x.id === id);
      if (!svc || !svc.startable || pm.isRunning(id)) {
        results.push({ id, ok: false, skipped: true, reason: svc ? svc.blockedReason : '未知' });
        continue;
      }
      // 不只看内存托管表：端口已在监听 = 已有实例在跑（残留/外部启动），复用而非再拉新实例
      if (svc.probePorts.length) {
        const ups = await Promise.all(svc.probePorts.map((p) => probePort(p)));
        if (ups.some(Boolean)) {
          results.push({ id, ok: true, reused: true, message: `${svc.name} 已在运行（端口 ${svc.probePorts.join('/')} 在监听），已复用现有进程` });
          continue;
        }
      }
      const r = pm.start(id, svc.run);
      // 附属服务跟随主服务启动
      for (const c of svc.companions || []) pm.start(c.id, { ...c.run, logTo: id, logPrefix: c.name });
      results.push({ id, ok: r.ok, error: r.error });
      // SnowLuma 等 3000 口就绪；DSH 等它自己的口；bridge 等 3100
      if (r.ok && svc.probePorts.length) {
        const deadline = Date.now() + 45000;
        let up = false;
        while (Date.now() < deadline) {
          const ups = await Promise.all(svc.probePorts.map((p) => probePort(p)));
          if (ups.some(Boolean)) {
            up = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 800));
        }
        if (!up) {
          // 端口超时不追加新记录：更新原启动记录避免前端重复报"未启动"
          const rec = results.find((r) => r.id === id && r.ok);
          if (rec) rec.warn = `${id} 启动后端口未就绪（可能需要扫码登录）`;
          else results.push({ id, ok: false, warn: `${id} 启动后端口未就绪（可能需要扫码登录）` });
        }
      }
    }
    return results;
  });

  ipcMain.handle('svc:stopAll', () => stopAllServices());

  // 配置读写
  ipcMain.handle('config:read', (_e, component) => {
    const d = detectAll();
    if (component === 'qqbridge' && d.qqbridge.dir) {
      const file = path.join(d.qqbridge.dir, 'config.json');
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        return { file, error: '读取失败: ' + e.message };
      }
      return { file, data };
    }
    if (component === 'snowluma' && d.snowluma.dir) {
      const rtFile = path.join(d.snowluma.dir, 'config', 'runtime.json');
      let runtime = {};
      try {
        runtime = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
      } catch {}
      const onebots = listOnebotFiles(d.snowluma.dir).map((f) => {
        try {
          return { file: f, name: path.basename(f), data: JSON.parse(fs.readFileSync(f, 'utf8')) };
        } catch (e) {
          return { file: f, name: path.basename(f), data: {}, error: e.message };
        }
      });
      return { runtimeFile: rtFile, runtime, onebots };
    }
    return { error: '未检测到该组件目录' };
  });

  ipcMain.handle('config:write', (_e, { file, apply }) => {
    // apply: [{ path, value }]，一次性合并写回，减少多次备份
    // 主进程侧校验：只允许写检测到的组件配置文件（qq-bridge config.json / SnowLuma runtime.json / onebot_*.json）
    if (!isAllowedConfigFile(file)) return { ok: false, error: '目标文件不在允许写入的配置范围内' };
    if (!Array.isArray(apply) || !apply.length) return { ok: false, error: '无效的写入请求' };
    for (const item of apply) {
      if (!item || typeof item.path !== 'string') return { ok: false, error: '无效的写入路径' };
    }
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      data = {};
    }
    for (const { path: p, value } of apply) deepSet(data, p, value);
    backupAndWrite(file, data);
    return { ok: true };
  });

  // 下载 / 安装
  ipcMain.handle('dl:install', async (_e, { key, targetDir }) => {
    if (!ALLOW_INSTALL_KEYS.has(key)) return { ok: false, error: '未知的安装组件' };
    if (downloads.get(key)) return { ok: false, error: '该组件正在安装中' };
    downloads.set(key, true);
    try {
      const dir = targetDir || path.join(defaultScanRoot(), key === 'qqbridge' ? 'qq-bridge' : key);
      // 主进程侧校验：安装目标目录必须位于扫描根内，防止任意路径写入
      if (!isUnderScanRoots(dir)) {
        downloads.delete(key);
        return { ok: false, error: '安装目录不在允许范围内（仅限扫描根目录）' };
      }
      await installComponent(key, dir, (msg) => send('dl:step', { key, msg }));
      send('dl:done', { key, ok: true });
      return { ok: true, dir };
    } catch (e) {
      send('dl:done', { key, ok: false, error: e.message });
      return { ok: false, error: e.message };
    } finally {
      downloads.delete(key);
      invalidateDetect(); // 装完新组件立刻重扫
    }
  });

  ipcMain.handle('dl:openPage', async (_e, key) => {
    const url = settings().downloads[key];
    if (!url) return { ok: false, error: '未配置下载地址，请在高级设置里填写' };
    await shell.openExternal(url);
    return { ok: true };
  });

  // 修复：npm install
  ipcMain.handle('fix:npmInstall', async (_e, { dir }) => {
    if (!dir) return { ok: false, error: '目录不存在' };
    const nodeDir = path.join(defaultScanRoot(), 'tools', '_runtime', 'node');
    const nodeExe = path.join(nodeDir, 'node.exe');
    send('dl:step', { key: 'fix', msg: `npm install @ ${dir}` });
    const res = await npmInstall(dir, fs.existsSync(nodeExe) ? nodeDir : '');
    if (res.ok) {
      // 修复成功后兜底补齐 config.json（仓库不含，只有 example）
      const example = path.join(dir, 'config.example.json');
      const target = path.join(dir, 'config.json');
      if (fs.existsSync(example) && !fs.existsSync(target)) {
        try {
          fs.copyFileSync(example, target);
        } catch (e) {}
      }
      invalidateDetect();
    } else {
      res.error = res.error + (res.log && res.log.length ? '\n最近日志：\n' + res.log.slice(-15).join('\n') : '');
    }
    send('dl:done', { key: 'fix', ok: res.ok, error: res.error });
    return res;
  });

  // 设置
  ipcMain.handle('settings:get', () => settings());
  ipcMain.handle('settings:set', (_e, patch) => {
    // 主进程侧白名单 schema 校验：未知字段/非法类型直接丢弃，防止注入恶意 startCommand / 下载地址
    const clean = sanitizeBySchema(patch || {}, SETTINGS_SCHEMA);
    if (!clean || typeof clean !== 'object') return { ok: false, error: '无效的设置内容' };
    const r = updateSettings(clean);
    invalidateDetect(); // 目录变了立刻重扫
    return r;
  });

  // 系统
  ipcMain.handle('pick:dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
  });
  // 打开浏览器：shell.openExternal 失败时（受限环境/关联异常）退回系统 start 命令，
  // 仍失败则把错误返回给前端弹提示，绝不静默
  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (!/^https?:\/\//.test(url)) return { ok: false, error: '非法链接' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      const r = spawnSync('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { windowsHide: true, timeout: 5000 });
      return { ok: r.status === 0, error: r.status !== 0 ? '无法打开浏览器（shell 与 start 均失败）' : '' };
    }
  });
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  // 返回 { packaged, version }：开发版（未打包）不带版本号，渲染层据此隐藏版本行与更新入口
  ipcMain.handle('app:version', () => {
    const packaged = isReleaseBuild();
    return { packaged, version: packaged ? managerVersion() : '' };
  });

  // ---------- 自更新 ----------
  // 更新来源固定为 GitHub Releases（release.yml 在 push 时自动构建发布，tag 形如 "QQ-DSH-Manager vX.X.X"），
  // 不再需要手动填写更新清单地址。
  const MANAGER_RELEASE_API = 'https://api.github.com/repos/Serein1202/QQ-DSH-Manager/releases/latest';
  const MANAGER_RELEASE_PAGE = 'https://github.com/Serein1202/QQ-DSH-Manager/releases/latest';

  // 从网页版 releases/latest 拿到最终 tag URL（不读 body，避免下载整页 HTML）。
  // 这条路不消耗 API 限额，用来在 API 被限流（HTTP 403）时兜底判断「有没有新版本」。
  // 注意 Electron 的 net.fetch 不支持 redirect:'manual'（会抛 "Redirect was cancelled"），
  // 所以这里让它正常跟随跳转，再从 res.url 里取 tag。
  // tag 命名是 "QQ-DSH-Manager-v1.0.10"，前缀不一定以 v 开头，所以只认 /releases/tag/ 之后的部分。
  const TAG_SEG = /\/releases\/tag\/([^/?#]+)/;
  function versionFromTagUrl(url) {
    const m = String(url || '').match(TAG_SEG);
    if (!m) return '';
    const v = m[1].match(/(\d+)\.(\d+)\.(\d+)/);
    return v ? v.slice(1, 4).join('.') : '';
  }

  async function fetchReleaseTagUrl(url) {
    try {
      const { net } = require('electron');
      if (net && typeof net.fetch === 'function') {
        const res = await net.fetch(url, { headers: { 'User-Agent': 'QQ-DSH-Manager/' + managerVersion() } });
        const finalUrl = res.url || '';
        try {
          if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
        } catch {}
        if (TAG_SEG.test(finalUrl)) return finalUrl;
      }
    } catch (e) {
      if (process.env.QDM_DEBUG_UPDATE) console.error('[update] net.fetch(tag) 失败:', e && e.message);
    }
    // 回退：裸 https，不跟随跳转，直接读 302 的 Location
    const https = require('https');
    return new Promise((resolve) => {
      const req = https.get(url, { headers: { 'User-Agent': 'QQ-DSH-Manager/' + managerVersion() } }, (res) => {
        res.resume();
        const loc = res.headers.location || '';
        resolve(TAG_SEG.test(loc) ? loc : '');
      });
      req.on('error', () => resolve(''));
      req.setTimeout(12000, () => { req.destroy(); resolve(''); });
    });
  }


  // GitHub 加速候选：配置了镜像前缀只走镜像；未配置先直连官方，失败自动换内置镜像兜底
  function releaseApiCandidates() {
    const mirror = (settings().githubMirror || '').trim().replace(/\/+$/, '');
    if (mirror) return [mirror + '/' + MANAGER_RELEASE_API];
    return [MANAGER_RELEASE_API, ...GITHUB_MIRRORS.map((m) => m + '/' + MANAGER_RELEASE_API)];
  }

  // 下载 URL 候选（同样规则）：配置镜像只用镜像；否则官方直连失败自动走镜像兜底
  function githubDlCandidates(url) {
    const mirror = (settings().githubMirror || '').trim().replace(/\/+$/, '');
    if (mirror) return [githubMirrorUrl(url, mirror)];
    return [url, ...GITHUB_MIRRORS.map((m) => githubMirrorUrl(url, m))];
  }

  // 拉取 latest release 并解析出版本号与安装包资产（逐个候选源尝试，全失败才抛错）
  // 请求优先走 Chromium 网络栈（net.fetch）：它继承系统代理 / PAC 设置，
  // 而 downloader.js 里的裸 https.get 只支持直连——在必须走代理的网络里直连只会拿到
  // ECONNRESET / 超时，旧实现下表现就是「检查更新失败：read ECONNRESET」。
  // net 不可用（或该 URL 走不通）时再回退到裸 https，保证两种网络环境都能覆盖。
  async function fetchReleaseJson(url) {
    try {
      const { net } = require('electron');
      if (net && typeof net.fetch === 'function') {
        const res = await net.fetch(url, {
          headers: { 'User-Agent': 'QQ-DSH-Manager/' + managerVersion(), Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      }
    } catch (e) {
      // 落到下面用裸 https 再试一次
      if (process.env.QDM_DEBUG_UPDATE) console.error('[update] net.fetch 失败:', e && e.message);
    }
    return fetchJson(url);
  }

  async function fetchManagerRelease() {
    let lastErr = null;
    for (const apiUrl of releaseApiCandidates()) {
      try {
        const m = await fetchReleaseJson(apiUrl);
        const tag = String(m.tag_name || '');
        const ver = (tag.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1, 4).join('.');
        // 解析不出三位版本号就当作这次失败，继续试下一个源。
        // 否则 version='' 会让 cmpVer 全按 0 处理，结果永远是「已是最新」，用户完全看不出异常。
        if (!ver) throw new Error('Release 标签里没有版本号：' + (tag || '(空)'));
        const assets = (m.assets || []).map((a) => ({ name: a.name || '', url: a.browser_download_url || '' }));
        const find = (re) => { const a = assets.find((x) => re.test(x.name)); return a ? a.url : ''; };
        return {
          version: ver,
          installer: find(/\.exe$/i),
          portable: find(/\.zip$/i),
          zip: find(/\.zip$/i),
          page: m.html_url || '',
          notes: m.body || '',
        };
      } catch (e) {
        lastErr = e;
      }
    }
    // 全部 API 源都失败时（最常见原因：未认证 API 限额 60 次/小时/IP，共享出口 IP 很容易打满，
    // 返回 HTTP 403），退回网页版 releases/latest 的 302 跳转，从 Location 里取 tag。
    // 这条路不走 API、没有速率限制，足以判断「有没有新版本」；代价是拿不到资产直链，
    // 前端会退回到打开 Release 页面让用户手动下载。
    try {
      const tagUrl = await fetchReleaseTagUrl(MANAGER_RELEASE_PAGE);
      const ver = versionFromTagUrl(tagUrl);
      if (ver) {
        return { version: ver, installer: '', portable: '', zip: '', page: tagUrl, notes: '' };
      }
    } catch (e) {
      lastErr = lastErr || e;
    }
    throw lastErr || new Error('获取最新版本失败');
  }

  ipcMain.handle('update:check', async () => {
    // 开发版（未打包）不检查更新：源码运行的版本号没有发布语义，
    // 拿它跟 Release 比只会得到「已是最新」或「要更新到比自己旧」的荒唐结论。
    if (!isReleaseBuild()) {
      return { configured: false, packaged: false, ok: false, error: '开发版不支持检查更新' };
    }
    try {
      const rel = await fetchManagerRelease();
      const current = managerVersion();
      const latest = rel.version;
      return {
        configured: true,
        packaged: true,
        ok: true,
        current,
        latest,
        newer: cmpVer(latest, current) > 0,
        installer: rel.installer,
        portable: rel.portable,
        zip: rel.zip,
        page: rel.page,
        notes: rel.notes,
      };
    } catch (e) {
      return { configured: true, packaged: true, ok: false, error: e.message };
    }
  });

  // 下载新版 zip 到固定根目录，解压到 update-new，写替换脚本分离重启（替代直接运行 portable exe：
  // portable 每次解压到 Temp 随机目录无法原地覆盖，导致新旧客户端并存）
  // 收紧：仅允许下载当前 latest release 的资产，扩展名必须是 .zip，执行前弹确认
  // 在解压目录里找主程序 exe（跳过卸载器，最多 2 层）
  function findMainExe(dir, maxDepth) {
    const queue = [[dir, 0]];
    while (queue.length) {
      const [d, depth] = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isFile() && /\.exe$/i.test(e.name) && !/uninstall/i.test(e.name) && /qq-dsh-manager/i.test(e.name)) return full;
        if (e.isDirectory() && depth < maxDepth) queue.push([full, depth + 1]);
      }
    }
    return '';
  }
  ipcMain.handle('update:install', async (_e, { url }) => {
    // 开发版没有可替换的安装目录，直接拒绝，避免半路写坏 update-new
    if (!isReleaseBuild()) return { ok: false, error: '开发版不支持自动更新' };
    try {
      const rel = await fetchManagerRelease();
      const allowed = [rel.zip, rel.installer, rel.portable].filter(Boolean);
      if (!url || !allowed.includes(url)) return { ok: false, error: '仅允许下载官方 Release 资产' };
      let destPath = '';
      try {
        destPath = new URL(url).pathname;
      } catch {
        return { ok: false, error: '无效的下载地址' };
      }
      if (!/\.zip$/i.test(destPath) && !/\.zip\?/i.test(url)) return { ok: false, error: '更新包必须是 .zip 文件' };
      const ans = await dialog.showMessageBox({
        type: 'warning',
        title: '确认安装更新',
        message: `即将下载更新包并替换当前版本：\n${url}\n\n确认继续？`,
        buttons: ['确认下载并更新', '取消'],
        cancelId: 1,
        defaultId: 0,
      });
      if (ans.response !== 0) return { ok: false, error: '已取消更新' };
      const root = defaultScanRoot();
      const zipDest = path.join(root, 'cm-update.zip');
      const stage = path.join(root, 'update-new');
      // 多源回退：直连失败自动切镜像；网络中断时 .part 保留，换源后从断点继续
      let lastErr = null;
      for (const dlUrl of githubDlCandidates(url)) {
        try {
          await downloadFile(dlUrl, zipDest, (r, t) => send('dl:progress', { key: 'update', received: r, total: t }));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) throw lastErr;
      fs.rmSync(stage, { recursive: true, force: true });
      unzip(zipDest, stage);
      fs.rmSync(zipDest, { force: true });
      // 若解压后顶层只有一层目录（如 win-unpacked），提升其内容到 stage 顶层，保证 exe 落在固定根
      const topDirs = fs.readdirSync(stage, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      if (topDirs.length === 1 && !findMainExe(stage, 0) && findMainExe(path.join(stage, topDirs[0].name), 1)) {
        const inner = path.join(stage, topDirs[0].name);
        for (const e of fs.readdirSync(inner, { withFileTypes: true })) {
          fs.renameSync(path.join(inner, e.name), path.join(stage, e.name));
        }
        fs.rmdirSync(inner);
      }
      const exe = findMainExe(stage, 2);
      if (!exe) throw new Error('更新包内未找到 QQ-DSH-Manager.exe');
      const relPath = path.relative(stage, exe).split(path.sep).join('\\');
      // 替换脚本：等旧进程退出 -> 强制结束残留同名单进程 -> 把 update-new 内容并入固定根 -> 启动新版 -> 自删
      const bat = path.join(root, 'cm-apply-update.bat');
      const batContent = [
        '@echo off',
        'timeout /t 2 /nobreak >nul',
        'taskkill /f /im QQ-DSH-Manager.exe >nul 2>&1',
        'xcopy /e /y /q "%~dp0update-new\\*" "%~dp0" >nul',
        'rmdir /s /q "%~dp0update-new"',
        'start "" "%~dp0' + relPath + '"',
        'del "%~f0"',
      ].join('\r\n');
      fs.writeFileSync(bat, batContent, 'utf8');
      spawn('cmd.exe', ['/d', '/s', '/c', bat], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 800);
      return { ok: true, file: exe, relaunch: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // SnowLuma 扫码提示：打开其目录里的 launcher.bat 由用户扫码（首次登录用）
  ipcMain.handle('snowluma:launchScan', async () => {
    const d = detectAll();
    if (!d.snowluma.dir) return { ok: false, error: '未检测到 SnowLuma' };
    const launcher = path.join(d.snowluma.dir, 'launcher.bat');
    if (fs.existsSync(launcher)) {
      await shell.openPath(launcher);
      return { ok: true };
    }
    return { ok: false, error: '未找到 launcher.bat' };
  });

  // 退出时按设置清理：崩溃自动重启（连续失败退避 + 恢复附属服务）
  pm.onExit = (id) => {
    flushLogs(); // 先推残余日志，渲染层才能看到「进程退出」这一行
    send('proc:exit', { id });
    const auto = settings().autoRestart;
    if (!auto || !auto[id]) return;
    const svc = buildServiceList().find((x) => x.id === id);
    if (!svc || !svc.startable) return;

    // 连续崩溃保护：60s 窗口内第 3 次崩溃就停止重启，避免秒崩服务无限循环
    const now = Date.now();
    const s = pm.restartStats.get(id);
    if (!s || now - s.windowStart > 60000) {
      pm.restartStats.set(id, { count: 1, windowStart: now });
    } else {
      s.count += 1;
      if (s.count >= 3) {
        send('proc:log', { id, line: `[${new Date().toLocaleTimeString()}] 连续崩溃 ${s.count} 次，已停止自动重启` });
        return;
      }
    }
    const st = pm.restartStats.get(id);
    const delay = Math.min(3000 * Math.pow(2, st.count - 1), 15000); // 3s → 6s → 12s 退避
    setTimeout(() => {
      const r = pm.start(id, svc.run);
      if (!r.ok) send('proc:log', { id, line: `[${new Date().toLocaleTimeString()}] 自动重启失败: ${r.error}` });
      // 附属服务（qq-bridge 的手机 MCP / QQ 空间）随主服务一起恢复
      for (const c of svc.companions || []) {
        pm.start(c.id, { ...c.run, logTo: id, logPrefix: c.name });
      }
    }, delay);
  };
}

module.exports = { registerIpc, pm, stopAllServices, stopAllServicesSync };
