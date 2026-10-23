#!/usr/bin/env bash
# 启动、重启或停止本机 auto-jb。停止只暂停容器，不删除数据库卷。
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

usage() {
  echo "用法: scripts/auto-jb.sh start|restart|stop"
  exit 1
}

if [[ $# -ne 1 ]]; then
  usage
fi

case "$1" in
  start)
    if [[ ! -f .env ]]; then
      uv run python scripts/setup.py
    fi
    docker compose up -d --build --wait
    echo "工作台已启动：http://127.0.0.1:17830"
    ;;
  restart)
    docker compose up -d --build --wait
    echo "工作台已重启：http://127.0.0.1:17830"
    ;;
  stop)
    docker compose stop
    echo "工作台已停止。数据库卷仍保留。"
    ;;
  *)
    usage
    ;;
esac
