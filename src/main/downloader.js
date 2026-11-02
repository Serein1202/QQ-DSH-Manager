// downloader.js — 下载（重定向跟随 + 进度上报）+ zip 解压 + npm install 修复
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function fetchRedirect(url, depth = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'QQ-DSH-Manager/1.0', ...extraHeaders } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchRedirect(next, depth + 1, extraHeaders));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('连接超时')));
  });
}

// GitHub 加速镜像列表（按稳定性排序，仅作直连失败的兜底；均支持标准前缀拼 URL）
const GITHUB_MIRRORS = [
  'https://ghfast.top',
  'https://gh-proxy.com',
  'https://ghproxy.net',
  'https://mirror.ghproxy.com',
];

// 若配置了镜像前缀，给 GitHub 官方 URL 加前缀；留空则原样返回（直连）
function githubMirrorUrl(url, mirror) {
  const m = String(mirror || '').trim().replace(/\/+$/, '');
  if (!m) return url;
  return m + '/' + url;
}

// 下载到 destFile，onProgress(received, total) 每 ~2% 上报一次。支持断点续传：
// - 若 destFile.part 已存在且有字节，自动带 Range 头续传（服务端返回 206 则追加写入）；
// - 服务端不支持 Range（200）或 Range 无效（416）时自动从头下载；
// - 网络中断/超时等错误保留 .part，下次调用同一 destFile 可从断点继续；
// - opts.verifyZip = true 时校验 zip 魔数（PK\x03\x04）与 content-length 一致性，
//   失败会清空 .part 从头完整重下一遍，仍失败才抛错。
// 注意：只能通过 'data' 监听器写入，不能再挂 res.pipe(out)——
// 早期版本两者并存会把每个 chunk 写两次，文件膨胀 2 倍导致 zip 损坏。
async function downloadFile(url, destFile, onProgress, opts = {}) {
  const tmp = destFile + '.part';
  let resumeFrom = 0;
  try {
    if (fs.existsSync(tmp)) {
      const st = fs.statSync(tmp);
      if (st.size > 0) resumeFrom = st.size;
    }
  } catch { /* stat 失败忽略，从头下载 */ }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const headers = {};
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
    let res;
    try {
      res = await fetchRedirect(url, 0, headers);
    } catch (e) {
      if (String(e.message).startsWith('HTTP 416')) {
        // Range 超出/无效：本地 part 与服务器不一致，清掉从头下
        resumeFrom = 0;
        fs.rmSync(tmp, { force: true });
        continue;
      }
      throw e; // 网络错误：保留 .part 供下次续传
    }
    const total = (resumeFrom || 0) + (Number(res.headers['content-length']) || 0);
    const out = fs.createWriteStream(tmp, resumeFrom > 0 && res.statusCode === 206 ? { flags: 'a' } : { flags: 'w' });
    let received = resumeFrom;
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
    } catch (e) {
      out.destroy(); // 网络中断：保留 .part，供下次续传
      throw e;
    }
    // 完整性校验：zip 魔数 + 大小一致（仅当调用方要求）
    if (opts.verifyZip) {
      let bad = false;
      try {
        const head = Buffer.alloc(4);
        const fd = fs.openSync(tmp, 'r');
        fs.readSync(fd, head, 0, 4, 0);
        fs.closeSync(fd);
        if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) bad = true;
        if (total && received !== total) bad = true;
      } catch { bad = true; }
      if (bad) {
        if (attempt < 2) {
          // 可能续传到了过期/损坏数据：清空 part 从头完整重下
          resumeFrom = 0;
          fs.rmSync(tmp, { force: true });
          continue;
        }
        throw new Error('下载内容校验失败（zip 魔数或大小不一致）');
      }
    }
    fs.renameSync(tmp, destFile);
    return destFile;
  }
  throw new Error('下载失败：重试次数用尽');
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

module.exports = { downloadFile, unzip, npmInstall, fetchRedirect, fetchJson, GITHUB_MIRRORS, githubMirrorUrl };
