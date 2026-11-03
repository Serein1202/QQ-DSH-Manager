// test-restart-e2e.js — 端到端验证真实 IPC 处理器（svc:start / svc:stop / svc:restart）
// 运行：node tools/test-restart-e2e.js
//
// 做法：用 Module._load 拦截 require('electron')，注入最小 stub；再替换 services.buildServiceList
// 为确定性桩（避免依赖本机是否装了 DSH / qq-bridge），然后直接调用 ipc.js 里注册的 handler。
// 覆盖：
//   A. 服务未运行时点「重启」——旧代码必然报「停止失败：服务未在运行」，现在必须能正常启动
//   B. 服务运行中点「重启」——必须换新 PID 且托管状态保持
//   F. 非托管进程（用户手动开的）点「停止」——必须能停掉（旧代码因未传 verify 停在「无法确认身份」）
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { probePort } = require('../src/main/procs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qdm-e2e-'));
const FAKE = path.join(TMP, '_fake-dsh.js');
const NODE = process.execPath;
const PORT = 39810;

fs.writeFileSync(
  FAKE,
  `const net = require('net');
const port = Number(process.argv[2]);
const token = 'tok-' + Date.now().toString(36);
process.stdout.write('dsh web: http://127.0.0.1:' + port);
setTimeout(() => {
  process.stdout.write('/?token=' + token + '\\n');
  net.createServer(() => {}).listen(port, '127.0.0.1');
}, 100);
setInterval(() => {}, 1000);
`,
  'utf8'
);

// ---- electron stub ----
const handlers = new Map();
const fakeElectron = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 1 }) },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  app: {
    getPath: () => TMP,
    isPackaged: false,
    getVersion: () => '1.0.4',
    quit: () => {},
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

// ---- 确定性服务桩 ----
const services = require('../src/main/services.js');
const START_ORDER = services.START_ORDER;
const stubSvc = {
  id: 'dsh',
  name: 'DSH',
  desc: 'E2E 桩',
  startable: true,
  blockedReason: '',
  // shellCmd 里带 --expose-internals，与 services.js 里 DSH 的 verify 特征一致，
  // 这样非托管停止用例才能验证 verify 匹配链路
  run: {
    cwd: TMP,
    shellCmd: `"${NODE}" --expose-internals "${FAKE}" ${PORT}`,
    env: {},
    verify: ['--expose-internals'],
  },
  probePorts: [PORT],
  webLinks: [{ label: 'DSH Web API', url: `http://127.0.0.1:${PORT}`, port: PORT }],
};
services.buildServiceList = () => [stubSvc];

const ipc = require('../src/main/ipc.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${extra ? ' -> ' + extra : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本地实现：不依赖被测模块是否导出 isPidAlive，保证同一份用例能跑旧代码做对照
function isPidAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 4) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

async function waitPort(port, ms = 8000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (await probePort(port, '127.0.0.1', 200)) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  ipc.registerIpc();
  ok('IPC 处理器已注册（含 svc:restart）', handlers.has('svc:restart') && handlers.has('svc:stop'));

  const call = (ch, arg) => handlers.get(ch)(null, arg);

  console.log('\n== 用例 A：服务未运行时点「重启」必须能启动（旧代码报「停止失败」） ==');
  {
    ok('前置：端口空闲', !(await probePort(PORT, '127.0.0.1', 300)));
    const r = await call('svc:restart', 'dsh');
    ok('restart 返回 ok', r.ok === true, JSON.stringify(r));
    ok('端口已就绪', await waitPort(PORT));
    ok('托管状态为 true', ipc.pm.isRunning('dsh'));
  }

  console.log('\n== 用例 B：运行中重启必须换新 PID 且托管状态保持 ==');
  {
    const pid1 = ipc.pm.procs.get('dsh').pid;
    const r = await call('svc:restart', 'dsh');
    ok('restart 返回 ok', r.ok === true, JSON.stringify(r));
    const pid2 = ipc.pm.procs.get('dsh') && ipc.pm.procs.get('dsh').pid;
    ok('PID 已更换', !!pid2 && pid2 !== pid1, `old=${pid1} new=${pid2}`);
    ok('旧 PID 已退出', !isPidAlive(pid1));
    ok('重启后仍受托管（旧 exit 回调没清掉新记录）', ipc.pm.isRunning('dsh'));
    ok('端口在新进程上就绪', await waitPort(PORT));
    ok('token 已刷新为新进程的（不是过期 token）', /^tok-/.test(ipc.pm.getWebToken('dsh')), ipc.pm.getWebToken('dsh'));
    const l = await call('svc:list');
    ok('svc:list 显示 running=true 且 managed=true', l[0].running === true && l[0].managed === true, JSON.stringify(l[0]));
  }

  console.log('\n== 用例 C：非托管进程点「停止」必须能停掉（旧代码报「无法确认是本服务」） ==');
  {
    // 先停掉托管实例，再模拟用户手动启动一个（不经管理器）
    await call('svc:stop', 'dsh');
    await sleep(300);
    const ext = spawn(NODE, ['--expose-internals', FAKE, String(PORT)], { cwd: TMP, stdio: 'ignore', windowsHide: true });
    ok('外部实例已启动', await waitPort(PORT), `pid=${ext.pid}`);
    ok('管理器未托管该实例', ipc.pm.isRunning('dsh') === false);

    const r = await call('svc:stop', 'dsh');
    ok('stop 返回 ok', r.ok === true, JSON.stringify(r));
    await sleep(600);
    ok('外部进程已被杀掉', !isPidAlive(ext.pid));
    ok('端口已释放', !(await probePort(PORT, '127.0.0.1', 300)));
    try {
      ext.kill();
    } catch {}
  }

  console.log('\n== 用例 D：重复启动不叠加实例 ==');
  {
    const r1 = await call('svc:start', 'dsh');
    ok('首次启动 ok', r1.ok === true, JSON.stringify(r1));
    const r2 = await call('svc:start', 'dsh');
    ok('第二次启动识别为复用而非新开', r2.ok === true && r2.reused === true, JSON.stringify(r2));
    await call('svc:stop', 'dsh');
    await sleep(300);
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
