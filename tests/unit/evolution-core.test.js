/**
 * 进化核 (EvolutionCore) 单元测试 — v5.0.0 新增
 * 覆盖：技能沉淀、技能审计、SKILL.md生成、整合循环、轨迹分析、重试机制
 */
'use strict';

const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { EvolutionCore, SKILL_STATUS, SKILL_CATEGORY, SKILL_MD_TEMPLATE } = require('../../src/core/evolution-core');

// Mock memory engine with SQLite-like interface
class MockMemory {
  constructor() {
    this._db = {
      prepare: () => ({
        get: () => ({ c: 0 }),
        all: () => [],
        run: () => {},
      }),
    };
    this._traces = new Map();
    this._skills = [];
    this._focusStack = [];
  }

  getExecutionTrace(taskId) {
    return this._traces.get(taskId) || [];
  }

  recordExecutionTrace(trace) {
    if (!this._traces.has(trace.task_id)) {
      this._traces.set(trace.task_id, []);
    }
    this._traces.get(trace.task_id).push(trace);
  }

  searchSkills(query, limit = 3) {
    return this._skills.slice(0, limit);
  }

  recordSkillUse(skillId) {
    const skill = this._skills.find(s => s.id === skillId);
    if (skill) skill.use_count = (skill.use_count || 0) + 1;
  }

  saveSkill(skill) {
    const saved = { id: this._skills.length + 1, ...skill, audit_status: 'pending' };
    this._skills.push(saved);
    return saved;
  }

  auditSkill(skillId, decision) {
    const skill = this._skills.find(s => s.id === skillId);
    if (skill) skill.audit_status = decision;
  }

  decay() { this._decayed = true; }
  consolidate() { return 3; }

  extractKeywords(text, count = 5) { return text.split(/\s+/).slice(0, count); }
  getFocusStack() { return this._focusStack; }
  updateFocusStack(event, keywords, tick) {
    this._focusStack.push({ topics: keywords, event, tick });
    return this._focusStack;
  }

  _isSimilar(a, b) { return false; }
}

