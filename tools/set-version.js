// tools/set-version.js — 把版本号写进 package.json / package-lock.json
//
// 用法：node tools/set-version.js 1.2.3
//
// 为什么不用 `npm version <ver> --no-git-tag-version`：
// 当 package.json 里的版本已经等于目标版本时，npm 10 会直接报错退出：
//     npm error Version not changed
// CI 的版本号来源是 max(最新 tag + 1, package.json 的 version)。仓库里手动把版本写成
// 1.1.0、最新 Release 还是 1.0.10 时，两者取大正好等于 1.1.0 —— 于是 npm version 报
// Version not changed，整条 Release 流水线在「同步版本号」这一步就挂了（run #10 实测）。
// 这里改成幂等写入：相同就跳过，不同才改。
//
// 同时同步 package-lock.json 的两处根版本（.version 与 .packages[""].version）：
// npm version 会一起改，手工改 package.json 不改 lock 会让 `npm ci` 之后的 lock 与
// package.json 版本不一致。只动这两处，其它依赖的版本号一律不碰。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function die(msg) {
  console.error('set-version: ' + msg);
  process.exit(1);
}

const target = String(process.argv[2] || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(target)) die(`版本号必须是三段式 x.y.z，收到：${JSON.stringify(target)}`);

const pkgPath = path.join(ROOT, 'package.json');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (e) {
  die('读不到 package.json：' + e.message);
}

const before = String(pkg.version || '');
const changed = before !== target;
if (changed) {
  pkg.version = target;
  // 保持 2 空格缩进 + 结尾换行，避免 diff 噪音
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}
console.log(`package.json: ${before || '(空)'} -> ${changed ? target : target + '（未变化）'}`);

// ---- package-lock.json（没有就跳过，不报错）----
const lockPath = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (e) {
    die('package-lock.json 解析失败：' + e.message);
  }
  let lockChanged = false;
  if (typeof lock.version === 'string' && lock.version !== target) {
    lock.version = target;
    lockChanged = true;
  }
  const rootPkg = lock.packages && lock.packages[''];
  if (rootPkg && typeof rootPkg === 'object' && rootPkg.version !== target) {
    rootPkg.version = target;
    lockChanged = true;
  }
  if (lockChanged) {
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  }
  console.log(`package-lock.json: ${lockChanged ? '已同步为 ' + target : '已是 ' + target + '（未变化）'}`);
} else {
  console.log('package-lock.json: 不存在，跳过');
}

// 输出给 shell 用（CI 里方便直接读）
console.log('version=' + target);
