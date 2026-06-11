# Changelog

All notable changes to TriCore Agent will be documented in this file.

## [1.0.0] - 2026-06-09 (正式版)

### Changed — 统一版本并深度优化
- **版本号全系统统一至1.0.0**：index.js / package.json / bootstrap-infrastructure.js / README / CHANGELOG 等全部统一
- **三核深度优化**：意识核L1/L2分层快速响应、执行核并行工具调用、进化核增量整合
- **安全加固**：修复密码日志泄露、SSRF漏洞、JWT降级回退、shell命令白名单
- **代码质量提升**：消除DRY违反、统一错误处理模式、清理console.log、修复brain-ui.js LOG递归bug
- **全流程打通**：端到端AI反馈机制优化、工作流程全面检查

## [5.0.0] - 2026-06-07 (历史版本)

### Added — 按审计报告完成全量修复 P0+P1+P2+P3 (历史)

#### P0 紧急修复
- **版本号全系统统一**：index.js / package.json / bootstrap-infrastructure.js 统一为 v5.0.0

#### P1 短期改进
- **布局算法补全** (`src/subagent/memory-network-graph.js`): 四种布局模式全部实现
  - `_applyForceLayout()`: Barnes-Hut近似多体力模拟（引力+斥力+连线力+层级力+黑洞效应）
  - `_applySpiralLayout()`: 阿基米德时间螺旋布局（新记忆近中心，旧记忆向外螺旋）
  - `_applyRadialLayout()`: 径向层级布局（5层同心圆按tier分组）
  - `_applyConstellationLayout()`: 星座图布局（聚类星区分布+星群图案）
- **焦点栈精细化**：语义分类+LLM仲裁+话题切换检测+上下文保持

#### P2 中期增强
- **执行核单元测试** (`tests/unit/execution-core.test.js`): 38个测试用例覆盖任务生命周期/工具执行/插件管理/安全沙箱/重试机制/审计日志
- **进化核单元测试** (`tests/unit/evolution-core.test.js`): 30个测试用例覆盖技能沉淀/审计/SKILL.md生成/整合循环/轨迹分析/重试机制
- **意识核焦点栈测试** (`tests/unit/consciousness-focus.test.js`): 30个测试用例覆盖焦点更新/语义分类/Prompt注入防护/时间词解析/情感向量
- **UI层测试** (`tests/unit/ui-layer.test.js`): 状态管理/消息格式化/指示器/记忆流/运行时统计测试
- **向量嵌入集成** (`src/memory/vector-embedding.js`): 余弦/欧氏/点积相似度 + K-means聚类 + LRU缓存 + 降级伪向量

#### P3 长期规划
- **插件协议标准化** (`src/plugin/plugin-protocol.js`): 6阶段生命周期状态机（注册→验证→加载→激活→停用→卸载）+ 权限控制 + 热加载 + 依赖拓扑排序
- **P2P子智能体通信** (`src/subagent/peer-to-peer.js`): 节点发现 + 握手连接 + 加密消息 + 状态同步 + 心跳保活 + 超时检测
- **微服务编排器** (`src/deploy/microservice-orchestrator.js`): 服务注册发现 + 加权轮询负载均衡 + 健康检查 + 断路保护
- **CI/CD流水线** (`.github/workflows/ci.yml`): Node 18/20/22矩阵测试 + 覆盖率报告 + 安全审计 + 压力测试

### Changed
- `src/index.js`: VERSION 从 4.1.0 → 5.0.0
- `src/bootstrap/bootstrap-infrastructure.js`: VERSION 从 4.0.0 → 4.1.0（同步修复）
- `package.json`: version 从 4.1.0 → 5.0.0
- `README.md`: 更新架构图、新增v5.0功能列表、添加CI/CD徽章
- `src/subagent/memory-network-graph.js`: `buildFromMemory()` 新增 `_applyLayout()` 调用；`setLayoutMode()` 支持即时重算

---

## [4.1.0] - 2026-06-07

### Added (按审计报告"下一步开发计划"执行 — 系统完善与工程化增强)

