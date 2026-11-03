// detect.js — 环境检测：Node / SnowLuma / DSH / qq-bridge
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { settings, defaultScanRoot, scanRoots } = require('./store');

// 扫描时跳过的重目录（避免扫到 AppData / 系统目录拖慢检测）
const SKIP_DIRS = new Set([
  '$recycle.bin', 'appdata', 'windows', 'program files', 'program files (x86)',
  'programdata', 'node_modules', 'system volume information', 'temp',
]);

// 判断路径是否位于系统临时目录（兼容 8.3 短名 / 环境变量形式）：
// 1) 与 os.tmpdir() 前缀一致；2) 兜底：路径含 <...>\AppData\Local\Temp 段。
// discoverDir 直接跳过临时目录整棵子树，避免把更新器残留、解压缓存误当安装本体。
function isSystemTempPath(p) {
  const l = path.resolve(p).toLowerCase();
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  if (l === tmp || l.startsWith(tmp + path.sep)) return true;
  return /appdata[\\/]local[\\/]temp([\\/]|$)/.test(l);
}

// SnowLuma 更新器会往系统 Temp 解压 snowluma-update-* 临时目录，那不是安装本体
const SNOW_EXCLUDE = /snowluma-update-/i;

// 在 root 下按关键词模糊匹配组件目录：BFS 最多 2 层，收集全部命中
function discoverDir(root, keywords) {
  const hits = [];
  if (!isDir(root)) return hits;
  if (isSystemTempPath(root)) return hits;
  const queue = [[root, 0]];
  while (queue.length) {
    const [dir, depth] = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name.toLowerCase();
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, e.name);
      if (keywords.some((kw) => name.includes(kw))) hits.push(full);
      if (depth < 2) queue.push([full, depth + 1]);
    }
  }
  return hits;
}

// 跨所有扫描根收集候选；exclude 命中路径则剔除（防误报）
function discoverMatches(keywords, exclude) {
  const hits = [];
  for (const root of scanRoots()) {
    for (const hit of discoverDir(root, keywords)) {
      if (!(exclude && exclude.test(hit))) hits.push(hit);
    }
  }
  return hits;
}

// 多候选时优先选通过 validator 的（如 node_modules 完整），否则取第一个
function pickDir(hits, validator) {
  if (!hits.length) return '';
  if (validator) {
    const good = hits.find(validator);
    if (good) return good;
  }
  return hits[0];
}

