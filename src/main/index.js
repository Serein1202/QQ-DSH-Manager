// index.js — Electron 入口
'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { registerIpc, stopAllServicesSync } = require('./ipc');
const { settings, updateSettings } = require('./store');

let win = null;
// 是否处于「确认要退出」状态。两个来源会置位：
// 1) 用户在关闭询问对话框里选了退出 / 设置里记住的关闭行为是退出
// 2) app.quit() 触发的 before-quit（自动更新重启走这条路）
// 置位后 close 事件直接放行，不再弹询问，避免退出被拦截或重复弹窗
let quitting = false;

const CLOSE_ACTIONS = new Set(['ask', 'minimize', 'exit']);

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: 'QQ-DSH-Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 点窗口关闭按钮：按记住的行为直接执行，否则弹「最小化 / 退出」询问
  win.on('close', (e) => {
    if (quitting) return;
    const action = CLOSE_ACTIONS.has(settings().closeAction) ? settings().closeAction : 'ask';
    if (action === 'minimize') {
      e.preventDefault();
      win.minimize(); // 程序留在任务栏，服务继续在后台运行
      return;
    }
    if (action === 'exit') {
      quitting = true; // 放行 close → window-all-closed → quit
      return;
    }
    e.preventDefault();
    promptCloseAction();
  });
}

// 关闭询问对话框：最小化 / 完全退出，勾选「记住我的选择」后不再询问
async function promptCloseAction() {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: '关闭 QQ-DSH-Manager',
    message: '要最小化程序，还是完全退出？',
    detail:
      '最小化：程序缩小到任务栏，所有服务继续在后台运行。\n' +
      '完全退出：是否顺带停止服务，取决于「高级设置 → 关闭软件时停止服务」。',
    buttons: ['最小化', '完全退出'],
    defaultId: 0,
    checkboxLabel: '记住我的选择（之后可在高级设置里修改）',
    checkboxChecked: false,
    noLink: true,
  });
  if (win.isDestroyed()) return;
  const exit = r.response === 1;
  if (r.checkboxChecked) updateSettings({ closeAction: exit ? 'exit' : 'minimize' });
  if (exit) {
    quitting = true;
    app.quit();
  } else {
    // 对话框被 ESC / 关闭按钮 dismiss 时 response 不是 1，一律按最小化处理（不误退）
    win.minimize();
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  quitting = true;
  // 按设置决定：关闭软件时是否停掉由本软件拉起的服务
  // 用同步版本：before-quit 是同步钩子，异步 stopAll 里的 await 会中断后续服务的停止
  if (settings().closeStopServices) {
    stopAllServicesSync();
  }
});
