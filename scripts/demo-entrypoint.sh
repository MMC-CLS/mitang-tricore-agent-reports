#!/bin/sh
# ─────────────────────────────────────────────────────────────
# 蜜糖 TriCore Agent — Demo 启动脚本
# 内置 Echo/Mock Provider，无需真实 LLM API Key
# ─────────────────────────────────────────────────────────────

set -e

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         🍯 蜜糖 TriCore Agent — Demo Mode               ║"
echo "║         三核融合智能体 · 一键体验版                      ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  意识核 (💡)  · 自主思考 · TICK驱动                      ║"
echo "║  执行核 (⚡)  · 任务闭环 · 安全沙箱                      ║"
echo "║  进化核 (🧬)  · 技能沉淀 · 自我进化                      ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  API:      http://localhost:3721                        ║"
echo "║  Health:   http://localhost:3722/health                 ║"
echo "║  Brain UI: http://localhost:8080                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# 确保数据目录存在
mkdir -p /app/data/logs /app/data/audit /app/data/keys /app/data/config

# 启动 TriCore Agent (后台)
echo "[demo] 启动 TriCore Agent (Echo Mock Provider)..."
node src/index.js &
TRICORE_PID=$!

# 等待 API 就绪
echo "[demo] 等待 API 就绪..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3722/health > /dev/null 2>&1; then
    echo "[demo] ✅ API 就绪 (尝试 ${i} 次)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[demo] ⚠️ API 启动超时，继续..."
  fi
  sleep 1
done

# 启动 Brain UI 静态服务 (后台)
echo "[demo] 启动 Brain UI 静态服务..."
node src/ui/brain-ui/server.js &
UI_PID=$!

echo "[demo] ✅ Brain UI 就绪: http://localhost:8080"

# ── 自动运行 Demo 场景 ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🎬 运行 Demo 场景"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

sleep 2

# 场景 1: 发送测试消息
echo ""
echo "📨 [场景1] 发送测试消息..."
curl -s -X POST http://localhost:3721/api/message \
  -H "Content-Type: application/json" \
  -d '{"from":"demo_user","content":"你好蜜糖！介绍一下你的三核架构吧"}'
echo ""

sleep 3

# 场景 2: 查询状态
echo ""
echo "📊 [场景2] 查询系统状态..."
curl -s http://localhost:3721/status | head -c 500
echo ""

sleep 2

# 场景 3: 提交任务
echo ""
echo "📋 [场景3] 提交 Demo 任务..."
curl -s -X POST http://localhost:3721/api/task \
  -H "Content-Type: application/json" \
  -d '{"content":"创建一个示例数据分析报告","mode":"task"}'
echo ""

sleep 2

# 场景 4: 搜索记忆
echo ""
echo "🧠 [场景4] 搜索记忆..."
curl -s "http://localhost:3721/api/memories?q=三核&limit=5"
echo ""

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Demo 场景运行完毕！"
echo ""
echo "  🌐 打开浏览器访问:"
echo"     Brain UI:  http://localhost:8080"
echo "     API:       http://localhost:3721"
echo "     Health:    http://localhost:3722/health"
echo ""
echo "  按 Ctrl+C 停止所有服务"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 监控子进程，任意退出则终止
trap 'echo "[demo] 正在停止..."; kill $TRICORE_PID $UI_PID 2>/dev/null; exit 0' INT TERM

# 等待任一进程退出
wait -n $TRICORE_PID $UI_PID 2>/dev/null
echo "[demo] 进程退出，清理中..."
kill $TRICORE_PID $UI_PID 2>/dev/null
