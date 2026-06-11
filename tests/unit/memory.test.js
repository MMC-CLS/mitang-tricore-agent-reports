/**
 * MemoryEngine 单元测试
 * Phase 20: 记忆引擎测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { MemoryEngine, MEMORY_TIER, DECAY_CONFIG } = require('../../src/memory/memory-engine');

test('MemoryEngine - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const mem = new MemoryEngine({
      dbPath: ':memory:',
    });
    assert.ok(mem);
    mem.init();
    mem.close();
  });

  await t.test('自定义缓存大小', () => {
    const mem = new MemoryEngine({
      dbPath: ':memory:',
      embeddingCacheSize: 100,
    });
    assert.ok(mem);
    mem.init();
    mem.close();
  });
});

test('MemoryEngine - 记忆CRUD', async (t) => {
  const mem = new MemoryEngine({ dbPath: ':memory:' });
  mem.init();

  await t.test('存储记忆', () => {
    const result = mem.store({
      content: '这是一条测试记忆',
      type: 'fact',
      importance: 0.8,
      tags: ['test', 'memory'],
    });
    assert.ok(result);
    assert.ok(result.id);
  });

  await t.test('搜索记忆', () => {
    mem.store({ content: '测试搜索功能的记忆', type: 'fact', importance: 0.5 });
    const results = mem.search({ text: '搜索', limit: 5 });
    assert.ok(Array.isArray(results));
  });

  await t.test('按标签搜索', () => {
    mem.store({ content: '带标签的记忆', type: 'fact', importance: 0.3, tags: ['unique-tag'] });
    const results = mem.search({ tags: ['unique-tag'], limit: 5 });
    assert.ok(Array.isArray(results));
  });

  await t.test('删除记忆', () => {
    const stored = mem.store({ content: '待删除的记忆', type: 'fact', importance: 0.1 });
    const deleted = mem.delete(stored.id);
    assert.ok(deleted);
  });

  mem.close();
});

test('MemoryEngine - 记忆层级', async (t) => {
  const mem = new MemoryEngine({ dbPath: ':memory:' });
  mem.init();

  await t.test('不同层级存储', () => {
    const tiers = [MEMORY_TIER.WORKING, MEMORY_TIER.SHORT_TERM, MEMORY_TIER.LONG_TERM];
    for (const tier of tiers) {
      const result = mem.store({
        content: `tier ${tier} memory`,
        type: 'fact',
        tier,
        importance: 0.5,
      });
      assert.ok(result);
    }
  });

  mem.close();
});

test('MemoryEngine - 统计', async (t) => {
  const mem = new MemoryEngine({ dbPath: ':memory:' });
  mem.init();

  await t.test('getStats', () => {
    mem.store({ content: 'stats test', type: 'fact', importance: 0.5 });
    const stats = mem.getStats();
    assert.ok(stats);
    assert.ok(stats.totalMemories >= 1);
  });

  mem.close();
});
