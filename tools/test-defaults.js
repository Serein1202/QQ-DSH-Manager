// tools/test-defaults.js — 默认下载源守卫（离线，纯源码文本检查）
//
// 这些地址是「新电脑第一次点安装」唯一的入口，错了就是整条安装链路断在这里，
// 而界面不会报错——只会在下载阶段超时。所以用测试钉住，防止以后调别的地方时被顺手改回去。
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

const store = fs.readFileSync(path.join(ROOT, 'src/main/store.js'), 'utf8');

console.log('== 默认下载源仍可用 ==');
{
  // node 便携版是 npm install 的前置依赖，必须是 zip 直链
  ok('node 是 zip 直链', /node:\s*'https:\/\/npmmirror\.com\/mirrors\/node\/v[\d.]+\/node-v[\d.]+-win-x64\.zip'/.test(store));
  ok('snowluma / dsh 仍是网页地址（由用户到高级设置填 zip）', /snowluma:\s*'https:\/\//.test(store) && /dsh:\s*'https:\/\//.test(store));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
