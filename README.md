# QQ-DSH-Manager

给小白用的拟人化 AI 桌面部署管理器。管两样东西：**SnowLuma**（QQ 协议端）、**DSH**（DeepSeek Harness）。

## 功能

| 页面 | 功能 |
|---|---|
| 环境检测 | 自动扫描组件目录（Node / SnowLuma / DSH），红绿灯显示，缺什么点什么：一键下载解压 |
| 服务管理 | 每个服务启动/停止/重启 + Web 入口按钮（端口就绪才可点，直达 SnowLuma WebUI / DSH），实时日志，崩溃自动重启（可选），一键按依赖顺序全部启动（SnowLuma → DSH），SnowLuma 扫码登录引导 |
| 高级设置 | 组件目录手动指定、DSH 启动命令、各下载源地址、管理器更新清单、关闭按钮行为（询问/最小化到托盘/退出，可记住选择）、关闭软件时是否停服务 |

## 运行

**最省事：双击 `启动.bat`**（首次会自动 npm install，之后直接拉起窗口；脚本内已清掉 `ELECTRON_RUN_AS_NODE`，避免 Electron 退化成纯 Node 直接退出）

命令行方式：

```bash
cd QQ-DSH-Manager
npm install          # 已配 npmmirror + electron 镜像，国内可直接装
npm start            # 启动软件
```

## 打包（只出 zip）

```bash
npm run dist       # 产出 release/QQ-DSH-Manager-<版本>-win64.zip（解压即用目录）
npm run dist:dir   # 只出解压目录 release/win-unpacked，不打 zip（本地验证用，快很多）
```

产物在 `release/` 目录。

不发 NSIS 安装器和单文件 portable exe，原因：

- **单文件 exe** 每次运行都自解压到 `%TEMP%` 下的随机目录，程序真正运行的目录和你解压的目录不是同一个。软件内"检查更新"要按 exe 目录原地覆盖，结果覆盖不到正在运行的那份，新旧客户端并存，还可能出现关掉旧版发现没更新过的情况。
- **NSIS 安装器**默认装到 `Program Files`，普通账户对该目录没有写权限，自动更新必然 `Permission denied`。

zip 是就地解压运行，程序目录 == 你解压的目录，更新脚本能原地覆盖，链路才闭环。

软件内点"检查更新"后：下载 zip → 解压到程序目录的 `update-new/` → 校验 `QQ-DSH-Manager.exe` 与 `resources/app.asar` 齐全 → 生成 `cm-apply-update.ps1` 并退出 → 脚本等旧进程彻底退出后用 robocopy 覆盖、启动新版、自删。失败时程序目录会留下 `cm-update.log` / `update-new/`，看日志即可定位。

> **升级旧版本注意**：1.1.0 及更早的构建里解压逻辑有 bug（release zip 顶层同时有文件和多个目录时只拷了第一个目录），下载的更新包会找不到 exe，表现就是"下载 100% 后没反应"。这个 bug 只能靠**手动下载新 zip 覆盖一次目录**来跨过去（设置存在 userData，不会被覆盖）；覆盖之后软件内自动更新才恢复可用。

GitHub Actions（`.github/workflows/release.yml`）在 push 到 main 时自动递增 patch 版本号、打 zip、发 Release。

## 首次部署流程（小白视角）

1. 双击打开软件 → 首页自动检测
2. 缺 SnowLuma → 点"一键下载安装"（预置了 v2.4.2 release zip 直链，已套 gh-proxy 加速）；缺 DSH → 官网下载解压后，在"高级设置"里指定目录
3. SnowLuma 首次登录：点首页"打开扫码窗口"扫码
4. "服务管理"页点"🚀 一键全部启动"
5. "Web 入口"页点链接进各 WebUI

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
├── electron-builder.yml       # 打包配置（只出 zip）
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
- **SnowLuma 下载地址**：默认预置 GitHub release 的 zip 直链并套 `gh-proxy.org` 前缀（`SnowLuma-v2.4.2-win-x64.zip`）；升级版本时改 `src/main/store.js` 里的 `SNOWLUMA_DEFAULT` 即可，高级设置里也能随时换成自己的镜像。
- **DSH 下载地址**：官方无稳定 zip 直链，默认只打开官网，需手动下载后指定目录（也可在高级设置里填 zip 直链启用一键下载）。
- **Node 版本要求**：SnowLuma 优先用其目录自带的 node.exe。

