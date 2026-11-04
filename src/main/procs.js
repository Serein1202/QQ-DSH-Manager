// procs.js — 服务进程管理：spawn / 停止(taskkill 树杀) / 日志环形缓冲 / 端口探活
'use strict';
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const net = require('net');
const os = require('os');
const fs = require('fs');

const LOG_LIMIT = 1000; // 每服务保留最近 1000 行

// ---------- 异步执行器 ----------
// 为什么必须有它：主进程里所有 spawnSync 都会阻塞 Electron 的事件循环。
// restart 一次要跑 netstat + 最多 4 个 PowerShell + taskkill，同步执行累计 3~10s，
// 期间窗口不派发消息 → Windows 判定「未响应」（用户看到的就是「点重启客户端卡死」）。
// 统一走 spawn 回调，主进程全程可响应，渲染层的进度/状态刷新也不会被冻住。
// 超时用 kill 兜底（Windows 下等价 TerminateProcess），返回 status=-1 表示失败，不抛异常。
const MAX_OUT = 4 * 1024 * 1024; // 输出上限，防止异常进程刷爆内存

function runAsync(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        if (child) child.kill();
      } catch {}
      resolve(r);
    };
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ status: -1, stdout: '', stderr: e.message });
    }
    const timer = setTimeout(() => finish({ status: -1, stdout: out, stderr: 'timeout' }), timeout);
    if (child.stdout)
      child.stdout.on('data', (b) => {
        if (out.length < MAX_OUT) out += b.toString('utf8');
      });
    if (child.stderr)
      child.stderr.on('data', (b) => {
        if (err.length < MAX_OUT) err += b.toString('utf8');
      });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ status: -1, stdout: out, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ status: code, stdout: out, stderr: err });
    });
  });
}

// PID 是否仍存活。process.kill(pid, 0) 只做句柄探测不发送信号：
//   ESRCH = 进程已不存在；EPERM = 存在但无权限打开（受保护进程）→ 仍算存活。
function isPidAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 4) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// 按流维护行缓冲。
// 为什么不能每块 chunk 单独 split('\n')：chunk 边界随时可能切在
// `dsh web: http://127.0.0.1:3080/?token=xxx` 中间，逐块处理会把该行劈成两段半行，
// 两段都不匹配 URL 正则 → token 永远捕获不到 → Web 入口打不开（401）。
// StringDecoder 负责跨 chunk 的多字节 UTF-8 拼接，避免中文日志乱码。
function makeLineReader(onLine) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  const emit = (line) => {
    if (line) onLine(line);
  };
  return {
    push(chunk) {
      buf += decoder.write(chunk);
      // 防御：刷屏输出长时间不带换行时，只保留尾部，避免无界增长
      if (buf.length > 64 * 1024) buf = buf.slice(-32 * 1024);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop(); // 最后一段可能是半行，留到下一次 chunk 再拼
      for (const line of parts) emit(line);
    },
    // 进程退出时把残留半行吐出去，否则最后一行（常含关键错误）会丢
    flush() {
      buf += decoder.end();
      if (buf) emit(buf.replace(/\r$/, ''));
      buf = '';
    },
  };
}

