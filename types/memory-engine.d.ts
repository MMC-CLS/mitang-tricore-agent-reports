/**
 * Type declarations for MemoryEngine — 增强记忆引擎
 *
 * 入口: src/memory/memory-engine.js
 *
 * FTS5+向量双路召回 + 记忆衰减 + 分层管理
 *
 * 记忆分层：
 *   L0: 热记忆 (Hot)     — salience >= 5, age < 7天
 *   L1: 温记忆 (Warm)    — salience >= 3, age < 30天
 *   L2: 冷记忆 (Cold)    — salience < 3 或 age >= 30天
 *   L3: 执行记忆 (Exec)  — 任务执行轨迹
 *   L4: 技能记忆 (Skill) — SKILL.md 标准
 */

declare module 'mitang-tricore-agent' {

  // ── 记忆层级 ──
  export const MEMORY_TIER: {
    readonly HOT: 'hot';
    readonly WARM: 'warm';
    readonly COLD: 'cold';
    readonly EXEC: 'exec';
    readonly SKILL: 'skill';
  };
  type MemoryTier = 'hot' | 'warm' | 'cold' | 'exec' | 'skill';

  // ── 衰减配置 ──
  export const DECAY_CONFIG: {
    readonly SALIENCE_DECAY_PER_DAY: 0.1;
    readonly MIN_SALIENCE: 1.0;
    readonly HOT_THRESHOLD: 5.0;
    readonly WARM_THRESHOLD: 3.0;
    readonly MAX_MEMORIES: 10000;
    readonly EVICTION_BATCH: 100;
    readonly CONSOLIDATION_INTERVAL: 1800000;
  };

  // ── 记忆条目 ──
  interface MemoryEntry {
    id: number;
    content: string;
    summary: string | null;
    tier: MemoryTier;
    salience: number;
    mem_type: 'fact' | 'preference' | 'event' | 'procedure';
    tags: string[] | null;
    source: 'conversation' | 'execution' | 'skill' | 'system';
    source_id: string | null;
    embedding: Buffer | null;
    hit_count: number;
    last_hit_at: number | null;
    created_at: number;
    updated_at: number;
    expires_at: number | null;
  }

  // ── 搜索选项 ──
  interface SearchOptions {
    text: string;
    limit?: number;
    tierFilter?: MemoryTier;
    memType?: string;
    minSalience?: number;
    useVector?: boolean;
    useFts?: boolean;
  }

  // ── 搜索命中 ──
  interface SearchHit {
    id: number;
    content: string;
    summary: string | null;
    tier: MemoryTier;
    salience: number;
    mem_type: string;
    score: number;
    created_at: number;
  }

  // ── 执行轨迹 ──
  interface ExecutionTrace {
    id: number;
    task_id: string;
    step_index: number;
    success: boolean;
    action: string;
    input: string;
    output: string;
    error: string | null;
    duration_ms: number;
    created_at: number;
  }

  // ── 技能条目 ──
  interface SkillEntry {
    id: number;
    name: string;
    description: string;
    content: string;
    category: string;
    status: string;
    trigger_keywords: string | null;
    auto_created: boolean;
    use_count: number;
    created_at: number;
    updated_at: number;
  }

  // ── 分层记忆数据 ──
  interface LayeredMemoryData {
    layers: {
      hot: LayerMemoryItem[];
      warm: LayerMemoryItem[];
      cold: LayerMemoryItem[];
      exec: LayerMemoryItem[];
      skill: LayerMemoryItem[];
    };
  }

  interface LayerMemoryItem {
    id: string;
    title: string;
    content: string;
    salience: number;
    timestamp: number;
    type: string;
    tier: MemoryTier;
    entities: string[];
  }

  // ── 构造选项 ──
  interface MemoryEngineOptions {
    dbPath?: string;
    computeEmbedding?: ((text: string) => Promise<number[] | null>) | null;
    embeddingCacheSize?: number;
    layeredCacheTTL?: number;
    annEnabled?: boolean;
    annDimensions?: number;
    annNumTables?: number;
  }

  // ── 统计 ──
  interface MemoryStats {
    totalMemories: number;
    byTier: Record<string, number>;
    byType: Record<string, number>;
    totalSkills: number;
    pendingSkills: number;
    cacheSize: number;
    annIndexSize: number;
  }

  // ── 主类 ──
  class MemoryEngine {
    constructor(options?: MemoryEngineOptions);

    /** 初始化数据库和表结构 */
    init(): void;

    /** 关闭数据库 */
    close(): void;

    /** 搜索记忆（FTS5 + 向量双路召回） */
    search(options: SearchOptions): SearchHit[];

    /** 搜索技能 */
    searchSkills(query: string, limit?: number): SkillEntry[];

    /** 保存记忆 */
    save(memory: Partial<MemoryEntry>): number;

    /** 获取执行轨迹 */
    getExecutionTrace(taskId: string): ExecutionTrace[];

    /** 保存技能 */
    saveSkill(skill: Partial<SkillEntry>): number;

    /** 记录技能使用 */
    recordSkillUse(skillId: number): void;

    /** 获取待审计技能数量 */
    getPendingSkillCount(): number;

    /** 获取分层记忆数据（用于记忆网络图） */
    getLayeredMemoryData(): LayeredMemoryData;

    /** 获取统计信息 */
    getStats(): MemoryStats;
  }

  export { MemoryEngine };
}
