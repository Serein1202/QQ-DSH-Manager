// downloader.js — 下载（重定向跟随 + 进度上报）+ zip 解压 + npm install 修复
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function fetchRedirect(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'companion-manager/1.0' } }, (res) => {
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

// 下载到 destFile，onProgress(received, total) 每 ~2% 上报一次
async function downloadFile(url, destFile, onProgress) {
  const res = await fetchRedirect(url);
  const total = Number(res.headers['content-length']) || 0;
  const tmp = destFile + '.part';
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastPct = -1;
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
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  fs.renameSync(tmp, destFile);
  return destFile;
}

// 用 PowerShell Expand-Archive 解压（Windows 自带，免第三方依赖）
function unzip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ps =
    `$ErrorActionPreference='Stop';` +
    `Expand-Archive -Path '${zipFile.replace(/'/g, "''")}' -DestinationPath '$env:TEMP\\cm-unzip' -Force;` +
    `$d = Get-ChildItem '$env:TEMP\\cm-unzip' -Directory | Select-Object -First 1;` +
    `if ($d) { Copy-Item ($d.FullName + '\\*') '${destDir.replace(/'/g, "''")}' -Recurse -Force }` +
    `else { Copy-Item '$env:TEMP\\cm-unzip\\*' '${destDir.replace(/'/g, "''")}' -Recurse -Force };` +
    `Remove-Item '$env:TEMP\\cm-unzip' -Recurse -Force -ErrorAction SilentlyContinue`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    timeout: 300000,
  });
  if (r.status !== 0) throw new Error('解压失败: ' + (r.stderr || r.stdout || ''));
  return destDir;
}

// npm install（可指定 node/npm 目录；npmmirror 兜底）
function npmInstall(cwd, nodeDir) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (nodeDir) env.PATH = nodeDir + path.delimiter + env.PATH;
    const npmCmd = nodeDir ? path.join(nodeDir, 'npm.cmd') : 'npm.cmd';
    const child = spawn(npmCmd, ['install', '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com'], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
    });
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

// 拉取 JSON（更新清单用）
async function fetchJson(url) {
  const res = await fetchRedirect(url);
  let data = '';
  for await (const chunk of res) data += chunk.toString('utf8');
  return JSON.parse(data);
}

module.exports = { downloadFile, unzip, npmInstall, fetchRedirect, fetchJson };
