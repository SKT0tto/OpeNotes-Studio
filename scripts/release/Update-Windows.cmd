@echo off
setlocal
chcp 65001 >nul
title OpeNotes Studio Update

rem Options: --check = only look for a new version, --yes = do not ask, --rollback = undo the last update,
rem --from-zip <file> = update from a zip you downloaded yourself. OPENOTES_NO_PAUSE=1 skips the final pause.
rem The script runs from the folder it lives in, so a relative --from-zip path means your current folder.

echo.
echo  OpeNotes Studio 更新
echo  ====================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 goto oldnode
goto run

:nonode
echo  [错误] 没有找到 Node.js。请先安装 Node.js 22 或更高版本（LTS）：
echo         https://nodejs.org
goto fail

:oldnode
echo  [错误] Node.js 版本过低（需要 22 或更高）：
node -v
echo  请从 https://nodejs.org 安装最新的 LTS 版本。
goto fail

:fail
echo.
if not defined OPENOTES_NO_PAUSE pause
exit /b 1

:run
rem This block is read by cmd as a whole and ends with exit, so replacing this file while it runs is safe.
(
  node "%~dp0scripts\update.mjs" %*
  call set "RC=%%errorlevel%%"
  echo.
  if not defined OPENOTES_NO_PAUSE pause
  call exit /b %%RC%%
)
