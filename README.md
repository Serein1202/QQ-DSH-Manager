# QQ-DSH-Manager

给小白用的拟人化 AI 桌面部署管理器。管四样东西：**SnowLuma**（QQ 协议端）、**DSH**（DeepSeek Harness）、**qq-bridge**（桥接）、**ai-companion-kit**（记忆/手机MCP/空间）。

## 功能

| 页面 | 功能 |
|---|---|
| 环境检测 | 自动扫描组件目录（Node / SnowLuma / DSH / qq-bridge / companion-kit），红绿灯显示，缺什么点什么：一键下载解压 + npm install |
| 服务管理 | 每个服务启动/停止/重启 + Web 入口按钮（端口就绪才可点，直达 SnowLuma WebUI / DSH / bridge 控制台），实时日志，崩溃自动重启（可选），一键按依赖顺序全部启动（SnowLuma → DSH → bridge），SnowLuma 扫码登录引导 |
| 凭证配置 | 表单化编辑 qq-bridge 的 config.json（主人QQ、允许群号、DSH/SnowLuma 凭证等）和 SnowLuma 的 runtime.json / onebot_*.json，保存前自动备份 .bak |
| 高级设置 | 组件目录手动指定、DSH 启动命令、各下载源地址、管理器更新清单、关闭软件时是否停服务 |

## 运行

**最省事：双击 `启动.bat`**（首次会自动 npm install，之后直接拉起窗口；脚本内已清掉 `ELECTRON_RUN_AS_NODE`，避免 Electron 退化成纯 Node 直接退出）

命令行方式：

```bash
cd QQ-DSH-Manager
npm install          # 已配 npmmirror + electron 镜像，国内可直接装
npm start            # 启动软件
```

## 打包（两种都要就跑这一条）

```bash
npm run dist             # 同时产出 NSIS 安装器 + 便携版 exe
npm run dist:installer   # 只出安装器
npm run dist:portable    # 只出便携版
```

产物在 `release/` 目录。

## 首次部署流程（小白视角）

1. 双击打开软件 → 首页自动检测
2. 缺 qq-bridge / companion-kit → 点"一键下载安装"（走 gh-proxy 加速，自动 npm install）
3. 缺 SnowLuma / DSH → 官网下载解压后，在"高级设置"里指定目录（或直接在高级设置里填 zip 直链，之后就能一键装）
4. SnowLuma 首次登录：点首页"打开扫码窗口"扫码
5. "凭证配置"页填 QQ 号 / 群号 / authToken → 保存
6. "服务管理"页点"🚀 一键全部启动"
7. "Web 入口"页点链接进各 WebUI

## DSH 插件市场更新失败（spawn … ENOENT）

现象：在 DSH 市场里更新插件，报

```
<插件> 更新失败，且更新前的构建未能验证恢复（spawn C:\…\DeepSeek Harness\DeepSeek Harness.exe ENOENT）
```

原因：DSH 的 3080 端口属于 `web` profile，必须用 `dsh web` 启动，而 dsh 的 CLI 入口在 `resources/app.asar` 里。市场更新插件时会 spawn 子进程执行 `dsh add`，并把子进程的工作目录设成 CLI 入口所在目录——**asar 内的路径是 Electron 的虚拟路径，操作系统无法 chdir 进去**，于是 CreateProcess 失败，Node 报 ENOENT。更新失败后又用同一条链路回滚，所以回滚也"无法验证"。

解决：把 CLI 提取到磁盘真实路径，管理器会自动优先使用它。

```bash
node tools/extract-dsh-cli.js
```

默认从 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar` 提取到 `~/.dsh/desktop-cli/dsh`（约 440MB，30 秒左右），完成后重启 DSH 即可。DSH 大版本升级后重跑一次。

## 目录结构

```
QQ-DSH-Manager/
├── package.json               # electron + electron-builder
├── electron-builder.yml       # nsis + portable 双打包配置
├── .npmrc                     # npmmirror 镜像
└── src/
    ├── preload.js             # contextBridge 安全桥
    ├── main/
    │   ├── index.js           # 入口：窗口 + 退出清理
    │   ├── store.js           # 设置持久化（userData/settings.json）
    │   ├── detect.js          # 组件检测（目录模糊匹配 + node 版本）
    │   ├── procs.js           # 进程管理（spawn/taskkill树杀/日志/端口探活）
    │   ├── services.js        # 服务注册表（启动命令/探活端口/Web链接）
    │   ├── downloader.js      # 下载（重定向/进度）+ 解压 + npm install
    │   └── ipc.js             # IPC 路由 + 安装流程编排
    └── renderer/              # 零构建原生 JS 界面
        ├── index.html
        ├── style.css
        └── app.js
```

## 关键假设（可在软件里改）

- **扫描根目录**：打包版默认 exe 所在目录；开发版默认本目录上两级。高级设置可改。
- **DSH**：官方成品，启动命令不通用，需在高级设置里填（如 `start.bat`），端口默认 3080。
- **SnowLuma / DSH 下载地址**：官网直链未预置（避免写死失效地址），高级设置里填 zip 直链即可启用一键下载；qq-bridge / companion-kit 已预置 gh-proxy 加速的 GitHub 地址。
- **Node 版本要求**：qq-bridge ≥22.13；SnowLuma 优先用其目录自带的 node.exe。