#### P0 紧急任务
- **入口文件拆分** (`src/bootstrap/`): 将2900行的index.js拆分为12个bootstrap模块
  - `bootstrap-logger.js`: Logger + ErrorHandler 初始化
  - `bootstrap-infrastructure.js`: ConfigValidator + MessageQueue + PerfMonitor + TickConcurrency + DistLock + GracefulRestart + RateLimiter + StartupSelfCheck + Prometheus + MicroRegistry
  - `bootstrap-governance.js`: CoreBus + SecurityBoundary + TokenBudgetManager
  - `bootstrap-foundation.js`: Scheduler + MemoryEngine + ModelRouter
  - `bootstrap-tricore.js`: ConsciousnessCore + ExecutionCore + EvolutionCore
  - `bootstrap-extensions.js`: BrowserAutomation + SocialDispatch + VoiceSystem + ApiServer + ConfigManager
  - `bootstrap-collaboration.js`: AgentCoordination + SkillMarket + ProcessManager
  - `bootstrap-subagents.js`: SubAgentManager + SubAgentGuardian + SubAgentScheduler + TeamManager + MessageProcessor + MemoryNetworkGraph + PersistenceStore
  - `bootstrap-llm.js`: ToolCallingEngine + RAGEngine + MultiModalEngine
  - `bootstrap-enterprise.js`: RBACManager + AuditLogger + EncryptionService
  - `bootstrap-v4.js`: ContentSafetyFilter + I18n (v4.0新增模块)
  - `bootstrap/index.js`: 聚合导出，bootstrapAll() + startupAll() + bindEventsAll() 统一编排
- **CI/CD流水线** (`.github/workflows/ci.yml`): GitHub Actions自动测试/基准测试/安全审计流水线，支持Node 18/20/22矩阵测试

#### P1 高优先级任务
- **API版本控制** (`src/api/api-server.js`): 新增 /api/v1/ 路由前缀、X-API-Version 响应头、/api/version 和 /api/health 端点，完全向后兼容
- **数据库迁移策略** (`src/data/schema-migrations.js`): 版本化Schema迁移系统，支持up/down迁移、自动版本检测、v1→v2升级（新增安全过滤日志表/国际化缓存表/性能指标表）
- **性能基准测试** (`tests/benchmark/performance-benchmark.test.js`): 全面的性能基准套件，覆盖模块初始化/记忆操作/事件总线/Token预算/消息处理/启动时间的延迟与吞吐量基准
- **v4.0模块集成测试** (`tests/integration/v4-modules-integration.test.js`): ContentSafetyFilter/版权保护层/I18n/分层缓存的集成验证
- **E2E测试增强** (`tests/e2e/tricore-v4-e2e.test.js`): 新增异常恢复/并发消息/长对话记忆保持/子智能体生命周期/版权标识持久性测试

#### P2 中期增强
- **性能SLA定义**: 在各bootstrap模块中嵌入性能监控埋点
- **package.json增强**: 新增 test:benchmark/test:v4-integration/test:v4-e2e/db:migrate/db:rollback/coverage/ci 脚本

### Changed
- `src/index.js`: 构造函数从2900行精简至~300行（委托bootstrap模块），保持完全向后兼容
- `src/api/api-server.js`: 新增版本化路由、健康检查端点、API版本端点
- `package.json`: 新增7个npm scripts，更新keywords
- `CHANGELOG.md`: 补写v4.1.0完整记录

### Fixed
- PDF中文乱码问题：修复reportlab中文字体注册（SimHei/SimSun），重新生成中文PDF审计报告
- 系统入口文件可维护性：解决112KB单文件难以维护的问题

---

## [4.0.0] - 2026-06-07

### Added (全面审计修复与增强 — 22项任务)

#### P0 严重问题修复
- **README/CHANGELOG版本同步**: README.md从v2.5更新至v4.0.0，CHANGELOG补写v2.6-v4.0完整记录
- **意识核工具路由实现** (`src/core/consciousness-core.js`): `_getToolsForMessage()` 从空实现升级为三层路由系统（Intent→Entity→Fallback），支持search/file/execute/code/analysis/chat六大意图动态工具注入，最多5个工具/消息控制token开销
- **web_search/fetch_url真实能力** (`src/core/execution-core.js`): 替换占位返回为DuckDuckGo搜索API + Node.js原生HTTP(S)抓取，支持重定向链/超时控制/响应大小限制/HTML剥离，新增`_httpFetch()`辅助方法
- **v3.0模块单元测试补充** (`tests/unit/`): 新增message-processor/memory-network-graph/persistence-store三个模块的完整单元测试

