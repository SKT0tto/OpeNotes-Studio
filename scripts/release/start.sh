#!/usr/bin/env bash
# OpeNotes Studio launcher for macOS / Linux.
# Options (for automation): --yes = accept the Live2D licence and download the Core without asking,
# --no-core = skip it, --no-browser = do not open the browser.
cd "$(dirname "$0")" || exit 1

core_arg=""
for a in "$@"; do
  case "$a" in
    --yes) core_arg="--yes" ;;
    --no-core) core_arg="--no-core" ;;
    --no-browser) export OPENOTES_NO_BROWSER=1 ;;
  esac
done

echo
echo " OpeNotes Studio"
echo " ==============="
echo

if ! command -v node >/dev/null 2>&1; then
  echo " [错误] 没有找到 Node.js。请先安装 Node.js 22 或更高版本（LTS）：https://nodejs.org"
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"; then
  echo " [错误] Node.js 版本过低（需要 22 或更高）：$(node -v)"
  echo " 请从 https://nodejs.org 安装最新的 LTS 版本。"
  exit 1
fi

if ! node scripts/launch.mjs deps-ok; then
  echo " 首次运行（或升级后）正在安装依赖，需要联网，请稍候 ..."
  if ! npm ci --omit=dev; then
    echo " [错误] 依赖安装失败。请检查网络连接后重试。"
    exit 1
  fi
  node scripts/launch.mjs deps-stamp
fi

node scripts/fetch-core.mjs $core_arg
echo
exec node scripts/launch.mjs
