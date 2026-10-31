#!/bin/bash
set -u
app_package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
cd -- "$app_package" || exit 1
if [ ! -f "$app_package/app/launcher/mac-common.sh" ]; then
  printf 'Unzip the whole package first. 请先完整解压。\n' >&2
  exit 1
fi
. "$app_package/app/launcher/mac-common.sh"
if ! app_prepare_runtime; then app_pause; exit 1; fi
"$app_node" "$app_package/app/tools/get-weather-evidence.mjs" "$@"
app_exit=$?
if [ "$#" -eq 0 ]; then app_pause; fi
exit "$app_exit"
