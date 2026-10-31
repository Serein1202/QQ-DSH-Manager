@echo off
chcp 65001 >nul
title AI 伴侣管理器 - 启动器
setlocal
cd /d "%~dp0"
set "APP_DIR=%~dp0"
set "ELECTRON=%APP_DIR%node_modules\electron\dist\electron.exe"

rem 清掉可能残留的 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成纯 Node 直接退出
set "ELECTRON_RUN_AS_NODE="

if not exist "%ELECTRON%" (
  echo [1/2] 首次运行，正在安装依赖，可能需要几分钟...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未找到 npm，请先安装 Node.js 18+ 后重试
    pause
    exit /b 1
  )
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)

if not exist "%ELECTRON%" (
  echo [错误] 未找到 Electron 可执行文件：
  echo         %ELECTRON%
  echo         请删除 node_modules 目录后重新运行本脚本
  pause
  exit /b 1
)

echo [2/2] 启动 AI 伴侣管理器...
rem 注意：不能传 "%APP_DIR%"——%~dp0 结尾的反斜杠会把引号转义掉（\" 被当成转义），
rem       Electron 会收到带杂引号的路径报 "Unable to find Electron app"。前面已 cd 到目录，直接传 . 即可。
rem 用 start 分离启动 + 立即退出，避免留下常驻黑窗口（关掉黑窗口会连带杀掉程序）
start "" "%ELECTRON%" .
exit /b 0
