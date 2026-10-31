#!/usr/bin/env node
/**
 * 把 DSH 的 dsh CLI 从 app.asar 里完整提取到磁盘真实目录。
 *
 * 为什么需要它：
 * DSH 插件市场（dshmarket）在更新插件时会 spawn 一个子进程，并把子进程的 cwd
 * 设成 CLI 入口（bin.js）所在目录。app.asar 内的路径是 Electron 的虚拟路径，
 * 操作系统无法 chdir 进去，CreateProcess 直接失败并报
 *     spawn <DeepSeek Harness.exe> ENOENT
 * 界面上的表现就是「更新失败，且更新前的构建未能验证恢复」。
 * 把 CLI 放到磁盘真实路径上，市场才能正常更新/回滚。
 *
 * DSH 每次大版本升级后 app.asar 会变，重跑一次本脚本即可。
 *
 * 用法：
 *   node tools/extract-dsh-cli.js
 *   node tools/extract-dsh-cli.js --asar "C:\path\to\resources\app.asar" --out "C:\path\to\desktop-cli"
 *   node tools/extract-dsh-cli.js --dsh-dir "C:\Users\me\AppData\Local\Programs\DeepSeek Harness"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const pick = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};

const CLI_REL = path.join('dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DEFAULT_DSH_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
const DEFAULT_OUT = path.join(os.homedir(), '.dsh', 'desktop-cli');

const dshDir = pick('--dsh-dir') || DEFAULT_DSH_DIR;
const asar = pick('--asar') || path.join(dshDir, 'resources', 'app.asar');
const out = path.resolve(pick('--out') || DEFAULT_OUT);

if (!fs.existsSync(asar)) {
  console.error(`找不到 app.asar：${asar}`);
  console.error('用 --asar 指定路径，或用 --dsh-dir 指定 DSH 安装目录。');
  process.exit(1);
}

const tmp = path.join(os.tmpdir(), `dsh-cli-extract-${Date.now()}`);
const unpacked = path.join(tmp, 'app');

console.log(`源：${asar}`);
console.log(`目标：${path.join(out, 'dsh')}`);

try {
  fs.mkdirSync(tmp, { recursive: true });
  // asar 自带的 extract 会把整个包铺开（几百 MB 的小文件），把 dsh 子树整棵搬走最快
  const { execFileSync } = require('child_process');
  console.log('解包中（约 30 秒，取决于磁盘）…');
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', '@electron/asar@3', 'extract', asar, unpacked],
    { stdio: 'ignore', windowsHide: true }
  );

  const src = path.join(unpacked, 'dsh');
  if (!fs.existsSync(src)) {
    console.error('解包结果里没有 dsh 目录，可能 app.asar 不完整或版本结构变了。');
    process.exit(1);
  }

  // 完整性自检：抽查所有 .json 能不能解析（tsconfig 之类是 JSONC，单独跳过）
  const { bad, total } = verifyJson(src);
  if (bad.length > 0) {
    console.error(`解包不完整，以下 JSON 无法解析（共 ${total} 个）：`);
    bad.slice(0, 10).forEach((f) => console.error(`  ${f}`));
    console.error('请重跑一次；反复失败的话换到另一个磁盘分区试试（有些杀软会在写入时截断）。');
    process.exit(1);
  }
  console.log(`完整性自检通过（${total} 个 JSON 全部可解析）`);

  fs.mkdirSync(out, { recursive: true });
  const dest = path.join(out, 'dsh');
  if (fs.existsSync(dest)) {
    console.log('目标已存在，先替换…');
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.renameSync(src, dest);

  const entry = path.join(dest, CLI_REL);
  if (!fs.existsSync(entry)) {
    console.error(`缺少 CLI 入口：${entry}`);
    process.exit(1);
  }
  console.log('完成。DSH 的 CLI 入口现在在这里：');
  console.log(`  ${entry}`);
  console.log('AI 伴侣管理器会自动优先使用它；插件市场也就能正常更新了。');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** 遍历目录下所有 .json，返回解析失败的文件列表。 */
function verifyJson(root) {
  const bad = [];
  let total = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) {
        total += 1;
        // tsconfig 是 JSONC（带注释/尾逗号），不是损坏，跳过
        if (e.name === 'tsconfig.json' || e.name === 'tsdoc-metadata.json') continue;
        try {
          JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
          bad.push(p);
        }
      }
    }
  };
  walk(root);
  return { bad, total };
}
