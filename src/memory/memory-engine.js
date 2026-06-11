/**
 * TriCore Agent - 增强记忆引擎 (Enhanced Memory Engine)
 *
 * 继承白龙马的FTS5+向量双路召回，新增：
 *   1. 记忆衰减机制（解决长期运行记忆膨胀问题）
 *   2. 执行记忆层（记录任务执行轨迹，供进化层学习）
 *   3. 技能记忆层（SKILL.md标准，可搜索可分享）
 *
 * 记忆分层：
 *   L0: 热记忆 (Hot)     - 当前焦点，每轮注入
 *   L1: 温记忆 (Warm)    - 近期高salience，按需召回
 *   L2: 冷记忆 (Cold)    - 历史低salience，仅关键词/向量命中
 *   L3: 执行记忆 (Exec)  - 任务执行轨迹，供技能沉淀
 *   L4: 技能记忆 (Skill) - SKILL.md标准，可复用知识
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// ── 记忆层级 ──
const MEMORY_TIER = Object.freeze({
  HOT: 'hot',      // salience >= 5, age < 7天
  WARM: 'warm',    // salience >= 3, age < 30天
  COLD: 'cold',    // salience < 3 或 age >= 30天
  EXEC: 'exec',    // 执行记忆
  SKILL: 'skill',  // 技能记忆
});

// ── 衰减配置 ──
const DECAY_CONFIG = Object.freeze({
  SALIENCE_DECAY_PER_DAY: 0.1,     // 每天salience衰减0.1
  MIN_SALIENCE: 1.0,               // 最低salience
  HOT_THRESHOLD: 5.0,              // 热记忆阈值
  WARM_THRESHOLD: 3.0,             // 温记忆阈值
  MAX_MEMORIES: 10000,             // 记忆数量上限
  EVICTION_BATCH: 100,             // 每次淘汰数量
  CONSOLIDATION_INTERVAL: 30 * 60 * 1000, // 整合间隔30分钟
});

class MemoryEngine {
  constructor(options = {}) {
    this._dbPath = options.dbPath || path.join(process.cwd(), 'data', 'memory.db');
    this._db = null;

    // 向量计算函数（外部注入，避免硬依赖）
    this._computeEmbedding = options.computeEmbedding || null;

    // LRU缓存
    this._embeddingCache = new Map();
    this._embeddingCacheMaxSize = options.embeddingCacheSize || 500;

    // v4.0: 分层记忆数据TTL缓存（减少高频TICK下的重复SQL查询）
    this._layeredCache = null;
    this._layeredCacheTime = 0;
    this._layeredCacheTTL = options.layeredCacheTTL ?? 5000; // 5秒默认

    // v4.0: ANN 近似最近邻向量搜索索引
    this._annIndex = null;
    this._annEnabled = options.annEnabled !== false;
    this._annDimensions = options.annDimensions || 1536;
    this._annNumTables = options.annNumTables || 10;

    // v4.3: 搜索缓存（Map-based, 30s TTL）
    this._searchCache = new Map();
    this._searchCacheTTL = options.searchCacheTTL || 30000; // 30秒默认
  }

  // ═══════════════════════════════════════
  // 初始化
  // ═══════════════════════════════════════

  /**
   * v4.2: 事务辅助方法 — 在单个事务中执行回调
   * 所有需要原子性的多步操作应使用此方法
   * @param {Function} fn - 在事务中执行的函数，接收 db 实例
   * @returns {any} fn 的返回值
   */
  _transaction(fn) {
    if (!this._db) throw new Error('Database not initialized');
    const txn = this._db.transaction(() => fn(this._db));
    return txn();
  }

  /**
   * 初始化数据库和表结构
   */
  init() {
    const fs = require('fs');
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this._db = new Database(this._dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');

    // v4.0: 自动执行 schema 迁移
    try {
      const { autoMigrate } = require('../data/schema-migrations');
      const result = autoMigrate(this._db);
      if (result.applied.length > 0) {
        // 静默迁移成功（可通过日志模块记录）
      }
    } catch (e) {
      // 迁移失败不阻止启动，回退到手动建表
      // 可在日志中记录: `this._log?.warn('Schema migration failed, falling back to manual creation', e.message)`
    }

    this._createTables();
    this._registerFunctions();

    // v4.3: ANN 向量搜索索引 — 强制启用，始终初始化
    // 如果 ann-index.js 模块加载失败，使用内联的轻量级实现
    try {
      const { ANNIndex, DISTANCE_METRIC } = require('./ann-index');
      this._annIndex = new ANNIndex({
        dimensions: this._annDimensions,
        numTables: this._annNumTables,
        metric: DISTANCE_METRIC.COSINE,
      });
    } catch (e) {
      // 极端降级：如果 ann-index.js 不存在，回退到 null（暴力扫描兜底）
      this._annIndex = null;
    }

    // 从数据库加载已有向量到 ANN 索引
    if (this._annIndex) {
      this._rebuildAnnIndex();
    }
  }

  _createTables() {
    this._db.exec(`
      -- 核心记忆表
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        summary TEXT,
        tier TEXT NOT NULL DEFAULT 'warm',
        salience REAL NOT NULL DEFAULT 3.0,
        mem_type TEXT NOT NULL DEFAULT 'fact',       -- fact | preference | event | procedure
        tags TEXT,                                     -- JSON array
        source TEXT,                                   -- conversation | execution | skill | system
        source_id TEXT,                                -- 关联ID（对话ID/任务ID/技能ID）
        embedding BLOB,                                -- 向量嵌入
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        expires_at INTEGER                              -- 过期时间（NULL=永不过期）
      );

      -- FTS5全文索引（trigram支持中文）
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        summary,
        tokenize='trigram'
      );

      -- 执行轨迹表
      CREATE TABLE IF NOT EXISTS execution_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        action TEXT NOT NULL,
        params TEXT,                                   -- JSON
        result TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      -- 技能表（SKILL.md标准）
      CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        content TEXT NOT NULL,                         -- SKILL.md正文
        category TEXT NOT NULL DEFAULT 'general',
        trigger_keywords TEXT,                         -- JSON array
        auto_created INTEGER NOT NULL DEFAULT 0,       -- 是否自动沉淀
        audit_status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      -- 焦点栈表
      CREATE TABLE IF NOT EXISTS focus_stack (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        frame_index INTEGER NOT NULL,
        topics TEXT NOT NULL,                          -- JSON array
        started_at_tick INTEGER NOT NULL,
        last_seen_tick INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        conclusions TEXT,                              -- JSON array
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
      CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(mem_type);
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
      CREATE INDEX IF NOT EXISTS idx_exec_traces_task ON execution_traces(task_id);
      CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
      CREATE INDEX IF NOT EXISTS idx_skills_audit ON skills(audit_status);
    `);
  }

  _registerFunctions() {
    // 注册向量余弦相似度函数
    this._db.function('vec_cosine_similarity', (aBuf, bBuf) => {
      if (!aBuf || !bBuf) return 0;
      const a = new Float32Array(aBuf.buffer, aBuf.byteOffset, aBuf.byteLength / 4);
      const b = new Float32Array(bBuf.buffer, bBuf.byteOffset, bBuf.byteLength / 4);
      if (a.length !== b.length) return 0;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
    });
  }

  // ═══════════════════════════════════════
  // 记忆写入
  // ═══════════════════════════════════════

  /**
   * 写入记忆（自动去重）
   * @param {Object} entry - { content, summary?, salience?, mem_type?, tags?, source?, source_id? }
   * @returns {number} memory id
   */
  upsert(entry) {
    const {
      content, summary = null,
      salience = 3.0, mem_type = 'fact',
      tags = null, source = 'conversation', source_id = null,
    } = entry;

    // 查重：FTS5搜索相似内容
    const existing = this._findDuplicate(content);
    if (existing) {
      // 合并：提升salience，更新内容
      const newSalience = Math.max(existing.salience, salience) + 0.5;
      return this._updateSalience(existing.id, newSalience);
    }

    // 插入新记忆
    const tier = this._computeTier(salience, 0);
    const tagsJson = tags ? JSON.stringify(tags) : null;

    const result = this._db.prepare(`
      INSERT INTO memories (content, summary, tier, salience, mem_type, tags, source, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(content, summary, tier, salience, mem_type, tagsJson, source, source_id);

    const memId = result.lastInsertRowid;

    // 同步FTS5
    this._db.prepare(`
      INSERT INTO memories_fts (rowid, content, summary)
      VALUES (?, ?, ?)
    `).run(memId, content, summary || '');

    // 异步计算embedding
    this._backfillEmbedding(memId, content);

    return memId;
  }

  /**
   * 批量写入
   */
  upsertBatch(entries) {
    const ids = [];
    const txn = this._db.transaction(() => {
      for (const entry of entries) {
        ids.push(this.upsert(entry));
      }
    });
    txn();
    return ids;
  }

  // ═══════════════════════════════════════
  // v1.0: 记忆更新与删除
  // ═══════════════════════════════════════

  /**
   * 更新记忆内容
   * @param {number} id - 记忆ID
   * @param {Object} updates - 要更新的字段 { content?, salience?, tags?, summary? }
   * @returns {Object|null} 更新后的记忆或null
   */
  update(id, updates) {
    const existing = this._db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!existing) return null;

    const newContent = updates.content || existing.content;
    const newSalience = updates.salience !== undefined ? updates.salience : existing.salience;
    const newTags = updates.tags ? JSON.stringify(updates.tags) : existing.tags;
    const newSummary = updates.summary || existing.summary;
    const newTier = this._computeTier(newSalience, existing.access_count || 0);

    this._db.prepare(`
      UPDATE memories SET content = ?, salience = ?, tier = ?, tags = ?, summary = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newContent, newSalience, newTier, newTags, newSummary, id);

    // 更新FTS5索引
    this._db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(id);
    this._db.prepare('INSERT INTO memories_fts (rowid, content, summary) VALUES (?, ?, ?)')
      .run(id, newContent, newSummary || '');

    return this._db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  }

  /**
   * 软删除记忆（降低salience到0，不物理删除）
   * @param {number} id - 记忆ID
   * @returns {boolean} 是否删除成功
   */
  delete(id) {
    const existing = this._db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!existing) return false;

    // 软删除：标记为deleted
    this._db.prepare(`
      UPDATE memories SET salience = 0, tier = 'deleted', deleted_at = datetime('now'), visibility = 'hidden'
      WHERE id = ?
    `).run(id);

    return true;
  }

  // ═══════════════════════════════════════
  // 记忆召回 - FTS5 + 向量双路
  // ═══════════════════════════════════════

  /**
   * 搜索相关记忆（双路召回）
   * @param {Object} query - { text, limit?, tierFilter? }
   * @returns {Array} 记忆列表
   */
  search(query) {
    const { text, limit = 10, offset = 0, tierFilter = null } = query;

    const results = [];

    // 路径1：FTS5全文搜索
    const ftsHits = this._searchFTS5(text, limit * 2);
    results.push(...ftsHits);

    // 路径2：向量嵌入搜索
    const vecHits = this._searchByEmbedding(text, limit, offset);
    for (const hit of vecHits) {
      if (!results.find(r => r.id === hit.id)) {
        results.push(hit);
      }
    }

    // 应用衰减
    const decayed = results.map(r => ({
      ...r,
      effectiveSalience: this._applyDecay(r.salience, r.created_at),
    }));

    // 排序：salience >= HOT_THRESHOLD 前置，然后按effectiveSalience降序
    decayed.sort((a, b) => {
      const aHot = a.effectiveSalience >= DECAY_CONFIG.HOT_THRESHOLD ? 1 : 0;
      const bHot = b.effectiveSalience >= DECAY_CONFIG.HOT_THRESHOLD ? 1 : 0;
      if (aHot !== bHot) return bHot - aHot;
      return b.effectiveSalience - a.effectiveSalience;
    });

    // 层级过滤
    const filtered = tierFilter
      ? decayed.filter(r => r.tier === tierFilter)
      : decayed;

    // 更新hit_count
    for (const r of filtered.slice(0, limit)) {
      this._recordHit(r.id);
    }

    return filtered.slice(0, limit);
  }

  /**
   * FTS5全文搜索
   */
  _searchFTS5(text, limit) {
    const keywords = this._extractKeywords(text, 8);
    if (keywords.length === 0) return [];

    const hits = [];
    for (const kw of keywords) {
      try {
        const rows = this._db.prepare(`
          SELECT m.id, m.content, m.summary, m.tier, m.salience,
                 m.mem_type, m.tags, m.source, m.created_at,
                 rank AS fts_rank
          FROM memories_fts f
          JOIN memories m ON m.id = f.rowid
          WHERE memories_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(kw, Math.ceil(limit / keywords.length));
        hits.push(...rows);
      } catch (e) {
        // FTS5查询可能因特殊字符失败，跳过
      }
    }

    // 去重
    const seen = new Set();
    return hits.filter(h => {
      if (seen.has(h.id)) return false;
      seen.add(h.id);
      return true;
    });
  }

  /**
   * 向量嵌入搜索（v4.0: 集成 ANN 近似最近邻索引）
   * 支持同步 embedding（预计算）和异步降级
   */
  async _searchByEmbedding(text, limit = 10, offset = 0) {
    // v4.3: 搜索缓存检查 — 相同查询文本在30秒内复用结果
    const cacheKey = this._hashString(text);
    const now = Date.now();
    const cached = this._searchCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < this._searchCacheTTL) {
      // 从缓存结果中分页
      const paged = cached.results.slice(offset, offset + limit);
      return paged;
    }

    // 尝试获取 embedding
    let embedding = null;
    try {
      if (this._computeEmbedding) {
        embedding = await this._computeEmbedding(text);
      }
    } catch { /* embedding 计算失败 */ }

    if (!embedding) return [];

    // v4.0: 优先使用 ANN 索引
    if (this._annIndex && this._annIndex.getStats().totalVectors > 0) {
      const annResults = this._annIndex.search(embedding, limit);
      if (annResults.length > 0) {
        // 根据 ANN 结果从数据库获取完整记忆数据
        const ids = annResults.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        const memories = this._db.prepare(`
          SELECT id, content, summary, tier, salience, mem_type, tags, source, created_at
          FROM memories WHERE id IN (${placeholders})
        `).all(...ids);

        // 按 ANN 分数排序
        const scoreMap = new Map(annResults.map(r => [r.id, r.score]));
        memories.sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0));

        const results = memories.map(m => ({ ...m, vector_score: scoreMap.get(m.id) }));

        // v4.3: 缓存搜索结果
        this._searchCache.set(cacheKey, { results, timestamp: now });
        // 简单缓存清理：超过1000条时清空
        if (this._searchCache.size > 1000) {
          this._searchCache.clear();
        }

        return results;
      }
    }

    // 降级: 暴力扫描（从数据库读取所有向量计算余弦相似度）
    // v4.3: 分页支持 — 扫描足够多的向量进行评分，然后在结果层分页
    try {
      // 扫描策略：至少扫描 offset+limit+100 条，确保分页有足够数据
      const scanLimit = Math.max(offset + limit + 100, 500);
      const rows = this._db.prepare(`
        SELECT id, content, summary, tier, salience, mem_type, tags, source, created_at, embedding
        FROM memories WHERE embedding IS NOT NULL
        ORDER BY id
        LIMIT ?
      `).all(scanLimit);

      const scored = [];
      for (const row of rows) {
        if (!row.embedding) continue;
        try {
          const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
          const score = this._cosineSimilarity(embedding, vec);
          if (score >= 0.5) {
            scored.push({
              id: row.id,
              content: row.content,
              summary: row.summary,
              tier: row.tier,
              salience: row.salience,
              mem_type: row.mem_type,
              tags: row.tags,
              source: row.source,
              created_at: row.created_at,
              vector_score: score,
            });
          }
        } catch { /* 跳过损坏的向量 */ }
      }

      scored.sort((a, b) => b.vector_score - a.vector_score);

      // v4.3: 缓存全部评分结果（分页在缓存命中时处理）
      this._searchCache.set(cacheKey, { results: scored, timestamp: now });
      if (this._searchCache.size > 1000) {
        this._searchCache.clear();
      }

      return scored.slice(offset, offset + limit);
    } catch {
      return [];
    }
  }

  /**
   * 余弦相似度计算（Fallback）
   */
  _cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? (dot / denom + 1) / 2 : 0;
  }

  // ═══════════════════════════════════════
  // 执行记忆
  // ═══════════════════════════════════════

  /**
   * 记录执行轨迹
   */
  recordExecutionTrace(trace) {
    const { task_id, step_index, action, params, result, success = true, duration_ms = null } = trace;
    this._db.prepare(`
      INSERT INTO execution_traces (task_id, step_index, action, params, result, success, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(task_id, step_index, action,
      params ? JSON.stringify(params) : null,
      result, success ? 1 : 0, duration_ms);
  }

  /**
   * 获取任务执行轨迹
   */
  getExecutionTrace(taskId) {
    return this._db.prepare(`
      SELECT * FROM execution_traces WHERE task_id = ? ORDER BY step_index
    `).all(taskId);
  }

  // ═══════════════════════════════════════
  // 技能记忆
  // ═══════════════════════════════════════

  /**
   * 沉淀技能（自动或手动）
   */
  saveSkill(skill) {
    const { name, description, content, category = 'general', trigger_keywords = null, auto_created = false } = skill;
    const keywordsJson = trigger_keywords ? JSON.stringify(trigger_keywords) : null;

    return this._db.prepare(`
      INSERT INTO skills (name, description, content, category, trigger_keywords, auto_created, audit_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        content = excluded.content,
        category = excluded.category,
        trigger_keywords = excluded.trigger_keywords,
        updated_at = strftime('%s','now') * 1000
    `).run(name, description, content, category, keywordsJson, auto_created ? 1 : 0, 'pending');
  }

  /**
   * 搜索技能
   */
  searchSkills(query, limit = 5) {
    const keywords = this._extractKeywords(query, 5);
    if (keywords.length === 0) {
      return this._db.prepare(`
        SELECT * FROM skills WHERE audit_status = 'approved'
        ORDER BY use_count DESC LIMIT ?
      `).all(limit);
    }

    const results = [];
    for (const kw of keywords) {
      const rows = this._db.prepare(`
        SELECT * FROM skills
        WHERE audit_status = 'approved'
        AND (name LIKE ? OR description LIKE ? OR category LIKE ?)
        LIMIT ?
      `).all(`%${kw}%`, `%${kw}%`, `%${kw}%`, limit);
      results.push(...rows);
    }

    // 去重
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    }).slice(0, limit);
  }

  /**
   * 审计技能（安全约束）
   */
  auditSkill(skillId, status) {
    return this._db.prepare(`
      UPDATE skills SET audit_status = ?, updated_at = strftime('%s','now') * 1000
      WHERE id = ?
    `).run(status, skillId);
  }

  /**
   * 记录技能使用
   */
  recordSkillUse(skillId) {
    return this._db.prepare(`
      UPDATE skills SET use_count = use_count + 1,
        last_used_at = strftime('%s','now') * 1000
      WHERE id = ?
    `).run(skillId);
  }

  // ═══════════════════════════════════════
  // 公共工具方法
  // ═══════════════════════════════════════

  /**
   * 提取关键词（公共接口）
   */
  extractKeywords(text, maxKeywords = 8) {
    return this._extractKeywords(text, maxKeywords);
  }

  // ═══════════════════════════════════════
  // 公共查询方法（消除跨层 _db 访问）
  // ═══════════════════════════════════════

  /**
   * 获取待审核技能数量
   * @returns {number}
   */
  getPendingSkillCount() {
    if (!this._db) return 0;
    const row = this._db.prepare(
      "SELECT COUNT(*) as c FROM skills WHERE audit_status = 'pending'"
    ).get();
    return row?.c || 0;
  }

  /**
   * 按ID获取技能
   * @param {number} id
   * @returns {Object|null}
   */
  getSkillById(id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM skills WHERE id = ?').get(id) || null;
  }

  /**
   * 获取最近执行轨迹
   * @param {number} limit
   * @param {number} sinceTimestamp - 起始时间戳(ms)
   * @returns {Array}
   */
  getRecentExecutionTraces(limit = 200, sinceTimestamp = null) {
    if (!this._db) return [];
    const since = sinceTimestamp || (Date.now() - 7 * 86400000);
    return this._db.prepare(`
      SELECT task_id, action, success, duration_ms, created_at
      FROM execution_traces
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(since, limit);
  }

  /**
   * 获取整合统计信息
   * @returns {Object}
   */
  getConsolidationStats() {
    if (!this._db) {
      return { totalMemories: 0, hotCount: 0, warmCount: 0, coldCount: 0, pendingSkillCount: 0 };
    }
    const hot = this._db.prepare("SELECT COUNT(*) as c FROM memories WHERE tier = 'hot'").get();
    const warm = this._db.prepare("SELECT COUNT(*) as c FROM memories WHERE tier = 'warm'").get();
    const cold = this._db.prepare("SELECT COUNT(*) as c FROM memories WHERE tier = 'cold'").get();
    const total = this._db.prepare("SELECT COUNT(*) as c FROM memories").get();
    return {
      totalMemories: total?.c || 0,
      hotCount: hot?.c || 0,
      warmCount: warm?.c || 0,
      coldCount: cold?.c || 0,
      pendingSkillCount: this.getPendingSkillCount(),
    };
  }

  /**
   * 获取记忆统计（按tier分组计数）
   * @returns {Array<{tier, count, avg_salience}>}
   */
  getMemoryStats() {
    if (!this._db) return [];
    return this._db.prepare(`
      SELECT tier, COUNT(*) as count, AVG(salience) as avg_salience
      FROM memories GROUP BY tier
    `).all();
  }

  /**
   * 通用记忆搜索
   * @param {string} query - 搜索文本
   * @param {Object} options - { limit?, tierFilter?, memType?, source?, offset? }
   * @returns {{ memories: Array, total: number }}
   */
  searchMemories(query, options = {}) {
    if (!this._db) return { memories: [], total: 0 };
    const { limit = 20, tierFilter = null, memType = null, source = null, offset = 0 } = options;

    let where = 'WHERE 1=1';
    const params = [];

    if (tierFilter) {
      where += ' AND tier = ?';
      params.push(tierFilter);
    }
    if (memType) {
      where += ' AND mem_type = ?';
      params.push(memType);
    }
    if (source) {
      where += ' AND source = ?';
      params.push(source);
    }
    if (query) {
      where += ' AND (content LIKE ? OR summary LIKE ?)';
      params.push(`%${query}%`, `%${query}%`);
    }

    const total = this._db.prepare(`SELECT COUNT(*) as c FROM memories ${where}`).get(...params)?.c || 0;

    const memories = this._db.prepare(`
      SELECT id, content, summary, tier, salience, mem_type, tags, source, source_id, created_at, updated_at
      FROM memories ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return { memories, total };
  }

  /**
   * 获取待审核技能列表（带自动创建标记过滤）
   * @param {boolean} autoCreatedOnly - 仅自动创建的技能
   * @returns {Array}
   */
  getPendingSkills(autoCreatedOnly = false) {
    if (!this._db) return [];
    if (autoCreatedOnly) {
      return this._db.prepare(
        "SELECT * FROM skills WHERE audit_status = 'pending' AND auto_created = 1"
      ).all();
    }
    return this._db.prepare(
      "SELECT * FROM skills WHERE audit_status = 'pending'"
    ).all();
  }

  // ═══════════════════════════════════════
  // 焦点栈
  // ═══════════════════════════════════════

  /**
   * 更新焦点栈
   * @param {string} event - created | kept | pushed | returned | cleared | noop
   * @param {Array} topics - 当前话题关键词
   * @param {number} tickNumber - 当前TICK编号
   */
  updateFocusStack(event, topics, tickNumber) {
    const MAX_DEPTH = 4;
    const STALE_TICKS = 20;

    // 清理失活帧
    this._db.prepare(`
      DELETE FROM focus_stack
      WHERE (? - last_seen_tick) > ?
    `).run(tickNumber, STALE_TICKS);

    const currentStack = this._db.prepare(`
      SELECT * FROM focus_stack ORDER BY frame_index ASC
    `).all();

    switch (event) {
      case 'created': {
        // 清空旧栈，创建首帧
        this._db.prepare('DELETE FROM focus_stack').run();
        this._db.prepare(`
          INSERT INTO focus_stack (frame_index, topics, started_at_tick, last_seen_tick, hit_count)
          VALUES (0, ?, ?, ?, 1)
        `).run(JSON.stringify(topics), tickNumber, tickNumber);
        break;
      }
      case 'kept': {
        // 命中栈顶，更新
        const top = currentStack[currentStack.length - 1];
        if (top) {
          this._db.prepare(`
            UPDATE focus_stack SET last_seen_tick = ?, hit_count = hit_count + 1
            WHERE id = ?
          `).run(tickNumber, top.id);
        }
        break;
      }
      case 'pushed': {
        // 新主题，push新帧
        const newIndex = currentStack.length;
        if (newIndex >= MAX_DEPTH) {
          // 超深，移除栈底
          this._db.prepare('DELETE FROM focus_stack WHERE frame_index = 0').run();
          // 重编号
          this._db.prepare(`
            UPDATE focus_stack SET frame_index = frame_index - 1
          `).run();
        }
        this._db.prepare(`
          INSERT INTO focus_stack (frame_index, topics, started_at_tick, last_seen_tick, hit_count)
          VALUES (?, ?, ?, ?, 1)
        `).run(newIndex >= MAX_DEPTH ? MAX_DEPTH - 1 : newIndex,
          JSON.stringify(topics), tickNumber, tickNumber);
        break;
      }
      case 'returned': {
        // 回到旧主题，pop到对应帧
        for (let i = currentStack.length - 1; i >= 0; i--) {
          const frame = currentStack[i];
          const frameTopics = JSON.parse(frame.topics || '[]');
          const hasOverlap = topics.some(t => frameTopics.includes(t));
          if (hasOverlap) {
            // 删除更高帧
            this._db.prepare('DELETE FROM focus_stack WHERE frame_index > ?').run(frame.frame_index);
            // 更新命中
            this._db.prepare(`
              UPDATE focus_stack SET last_seen_tick = ?, hit_count = hit_count + 1
              WHERE id = ?
            `).run(tickNumber, frame.id);
            break;
          }
        }
        break;
      }
      case 'cleared': {
        // 栈顶失活，pop
        const topFrame = currentStack[currentStack.length - 1];
        if (topFrame) {
          this._db.prepare('DELETE FROM focus_stack WHERE id = ?').run(topFrame.id);
        }
        break;
      }
    }

    return this.getFocusStack();
  }

  /**
   * 获取焦点栈
   */
  getFocusStack() {
    return this._db.prepare(`
      SELECT * FROM focus_stack ORDER BY frame_index ASC
    `).all().map(f => ({
      ...f,
      topics: JSON.parse(f.topics || '[]'),
      conclusions: JSON.parse(f.conclusions || '[]'),
    }));
  }

  // ═══════════════════════════════════════
  // 记忆衰减与整合
  // ═══════════════════════════════════════

  /**
   * 执行一轮衰减（v4.2: 事务保护）
   */
  decay() {
    this._transaction(() => { this._decayInternal(); });
  }

  /**
   * v4.2: 衰减内部实现（供外部事务包装使用）
   */
  _decayInternal() {
    this._db.prepare(`
      UPDATE memories SET
        salience = MAX(?, salience - ? * (CAST(strftime('%s','now') AS REAL) * 1000 - created_at) / 86400000),
        tier = CASE
          WHEN salience >= ? THEN 'hot'
          WHEN salience >= ? THEN 'warm'
          ELSE 'cold'
        END,
        updated_at = strftime('%s','now') * 1000
      WHERE tier != 'skill'
    `).run(
      DECAY_CONFIG.MIN_SALIENCE,
      DECAY_CONFIG.SALIENCE_DECAY_PER_DAY,
      DECAY_CONFIG.HOT_THRESHOLD,
      DECAY_CONFIG.WARM_THRESHOLD
    );

    // 淘汰超限冷记忆
    const count = this._db.prepare('SELECT COUNT(*) as c FROM memories WHERE tier = ?').get('cold').c;
    if (count > DECAY_CONFIG.MAX_MEMORIES * 0.5) {
      this._db.prepare(`
        DELETE FROM memories WHERE tier = 'cold'
        ORDER BY salience ASC, updated_at ASC
        LIMIT ?
      `).run(DECAY_CONFIG.EVICTION_BATCH);

      // 同步FTS5
      this._db.prepare(`
        DELETE FROM memories_fts WHERE rowid NOT IN (SELECT id FROM memories)
      `).run();
    }
  }

  /**
   * 整合记忆（去重/合并/降级）（v4.2: 事务保护）
   */
  consolidate() {
    return this._transaction(() => this._consolidateInternal());
  }

  /**
   * v4.2: 整合内部实现（供外部事务包装使用）
   */
  _consolidateInternal() {
      // 查找可能的重复记忆
      const candidates = this._db.prepare(`
        SELECT m1.id as id1, m2.id as id2,
               m1.content as c1, m2.content as c2,
               m1.salience as s1, m2.salience as s2
        FROM memories m1
        JOIN memories m2 ON m1.id < m2.id AND m1.mem_type = m2.mem_type
        WHERE m1.tier IN ('hot', 'warm') AND m2.tier IN ('hot', 'warm')
        AND abs(m1.created_at - m2.created_at) < 86400000
        LIMIT 50
      `).all();

      // 简单去重：内容相似度（编辑距离近似）
      const toDelete = new Set();
      for (const pair of candidates) {
        if (this._isSimilar(pair.c1, pair.c2)) {
          const deleteId = pair.s1 >= pair.s2 ? pair.id2 : pair.id1;
          toDelete.add(deleteId);
        }
      }

      if (toDelete.size > 0) {
        const ids = [...toDelete];
        const placeholders = ids.map(() => '?').join(',');
        this._db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
        this._db.prepare(`DELETE FROM memories_fts WHERE rowid IN (${placeholders})`).run(...ids);
      }

      return toDelete.size;
  }

  // ═══════════════════════════════════════
  // 统计与诊断
  // ═══════════════════════════════════════

  // ═══════════════════════════════════════
  // v4.0: ANN 索引管理
  // ═══════════════════════════════════════

  /**
   * 从数据库重建 ANN 索引（启动时调用）
   */
  _rebuildAnnIndex() {
    if (!this._annIndex || !this._db) return;
    try {
      const rows = this._db.prepare(`
        SELECT id, embedding FROM memories WHERE embedding IS NOT NULL
      `).all();

      let count = 0;
      for (const row of rows) {
        if (!row.embedding) continue;
        try {
          const vec = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.length / 4
          );
          this._annIndex.insert(`mem_${row.id}`, vec, { dbId: row.id });
          count++;
        } catch { /* 跳过损坏的向量 */ }
      }
      if (count > 0) {
        // 静默重建，不打印日志避免启动时刷屏
      }
    } catch { /* ANN 重建失败不影响主流程 */ }
  }

  /**
   * 向 ANN 索引添加向量
   */
  _addToAnnIndex(memoryId, embedding) {
    if (!this._annIndex || !embedding) return;
    try {
      const vec = embedding instanceof Float32Array
        ? embedding
        : new Float32Array(embedding);
      this._annIndex.insert(`mem_${memoryId}`, vec, { dbId: memoryId });
    } catch { /* 静默失败 */ }
  }

  /**
   * 从 ANN 索引移除向量
   */
  _removeFromAnnIndex(memoryId) {
    if (!this._annIndex) return;
    try {
      this._annIndex.remove(`mem_${memoryId}`);
    } catch { /* 静默失败 */ }
  }

  /**
   * 使分层缓存失效
   */
  invalidateLayeredCache() {
    this._layeredCache = null;
    this._layeredCacheTime = 0;
  }

  getStats() {
    if (!this._db) {
      return { memories: [], skills: [], traces: { total: 0, success_count: 0 }, focusStackSize: 0 };
    }

    const memStats = this._db.prepare(`
      SELECT tier, COUNT(*) as count, AVG(salience) as avg_salience
      FROM memories GROUP BY tier
    `).all();

    const skillStats = this._db.prepare(`
      SELECT audit_status, COUNT(*) as count FROM skills GROUP BY audit_status
    `).all();

    const traceStats = this._db.prepare(`
      SELECT COUNT(*) as total, SUM(success) as success_count
      FROM execution_traces
    `).get();

    return {
      memories: memStats,
      skills: skillStats,
      traces: traceStats,
      focusStackSize: this._db.prepare('SELECT COUNT(*) as c FROM focus_stack').get().c,
    };
  }

  // ═══════════════════════════════════════
  // 内部辅助
  // ═══════════════════════════════════════

  _findDuplicate(content) {
    const keywords = this._extractKeywords(content, 3);
    if (keywords.length === 0) return null;

    for (const kw of keywords) {
      try {
        const row = this._db.prepare(`
          SELECT m.id, m.salience FROM memories_fts f
          JOIN memories m ON m.id = f.rowid
          WHERE memories_fts MATCH ?
          LIMIT 1
        `).get(kw);
        if (row) return row;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  _updateSalience(id, newSalience) {
    const tier = this._computeTier(newSalience, 0);
    this._db.prepare(`
      UPDATE memories SET salience = ?, tier = ?, updated_at = strftime('%s','now') * 1000
      WHERE id = ?
    `).run(newSalience, tier, id);
    return id;
  }

  _recordHit(id) {
    this._db.prepare(`
      UPDATE memories SET hit_count = hit_count + 1,
        last_hit_at = strftime('%s','now') * 1000
      WHERE id = ?
    `).run(id);
  }

  _computeTier(salience, ageDays) {
    const effectiveSalience = salience - ageDays * DECAY_CONFIG.SALIENCE_DECAY_PER_DAY;
    if (effectiveSalience >= DECAY_CONFIG.HOT_THRESHOLD) return MEMORY_TIER.HOT;
    if (effectiveSalience >= DECAY_CONFIG.WARM_THRESHOLD) return MEMORY_TIER.WARM;
    return MEMORY_TIER.COLD;
  }

  _applyDecay(salience, createdAt) {
    const ageDays = (Date.now() - createdAt) / 86400000;
    return Math.max(DECAY_CONFIG.MIN_SALIENCE,
      salience - ageDays * DECAY_CONFIG.SALIENCE_DECAY_PER_DAY);
  }

  // ═══════════════════════════════════════
  // v3.0: 分层记忆数据导出（供MemoryNetworkGraph使用）
  // ═══════════════════════════════════════

  /**
   * 获取按层级组织的记忆数据
   * 供MemoryNetworkGraph.buildFromMemory()使用
   * @param {number} maxPerLayer - 每层最多返回条数
   * @returns {Object} { layers: { hot, warm, cold, exec, skill } }
   */
  getLayeredMemoryData(maxPerLayer = 50) {
    // v4.0: 5-second TTL cache to reduce repeated SQL queries in high-frequency TICKs
    const now = Date.now();
    if (this._layeredCache && (now - this._layeredCacheTime) < this._layeredCacheTTL) {
      return this._layeredCache;
    }

    const layers = { hot: [], warm: [], cold: [], exec: [], skill: [] };

    if (!this._db) return { layers };

    // 热记忆：salience >= 5, 最近7天
    const hotMemories = this._db.prepare(`
      SELECT id, content, summary, tier, salience, mem_type, tags, source, created_at
      FROM memories WHERE tier = 'hot' AND salience >= ?
      ORDER BY salience DESC LIMIT ?
    `).all(DECAY_CONFIG.HOT_THRESHOLD, maxPerLayer);
    layers.hot = hotMemories.map(m => this._normalizeMemoryRow(m));

    // 温记忆：salience >= 3, 最近30天
    const warmMemories = this._db.prepare(`
      SELECT id, content, summary, tier, salience, mem_type, tags, source, created_at
      FROM memories WHERE tier = 'warm' AND salience >= ?
      ORDER BY salience DESC LIMIT ?
    `).all(DECAY_CONFIG.WARM_THRESHOLD, maxPerLayer);
    layers.warm = warmMemories.map(m => this._normalizeMemoryRow(m));

    // 冷记忆：salience < 3 或 超30天
    const coldMemories = this._db.prepare(`
      SELECT id, content, summary, tier, salience, mem_type, tags, source, created_at
      FROM memories WHERE tier = 'cold'
      ORDER BY salience DESC LIMIT ?
    `).all(maxPerLayer);
    layers.cold = coldMemories.map(m => this._normalizeMemoryRow(m));

    // 执行记忆：最近执行轨迹
    const execTraces = this._db.prepare(`
      SELECT id, task_id, step_index, action, params, result, success, duration_ms, created_at
      FROM execution_traces ORDER BY created_at DESC LIMIT ?
    `).all(maxPerLayer);
    layers.exec = execTraces.map(t => ({
      id: `exec_${t.id}`,
      title: t.action,
      content: t.result ? String(t.result).substring(0, 200) : '',
      salience: t.success ? 3.5 : 2.0,
      timestamp: t.created_at,
      type: 'exec',
      entities: [],
    }));

    // 技能记忆：已批准的技能
    const skills = this._db.prepare(`
      SELECT id, name, description, content, category, use_count, last_used_at
      FROM skills WHERE audit_status = 'approved'
      ORDER BY use_count DESC LIMIT ?
    `).all(maxPerLayer);
    layers.skill = skills.map(s => ({
      id: `skill_${s.id}`,
      title: s.name,
      content: s.description || s.content?.substring(0, 200),
      salience: Math.min(5, 3 + s.use_count * 0.5),
      timestamp: s.last_used_at || Date.now(),
      type: 'skill',
      entities: [s.category],
    }));

    const result = { layers, timestamp: now };

    // v4.0: Cache the result with TTL
    this._layeredCache = result;
    this._layeredCacheTime = now;

    return result;
  }

  // v4.0: Invalidate layered cache (call on insert/update/delete/decay/consolidate)
  invalidateLayeredCache() {
    this._layeredCache = null;
    this._layeredCacheTime = 0;
  }

  _normalizeMemoryRow(m) {
    return {
      id: `mem_${m.id}`,
      title: m.summary || m.content?.substring(0, 60) || '',
      content: m.content || '',
      salience: m.salience,
      timestamp: m.created_at,
      type: m.mem_type,
      tier: m.tier,
      tags: m.tags ? JSON.parse(m.tags) : [],
      entities: [],
    };
  }

  /**
   * v4.3: 简单字符串哈希（用于搜索缓存键）
   * @param {string} str
   * @returns {string} 哈希值（hex）
   */
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32bit integer
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * 中文n-gram关键词提取（继承自白龙马 keywords.js）
   * 改进：短n-gram不被长n-gram覆盖，保留所有有意义的gram
   */
  _extractKeywords(text, maxKeywords = 8) {
    if (!text || typeof text !== 'string') return [];

    // 停用词
    const STOP_WORDS = new Set([
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
      '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没',
      '看', '好', '自己', '这', '他', '她', '它', '吗', '那', '什么', '怎么',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
      'and', 'but', 'or', 'not', 'no', 'if', 'then', 'else', 'when',
      'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it',
      'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
      'his', 'its', 'our', 'their', 'what', 'which', 'who', 'whom',
    ]);

    const keywords = [];

    // 中文：2-4 gram（从长到短，但保留所有）
    const cjkChars = text.replace(/[^\u4e00-\u9fff]/g, '');
    const gramSet = new Set();
    for (let n = 4; n >= 2; n--) {
      for (let i = 0; i <= cjkChars.length - n; i++) {
        const gram = cjkChars.substring(i, i + n);
        if (!STOP_WORDS.has(gram) && gram.length >= 2) {
          gramSet.add(gram);
        }
      }
    }

    // 过滤：如果短gram被长gram包含且长gram更具体，仍保留短gram（用于FTS5搜索）
    // 但优先排序：先长gram后短gram
    const cjkKeywords = [...gramSet];
    cjkKeywords.sort((a, b) => b.length - a.length);
    keywords.push(...cjkKeywords);

    // 英文：按空格分词，过滤短词
    const engWords = text.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()));
    keywords.push(...engWords.map(w => w.toLowerCase()));

    // 去重 + 截断
    return [...new Set(keywords)].slice(0, maxKeywords);
  }

  /**
   * 简单文本相似度（Jaccard）
   */
  _isSimilar(a, b) {
    const setA = new Set(this._extractKeywords(a, 10));
    const setB = new Set(this._extractKeywords(b, 10));
    if (setA.size === 0 || setB.size === 0) return false;
    let intersection = 0;
    for (const x of setA) { if (setB.has(x)) intersection++; }
    const union = setA.size + setB.size - intersection;
    return intersection / union > 0.6;
  }

  /**
   * 异步回填embedding
   */
  async _backfillEmbedding(memId, content) {
    if (!this._computeEmbedding) return;

    // 缓存检查
    const cacheKey = content.substring(0, 200);
    if (this._embeddingCache.has(cacheKey)) {
      const emb = this._embeddingCache.get(cacheKey);
      this._saveEmbedding(memId, emb);
      return;
    }

    try {
      const emb = await this._computeEmbedding(content);
      if (!emb) return;

      // LRU缓存
      if (this._embeddingCache.size >= this._embeddingCacheMaxSize) {
        const firstKey = this._embeddingCache.keys().next().value;
        this._embeddingCache.delete(firstKey);
      }
      this._embeddingCache.set(cacheKey, emb);

      this._saveEmbedding(memId, emb);
    } catch (e) {
      // embedding失败不影响主流程
    }
  }

  _saveEmbedding(memId, emb) {
    const buf = Buffer.from(new Float32Array(emb).buffer);
    this._db.prepare(`
      UPDATE memories SET embedding = ? WHERE id = ?
    `).run(buf, memId);

    // v4.0: 同步更新 ANN 索引
    this._addToAnnIndex(memId, emb);
  }

  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

// ── 导出 ──
module.exports = {
  MemoryEngine,
  MEMORY_TIER,
  DECAY_CONFIG,
};
