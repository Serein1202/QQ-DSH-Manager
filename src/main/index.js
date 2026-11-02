// index.js — Electron 入口
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { registerIpc, pm } = require('./ipc');
const { settings } = require('./store');

let win = null;

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
  // 按设置决定：关闭软件时是否停掉由本软件拉起的服务
  if (settings().closeStopServices) {
    pm.stopAll();
  }
});
