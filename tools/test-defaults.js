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

  // snowluma 默认走 release 资产的 zip 直链（installComponent 用 /\.zip($|\?)/ 判断走下载还是跳网页）
  const SNOW = 'https://gh-proxy.org/https://github.com/Serein1202/Snowluma/releases/download/SnowLuma-v2.4.2-win-x64/SnowLuma-v2.4.2-win-x64.zip';
  ok('snowluma 常量值等于约定地址', store.includes(`'${SNOW}'`), SNOW);
  ok('snowluma 默认值引用常量', /snowluma:\s*SNOWLUMA_DEFAULT/.test(store));
  ok('snowluma 以 .zip 结尾（否则会走网页跳转分支）', SNOW.endsWith('.zip'));
  ok('snowluma 走 gh-proxy 加速前缀', /SNOWLUMA_DEFAULT\s*=\s*'https:\/\/gh-proxy\.org\/https:\/\/github\.com\//.test(store));
  ok('snowluma 指向 releases/download 资产', /\/releases\/download\//.test(SNOW));

  ok('dsh 仍是网页地址（官方无稳定 zip 直链）', /dsh:\s*'https:\/\//.test(store));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
