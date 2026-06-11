/**
 * Type declarations for EvolutionCore — 进化核
 *
 * 入口: src/core/evolution-core.js
 *
 * 继承爱马仕的核心设计：
 *   1. 自动技能沉淀引擎 — 从执行轨迹提取可复用技能
 *   2. SKILL.md 开放标准 — 可搜索/可分享/可移植
 *   3. 技能审计系统 — 安全约束，自动沉淀必须审计
 *   4. 记忆整合循环 — 去重/降级/合并/衰减
 *   5. 轨迹分析器 — 分析执行模式，发现改进机会
 */

declare module 'mitang-tricore-agent' {
  import { EventEmitter } from 'events';

  // ── 技能状态 ──
  export const SKILL_STATUS: {
    readonly PENDING: 'pending';
    readonly APPROVED: 'approved';
    readonly REJECTED: 'rejected';
    readonly DEPRECATED: 'deprecated';
  };
  type SkillStatus = 'pending' | 'approved' | 'rejected' | 'deprecated';

  // ── 技能类别 ──
  export const SKILL_CATEGORY: {
    readonly DATA_PROCESSING: 'data_processing';
    readonly FILE_OPERATION: 'file_operation';
    readonly WEB_INTERACTION: 'web_interaction';
    readonly CODE_GENERATION: 'code_generation';
    readonly ANALYSIS: 'analysis';
    readonly COMMUNICATION: 'communication';
    readonly AUTOMATION: 'automation';
    readonly GENERAL: 'general';
  };
  type SkillCategory =
    | 'data_processing'
    | 'file_operation'
    | 'web_interaction'
    | 'code_generation'
    | 'analysis'
    | 'communication'
    | 'automation'
    | 'general';

  // ── 技能 ──
  interface Skill {
    id: number;
    name: string;
    description: string;
    content: string;
    category: SkillCategory;
    status: SkillStatus;
    trigger_keywords?: string;
    auto_created: boolean;
    use_count: number;
    created_at: number;
    updated_at: number;
  }

  // ── 沉淀的技能 ──
  interface ExtractedSkill {
    name: string;
    description: string;
    category: SkillCategory;
    triggers: string[];
    steps: string[];
    caveats: string[];
  }

  // ── 整合报告 ──
  interface ConsolidationReport {
    memoriesMerged: number;
    memoriesDecayed: number;
    memoriesEvicted: number;
    skillsAutoApproved: number;
    skillsRejected: number;
    duration: number;
  }

  // ── 构造选项 ──
  interface EvolutionCoreOptions {
    memory?: unknown;
    router?: unknown;
    bus?: unknown;
    security?: unknown;
    budget?: unknown;
    consolidationInterval?: number;
    minTracesForSkill?: number;
    maxPendingSkills?: number;
    skillSimilarityThreshold?: number;
    consolidationRetryMax?: number;
    consolidationRetryBaseDelay?: number;
  }

  // ── 状态 ──
  interface EvolutionStatus {
    consolidationInterval: number;
    minTracesForSkill: number;
    maxPendingSkills: number;
    pendingSkillCount: number;
    approvedSkillCount: number;
    executionPatterns: number;
    lastConsolidationAt: number;
  }

  // ── 主类 ──
  class EvolutionCore extends EventEmitter {
    constructor(options?: EvolutionCoreOptions);

    /** 从任务轨迹中提取技能 */
    extractSkillFromTask(taskId: string): Promise<ExtractedSkill | null>;

    /** 审计技能 */
    auditSkill(skillId: string, decision: SkillStatus, reason?: string): boolean;

    /** 自动审计安全技能 */
    autoAuditSafeSkills(): number;

    /** 运行整合循环 */
    runConsolidation(): Promise<ConsolidationReport>;

    /** 启动整合循环（定时器） */
    startConsolidationLoop(): void;

    /** 停止整合循环 */
    stopConsolidationLoop(): void;

    /** 获取状态 */
    getStatus(): EvolutionStatus;

    /** 事件: skill_extracted */
    on(event: 'skill_extracted', listener: (data: { name: string; category: SkillCategory; sourceTask: string; status: SkillStatus }) => void): this;
    /** 事件: skill_audited */
    on(event: 'skill_audited', listener: (data: { skillId: string; decision: SkillStatus }) => void): this;
    /** 事件: skill_deduplicated */
    on(event: 'skill_deduplicated', listener: (data: { existingSkill: string; newDescription: string }) => void): this;
    /** 事件: skill_queue_full */
    on(event: 'skill_queue_full', listener: (data: { pendingCount: number }) => void): this;
    /** 事件: consolidation_complete */
    on(event: 'consolidation_complete', listener: (data: ConsolidationReport) => void): this;
  }

  export { EvolutionCore };
}
