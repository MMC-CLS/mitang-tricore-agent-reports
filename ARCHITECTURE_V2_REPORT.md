# TriCore Agent v2.0 架构修正报告

## 一、Token成本失控 → Token预算管理器

### 问题
意识TICK + 任务执行 + 技能沉淀三层同时运行，Token成本可能是单一产品的3-5倍。

### 解决方案：`src/budget/token-budget-manager.js`

| 机制 | 说明 |
|------|------|
| **三层预算分配** | 意识60% / 执行30% / 进化10%（可配置） |
| **五级自动节流** | NONE → LIGHT → MODERATE → HEAVY → EMERGENCY |
| **经济模式** | 节流时自动降级模型（强→弱→跳过） |
| **调用缓存** | EXACT/SEMANTIC缓存，5分钟TTL，LRU淘汰 |
| **批量合并** | 进化层多个小请求合并为一次LLM调用 |
| **跨核借预算** | 高优先级请求可从其他核借Token |
| **自适应分配** | 按历史使用率动态调整各核预算比例 |
| **成本估算** | 实时计算hourly/daily成本 |

### 节流策略

```
使用率 < 50%  → NONE     无限制
使用率 < 70%  → LIGHT    max_tokens缩至70%，意识用execution模型
使用率 < 85%  → MODERATE max_tokens缩至50%，意识用evolution模型
使用率 < 95%  → HEAVY    跳过idle/low优先级调用
使用率 ≥ 95%  → EMERGENCY 仅允许execution层CRITICAL调用
```

---

## 二、架构复杂度 → 核心总线 (CoreBus)

### 问题
三种不同哲学的系统融合，调试难度指数级上升。

### 解决方案：`src/bus/core-bus.js`

| 机制 | 说明 |
|------|------|
| **统一事件总线** | 三核通过唯一通道通信，`BUS_EVENT`定义所有跨核消息类型 |
| **关联ID追踪** | `startTrace()` → 全链路traceId，贯穿意识→执行→进化 |
| **结构化日志** | 每个事件带traceId/source/timestamp/sequence |
| **调试探针** | `setBreakpoint(eventType, condition)` 命中暂停 |
| **诊断API** | `getDiagnostics()` 一键获取瓶颈分析、事件统计 |
| **时间线回放** | `getTrace(traceId)` 回放完整事件链，定位根因 |
| **订阅机制** | 按通道/事件类型订阅，`subscribe(channel, callback)` |
| **拦截器** | `use(interceptor)` 中间件模式，可拦截/修改事件 |

### 事件类型

```
CONSCIOUSNESS_TASK_REQUEST  意识→执行：建议执行任务
CONSCIOUSNESS_SKILL_QUERY   意识→进化：查询技能
EXECUTION_TASK_COMPLETE     执行→意识：任务完成
EXECUTION_TASK_FAILED       执行→意识：任务失败
EXECUTION_SKILL_EXTRACT     执行→进化：请求技能沉淀
EVOLUTION_SKILL_PUBLISHED   进化→执行：发布已审计技能
EVOLUTION_CONSOLIDATION_DONE 进化→意识：整合完成
SCHEDULER_MODE_CHANGE       调度器→全局：模式切换
SYSTEM_ERROR/WARNING/BUDGET_WARNING 系统级事件
```

---

## 三、安全边界模糊 → 安全边界 (SecurityBoundary)

### 问题
意识层的"自主思考"与执行层的"自主操作"之间需要极严格的隔离。

### 解决方案：`src/security/security-boundary.js`

### 三条铁律

| 铁律 | 含义 | 实现 |
|------|------|------|
| **铁律1：意识不碰手** | 意识核不能直接调用任何工具/IO | `enforceIronLaw1()` + 策略引擎 |
| **铁律2：执行不经脑** | 执行核不能自主发起LLM推理 | `enforceIronLaw2()` + 策略引擎 |
| **铁律3：进化受约束** | 进化核产出必须审计才能激活 | `enforceIronLaw3()` + 审计流程 |

### 能力令牌体系

```
意识核能力:  THINK / SUGGEST_TASK / QUERY_MEMORY / QUERY_SKILL / FOCUS_MANAGE
执行核能力:  EXECUTE_TASK / CALL_TOOL / FILE_READ / FILE_WRITE / SHELL_EXEC / BROWSER_CONTROL
进化核能力:  EXTRACT_SKILL / AUDIT_SKILL / CONSOLIDATE / PUBLISH_SKILL

跨核能力:   REQUEST_EXECUTION / REQUEST_EVOLUTION / NOTIFY_CONSCIOUSNESS
```

### 安全级别

| 级别 | 行为 | 示例 |
|------|------|------|
| SAFE | 直接允许 | 查询记忆、建议任务 |
| MODERATE | 需记录 | 文件写入、技能审计 |
| CRITICAL | 需确认 | shell_exec、浏览器控制 |
| FORBIDDEN | 绝对拒绝 | 意识核直接执行shell |

### 确认机制
CRITICAL操作通过`requestConfirmation()`进入多签确认流程，60秒超时自动拒绝。

---

## 四、模型依赖 → 多模型协同路由 (ModelRouter v2)

### 问题
三层能力对模型要求不同，可能需要多模型协同。

### 解决方案：`src/providers/model-router.js` (增强版)