// DSH web 启动时会打印 `dsh web: http://127.0.0.1:3080/?token=xxx`，
// token 仅进程启动时 mint 一次、不落盘，必须从该行捕获，供 Web 入口按钮拼接
const DSH_WEB_URL_RE = /dsh web:\s*(https?:\/\/[^\s"'<>]+)/i;

// shell 元字符：出现即说明是复合命令（管道/重定向/变量/串联），只能交给 cmd
const CMD_META = /[|&<>^%]/;

// 把 "含空格的 exe 路径 + 参数" 拆成 { exe, args }，用于绕过 cmd 直接启动。
// 为什么必须拆分：
//   1) cmd.exe /s /c "<路径>" 会剥掉首尾引号（/S 规则），含空格的路径被当成「命令 + 参数」→
//      报「不是内部或外部命令」，DSH 这类装在 "DeepSeek Harness" 目录下的程序必挂；
//   2) 即便包一层引号能过，cmd 作为父进程会在 GUI 程序起来后立刻退出，托管句柄丢失，
//      服务页显示「未运行」且停止按钮失效。
// 返回 null 表示不能安全拆分（复合命令 / 路径不存在），调用方退回 shell 模式。
function parseShellCmd(shellCmd) {
  const s = String(shellCmd || '').trim();
  if (!s) return null;
  if (CMD_META.test(s)) return null;

  let exe = '';
  let rest = '';
  if (s[0] === '"') {
    const end = s.indexOf('"', 1);
    if (end < 0) return null;
    exe = s.slice(1, end);
    rest = s.slice(end + 1).trim();
  } else {
    const sp = s.indexOf(' ');
    exe = sp < 0 ? s : s.slice(0, sp);
    rest = sp < 0 ? '' : s.slice(sp + 1).trim();
  }
  if (!exe || !fs.existsSync(exe)) return null; // 依赖 PATH 查找的命令交给 shell

  // 参数分词：双引号内保留空格
  const args = [];
  let cur = '';
  let quoted = false;
  for (const c of rest) {
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur) args.push(cur);
  return { exe, args };
}

// 按监听端口反查 PID：netstat -ano 是纯系统工具，比 PowerShell 快且无兼容性问题
function pidsByPortNetstat(port) {
  try {
    const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (!r.stdout) return [];
    const suffix = ':' + Number(port); // 匹配 IPv4/IPv6 本地地址结尾
    const pids = new Set();
    for (const line of String(r.stdout).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // TCP  本地地址  远程地址  LISTENING  pid
      if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3]) && cols[1].endsWith(suffix)) {
        const pid = Number(cols[4]);
        if (pid > 4 && pid !== process.pid) pids.add(pid); // 过滤系统(0/4)和自身
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

// 兜底 1：netstat 视图被过滤/失败时用 PowerShell 的 Get-NetTCPConnection
function pidsByPortPowerShell(port) {
  try {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`,
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    const out = String(r.stdout || '').trim();
    if (!out) return [];
    return out
      .split(',')
      .map(Number)
      .filter((n) => n > 4 && n !== process.pid);
  } catch {
    return [];
  }
}

// 兜底 2：端口查不到（监听行被过滤）时，按服务工作目录匹配进程命令行。
// node 服务启动时命令行里带 cwd 路径，CIM 能枚举到；匹配到就杀。
function pidsByCmdline(needle) {
  if (!needle) return [];
  try {
    const esc = String(needle).replace(/'/g, "''");
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${esc}*' -and $_.ProcessId -ne $PID } | Select-Object -ExpandProperty ProcessId) -join ','`,
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const out = String(r.stdout || '').trim();
    if (!out) return [];
    return out
      .split(',')
      .map(Number)
      .filter((n) => n > 4 && n !== process.pid);
  } catch {
    return [];
  }
}

function pidsByPort(port) {
  let pids = pidsByPortNetstat(port);
  if (!pids.length) pids = pidsByPortPowerShell(port);
  return pids;
}

// 批量反查 PID 的命令行：停止前确认进程身份，避免误杀无关进程。
// 返回 [{ pid, cmdline }]，查不到命令行的 PID 也带空 cmdline（权限不足/僵尸进程）。
function pidsInfo(pids) {
  if (!pids || !pids.length) return [];
  try {
    const idList = [...new Set(pids)].map(Number).join(',');
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -in @(${idList}) } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }`,
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const out = [];
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const i = line.indexOf('|');
      if (i > 0) out.push({ pid: Number(line.slice(0, i)), cmdline: line.slice(i + 1) });
    }
    return out;
  } catch {
    return pids.map((p) => ({ pid: p, cmdline: '' }));
  }
}

function killPidTree(pid) {
  try {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function killPidTreeAsync(pid) {
  const r = await runAsync('taskkill', ['/PID', String(pid), '/T', '/F'], 8000);
  return r.status === 0;
}

// ---------- 异步版进程反查（stopAsync 用） ----------
// 把「netstat 查端口 + PowerShell 查命令行」压成 ≤2 次子进程：
// 旧实现是 1 次 netstat + 每个特征各 1 次 PowerShell（cwd、exe 名、--expose-internals 共 4 次），
// 每次 PowerShell 冷启动 0.5~3s，串起来就是 5~10s 的整机卡顿。
// 现在一次 CIM 枚举同时返回「端口命中的 PID」和「命令行命中特征的 PID」，用 idx 区分来源：
//   idx >= 0  → 命令行命中第 idx 个 needle（身份弱，必须 verify 再确认）
//   idx = -2  → 端口命中（身份强，反查不到命令行时按端口归属处理）
async function scanAsync({ ports = [], needles = [] } = {}) {
  const portPids = new Set();
  const list = (ports || []).map(Number).filter((n) => n > 0 && n < 65536);
  if (list.length) {
    const r = await runAsync('netstat', ['-ano', '-p', 'TCP'], 6000);
    const suffixes = list.map((p) => ':' + p);
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5 || cols[0] !== 'TCP' || !/LISTENING/i.test(cols[3])) continue;
      if (!suffixes.some((s) => cols[1].endsWith(s))) continue;
      const pid = Number(cols[4]);
      if (pid > 4 && pid !== process.pid) portPids.add(pid);
    }
    // 兜底：netstat 视图被过滤/失败时改用 CIM 的监听连接（同样一次调用）
    if (!portPids.size) {
      const ps = await runAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${list.join(',')}) -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`,
        ],
        8000
      );
      for (const s of String(ps.stdout || '').trim().split(',')) {
        const pid = Number(s);
        if (pid > 4 && pid !== process.pid) portPids.add(pid);
      }
    }
  }

  const nd = (needles || []).map((n) => String(n || '').trim()).filter(Boolean);
  const ids = [...portPids];
  const infoMap = new Map();
  const cmdPids = new Set();
  if (!ids.length && !nd.length) return { portPids, cmdPids, infoMap };

  // needle 走单引号字面量：PowerShell 里 ' 需要写成 '' 转义
  const needleLit = nd.map((n) => "'" + n.replace(/'/g, "''") + "'").join(',');
  const script = [
    `$ids=@(${ids.join(',')});`,
    `$needles=@(${needleLit});`,
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {',
    '  $p=$_; if ($p.ProcessId -le 4 -or $p.ProcessId -eq $PID) { return }',
    '  $idx=-1;',
    '  if ($ids -contains $p.ProcessId) { $idx=-2 }',
    '  if ($idx -eq -1) {',
    '    for ($i=0; $i -lt $needles.Count; $i++) {',
    "      if ($needles[$i] -and $p.CommandLine -like ('*'+$needles[$i]+'*')) { $idx=$i; break }",
    '    }',
    '  }',
    '  if ($idx -ne -1) { "$($p.ProcessId)|$idx|$($p.CommandLine)" }',
    '}',
  ].join(' ');
  const r = await runAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15000);
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const i1 = line.indexOf('|');
    if (i1 <= 0) continue;
    const i2 = line.indexOf('|', i1 + 1);
    if (i2 < 0) continue;
    const pid = Number(line.slice(0, i1));
    if (!(pid > 4) || pid === process.pid) continue;
    const idx = Number(line.slice(i1 + 1, i2));
    if (!Number.isFinite(idx)) continue;
    infoMap.set(pid, line.slice(i2 + 1));
    if (idx >= 0) cmdPids.add(pid);
  }
  return { portPids, cmdPids, infoMap };
}

