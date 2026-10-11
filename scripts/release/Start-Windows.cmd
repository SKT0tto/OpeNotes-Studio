@echo off
setlocal
chcp 65001 >nul
title OpeNotes Studio
cd /d "%~dp0"

rem Options (for automation): --yes = accept the Live2D licence and download the Core without asking, --no-core = skip it,
rem --no-browser = do not open the browser.
set "CORE_ARG="
:args
if "%~1"=="" goto argsdone
if /i "%~1"=="--yes" set "CORE_ARG=--yes"
if /i "%~1"=="--no-core" set "CORE_ARG=--no-core"
if /i "%~1"=="--no-browser" set "OPENOTES_NO_BROWSER=1"
shift
goto args
:argsdone

echo.
echo  OpeNotes Studio
echo  ===============
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 goto oldnode
goto nodeok

:nonode
echo  [错误] 没有找到 Node.js。请先安装 Node.js 22 或更高版本（LTS）：
echo         https://nodejs.org
echo  安装完成后重新双击本文件。
goto fail

:oldnode
echo  [错误] Node.js 版本过低（需要 22 或更高）：
node -v
echo  请从 https://nodejs.org 安装最新的 LTS 版本后重新双击本文件。
goto fail

:nodeok
node scripts\launch.mjs deps-ok
if not errorlevel 1 goto depsok
echo  首次运行（或升级后）正在安装依赖，需要联网，请稍候 ...
call npm ci --omit=dev
if errorlevel 1 goto depsfail
node scripts\launch.mjs deps-stamp
:depsok

node scripts\fetch-core.mjs %CORE_ARG%
echo.
node scripts\launch.mjs
echo.
echo  服务已停止。
goto end

:depsfail
echo  [错误] 依赖安装失败。请检查网络连接后重试。
goto fail

:fail
echo.
if not defined OPENOTES_NO_PAUSE pause
exit /b 1

:end
if not defined OPENOTES_NO_PAUSE pause
exit /b 0
