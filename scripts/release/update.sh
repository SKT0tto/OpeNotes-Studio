#!/usr/bin/env bash
# OpeNotes Studio updater for macOS / Linux. Options: --check (only look), --yes (no prompt), --rollback (undo the last update).
cd "$(dirname "$0")" || exit 1

echo
echo " OpeNotes Studio 更新"
echo " ===================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo " [错误] 没有找到 Node.js。请先安装 Node.js 22 或更高版本（LTS）：https://nodejs.org"
  exit 1
fi
exec node scripts/update.mjs "$@"
