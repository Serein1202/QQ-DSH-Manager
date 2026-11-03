// test-restart.js — 重启链路回归测试（不依赖 Electron，直接驱动 ProcessManager）
// 运行：node tools/test-restart.js
// 覆盖 5 个曾经导致「DSH 重启后不可用」的缺陷：
//   1. 旧进程 exit 回调晚到，把新进程从托管表里删掉（竞态）
//   2. stop 之后不等 PID 消失就 start（抢端口 / 双实例）
//   3. 跨 chunk 的日志行被丢弃 → DSH token 捕获不到
//   4. 重启后 webTokens 里残留过期 token
//   5. stop 对未运行服务返回 notRunning，重启应继续而不是中止
'use strict';
const net = require('net');
const path = require('path');
const { ProcessManager, probePort, makeLineReader, isPidAlive } = require('../src/main/procs');

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

// 占用一个端口，返回 { port, close }
function listen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.destroy());
    srv.listen(port, '127.0.0.1', () => resolve({ port, close: () => new Promise((r) => srv.close(r)) }));
  });
}

async function freePort(start) {
  for (let p = start; p < start + 50; p++) {
    if (!(await probePort(p, '127.0.0.1', 200))) return p;
  }
  throw new Error('无可用端口');
}

// 一个模拟 DSH 的假服务：打印带 token 的启动行，然后长期运行
const FAKE_DSH = path.join(__dirname, '_fake-dsh.js');
function writeFakeDsh() {
  require('fs').writeFileSync(
    FAKE_DSH,
    `// 模拟 DSH web：先分两段打印 token 行（触发跨 chunk 解析），再监听端口
const net = require('net');
const port = Number(process.argv[2]);
const token = 'tok-' + Date.now().toString(36);
process.stdout.write('dsh web: http://127.0.0.1:' + port);
setTimeout(() => {
  process.stdout.write('/?token=' + token + '\\n');
  const s = net.createServer(() => {});
  s.listen(port, '127.0.0.1');
}, 120);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
    'utf8'
  );
}

async function main() {
  writeFakeDsh();
  const port = await freePort(39000);
  const pm = new ProcessManager();
  const run = { cwd: __dirname, command: process.execPath, args: [FAKE_DSH, String(port)], verify: ['_fake-dsh.js'] };

  console.log('\n== 用例 1：跨 chunk 的日志行必须被完整拼接（token 捕获） ==');
  {
    const r = pm.start('dsh', run);
    ok('start 返回 ok', r.ok === true, JSON.stringify(r));
    // 等端口就绪
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(await probePort(port, '127.0.0.1', 200))) await sleep(100);
    const tok = pm.getWebToken('dsh');
    ok('端口已监听（进程真的起来了）', await probePort(port, '127.0.0.1', 300));
    ok('跨 chunk 的 token 被完整捕获', /^tok-/.test(tok), `token="${tok}"`);
    ok('isRunning 为 true', pm.isRunning('dsh'));

    console.log('\n== 用例 2：stop 后必须等 PID 真正消失 ==');
    const stopR = pm.stop('dsh', [port], __dirname, { verify: run.verify });
    ok('stop 返回 ok', stopR.ok === true, JSON.stringify(stopR));
    ok('stop 返回了 PID 用于等待', Array.isArray(stopR.pids) && stopR.pids.length === 1, JSON.stringify(stopR.pids));
    const pid = stopR.pids[0];
    const gone = await pm.waitStopped(stopR.pids, 8000);
    ok('waitStopped 确认进程已退出', gone === true);
    ok('PID 确实不存在了', !isPidAlive(pid));
    ok('停止后 token 已清理（不留过期 token）', pm.getWebToken('dsh') === '', `残留 token="${pm.getWebToken('dsh')}"`);
  }

  console.log('\n== 用例 3：旧进程 exit 回调晚到，不能删掉新进程的托管记录 ==');
  {
    // 先起一个进程，然后不经过 exit 回调就强制替换：模拟 restart 的时序
    pm.start('dsh', run);
    await sleep(300);
    const oldChild = pm.procs.get('dsh');
    ok('第一代进程已登记', !!oldChild);

    // 手动杀掉但立刻重新 start（不 await exit 事件），复现竞态窗口
    pm.stop('dsh', [port], __dirname, { verify: run.verify });
    const r2 = pm.start('dsh', run);
    ok('第二代进程启动成功', r2.ok === true, JSON.stringify(r2));

    // 等旧 child 的 exit 回调派发完毕（若未修复，它会把新记录删掉）
    await sleep(1200);
    ok('旧 exit 回调没有清掉新进程的托管记录', pm.isRunning('dsh') === true, `procs.has=${pm.procs.has('dsh')}`);
    pm.stop('dsh', [port], __dirname, { verify: run.verify });
    await pm.waitStopped([r2.pid], 8000);
  }

  console.log('\n== 用例 4：对未运行的服务 stop 必须返回 notRunning（重启可继续） ==');
  {
    const p2 = await freePort(39100);
    const r = pm.stop('dsh', [p2], __dirname, { verify: run.verify });
    ok('stop 返回 ok=false', r.ok === false);
    ok('带 notRunning 标记', r.notRunning === true, JSON.stringify(r));
    ok('错误信息为「服务未在运行」', /未在运行/.test(r.error || ''), r.error);
  }

  console.log('\n== 用例 5：行缓冲器不吞半行、不丢尾部 ==');
  {
    const lines = [];
    const lr = makeLineReader((l) => lines.push(l));
    lr.push(Buffer.from('dsh web: http://127.0.0.1:3080'));
    lr.push(Buffer.from('/?token=abc123\n第二行\n半'));
    lr.push(Buffer.from('行结尾'));
    lr.flush();
    ok('第一行被完整拼出', lines[0] === 'dsh web: http://127.0.0.1:3080/?token=abc123', lines[0]);
    ok('第二行正常切分', lines[1] === '第二行', lines[1]);
    ok('flush 吐出没有换行的末尾行', lines[2] === '半行结尾', lines[2]);
  }

  console.log('\n== 用例 6：start 清掉残留的 userStopped 标记（否则崩溃被误判为用户停止） ==');
  {
    pm.userStopped.add('dsh'); // 模拟上一次 stop 的标记没被 exit 回调清掉
    pm.start('dsh', run);
    ok('start 后 userStopped 已清除', pm.userStopped.has('dsh') === false);
    const r = pm.start('dsh', run);
    ok('重复 start 被拒绝（不会叠加实例）', r.ok === false && /已在运行/.test(r.error), JSON.stringify(r));
    pm.stop('dsh', [port], __dirname, { verify: run.verify });
    await pm.waitStopped([pm.procs.get('dsh') ? pm.procs.get('dsh').pid : 0], 5000);
  }

  console.log('\n== 用例 7：stopAllSync 必须一次性下达全部 taskkill（退出路径不能漏杀） ==');
  {
    // 起两个假服务，验证同步批量停止会全部杀掉，而不是只杀掉第一个
    const pA = await freePort(39200);
    const pB = await freePort(39260);
    const A = pm.start('svcA', { cwd: __dirname, command: process.execPath, args: [FAKE_DSH, String(pA)], verify: ['_fake-dsh.js'] });
    const B = pm.start('svcB', { cwd: __dirname, command: process.execPath, args: [FAKE_DSH, String(pB)], verify: ['_fake-dsh.js'] });
    await sleep(500);
    const res = pm.stopAllSync({ svcA: [pA], svcB: [pB] }, { svcA: __dirname, svcB: __dirname }, { svcA: { verify: ['_fake-dsh.js'] }, svcB: { verify: ['_fake-dsh.js'] } });
    ok('两个服务都被停止', res.stopped.length === 2, JSON.stringify(res.stopped));
    const gone = await pm.waitStopped([A.pid, B.pid], 8000);
    ok('两个 PID 都已退出', gone === true);
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
