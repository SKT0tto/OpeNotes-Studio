@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title OpeNotes Studio 更新
cd /d "%~dp0"

rem 用法：双击检查并更新；命令行可加参数 --check（只检查）、--yes（不再询问）、--rollback（还原上一次更新）。
rem 整段放在括号里：cmd 会先整体读入，更新过程中替换本文件也不会出错。
(
  echo.
  echo  OpeNotes Studio 更新
  echo  ====================
  echo.
  where node >nul 2>nul
  if errorlevel 1 (
    echo  [错误] 没有找到 Node.js。请先安装 Node.js 22 或更高版本（LTS）：https://nodejs.org
    set "RC=1"
  ) else (
    node scripts\update.mjs %*
    set "RC=!errorlevel!"
  )
  echo.
  if not defined OPENOTES_NO_PAUSE pause
  exit /b !RC!
)
