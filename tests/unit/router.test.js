/**
 * ModelRouter 单元测试
 * Phase 20: 多模型协同路由测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ModelRouter, MODEL_PURPOSE, PROVIDER_PRESETS, ROUTE_STRATEGY, MODEL_CAPABILITY } = require('../../src/providers/model-router');

test('ModelRouter - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const router = new ModelRouter();
    assert.ok(router);
    assert.strictEqual(router._strategy, ROUTE_STRATEGY.LAYER_OPTIMAL);
  });

  await t.test('自定义策略', () => {
    const router = new ModelRouter({ strategy: ROUTE_STRATEGY.CHEAPEST });
    assert.strictEqual(router._strategy, ROUTE_STRATEGY.CHEAPEST);
  });

  await t.test('集成配置', () => {
    const router = new ModelRouter({
      ensembleMinProviders: 3,
      ensembleStrategy: 'weighted',
    });
    assert.strictEqual(router._ensembleConfig.minProviders, 3);
    assert.strictEqual(router._ensembleConfig.strategy, 'weighted');
  });
});

test('ModelRouter - Provider管理', async (t) => {
  const router = new ModelRouter();

  await t.test('注册Provider', () => {
    router.registerProvider('deepseek', { apiKey: 'test-key' });
    assert.ok(router._providers.has('deepseek'));
    assert.strictEqual(router._activeProvider, 'deepseek');
  });

  await t.test('注册第二个Provider', () => {
    router.registerProvider('qwen', { apiKey: 'test-key-qwen' });
    assert.ok(router._providers.has('qwen'));
  });

  await t.test('设置活跃Provider', () => {
    router.setActiveProvider('qwen');
    assert.strictEqual(router._activeProvider, 'qwen');
  });

  await t.test('设置不存在的Provider', () => {
    assert.throws(() => {
      router.setActiveProvider('nonexistent');
    });
  });

  await t.test('Provider事件', () => {
    return new Promise((resolve) => {
      router.on('provider_registered', (data) => {
        assert.strictEqual(data.name, 'openai');
        resolve();
      });
      router.registerProvider('openai', { apiKey: 'test-openai' });
    });
  });
});

test('ModelRouter - 用途分配', async (t) => {
  const router = new ModelRouter();
  router.registerProvider('deepseek', { apiKey: 'key1' });
  router.registerProvider('qwen', { apiKey: 'key2' });

  await t.test('单个分配', () => {
    router.assignProvider('deepseek', MODEL_PURPOSE.CONSCIOUSNESS);
    const list = router._purposeProviders.get(MODEL_PURPOSE.CONSCIOUSNESS);
    assert.ok(list.includes('deepseek'));
  });

  await t.test('批量分配', () => {
    router.assignProviders({
      [MODEL_PURPOSE.EXECUTION]: 'qwen',
      [MODEL_PURPOSE.EVOLUTION]: 'qwen',
    });
    assert.ok(router._purposeProviders.get(MODEL_PURPOSE.EXECUTION).includes('qwen'));
    assert.ok(router._purposeProviders.get(MODEL_PURPOSE.EVOLUTION).includes('qwen'));
  });

  await t.test('未注册Provider分配报错', () => {
    assert.throws(() => {
      router.assignProvider('nonexistent', MODEL_PURPOSE.CONSCIOUSNESS);
    });
  });
});

test('ModelRouter - Fallback链', async (t) => {
  const router = new ModelRouter();
  router.registerProvider('deepseek', { apiKey: 'key1' });
  router.registerProvider('qwen', { apiKey: 'key2' });
  router.registerProvider('zhipu', { apiKey: 'key3' });

  await t.test('设置Fallback链', () => {
    router.setFallbackChain(['qwen', 'zhipu']);
    assert.deepStrictEqual(router._fallbackChain, ['qwen', 'zhipu']);
  });

  await t.test('自动过滤不存在的Provider', () => {
    router.setFallbackChain(['qwen', 'nonexistent', 'zhipu']);
    assert.deepStrictEqual(router._fallbackChain, ['qwen', 'zhipu']);
  });
});

test('ModelRouter - 能力池', async (t) => {
  const router = new ModelRouter();
  router.registerProvider('deepseek', { apiKey: 'key1' });
  router.registerProvider('openai', { apiKey: 'key2' });

  await t.test('能力池自动更新', () => {
    const toolCallProviders = router.getProvidersByCapability(MODEL_CAPABILITY.TOOL_CALL);
    assert.ok(toolCallProviders.includes('deepseek'));
  });

  await t.test('查询不存在的能力', () => {
    const result = router.getProvidersByCapability(MODEL_CAPABILITY.LONG_CONTEXT);
    assert.deepStrictEqual(result, []);
  });
});

test('ModelRouter - 路由链解析', async (t) => {
  const router = new ModelRouter();
  router.registerProvider('deepseek', { apiKey: 'key1' });
  router.registerProvider('qwen', { apiKey: 'key2' });
  router.assignProvider('qwen', MODEL_PURPOSE.CONSCIOUSNESS);

  await t.test('有专用Provider时优先', () => {
    const chain = router._resolveProviderChain(MODEL_PURPOSE.CONSCIOUSNESS);
    assert.strictEqual(chain[0], 'qwen');
  });

  await t.test('无专用Provider时使用活跃', () => {
    const chain = router._resolveProviderChain(MODEL_PURPOSE.EMBEDDING);
    assert.ok(chain.includes('deepseek'));
  });
});

test('ModelRouter - 成本感知', async (t) => {
  const router = new ModelRouter({ strategy: ROUTE_STRATEGY.CHEAPEST });
  router.registerProvider('deepseek', { apiKey: 'key1' });
  router.registerProvider('openai', { apiKey: 'key2' });

  await t.test('按成本排序', () => {
    const chain = router._resolveCheapestChain(MODEL_PURPOSE.CONSCIOUSNESS);
    assert.strictEqual(chain[0], 'deepseek'); // deepseek 更便宜
  });
});

test('ModelRouter - 状态查询', async (t) => {
  const router = new ModelRouter();
  router.registerProvider('deepseek', { apiKey: 'key1' });

  await t.test('getStatus', () => {
    const status = router.getStatus();
    assert.strictEqual(status.activeProvider, 'deepseek');
    assert.ok(status.providers.deepseek);
    assert.strictEqual(status.providers.deepseek.status, 'available');
  });

  await t.test('getPerformanceReport', () => {
    const report = router.getPerformanceReport();
    assert.ok(report.byProvider);
    assert.ok(report.byPurpose);
  });
});

test('ModelRouter - 自动探测', async (t) => {
  await t.test('自动探测（无Provider时注册custom）', async () => {
    const router = new ModelRouter();
    // 使用非标准 key 格式，确保不会匹配到预设
    const result = await router.autoDetect('x-custom-key-123', null);
    assert.strictEqual(result, 'custom');
    assert.ok(router._providers.has('custom'));
  });
});
