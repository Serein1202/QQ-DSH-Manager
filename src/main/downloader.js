// downloader.js — 下载（重定向跟随 + 进度上报）+ zip 解压 + npm install 修复
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function fetchRedirect(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'QQ-DSH-Manager/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchRedirect(next, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('连接超时')));
  });
}

// 下载到 destFile，onProgress(received, total) 每 ~2% 上报一次。
// opts.verifyZip = true 时校验 zip 魔数（PK\x03\x04）与 content-length 一致性，失败清理 .part。
// 注意：只能通过 'data' 监听器写入，不能再挂 res.pipe(out)——
// 早期版本两者并存会把每个 chunk 写两次，文件膨胀 2 倍导致 zip 损坏。
async function downloadFile(url, destFile, onProgress, opts = {}) {
  const res = await fetchRedirect(url);
  const total = Number(res.headers['content-length']) || 0;
  const tmp = destFile + '.part';
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastPct = -1;
  try {
    await new Promise((resolve, reject) => {
      res.on('data', (chunk) => {
        received += chunk.length;
        out.write(chunk);
        if (onProgress && total) {
          const pct = Math.floor((received / total) * 100);
          if (pct >= lastPct + 2 || pct === 100) {
            lastPct = pct;
            onProgress(received, total);
          }
        }
      });
      res.on('end', () => out.end()); // 流读完显式结束写流（去掉 pipe 后需手动 end）
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
    });
    // 完整性校验：zip 魔数 + 大小一致（仅当调用方要求）
    if (opts.verifyZip) {
      const head = Buffer.alloc(4);
      const fd = fs.openSync(tmp, 'r');
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw new Error('下载内容不是有效的 zip 包（魔数校验失败）');
      }
      if (total && received !== total) {
        throw new Error(`下载不完整（${received}/${total} 字节）`);
      }
    }
    fs.renameSync(tmp, destFile);
  } catch (e) {
    fs.rmSync(tmp, { force: true }); // 失败清理 .part，避免残留
    throw e;
  }
  return destFile;
}

// 用 PowerShell Expand-Archive 解压（Windows 自带，免第三方依赖）
// 注意：临时解压目录必须用绝对路径（os.tmpdir()），不能写 '$env:TEMP' 之类的
// 环境变量引用——若用单引号包裹，PowerShell 不会展开，字面量 "$env:" 会被当成
// 驱动器解析导致 DriveNotFound 解压失败（曾在新电脑上复现）。
function unzip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tmpDir = path.join(os.tmpdir(), 'cm-unzip-' + crypto.randomBytes(4).toString('hex'));
  const sq = (s) => s.replace(/'/g, "''");
  const ps =
    `$ErrorActionPreference='Stop';` +
    `Expand-Archive -Path '${sq(zipFile)}' -DestinationPath '${sq(tmpDir)}' -Force;` +
    `$d = Get-ChildItem '${sq(tmpDir)}' -Directory | Select-Object -First 1;` +
    `if ($d) { Copy-Item ($d.FullName + '\\*') '${sq(destDir)}' -Recurse -Force }` +
    `else { Copy-Item '${sq(tmpDir)}\\*' '${sq(destDir)}' -Recurse -Force };` +
    `Remove-Item '${sq(tmpDir)}' -Recurse -Force -ErrorAction SilentlyContinue`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    timeout: 300000,
  });
  if (r.status !== 0) throw new Error('解压失败: ' + (r.stderr || r.stdout || ''));
  return destDir;
}

// 单次 npm install（registry 由调用方指定）
function runNpm(cwd, nodeDir, registry) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (nodeDir) env.PATH = nodeDir + path.delimiter + env.PATH;
    // Windows 下 .cmd/.bat 不能直接被 spawn（CreateProcess 不解释批处理 → ENOENT）。
    // 有便携 node 时用 node + npm-cli.js 精确执行；没有便携 node 时退回 cmd 包装 npm.cmd。
    const npmArgs = ['install', '--no-audit', '--no-fund', '--registry=' + registry];
    let child;
    if (nodeDir) {
      const nodeBin = path.join(nodeDir, 'node.exe');
      const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      child = spawn(nodeBin, [npmCli, ...npmArgs], {
        cwd,
        env,
        windowsHide: true,
        shell: false,
      });
    } else {
      child = spawn('npm.cmd', npmArgs, {
        cwd,
        env,
        windowsHide: true,
        shell: true,
      });
    }
    let tail = [];
    const collect = (buf) => {
      tail = tail.concat(buf.toString('utf8').split(/\r?\n/).filter(Boolean));
      if (tail.length > 200) tail = tail.slice(-200);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => resolve({ ok: false, error: e.message, log: tail }));
    child.on('exit', (code) =>
      resolve({ ok: code === 0, error: code === 0 ? '' : `npm install 退出码 ${code}`, log: tail })
    );
  });
}

// npm install（可指定 node/npm 目录；优先 npmmirror，失败自动换官方源兜底）
async function npmInstall(cwd, nodeDir) {
  const registries = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
  let last;
  for (const registry of registries) {
    last = await runNpm(cwd, nodeDir, registry);
    if (last.ok) return last;
  }
  return last;
}

// 拉取 JSON（更新清单用）
async function fetchJson(url) {
  const res = await fetchRedirect(url);
  let data = '';
  for await (const chunk of res) data += chunk.toString('utf8');
  return JSON.parse(data);
}

module.exports = { downloadFile, unzip, npmInstall, fetchRedirect, fetchJson };
