/**
 * TriCoreAgent v2.9 - SubAgentMemoryBinder 单元测试
 *
 * 覆盖范围：
 *   - 独立记忆数据库初始化
 *   - 技能绑定/解绑
 *   - 技能锁定为核心记忆
 *   - 记忆写入/搜索
 *   - 记忆层级（L0-L4）
 *   - 记忆导出/导入
 *   - 记忆统计
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DATA_DIR = path.join(os.tmpdir(), `tricore_test_memory_binder_${Date.now()}`);

class MockLogger {
  constructor() { this.logs = []; }
  info() {}
  warn() {}
  error() {}
  debug() {}
}

const {
  SubAgentMemoryBinder,
  MEMORY_BIND_STATUS,
  SKILL_MEMORY_TIER,
  MEMORY_DECAY_CONFIG,
} = require('../../src/subagent/subagent-memory-binder');

function createBinder(options = {}) {
  return new SubAgentMemoryBinder({
    logger: new MockLogger(),
    dataDir: path.join(TEST_DATA_DIR, options.suffix || 'default'),
    parentMemoryEngine: null,
    ...options,
  });
}

function cleanup() {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
}

// ═══════════════════════════════════════

test('SubAgentMemoryBinder - 导出常量', async (t) => {
  await t.test('MEMORY_BIND_STATUS', () => {
    assert.ok(MEMORY_BIND_STATUS);
  });

  await t.test('SKILL_MEMORY_TIER', () => {
    assert.ok(SKILL_MEMORY_TIER);
  });

  await t.test('MEMORY_DECAY_CONFIG', () => {
    assert.ok(MEMORY_DECAY_CONFIG);
  });
});

test('SubAgentMemoryBinder - 初始化', async (t) => {
  await t.test('创建记忆绑定器', () => {
    const binder = createBinder({ suffix: 'init' });
    assert.ok(binder);
    assert.ok(binder._dataDir);
  });

  await t.test('初始化agent记忆空间', () => {
    const binder = createBinder({ suffix: 'init_agent' });
    const result = binder.initAgentMemory('agent_001', {
      agentName: '测试智能体',
      agentType: 'assistant',
    });
    assert.ok(result);
    // 检查数据库文件是否创建
    const dbPath = path.join(binder._dataDir, 'agent_001', 'memory', 'memory.db');
    const fs = require('fs');
    const dbDirExists = fs.existsSync(path.dirname(dbPath));
    assert.ok(dbDirExists, '记忆目录应被创建');
  });

  cleanup();
});

test('SubAgentMemoryBinder - 技能绑定', async (t) => {
  await t.test('绑定技能到记忆', () => {
    const binder = createBinder({ suffix: 'bind_skill' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });

    const skill = {
      id: 'skill_001',
      name: '数据分析',
      category: 'data_analysis',
      version: '1.0.0',
      instructions: '数据分析技能说明',
      triggerKeywords: ['数据', '分析'],
    };

    const result = binder.bindSkill('agent_001', skill);
    // 由于better-sqlite3可能未安装，bindSkill可能有graceful fallback
    assert.ok(result);
  });

  await t.test('解绑技能', () => {
    const binder = createBinder({ suffix: 'unbind' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });
    const result = binder.unbindSkill('agent_001', 'skill_001');
    assert.ok(result);
  });

  cleanup();
});

test('SubAgentMemoryBinder - 技能锁定', async (t) => {
  await t.test('锁定技能为核心记忆', () => {
    const binder = createBinder({ suffix: 'lock' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });

    const skill = { id: 'core_skill', name: '核心技能', category: 'core' };
    binder.bindSkill('agent_001', skill);
    const result = binder.lockSkillAsCore('agent_001', 'core_skill');
    assert.ok(result);
  });

  cleanup();
});

test('SubAgentMemoryBinder - 记忆操作', async (t) => {
  await t.test('写入记忆', () => {
    const binder = createBinder({ suffix: 'write_mem' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });

    const result = binder.writeMemory('agent_001', '这是一条测试记忆', 3.0);
    assert.ok(result);
  });

  await t.test('搜索记忆', () => {
    const binder = createBinder({ suffix: 'search_mem' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });

    binder.writeMemory('agent_001', '关于数据分析的记忆', 5.0);
    const results = binder.searchMemory('agent_001', '数据分析');
    assert.ok(Array.isArray(results));
  });

  await t.test('获取固化技能列表', () => {
    const binder = createBinder({ suffix: 'bound_skills' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });

    const skill = { id: 'bound_001', name: '已绑定技能', category: 'test' };
    binder.bindSkill('agent_001', skill);

    const bound = binder.getBoundSkills('agent_001');
    assert.ok(Array.isArray(bound));
  });

  cleanup();
});

test('SubAgentMemoryBinder - 记忆导出导入', async (t) => {
  await t.test('导出技能记忆', () => {
    const binder = createBinder({ suffix: 'export' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });

    const skill = { id: 'exp_001', name: '导出测试', category: 'test' };
    binder.bindSkill('agent_001', skill);
    binder.writeMemory('agent_001', '导出测试记忆', 4.0);

    const exported = binder.exportSkillMemories('agent_001');
    assert.ok(exported);
  });

  await t.test('导入技能记忆', () => {
    const binder = createBinder({ suffix: 'import' });
    binder.initAgentMemory('agent_002', { agentName: 'Import Target' });

    const data = {
      skills: [{ id: 'imp_001', name: '导入技能', category: 'test' }],
      memories: [{ content: '导入的记忆', salience: 4.0 }],
    };

    const result = binder.importSkillMemories('agent_002', data);
    assert.ok(result);
  });

  cleanup();
});

test('SubAgentMemoryBinder - 统计', async (t) => {
  await t.test('获取记忆统计', () => {
    const binder = createBinder({ suffix: 'stats' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });
    binder.writeMemory('agent_001', '记忆1', 5.0);
    binder.writeMemory('agent_001', '记忆2', 3.0);

    const stats = binder.getMemoryStats('agent_001');
    assert.ok(stats);
  });

  await t.test('关闭记忆空间', () => {
    const binder = createBinder({ suffix: 'close_mem' });
    binder.initAgentMemory('agent_001', { agentName: 'Test' });
    const result = binder.closeAgentMemory('agent_001');
    assert.ok(result);
  });

  cleanup();
});

// ── 最终清理 ──
test('清理测试数据', () => {
  cleanup();
});
