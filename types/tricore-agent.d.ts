/**
 * Type declarations for TriCoreAgent — 三核融合智能体主类
 *
 * 入口: src/index.js
 * 类名: TriCoreAgent
 */

declare module 'mitang-tricore-agent' {
  import { EventEmitter } from 'events';

  // ── 版本信息 ──
  export const VERSION: string;
  export const CODENAME: string;
  export const BRAND_NAME: string;

  // ═══════════════════════════════════════
  // TriCoreAgent 构造选项
  // ═══════════════════════════════════════

  interface TriCoreAgentOptions {
    /** 数据目录路径，默认 process.cwd()/data */
    dataDir?: string;
    /** Agent 名称 */
    name?: string;
    /** 系统人设文本 */
    persona?: string;
    /** 插件目录路径 */
    pluginsDir?: string;
    /** 是否自动激活插件 */
    autoActivatePlugins?: boolean;
    /** 是否启用插件文件监听 */
    pluginWatch?: boolean;
    /** 觉醒期 TICK 数量 */
    awakeningTicks?: number;
    /** 觉醒期 TICK 间隔 (ms) */
    awakeningInterval?: number;
    /** 活跃期 TICK 间隔 (ms) */
    activeInterval?: number;
    /** 意识期 TICK 间隔 (ms) */
    consciousInterval?: number;
    /** 进化期 TICK 间隔 (ms) */
    evolutionInterval?: number;
    /** 空闲期 TICK 间隔 (ms) */
    idleInterval?: number;
    /** 最大并发任务数 */
    maxConcurrentTasks?: number;
    /** 任务最大重试次数 */
    maxRetries?: number;
    /** 沙箱目录 */
    sandboxDir?: string;
    /** 记忆整合间隔 (ms) */
    consolidationInterval?: number;
    /** 技能最小轨迹数 */
    minTracesForSkill?: number;
    /** API 服务器端口 */
    port?: number;
    /** API 服务器主机 */
    host?: string;
    /** API Token */
    apiToken?: string;
    /** 允许 LAN 访问 */
    allowLan?: boolean;
  }

  // ═══════════════════════════════════════
  // 启动配置
  // ═══════════════════════════════════════

  interface StartConfig {
    /** LLM Provider 名称 */
    provider?: string;
    /** API Key */
    apiKey?: string;
    /** 模型名称 */
    model?: string;
    /** 是否启动 API 服务（默认 true） */
    startApi?: boolean;
  }

  // ═══════════════════════════════════════
  // 消息元数据
  // ═══════════════════════════════════════

  interface MessageMeta {
    channel?: string;
    urgent?: boolean;
    priority?: number;
    parentMsgId?: string | null;
    metadata?: Record<string, unknown>;
  }

  // ═══════════════════════════════════════
  // Agent 状态
  // ═══════════════════════════════════════

  interface AgentStatus {
    version: string;
    codename: string;
    brandName: string;
    running: boolean;
    scheduler: unknown;
    consciousness: unknown;
    execution: unknown;
    evolution: unknown;
    browser: unknown;
    social: unknown;
    voice: unknown;
    api: unknown;
    memory: unknown;
    router: unknown;
    coordination: unknown;
    skillMarket: unknown;
    budget: unknown;
    security: unknown;
    busDiagnostics: unknown;
    toolCalling: unknown;
    rag: unknown;
    multimodal: unknown;
    rbac: unknown;
    audit: unknown;
    encryption: unknown;
    logger: unknown;
    errorHandler: unknown;
    messageQueue: unknown;
    performance: unknown;
    tickConcurrency: unknown;
    distLock: unknown;
    gracefulRestart: unknown;
    rateLimiter: unknown;
    microRegistry: unknown;
    subAgents: unknown;
    subAgentGuardian: unknown;
    subAgentScheduler: unknown;
    teams: unknown;
    skillInstaller: unknown;
    messageProcessor: unknown;
    memoryNetworkGraph: unknown;
    startupSelfCheck: unknown;
    plugins: unknown;
  }

  // ═══════════════════════════════════════
  // 主类
  // ═══════════════════════════════════════

  class TriCoreAgent extends EventEmitter {
    constructor(options?: TriCoreAgentOptions);

    // ── 生命周期 ──
    start(config?: StartConfig): Promise<void>;
    stop(): Promise<void>;

    // ── 消息接口 ──
    sendMessage(userId: string, content: string, meta?: MessageMeta): string | null;
    submitTask(goal: string, context?: Record<string, unknown>): Promise<string | null>;

    // ── 记忆 API ──
    searchMemories(query: string, limit?: number): unknown[];
    searchSkills(query: string, limit?: number): unknown[];
    auditSkill(skillId: string, decision: string, reason?: string): unknown;

    // ── 配置 API ──
    getConfig(key: string): unknown;
    setConfig(key: string, value: unknown): void;
    validateConfig(options?: Record<string, unknown>): unknown;
    validateAndMigrateConfig(options?: Record<string, unknown>): unknown;
    getConfigSchema(): unknown;

    // ── 记忆网络图 API ──
    getMemoryGraphData(): { nodes: unknown[]; edges: unknown[]; clusters: unknown[] };
    rebuildMemoryGraph(): { nodes: unknown[]; edges: unknown[]; clusters: unknown[] };

    // ── 团队 API ──
    addTeamMember(teamId: string, agentId: string, role?: string): unknown;
    removeTeamMember(teamId: string, agentId: string): unknown;

    // ── Prometheus API ──
    exportPrometheusMetrics(): string;
    recordHttpMetric(method: string, path: string, status: number, durationMs: number): void;
    recordLLMMetric(provider: string, purpose: string, status: string, tokensUsed: number, durationMs: number): void;

    // ── 日志 API ──
    setLogLevel(level: string): { level: string };
    getLogLevel(): string;

    // ── 子智能体 API ──
    listSubAgentEngines(): unknown[];
    getSubAgentWSStats(): unknown;
    initSubAgentWebSocket(options?: Record<string, unknown>): unknown;

    // ── 状态 ──
    getStatus(): AgentStatus;

    // ── 属性访问器 ──
    get execution(): unknown;
    get browser(): unknown;
    get social(): unknown;
    get voice(): unknown;
    get api(): unknown;
    get bus(): unknown;
    get security(): unknown;
    get budget(): unknown;
    get toolCalling(): unknown;
    get rag(): unknown;
    get multimodal(): unknown;
    get rbac(): unknown;
    get audit(): unknown;
    get encryption(): unknown;
    get logger(): unknown;
    get errorHandler(): unknown;
    get configValidator(): unknown;
    get messageQueue(): unknown;
    get perfMonitor(): unknown;
    get tickConcurrency(): unknown;
    get distLock(): unknown;
    get gracefulRestart(): unknown;
    get rateLimiter(): unknown;
    get prometheus(): unknown;
    get microRegistry(): unknown;
    get subAgentManager(): unknown;
    get subAgentGuardian(): unknown;
    get subAgentScheduler(): unknown;
    get teamManager(): unknown;
    get messageProcessor(): unknown;
    get memoryNetworkGraph(): unknown;
    get startupSelfCheck(): unknown;
    get pluginLoader(): unknown;
    get pluginHooks(): unknown;
  }

  export { TriCoreAgent };
}
