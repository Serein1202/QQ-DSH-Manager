// test-update-apply.js — 自动更新「下载完 → 覆盖 → 重启」链路守卫
//
// 复现过的真实故障：release zip 顶层是 QQ-DSH-Manager.exe + locales/ + resources/，
// 旧 unzip() 只要看到目录就把第一个目录(locales)的内容拷进 destDir，
// 结果 update-new 里只有一堆 .pak，找不到 exe，更新在下载 100% 后静默中断。
// 这里用两个真实 zip 布局跑一遍解压，并静态钉住替换脚本的关键不变量。
'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (extra ? '  → ' + extra : ''));
  }
}

// downloader -> detect -> store 会 require('electron')，这里注入最小 stub
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => ROOT } };
  }
  return origLoad.apply(this, arguments);
};
const { unzip } = require('../src/main/downloader.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qdm-upd-'));
function writeTree(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(base, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content, 'utf8');
  }
}
function makeZip(name, tree) {
  const src = path.join(TMP, name + '-src');
  const zip = path.join(TMP, name + '.zip');
  writeTree(src, tree);
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Compress-Archive -Path (Join-Path '${src.replace(/'/g, "''")}' '*') -DestinationPath '${zip.replace(/'/g, "''")}' -Force`,
  ], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error('造测试 zip 失败: ' + (r.stderr || r.stdout || ''));
  return zip;
}

console.log('== unzip：顶层「文件 + 多个目录」的 release zip ==');
{
  const zip = makeZip('root-layout', {
    'QQ-DSH-Manager.exe': 'EXE',
    'icudtl.dat': 'DATA',
    'locales/af.pak': 'PAK',
    'locales/en-US.pak': 'PAK',
    'resources/app.asar': 'ASAR',
  });
  const dest = path.join(TMP, 'out-root');
  unzip(zip, dest);
  ok('exe 在 dest 顶层', fs.existsSync(path.join(dest, 'QQ-DSH-Manager.exe')));
  ok('顶层散文件保留', fs.existsSync(path.join(dest, 'icudtl.dat')));
  ok('locales 子目录保留', fs.existsSync(path.join(dest, 'locales', 'af.pak')));
  ok('resources/app.asar 保留（更新完整性校验靠它）', fs.existsSync(path.join(dest, 'resources', 'app.asar')));
  ok('没有把 locales 的内容平铺到顶层', !fs.existsSync(path.join(dest, 'af.pak')));
}

console.log('\n== unzip：顶层只有一层外壳目录的 zip ==');
{
  const zip = makeZip('wrapper-layout', {
    'win-unpacked/QQ-DSH-Manager.exe': 'EXE',
    'win-unpacked/resources/app.asar': 'ASAR',
    'win-unpacked/locales/af.pak': 'PAK',
  });
  const dest = path.join(TMP, 'out-wrapper');
  unzip(zip, dest);
  ok('外壳被脱掉，exe 落到 dest 顶层', fs.existsSync(path.join(dest, 'QQ-DSH-Manager.exe')));
  ok('外壳目录本身不出现在 dest', !fs.existsSync(path.join(dest, 'win-unpacked')));
  ok('子目录结构保留', fs.existsSync(path.join(dest, 'resources', 'app.asar')));
}

console.log('\n== 替换脚本：必须等旧进程退出、可靠覆盖、能拉起新版 ==');
{
  const ipc = fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8');
  const dl = fs.readFileSync(path.join(ROOT, 'src/main/downloader.js'), 'utf8');
  // 剔除整行注释再判「不该出现」的代码，避免注释里解释旧 bug 的文字误伤
  const ipcBody = ipc.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok('不再用无控制台会失效的 timeout /t', !/timeout\s+\/t/.test(ipcBody));
  ok('不再用 xcopy', !/xcopy\s+\/e/.test(ipcBody));
  ok('用 robocopy /E 合并目录树', /robocopy\s+\$stage\s+\$root\s+\/E/.test(ipc));
  ok('robocopy 返回码 >=8 才算失败', /\$LASTEXITCODE\s+-ge\s+8/.test(ipc));
  ok('启动新版前轮询等待旧进程消失', /Get-Process\s+-Name\s+'QQ-DSH-Manager'/.test(ipc) && /Start-Process\s+-FilePath\s+\$exe/.test(ipc));
  ok('覆盖前校验 app.asar 完整性', /resources',\s*'app\.asar'/.test(ipc) || /resources.*app\.asar/.test(ipc));
  ok('unzip 只在「单目录且无顶层文件」时脱壳', /\$dirs\.Count\s+-eq\s+1\s+-and\s+\$files\.Count\s+-eq\s+0/.test(dl));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
