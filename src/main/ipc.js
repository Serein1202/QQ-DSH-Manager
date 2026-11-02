// ipc.js — 主进程 IPC 路由：检测 / 服务 / 配置 / 下载 / 设置 / Shell
'use strict';
const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { settings, updateSettings, defaultScanRoot, scanRoots } = require('./store');
const { detectAll, invalidateDetect, findNode } = require('./detect');
const { ProcessManager, probePort } = require('./procs');
const { buildServiceList, START_ORDER } = require('./services');
const { downloadFile, unzip, npmInstall, fetchJson } = require('./downloader');

const pm = new ProcessManager();
const downloads = new Map(); // key -> { running: true } 防重复下载

function send(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

pm.onLog = (id, line) => send('proc:log', { id, line });
pm.onExit = (id) => send('proc:exit', { id });

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
  // 检测
  ipcMain.handle('detect:all', () => detectAll());

  // 服务列表 + 状态（全部探活并发，单个 600ms 超时，5 个服务最坏 ~0.6s 出全量结果）
  ipcMain.handle('svc:list', async () => {
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
        const alive = pm.isRunning(svc.id) || (svc.probePorts.length > 0 && Object.values(ports).some(Boolean));
        return {
          id: svc.id,
          name: svc.name,
          desc: svc.desc,
          running: !!alive,
          managed: pm.isRunning(svc.id),
          ports,
          startable: svc.startable,
          blockedReason: svc.blockedReason,
          companionHint: svc.companionHint || '',
          webLinks: svc.webLinks.map((l) => ({ ...l, open: !!ports[l.port] })),
        };
      })
    );
    return out;
  });

  ipcMain.handle('svc:start', async (_e, id) => {
    const svc = buildServiceList().find((x) => x.id === id);
    if (!svc) return { ok: false, error: '未知服务' };
    if (!svc.startable) return { ok: false, error: svc.blockedReason || '无法启动' };
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
    return { ...r, companions };
  });

  ipcMain.handle('svc:stop', async (_e, id) => {
    const svc = buildServiceList().find((x) => x.id === id);
    // 先停附属服务，再停主服务（顺序反了容易留孤儿进程）
    for (const c of (svc && svc.companions) || []) pm.stop(c.id);
    return pm.stop(id, svc ? svc.probePorts : [], svc ? svc.run.cwd : '');
  });
  ipcMain.handle('svc:logs', (_e, id) => pm.getLogs(id));

  ipcMain.handle('svc:restart', async (_e, id) => {
    const svc = buildServiceList().find((x) => x.id === id);
    for (const c of (svc && svc.companions) || []) pm.stop(c.id);
    // 不再无条件信任 stop 结果：停止失败直接中止重启，禁止继续 start，避免叠加新实例
    const stopR = pm.stop(id, svc ? svc.probePorts : [], svc ? svc.run.cwd : '', { verify: (svc && svc.run.verify) || [] });
    if (!stopR.ok) {
      return { ok: false, error: `停止失败，已中止重启：${stopR.error || '未知错误'}` };
    }
    // 等端口真正释放（DSH 这类 GUI 程序退出较慢，固定 1.2s 常常没退干净就重启 → 抢端口失败）
    const ports = (svc && svc.probePorts) || [];
    const deadline = Date.now() + 10000;
    while (ports.length && Date.now() < deadline) {
      const ups = await Promise.all(ports.map((p) => probePort(p, '127.0.0.1', 400)));
      if (!ups.some(Boolean)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!svc || !svc.startable) return { ok: false, error: (svc && svc.blockedReason) || '无法启动' };
    // 等端口释放循环超时后端口仍被占用：旧实例未退净，直接启动会再叠加实例，报错中止
    const stillUp = await Promise.all(ports.map((p) => probePort(p, '127.0.0.1', 400)));
    if (ports.length && stillUp.some(Boolean)) {
      return { ok: false, error: `端口 ${ports.join('/')} 在停止后仍未释放，已中止重启以避免残留多实例` };
    }
    const r = pm.start(id, svc.run);
    for (const c of svc.companions || []) pm.start(c.id, { ...c.run, logTo: id, logPrefix: c.name });
    return r;
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

  ipcMain.handle('svc:stopAll', () => {
    // 传入每个服务的探活端口 + 工作目录 + 身份特征：非托管（用户手动开的）服务也能停掉，且不误杀
    const portsById = {};
    const cwdById = {};
    const optsById = {};
    for (const svc of buildServiceList()) {
      portsById[svc.id] = svc.probePorts;
      cwdById[svc.id] = svc.run.cwd || '';
      optsById[svc.id] = { verify: svc.run.verify || [] };
    }
    return pm.stopAll(portsById, cwdById, optsById);
  });

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
  ipcMain.handle('app:version', () => app.getVersion());

  // ---------- 自更新 ----------
  // 更新来源固定为 GitHub Releases（release.yml 在 push 时自动构建发布，tag 形如 "QQ-DSH-Manager vX.X.X"），
  // 不再需要手动填写更新清单地址。
  const MANAGER_RELEASE_API = 'https://api.github.com/repos/Serein1202/QQ-DSH-Manager/releases/latest';

  // 拉取 latest release 并解析出版本号与安装包资产
  async function fetchManagerRelease() {
    const m = await fetchJson(MANAGER_RELEASE_API);
    const tag = String(m.tag_name || '');
    const ver = (tag.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1, 4).join('.');
    const assets = (m.assets || []).map((a) => ({ name: a.name || '', url: a.browser_download_url || '' }));
    const find = (re) => { const a = assets.find((x) => re.test(x.name)); return a ? a.url : ''; };
    return {
      version: ver,
      installer: find(/\.exe$/i),
      portable: find(/\.zip$/i),
      page: m.html_url || '',
      notes: m.body || '',
    };
  }

  ipcMain.handle('update:check', async () => {
    try {
      const rel = await fetchManagerRelease();
      const current = app.getVersion();
      const latest = rel.version;
      return {
        configured: true,
        ok: true,
        current,
        latest,
        newer: cmpVer(latest, current) > 0,
        installer: rel.installer,
        portable: rel.portable,
        page: rel.page,
        notes: rel.notes,
      };
    } catch (e) {
      return { configured: true, ok: false, error: e.message };
    }
  });

  // 下载新版安装包到临时目录，下载完自动运行（NSIS 安装器会自己接管）
  // 收紧：仅允许下载当前 latest release 的资产，扩展名必须是 .exe，打开前弹确认
  ipcMain.handle('update:install', async (_e, { url }) => {
    try {
      const rel = await fetchManagerRelease();
      const allowed = [rel.installer, rel.portable].filter(Boolean);
      if (!url || !allowed.includes(url)) return { ok: false, error: '仅允许下载官方 Release 资产' };
      let destPath = '';
      try {
        destPath = new URL(url).pathname;
      } catch {
        return { ok: false, error: '无效的下载地址' };
      }
      if (!/\.exe$/i.test(destPath) && !/\.exe\?/i.test(url)) return { ok: false, error: '安装包必须是 .exe 文件' };
      const ans = await dialog.showMessageBox({
        type: 'warning',
        title: '确认安装更新',
        message: `即将下载并运行更新安装包：\n${url}\n\n确认继续？`,
        buttons: ['确认下载并运行', '取消'],
        cancelId: 1,
        defaultId: 0,
      });
      if (ans.response !== 0) return { ok: false, error: '已取消更新' };
      const name = path.basename(destPath) || 'update-installer.exe';
      const dest = path.join(os.tmpdir(), 'cm-update-' + name);
      await downloadFile(url, dest, (r, t) => send('dl:progress', { key: 'update', received: r, total: t }));
      const err = shell.openPath(dest);
      if (err) return { ok: false, error: err };
      return { ok: true, file: dest };
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

module.exports = { registerIpc, pm };
