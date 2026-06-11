/**
 * Type declarations for ConsciousnessCore — 意识核
 *
 * 入口: src/core/consciousness-core.js
 *
 * 继承白龙马的核心设计：
 *   1. TICK循环引擎
 *   2. 双层思考 L1/L2
 *   3. 焦点栈LLM仲裁
 *   4. 记忆注入器
 *   5. 觉醒期探索
 *   6. Prompt注入防护
 */

declare module 'mitang-tricore-agent' {
  import { EventEmitter } from 'events';

  // ── 思考层级 ──
  export const THINK_LAYER: {
    readonly L1: 'l1';
    readonly L2: 'l2';
  };
  type ThinkLayer = 'l1' | 'l2';

  // ── TICK 类型 ──
  export const TICK_TYPE: {
    readonly USER_MESSAGE: 'user_message';
    readonly BACKGROUND: 'background';
    readonly IDLE_THINK: 'idle_think';
    readonly AWAKENING: 'awakening';
  };
  type TickType = 'user_message' | 'background' | 'idle_think' | 'awakening';

  // ── TICK 输入 ──
  interface TickInput {
    type: TickType;
    message?: MessageInput | null;
    tickNumber: number;
    budgetThrottle?: string;
    suggestedPurpose?: string;
    processorAnalysis?: ProcessorAnalysis | null;
  }

  interface MessageInput {
    id: string;
    from: string;
    content: string;
    channel?: string;
    priority?: number;
    traceId?: string;
    metadata?: Record<string, unknown>;
  }

  interface ProcessorAnalysis {
    intent?: { primary: string; confidence: number; alternatives?: string[] };
    entities?: Array<{ name: string; type: string; value: string }>;
    affect?: { valence: number; arousal: number; dominance: number };
    complexity?: { score: number; reason?: string };
    language?: { detected: string; confidence: number };
    selfCheckPhase3?: {
      active: boolean;
      directions: string;
    };
  }

  // ── TICK 输出 ──
  interface TickResult {
    layer: ThinkLayer;
    response: string | null;
    thoughts: string[];
    focusUpdate: boolean;
    toolCalls?: ToolCall[];
    cacheHit?: boolean;
  }

  interface ToolCall {
    id?: string;
    type: 'function';
    function: {
      name: string;
      arguments: string | Record<string, unknown>;
    };
  }

  // ── 自适应间隔配置 ──
  interface AdaptiveIntervals {
    awakening: number;
    active: number;
    conscious: number;
    evolution: number;
    idle: number;
  }

  // ── 构造选项 ──
  interface ConsciousnessCoreOptions {
    memory?: unknown;
    router?: unknown;
    bus?: unknown;
    security?: unknown;
    budget?: unknown;
    awakeningTicks?: number;
    awakeningInterval?: number;
    activeInterval?: number;
    consciousInterval?: number;
    evolutionInterval?: number;
    idleInterval?: number;
    focusClassifierTimeout?: number;
    l1CacheMaxSize?: number;
    l1CacheTTL?: number;
  }

  // ── 状态 ──
  interface ConsciousnessStatus {
    tickCounter: number;
    thoughtStackDepth: number;
    awakeningRemaining: number;
    l1CacheSize: number;
    promptCacheVersion: number;
    adaptiveIntervals: AdaptiveIntervals;
    messageCount: number;
  }

  // ── 主类 ──
  class ConsciousnessCore extends EventEmitter {
    constructor(options?: ConsciousnessCoreOptions);

    /** 处理一个 TICK */
    processTick(tick: TickInput): Promise<TickResult>;

    /** 获取当前状态 */
    getStatus(): ConsciousnessStatus;

    /** 事件: task_needed — 意识核建议执行任务 */
    on(event: 'task_needed', listener: (data: { goal: string; context?: Record<string, unknown> }) => void): this;
    /** 事件: focus_changed — 焦点栈变化 */
    on(event: 'focus_changed', listener: (data: { from: unknown; to: unknown }) => void): this;
  }

  export { ConsciousnessCore };
}