// 由「端口命中 / 命令行命中 / 命令行」决定要杀谁。同步与异步路径共用，避免两套判定漂移。
// 防误杀与防漏杀的平衡：
// - 端口命中的 PID：反查不到命令行（权限/僵尸）时信任端口归属，避免漏杀；
//   反查到且明确不含 verify 特征时视为无关进程放过。
// - 命令行兜底命中的 PID：特征较宽泛，必须 verify 确认身份才杀。
function decideTargets(portPids, cmdPids, infoMap, verify) {
  // 自杀保护：不能把管理器自己（或它的父进程）杀掉。
  //
  // 判据只能是「自身进程号」+「打包运行时唯一的 exe 路径」两者组合，不能拿 process.execPath 无条件比对：
  // - 打包态 Electron：execPath 就是 QQ-DSH-Manager.exe，命令行里出现它即等同自身，安全；
  // - 开发态 Electron（electron .）：execPath 是共享的 electron.exe；
  // - 纯 node 运行（命令行 / 测试 / 被当作 runtime 复用时）：execPath 是共享的 node.exe。
  // 后两种情形下 if(cmd.includes(execPath)) 会把「所有用同一 node 启动的托管服务」判成自身，
  // 造成非托管实例永远停不掉（端口有进程 → foreign 为空 → 报「无法确认是本服务」）。
  const electron = !!(process.versions && process.versions.electron);
  const selfExe = electron && !process.defaultApp ? process.execPath || '' : '';
  const safe = (pid) => {
    if (pid === process.pid || pid === process.ppid) return false;
    const cmd = infoMap.get(pid);
    if (selfExe && cmd && cmd.includes(selfExe)) return false;
    return true;
  };
  const targets = [];
  for (const pid of portPids) {
    if (!safe(pid)) continue;
    const cmd = infoMap.get(pid);
    if (cmd === undefined || cmd === '') targets.push({ pid });
    else if (verify.length && verify.some((v) => v && cmd.includes(v))) targets.push({ pid });
  }
  for (const pid of cmdPids) {
    if (portPids.has(pid) || !safe(pid)) continue;
    const cmd = infoMap.get(pid);
    if (cmd && verify.length && verify.some((v) => v && cmd.includes(v))) targets.push({ pid });
  }
  return targets;
}

