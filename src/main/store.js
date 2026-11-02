// store.js — 全局设置读写（userData/settings.json），含默认值合并与原子写入
'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// 各下载源默认值。snowluma / dsh 默认官网地址（网页跳转），用户可在"高级设置"里覆盖；
// 填了 zip 直链就自动下载解压，只填网页地址就跳浏览器。
const DEFAULT_DOWNLOADS = {
  snowluma: 'https://github.com/SnowLuma/SnowLuma/releases',
  dsh: 'https://www.deepseek.com/harness/',
  qqbridge: 'https://github.com/Serein1202/qq-bridge/archive/refs/heads/main.zip',
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
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    return deepMerge(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
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

function defaultScanRoot() {
  if (settings().scanRoot) return settings().scanRoot;
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  return path.resolve(__dirname, '../../..');
}

// 多根目录扫描：exe 目录 → 上级 → 桌面 → 用户目录，逐个尝试，命中即停
function scanRoots() {
  const os = require('os');
  const roots = [];
  const s = settings();
  if (s.scanRoot) roots.push(s.scanRoot);
  if (app.isPackaged) {
    const exeDir = path.dirname(app.getPath('exe'));
    roots.push(exeDir, path.dirname(exeDir));
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
