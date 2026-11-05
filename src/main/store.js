// store.js — 全局设置读写（userData/settings.json），含默认值合并与原子写入
'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// 各下载源默认值。snowluma / dsh 默认官网地址（网页跳转），用户可在"高级设置"里覆盖；
// 填了 zip 直链就自动下载解压，只填网页地址就跳浏览器。
// qq-bridge 仓库是源码包（archive/refs/heads/main.zip），GitHub 直连在国内基本拿不到，
// 所以默认地址直接套 gh-proxy.org 前缀；用户可以在高级设置里换成自己的镜像或直连。
const QQBRIDGE_DEFAULT = 'https://gh-proxy.org/https://github.com/Serein1202/qq-bridge/archive/refs/heads/main.zip';
// 旧版默认地址：只用来识别「用户没改过」，命中就迁移到新地址（用户自己填过的绝不动）
const QQBRIDGE_LEGACY = 'https://github.com/Serein1202/qq-bridge/archive/refs/heads/main.zip';

const DEFAULT_DOWNLOADS = {
  snowluma: 'https://github.com/SnowLuma/SnowLuma/releases',
  dsh: 'https://www.deepseek.com/harness/',
  qqbridge: QQBRIDGE_DEFAULT,
  node: 'https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-win-x64.zip',
};

const DEFAULT_SETTINGS = {
  // 组件目录：留空则自动扫描 scanRoot
  components: {
    snowluma: { dir: '' },
    dsh: { dir: '', startCommand: '', port: 3080, workspace: '' },
    qqbridge: { dir: '' },
  },
  downloads: { ...DEFAULT_DOWNLOADS },
  // 扫描根目录：packaged 模式默认 exe 所在目录；dev 模式默认项目上两级
  scanRoot: '',
  // 关闭软件时是否停掉所有由本软件拉起的服务
  closeStopServices: false,
  // 子进程崩溃后是否自动重启（每服务可覆盖）
  autoRestart: { snowluma: false, dsh: false, qqbridge: false },
  // GitHub 加速镜像前缀（留空=官方直连，失败自动走内置镜像兜底；如 https://ghfast.top）
  githubMirror: '',
};

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!extra || typeof extra !== 'object') return out;
  for (const k of Object.keys(extra)) {
    const v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadSettings() {
  let out;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    out = deepMerge(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  // 迁移 qq-bridge 默认下载地址。deepMerge 会让老 settings.json 里的旧值一直生效，
  // 只改 DEFAULT_DOWNLOADS 对已装过的机器等于没改。
  // 仅当值恰好等于旧默认值时才替换 —— 那是「用户从没改过」的唯一可靠标志，
  // 用户自己填的镜像/直连原样保留。
  try {
    if (out && out.downloads && out.downloads.qqbridge === QQBRIDGE_LEGACY) {
      out.downloads.qqbridge = QQBRIDGE_DEFAULT;
    }
  } catch { /* 结构异常就算了，不影响主流程 */ }
  return out;
}

function saveSettings(settings) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原子写：先写临时文件再替换，防止写一半损坏
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return settings;
}

// 判断路径是否位于系统临时目录（兼容 8.3 短名 / 环境变量形式）：
// 1) 与 os.tmpdir() 前缀一致；2) 兜底：路径含 <...>\AppData\Local\Temp 段
function isInSystemTemp(p) {
  const os = require('os');
  const l = path.resolve(p).toLowerCase();
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  if (l === tmp || l.startsWith(tmp + path.sep)) return true;
  return /appdata[\\/]local[\\/]temp([\\/]|$)/.test(l);
}

// 计算默认根目录：
// - dev 模式：项目上两级（源码仓库根）
// - packaged 模式：exe 所在目录；但若 exe 位于系统临时目录（安装器解压运行 /
//   便携版放 Temp），临时目录随机、重启会变、还会把更新残留扫进来，不能当持久根，
//   回退到用户主目录下的固定数据目录。已配置 scanRoot 的用户不受影响（始终优先）。
function defaultRootDir() {
  if (!app.isPackaged) return path.resolve(__dirname, '../../..');
  const exeDir = path.dirname(app.getPath('exe'));
  return isInSystemTemp(exeDir) ? path.join(os.homedir(), 'QQ-DSH-Manager') : exeDir;
}

function defaultScanRoot() {
  if (settings().scanRoot) return settings().scanRoot;
  return defaultRootDir();
}

// 多根目录扫描：默认根 → exe 目录 → 上级 → 桌面 → 用户目录，逐个尝试，命中即停
// （exe 在 Temp 时不加入 exe 目录/上级，否则整个 Temp 都被当扫描根）
function scanRoots() {
  const os = require('os');
  const roots = [];
  const s = settings();
  if (s.scanRoot) roots.push(s.scanRoot);
  roots.push(defaultRootDir());
  if (app.isPackaged) {
    const exeDir = path.dirname(app.getPath('exe'));
    if (!isInSystemTemp(exeDir)) roots.push(exeDir, path.dirname(exeDir));
  } else {
    roots.push(path.resolve(__dirname, '../../..'));
  }
  roots.push(path.join(os.homedir(), 'Desktop'));
  roots.push(os.homedir());
  const seen = new Set();
  return roots.filter((r) => {
    if (!r || seen.has(r)) return false;
    seen.add(r);
    return true;
  });
}

let cached = null;
function settings() {
  if (!cached) cached = loadSettings();
  return cached;
}
function updateSettings(patch) {
  cached = deepMerge(cached || loadSettings(), patch);
  saveSettings(cached);
  return cached;
}
function resetCache() {
  cached = null;
}

module.exports = { settings, updateSettings, resetCache, defaultScanRoot, scanRoots, DEFAULT_DOWNLOADS };
