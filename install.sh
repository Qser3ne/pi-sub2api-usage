#!/usr/bin/env bash
# 把本仓库中的扩展软链到 ~/.pi/agent/extensions/
set -euo pipefail
TARGET="${HOME}/.pi/agent/extensions"
mkdir -p "$TARGET"
cd "$(dirname "$0")"
shopt -s nullglob
linked=0
for d in */; do
  case "$d" in _*\|*/) continue ;; esac
  d=${d%/}
  entry=""
  if [ -f "$d/$d.ts" ]; then
    entry="$d/$d.ts"
  else
    files=("$d"/*.ts)
    if [ ${#files[@]} -eq 1 ]; then entry="${files[0]}"; fi
  fi
  if [ -z "$entry" ]; then echo "skip $d（未找到入口 .ts）"; continue; fi
  ln -sfn "$(pwd)/$entry" "$TARGET/$(basename "$entry")"
  echo "linked: $entry -> $TARGET/$(basename "$entry")"
  linked=$((linked+1))
done
echo "完成，共链接 $linked 个扩展。重启 pi 会话后生效。"
