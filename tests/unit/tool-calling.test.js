/**
 * ToolCallingEngine 单元测试
 * Phase 20: 工具调用引擎测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ToolCallingEngine, TOOL_CALL_STATUS, TOOL_CALL_MODE, PARAM_TYPE } = require('../../src/llm/tool-calling-engine');

test('ToolCallingEngine - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const engine = new ToolCallingEngine();
    assert.ok(engine);
    assert.strictEqual(engine._tools.size, 0);
  });

  await t.test('自定义配置', () => {
    const engine = new ToolCallingEngine({
      maxRetries: 5,
      defaultTimeout: 60000,
      cacheTTL: 600000,
    });
    assert.strictEqual(engine._maxRetries, 5);
    assert.strictEqual(engine._defaultTimeout, 60000);
  });
});

test('ToolCallingEngine - 工具注册', async (t) => {
  const engine = new ToolCallingEngine();

  await t.test('注册单个工具', () => {
    engine.registerTool({
      name: 'get_weather',
      description: '获取天气信息',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名称' },
        },
        required: ['city'],
      },
      handler: async (args) => ({ city: args.city, temp: 25, weather: '晴' }),
    });
    assert.strictEqual(engine._tools.size, 1);
    assert.ok(engine._tools.has('get_weather'));
  });

  await t.test('批量注册工具', () => {
    engine.registerTools([
      {
        name: 'search_web',
        description: '搜索网页',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        handler: async (args) => ({ results: [`Result for: ${args.query}`] }),
      },
      {
        name: 'read_file',
        description: '读取文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        handler: async (args) => ({ content: `Content of ${args.path}` }),
      },
    ]);
    assert.strictEqual(engine._tools.size, 3);
  });

  await t.test('重复注册覆盖', () => {
    engine.registerTool({
      name: 'get_weather',
      description: '获取天气信息（新版本）',
      handler: async () => ({ temp: 30 }),
    });
    const tool = engine._tools.get('get_weather');
    assert.ok(tool.definition.function.description.includes('新版本'));
  });
});

test('ToolCallingEngine - 工具定义', async (t) => {
  const engine = new ToolCallingEngine();
  engine.registerTool({
    name: 'test_tool',
    description: '测试工具',
    handler: async () => ({}),
  });

  await t.test('获取全部工具定义', () => {
    const defs = engine.getToolDefinitions();
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].type, 'function');
    assert.strictEqual(defs[0].function.name, 'test_tool');
  });

  await t.test('按名称过滤', () => {
    engine.registerTool({
      name: 'another_tool',
      description: '另一个工具',
      handler: async () => ({}),
    });
    const defs = engine.getToolDefinitions(['test_tool']);
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].function.name, 'test_tool');
  });

  await t.test('列出工具', () => {
    const tools = engine.listTools();
    assert.strictEqual(tools.length, 2);
    assert.ok(tools.find(t => t.name === 'test_tool'));
  });
});

test('ToolCallingEngine - 工具执行', async (t) => {
  const engine = new ToolCallingEngine();
  engine.registerTool({
    name: 'add',
    description: '加法运算',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    handler: async (args) => ({ result: args.a + args.b }),
  });

  await t.test('成功执行', async () => {
    const result = await engine.execute({
      function: { name: 'add', arguments: JSON.stringify({ a: 1, b: 2 }) },
    });
    assert.strictEqual(result.status, TOOL_CALL_STATUS.SUCCESS);
    assert.strictEqual(result.result.result, 3);
  });

  await t.test('未知工具', async () => {
    const result = await engine.execute({
      function: { name: 'unknown_tool', arguments: '{}' },
    });
    assert.strictEqual(result.status, TOOL_CALL_STATUS.FAILED);
    assert.ok(result.error.includes('Unknown tool'));
  });

  await t.test('无效参数', async () => {
    const result = await engine.execute({
      function: { name: 'add', arguments: 'invalid json' },
    });
    assert.strictEqual(result.status, TOOL_CALL_STATUS.FAILED);
  });
});

test('ToolCallingEngine - 并行执行', async (t) => {
  const engine = new ToolCallingEngine();
  engine.registerTool({
    name: 'fast_tool',
    description: '快速工具',
    handler: async () => ({ done: true }),
  });
  engine.registerTool({
    name: 'slow_tool',
    description: '慢速工具',
    handler: async () => {
      await new Promise(r => setTimeout(r, 50));
      return { done: true };
    },
  });

  await t.test('并行执行多个工具', async () => {
    const results = await engine.executeParallel([
      { id: '1', function: { name: 'fast_tool', arguments: '{}' } },
      { id: '2', function: { name: 'slow_tool', arguments: '{}' } },
    ]);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].status, TOOL_CALL_STATUS.SUCCESS);
    assert.strictEqual(results[1].status, TOOL_CALL_STATUS.SUCCESS);
  });
});

test('ToolCallingEngine - 顺序执行', async (t) => {
  const engine = new ToolCallingEngine();
  let executionOrder = [];

  engine.registerTool({
    name: 'step1',
    description: '步骤1',
    handler: async () => { executionOrder.push(1); return { step: 1 }; },
  });
  engine.registerTool({
    name: 'step2',
    description: '步骤2',
    handler: async () => { executionOrder.push(2); return { step: 2 }; },
  });

  await t.test('顺序执行', async () => {
    executionOrder = [];
    const results = await engine.executeSequential([
      { id: '1', function: { name: 'step1', arguments: '{}' } },
      { id: '2', function: { name: 'step2', arguments: '{}' } },
    ]);
    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(executionOrder, [1, 2]);
  });
});

test('ToolCallingEngine - 缓存', async (t) => {
  const engine = new ToolCallingEngine({ cacheTTL: 60000 });
  let callCount = 0;

  engine.registerTool({
    name: 'idempotent_tool',
    description: '幂等工具',
    handler: async () => { callCount++; return { value: 42 }; },
    schema: { idempotent: true },
  });

  await t.test('缓存命中', async () => {
    callCount = 0;
    // 第一次调用
    await engine.execute({ function: { name: 'idempotent_tool', arguments: '{}' } });
    assert.strictEqual(callCount, 1);
    // 第二次应该命中缓存
    await engine.execute({ function: { name: 'idempotent_tool', arguments: '{}' } });
    assert.strictEqual(callCount, 1); // 没再调用handler
  });

  await t.test('清除缓存', () => {
    engine.clearCache();
    assert.strictEqual(engine._resultCache.size, 0);
  });
});

test('ToolCallingEngine - 关键词匹配', async (t) => {
  const engine = new ToolCallingEngine();
  engine.registerTool({
    name: 'get_weather',
    description: '获取指定城市的天气信息',
    handler: async () => ({}),
  });
  engine.registerTool({
    name: 'search_web',
    description: '在互联网上搜索信息',
    handler: async () => ({}),
  });

  await t.test('关键词匹配', async () => {
    const tools = await engine.selectTools('天气', 3);
    assert.ok(tools.length > 0);
  });

  await t.test('搜索意图匹配', async () => {
    const tools = await engine.selectTools('搜索', 3);
    assert.ok(tools.length > 0);
  });
});

test('ToolCallingEngine - 统计', async (t) => {
  const engine = new ToolCallingEngine();
  engine.registerTool({
    name: 'test',
    description: 'test',
    handler: async () => ({ ok: true }),
  });

  await t.test('getStats', async () => {
    await engine.execute({ function: { name: 'test', arguments: '{}' } });
    const stats = engine.getStats();
    assert.ok(stats.totalCalls >= 1);
    assert.ok(stats.toolsRegistered >= 1);
  });
});