describe('EvolutionCore', () => {
  let evo;
  let memory;

  beforeEach(() => {
    memory = new MockMemory();
    evo = new EvolutionCore({
      memory,
      minTracesForSkill: 2,
      consolidationInterval: 1000,
      consolidationRetryMax: 3,
      consolidationRetryBaseDelay: 100,
    });
  });

  afterEach(() => {
    evo.stopConsolidationLoop();
  });

  // ═══ 技能提取 ═══
  describe('extractSkillFromTask', () => {
    it('should return null when insufficient traces', async () => {
      const result = await evo.extractSkillFromTask('task1');
      assert.equal(result, null);
    });

    it('should extract skill from successful traces (template fallback)', async () => {
      memory._traces.set('task_success', [
        { task_id: 'task_success', step_index: 0, action: 'read_file', params: '{}', success: true, duration_ms: 100, result: 'content' },
        { task_id: 'task_success', step_index: 1, action: 'write_file', params: '{}', success: true, duration_ms: 50, result: 'success' },
      ]);

      const result = await evo.extractSkillFromTask('task_success');
      assert.ok(result);
      assert.equal(result.status, SKILL_STATUS.PENDING);
      assert.ok(result.name.startsWith('auto_skill_'));
    });

    it('should not extract skill from failed traces', async () => {
      memory._traces.set('task_failed', [
        { task_id: 'task_failed', step_index: 0, action: 'read_file', params: '{}', success: true, duration_ms: 100, result: 'ok' },
        { task_id: 'task_failed', step_index: 1, action: 'write_file', params: '{}', success: false, duration_ms: 50, result: 'error' },
      ]);

      const result = await evo.extractSkillFromTask('task_failed');
      assert.equal(result, null);
    });

    it('should deduplicate similar skills', async () => {
      memory._skills.push({ id: 1, name: 'existing', description: 'similar description' });
      memory._isSimilar = () => true;

      memory._traces.set('task_dup', [
        { task_id: 'task_dup', step_index: 0, action: 'read_file', params: '{}', success: true, duration_ms: 100, result: 'ok' },
        { task_id: 'task_dup', step_index: 1, action: 'list_dir', params: '{}', success: true, duration_ms: 50, result: 'ok' },
      ]);

      const result = await evo.extractSkillFromTask('task_dup');
      assert.equal(result, null);
    });
  });

  // ═══ 模板技能提取 ═══
  describe('_extractSkillFromTemplate', () => {
    it('should create skill from traces', () => {
      const traces = [
        { action: 'read_file', params: { path: 'test.txt' } },
        { action: 'write_file', params: { path: 'out.txt', content: 'data' } },
      ];
      const skill = evo._extractSkillFromTemplate(traces, 'tpl_task');
      assert.ok(skill.name.includes('tpl_task'));
      assert.equal(skill.category, SKILL_CATEGORY.GENERAL);
      assert.ok(skill.steps.length === 2);
      assert.ok(skill.triggers.includes('read_file'));
      assert.ok(skill.caveats.length > 0);
    });
  });

  // ═══ SKILL.md生成 ═══
  describe('_generateSkillMd', () => {
    it('should generate valid SKILL.md content', () => {
      const skill = {
        name: 'test_skill',
        description: 'A test skill',
        category: SKILL_CATEGORY.DATA_PROCESSING,
        triggers: ['analyze', 'process'],
        steps: ['Step 1: load data', 'Step 2: transform'],
        caveats: ['Backup before running'],
      };
      const md = evo._generateSkillMd(skill);
      assert.ok(md.includes('# test_skill'));
      assert.ok(md.includes('A test skill'));
      assert.ok(md.includes('- analyze'));
      assert.ok(md.includes('1. Step 1: load data'));
      assert.ok(md.includes('- Backup before running'));
      assert.ok(md.includes('data_processing'));
      assert.ok(md.includes('是')); // auto_created
    });

    it('should handle empty arrays gracefully', () => {
      const md = evo._generateSkillMd({ name: 'minimal', description: 'min' });
      assert.ok(md.includes('# minimal'));
      assert.ok(md.includes('- 无特定触发条件'));
      assert.ok(md.includes('- 无具体步骤'));
    });
  });

  // ═══ 技能审计 ═══
  describe('auditSkill', () => {
    it('should approve a pending skill', () => {
      memory._skills.push({ id: 1, name: 'approvable', audit_status: 'pending', category: SKILL_CATEGORY.GENERAL });
      const result = evo.auditSkill(1, SKILL_STATUS.APPROVED, 'Looks safe');
      assert.ok(result.success);
      assert.equal(memory._skills[0].audit_status, SKILL_STATUS.APPROVED);
    });

    it('should reject a skill', () => {
      memory._skills.push({ id: 2, name: 'rejectable', audit_status: 'pending', category: SKILL_CATEGORY.AUTOMATION });
      const result = evo.auditSkill(2, SKILL_STATUS.REJECTED, 'Too risky');
      assert.ok(result.success);
      assert.equal(memory._skills[0].audit_status, SKILL_STATUS.REJECTED);
    });

    it('should reject invalid decision values', () => {
      memory._skills.push({ id: 3, name: 'invalid', audit_status: 'pending', category: SKILL_CATEGORY.GENERAL });
      assert.throws(() => {
        evo.auditSkill(3, 'invalid_decision');
      }, /Invalid audit decision/);
    });

    it('should emit skill_audited event', () => {
      memory._skills.push({ id: 4, name: 'event_skill', audit_status: 'pending', category: SKILL_CATEGORY.ANALYSIS });
      const events = [];
      evo.on('skill_audited', (data) => events.push(data));
      evo.auditSkill(4, SKILL_STATUS.APPROVED, 'OK');
      assert.equal(events.length, 1);
      assert.equal(events[0].decision, SKILL_STATUS.APPROVED);
    });
  });

  // ═══ 自动审计安全技能 ═══
  describe('autoAuditSafeSkills', () => {
    it('should auto-approve safe category skills', () => {
      memory._skills = [
        { id: 1, name: 'data_skill', category: SKILL_CATEGORY.DATA_PROCESSING, audit_status: 'pending', auto_created: 1 },
        { id: 2, name: 'analysis_skill', category: SKILL_CATEGORY.ANALYSIS, audit_status: 'pending', auto_created: 1 },
        { id: 3, name: 'automation_skill', category: SKILL_CATEGORY.AUTOMATION, audit_status: 'pending', auto_created: 1 },
      ];
      memory._db.prepare = () => ({ all: () => memory._skills });

      const result = evo.autoAuditSafeSkills();
      assert.ok(result.approved >= 2); // DATA_PROCESSING + ANALYSIS
      assert.equal(memory._skills[0].audit_status, SKILL_STATUS.APPROVED);
    });
  });

  // ═══ 整合循环 ═══
  describe('consolidation loop', () => {
    it('should start and stop consolidation loop', () => {
      evo.startConsolidationLoop();
      assert.ok(evo._consolidationTimer);
      evo.stopConsolidationLoop();
      assert.equal(evo._consolidationTimer, null);
    });

    it('should not create duplicate timers', () => {
      evo.startConsolidationLoop();
      const firstTimer = evo._consolidationTimer;
      evo.startConsolidationLoop();
      assert.equal(evo._consolidationTimer, firstTimer);
      evo.stopConsolidationLoop();
    });

    it('should run consolidation successfully', () => {
      evo.runConsolidation();
      assert.ok(memory._decayed);
      assert.ok(evo._lastConsolidationAt > 0);
      assert.equal(evo._consolidationRetryCount, 0);
    });

    it('should emit consolidation_complete event', () => {
      const events = [];
      evo.on('consolidation_complete', (data) => events.push(data));
      evo.runConsolidation();
      assert.equal(events.length, 1);
      assert.ok(events[0].memoriesMerged >= 0);
    });
  });

  // ═══ 轨迹分析 ═══
  describe('analyzeExecutionPatterns', () => {
    it('should return empty for no traces', async () => {
      const suggestions = await evo.analyzeExecutionPatterns();
      assert.deepEqual(suggestions, []);
    });

    it('should detect low success rate patterns', async () => {
      memory._db.prepare = () => ({
        all: () => [
          { action: 'failing_action', success: false, duration_ms: 100 },
          { action: 'failing_action', success: false, duration_ms: 100 },
          { action: 'failing_action', success: false, duration_ms: 100 },
          { action: 'failing_action', success: true, duration_ms: 100 },
        ],
      });

      const suggestions = await evo.analyzeExecutionPatterns();
      const lowSuccess = suggestions.filter(s => s.type === 'low_success_rate');
      assert.ok(lowSuccess.length > 0);
      assert.equal(lowSuccess[0].action, 'failing_action');
    });

    it('should detect slow execution patterns', async () => {
      memory._db.prepare = () => ({
        all: () => [
          { action: 'slow_action', success: true, duration_ms: 10000 },
          { action: 'slow_action', success: true, duration_ms: 8000 },
        ],
      });

      const suggestions = await evo.analyzeExecutionPatterns();
      const slow = suggestions.filter(s => s.type === 'slow_execution');
      assert.ok(slow.length > 0);
    });
  });

  // ═══ 重试机制 (v4.0) ═══
  describe('consolidation retry (v4.0)', () => {
    it('should retry on failure with exponential backoff', () => {
      // Make consolidate throw
      memory.consolidate = () => { throw new Error('simulated failure'); };

      const retryEvents = [];
      evo.on('consolidation_retry', (data) => retryEvents.push(data));

      evo.runConsolidation();
      assert.equal(evo._consolidationRetryCount, 1);
      assert.ok(retryEvents.length > 0);
      assert.equal(retryEvents[0].attempt, 1);
    });

    it('should emit consolidation_failed after max retries', () => {
      memory.consolidate = () => { throw new Error('persistent failure'); };
      evo._consolidationRetryMax = 1; // Only 1 retry

      const failEvents = [];
      evo.on('consolidation_failed', (data) => failEvents.push(data));

      // First call triggers retry, second call should fail
      evo.runConsolidation();
      evo.runConsolidation(); // retry count now 2 > max 1
      assert.ok(failEvents.length > 0);
    });
  });

  // ═══ 状态查询 ═══
  describe('getStatus', () => {
    it('should return consolidation status', () => {
      const status = evo.getStatus();
      assert.equal(status.lastConsolidationAt, 0);
      assert.equal(status.consolidationInterval, 1000);
      assert.equal(status.isRunning, false);

      evo.startConsolidationLoop();
      assert.equal(evo.getStatus().isRunning, true);
      evo.stopConsolidationLoop();
    });
  });

  // ═══ LLM解析 ═══
  describe('_parseSkillFromLLM', () => {
    it('should parse valid JSON skill', () => {
      const content = '```json\n{"name":"web_scraper","description":"Scrapes web pages","category":"web_interaction","triggers":["scrape","fetch"],"steps":["1. Fetch URL","2. Parse HTML"],"caveats":["Respect robots.txt"]}\n```';
      const skill = evo._parseSkillFromLLM(content);
      assert.ok(skill);
      assert.equal(skill.name, 'web_scraper');
      assert.equal(skill.description, 'Scrapes web pages');
      assert.equal(skill.category, 'web_interaction');
      assert.equal(skill.triggers.length, 2);
      assert.equal(skill.steps.length, 2);
      assert.equal(skill.caveats.length, 1);
    });

    it('should return null for invalid content', () => {
      assert.equal(evo._parseSkillFromLLM(''), null);
      assert.equal(evo._parseSkillFromLLM(null), null);
      assert.equal(evo._parseSkillFromLLM('not json at all'), null);
    });

    it('should return null for missing required fields', () => {
      const content = '{"description":"no name"}';
      assert.equal(evo._parseSkillFromLLM(content), null);
    });
  });
});
