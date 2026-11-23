#!/bin/sh
# 「带浏览器」镜像的启动入口：先备好虚拟屏，再 exec 进程本体。
#
# ## 为什么必须有虚拟屏
#
# 豆包扫码登录（以及本仓其它 headful 链路）起的是**可见窗口** —— 页面上要弹二维码
# 给用户扫。容器里没有 X server 时 Chromium 直接报
# `Missing X server or $DISPLAY`，窗口根本起不来。
#
# 故这里在 **DISPLAY 未设置**时拉一块 1280x900 的 Xvfb 虚拟屏。已经有 X（用户自带
# 或者把宿主 X socket 挂进来）时**不覆盖** DISPLAY，交给外部。
#
# ## 怎么看那个窗口
#
# 默认看不到 —— 需要 `C2A_VNC=1` 起一个 x11vnc（5900），用 VNC 客户端连上去扫码/点登录。
# ⚠️ x11vnc 这里**不设密码**（容器内的临时会话），只适用于可信网络；暴露到公网请自己
#    加 `-rfbauth` 或放在反向代理 + 鉴权后面。
set -u

cd /app || exit 1

if [ -z "${DISPLAY:-}" ]; then
  Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  export DISPLAY=:99
  # 等 X socket 就绪（最多 3 秒）；等不到也继续 —— 起不来时下游会给出可读报错。
  i=0
  while [ ! -S /tmp/.X11-unix/X99 ] && [ "${i}" -lt 30 ]; do
    i=$((i + 1))
    sleep 0.1
  done
fi

if [ "${C2A_VNC:-0}" = "1" ]; then
  x11vnc -display "${DISPLAY}" -rfbport 5900 -nopw -forever -shared -quiet \
    >/tmp/x11vnc.log 2>&1 &
fi

exec node dist-server/index.js "$@"