| 机制 | 说明 |
|------|------|
| **多Provider同时注册** | 7个预设Provider + 自定义，可同时注册 |
| **能力分池路由** | `assignProvider('deepseek', 'consciousness')` 按用途分配 |
| **能力探测** | `probeCapabilities()` 自动测试tool_call/thinking/streaming |
| **集成模式** | ENSEMBLE策略：多Provider并行投票/级联 |
| **成本感知路由** | COST_AWARE策略：结合BudgetManager做经济路由 |
| **智能降级** | 主Provider失败自动fallback，且保持用途匹配 |
| **性能追踪** | 按Provider/Purpose记录延迟、成功率、Token消耗 |
| **本地模型** | 预置Ollama配置，零成本运行 |

### 路由策略

```
LAYER_OPTIMAL  按层最优（默认）- 按用途分配
CHEAPEST       最便宜 - 按costPer1k排序
FASTEST        最快 - 按历史延迟排序
BEST_QUALITY   最高质量 - 意识层模型优先
ENSEMBLE       多模型投票 - 并行调用+加权选择
COST_AWARE     成本感知 - 结合BudgetManager
```

### 新增Provider预设

```
deepseek   成本极低，支持thinking
openai     GPT-4o + GPT-4o-mini + o3-mini
qwen       qwen-max + qwen-turbo + qwq-32b
zhipu      GLM-4-plus + GLM-4-flash
ollama     本地零成本
```

---

## 五、遗留Bug修复

| Bug | 文件 | 修复 |
|-----|------|------|
| confirmDangerousAction(false)不通知执行核 | `src/ui/main.js:335` | 无论confirmed=true/false都调用`confirmDangerousAction(taskId, !!confirmed)` |
| 信号处理器重复注册 | `src/deploy/process-manager.js:160` | 添加`if (this._signalHandlersRegistered) return;`守卫 |

---

## 六、集成架构

```
                    ┌─────────────────────────────────────────┐
                    │         TriCore Agent v2.0              │
                    │                                         │
  ┌─────────────────┼─────────────────────────────────────────┼─────────────────┐
  │                 │           治 理 层                      │                 │
  │   ┌─────────────┴─────────────┐ ┌─────────────────────┐ │                 │
  │   │   CoreBus (核心总线)      │ │ SecurityBoundary    │ │                 │
  │   │ · 统一事件通道            │ │ · 三条铁律          │ │                 │
  │   │ · traceId全链路追踪       │ │ · 能力令牌          │ │                 │
  │   │ · 调试探针/时间线回放     │ │ · 授权网关          │ │                 │
  │   │ · 诊断API                │ │ · 多签确认          │ │                 │
  │   └───────────────────────────┘ └─────────────────────┘ │                 │
  │   ┌───────────────────────────┐ ┌─────────────────────┐ │                 │
  │   │ TokenBudgetManager        │ │ ModelRouter v2      │ │                 │
  │   │ · 三层预算 60/30/10%      │ │ · 多Provider分池    │ │                 │
  │   │ · 五级自动节流            │ │ · 能力探测          │ │                 │
  │   │ · 调用缓存/批量合并       │ │ · 集成投票          │ │                 │
  │   │ · 自适应预算分配          │ │ · 成本感知路由      │ │                 │
  │   └───────────────────────────┘ └─────────────────────┘ │                 │
  │                                     │                    │                 │
  └─────────────────────────────────────┼────────────────────┘                 │
                                        │                                      │
          ┌─────────────────────────────┼─────────────────────────────┐        │
          │                             │                              │        │
   ┌──────┴──────┐              ┌───────┴──────┐              ┌───────┴──────┐  │
   │  意识核     │              │  执行核      │              │  进化核      │  │
   │  THINK      │──建议任务──→│  EXECUTE     │──技能提取──→│  EXTRACT     │  │
   │  SUGGEST    │              │  CALL_TOOL   │              │  AUDIT       │  │
   │  QUERY_MEM  │              │  FILE_IO     │              │  CONSOLIDATE │  │
   │  FOCUS      │              │  SHELL(限制) │              │  PUBLISH     │  │
   │             │←──任务结果───│              │←──已审计技能─│              │  │
   └─────────────┘              └──────────────┘              └──────────────┘  │
                                                                                 │
   ═══════ 铁律: 意识不碰手 | 执行不经脑 | 进化受约束 ═══════                     │
                                                                                 │
   所有跨核通信必须经过 CoreBus，所有操作必须经过 SecurityBoundary 授权            │
   所有LLM调用经过 TokenBudgetManager 检查，所有路由经过 ModelRouter 协同       │
```

---

## 七、新增文件清单

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/budget/token-budget-manager.js` | ~270 | Token预算管理器 |
| `src/bus/core-bus.js` | ~450 | 核心总线 |
| `src/security/security-boundary.js` | ~480 | 安全边界 |

## 八、修改文件清单

| 文件 | 变更 |
|------|------|
| `src/index.js` | 重写：注入治理层、集成四大模块、v1.0→v2.0 |
| `src/providers/model-router.js` | 重写：多Provider分池、能力探测、集成模式、成本感知 |
| `src/core/consciousness-core.js` | 新增 bus/security/budget 依赖注入 |
| `src/core/execution-core.js` | 新增 bus/security/budget 依赖注入 |
| `src/core/evolution-core.js` | 新增 bus/security/budget 依赖注入 |
| `src/ui/main.js` | 修复 confirmDangerousAction(false) bug |
| `src/deploy/process-manager.js` | 修复信号处理器重复注册 bug |

## 九、测试结果

**18/18 全部通过** ✓

```
[1-4]  治理层模块加载: OK
[5-10] 三核注入治理层依赖: OK
[11]   预算分配比例: 60/30/10% OK
[12]   安全策略: 4个默认策略 OK
[13]   总线诊断: OK
[14]   安全边界阻断: OK
[15-17] 三条铁律: OK
[18]   信号处理器守卫: OK
```
