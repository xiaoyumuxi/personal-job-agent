#!/bin/bash
# Finder does not load nvm/Homebrew shell setup. Resolve tools explicitly.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fail() { printf '\n启动失败：%s\n' "$*" >&2; exit 1; }
mode="${1:-start}"
if [[ $# -gt 1 ]]; then fail "只接受 --rebuild、--check 或 --help 中的一个选项。"; fi
case "$mode" in
  --help)
    printf '%s\n' '用法：./scripts/start-desktop.sh [--rebuild | --check]' \
      '默认打开本机构建的 .app；首次运行自动安装依赖并构建。' \
      '--rebuild  重新安装锁定依赖并构建，再打开应用；请先退出客户端。' \
      '--check    仅检查本机应用和源码构建环境，不安装、不构建、不打开。'
    exit 0 ;;
  start|--rebuild|--check) ;;
  *) fail "未知选项；使用 --help 查看用法。" ;;
esac

[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail "客户端目前仅支持 macOS。"
case "$(/usr/bin/uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) fail "不支持当前芯片架构。" ;;
esac
app="$root/release/JobAgent-darwin-$arch/JobAgent.app"

app_ready() {
  [[ -x "$app/Contents/MacOS/JobAgent" &&
     -f "$app/Contents/Info.plist" &&
     -f "$app/Contents/Resources/app/dist/desktop/main.js" &&
     -f "$app/Contents/Resources/app/dist/desktop/worker.js" &&
     -f "$app/Contents/Resources/app/dist/src/cli.js" &&
     -f "$app/Contents/Resources/app/desktop-build/index.html" &&
     -f "$app/Contents/Resources/app/desktop-build/preload.cjs" &&
     -f "$app/Contents/Resources/app/desktop-build/renderer.js" &&
     -f "$app/Contents/Resources/app/desktop-build/style.css" &&
     -x "$app/Contents/Resources/.desktop-runtime/node" &&
     -x "$app/Contents/Resources/.desktop-runtime/keychain-helper" ]]
}

if [[ "$mode" == --rebuild ]] || ! app_ready; then
  if [[ "$mode" != --check ]] && /usr/bin/pgrep -x JobAgent >/dev/null; then
    fail "JobAgent 仍在运行。请先在客户端按 ⌘Q 退出，再重新构建；关闭窗口不等于退出。"
  fi

  shopt -s nullglob
  candidates=("$(command -v node || true)"
    /opt/homebrew/bin/node /opt/homebrew/opt/node@24/bin/node
    /usr/local/bin/node /usr/local/opt/node@24/bin/node
    "${VOLTA_HOME:-$HOME/.volta}/bin/node"
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node
    "$HOME"/.local/share/mise/installs/node/*/bin/node)
  node_bin=""
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then
      node_bin="$candidate"
      break
    fi
  done
  [[ -n "$node_bin" ]] || fail "未找到 Node.js 24+。请安装与本机架构匹配的 Node.js 24+（含 npm），再双击启动。"
  export PATH="$(dirname "$node_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
  [[ "$("$node_bin" -p 'process.arch')" == "$arch" ]] || fail "Node 架构与当前启动环境不一致，请使用 $arch 版本的 Node.js 或在对应架构环境中构建。"
  npm_bin="$(command -v npm || true)"
  [[ -n "$npm_bin" && -x "$npm_bin" ]] || fail "未找到 npm。请安装包含 npm 的 Node.js 24+。"
  /usr/bin/xcode-select -p >/dev/null 2>&1 || fail "缺少 Apple Command Line Tools。请先运行 xcode-select --install 完成安装。"

  if [[ "$mode" == --check ]]; then
    printf '%s\n' '尚无完整的本机 .app；Node、npm 和 Command Line Tools 已找到，可运行启动脚本进行构建。'
    exit 0
  fi

  printf '%s\n' '准备构建 JobAgent：将按 package-lock.json 安装依赖，首次运行需要联网并等待构建完成。'
  "$npm_bin" ci --cache "${TMPDIR:-/private/tmp}/jobagent-npm-cache" || fail "依赖安装失败，请检查上方 npm 错误和网络后重试。"
  "$npm_bin" run desktop:package || fail "应用构建失败，请检查上方错误后重试。"
  app_ready || fail "构建未生成完整的 .app，请检查构建输出。"
fi

if [[ "$mode" == --check ]]; then
  printf '本机应用已就绪：%s\n' "$app"
  exit 0
fi

printf '正在打开：%s\n' "$app"
/usr/bin/open "$app" || fail "macOS 未能打开应用。请在 Finder 中打开上方 .app 并查看系统提示。"
printf '%s\n' '已向 macOS 发出打开请求。客户端打开后可以关闭此终端窗口；退出客户端请使用 ⌘Q。'