class ProcessManager {
  constructor() {
    this.procs = new Map(); // id -> ChildProcess
    this.logs = new Map(); // id -> string[]
    this.webTokens = new Map(); // id -> 从启动日志捕获的 Web token（如 DSH 的 ?token=）
    this.onExit = null; // (id, code) => void，由 ipc 层注入
    this.onLog = null; // (id, line) => void
    this.userStopped = new Set(); // 用户主动 stop 的 id：退出时不算崩溃，不触发自动重启
    this.restartStats = new Map(); // id -> { count, timer } 崩溃自动重启计数（60s 窗口退避）
    this.startedAt = new Map(); // id -> 启动时间戳，用于前端显示运行时长
  }

  getWebToken(id) {
    return this.webTokens.get(id) || '';
  }

  // 托管进程的 PID / 运行时长，供服务列表实时显示
  getPid(id) {
    const p = this.procs.get(id);
    return p && p.pid ? p.pid : 0;
  }

  getUptime(id) {
    const t = this.startedAt.get(id);
    return t ? Date.now() - t : 0;
  }

  clearCrash(id) {
    this.restartStats.delete(id);
  }

  isRunning(id) {
    const p = this.procs.get(id);
    if (!p || !p.pid) return false;
    try {
      // exitCode / signalCode 由 Node 在子进程真实退出时写入；两者仍为 null 才是活着的。
      // killed 只反映本地 child.kill() 调用，外部 taskkill 不会置位，不能单独作为判据。
      return p.exitCode === null && p.signalCode === null && !p.killed;
    } catch {
      return false;
    }
  }

