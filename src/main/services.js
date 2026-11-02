// services.js — 服务注册表：每个服务的启动命令构造、探活端口、WebUI 链接
'use strict';
const fs = require('fs');
const path = require('path');
const { settings, defaultScanRoot } = require('./store');
const { detectAll, findNode, exists } = require('./detect');

// 读 qq-bridge 的 config.json 拿端口/token（读失败不阻塞，返回默认值）
function readQbConfig(qbDir) {
  const out = { consolePort: 3100, consoleToken: '', snowlumaHomeDir: '', dshBasePort: 0 };
  if (!qbDir) return out;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(qbDir, 'config.json'), 'utf8'));
    out.consolePort = Number(cfg.consolePort) || 3100;
    out.consoleToken = cfg.consoleToken || '';
    out.snowlumaHomeDir = (cfg.snowluma && cfg.snowluma.homeDir) || '';
    // dsh.baseUrl 形如 http://127.0.0.1:3080 → 解析端口作为 DSH 探活依据
    const m = /:(\d+)\s*\/?$/.exec((cfg.dsh && cfg.dsh.baseUrl) || '');
    if (m) out.dshBasePort = Number(m[1]) || 0;
  } catch {}
  return out;
}

// 读 SnowLuma runtime.json 拿 WebUI 端口
function readSnowRuntime(snowDir) {
  const out = { webuiPort: 5099 };
  if (!snowDir) return out;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(snowDir, 'config', 'runtime.json'), 'utf8'));
    out.webuiPort = Number(cfg.webuiPort) || 5099;
  } catch {}
  return out;
}

function buildServiceList() {
  const d = detectAll();
  const s = settings();
  const qb = readQbConfig(d.qqbridge.dir);
  const snow = readSnowRuntime(d.snowluma.dir);

  const list = [];

  // SnowLuma：优先用它目录里自带的 node.exe，其次系统/便携 node
  {
    const node = exists(path.join(d.snowluma.dir || '', 'node.exe'))
      ? path.join(d.snowluma.dir, 'node.exe')
      : (findNode('').path || 'node');
    list.push({
      id: 'snowluma',
      name: 'SnowLuma',
      desc: 'QQ 协议端（OneBot v11）',
      startable: !!d.snowluma.entry,
      blockedReason: d.snowluma.state === 'missing' ? '未检测到 SnowLuma，先去首页安装' : '',
      run: { cwd: d.snowluma.dir, command: node, args: ['index.mjs'], verify: ['index.mjs'] },
      probePorts: [3000, snow.webuiPort],
      webLinks: [
        { label: 'SnowLuma WebUI', url: `http://127.0.0.1:${snow.webuiPort}`, port: snow.webuiPort },
      ],
    });
  }

  // DSH：3080 由 web profile 的 web-server 插件提供，必须 `dsh web` 启动
  // （双击桌面 exe 只起 desktop profile，只有 GUI、不监听端口）
  {
    const dshExe = d.dsh.exe || '';
    const cli = d.dsh.cli || '';
    const ws = d.dsh.workspace || d.dsh.dir || '';
    // 探活端口优先从 qq-bridge 的 dsh.baseUrl 解析（那是 bridge 实际连的地址）
    let dshPort = (s.components.dsh && s.components.dsh.port) || 3080;
    try {
      const qbCfg = readQbConfig(d.qqbridge.dir);
      if (qbCfg.dshBasePort) dshPort = qbCfg.dshBasePort;
    } catch {}

    // 用户手填的命令优先；否则用 exe + asar 内 CLI 跑 web profile
    const autoCmd =
      dshExe && cli ? `"${dshExe}" --expose-internals "${cli}" web --port ${dshPort} --no-open` : '';
    const cmd = (s.components.dsh && s.components.dsh.startCommand) || autoCmd;

    list.push({
      id: 'dsh',
      name: 'DSH',
      desc: 'DeepSeek Harness（Agent 大脑）',
      startable: !!cmd,
      blockedReason: !dshExe
        ? '未找到 DSH，先去官网下载安装（首页可打开下载页）'
        : !cmd
          ? '已安装但找不到 dsh CLI（app.asar 缺失），请重装 DSH 或在"高级设置"手填启动命令'
          : '',
      run: {
        cwd: ws,
        shellCmd: cmd,
        // 只要是拿 DSH 的 Electron 本体执行 JS（不管入口在 asar 内还是磁盘上），
        // 都必须 ELECTRON_RUN_AS_NODE=1，否则它会当成桌面应用去开窗口而不是执行 CLI
        env: /\.exe"/i.test(cmd) ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        // 停止时用于确认进程身份（端口反查防误杀）：exe 名或 CLI 特征
        verify: [dshExe ? path.basename(dshExe) : '', '--expose-internals'].filter(Boolean),
      },
      probePorts: [dshPort],
      webLinks: [{ label: 'DSH Web API', url: `http://127.0.0.1:${dshPort}`, port: dshPort }],
    });
  }

  // qq-bridge（手机 MCP / QQ 空间作为附属服务，随它一起启停，不单独占用卡片）
  // ai-companion-kit 已整合进 qq-bridge，附属服务统一从 qq-bridge 目录运行
  {
    const node = findNode(d.qqbridge.dir).path || 'node';
    const companions = [];
    if (d.qqbridge.dir) {
      companions.push(
        {
          id: 'qqbridge-phone',
          name: '手机 MCP',
          run: { cwd: d.qqbridge.dir, command: node, args: ['packages/phone-mcp/src/phone-mcp.js'], verify: ['phone-mcp.js'] },
        },
        {
          id: 'qqbridge-qzone',
          name: 'QQ 空间',
          run: { cwd: d.qqbridge.dir, command: node, args: ['packages/qzone/open-zone.mjs'], verify: ['open-zone.mjs'] },
        }
      );
    }
    list.push({
      id: 'qqbridge',
      name: 'qq-bridge',
      desc: 'QQ ↔ DSH 桥接',
      startable: !!d.qqbridge.entry,
      blockedReason: d.qqbridge.state === 'missing' ? '未检测到 qq-bridge，先去首页安装' : d.qqbridge.state === 'warn' ? d.qqbridge.detail : '',
      run: { cwd: d.qqbridge.dir, command: node, args: ['src/bridge.js'], verify: ['bridge.js'] },
      probePorts: [qb.consolePort],
      companions,
      companionHint: companions.length ? `含 ${companions.map((c) => c.name).join(' / ')}，随桥接一起启停` : '',
      webLinks: [
        {
          label: 'bridge 控制台',
          url:
            `http://127.0.0.1:${qb.consolePort}` + (qb.consoleToken ? `/?token=${qb.consoleToken}` : ''),
          port: qb.consolePort,
        },
      ],
    });
  }

  return list;
}

// 一键全部启动顺序：snowluma -> dsh -> qqbridge（companion-kit 服务不参与默认顺序）
const START_ORDER = ['snowluma', 'dsh', 'qqbridge'];

module.exports = { buildServiceList, readQbConfig, readSnowRuntime, START_ORDER };
