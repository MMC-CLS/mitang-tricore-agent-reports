/**
 * TriCore Agent - 进化核 (Evolution Core)
 *
 * 继承爱马仕的核心设计：
 *   1. 自动技能沉淀引擎 - 从执行轨迹中提取可复用技能
 *   2. SKILL.md开放标准 - 可搜索、可分享、可移植的技能文档
 *   3. 技能审计系统 - 安全约束：自动沉淀的技能必须审计才能激活
 *   4. 记忆整合循环 - 去重、降级、合并、衰减
 *   5. 轨迹分析器 - 分析执行模式，发现改进机会
 *
 * 设计原则："进化受约束"
 *   - 自动沉淀的技能默认状态为pending，必须经过审计才可使用
 *   - 技能执行有权重限制，新技能初始权重低
 *   - 记忆整合不会删除高salience记忆
 *
 * 治理层集成（v2.0）：
 *   - _dispatchBus(): 所有生命周期事件同步总线派发
 *   - _extractSkillWithLLM(): 预算检查 + 用量上报
 *   - auditSkill(): 安全边界授权检查
 *   - runConsolidation(): 总线派发整合完成事件
 */

'use strict';

const { EventEmitter } = require('events');

// ── 技能状态 ──
const SKILL_STATUS = Object.freeze({
  PENDING: 'pending',       // 待审计
  APPROVED: 'approved',     // 已批准可用
  REJECTED: 'rejected',     // 已拒绝
  DEPRECATED: 'deprecated', // 已废弃
});

// ── 技能类别 ──
const SKILL_CATEGORY = Object.freeze({
  DATA_PROCESSING: 'data_processing',
  FILE_OPERATION: 'file_operation',
  WEB_INTERACTION: 'web_interaction',
  CODE_GENERATION: 'code_generation',
  ANALYSIS: 'analysis',
  COMMUNICATION: 'communication',
  AUTOMATION: 'automation',
  GENERAL: 'general',
});

// ── SKILL.md模板 ──
const SKILL_MD_TEMPLATE = `# {name}

## 描述
{description}

## 触发条件
{triggers}

## 步骤
{steps}

## 注意事项
{caveats}

## 元数据
- 类别: {category}
- 自动创建: {auto_created}
- 创建时间: {created_at}
- 使用次数: {use_count}
`;

