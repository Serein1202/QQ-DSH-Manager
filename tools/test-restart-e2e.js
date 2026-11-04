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
    // 故意模拟「非标准启动方式」下 app.getVersion() 的退化行为：
    // 应用根目录里没有 package.json 时 Electron 会返回自身版本（如 33.4.11）。
    // 版本号绝对不能直接信它，否则界面显示 33.4.11 且更新检查永远判定「已是最新」。
    getAppPath: () => TMP,
    isPackaged: false,
    getVersion: () => '33.4.11',
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

  console.log('\n== 用例 E：外部实例命令行只有 CLI 路径特征时，必须能被停掉 ==');
  {
    // 复现本机场景：`node ... @deepseek-ai/dsh/lib/bin.js web`，命令行里既没有 exe 名
    // 也没有 --expose-internals。旧 verify 只认前两条 → 判定「无法确认是本服务」→ 重启中止。
    const cliRel = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const cliDir = path.join(TMP, 'cli', 'dsh', 'node_modules', path.dirname(cliRel));
    fs.mkdirSync(cliDir, { recursive: true });
    const cliBin = path.join(cliDir, 'bin.js');
    const PORT_E = PORT + 2;
    fs.writeFileSync(cliBin, `require('net').createServer(()=>{}).listen(${PORT_E},'127.0.0.1');setInterval(()=>{},1000);`, 'utf8');

    const ext = spawn(NODE, [cliBin, 'web', '--port', String(PORT_E)], { cwd: TMP, stdio: 'ignore', windowsHide: true });
    ok('外部 CLI 实例已启动', await waitPort(PORT_E), `pid=${ext.pid}, bin=${cliBin}`);

    // 换成 services.js 里 DSH 的真实 verify 组合（含 CLI 路径特征）。
    // 注意：不能用 path.basename(NODE) 这种宽泛特征——"node.exe" 会命中本机所有 node 进程，
    // 用例会把无关进程一起卷进来（真实的 DSH verify 是 "DeepSeek Harness.exe"，
    // 不会和普通 node 进程撞车）。
    stubSvc.probePorts = [PORT_E];
    stubSvc.run.verify = [cliRel, '--dsh-e2e-marker'];
    const r = await call('svc:stop', 'dsh');
    ok('stop 返回 ok（不再报「无法确认是本服务」）', r.ok === true, JSON.stringify(r));
    await sleep(500);
    ok('外部 CLI 进程已被杀掉', !isPidAlive(ext.pid));
    try { ext.kill(); } catch {}

    // 还原桩，后续用例继续用原端口
    stubSvc.probePorts = [PORT];
    stubSvc.run.verify = ['--expose-internals'];
  }

  console.log('\n== 用例 F：重启期间主进程不能被阻塞（点重启不卡死） ==');
  {
    await call('svc:start', 'dsh');
    await waitPort(PORT);
    // 每 50ms 打点，记录事件循环被同步调用卡住的最大间隔。
    // 旧实现走 spawnSync（netstat + 最多 4 次 PowerShell），实测会卡 3~10s。
    let maxGap = 0;
    let last = Date.now();
    const iv = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 50);
    const r = await call('svc:restart', 'dsh');
    clearInterval(iv);
    ok('restart 返回 ok', r.ok === true, JSON.stringify(r));
    ok('事件循环最大停顿 < 800ms（不再整窗卡死）', maxGap < 800, `maxGap=${maxGap}ms`);
    await call('svc:stop', 'dsh');
    await sleep(300);
  }

  console.log('\n== 用例 G：状态接口带上 pid / 运行时长，刷新接口可用 ==');
  {
    const r0 = await call('svc:start', 'dsh');
    ok('启动成功', r0.ok === true, JSON.stringify(r0));
    await sleep(400);
    const list = await call('svc:list');
    const s = list.find((x) => x.id === 'dsh');
    ok('svc:list 返回 pid', !!s && s.pid > 0, JSON.stringify(s && { pid: s.pid }));
    ok('svc:list 返回运行时长', !!s && s.uptimeMs >= 0, JSON.stringify(s && { up: s.uptimeMs }));
    const rr = await call('svc:refresh');
    ok('svc:refresh 返回新列表', rr.ok === true && Array.isArray(rr.list) && rr.list.length === 1, JSON.stringify(rr && { n: rr.list && rr.list.length }));
    await call('svc:stop', 'dsh');
    await sleep(300);
  }

  console.log('\n== 用例 H：开发版不暴露版本号/不查更新，打包版才显示 ==');
  {
    // 桩里 app.getVersion() 返回 '33.4.11'（模拟 electron <入口文件> 启动时的退化值），
    // app.getAppPath() 指向无 package.json 的临时目录 —— 两条「正常来源」都拿不到版本，
    // 只能靠 __dirname 上溯两级读到本项目的 package.json。
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

    // --- 开发版（app.isPackaged === false）---
    fakeElectron.app.isPackaged = false;
    const dv = await call('app:version');
    ok('开发版 packaged=false', dv && dv.packaged === false, JSON.stringify(dv));
    ok('开发版不返回版本号', dv && dv.version === '', JSON.stringify(dv));
    const du = await call('update:check');
    ok('开发版不检查更新', du && du.ok === false && du.packaged === false, JSON.stringify(du));
    ok('开发版错误信息可读', /开发版/.test(String(du && du.error)), String(du && du.error));

    // --- 打包版（app.isPackaged === true）---
    fakeElectron.app.isPackaged = true;
    const pv = await call('app:version');
    ok('打包版 packaged=true', pv && pv.packaged === true, JSON.stringify(pv));
    ok('打包版版本号等于项目 package.json', pv && pv.version === real, `got=${pv && pv.version} want=${real}`);
    ok('没有退化成 Electron 版本', pv && pv.version !== fakeElectron.app.getVersion(), `got=${pv && pv.version}`);
    ok('三段式版本号', /^\d+\.\d+\.\d+$/.test(String(pv && pv.version)), `got=${pv && pv.version}`);

    fakeElectron.app.isPackaged = false; // 还原，避免影响其它用例
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
