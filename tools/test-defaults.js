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

console.log('== qq-bridge 默认下载地址 ==');
{
  const want = 'https://gh-proxy.org/https://github.com/Serein1202/qq-bridge/archive/refs/heads/main.zip';
  ok('常量值等于约定地址', store.includes(`'${want}'`), want);
  ok('走 gh-proxy.org 代理前缀', /QQBRIDGE_DEFAULT\s*=\s*'https:\/\/gh-proxy\.org\//.test(store));
  ok('DEFAULT_DOWNLOADS.qqbridge 引用常量', /qqbridge:\s*QQBRIDGE_DEFAULT/.test(store));
  // installComponent 用 /\.zip($|\?)/i 判断是否走 zip 直链分支，结尾不是 .zip 就退化成"打开网页"
  ok('地址以 .zip 结尾（否则会走网页跳转分支）', want.endsWith('.zip'));

  // 老用户 settings.json 里存的是旧默认值，deepMerge 会一直用旧的，必须有迁移
  ok('保留旧默认值常量做识别', /QQBRIDGE_LEGACY\s*=\s*'https:\/\/github\.com\/Serein1202\/qq-bridge\/archive\/refs\/heads\/main\.zip'/.test(store));
  ok('loadSettings 里做迁移', /downloads\.qqbridge\s*===\s*QQBRIDGE_LEGACY/.test(store));
  ok('迁移只改「等于旧默认值」的项（不覆盖用户自定义）', /===\s*QQBRIDGE_LEGACY\)\s*\{[\s\S]{0,120}QQBRIDGE_DEFAULT/.test(store));
}

console.log('\n== 其余默认下载源仍可用 ==');
{
  // node 便携版是 npm install 的前置依赖，必须是 zip 直链
  ok('node 是 zip 直链', /node:\s*'https:\/\/npmmirror\.com\/mirrors\/node\/v[\d.]+\/node-v[\d.]+-win-x64\.zip'/.test(store));
  ok('snowluma / dsh 仍是网页地址（由用户到高级设置填 zip）', /snowluma:\s*'https:\/\//.test(store) && /dsh:\s*'https:\/\//.test(store));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