class EvolutionCore extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── 依赖注入 ──
    this._memory = options.memory || null;
    this._router = options.router || null;
    this._bus = options.bus || null;
    this._security = options.security || null;
    this._budget = options.budget || null;

    // ── 配置 ──
    this._consolidationInterval = options.consolidationInterval ?? 30 * 60 * 1000; // 30分钟
    this._minTracesForSkill = options.minTracesForSkill ?? 2;   // 至少2次成功轨迹才沉淀技能
    this._maxPendingSkills = options.maxPendingSkills ?? 50;     // 待审计技能上限
    this._skillSimilarityThreshold = options.skillSimilarityThreshold ?? 0.6;

    // ── 整合循环 ──
    this._consolidationTimer = null;
    this._lastConsolidationAt = 0;

    // v4.0: 整合重试机制
    this._consolidationRetryMax = options.consolidationRetryMax ?? 3;
    this._consolidationRetryBaseDelay = options.consolidationRetryBaseDelay ?? 30000;
    this._consolidationRetryCount = 0;

    // ── 轨迹分析 ──
    this._executionPatterns = new Map(); // pattern hash → { count, successRate, taskIds }
  }

  // ═══════════════════════════════════════
  // 技能沉淀
  // ═══════════════════════════════════════

  /**
   * 从执行轨迹自动沉淀技能
   * @param {string} taskId - 已完成的任务ID
   * @returns {Object|null} 新沉淀的技能（pending状态），或null
   */
  async extractSkillFromTask(taskId) {
    if (!this._memory) return null;

    const traces = this._memory.getExecutionTrace(taskId);
    if (traces.length < this._minTracesForSkill) return null;

    // 只沉淀全成功的任务
    const allSuccess = traces.every(t => t.success);
    if (!allSuccess) return null;

    // 用LLM提取技能
    const skill = await this._extractSkillWithLLM(traces, taskId);
    if (!skill) return null;

    // 检查是否与已有技能重复（v2.0: 增量学习增强）
    const existingSkills = this._memory.searchSkills(skill.name || skill.description, 3);
    if (existingSkills.length > 0) {
      for (const existing of existingSkills) {
        if (this._memory._isSimilar(existing.description, skill.description)) {
          // ── v2.0: 增量学习 — 检查是否有同类已存在技能，增量更新而非全新生成 ──
          const incrementallyUpdated = this._incrementalUpdateSkill(existing, skill, traces, taskId);
          if (incrementallyUpdated) {
            this.emit('skill_incrementally_updated', {
              existingSkill: existing.name,
              newSteps: skill.steps?.length || 0,
              sourceTask: taskId,
            });
            this._dispatchBus('evolution:skill_incrementally_updated', {
              existingSkill: existing.name,
              newSteps: skill.steps?.length || 0,
              sourceTask: taskId,
            });
            return { name: existing.name, status: existing.status || SKILL_STATUS.PENDING, incrementallyUpdated: true };
          }

          // 降级：仅更新已有技能的使用计数
          this._memory.recordSkillUse(existing.id);
          this.emit('skill_deduplicated', { existingSkill: existing.name, newDescription: skill.description });
          this._dispatchBus('evolution:skill_deduplicated', { existingSkill: existing.name, newDescription: skill.description });
          return null;
        }
      }
    }

    // 检查待审计技能数量
    const pendingCount = this._memory.getPendingSkillCount();
    if (pendingCount >= this._maxPendingSkills) {
      this.emit('skill_queue_full', { pendingCount });
      this._dispatchBus('system:warning', { type: 'skill_queue_full', pendingCount, max: this._maxPendingSkills });
      return null;
    }

    // 保存为SKILL.md格式
    const skillContent = this._generateSkillMd(skill);
    const saveResult = this._memory.saveSkill({
      name: skill.name,
      description: skill.description,
      content: skillContent,
      category: skill.category || SKILL_CATEGORY.GENERAL,
      trigger_keywords: skill.triggers,
      auto_created: true,
    });

    this.emit('skill_extracted', {
      name: skill.name,
      category: skill.category,
      sourceTask: taskId,
      status: SKILL_STATUS.PENDING,
    });

    // 通过总线通知技能沉淀
    this._dispatchBus('evolution:skill_extracted', {
      name: skill.name,
      category: skill.category,
      sourceTask: taskId,
      status: SKILL_STATUS.PENDING,
    });

    return { name: skill.name, status: SKILL_STATUS.PENDING, content: skillContent };
  }

  /**
   * LLM驱动的技能提取（含预算检查 + 用量上报）
   */
  async _extractSkillWithLLM(traces, taskId) {
    if (!this._router) {
      // 无LLM，使用简单模板提取
      return this._extractSkillFromTemplate(traces, taskId);
    }

    const traceSummary = traces.map(t =>
      `步骤${t.step_index}: ${t.action}(${t.params ? JSON.stringify(t.params) : ''}) → ${t.success ? '成功' : '失败'} | 结果: ${(t.result || '').substring(0, 100)}`
    ).join('\n');

    // ── Token预算检查 ──
    const estimatedTokens = 1024;
    const budgetDecision = this._budget
      ? this._budget.requestTokens('evolution', estimatedTokens, { priority: 40, callType: 'skill_extract' })
      : { allowed: true, adjustedMaxTokens: 1024 };

    if (!budgetDecision.allowed) {
      // 预算不足，降级为模板提取
      this._dispatchBus('system:warning', { type: 'budget_denied', core: 'evolution', callType: 'skill_extract', reason: budgetDecision.reason });
      return this._extractSkillFromTemplate(traces, taskId);
    }

    // 缓存命中直接返回
    if (budgetDecision.fromCache && budgetDecision.cacheResult) {
      return budgetDecision.cacheResult;
    }

    try {
      const { MODEL_PURPOSE } = require('../providers/model-router');
      const result = await this._router.call({
        purpose: MODEL_PURPOSE.EVOLUTION,
        messages: [
          {
            role: 'system',
            content: [
              '你是一个技能提取专家。从执行轨迹中提取可复用的技能。',
              '',
              '输出JSON格式：',
              '{',
              '  "name": "技能名称（英文snake_case）",',
              '  "description": "简短中文描述",',
              '  "category": "分类(data_processing|file_operation|web_interaction|code_generation|analysis|communication|automation|general)",',
              '  "triggers": ["触发关键词1", "关键词2"],',
              '  "steps": ["步骤1描述", "步骤2描述"],',
              '  "caveats": ["注意事项1"]',
              '}',
              '',
              '规则：',
              '- 只输出JSON',
              '- 技能名称要简洁、描述性',
              '- 触发关键词要覆盖用户可能的表达',
              '- 步骤要具体可执行',
            ].join('\n'),
          },
          { role: 'user', content: `任务ID: ${taskId}\n执行轨迹:\n${traceSummary}` },
        ],
        temperature: 0.4,
        max_tokens: budgetDecision.adjustedMaxTokens || 1024,
      });

      // ── 报告Token使用量 ──
      if (this._budget && result.usage) {
        this._budget.reportUsage('evolution', result.usage, result);
      }

      return this._parseSkillFromLLM(result.content);
    } catch (error) {
      // LLM提取失败，降级为模板提取
      this._dispatchBus('system:error', { type: 'skill_extract_error', core: 'evolution', taskId, error: error.message });
      return this._extractSkillFromTemplate(traces, taskId);
    }
  }

  /**
   * 模板式技能提取（无LLM兜底）
   */
  _extractSkillFromTemplate(traces, taskId) {
    const actions = traces.map(t => t.action);
    const uniqueActions = [...new Set(actions)];

    return {
      name: `auto_skill_${taskId}`,
      description: `自动技能: ${uniqueActions.join(' → ')}`,
      category: SKILL_CATEGORY.GENERAL,
      triggers: uniqueActions,
      steps: traces.map(t => `${t.action}${t.params ? `(${JSON.stringify(t.params)})` : ''}`),
      caveats: ['此技能由系统自动提取，请审计后再使用'],
    };
  }

  /**
   * 解析LLM输出的技能
   */
  _parseSkillFromLLM(content) {
    if (!content) return null;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.name || !parsed.description) return null;
      return {
        name: parsed.name,
        description: parsed.description,
        category: parsed.category || SKILL_CATEGORY.GENERAL,
        triggers: parsed.triggers || [],
        steps: parsed.steps || [],
        caveats: parsed.caveats || [],
      };
    } catch {
      return null;
    }
  }

  /**
   * 增量更新已有技能（v2.0新增）
   *
   * 当发现同类已存在技能时，不创建全新技能，而是：
   *   1. 合并新步骤到已有步骤列表（去重追加）
   *   2. 合并新触发关键词
   *   3. 更新使用计数和最后更新时间
   *   4. 通过 _memory 的相关方法持久化更新
   *
   * @param {Object} existing - 已存在的技能对象
   * @param {Object} newSkill - 新提取的技能
   * @param {Array} traces - 执行轨迹
   * @param {string} taskId - 源任务ID
   * @returns {boolean} 是否成功增量更新
   */
  _incrementalUpdateSkill(existing, newSkill, traces, taskId) {
    if (!this._memory) return false;

    try {
      // ── 合并步骤：新步骤追加到已有步骤（去重） ──
      const existingSteps = existing.steps || [];
      const existingStepTexts = new Set(existingSteps.map(s => s.toLowerCase().trim()));
      const newSteps = (newSkill.steps || []).filter(s => {
        const normalized = s.toLowerCase().trim();
        return normalized && !existingStepTexts.has(normalized);
      });

      // ── 合并触发关键词 ──
      const existingTriggers = new Set((existing.trigger_keywords || []).map(t => t.toLowerCase().trim()));
      const newTriggers = (newSkill.triggers || []).filter(t => {
        const normalized = t.toLowerCase().trim();
        return normalized && !existingTriggers.has(normalized);
      });

      // ── 更新技能内容 ──
      const updatedSteps = [...existingSteps, ...newSteps];
      const updatedTriggers = [...(existing.trigger_keywords || []), ...newTriggers];

      // 重新生成SKILL.md内容
      const updatedSkillMd = this._generateSkillMd({
        name: existing.name,
        description: existing.description,
        category: existing.category || SKILL_CATEGORY.GENERAL,
        triggers: updatedTriggers,
        steps: updatedSteps,
        caveats: existing.caveats || [],
      });

      // 通过 memory 更新技能（如果支持 updateSkill 方法）
      if (typeof this._memory.updateSkill === 'function') {
        this._memory.updateSkill(existing.id, {
          content: updatedSkillMd,
          trigger_keywords: updatedTriggers,
          steps: updatedSteps,
          updated_at: Date.now(),
        });
      } else {
        // 降级：至少记录使用
        this._memory.recordSkillUse(existing.id);
      }

      return true;
    } catch (e) {
      // 增量更新失败，降级为仅记录使用
      try { this._memory.recordSkillUse(existing.id); } catch (_) { /* 最终降级 */ }
      return false;
    }
  }

  // ═══════════════════════════════════════
  // SKILL.md标准
  // ═══════════════════════════════════════

  /**
   * 生成SKILL.md格式内容
   */
  _generateSkillMd(skill) {
    return SKILL_MD_TEMPLATE
      .replace('{name}', skill.name || 'unnamed_skill')
      .replace('{description}', skill.description || '')
      .replace('{triggers}', (skill.triggers || []).map(t => `- ${t}`).join('\n') || '- 无特定触发条件')
      .replace('{steps}', (skill.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n') || '- 无具体步骤')
      .replace('{caveats}', (skill.caveats || []).map(c => `- ${c}`).join('\n') || '- 无特殊注意')
      .replace('{category}', skill.category || SKILL_CATEGORY.GENERAL)
      .replace('{auto_created}', '是')
      .replace('{created_at}', new Date().toLocaleString('zh-CN'))
      .replace('{use_count}', '0');
  }

  /**
   * 导出技能为SKILL.md文件
   */
  async exportSkillMd(skillId, outputDir) {
    if (!this._memory) return null;

    const skill = this._memory.getSkillById(skillId);
    if (!skill) return null;

    const fs = require('fs');
    const fsPromises = require('fs/promises');
    await fsPromises.mkdir(outputDir, { recursive: true });

    const filename = `${skill.name}.skill.md`;
    const filePath = require('path').join(outputDir, filename);
    await fsPromises.writeFile(filePath, skill.content, 'utf-8');

    return filePath;
  }

  // ═══════════════════════════════════════
  // 技能审计（含安全边界授权）
  // ═══════════════════════════════════════

  /**
   * 审计技能（需安全边界授权）
   * @param {number} skillId
   * @param {string} decision - approved | rejected
   * @param {string} reason
   * @returns {Object} { success, reason? }
   */
  auditSkill(skillId, decision, reason = '') {
    if (!this._memory) return { success: false, reason: 'No memory engine' };

    if (!Object.values(SKILL_STATUS).includes(decision)) {
      throw new Error(`Invalid audit decision: ${decision}`);
    }

    // ── 安全边界：技能审计需授权 ──
    if (this._security) {
      const { CORE_IDENTITY, CAPABILITY } = require('../security/security-boundary');
      const auth = this._security.authorize(CORE_IDENTITY.EVOLUTION, CAPABILITY.AUDIT_SKILL, {
        params: { skillId, decision, reason },
      });
      if (!auth.allowed) {
        this._dispatchBus('system:warning', { type: 'audit_unauthorized', skillId, decision, reason: auth.reason });
        return { success: false, reason: `Security denied: ${auth.reason}` };
      }
    }

    this._memory.auditSkill(skillId, decision);

    this.emit('skill_audited', {
      skillId,
      decision,
      reason,
      timestamp: Date.now(),
    });

    // 通过总线通知审计结果
    if (decision === SKILL_STATUS.APPROVED) {
      this._dispatchBus('evolution:skill_published', { skillId, decision, reason });
    } else {
      this._dispatchBus('evolution:skill_audited', { skillId, decision, reason });
    }

    return { success: true };
  }

  /**
   * 批量审计：自动批准安全技能
   */
  autoAuditSafeSkills() {
    if (!this._memory) return { approved: 0, rejected: 0 };

    const pendingSkills = this._memory.getPendingSkills(true);

    let approved = 0;
    let rejected = 0;

    for (const skill of pendingSkills) {
      // 简单规则：只读类别的技能自动批准
      const safeCategories = [SKILL_CATEGORY.DATA_PROCESSING, SKILL_CATEGORY.ANALYSIS, SKILL_CATEGORY.COMMUNICATION];
      if (safeCategories.includes(skill.category)) {
        const result = this.auditSkill(skill.id, SKILL_STATUS.APPROVED, 'Auto-approved: safe category');
        if (result.success) {
          approved++;
        }
      }
    }

    return { approved, rejected };
  }

  // ═══════════════════════════════════════
  // 记忆整合循环
  // ═══════════════════════════════════════

  /**
   * 启动整合循环（v2.0: 使用智能触发逻辑替代固定间隔）
   *
   * 不再使用固定间隔的 setInterval，改为动态评估是否触发整合。
   * 每30s轮询一次 shouldTriggerConsolidation()，满足条件时立即执行。
   */
  startConsolidationLoop() {
    if (this._consolidationTimer) return;

    // ── v2.0: 智能整合触发 — 使用动态间隔替代固定setInterval ──
    const pollInterval = Math.min(this._consolidationInterval, 30000); // 最多30s轮询一次
    this._consolidationTimer = setInterval(() => {
      try {
        // 检查是否满足智能触发条件
        if (this.shouldTriggerConsolidation()) {
          this.runConsolidation();
        }
      } catch (e) { /* errors handled inside runConsolidation */ }
    }, pollInterval);

    this.emit('consolidation_started', { interval: pollInterval, mode: 'smart_trigger' });
    this._dispatchBus('evolution:consolidation_started', { interval: pollInterval, mode: 'smart_trigger' });
  }

  /**
   * 停止整合循环
   */
  stopConsolidationLoop() {
    if (this._consolidationTimer) {
      clearInterval(this._consolidationTimer);
      this._consolidationTimer = null;
    }
  }

  /**
   * 智能整合触发判断（v2.0新增）
   *
   * 触发条件（满足任一即触发）：
   *   1. 新记忆超过100条 → 立即触发去重合并
   *   2. Pending技能超过20个 → 立即触发审计
   *   3. 距上次整合超过配置的 consolidationInterval → 按原定时间间隔
   *
   * 目的：避免记忆/技能积压导致系统质量下降，同时保持正常节奏
   * @returns {boolean} 是否应触发整合
   */
  shouldTriggerConsolidation() {
    if (!this._memory) return false;

    // ── 条件1: 新记忆超过100条，立即触发去重 ──
    try {
      const newMemoryCount = this._memory.getNewMemoryCount
        ? this._memory.getNewMemoryCount()
        : 0;
      if (newMemoryCount > 100) {
        return true;
      }
    } catch (e) { /* 降级：忽略统计错误 */ }

    // ── 条件2: Pending技能超过20个，立即触发审计 ──
    try {
      const pendingSkillCount = this._memory.getPendingSkillCount
        ? this._memory.getPendingSkillCount()
        : 0;
      if (pendingSkillCount > 20) {
        return true;
      }
    } catch (e) { /* 降级：忽略统计错误 */ }

    // ── 条件3: 距上次整合超过配置间隔 ──
    const timeSinceLast = Date.now() - this._lastConsolidationAt;
    if (timeSinceLast >= this._consolidationInterval) {
      return true;
    }

    return false;
  }

  /**
   * 执行一轮整合（含总线派发 + v4.0指数退避重试）
   * 1. 衰减：salience每日递减
   * 2. 去重：合并相似记忆
   * 3. 降级：冷记忆超限淘汰
   *
   * v4.2: decay + consolidate + audit 三步放入同一事务，确保原子性
   */
  runConsolidation() {
    if (!this._memory) return;
    try {
      let merged = 0;
      let approved = 0;

      // v4.2: 使用 MemoryEngine._transaction 确保三步原子化
      if (typeof this._memory._transaction === 'function') {
        this._memory._transaction(() => {
          // 衰减（使用内部方法避免嵌套事务）
          if (typeof this._memory._decayInternal === 'function') {
            this._memory._decayInternal();
          } else {
            this._memory.decay();
          }
          // 去重合并（使用内部方法避免嵌套事务）
          if (typeof this._memory._consolidateInternal === 'function') {
            merged = this._memory._consolidateInternal();
          } else {
            merged = this._memory.consolidate();
          }
          // 自动审计安全技能（在同一事务内）
          const auditResult = this.autoAuditSafeSkills();
          approved = auditResult.approved;
        });
      } else {
        // 降级路径：如果 MemoryEngine 没有 _transaction
        this._memory.decay();
        merged = this._memory.consolidate();
        const { approved: a } = this.autoAuditSafeSkills();
        approved = a;
      }

      this._lastConsolidationAt = Date.now();
      this._consolidationRetryCount = 0; // Reset on success

      this.emit('consolidation_complete', {
        memoriesMerged: merged,
        skillsAutoApproved: approved,
      });
      // 通过总线通知整合完成
      this._dispatchBus('evolution:consolidation_done', {
        memoriesMerged: merged,
        skillsAutoApproved: approved,
      });
    } catch (error) {
      // v4.0: 指数退避重试机制
      this._consolidationRetryCount++;
      const delay = Math.min(
        this._consolidationRetryBaseDelay * Math.pow(2, this._consolidationRetryCount - 1),
        300000 // 最大5分钟
      );
      if (this._consolidationRetryCount <= this._consolidationRetryMax) {
        this.emit('consolidation_retry', {
          attempt: this._consolidationRetryCount, delay, error: error.message,
        });
        setTimeout(() => this.runConsolidation(), delay);
      } else {
        this.emit('consolidation_failed', {
          error: error.message, attempts: this._consolidationRetryCount,
        });
        this._dispatchBus('evolution:consolidation_failed', { error: error.message });
        this._consolidationRetryCount = 0; // Reset for next cycle
      }
    }
  }

  // ═══════════════════════════════════════
  // 总线派发辅助
  // ═══════════════════════════════════════

  /**
   * 统一总线派发辅助方法
   * @param {string} eventType - BUS_EVENT中的事件类型
   * @param {Object} data - 事件数据
   * @param {Object} meta - 附加元信息
   */
  _dispatchBus(eventType, data, meta = {}) {
    if (this._bus) {
      this._bus.dispatch(eventType, data, { source: 'evolution', ...meta });
    }
  }

  // ═══════════════════════════════════════
  // 轨迹分析
  // ═══════════════════════════════════════

  /**
   * 分析执行模式，发现可改进的模式
   * @returns {Array} 改进建议列表
   */
  async analyzeExecutionPatterns() {
    if (!this._memory) return [];

    // 获取最近的执行轨迹
    const recentTraces = this._memory.getRecentExecutionTraces(200);

    if (recentTraces.length === 0) return [];

    // 按action分组统计
    const actionStats = {};
    for (const trace of recentTraces) {
      if (!actionStats[trace.action]) {
        actionStats[trace.action] = { total: 0, success: 0, totalDuration: 0 };
      }
      actionStats[trace.action].total++;
      if (trace.success) actionStats[trace.action].success++;
      actionStats[trace.action].totalDuration += trace.duration_ms || 0;
    }

    // 生成改进建议
    const suggestions = [];
    for (const [action, stats] of Object.entries(actionStats)) {
      const successRate = stats.success / stats.total;
      const avgDuration = stats.totalDuration / stats.total;

      if (successRate < 0.8) {
        suggestions.push({
          type: 'low_success_rate',
          action,
          successRate: (successRate * 100).toFixed(1) + '%',
          suggestion: `"${action}" 成功率仅${(successRate * 100).toFixed(1)}%，建议优化执行策略或增加前置校验`,
        });
      }

      if (avgDuration > 5000) {
        suggestions.push({
          type: 'slow_execution',
          action,
          avgDuration: (avgDuration / 1000).toFixed(1) + 's',
          suggestion: `"${action}" 平均耗时${(avgDuration / 1000).toFixed(1)}秒，建议缓存或异步化`,
        });
      }
    }

    return suggestions;
  }

  // ═══════════════════════════════════════
  // 状态
  // ═══════════════════════════════════════

  getStatus() {
    return {
      lastConsolidationAt: this._lastConsolidationAt,
      consolidationInterval: this._consolidationInterval,
      isRunning: !!this._consolidationTimer,
    };
  }
}

// ── 导出 ──
module.exports = {
  EvolutionCore,
  SKILL_STATUS,
  SKILL_CATEGORY,
  SKILL_MD_TEMPLATE,
};