function componentDir(key, keywords, validator, exclude) {
  const conf = settings().components[key] || {};
  if (conf.dir && isDir(conf.dir)) return conf.dir;
  return pickDir(discoverMatches(keywords, exclude), validator);
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// 找可用的 node.exe：优先组件内（extraDir）→ 便携版 → 系统 PATH。
// 注意：SnowLuma 自带 node 未加入 PATH，不能用于管理器的 npm install，不作为候选
function findNode(extraDir) {
  const candidates = [];
  if (extraDir) candidates.push(path.join(extraDir, 'node.exe'));
  const root = defaultScanRoot();
  candidates.push(path.join(root, 'tools', '_runtime', 'node', 'node.exe'));
  candidates.push(path.join(root, '_runtime', 'node', 'node.exe'));
  for (const c of candidates) {
    if (exists(c)) return { path: c, bundled: true };
  }
  try {
    const r = spawnSync('where', ['node'], { encoding: 'utf8' });
    if (r.status === 0) {
      const first = (r.stdout || '').split(/\r?\n/).find(Boolean);
      if (first && exists(first.trim())) return { path: first.trim(), bundled: false };
    }
  } catch {}
  return { path: '', bundled: false };
}

function nodeVersion(nodePath) {
  try {
    const r = spawnSync(nodePath, ['-v'], { encoding: 'utf8' });
    if (r.status === 0) return (r.stdout || '').trim().replace(/^v/, '');
  } catch {}
  return '';
}

function versionOk(v, minMajor, minMinor = 0) {
  const m = /^(\d+)\.(\d+)/.exec(v || '');
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > minMajor || (maj === minMajor && min >= minMinor);
}

// detectAll 结果缓存 15s：svc:list 每 2.5s 轮询一次，不能每次都全盘扫磁盘
let _cache = null;
let _cacheAt = 0;
function detectAll() {
  if (_cache && Date.now() - _cacheAt < 15000) return _cache;
  _cache = detectAllImpl();
  _cacheAt = Date.now();
  return _cache;
}
function invalidateDetect() {
  _cache = null;
}

function detectAllImpl() {
  const s = settings();
  const roots = scanRoots();

  // ---- qq-bridge（先找它：它的 config.json 里有 SnowLuma homeDir 线索）----
  const qbDir =
    componentDir('qqbridge', ['qq-bridge', 'qqbridge'], (d) => isDir(path.join(d, 'node_modules'))) ||
    componentDir('qqbridge', ['qq-bridge', 'qqbridge']);
  const qbEntry = qbDir ? path.join(qbDir, 'src', 'bridge.js') : '';
  const qbNodeMods = qbDir ? path.join(qbDir, 'node_modules') : '';
  const qbCfg = qbDir ? path.join(qbDir, 'config.json') : '';
  let qbHomeDirHint = '';
  if (qbCfg && exists(qbCfg)) {
    try {
      qbHomeDirHint = JSON.parse(fs.readFileSync(qbCfg, 'utf8'))?.snowluma?.homeDir || '';
    } catch {}
  }

  // ---- SnowLuma ----
  const snowDir =
    componentDir('snowluma', ['snowluma'], (d) => exists(path.join(d, 'index.mjs')), SNOW_EXCLUDE) ||
    componentDir('snowluma', ['snowluma'], null, SNOW_EXCLUDE) ||
    (isDir(qbHomeDirHint) ? qbHomeDirHint : '');
  const snowEntry = snowDir ? path.join(snowDir, 'index.mjs') : '';
  const snowNodeExe = snowDir ? path.join(snowDir, 'node.exe') : '';
  const snowNode = exists(snowNodeExe) ? snowNodeExe : findNode(snowDir ? '' : '').path;
  const snowNodeVer = snowNode ? nodeVersion(snowNode) : '';

  // ---- DSH ----
  // 目录名含关键词不算安装：残留目录（卸载未删净）也会命中，必须校验 exe / app.asar 存在
  const dshConf = s.components.dsh || {};
  const dshCands = discoverMatches(['dsh', 'deepseek', 'harness'], /qq-bridge/i).filter(
    (d) => findDshExe(d) || exists(path.join(d, 'resources', 'app.asar'))
  );
  const dshDir = (dshConf.dir && isDir(dshConf.dir)) ? dshConf.dir : dshCands[0] || '';
  const dshPort = dshConf.port || 3080;
  const dshLaunch = findDshLaunch(dshDir, dshConf.workspace, dshConf.cliDir);

  // 管理器可用的 node：只认便携版 / 系统 PATH 的 node（SnowLuma 自带 node 未加 PATH，
  // 不能用于管理器的 npm install；snowNode 仅供 SnowLuma 卡片展示自身运行时信息）
  const nodeUsed = findNode().path;
  const nodeState = nodeUsed
    ? versionOk(nodeVersion(nodeUsed), 22, 13)
      ? 'ok'
      : 'warn' // 版本太老
    : 'missing';

  return {
    scanRoots: roots,
    scanRoot: roots[0] || '',
    node: {
      state: nodeState,
      path: nodeUsed,
      version: nodeUsed ? nodeVersion(nodeUsed) : '',
      need: '>=22.13（便携版或系统 Node 均可）',
    },
    snowluma: {
      state: snowDir && exists(snowEntry) ? 'ok' : snowDir ? 'warn' : 'missing',
      dir: snowDir,
      entry: snowEntry,
      node: snowNode,
      nodeVersion: snowNodeVer,
      detail: !snowDir
        ? '未找到目录'
        : exists(snowEntry)
          ? `node ${snowNodeVer || '未知'}`
          : '目录存在但缺 index.mjs',
    },
    dsh: {
      state: dshDir && dshLaunch.exe ? 'ok' : dshDir ? 'warn' : 'missing',
      dir: dshDir,
      port: dshPort,
      startCommand: dshConf.startCommand || '',
      exe: dshLaunch.exe,
      cli: dshLaunch.cli,
      cliReal: dshLaunch.cliReal,
      cliDir: dshConf.cliDir || '',
      workspace: dshLaunch.workspace,
      detail: !dshDir
        ? '未找到目录（官网下载后，请在"高级设置"里指定目录）'
        : !dshLaunch.exe
          ? '目录存在但未找到可执行文件（可能已卸载或安装不完整，建议重装 DSH）'
          : dshLaunch.cli
            ? `dsh web · ${dshLaunch.workspace}` + (dshLaunch.cliReal ? '' : '（CLI 在 app.asar 内，插件市场更新会失败）')
            : '已安装，但未找到 dsh CLI（app.asar 缺失，建议重装 DSH）',
    },
    qqbridge: {
      state:
        qbDir && exists(qbEntry) && isDir(qbNodeMods) && exists(qbCfg)
          ? 'ok'
          : qbDir && exists(qbEntry)
            ? 'warn'
            : 'missing',
      dir: qbDir,
      entry: qbEntry,
      detail: !qbDir
        ? '未找到目录'
        : !exists(qbCfg)
          ? '缺 config.json（可在配置页自动生成）'
          : !isDir(qbNodeMods)
            ? '缺 node_modules，点"修复"自动 npm install'
            : '依赖完整',
    },
  };
}

// 找 DSH 可执行文件：标准安装位置 → dsh.dir 下的 exe（一层）
function findDshExe(dshDir) {
  const os = require('os');
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  if (dshDir) {
    try {
      for (const f of fs.readdirSync(dshDir)) {
        if (f.toLowerCase().endsWith('.exe') && !f.startsWith('Uninstall')) candidates.push(path.join(dshDir, f));
      }
    } catch {}
  }
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return '';
}

// 解析 DSH 的启动三件套：exe、dsh CLI 入口、workspace 根目录。
// 为什么不能直接双击 exe：桌面 exe 起的是 `desktop` profile（只有 GUI，不监听端口）；
// qq-bridge 需要的 3080 属于 `web` profile（web-server 插件），必须用 CLI 跑 `dsh web`。
// CLI 入口在 app.asar 内，普通 node 读不了 asar，所以用 Electron 本体 + ELECTRON_RUN_AS_NODE=1 执行。
//
// 为什么优先用磁盘上的真实 CLI 副本：dshmarket（DSH 插件市场）更新插件时会 spawn 子进程，
// 并把 cwd 设成 CLI 入口所在目录。app.asar 内的路径是 Electron 的虚拟路径，操作系统无法
// chdir 进去，CreateProcess 直接 ENOENT，表现为「更新失败 + 更新前的构建未能验证恢复」。
// 用真实磁盘路径当入口，子进程的 cwd 才成立。
function findDshLaunch(dshDir, workspaceOverride, cliDirOverride) {
  const os = require('os');
  const exe = findDshExe(dshDir);
  const out = { exe, cli: '', workspace: '', cliReal: false };
  if (!exe) return out;

  const root = path.dirname(exe);
  const cliRel = path.join('dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  // 1) 磁盘上的真实副本（高级设置可改目录；默认 ~/.dsh/desktop-cli）
  const externalDirs = [cliDirOverride, path.join(os.homedir(), '.dsh', 'desktop-cli')].filter(Boolean);
  for (const dir of externalDirs) {
    const p = path.join(dir, cliRel);
    if (exists(p)) {
      out.cli = p;
      out.cliReal = true;
    }
  }
  // 2) 解包目录（存在即说明被解包过） 3) 退回 asar 内路径（能启动，但市场更新会 ENOENT）
  if (!out.cli) {
    const dirCli = path.join(root, 'resources', 'app', cliRel);
    const asarCli = path.join(root, 'resources', 'app.asar', cliRel);
    // Electron 主进程的 fs 补丁能判断 asar 内路径；纯 node 环境判断不了，退回判断 app.asar 本体
    if (exists(asarCli) || exists(path.join(root, 'resources', 'app.asar'))) out.cli = asarCli;
    else if (exists(dirCli)) out.cli = dirCli;
  }
  if (!out.cli) return out;

  // workspace：用户指定 > ~/Documents/deepseek-harness（DSH 默认工作区）> 用户目录
  const candidates = [workspaceOverride, path.join(os.homedir(), 'Documents', 'deepseek-harness'), os.homedir()];
  for (const c of candidates) {
    if (c && isDir(c)) {
      out.workspace = c;
      break;
    }
  }
  return out;
}

module.exports = { detectAll, invalidateDetect, findDshExe, findDshLaunch, findNode, nodeVersion, versionOk, discoverDir, exists, isDir };
