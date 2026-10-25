#!/usr/bin/env bash
# 给底层米家服务（lamp_server.py）装上开机自启。在服务器上跑一次：
#
#   cd ~/Vesper-light && bash scripts/install_lamp_service.sh
#
# 它做五件事：找到 venv 的 python 和 lamp_server.py、停掉现在裸跑的那个进程、
# 生成 unit 文件、enable + start、最后回读一次状态和端口确认真的起来了。
#
# 重复跑安全：已经装过就是重新写 unit 再 restart。
set -euo pipefail

UNIT_NAME=lamp-mcp
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}.service"
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/assets/lamp-mcp.service"

say() { printf '%s\n' "$*"; }
die() { printf '\xe2\x9c\x97 %s\n' "$*" >&2; exit 1; }

[ -f "$TEMPLATE" ] || die "找不到 $TEMPLATE——先 git pull 一下这个库。"
[ "$(id -u)" = 0 ] || die "要 root 才能写 /etc/systemd/system。用 sudo 跑。"

# ── 找底层那堆东西在哪 ──
# 交接文档第 3 节写的是 ~/miot-lamp，但别写死——找不到就报清楚比猜好。
LAMP_HOME="${LAMP_HOME:-}"
if [ -z "$LAMP_HOME" ]; then
  for d in "$HOME/miot-lamp" /root/miot-lamp /home/*/miot-lamp; do
    [ -d "$d" ] && LAMP_HOME="$d" && break
  done
fi
[ -n "$LAMP_HOME" ] && [ -d "$LAMP_HOME" ] || die "找不到 miot-lamp 目录。用 LAMP_HOME=/路径 bash scripts/install_lamp_service.sh 指定。"

# lamp_server.py 在哪（交接文档说在 miot-mcp/ 子目录）
SCRIPT=""
for p in "$LAMP_HOME/miot-mcp/lamp_server.py" "$LAMP_HOME/lamp_server.py"; do
  [ -f "$p" ] && SCRIPT="$p" && break
done
if [ -z "$SCRIPT" ]; then
  SCRIPT="$(find "$LAMP_HOME" -maxdepth 3 -name lamp_server.py -type f 2>/dev/null | head -1 || true)"
fi
[ -n "$SCRIPT" ] || die "在 $LAMP_HOME 下找不到 lamp_server.py。"
WORKDIR="$(dirname "$SCRIPT")"

# venv 的 python。不能用系统 python：mijiaAPI 装在 venv 里
PYTHON=""
for p in "$LAMP_HOME/venv/bin/python" "$LAMP_HOME/venv/bin/python3" "$WORKDIR/../venv/bin/python"; do
  [ -x "$p" ] && PYTHON="$p" && break
done
[ -n "$PYTHON" ] || die "找不到 venv 的 python（找过 $LAMP_HOME/venv/bin/）。用 PYTHON=/路径 指定。"

# 用哪个用户跑：按 miot-lamp 目录的主人算，而不是写死 root（~/.miot-mcp 里的凭证归他）
RUN_USER="$(stat -c '%U' "$LAMP_HOME")"

say "找到了："
say "  用户：  $RUN_USER"
say "  python：$PYTHON"
say "  脚本：  $SCRIPT"
say "  工作目录：$WORKDIR"
say ""

# ── 停掉裸跑的那个 ──
# 不停的话 8890 被占着，systemd 起来的那个会立刻挂，而且报错很难认
if pgrep -f 'lamp_server\.py' >/dev/null 2>&1; then
  say '有一个裸跑的 lamp_server.py（nohup 时代的），先停掉…'
  pkill -f 'lamp_server\.py' || true
  sleep 2
fi

# ── 写 unit ──
sed -e "s|__USER__|$RUN_USER|g" \
    -e "s|__PYTHON__|$PYTHON|g" \
    -e "s|__SCRIPT__|$SCRIPT|g" \
    -e "s|__WORKDIR__|$WORKDIR|g" \
    "$TEMPLATE" > "$UNIT_PATH"
say "已写 $UNIT_PATH"

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || systemctl enable "$UNIT_NAME"
systemctl restart "$UNIT_NAME"
say '已 enable + start，等它起来…'
sleep 4

# ── 回读确认 ──
# 单看 systemctl 不够：它说 active 只意味着进程在，不意味着端口听上了
say ''
systemctl --no-pager --lines=0 status "$UNIT_NAME" || true
say ''
if curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8890/mcp --max-time 5 | grep -qE '^(200|401|400)$'; then
  say '\xe2\x9c\x93 8890 在听了——底层服务真的起来了。'
  say ''
  say '验一下重启也能自己起（可选，会真的重启服务器）：'
  say '  reboot'
  say '  起来后：systemctl is-active lamp-mcp'
else
  say '\xe2\x9c\x97 8890 没听上。看日志：'
  say '  journalctl -u lamp-mcp -n 40 --no-pager'
  say '常见原因：小米登录失效（要重新扫码，见交接文档第 7 节）、venv 里缺包。'
  exit 1
fi
