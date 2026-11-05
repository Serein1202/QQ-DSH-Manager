// tools/test-release-config.js — 打包配置守卫（离线，纯文本检查，不依赖 yaml 解析器）
//
// 目的：Release 只允许产出 zip。这条约束分散在三个文件里
// （electron-builder.yml / .github/workflows/release.yml / package.json scripts），
// 任何一处被改回去都会静默产出 exe 资产，而 exe 资产会让软件内自动更新失效
// （portable 自解压到 %TEMP% 随机目录、NSIS 装 Program Files 不可写）。
// 所以用一个守门测试把它们钉住。
'use strict';
const fs = require('fs');
const path = require('path');

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

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('== electron-builder.yml ==');
{
  const y = read('electron-builder.yml');
  // 去掉注释行再判断，避免注释里出现的 nsis / portable 字样误伤
  const body = y
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  ok('win.target 只声明 zip', /win:[\s\S]*?target:\s*\n\s*-\s*target:\s*zip\b/.test(body), body);
  ok('没有 nsis 目标', !/-\s*target:\s*nsis\b/i.test(body));
  ok('没有 portable 目标', !/-\s*target:\s*portable\b/i.test(body));
  ok('没有 nsis: 配置段', !/^nsis:/m.test(body));
  ok('没有 portable: 配置段', !/^portable:/m.test(body));
  ok('artifactName 带版本号与扩展名', /artifactName:.*\$\{version\}.*\$\{ext\}/.test(body), body);
  ok('files 覆盖 src 与 package.json', /src\/\*\*/.test(body) && /package\.json/.test(body));
}

console.log('\n== .github/workflows/release.yml ==');
{
  const w = read('.github/workflows/release.yml');
  // 注释行同样剔除，`release/*.exe` 在注释里出现不算违规
  const body = w
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  ok('构建命令指定 zip 目标', /electron-builder\s+--win\s+zip\b/.test(body), body);
  ok('不再上传 exe 资产', !/release\/\*\.exe/.test(body));
  ok('上传 zip 资产', /release\/\*\.zip/.test(body));
  ok('用仓库内 electron-builder.yml', /--config\s+electron-builder\.yml/.test(body));
  // 旧实现用 pwsh here-string 内联生成配置，${productName} 会被 PowerShell 当变量展开成空串
  ok('不内联生成 electron-builder.ci.yml', !/electron-builder\.ci\.yml\s*$/m.test(body.replace(/--config\s+electron-builder\.yml/g, '')));
}

console.log('\n== package.json scripts ==');
{
  const pkg = JSON.parse(read('package.json'));
  const s = pkg.scripts || {};
  ok('dist 指向 zip', /--win\s+zip/.test(String(s.dist || '')), s.dist);
  ok('不再有 dist:installer', !('dist:installer' in s));
  ok('不再有 dist:portable', !('dist:portable' in s));
}

console.log('\n== src 侧资产解析 ==');
{
  const ipc = read('src/main/ipc.js');
  // update:check 的返回体里不应再出现 installer/portable 字段
  const block = ipc.slice(ipc.indexOf('async function fetchManagerRelease'));
  ok('fetchManagerRelease 只解析 zip', /zip:\s*find\(\/\\\.zip\$\/i\)/.test(block) && !/installer:\s*find/.test(block.split('update:check')[0]), 'fetchManagerRelease 资产解析');
  ok('update:install 白名单只含 zip', /const allowed = \[rel\.zip\]\.filter\(Boolean\)/.test(ipc));
  ok('update:install 以 exe 所在目录为替换目标', /path\.dirname\(app\.getPath\('exe'\)\)/.test(ipc));
  const app = read('src/renderer/app.js');
  ok('渲染层只取 r.zip', !/r\.zip \|\| r\.installer/.test(app));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
