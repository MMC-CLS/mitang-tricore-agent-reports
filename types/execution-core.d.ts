/**
 * Type declarations for ExecutionCore — 执行核
 *
 * 入口: src/core/execution-core.js
 *
 * 继承龙虾的核心设计：
 *   1. 任务闭环引擎 — 目标→拆解→执行→校验→错误修正
 *   2. 工具执行器 — 安全沙箱隔离
 *   3. 浏览器自动化接口 — Playwright 控制
 *   4. 插件市场 — 可安装/卸载的扩展工具
 *   5. 执行安全约束 — 权限分级/操作审计/回滚能力
 */

declare module 'mitang-tricore-agent' {
  import { EventEmitter } from 'events';

  // ── 任务状态 ──
  export const TASK_STATUS: {
    readonly PENDING: 'pending';
    readonly PLANNING: 'planning';
    readonly EXECUTING: 'executing';
    readonly VERIFYING: 'verifying';
    readonly COMPLETED: 'completed';
    readonly FAILED: 'failed';
    readonly PAUSED: 'paused';
  };
  type TaskStatus = 'pending' | 'planning' | 'executing' | 'verifying' | 'completed' | 'failed' | 'paused';

  // ── 工具权限 ──
  export const TOOL_PERMISSION: {
    readonly SAFE: 'safe';
    readonly MODERATE: 'moderate';
    readonly DANGEROUS: 'dangerous';
  };
  type ToolPermission = 'safe' | 'moderate' | 'dangerous';

  // ── 工具定义 ──
  interface ToolDefinition {
    description: string;
    permission: ToolPermission;
    params: Record<string, ToolParamDef>;
  }

  interface ToolParamDef {
    type: string;
    required: boolean;
  }

  // ── 任务 ──
  interface Task {
    id: string;
    goal: string;
    context: Record<string, unknown>;
    priority: string;
    status: TaskStatus;
    steps: TaskStep[];
    currentStepIndex: number;
    results: unknown[];
    errors: Error[];
    createdAt: number;
    updatedAt: number;
  }

  interface TaskStep {
    action: string;
    params: Record<string, unknown>;
    expectedOutput?: string;
    verification?: string;
  }

  interface TaskDef {
    goal: string;
    context?: Record<string, unknown>;
    priority?: string;
  }

  // ── 插件 ──
  interface Plugin {
    name: string;
    tools: Record<string, ToolDefinition & { handler: Function }>;
    metadata?: Record<string, unknown>;
  }

  // ── 构造选项 ──
  interface ExecutionCoreOptions {
    memory?: unknown;
    router?: unknown;
    bus?: unknown;
    security?: unknown;
    budget?: unknown;
    maxConcurrentTasks?: number;
    maxRetries?: number;
    sandboxDir?: string;
  }

  // ── 状态 ──
  interface ExecutionStatus {
    totalTasks: number;
    activeTasks: number;
    completedTasks: number;
    failedTasks: number;
    installedPlugins: number;
    registeredTools: number;
  }

  // ── 内置工具常量 ──
  export const BUILTIN_TOOLS: Record<string, ToolDefinition>;

  // ── 主类 ──
  class ExecutionCore extends EventEmitter {
    constructor(options?: ExecutionCoreOptions);

    /** 创建并启动执行任务 */
    createTask(taskDef: TaskDef): Promise<string>;

    /** 获取任务 */
    getTask(taskId: string): Task | undefined;

    /** 执行所有待执行步骤 */
    executeAll(taskId: string): Promise<unknown[]>;

    /** 执行单个步骤 */
    executeStep(taskId: string): Promise<unknown>;

    /** 安装插件 */
    installPlugin(plugin: Plugin): void;

    /** 卸载插件 */
    uninstallPlugin(pluginName: string): boolean;

    /** 注册工具 */
    registerTool(name: string, definition: ToolDefinition, handler: Function): void;

    /** 获取状态 */
    getStatus(): ExecutionStatus;

    /** 事件: task_created */
    on(event: 'task_created', listener: (data: { taskId: string; goal: string }) => void): this;
    /** 事件: task_completed */
    on(event: 'task_completed', listener: (data: { taskId: string }) => void): this;
    /** 事件: task_failed */
    on(event: 'task_failed', listener: (data: { taskId: string; error: string }) => void): this;
    /** 事件: dangerous_action */
    on(event: 'dangerous_action', listener: (data: { taskId: string; step: TaskStep }) => void): this;
  }

  export { ExecutionCore };
}
