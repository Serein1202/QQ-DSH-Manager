// index.js — Electron 入口
'use strict';
const { app, BrowserWindow, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { registerIpc, stopAllServicesSync } = require('./ipc');
const { settings, updateSettings } = require('./store');

let win = null;
let tray = null;
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

  // 点窗口关闭按钮：按记住的行为直接执行，否则弹「最小化到托盘 / 退出」询问
  win.on('close', (e) => {
    if (quitting) return;
    const action = CLOSE_ACTIONS.has(settings().closeAction) ? settings().closeAction : 'ask';
    if (action === 'minimize') {
      e.preventDefault();
      hideToTray(); // 隐藏窗口（任务栏不显示），服务继续在后台运行
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

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- 托盘（右下角角标） ----
// 懒创建：第一次「最小化」时才出现，之后常驻，方便随时恢复窗口
function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  // tray.png 16x16 + tray@2x.png 32x32，nativeImage 按 DPI 自动配对 @2x
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('QQ-DSH-Manager');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  // Windows 下托盘单击默认弹菜单；显式绑定 click 让单击直接恢复窗口（菜单走右键）
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  return tray;
}

function hideToTray() {
  ensureTray();
  win.hide();
}

// 关闭询问对话框：最小化到托盘 / 完全退出，勾选「记住我的选择」后不再询问
async function promptCloseAction() {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: '关闭 QQ-DSH-Manager',
    message: '要最小化到托盘，还是完全退出？',
    detail:
      '最小化到托盘：窗口收进右下角托盘图标，任务栏不显示，所有服务继续在后台运行，单击托盘图标恢复。\n' +
      '完全退出：是否顺带停止服务，取决于「高级设置 → 关闭软件时停止服务」。',
    buttons: ['最小化到托盘', '完全退出'],
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
    hideToTray();
  }
}

// 单实例锁：程序已在托盘里时再次双击 exe，直接唤出已有窗口而不是开第二个实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

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
}
