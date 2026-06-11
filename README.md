# 🍯 蜜糖 TriCore Agent

> **三核融合智能体** — 意识核自主思考 + 执行核任务闭环 + 进化核技能沉淀，持续运行的 AI Agent 系统。

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](package.json)

---

## ⚡ 5 分钟快速体验

**无需 API Key，一行命令启动：**

```bash
docker-compose -f docker-compose.demo.yml up
```

启动后：
- 🌐 **Brain UI**: http://localhost:8080 — 可视化三核状态面板
- 🔌 **API**: http://localhost:3721 — REST + WebSocket 接口
- ❤️ **Health**: http://localhost:3722/health — 健康检查

内置 Echo Mock Provider，自动运行 Demo 场景（发送测试消息、展示三核响应）。

---

## 🧠 核心特性

### 三核架构

| 核心 | 图标 | 职责 | 关键能力 |
|------|------|------|----------|
| **意识核** | 💡 | 自主思考 | TICK驱动 · 焦点栈注意力 · L1/L2分层响应 · 空闲觉察 |
| **执行核** | ⚡ | 任务闭环 | 安全沙箱 · 并行工具调用 · 自动重试 · 插件生态 |
| **进化核** | 🧬 | 技能沉淀 | 记忆整合 · 技能审计 · 增量进化 · 自我优化 |

### 三条铁律

1. **意识不碰手** — 意识核只提供建议，不直接执行操作
2. **执行不经脑** — 执行核按确定流程闭环，不经模糊推理
3. **进化受约束** — 自动沉淀的技能默认 pending，必须审计才能激活

### 更多特性

- 🤖 **子智能体系统** — 创建/管理/监控独立子Agent，团队协作，共识门控
- 🔒 **安全边界** — 三条铁律强制执行，跨核授权网关，行为审计
- 🔀 **模型路由** — 多Provider分池，按任务类型智能调度
- 📡 **实时推送** — WebSocket 连接，`ai_response` / `task_update` / `memory_update` 事件流
- 📊 **Brain UI** — 暗色科技风可视化面板，三核实时状态、记忆网络图、消息管道
- 🐳 **Docker 一键部署** — Demo 模式零配置启动，生产模式完整部署

---

## 🏗 架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                     🍯 蜜糖 TriCore Agent                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐           │
│   │ 💡 意识核    │   │ ⚡ 执行核    │   │ 🧬 进化核    │           │
│   │ TICK驱动    │   │ 任务闭环    │   │ 技能沉淀    │           │
│   │ 焦点栈注意力 │   │ 安全沙箱    │   │ 自我审计    │           │
│   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘           │
│          │                 │                 │                   │
│   ┌──────┴─────────────────┴─────────────────┴──────────────┐   │
│   │                    治理层                                │   │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │   │
│   │  │ CoreBus  │ │ Security │ │  Token   │ │  Model    │  │   │
│   │  │ 事件总线 │ │ 安全边界 │ │  预算    │ │  路由     │  │   │
│   │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │  能力层                                                   │  │
│   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────────┐  │  │
│   │  │Memory  │ │ToolCall│ │  RAG   │ │MessageProcessor  │  │  │
│   │  │Engine  │ │Engine  │ │Engine  │ │(量子态管道)      │  │  │
│   │  └────────┘ └────────┘ └────────┘ └──────────────────┘  │  │
│   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────────┐  │  │
│   │  │Browser │ │ Social │ │ Voice  │ │ MemoryNetwork    │  │  │
│   │  │Auto    │ │Dispatch│ │System  │ │ Graph(全息图谱)  │  │  │
│   │  └────────┘ └────────┘ └────────┘ └──────────────────┘  │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │  协作层: 子智能体系统 · 团队协作 · 技能市场 · 共识门控    │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐    │
│   │ REST API │ │WebSocket │ │ Brain UI │ │  Prometheus   │    │
│   │  :3721   │ │  :3721   │ │  :8080   │ │  Metrics      │    │
│   └──────────┘ └──────────┘ └──────────┘ └───────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🚀 生产部署

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0

### 安装启动

```bash
cd TriCoreAgent
npm install

# 配置 LLM API Key
export LLM_API_KEY="your-api-key"
export LLM_PROVIDER="deepseek"   # deepseek | openai | custom

# 启动
npm start
```

### Docker 部署

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f
```

---

## 📁 项目结构

```
TriCoreAgent/
├── src/
│   ├── index.js                    # 主入口
│   ├── core/
│   │   ├── consciousness-core.js   # 意识核
│   │   ├── execution-core.js       # 执行核
│   │   └── evolution-core.js       # 进化核
│   ├── bus/
│   │   ├── core-bus.js             # 核心事件总线
│   │   ├── graceful-restart.js     # 优雅重启
│   │   └── startup-self-check.js   # 启动自检
│   ├── security/
│   │   ├── security-boundary.js    # 安全边界
│   │   └── content-safety-filter.js# 内容安全
│   ├── memory/
│   │   └── memory-engine.js        # 记忆引擎
│   ├── llm/
│   │   ├── tool-calling-engine.js  # Tool Calling
│   │   └── rag-engine.js           # RAG引擎
│   ├── providers/
│   │   ├── model-router.js         # 模型路由
│   │   └── llm-provider.js         # LLM Provider
│   ├── api/
│   │   └── api-server.js           # API服务
│   ├── ui/
│   │   ├── brain-ui/               # Brain UI 前端
│   │   └── dashboard/              # 管理仪表盘
│   └── utils/                      # 工具模块
├── tests/                          # 测试
├── deploy/                         # 部署配置
├── scripts/
│   └── demo-entrypoint.sh          # Demo启动脚本
├── docker-compose.yml              # 生产部署
├── docker-compose.demo.yml         # 一键Demo
└── Dockerfile
```

---

## 🔗 链接

- 📋 [后续开发路线图](https://github.com/mitang-tricore-agent/mitang-tricore-agent/issues)
- 📖 [完整 API 文档](./docs/openapi.yaml)
- 🧪 [运行测试](#运行测试)

---

MIT License
