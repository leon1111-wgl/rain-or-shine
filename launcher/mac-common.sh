#!/bin/bash
# START-MAC.command and GET-WEATHER.command source this file. It works with the Bash 3.2 in macOS.
app_pause() {
  if [ -t 0 ]; then
    printf '\nPress Return to close. 按回车关闭。'
    IFS= read -r app_reply || true
  fi
}

app_prepare_runtime() {
  if [ "$(uname -s)" != "Darwin" ]; then
    printf 'This package is for macOS. 此包只能在 macOS 上运行。\n' >&2
    return 1
  fi
  app_version=$(sw_vers -productVersion) || return 1
  app_major=${app_version%%.*}
  app_minor=${app_version#*.}
  app_minor=${app_minor%%.*}
  case "$app_major:$app_minor" in
    *[!0-9:]*|:*|*:) printf 'Unknown macOS version: %s. 无法识别 macOS 版本。\n' "$app_version" >&2; return 1 ;;
  esac
  if [ "$app_major" -lt 13 ] || { [ "$app_major" -eq 13 ] && [ "$app_minor" -lt 5 ]; }; then
    printf 'This package needs macOS 13.5 or later. This Mac has %s. 需要 macOS 13.5 或更新版本。\n' "$app_version" >&2
    return 1
  fi
  app_arch=$(cat "$app_package/app/runtime/architecture") || return 1
  app_cpu=$(uname -m)
  # A Terminal running under Rosetta still belongs to an Apple silicon Mac.
  if [ "$app_cpu" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    app_cpu=arm64
  fi
  case "$app_arch:$app_cpu" in
    arm64:arm64|x64:x86_64) ;;
    *) printf 'This package is for %s, but this Mac is %s. Use arm64 for Apple silicon and x64 for Intel.\n芯片类型不匹配：Apple 芯片用 arm64，Intel 用 x64。\n' "$app_arch" "$app_cpu" >&2; return 1 ;;
  esac
  app_node="$app_package/app/runtime/node"
  if [ ! -f "$app_node" ]; then
    printf 'The runtime is missing. Unzip the whole package and try again. 缺少运行文件，请完整解压后再试。\n' >&2
    return 1
  fi
  if [ ! -x "$app_node" ]; then
    chmod u+x "$app_node" || return 1
  fi
}