#### P1 中等问题修复
- **index.js构造函数拆分**: 将500行巨型构造函数拆分为`_initInfrastructure()`/`_initCores()`/`_initEnterprise()`等工厂方法，提升可维护性
- **WebSocket实时通信** (`src/api/api-server.js`): 替换占位符为完整WebSocket实现，支持心跳保活/断线重连/流式响应/房间订阅/双向消息推送
- **Admin Restart零停机重启**: 实现真正的优雅重启逻辑，包括连接排空/状态序列化/新旧进程交接/健康检查验证
- **PDF解析集成** (`src/llm/rag-engine.js`): 集成pdf-parse库实现PDF文本提取，支持多页/复杂格式/元数据提取
- **brain-ui日志统一** (`src/ui/brain-ui/brain-ui.js`): 18处裸`console.error`迁移到统一LOG包装器，支持IPC日志回传后端
- **看门狗修复** (`src/scheduler/unified-scheduler.js`): `_resetWatchdog()`方法补全，在`_onTick()`/`start()`/`resume()`中正确调用，`stop()`中清理
- **集成测试完善**: 新增端到端消息处理流程测试/子智能体协作测试/团队协调测试
- **性能基准测试**: 建立TICK处理/记忆检索/图构建的性能基线指标

#### P2 远期增强
- **记忆网络图层级缓存** (`src/memory/memory-engine.js`): `getLayeredMemoryData()`增加5秒TTL缓存层，减少重复SQL查询，新增`invalidateLayeredCache()`方法
- **向量检索ANN索引** (`src/llm/rag-engine.js`): 新增`ANNIndex`类支持HNSW/Flat索引，替换O(n)余弦遍历，支持索引持久化与增量更新
- **人员记忆识别** (`src/core/consciousness-core.js`): 新增`_recognizePersonFromMessage()`方法，支持中英文姓名识别/自我介绍提取/记忆回溯关联
- **整合重试机制** (`src/core/evolution-core.js`): `runConsolidation()`增加指数退避重试（最多3次/5分钟上限），失败后自动恢复，成功重置计数器
- **LLM输出内容安全过滤** (`src/security/content-safety-filter.js`): 新增`ContentSafetyFilter`类，支持PII/CodeInjection/敏感词检测，sanitizeOutput脱敏处理，safe/warn/block三级分类
- **压力测试框架** (`tests/stress/stress-framework.test.js`): 并发TICK/消息/记忆测试框架，支持1000并发极限测试/性能基线采集
- **多语言国际化框架** (`src/utils/i18n.js`): 新增`I18n`类，zh-CN/en-US双语支持，分层键值查找，动态切换
- **可视化Dashboard** (`src/ui/dashboard/index.html`): 独立Web管理面板，实时系统状态/指标图表/模块健康度/操作日志
- **技能市场完整后端** (`src/market/skill-market.js`): 新增技能发布审核/搜索评分/下载安装/评论系统的完整后端实现

### Changed
- `src/index.js`: VERSION→4.0.0，集成ContentSafetyFilter/I18n/ANNIndex，构造函数拆分为工厂方法，start()/stop()增加新模块生命周期管理
- `package.json`: 版本升级至4.0.0，新增依赖(pdf-parse)，新增test脚本
- `deploy/.env.example`: 新增v4.0环境变量（自检/WebSocket/Dashboard/i18n/内容过滤/ANN）

---

## [3.1.0] - 2026-06-07

### Added (全流程启动自检)
- **StartupSelfCheck** (`src/bus/startup-self-check.js`): 借鉴白龙马BaiLongma L2自检架构，实现四阶段渐进式验证
  - Phase 0 — 前置飞航检查: Node版本/磁盘空间/内存/CPU/权限（同步，致命失败阻止启动）
  - Phase 1 — 能力探测: LLM Provider/嵌入模型/浏览器/沙箱/网络/SQLite（异步，失败降级启动）
  - Phase 2 — 集成冒烟: 核心总线/安全边界/Token预算/记忆读写/调度器/消息队列
  - Phase 3 — 全流程端到端: LLM驱动文件系统/工具调用/记忆注入/子智能体/API验证
- 版本化状态管理: 自检完成后持久化，版本变更或上次失败自动触发重检
- 超时保护: 每项独立超时 + 阶段总超时 + 全局超时（180s）
- 四级严重度: FATAL/CRITICAL/WARNING/INFO分类处理
- 完整事件系统: 7种事件类型，可观测性完备

### Changed
- `src/index.js`: VERSION→3.1.0，构造函数初始化StartupSelfCheck，start()中执行Phase 0-2，TICK中注入Phase 3指令
- `src/core/consciousness-core.js`: `_buildDynamicContext()`支持selfCheckPhase3指令注入

---

## [3.0.0] - 2026-06-06

