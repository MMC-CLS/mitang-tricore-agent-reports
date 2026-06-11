/**
 * 蜜糖 TriCore Agent - 子智能体记忆绑定器 (SubAgentMemoryBinder)
 *
 * 核心职责：
 *   1. 技能固化 - 将安装的技能深度绑定到子智能体记忆系统
 *   2. 独立记忆空间 - 每个子智能体拥有独立的 SQLite 记忆数据库
 *   3. 记忆持久化 - 技能相关的记忆不会因系统重启而丢失
 *   4. 记忆检索 - 基于技能的上下文记忆召回
 *   5. 技能执行记忆 - 记录技能使用轨迹，持续优化
 *   6. 记忆迁移 - 子智能体销毁时保留关键技能记忆
 *
 * 记忆层级 (继承 MemoryEngine 的五层体系)：
 *   L0: 热记忆 (Hot)     - 当前技能上下文，每轮注入
 *   L1: 温记忆 (Warm)    - 近期技能使用经验
 *   L2: 冷记忆 (Cold)    - 历史技能使用记录
 *   L3: 执行记忆 (Exec)  - 技能执行轨迹
 *   L4: 技能记忆 (Skill) - 固化技能本体 (SKILL.md标准)
 *
 * 每个子智能体的记忆数据库位置：
 *   data/subagents/{agentId}/memory/memory.db
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');

// ── 常量 ──

const MEMORY_BIND_STATUS = Object.freeze({
  UNBOUND: 'unbound',
  BINDING: 'binding',
  BOUND: 'bound',
  FAILED: 'failed',
});

const MEMORY_DECAY_CONFIG = Object.freeze({
  SALIENCE_DECAY_PER_DAY: 0.1,
  MIN_SALIENCE: 1.0,
  HOT_THRESHOLD: 5.0,
  WARM_THRESHOLD: 3.0,
  MAX_MEMORIES: 10000,
  EVICTION_BATCH: 100,
  CONSOLIDATION_INTERVAL: 30 * 60 * 1000,
});

const SKILL_MEMORY_TIER = Object.freeze({
  CORE: 'core',       // 核心技能记忆，永不衰减
  FREQUENT: 'frequent', // 频繁使用的技能
  RARE: 'rare',       // 偶尔使用的技能
  ARCHIVED: 'archived', // 已归档
});

// ── 记忆绑定器类 ──

class SubAgentMemoryBinder extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data', 'subagents');
    this._parentMemoryEngine = options.parentMemoryEngine || null; // 母体 MemoryEngine

    // 子智能体独立记忆数据库映射
    this._agentDBs = new Map();       // agentId → Database
    this._agentBindings = new Map();  // agentId → bindingStatus

    // 技能记忆索引（快速查找）
    this._skillMemoryIndex = new Map(); // agentId → Map(skillName → memoryIds[])

    // 记忆整合定时器
    this._consolidationTimers = new Map(); // agentId → timer

    // 确保数据目录
    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir, { recursive: true });
    }
  }

  // ═══════════════════════════════════════
  // 初始化与生命周期
  // ═══════════════════════════════════════

  /**
   * 为子智能体初始化独立记忆空间
   * @param {string} agentId
   * @param {object} options - { agentName?, agentType? }
   */
  initAgentMemory(agentId, options = {}) {
    if (this._agentDBs.has(agentId)) {
      return { success: true, message: '记忆空间已存在' };
    }

    this._agentBindings.set(agentId, MEMORY_BIND_STATUS.BINDING);

    try {
      const agentMemoryDir = path.join(this._dataDir, agentId, 'memory');
      if (!fs.existsSync(agentMemoryDir)) {
        fs.mkdirSync(agentMemoryDir, { recursive: true });
      }

      const dbPath = path.join(agentMemoryDir, 'memory.db');
      const db = new Database(dbPath);

      // 优化设置
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('cache_size = -8000'); // 8MB 缓存

      // 创建表结构
      this._createAgentMemoryTables(db);

      // 注册自定义函数
      this._registerAgentFunctions(db);

      // 写入初始化元记忆
      this._writeMetaMemory(db, {
        agentId,
        agentName: options.agentName || '未知',
        agentType: options.agentType || 'assistant',
        createdAt: Date.now(),
        version: '1.0.0',
      });

      this._agentDBs.set(agentId, db);
      this._skillMemoryIndex.set(agentId, new Map());
      this._agentBindings.set(agentId, MEMORY_BIND_STATUS.BOUND);

      // 启动定期记忆整合
      this._startConsolidation(agentId);

      this._logger.info(`[MemoryBinder] 子智能体 "${options.agentName || agentId}" 独立记忆空间已初始化`);
      this.emit('memory_initialized', { agentId });

      return { success: true, dbPath, agentId };

    } catch (error) {
      this._agentBindings.set(agentId, MEMORY_BIND_STATUS.FAILED);
      this._logger.error(`[MemoryBinder] 初始化记忆空间失败 (${agentId}): ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 关闭子智能体记忆空间
   */
  closeAgentMemory(agentId) {
    // 停止整合定时器
    const timer = this._consolidationTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this._consolidationTimers.delete(agentId);
    }

    // 关闭数据库
    const db = this._agentDBs.get(agentId);
    if (db) {
      try {
        db.close();
      } catch {}
      this._agentDBs.delete(agentId);
    }

    this._skillMemoryIndex.delete(agentId);
    this._agentBindings.delete(agentId);

    this._logger.info(`[MemoryBinder] 子智能体 ${agentId} 记忆空间已关闭`);
  }

  // ═══════════════════════════════════════
  // 技能固化 - 核心功能
  // ═══════════════════════════════════════

  /**
   * 固化技能到子智能体记忆
   * 将技能深度绑定到子智能体的记忆系统中，确保持久化
   *
   * @param {string} agentId - 子智能体ID
   * @param {object} skill - 技能对象（来自 SkillInstaller）
   * @param {object} options - { tier?, force? }
   */
  bindSkill(agentId, skill, options = {}) {
    const db = this._agentDBs.get(agentId);
    if (!db) {
      return { success: false, error: '子智能体记忆空间未初始化' };
    }

    const tier = options.tier || SKILL_MEMORY_TIER.CORE;
    const skillName = skill.name || skill.displayName || 'unknown';

    try {
      const txn = db.transaction(() => {
        // 1. 写入技能记忆表（L4 - 技能记忆层）
        const skillId = skill.id || `sk_${Date.now().toString(36)}`;
        const triggerKeywords = skill.triggerKeywords
          ? JSON.stringify(skill.triggerKeywords)
          : null;
        const toolsRequired = skill.toolsRequired
          ? JSON.stringify(skill.toolsRequired)
          : null;
        const dependencies = skill.dependencies
          ? JSON.stringify(skill.dependencies)
          : null;
        const metadata = skill.metadata
          ? JSON.stringify(skill.metadata)
          : null;

        db.prepare(`
          INSERT OR REPLACE INTO agent_skills
            (skill_id, name, display_name, description, category,
             instructions, system_prompt, trigger_keywords, tools_required,
             dependencies, version, author, source, tier, metadata,
             installed_at, updated_at, use_count, enabled)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          skillId, skillName, skill.displayName || skillName,
          skill.description || '', skill.category || 'custom',
          skill.instructions || '', skill.systemPrompt || '',
          triggerKeywords, toolsRequired, dependencies,
          skill.version || '1.0.0', skill.author || 'unknown',
          skill.source || 'installed', tier, metadata,
          skill.installedAt || Date.now(), Date.now(),
          0, 1
        );

        // 2. 写入核心记忆表（L0-L2 - 通用记忆层）
        // 技能描述作为高salience记忆
        const memoryContent = `[技能] ${skillName}: ${skill.description || ''}`;
        const memoryResult = db.prepare(`
          INSERT INTO agent_memories
            (content, summary, tier, salience, mem_type, tags, source, source_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          memoryContent,
          `技能 ${skillName} v${skill.version || '1.0.0'}`,
          'skill',
          10.0, // 技能记忆初始高salience
          'skill',
          JSON.stringify([skill.category, skillName, ...(skill.triggerKeywords || [])]),
          'skill_install',
          skillId
        );

        // 3. 写入技能指令作为过程记忆
        if (skill.instructions && skill.instructions.length > 0) {
          const truncatedInstructions = skill.instructions.length > 2000
            ? skill.instructions.substring(0, 2000) + '...'
            : skill.instructions;

          db.prepare(`
            INSERT INTO agent_memories
              (content, summary, tier, salience, mem_type, tags, source, source_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            truncatedInstructions,
            `技能指令: ${skillName}`,
            'skill',
            8.0,
            'procedure',
            JSON.stringify(['instruction', skillName]),
            'skill_install',
            skillId
          );
        }

        // 4. 更新索引
        const skillIndex = this._skillMemoryIndex.get(agentId);
        if (skillIndex) {
          if (!skillIndex.has(skillName)) {
            skillIndex.set(skillName, []);
          }
          skillIndex.get(skillName).push(memoryResult.lastInsertRowid);
        }

        // 5. 记录安装事件
        db.prepare(`
          INSERT INTO agent_memory_events
            (event_type, skill_id, skill_name, details, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          'skill_bound',
          skillId,
          skillName,
          JSON.stringify({
            version: skill.version || '1.0.0',
            tier,
            category: skill.category,
          }),
          Date.now()
        );

        return skillId;
      });

      const boundSkillId = txn();

      this._logger.info(`[MemoryBinder] 技能已固化: "${skillName}" → 子智能体 ${agentId} (层级: ${tier})`);
      this.emit('skill_bound', { agentId, skillId: boundSkillId, name: skillName, tier });

      return { success: true, skillId: boundSkillId, name: skillName, tier };

    } catch (error) {
      this._logger.error(`[MemoryBinder] 技能固化失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 解除技能绑定（从记忆系统中移除）
   */
  unbindSkill(agentId, skillIdOrName) {
    const db = this._agentDBs.get(agentId);
    if (!db) {
      return { success: false, error: '子智能体记忆空间未初始化' };
    }

    try {
      const txn = db.transaction(() => {
        // 查找技能
        let skill;
        const byId = db.prepare('SELECT * FROM agent_skills WHERE skill_id = ?').get(skillIdOrName);
        if (byId) {
          skill = byId;
        } else {
          const byName = db.prepare('SELECT * FROM agent_skills WHERE name = ?').get(skillIdOrName);
          skill = byName;
        }

        if (!skill) {
          throw new Error(`技能不存在: ${skillIdOrName}`);
        }

        // 1. 禁用技能（保留数据）
        db.prepare(`
          UPDATE agent_skills SET enabled = 0, updated_at = ?
          WHERE skill_id = ?
        `).run(Date.now(), skill.skill_id);

        // 2. 降低关联记忆的salience（不直接删除）
        db.prepare(`
          UPDATE agent_memories SET salience = 1.0, tier = 'cold', updated_at = ?
          WHERE source = 'skill_install' AND source_id = ?
        `).run(Date.now(), skill.skill_id);

        // 3. 记录解绑事件
        db.prepare(`
          INSERT INTO agent_memory_events
            (event_type, skill_id, skill_name, details, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          'skill_unbound',
          skill.skill_id,
          skill.name,
          JSON.stringify({ reason: 'user_request' }),
          Date.now()
        );

        return skill;
      });

      const removedSkill = txn();

      // 清理索引
      const skillIndex = this._skillMemoryIndex.get(agentId);
      if (skillIndex) {
        skillIndex.delete(removedSkill.name);
      }

      this._logger.info(`[MemoryBinder] 技能已解绑: "${removedSkill.name}" (${removedSkill.skill_id})`);
      this.emit('skill_unbound', { agentId, skillId: removedSkill.skill_id, name: removedSkill.name });

      return { success: true, skillId: removedSkill.skill_id, name: removedSkill.name };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 将已安装技能升级为核心记忆（永不衰减）
   */
  lockSkillAsCore(agentId, skillIdOrName) {
    const db = this._agentDBs.get(agentId);
    if (!db) {
      return { success: false, error: '子智能体记忆空间未初始化' };
    }

    try {
      const skill = db.prepare('SELECT * FROM agent_skills WHERE skill_id = ? OR name = ?')
        .get(skillIdOrName, skillIdOrName);

      if (!skill) {
        return { success: false, error: `技能不存在: ${skillIdOrName}` };
      }

      db.prepare(`
        UPDATE agent_skills SET tier = ?, updated_at = ? WHERE skill_id = ?
      `).run(SKILL_MEMORY_TIER.CORE, Date.now(), skill.skill_id);

      // 提升关联记忆的salience到永不衰减水平
      db.prepare(`
        UPDATE agent_memories SET salience = 20.0, tier = 'skill'
        WHERE source = 'skill_install' AND source_id = ?
      `).run(skill.skill_id);

      this._logger.info(`[MemoryBinder] 技能已锁定为核心: "${skill.name}"`);
      return { success: true, skillId: skill.skill_id, name: skill.name, tier: SKILL_MEMORY_TIER.CORE };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════
  // 记忆写入
  // ═══════════════════════════════════════

  /**
   * 写入子智能体记忆
   */
  writeMemory(agentId, entry) {
    const db = this._agentDBs.get(agentId);
    if (!db) return null;

    const {
      content, summary = null,
      salience = 3.0, mem_type = 'fact',
      tags = null, source = 'conversation', source_id = null,
    } = entry;

    // 查重
    const existing = this._findDuplicateMemory(db, content);
    if (existing) {
      const newSalience = Math.max(existing.salience, salience) + 0.5;
      db.prepare(`
        UPDATE agent_memories SET salience = ?, updated_at = ? WHERE id = ?
      `).run(newSalience, Date.now(), existing.id);
      return existing.id;
    }

    const tier = this._computeMemoryTier(salience, 0);
    const tagsJson = tags ? JSON.stringify(tags) : null;

    const result = db.prepare(`
      INSERT INTO agent_memories (content, summary, tier, salience, mem_type, tags, source, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(content, summary, tier, salience, mem_type, tagsJson, source, source_id);

    return result.lastInsertRowid;
  }

  /**
   * 记录技能使用记忆
   */
  recordSkillUseMemory(agentId, skillName, context = {}) {
    const db = this._agentDBs.get(agentId);
    if (!db) return;

    try {
      // 更新技能使用计数
      db.prepare(`
        UPDATE agent_skills SET
          use_count = use_count + 1,
          last_used_at = ?,
          updated_at = ?
        WHERE name = ? AND enabled = 1
      `).run(Date.now(), Date.now(), skillName);

      // 写入执行轨迹
      db.prepare(`
        INSERT INTO agent_execution_traces
          (skill_name, action, params, result, success, duration_ms, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        skillName,
        context.action || 'invoke',
        context.params ? JSON.stringify(context.params) : null,
        context.result ? JSON.stringify(context.result).substring(0, 500) : null,
        context.success !== false ? 1 : 0,
        context.durationMs || null,
        Date.now()
      );

      // 写入高salience使用记忆
      this.writeMemory(agentId, {
        content: `[技能使用] 使用技能 "${skillName}" - ${context.action || 'invoke'} - ${context.success !== false ? '成功' : '失败'}`,
        summary: `技能 ${skillName} 使用记录`,
        salience: 6.0,
        mem_type: 'event',
        tags: ['skill_use', skillName],
        source: 'skill_execution',
        source_id: skillName,
      });

    } catch (e) {
      this._logger.warn(`[MemoryBinder] 记录技能使用失败: ${e.message}`);
    }
  }

  /**
   * 写入对话记忆
   */
  writeConversationMemory(agentId, content, salience = 4.0) {
    return this.writeMemory(agentId, {
      content,
      summary: content.substring(0, 200),
      salience,
      mem_type: 'fact',
      tags: ['conversation'],
      source: 'conversation',
    });
  }

  // ═══════════════════════════════════════
  // 记忆检索
  // ═══════════════════════════════════════

  /**
   * 搜索子智能体记忆
   */
  searchMemory(agentId, query) {
    const db = this._agentDBs.get(agentId);
    if (!db) return [];

    const { text, limit = 10, tierFilter = null, memType = null } = query;

    try {
      let sql = 'SELECT * FROM agent_memories WHERE 1=1';
      const params = [];

      if (tierFilter) {
        sql += ' AND tier = ?';
        params.push(tierFilter);
      }

      if (memType) {
        sql += ' AND mem_type = ?';
        params.push(memType);
      }

      if (text) {
        sql += ' AND (content LIKE ? OR summary LIKE ?)';
        params.push(`%${text}%`, `%${text}%`);
      }

      sql += ' ORDER BY salience DESC, updated_at DESC LIMIT ?';
      params.push(limit);

      return db.prepare(sql).all(...params).map(m => ({
        ...m,
        tags: JSON.parse(m.tags || '[]'),
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * 获取技能相关记忆
   */
  getSkillMemories(agentId, skillName, limit = 10) {
    const db = this._agentDBs.get(agentId);
    if (!db) return [];

    try {
      return db.prepare(`
        SELECT * FROM agent_memories
        WHERE source = 'skill_install' AND source_id IN (
          SELECT skill_id FROM agent_skills WHERE name = ? AND enabled = 1
        )
        ORDER BY salience DESC
        LIMIT ?
      `).all(skillName, limit).map(m => ({
        ...m,
        tags: JSON.parse(m.tags || '[]'),
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * 获取子智能体所有固化技能
   */
  getBoundSkills(agentId) {
    const db = this._agentDBs.get(agentId);
    if (!db) return [];

    try {
      const skills = db.prepare(`
        SELECT * FROM agent_skills WHERE enabled = 1
        ORDER BY tier = 'core' DESC, use_count DESC, installed_at DESC
      `).all();

      return skills.map(s => ({
        ...s,
        trigger_keywords: JSON.parse(s.trigger_keywords || '[]'),
        tools_required: JSON.parse(s.tools_required || '[]'),
        dependencies: JSON.parse(s.dependencies || '[]'),
        metadata: JSON.parse(s.metadata || '{}'),
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * 获取固化技能详情
   */
  getBoundSkillDetail(agentId, skillIdOrName) {
    const db = this._agentDBs.get(agentId);
    if (!db) return null;

    try {
      const skill = db.prepare(`
        SELECT * FROM agent_skills WHERE skill_id = ? OR name = ?
      `).get(skillIdOrName, skillIdOrName);

      if (!skill) return null;

      return {
        ...skill,
        trigger_keywords: JSON.parse(skill.trigger_keywords || '[]'),
        tools_required: JSON.parse(skill.tools_required || '[]'),
        dependencies: JSON.parse(skill.dependencies || '[]'),
        metadata: JSON.parse(skill.metadata || '{}'),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 获取子智能体记忆统计
   */
  getMemoryStats(agentId) {
    const db = this._agentDBs.get(agentId);
    if (!db) return { total: 0, byTier: {}, skillCount: 0, totalSkillUses: 0 };

    try {
      const memStats = db.prepare(`
        SELECT tier, COUNT(*) as count, AVG(salience) as avg_salience
        FROM agent_memories GROUP BY tier
      `).all();

      const skillCount = db.prepare(
        'SELECT COUNT(*) as c FROM agent_skills WHERE enabled = 1'
      ).get().c;

      const totalSkillUses = db.prepare(
        'SELECT SUM(use_count) as c FROM agent_skills'
      ).get().c || 0;

      const traceCount = db.prepare(
        'SELECT COUNT(*) as c FROM agent_execution_traces'
      ).get().c;

      const byTier = {};
      for (const s of memStats) {
        byTier[s.tier] = { count: s.count, avgSalience: Math.round(s.avg_salience * 100) / 100 };
      }

      return {
        total: memStats.reduce((s, m) => s + m.count, 0),
        byTier,
        skillCount,
        totalSkillUses,
        executionTraces: traceCount,
      };
    } catch (e) {
      return { total: 0, byTier: {}, skillCount: 0, totalSkillUses: 0, error: e.message };
    }
  }

  // ═══════════════════════════════════════
  // 记忆维护
  // ═══════════════════════════════════════

  /**
   * 执行记忆衰减
   */
  decayMemory(agentId) {
    const db = this._agentDBs.get(agentId);
    if (!db) return;

    try {
      db.prepare(`
        UPDATE agent_memories SET
          salience = MAX(?, salience - ? * (CAST(strftime('%s','now') AS REAL) * 1000 - created_at) / 86400000),
          tier = CASE
            WHEN salience >= ? THEN 'hot'
            WHEN salience >= ? THEN 'warm'
            ELSE 'cold'
          END,
          updated_at = ?
        WHERE tier != 'skill' AND mem_type != 'skill'
      `).run(
        MEMORY_DECAY_CONFIG.MIN_SALIENCE,
        MEMORY_DECAY_CONFIG.SALIENCE_DECAY_PER_DAY,
        MEMORY_DECAY_CONFIG.HOT_THRESHOLD,
        MEMORY_DECAY_CONFIG.WARM_THRESHOLD,
        Date.now()
      );
    } catch (e) {
      this._logger.warn(`[MemoryBinder] 记忆衰减失败 (${agentId}): ${e.message}`);
    }
  }

  /**
   * 整合记忆（去重合并）
   */
  consolidateMemory(agentId) {
    const db = this._agentDBs.get(agentId);
    if (!db) return 0;

    try {
      // 查找相似记忆
      const candidates = db.prepare(`
        SELECT m1.id as id1, m2.id as id2,
               m1.salience as s1, m2.salience as s2
        FROM agent_memories m1
        JOIN agent_memories m2 ON m1.id < m2.id
        WHERE m1.mem_type = m2.mem_type
        AND m1.tier IN ('hot', 'warm') AND m2.tier IN ('hot', 'warm')
        AND abs(m1.created_at - m2.created_at) < 86400000
        LIMIT 30
      `).all();

      // 简单相似度去重
      let removed = 0;
      for (const pair of candidates) {
        const idToRemove = pair.s1 >= pair.s2 ? pair.id2 : pair.id1;
        db.prepare('DELETE FROM agent_memories WHERE id = ?').run(idToRemove);
        removed++;
      }

      return removed;
    } catch (e) {
      return 0;
    }
  }

  // ═══════════════════════════════════════
  // 迁移与备份
  // ═══════════════════════════════════════

  /**
   * 导出子智能体技能记忆（用于迁移或备份）
   */
  exportSkillMemories(agentId) {
    const db = this._agentDBs.get(agentId);
    if (!db) return null;

    try {
      const skills = this.getBoundSkills(agentId);
      const traces = db.prepare(`
        SELECT * FROM agent_execution_traces
        ORDER BY timestamp DESC LIMIT 500
      `).all();

      return {
        agentId,
        exportedAt: Date.now(),
        skills,
        executionTraces: traces,
        stats: this.getMemoryStats(agentId),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 导入技能记忆（从备份恢复）
   */
  importSkillMemories(agentId, data) {
    if (!data || !data.skills) {
      return { success: false, error: '无效的导入数据' };
    }

    let count = 0;
    for (const skill of data.skills) {
      const result = this.bindSkill(agentId, {
        id: skill.skill_id,
        name: skill.name,
        displayName: skill.display_name,
        description: skill.description,
        category: skill.category,
        instructions: skill.instructions,
        systemPrompt: skill.system_prompt,
        triggerKeywords: skill.trigger_keywords,
        toolsRequired: skill.tools_required,
        version: skill.version,
        author: skill.author,
        source: 'imported',
        installedAt: skill.installed_at,
      }, { tier: skill.tier || SKILL_MEMORY_TIER.CORE });

      if (result.success) count++;
    }

    return { success: true, imported: count, total: data.skills.length };
  }

  // ═══════════════════════════════════════
  // 数据库表结构
  // ═══════════════════════════════════════

  _createAgentMemoryTables(db) {
    db.exec(`
      -- 核心记忆表（对应 MemoryEngine 的 memories 表）
      CREATE TABLE IF NOT EXISTS agent_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        summary TEXT,
        tier TEXT NOT NULL DEFAULT 'warm',
        salience REAL NOT NULL DEFAULT 3.0,
        mem_type TEXT NOT NULL DEFAULT 'fact',
        tags TEXT,
        source TEXT,
        source_id TEXT,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        expires_at INTEGER
      );

      -- 技能固化表（L4 技能记忆层）
      CREATE TABLE IF NOT EXISTS agent_skills (
        skill_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        description TEXT,
        category TEXT NOT NULL DEFAULT 'custom',
        instructions TEXT,
        system_prompt TEXT,
        trigger_keywords TEXT,
        tools_required TEXT,
        dependencies TEXT,
        version TEXT DEFAULT '1.0.0',
        author TEXT DEFAULT 'unknown',
        source TEXT DEFAULT 'installed',
        tier TEXT DEFAULT 'core',
        metadata TEXT,
        installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        use_count INTEGER DEFAULT 0,
        last_used_at INTEGER,
        enabled INTEGER DEFAULT 1
      );

      -- 执行轨迹表
      CREATE TABLE IF NOT EXISTS agent_execution_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        action TEXT NOT NULL,
        params TEXT,
        result TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER,
        timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      -- 记忆事件日志
      CREATE TABLE IF NOT EXISTS agent_memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        skill_id TEXT,
        skill_name TEXT,
        details TEXT,
        timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      -- 元信息表
      CREATE TABLE IF NOT EXISTS agent_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_am_tier ON agent_memories(tier);
      CREATE INDEX IF NOT EXISTS idx_am_salience ON agent_memories(salience DESC);
      CREATE INDEX IF NOT EXISTS idx_am_type ON agent_memories(mem_type);
      CREATE INDEX IF NOT EXISTS idx_am_source ON agent_memories(source);
      CREATE INDEX IF NOT EXISTS idx_ask_name ON agent_skills(name);
      CREATE INDEX IF NOT EXISTS idx_ask_category ON agent_skills(category);
      CREATE INDEX IF NOT EXISTS idx_ask_tier ON agent_skills(tier);
      CREATE INDEX IF NOT EXISTS idx_aet_skill ON agent_execution_traces(skill_name);
      CREATE INDEX IF NOT EXISTS idx_aet_time ON agent_execution_traces(timestamp DESC);
    `);
  }

  _registerAgentFunctions(db) {
    // 简单的文本相似度函数（用于记忆匹配）
    db.function('text_similarity', (a, b) => {
      if (!a || !b) return 0;
      const setA = new Set(a.toLowerCase().split(/\s+/));
      const setB = new Set(b.toLowerCase().split(/\s+/));
      let intersection = 0;
      for (const x of setA) { if (setB.has(x)) intersection++; }
      const union = setA.size + setB.size - intersection;
      return union === 0 ? 0 : intersection / union;
    });
  }

  _writeMetaMemory(db, meta) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO agent_meta (key, value, updated_at) VALUES (?, ?, ?)
    `);

    for (const [key, value] of Object.entries(meta)) {
      stmt.run(key, String(value), Date.now());
    }
  }

  // ═══════════════════════════════════════
  // 内部辅助
  // ═══════════════════════════════════════

  _findDuplicateMemory(db, content) {
    try {
      return db.prepare(`
        SELECT id, salience FROM agent_memories
        WHERE content LIKE ? LIMIT 1
      `).get(content.substring(0, 100) + '%');
    } catch {
      return null;
    }
  }

  _computeMemoryTier(salience, ageDays) {
    const effective = salience - ageDays * MEMORY_DECAY_CONFIG.SALIENCE_DECAY_PER_DAY;
    if (effective >= MEMORY_DECAY_CONFIG.HOT_THRESHOLD) return 'hot';
    if (effective >= MEMORY_DECAY_CONFIG.WARM_THRESHOLD) return 'warm';
    return 'cold';
  }

  _startConsolidation(agentId) {
    const timer = setInterval(() => {
      this.decayMemory(agentId);
      this.consolidateMemory(agentId);
    }, MEMORY_DECAY_CONFIG.CONSOLIDATION_INTERVAL);

    timer.unref && timer.unref();
    this._consolidationTimers.set(agentId, timer);
  }

  /**
   * 关闭所有记忆空间
   */
  close() {
    for (const agentId of this._agentDBs.keys()) {
      this.closeAgentMemory(agentId);
    }
    this.removeAllListeners();
  }
}

module.exports = {
  SubAgentMemoryBinder,
  MEMORY_BIND_STATUS,
  SKILL_MEMORY_TIER,
  MEMORY_DECAY_CONFIG,
};
