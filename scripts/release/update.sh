#!/usr/bin/env bash
# OpeNotes Studio updater for macOS / Linux.
# Options: --check (only look), --yes (no prompt), --rollback (undo the last update), --from-zip <file> (update from a downloaded zip).
# Runs from the folder it lives in; a relative --from-zip path means your current folder.

echo
echo " OpeNotes Studio 更新"
echo " ===================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo " [错误] 没有找到 Node.js。请先安装 Node.js 22 或更高版本（LTS）：https://nodejs.org"
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"; then
  echo " [错误] Node.js 版本过低（需要 22 或更高）：$(node -v)"
  exit 1
fi
exec node "$(dirname "$0")/scripts/update.mjs" "$@"