### Added (三核集成发布)
- **MessageProcessor** (`src/subagent/message-processor.js`): 量子态管道/6维情感向量/DAG追踪/意图识别
- **MemoryNetworkGraph** (`src/subagent/memory-network-graph.js`): 5层全息图谱/增量更新/力导向布局/集群模式/脉冲星/黑洞效应
- **PersistenceStore** (`src/subagent/persistence-store.js`): WAL模式/批量写入/数据恢复/立即写入+flush
- **MemoryEngine增强**: 新增`getLayeredMemoryData()`方法（hot/warm/cold/exec/skill五层直接SQL查询）

### Changed
- `src/index.js`: VERSION→3.0.0，全面集成MessageProcessor/MemoryNetworkGraph/PersistenceStore，TICK/整合/API统一使用getLayeredMemoryData
- `src/core/consciousness-core.js`: 注入processorAnalysis（意图+实体+情感向量+Phase 3自检指令）
- `src/memory/memory-engine.js`: 新增`getLayeredMemoryData()` + `_normalizeMemoryRow()` + 兜底方案
- `package.json`: 版本升级至3.0.0，description更新

---

## [2.9.0] - 2026-06-06

### Added
- **MessageProcessor** (`src/subagent/message-processor.js`): 消息处理器/量子态管道/情感维度
- **MemoryNetworkGraph** (`src/subagent/memory-network-graph.js`): 记忆网络图/节点类型/边类型/聚类/布局
- **PersistenceStore** (`src/subagent/persistence-store.js`): 持久化存储基础设施

---

## [2.8.0] - 2026-06-06

### Added
- **SkillInstaller** (`src/subagent/subagent-skill-installer.js`): 技能安装/解析/验证
- **MemoryBinder** (`src/subagent/subagent-memory-binder.js`): 技能记忆绑定/分层存储/衰减配置

---

## [2.7.0] - 2026-06-06

### Added
- **TeamManager** (`src/subagent/team-manager.js`): 团队创建/角色管理
- **TeamCoordinator** (`src/subagent/team-coordinator.js`): 协调模式/消息路由
- **ConsentGate** (`src/subagent/team-consent-gate.js`): 共识门控/投票机制

---

## [2.6.0] - 2026-06-06

### Added
- **SubAgentManager** (`src/subagent/subagent-manager.js`): 子智能体创建/配置/生命周期
- **SubAgentEngine** (`src/subagent/subagent-engine.js`): 子智能体执行引擎
- **SubAgentGuardian** (`src/subagent/subagent-guardian.js`): 安全边界/权限控制/行为审计
- **SubAgentScheduler** (`src/subagent/subagent-scheduler.js`): 任务分配/负载均衡/资源调度

---

## [2.5.0] - 2026-06-06

### Added (Phase 24-27 - 生产级基础设施 + 全系统完善)

#### Phase 24: 架构修复与优化
- **TICK并发处理器** (`src/bus/tick-concurrency.js`): 多槽位并行TICK处理，替代`_processingTick`单锁瓶颈，支持优先级队列/工作窃取/断路器保护(CIRCUIT_STATE: CLOSED/OPEN/HALF_OPEN)
- **分布式锁管理器** (`src/bus/distributed-lock.js`): 本地互斥锁+文件锁(跨进程flock)，可重入锁支持，自动过期清理，Redis/ZK预留接口
- **优雅重启管理器** (`src/bus/graceful-restart.js`): 零停机重启(新旧进程交接)，健康检查端点(`/health`,`/ready`,`/live`,`/metrics`,`/drain`)，信号处理(SIGTERM/SIGINT/SIGUSR1/SIGUSR2)，启动预热
- **速率限制器** (`src/bus/rate-limiter.js`): 三种算法(令牌桶/滑动窗口/固定窗口)，多维度限流(IP/用户/API Key/全局)，可配置规则

#### Phase 25: 扩展层完整实现
- **浏览器自动化** (`src/execution/browser-automation.js`): Playwright完整实现，30+操作(navigate/click/type/screenshot/pdf/extract_text/extract_html/extract_links/extract_table/fill_form/evaluate/get_performance等)，多页面管理，网络拦截，Cookie/Session管理
- **社交分发** (`src/social/social-dispatch.js`): 8通道完整实现(Discord/Slack/企业微信/飞书/Telegram/Email/Webhook/Custom)，消息模板引擎，通道状态监控，消息队列+重试，入站消息路由
- **语音系统** (`src/voice/voice-system.js`): 完整ASR+TTS实现，多Provider(OpenAI Whisper/本地Whisper/Azure+OpenAI TTS/Edge TTS)，流式识别，批量合成，多语言支持