  // 等一批 PID 真正消失。
  // taskkill /T /F 返回 0 只代表命令执行成功，不代表目标已经终止（GUI 程序退出更慢）。
  // 不等就 start，会出现「旧实例还没死透、新实例抢不到端口」→ 重启看似成功但服务没起来。
  async waitStopped(pids, timeout = 8000) {
    const list = [...new Set((pids || []).map(Number))].filter((n) => n > 4);
    if (!list.length) return true;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!list.some(isPidAlive)) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return !list.some(isPidAlive);
  }

  pushLog(id, line) {
    if (!this.logs.has(id)) this.logs.set(id, []);
    const arr = this.logs.get(id);
    arr.push(line);
    if (arr.length > LOG_LIMIT) arr.splice(0, arr.length - LOG_LIMIT);
    // 捕获 DSH web 启动时打印的带 token URL（`dsh web: http://.../?token=xxx`）
    const m = DSH_WEB_URL_RE.exec(line);
    if (m) {
      try {
        const u = new URL(m[1]);
        const t = u.searchParams.get('token');
        if (t) this.webTokens.set(id, t);
      } catch {}
    }
    if (this.onLog) this.onLog(id, line);
  }

  // command: 可执行文件；args: 参数数组；shellCmd: 直接用 cmd /c 执行的整串命令（DSH 自定义命令用）
  // logTo / logPrefix: 附属服务把日志并入主服务面板并加前缀（如 [手机 MCP]）
  start(id, opts) {
    const { cwd, command, args = [], shellCmd = '', env = {}, logTo = '', logPrefix = '' } = opts || {};
    if (this.isRunning(id)) {
      return { ok: false, error: '服务已在运行' };
    }
    if (!cwd) return { ok: false, error: '未设置工作目录（请先完成环境检测/安装）' };
    if (!shellCmd && !command) return { ok: false, error: '未设置启动命令' };

    const logId = logTo || id;
    const prefix = logPrefix ? `[${logPrefix}] ` : '';
    const push = (line) => this.pushLog(logId, prefix + line);

    if (!logTo) this.logs.set(id, []);
    let child;
    let launchedExe = '';
    try {
      if (shellCmd) {
        const parsed = parseShellCmd(shellCmd);
        if (parsed) {
          // 常规情形：单条 exe 命令 → 直起，不经 cmd（引号/托管问题都不存在）
          launchedExe = parsed.exe;
          child = spawn(parsed.exe, parsed.args, {
            cwd,
            env: { ...process.env, ...env },
            windowsHide: true,
          });
        } else {
          // 复合命令：交给 shell；shell:true 在 Windows 下会再包一层引号，抵消 cmd /s 的剥离
          child = spawn(shellCmd, {
            shell: true,
            cwd,
            env: { ...process.env, ...env },
            windowsHide: true,
          });
        }
      } else {
        launchedExe = command;
        child = spawn(command, args, {
          cwd,
          env: { ...process.env, ...env },
          windowsHide: true,
        });
      }
    } catch (e) {
      return { ok: false, error: '启动失败: ' + e.message };
    }

    this.procs.set(id, child);
    this.startedAt.set(id, Date.now());
    // 新进程启动：上一次运行 mint 的 token 立即作废（DSH 每次启动都换 token）。
    // 不清掉会让 svc:list 把过期 token 拼进 Web 入口，点开直接 401 —— 这就是重启后「打不开」的来源。
    this.webTokens.delete(id);
    // userStopped 里可能还残留上一次 stop 的标记（旧 child 的 exit 事件尚未派发）。
    // 不清掉会把新进程的真实崩溃误判成「用户主动停止」，导致不触发自动重启。
    this.userStopped.delete(id);

    const tag = `[${new Date().toLocaleTimeString()}] 已启动 (pid ${child.pid})`;
    push(tag);

    const outReader = makeLineReader((line) => {
      if (line.trim()) push(line);
    });
    const errReader = makeLineReader((line) => {
      if (line.trim()) push(line);
    });
    if (child.stdout) child.stdout.on('data', (b) => outReader.push(b));
    if (child.stderr) child.stderr.on('data', (b) => errReader.push(b));
    child.on('error', (e) => {
      const hint =
        e.code === 'ENOENT'
          ? `找不到可执行文件: ${launchedExe || command || shellCmd}（检查路径是否存在）`
          : `${e.code || ''} ${e.message}`;
      push(`[错误] ${hint}`);
      if (this.procs.get(id) === child) this.procs.delete(id); // 起不来的不留在托管表里，避免 isRunning 误判
      if (this.onExit) this.onExit(id, -1);
    });
    child.on('exit', (code, signal) => {
      outReader.flush();
      errReader.flush();
      push(`[${new Date().toLocaleTimeString()}] 进程退出 (code=${code}, signal=${signal})`);
      // 只有登记表里仍是这个 child 才允许清账。
      // 重启时旧进程的 exit 回调可能晚于新进程 start 到达，无条件 delete 会把刚起来的新 child
      // 从托管表里删掉 → managed=false、状态显示「未运行」、停止按钮失效、再次重启报「停止失败」。
      const current = this.procs.get(id);
      if (current === child) {
        this.procs.delete(id);
        this.webTokens.delete(id); // 进程已死，token 一定失效，不能留给前端拼 URL
        this.startedAt.delete(id);
      }
      // 用户主动停止导致的退出不算崩溃：不触发自动重启，也不累计崩溃计数
      if (this.userStopped.has(id)) {
        this.userStopped.delete(id);
        this.clearCrash(id);
      } else if (current === child && this.onExit) {
        // 被替换掉的旧进程退出不回调 onExit，否则会触发对「用户刚重启的服务」的崩溃自动重启
        this.onExit(id, code);
      }
    });
    return { ok: true, pid: child.pid };
  }

  // Windows 下必须树杀，否则 node 的子进程会残留
  // ports: 服务监听的端口列表；cwd: 服务工作目录（端口查不到时按命令行兜底）。
  // 服务不是本管理器拉起时（用户手动开 / 上次残留），反查 PID 强杀，否则永远停不掉。
  stop(id, ports = [], cwd = '', opts = {}) {
    const p = this.procs.get(id);
    if (p && p.pid) {
      this.userStopped.add(id); // 主动停止：exit 时不触发崩溃自动重启
      try {
        const r = spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { encoding: 'utf8', timeout: 8000 });
        if (r.status === 0) {
          this.procs.delete(id);
          this.webTokens.delete(id); // 进程已停止，token 失效
          this.startedAt.delete(id);
          this.pushLog(id, `[${new Date().toLocaleTimeString()}] 已停止`);
          // 把 PID 交回调用方，由 waitStopped 确认真正退出（taskkill 返回 0 ≠ 已终止）
          return { ok: true, pids: [p.pid] };
        }
        // taskkill 失败：保留托管记录（isRunning 仍为 true），避免后续 start/restart 叠加新实例
        this.userStopped.delete(id);
        return { ok: false, error: (r.stderr || '').trim() || `taskkill 失败 (status=${r.status})` };
      } catch (e) {
        this.userStopped.delete(id);
        return { ok: false, error: e.message };
      }
    }

    // 非托管分支：端口反查 → 命令行兜底
    if ((!ports || !ports.length) && !cwd) {
      return { ok: false, notRunning: true, error: '服务未在运行' };
    }
    const portPids = new Set();
    for (const port of ports || []) {
      for (const pid of pidsByPort(port)) portPids.add(pid);
    }
    // 命令行兜底：不止 cwd，还按 verify 特征（可执行文件完整路径 / 入口文件名）枚举，
    // 覆盖回退到备用端口、未被 probePorts 反查到的实例
    const cmdPids = new Set();
    const needles = [cwd, ...((opts && opts.verify) || [])].filter(Boolean);
    for (const n of needles) {
      for (const pid of pidsByCmdline(n)) cmdPids.add(pid);
    }
    const pids = new Set([...portPids, ...cmdPids]);
    if (!pids.size) return { ok: false, notRunning: true, error: '服务未在运行' };

    const verify = (opts && opts.verify) || [];
    const infoMap = new Map(pidsInfo([...pids]).map((i) => [i.pid, i.cmdline]));
    const targets = decideTargets(portPids, cmdPids, infoMap, verify);
    if (!targets.length) return { ok: false, error: '端口有进程但无法确认是本服务（已取消停止以避免误杀）' };

    const errors = [];
    for (const t of targets) {
      if (!killPidTree(t.pid)) errors.push(t.pid);
    }
    const killed = targets.filter((t) => !errors.includes(t.pid)).map((t) => t.pid);
    if (killed.length) this.webTokens.delete(id); // 外部实例被清掉，旧 token 同样失效
    this.pushLog(id, `[${new Date().toLocaleTimeString()}] 已停止外部进程 (pid ${killed.join(', ')})`);
    return errors.length
      ? { ok: false, pids: killed, error: `部分进程停止失败: ${errors.join(', ')}` }
      : { ok: true, pids: killed };
  }

  // 异步版 stop：语义与 stop() 完全一致，但所有子进程调用都不阻塞主进程事件循环。
  // IPC（svc:stop / svc:restart / svc:stopAll）必须走这个版本，否则点一次重启窗口会「未响应」5~10s。
  // 同步版只留给 before-quit（同步钩子用不了 await）。
  async stopAsync(id, ports = [], cwd = '', opts = {}) {
    const p = this.procs.get(id);
    if (p && p.pid) {
      this.userStopped.add(id);
      const ok = await killPidTreeAsync(p.pid);
      if (ok) {
        this.procs.delete(id);
        this.webTokens.delete(id);
        this.startedAt.delete(id);
        this.pushLog(id, `[${new Date().toLocaleTimeString()}] 已停止`);
        return { ok: true, pids: [p.pid] };
      }
      this.userStopped.delete(id);
      return { ok: false, error: `taskkill 失败 (pid ${p.pid})` };
    }

    if ((!ports || !ports.length) && !cwd) {
      return { ok: false, notRunning: true, error: '服务未在运行' };
    }

    // 与同步版同一套特征：cwd 在 Windows 命令行里不存在，实际起作用的是 verify（exe 名 / CLI 路径）
    const needles = [cwd, ...((opts && opts.verify) || [])].filter(Boolean);
    const { portPids, cmdPids, infoMap } = await scanAsync({ ports: ports || [], needles });
    if (!portPids.size && !cmdPids.size) return { ok: false, notRunning: true, error: '服务未在运行' };

    const verify = (opts && opts.verify) || [];
    const targets = decideTargets(portPids, cmdPids, infoMap, verify);
    if (!targets.length) {
      // 带上占用者的 PID 和命令行，用户才知道是谁占着端口（原来只有一句模糊提示，没法排查）
      const who = [...portPids]
        .map((pid) => `pid ${pid}: ${(infoMap.get(pid) || '（无法读取命令行）').slice(0, 160)}`)
        .join('；');
      return {
        ok: false,
        error: '端口有进程但不属于本服务，已取消停止以避免误杀' + (who ? `（占用者 ${who}）` : ''),
        foreign: who ? [...portPids] : [],
      };
    }

    const killed = [];
    const errors = [];
    await Promise.all(
      targets.map(async (t) => {
        if (await killPidTreeAsync(t.pid)) killed.push(t.pid);
        else errors.push(t.pid);
      })
    );
    if (killed.length) this.webTokens.delete(id);
    if (killed.length) this.startedAt.delete(id);
    this.pushLog(id, `[${new Date().toLocaleTimeString()}] 已停止外部进程 (pid ${killed.join(', ')})`);
    return errors.length
      ? { ok: false, pids: killed, error: `部分进程停止失败: ${errors.join(', ')}` }
      : { ok: true, pids: killed };
  }

  async stopAll(portsById = {}, cwdById = {}, optsById = {}) {
    // 先同步下达所有 taskkill，再逐个等 PID 消失。
    // 不能边杀边等：await 会挂起循环，排在后面的服务就没机会被杀。
    const { stopped, pids } = this.stopAllSync(portsById, cwdById, optsById);
    await this.waitStopped(pids);
    return stopped;
  }

  // 异步批量停止（IPC / 界面按钮用）：并行下发，全部 await，主进程不卡
  async stopAllAsync(portsById = {}, cwdById = {}, optsById = {}) {
    const ids = [...new Set([...this.procs.keys(), ...Object.keys(portsById)])];
    const results = await Promise.all(
      ids.map((id) => this.stopAsync(id, portsById[id] || [], cwdById[id] || '', optsById[id] || {}))
    );
    const stopped = ids.filter((_, i) => results[i].ok);
    const pids = results.flatMap((r) => r.pids || []);
    await this.waitStopped(pids);
    return stopped;
  }

  // 同步停止全部，不做任何 await。
  // before-quit 是同步钩子，用不了 async —— 一旦 await，剩余服务不会被停掉，退出后残留孤儿进程。
  stopAllSync(portsById = {}, cwdById = {}, optsById = {}) {
    const stopped = [];
    const pids = [];
    // 托管的直接杀
    for (const id of [...this.procs.keys()]) {
      const r = this.stop(id, portsById[id] || [], cwdById[id] || '', optsById[id] || {});
      if (r.ok) {
        stopped.push(id);
        if (r.pids) pids.push(...r.pids);
      }
    }
    // 非托管但端口在线的也一并处理
    for (const id of Object.keys(portsById)) {
      if (stopped.includes(id)) continue;
      const r = this.stop(id, portsById[id], cwdById[id] || '', optsById[id] || {});
      if (r.ok) {
        stopped.push(id);
        if (r.pids) pids.push(...r.pids);
      }
    }
    return { stopped, pids };
  }

  getLogs(id) {
    return this.logs.get(id) || [];
  }
}

// 端口探活：TCP 连得上 = 服务在
function probePort(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(Number(port), host || '127.0.0.1');
  });
}

module.exports = {
  ProcessManager,
  probePort,
  parseShellCmd,
  isPidAlive,
  makeLineReader,
  runAsync,
  scanAsync,
  decideTargets,
};
