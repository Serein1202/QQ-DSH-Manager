// procs.js — 服务进程管理：spawn / 停止(taskkill 树杀) / 日志环形缓冲 / 端口探活
'use strict';
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');

const LOG_LIMIT = 1000; // 每服务保留最近 1000 行

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

class ProcessManager {
  constructor() {
    this.procs = new Map(); // id -> ChildProcess
    this.logs = new Map(); // id -> string[]
    this.onExit = null; // (id, code) => void，由 ipc 层注入
    this.onLog = null; // (id, line) => void
    this.userStopped = new Set(); // 用户主动 stop 的 id：退出时不算崩溃，不触发自动重启
    this.restartStats = new Map(); // id -> { count, timer } 崩溃自动重启计数（60s 窗口退避）
  }

  clearCrash(id) {
    this.restartStats.delete(id);
  }

  isRunning(id) {
    const p = this.procs.get(id);
    if (!p) return false;
    try {
      return p.pid && p.exitCode === null && !p.killed;
    } catch {
      return false;
    }
  }

  pushLog(id, line) {
    if (!this.logs.has(id)) this.logs.set(id, []);
    const arr = this.logs.get(id);
    arr.push(line);
    if (arr.length > LOG_LIMIT) arr.splice(0, arr.length - LOG_LIMIT);
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
    const tag = `[${new Date().toLocaleTimeString()}] 已启动 (pid ${child.pid})`;
    push(tag);

    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) push(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      const hint =
        e.code === 'ENOENT'
          ? `找不到可执行文件: ${launchedExe || command || shellCmd}（检查路径是否存在）`
          : `${e.code || ''} ${e.message}`;
      push(`[错误] ${hint}`);
      this.procs.delete(id); // 起不来的不留在托管表里，避免 isRunning 误判
      if (this.onExit) this.onExit(id, -1);
    });
    child.on('exit', (code, signal) => {
      push(`[${new Date().toLocaleTimeString()}] 进程退出 (code=${code}, signal=${signal})`);
      this.procs.delete(id);
      // 用户主动停止导致的退出不算崩溃：不触发自动重启，也不累计崩溃计数
      if (this.userStopped.has(id)) {
        this.userStopped.delete(id);
        this.clearCrash(id);
      } else if (this.onExit) {
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
          this.pushLog(id, `[${new Date().toLocaleTimeString()}] 已停止`);
          return { ok: true };
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
    if ((!ports || !ports.length) && !cwd) return { ok: false, error: '服务未在运行' };
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
    if (!pids.size) return { ok: false, error: '服务未在运行' };

    // 防误杀与防漏杀的平衡：
    // - 端口命中的 PID：端口是服务自己的 probePorts，命中即视为本服务；命令行反查失败（权限/僵尸）
    //   或反查为空时不放过，直接纳入停止，避免停不掉旧实例；若命令行可反查到且明确不含 verify
    //   特征，则视为无关进程放过。
    // - 命令行兜底命中的 PID：特征较宽泛，仍需 verify 确认身份才杀。
    const verify = (opts && opts.verify) || [];
    const infoMap = new Map(pidsInfo([...pids]).map((i) => [i.pid, i.cmdline]));
    const targets = [];
    for (const pid of portPids) {
      const cmd = infoMap.get(pid);
      if (cmd === undefined || cmd === '') {
        targets.push({ pid }); // 端口命中但反查不到命令行：信任端口归属，避免漏杀
      } else if (verify.length && verify.some((v) => v && cmd.includes(v))) {
        targets.push({ pid });
      }
      // 端口命中但命令行明确不含 verify 特征：视为无关进程占用端口，放过（防误杀）
    }
    for (const pid of cmdPids) {
      if (portPids.has(pid)) continue; // 已在端口命中分支处理
      const cmd = infoMap.get(pid);
      if (cmd && verify.length && verify.some((v) => v && cmd.includes(v))) targets.push({ pid });
    }
    if (!targets.length) return { ok: false, error: '端口有进程但无法确认是本服务（已取消停止以避免误杀）' };

    const errors = [];
    for (const t of targets) {
      if (!killPidTree(t.pid)) errors.push(t.pid);
    }
    const killed = targets.filter((t) => !errors.includes(t.pid)).map((t) => t.pid);
    this.pushLog(id, `[${new Date().toLocaleTimeString()}] 已停止外部进程 (pid ${killed.join(', ')})`);
    return errors.length
      ? { ok: false, error: `部分进程停止失败: ${errors.join(', ')}` }
      : { ok: true };
  }

  stopAll(portsById = {}, cwdById = {}, optsById = {}) {
    const stopped = [];
    // 托管的直接杀
    for (const id of [...this.procs.keys()]) {
      if (this.stop(id, portsById[id] || [], cwdById[id] || '', optsById[id] || {}).ok) stopped.push(id);
    }
    // 非托管但端口在线的也一并处理
    for (const id of Object.keys(portsById)) {
      if (stopped.includes(id)) continue;
      const r = this.stop(id, portsById[id], cwdById[id] || '', optsById[id] || {});
      if (r.ok) stopped.push(id);
    }
    return stopped;
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

module.exports = { ProcessManager, probePort, parseShellCmd };