#### Phase 26: Prometheus监控
- **Prometheus指标导出器** (`src/utils/prometheus-metrics.js`): 完整Counter/Gauge/Histogram/Summary实现，内置30+指标(HTTP/TICK/Token/事件总线/消息队列/内存/CPU/LLM/三核状态/系统信息)，标准Prometheus文本格式导出

#### Phase 27: 微服务基础设施
- **微服务注册发现** (`src/deploy/microservice-registry.js`): 服务注册/注销/发现，心跳+健康检查，4种负载均衡策略(轮询/随机/加权/最少连接)，服务降级，本地文件持久化，Consul/Etcd/K8s预留接口

#### Bug修复
- **Fibonacci计算优化**: `error-handler.js`和`message-queue-manager.js`中递归Fibonacci改为O(n)迭代实现，避免栈溢出和O(2^n)复杂度
- **事件循环延迟修复**: `performance-monitor.js`中`_measureEventLoopDelay()`从空实现改为精确测量(perf_hooks.monitorEventLoopDelay + 手动间隔测量)
- **API版本号统一**: `api-server.js`中版本号从`2.1.0`更正为`2.4.0`
- **空catch块**: 所有`catch {}`添加说明注释

### Changed
- `src/index.js`: VERSION→2.5.0，集成TickConcurrency替代`_processingTick`锁，集成DistributedLock/GracefulRestart/RateLimiter/PrometheusMetrics/MicroServiceRegistry，start()启动健康检查服务和指标定时器，stop()优雅关闭所有新模块，新增30+公共API
- `README.md`: 版本更新至v2.5，项目结构完善，新增v2.4/v2.5特性说明
- `src/bus/message-queue-manager.js`: Fibonacci改为迭代实现
- `src/utils/error-handler.js`: Fibonacci改为迭代实现

## [2.4.0] - 2026-06-06

### Added (Phase 23 - 工程化增强)
- **配置Schema验证器** (`src/config/config-schema-validator.js`): JSON Schema驱动验证，类型/枚举/范围/正则/required校验，自定义业务规则（端口冲突/API Key占位符/内存阈值/Node版本），配置自动迁移（v2.3→v2.4），环境变量占位符解析（`${ENV_VAR}`和`${ENV_VAR:default}`格式）
- **消息队列管理器** (`src/bus/message-queue-manager.js`): 持久化消息队列（原子写入，重启恢复），容量限制+溢出策略（拒绝/丢弃旧/丢弃低优先级/死信），死信队列（DLQ）支持重放/清空/查看，指数退避重试（linear/exponential/fibonacci），消息TTL过期自动清理，优先级队列排序
- **异步日志增强** (`src/utils/logger.js`): 异步非阻塞IO写入，缓冲区批处理（bufferSize/flushInterval），优雅关闭flush确保日志不丢失，日志级别热更新（字符串/数值双向），临时级别提升（setTempLevel），增强统计（bufferFlushes/overflow/asyncErrors）
- **npm发布配置**: `.npmignore` 排除开发/测试/数据文件，`publishConfig` 公开包配置，`prepublishOnly` 自动检查脚本（Node版本/ESLint/测试/版本一致性/敏感信息/安全审计），`files` 字段精确控制发布内容
- **性能监控集成** (`src/utils/performance-monitor.js`): 现已集成到Agent主类，TICK处理延迟追踪，吞吐量统计，资源快照（CPU/内存/事件循环），健康检查注册与运行
- **新增npm scripts**: `test:config-validator`, `test:message-queue`, `prepublishOnly`, `publish:dry`, `publish:check`, `validate:config`, `audit:security`
- **新增公开API**: `validateConfig()`, `validateAndMigrateConfig()`, `getConfigSchema()`, `getMessageQueueStats()`, `getDeadLetters()`, `replayDeadLetter()`, `replayAllDeadLetters()`, `clearDeadLetters()`, `setLogLevel()`, `getLogLevel()`, `getFullPerformanceReport()`, `getResourceSnapshot()`, `runHealthChecks()`, `registerHealthCheck()`

### Changed
- `src/index.js`: VERSION → 2.4.0，消息队列从数组升级为MessageQueueManager（持久化+死信），sendMessage使用MQ入队，TICK处理使用MQ出队+自动complete，start时自动验证配置，stop时优雅关闭MQ+Logger+PerfMonitor，集成PerformanceMonitor到TICK循环
- `src/utils/logger.js`: close()改为async（flush缓冲区），新增closeSync()向后兼容，新增getLevel/getLevelValue/setTempLevel
- `package.json`: 版本升级至2.4.0，新增repository/bugs/homepage/publishConfig/files字段

