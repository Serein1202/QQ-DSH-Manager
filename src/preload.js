// preload.js — 安全桥：渲染进程只能通过 window.api 调主进程
// 通道白名单：只放行 src/main/ipc.js 里实际注册的 handle 通道与事件推送通道，
// 防止渲染层被 XSS 后滥用任意 IPC（对应 update:install / config:write 等敏感 handler）。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 可 invoke 的通道（与 ipc.js registerIpc() 注册的 handle 一一对应）
const INVOKE_CHANNELS = new Set([
  'detect:all',
  'svc:list',
  'svc:start',
  'svc:stop',
  'svc:logs',
  'svc:restart',
  'svc:startAll',
  'svc:stopAll',
  'config:read',
  'config:write',
  'dl:install',
  'dl:openPage',
  'fix:npmInstall',
  'settings:get',
  'settings:set',
  'pick:dir',
  'shell:openExternal',
  'shell:openPath',
  'app:version',
  'update:check',
  'update:install',
  'snowluma:launchScan',
]);

// 可订阅的主进程推送通道
const EVENT_CHANNELS = new Set(['proc:log', 'proc:exit', 'proc:notice', 'dl:progress', 'dl:step', 'dl:done']);

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, payload) => {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error('非法 IPC 通道: ' + channel));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, cb) => {
    if (!EVENT_CHANNELS.has(channel)) return () => {};
    const wrapped = (_e, data) => cb(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
