#!/usr/bin/env bash
# tmon Linux 端到端验证（POSIX 路径：/bin/sh、forkpty、SIGINT 信号语义）
# 用法：bash tests/e2e-linux.sh（在项目根目录执行；需 node >= 22）
set -u
cd "$(dirname "$0")/.."

FAIL=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAIL=1; }

# 容器/CI 中无全局安装：npm link 提供 tmon 命令（本机已有则幂等）
npm link >/dev/null 2>&1

api() { curl -s -H "authorization: Bearer $TOKEN" "$@"; }
post_input() { curl -s -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d "$2" "http://127.0.0.1:$PORT/api/tasks/$1/input" >/dev/null; }

echo "== 0. 基础执行（sh -c 路径 + forkpty） =="
OUT=$(node bin/tmon.js "echo hello-linux && uname -s" 2>/dev/null) || { fail "基础执行失败"; }
echo "$OUT" | grep -q "hello-linux" && pass "输出透传" || fail "输出透传: $OUT"
echo "$OUT" | grep -qi "linux" && pass "uname 输出" || fail "uname 输出"

# 首个 tmon 命令已自动拉起 server：此刻再读发现文件（此前可能尚未创建）
TOKEN=$(cat ~/.tmon/token 2>/dev/null || echo "")
PORT=$(cat ~/.tmon/port 2>/dev/null || echo "")
if [ -z "$TOKEN" ] || [ -z "$PORT" ]; then
  fail "server 发现文件缺失（token=$TOKEN port=$PORT）"
fi

echo "== 1. 退出码透传 =="
node bin/tmon.js "exit 3" >/dev/null 2>&1
[ $? -eq 3 ] && pass "退出码 3 透传" || fail "退出码透传（got $?）"

echo "== 2. 任务注册与查询 =="
node bin/tmon.js "sleep 1; echo done" >/dev/null 2>&1 &
sleep 0.5
ID=$(node bin/tmon.js last 2>/dev/null)
[ -n "$ID" ] && pass "last 任务 id: $ID" || fail "last 无结果"
node bin/tmon.js status "$ID" 2>/dev/null | grep -q running && pass "status running" || fail "status 非 running"
node bin/tmon.js wait "$ID" --timeout=30 >/dev/null 2>&1 && pass "wait 透传 0" || fail "wait 未返回 0"

echo "== 3. 进度上报（IPC + 事件落盘） =="
node bin/tmon.js "bash -c 'for i in 1 2 3; do tmon progress \$((i*33)) \"步骤 \$i\"; sleep 0.3; done'" >/dev/null 2>&1 &
sleep 1.5
ID=$(node bin/tmon.js last)
node bin/tmon.js wait "$ID" --timeout=30 >/dev/null 2>&1
api "http://127.0.0.1:$PORT/api/tasks/$ID/events" | grep -q '"type":"progress"' && pass "progress 事件落盘" || fail "progress 事件缺失"

echo "== 4. 交互输入（REST input → PTY） =="
node bin/tmon.js "bash -c 'read -p \"名字: \" n; echo 你好 \$n'" >/dev/null 2>&1 &
sleep 1
ID=$(node bin/tmon.js last)
post_input "$ID" '{"data":"张三\r"}'
node bin/tmon.js wait "$ID" --timeout=30 >/dev/null 2>&1
node bin/tmon.js show "$ID" --full 2>/dev/null | grep -q "你好 张三" && pass "交互输入转发" || fail "交互输入未生效"

echo "== 5. kill（SIGINT → killed，退出码 130） =="
node bin/tmon.js "sleep 30" >/dev/null 2>&1 &
sleep 1
ID=$(node bin/tmon.js last)
node bin/tmon.js kill "$ID" --signal=SIGINT >/dev/null 2>&1
sleep 1
node bin/tmon.js status "$ID" 2>/dev/null | grep -q killed && pass "SIGINT → killed" || fail "SIGINT 未生效"
node bin/tmon.js wait "$ID" --timeout=30 >/dev/null 2>&1
[ $? -eq 130 ] && pass "killed 退出码 130" || fail "killed 退出码（got $?）"

echo "== 6. 交互式 demo 全流程 =="
node bin/tmon.js "node demo-interactive.mjs" >/dev/null 2>&1 &
sleep 1.5
ID=$(node bin/tmon.js last)
post_input "$ID" '{"data":"Alice\r"}'
sleep 0.5
post_input "$ID" '{"data":"y\r"}'
sleep 0.5
post_input "$ID" '{"data":"s3cret!\r"}'
node bin/tmon.js wait "$ID" --timeout=30 >/dev/null 2>&1
node bin/tmon.js show "$ID" --full 2>/dev/null | grep -q "密码长度 7 位" && pass "demo 全流程" || fail "demo 未完成"

echo "== 7. 无孤儿进程残留 =="
pgrep -f "sleep 30" >/dev/null && fail "孤儿 sleep 残留" || pass "无孤儿进程"

[ $FAIL -eq 0 ] && echo "ALL PASS" || echo "HAS FAILURES"
exit $FAIL