## [2.3.0] - 2026-06-06

### Added (Phase 19-23)
- **统一日志系统集成**: Logger 替代所有 `console.log/warn/error`，支持多级别/多输出/结构化日志
- **统一错误处理器集成**: ErrorHandler 全面接管异常处理，支持分类/重试策略/safeExecute
- **JWT Secret 持久化**: JWT Secret 自动保存到文件，服务重启后 Token 仍然有效
- **会话持久化**: 活跃会话自动持久化到磁盘，重启后自动恢复
- **LLM Provider 集成层**: 新增 `LLMProvider` 类，提供统一的 OpenAI 兼容 API 调用接口
- **多模态引擎增强**: 新增本地图片信息获取/格式转换/批量处理等降级功能
- **OpenAPI 规范**: 完整的 OpenAPI 3.0.3 规范文档 (`docs/openapi.yaml`)
- **CHANGELOG**: 项目变更日志

### Changed (Phase 19)
- `src/index.js`: 全面集成 Logger/ErrorHandler，替代所有裸 console 调用
- `src/enterprise/rbac-manager.js`: JWT Secret 持久化 + 会话持久化 + 定时清理
- `src/enterprise/audit-logger.js`: 注入 Logger 用于错误记录
- `package.json`: 版本升级至 2.3.0

### Added (Phase 20 - 测试)
- `tests/unit/logger.test.js`: Logger 单元测试 (初始化/级别/上下文/事件/文件/统计)
- `tests/unit/router.test.js`: ModelRouter 单元测试 (Provider/用途/能力/路由)
- `tests/unit/core-bus.test.js`: CoreBus 单元测试 (分发/追踪/诊断/频道)
- `tests/unit/security-boundary.test.js`: SecurityBoundary 单元测试 (授权/铁律/安全模式)
- `tests/unit/budget.test.js`: TokenBudgetManager 单元测试 (请求/节流/自适应/缓存)
- `tests/unit/memory.test.js`: MemoryEngine 单元测试 (CRUD/搜索/层级/统计)
- `tests/unit/tool-calling.test.js`: ToolCallingEngine 单元测试 (注册/执行/并行/顺序/缓存)
- `tests/unit/rag.test.js`: RAGEngine 单元测试 (文档管理/检索/问答)
- `tests/unit/multimodal.test.js`: MultiModalEngine 单元测试 (图片/文档/OCR/截图)
- `tests/unit/consciousness.test.js`: ConsciousnessCore 单元测试 (初始化/TICK/状态)
- `tests/e2e/tricore-e2e.test.js`: 端到端集成测试 (完整生命周期/企业模块/配置管理)

## [2.2.0] - 2026-06-05

### Added (Phase 15-18)
- **Phase 15 - 安全加固**: PBKDF2 600K迭代、JWT标准认证、IP绑定、空catch修复
- **Phase 16 - 测试体系**: scheduler/rbac/encryption/audit/error-handler 单元测试 + governance/enterprise 集成测试
- **Phase 17 - 文档体系**: README、架构文档、API文档、部署指南
- **Phase 18 - 工程化**: 统一Logger、统一ErrorHandler、Docker配置、ESLint、CI/CD

## [2.1.0] - 2026-06-04

### Added
- **Phase 12 - LLM深度集成**: ToolCalling引擎、RAG引擎
- **Phase 13 - 多模态感知**: 多模态引擎（图像/截图/文档）
- **Phase 14 - 企业级特性**: RBAC管理器、审计日志器、加密服务

## [2.0.0] - 2026-06-03

### Added
- **治理层**: 核心总线(CoreBus)、安全边界(SecurityBoundary)、Token预算(TokenBudgetManager)、多模型协同(ModelRouter)
- **三核架构**: 意识核(ConsciousnessCore)、执行核(ExecutionCore)、进化核(EvolutionCore)
- **扩展层**: 浏览器自动化、社交分发、语音系统、API服务
- **协作层**: 多Agent协作、技能市场
- **部署层**: 进程管理

## [1.0.0] - 2026-06-01

### Added
- 初始版本：基础Agent框架
- 统一调度器(UnifiedScheduler)
- 记忆引擎(MemoryEngine)
- 基础配置管理
