#!/bin/bash
# Double-click this file in Finder; all paths are relative to this repository.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
/bin/bash "$root/scripts/start-desktop.sh" "$@"
result=$?
if [[ $result -ne 0 && -t 0 && -t 1 ]]; then
  printf '\n请查看上方错误。按回车关闭本次启动。'
  read -r _
fi
exit "$result"
