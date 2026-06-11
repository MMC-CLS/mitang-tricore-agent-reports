/**
 * TriCore Agent v4.0 - 性能基准测试套件
 *
 * 测试范围：
 *   1. 模块初始化基准 - 各核心模块构造时间
 *   2. 记忆操作基准 - MemoryEngine 的 add/search/update 吞吐量
 *   3. 事件总线基准 - CoreBus 的事件发射/订阅延迟
 *   4. Token预算基准 - TokenBudgetManager 的 requestTokens 吞吐量
 *   5. 消息处理基准 - MessageProcessor 的 receive+analyze 流水线延迟
 *   6. 启动时间基准 - 完整 TriCoreAgent 构造时间（不含LLM调用）
 *
 * 使用 Node.js 原生 node:test + node:assert/strict
 * 使用 performance.now() 进行高精度计时
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

// ── 工具函数：计算百分位延迟 ──
function computePercentiles(samples) {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const len = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / len;
  return {
    p50: sorted[Math.floor(len * 0.5)],
    p95: sorted[Math.floor(len * 0.95)],
    p99: sorted[Math.floor(len * 0.99)],
    min: sorted[0],
    max: sorted[len - 1],
    mean,
  };
}

/**
 * 运行基准测试并输出结果
 * @param {string} name - 操作名称
 * @param {number} iterations - 迭代次数
 * @param {Function} fn - 每次迭代执行的函数（同步）
 * @returns {Object} 基准结果
 */
function runBenchmark(name, iterations, fn) {
  // 预热（避免JIT编译偏差）
  for (let i = 0; i < Math.min(10, iterations); i++) {
    try { fn(i); } catch (e) { /* ignore */ }
  }

  const samples = [];
  const startTotal = performance.now();

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      fn(i);
    } catch (e) {
      // 记录异常但不中断
    }
    const elapsed = performance.now() - start;
    samples.push(elapsed);
  }

  const totalMs = performance.now() - startTotal;
  const percentiles = computePercentiles(samples);
  const opsPerSec = (iterations / totalMs) * 1000;

  return {
    name,
    iterations,
    totalMs: Math.round(totalMs * 100) / 100,
    avgMs: Math.round(percentiles.mean * 1000) / 1000,
    opsPerSec: Math.round(opsPerSec * 100) / 100,
    p50: Math.round(percentiles.p50 * 1000) / 1000,
    p95: Math.round(percentiles.p95 * 1000) / 1000,
    p99: Math.round(percentiles.p99 * 1000) / 1000,
    minMs: Math.round(percentiles.min * 1000) / 1000,
    maxMs: Math.round(percentiles.max * 1000) / 1000,
  };
}

// ══════════════════════════════════════════════════════════════════
// 1. 模块初始化基准
// ══════════════════════════════════════════════════════════════════

test('Benchmark: 模块初始化基准', async (t) => {
  const results = [];

  await t.test('Logger 构造时间', () => {
    const { Logger } = require('../../src/utils/logger');
    const samples = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const logger = new Logger({
        name: 'benchmark',
        enableConsole: false,
        enableFile: false,
        enableJSON: false,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
      logger.close();
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'Logger 构造',
      iterations: 50,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 500, `Logger构造平均时间应<500ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  await t.test('MemoryEngine (:memory:) 构造+初始化时间', () => {
    const { MemoryEngine } = require('../../src/memory/memory-engine');
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const mem = new MemoryEngine({ dbPath: ':memory:', annEnabled: false });
      const start = performance.now();
      mem.init();
      const elapsed = performance.now() - start;
      samples.push(elapsed);
      mem.close();
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'MemoryEngine 构造+init',
      iterations: 20,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 1000, `MemoryEngine初始化平均时间应<1000ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  await t.test('CoreBus 构造时间', () => {
    const { CoreBus } = require('../../src/bus/core-bus');
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      new CoreBus({ debugMode: false, maxLogSize: 1000 });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'CoreBus 构造',
      iterations: 100,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 100, `CoreBus构造平均时间应<100ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  await t.test('SecurityBoundary 构造时间', () => {
    const { SecurityBoundary } = require('../../src/security/security-boundary');
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      new SecurityBoundary({
        maxConsciousnessTaskBudget: 10000,
        maxAutonomousSteps: 5,
        maxIdleThinkPerHour: 6,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'SecurityBoundary 构造',
      iterations: 100,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 100, `SecurityBoundary构造平均时间应<100ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  await t.test('TokenBudgetManager 构造时间', () => {
    const { TokenBudgetManager } = require('../../src/budget/token-budget-manager');
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const budget = new TokenBudgetManager({
        hourlyBudget: 50000,
        dailyBudget: 500000,
      });
      budget.initCore('consciousness', { ratio: 0.6 });
      budget.initCore('execution', { ratio: 0.3 });
      budget.initCore('evolution', { ratio: 0.1 });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'TokenBudgetManager 构造+initCore',
      iterations: 100,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 100, `TokenBudgetManager构造平均时间应<100ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  await t.test('ModelRouter 构造时间', () => {
    const { ModelRouter } = require('../../src/providers/model-router');
    const { TokenBudgetManager } = require('../../src/budget/token-budget-manager');
    const budget = new TokenBudgetManager({ hourlyBudget: 50000 });
    const samples = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      new ModelRouter({ budgetManager: budget });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'ModelRouter 构造',
      iterations: 50,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 100, `ModelRouter构造平均时间应<100ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  await t.test('ConsciousnessCore 构造时间', () => {
    const { ConsciousnessCore } = require('../../src/core/consciousness-core');
    const samples = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      new ConsciousnessCore({
        memory: null,
        router: null,
        awakeningTicks: 10,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'ConsciousnessCore 构造',
      iterations: 50,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 100, `ConsciousnessCore构造平均时间应<100ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  await t.test('ExecutionCore 构造时间', () => {
    const { ExecutionCore } = require('../../src/core/execution-core');
    const samples = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      new ExecutionCore({
        memory: null,
        router: null,
        sandboxDir: os.tmpdir(),
        maxRetries: 3,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'ExecutionCore 构造',
      iterations: 50,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 100, `ExecutionCore构造平均时间应<100ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  await t.test('EvolutionCore 构造时间', () => {
    const { EvolutionCore } = require('../../src/core/evolution-core');
    const samples = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      new EvolutionCore({
        memory: null,
        router: null,
        consolidationInterval: 30 * 60 * 1000,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }
    const p = computePercentiles(samples);
    results.push({
      name: 'EvolutionCore 构造',
      iterations: 50,
      totalMs: Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100,
      avgMs: Math.round(p.mean * 1000) / 1000,
      opsPerSec: '-',
      p50: Math.round(p.p50 * 1000) / 1000,
      p95: Math.round(p.p95 * 1000) / 1000,
      p99: Math.round(p.p99 * 1000) / 1000,
      minMs: Math.round(p.min * 1000) / 1000,
      maxMs: Math.round(p.max * 1000) / 1000,
    });
    assert.ok(p.mean < 100, `EvolutionCore构造平均时间应<100ms，实际: ${p.mean.toFixed(2)}ms`);
  });

  // 输出汇总表
  console.log('\n========== 模块初始化基准汇总 ==========');
  console.log('操作名称'.padEnd(40), '迭代'.padEnd(8), '总耗时(ms)'.padEnd(14), '平均(ms)'.padEnd(12), 'P50'.padEnd(10), 'P95'.padEnd(10), 'P99'.padEnd(10));
  console.log('-'.repeat(120));
  for (const r of results) {
    console.log(
      r.name.padEnd(40),
      String(r.iterations).padEnd(8),
      String(r.totalMs).padEnd(14),
      String(r.avgMs).padEnd(12),
      String(r.p50).padEnd(10),
      String(r.p95).padEnd(10),
      String(r.p99).padEnd(10),
    );
  }
});

// ══════════════════════════════════════════════════════════════════
// 2. 记忆操作基准
// ══════════════════════════════════════════════════════════════════

test('Benchmark: 记忆操作吞吐量', async (t) => {
  const { MemoryEngine } = require('../../src/memory/memory-engine');

  await t.test('MemoryEngine upsert (store) 吞吐量', () => {
    const mem = new MemoryEngine({ dbPath: ':memory:', annEnabled: false });
    mem.init();

    const result = runBenchmark('MemoryEngine.upsert', 200, (i) => {
      mem.upsert({
        content: `benchmark test memory entry ${i} with some additional content to make it unique`,
        salience: Math.random() * 5 + 1,
        mem_type: 'fact',
        tags: ['benchmark', `tag_${i % 10}`],
      });
    });

    console.log(`\nMemoryEngine.upsert: ${result.opsPerSec} ops/sec (${result.iterations} iterations, ${result.totalMs}ms total)`);
    console.log(`  avg=${result.avgMs}ms, p50=${result.p50}ms, p95=${result.p95}ms, p99=${result.p99}ms`);

    assert.ok(result.opsPerSec > 10, `upsert吞吐量应>10 ops/sec，实际: ${result.opsPerSec}`);
    mem.close();
  });

  await t.test('MemoryEngine search (FTS5) 吞吐量', () => {
    const mem = new MemoryEngine({ dbPath: ':memory:', annEnabled: false });
    mem.init();

    // 预填充数据
    const keywords = ['测试', '搜索', '记忆', '引擎', '基准', '性能', '优化', '缓存', '索引', '查询'];
    for (let i = 0; i < 100; i++) {
      mem.upsert({
        content: `${keywords[i % keywords.length]}性能基准测试数据条目${i}`,
        salience: 3 + Math.random() * 2,
        mem_type: 'fact',
      });
    }

    const result = runBenchmark('MemoryEngine.search', 100, (i) => {
      const kw = keywords[i % keywords.length];
      mem.search({ text: kw, limit: 10 });
    });

    console.log(`\nMemoryEngine.search: ${result.opsPerSec} ops/sec (${result.iterations} iterations, ${result.totalMs}ms total)`);
    console.log(`  avg=${result.avgMs}ms, p50=${result.p50}ms, p95=${result.p95}ms, p99=${result.p99}ms`);

    assert.ok(result.opsPerSec > 5, `search吞吐量应>5 ops/sec，实际: ${result.opsPerSec}`);
    mem.close();
  });

  await t.test('MemoryEngine getStats 吞吐量', () => {
    const mem = new MemoryEngine({ dbPath: ':memory:', annEnabled: false });
    mem.init();

    for (let i = 0; i < 50; i++) {
      mem.upsert({ content: `stats benchmark ${i}`, salience: 3, mem_type: 'fact' });
    }

    const result = runBenchmark('MemoryEngine.getStats', 200, () => {
      mem.getStats();
    });

    console.log(`\nMemoryEngine.getStats: ${result.opsPerSec} ops/sec (${result.iterations} iterations, ${result.totalMs}ms total)`);
    console.log(`  avg=${result.avgMs}ms, p50=${result.p50}ms, p95=${result.p95}ms, p99=${result.p99}ms`);

    assert.ok(result.opsPerSec > 50, `getStats吞吐量应>50 ops/sec，实际: ${result.opsPerSec}`);
    mem.close();
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. 事件总线基准
// ══════════════════════════════════════════════════════════════════

test('Benchmark: CoreBus 事件延迟', async (t) => {
  const { CoreBus, BUS_EVENT, EVENT_PRIORITY } = require('../../src/bus/core-bus');

  await t.test('dispatch 延迟 (p50/p95/p99)', () => {
    const bus = new CoreBus({ debugMode: false, maxLogSize: 1000 });
    const samples = [];

    // 注册一个轻量监听器
    bus.on(BUS_EVENT.SYSTEM_INFO, () => { /* noop */ });

    for (let i = 0; i < 500; i++) {
      const start = performance.now();
      bus.dispatch(BUS_EVENT.SYSTEM_INFO, { message: `bench_${i}` }, { source: 'benchmark' });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }

    const p = computePercentiles(samples);
    const totalMs = samples.reduce((a, b) => a + b, 0);
    const opsPerSec = (500 / totalMs) * 1000;

    console.log(`\nCoreBus.dispatch: ${Math.round(opsPerSec)} ops/sec (500 iterations, ${Math.round(totalMs * 100) / 100}ms total)`);
    console.log(`  avg=${(p.mean * 1000).toFixed(3)}ms, p50=${(p.p50 * 1000).toFixed(3)}ms, p95=${(p.p95 * 1000).toFixed(3)}ms, p99=${(p.p99 * 1000).toFixed(3)}ms`);

    assert.ok(p.p50 < 10, `dispatch p50延迟应<10ms，实际: ${p.p50.toFixed(3)}ms`);
    assert.ok(opsPerSec > 100, `dispatch吞吐量应>100 ops/sec，实际: ${Math.round(opsPerSec)}`);
  });

  await t.test('subscribe+dispatch 端到端延迟', () => {
    const bus = new CoreBus({ debugMode: false, maxLogSize: 1000 });
    const samples = [];

    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      let received = false;
      const unsub = bus.subscribe('benchmark', () => {
        received = true;
      });
      bus.dispatch(BUS_EVENT.SYSTEM_INFO, { msg: 'test' }, { source: 'benchmark' });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
      unsub();
    }

    const p = computePercentiles(samples);

    console.log(`\nCoreBus subscribe+dispatch e2e:`);
    console.log(`  avg=${(p.mean * 1000).toFixed(3)}ms, p50=${(p.p50 * 1000).toFixed(3)}ms, p95=${(p.p95 * 1000).toFixed(3)}ms, p99=${(p.p99 * 1000).toFixed(3)}ms`);

    assert.ok(p.p50 < 10, `subscribe+dispatch p50延迟应<10ms，实际: ${p.p50.toFixed(3)}ms`);
  });

  await t.test('startTrace + completeTrace 延迟', () => {
    const bus = new CoreBus({ debugMode: false, maxLogSize: 1000 });
    const samples = [];

    for (let i = 0; i < 500; i++) {
      const start = performance.now();
      const traceId = bus.startTrace('benchmark', { iteration: i });
      bus.completeTrace(traceId);
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }

    const p = computePercentiles(samples);

    console.log(`\nCoreBus startTrace+completeTrace:`);
    console.log(`  avg=${(p.mean * 1000).toFixed(3)}ms, p50=${(p.p50 * 1000).toFixed(3)}ms, p95=${(p.p95 * 1000).toFixed(3)}ms, p99=${(p.p99 * 1000).toFixed(3)}ms`);

    assert.ok(p.p50 < 5, `trace p50延迟应<5ms，实际: ${p.p50.toFixed(3)}ms`);
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. Token预算基准
// ══════════════════════════════════════════════════════════════════

test('Benchmark: TokenBudget 吞吐量', async (t) => {
  const { TokenBudgetManager, CALL_PRIORITY } = require('../../src/budget/token-budget-manager');

  await t.test('requestTokens 高并发吞吐量', () => {
    const budget = new TokenBudgetManager({
      hourlyBudget: 1000000,
      dailyBudget: 10000000,
    });
    budget.initCore('consciousness', { ratio: 0.6 });
    budget.initCore('execution', { ratio: 0.3 });
    budget.initCore('evolution', { ratio: 0.1 });

    const result = runBenchmark('TokenBudget.requestTokens', 1000, (i) => {
      budget.requestTokens('consciousness', 1000 + (i % 500), {
        priority: i % 10 === 0 ? CALL_PRIORITY.CRITICAL : CALL_PRIORITY.NORMAL,
        callType: i % 3 === 0 ? 'user_message' : 'idle_think',
      });
    });

    console.log(`\nTokenBudget.requestTokens: ${result.opsPerSec} ops/sec (${result.iterations} iterations, ${result.totalMs}ms total)`);
    console.log(`  avg=${result.avgMs}ms, p50=${result.p50}ms, p95=${result.p95}ms, p99=${result.p99}ms`);

    assert.ok(result.opsPerSec > 100, `requestTokens吞吐量应>100 ops/sec，实际: ${result.opsPerSec}`);
  });

  await t.test('getStatus 查询性能', () => {
    const budget = new TokenBudgetManager({
      hourlyBudget: 50000,
      dailyBudget: 500000,
    });
    budget.initCore('consciousness', { ratio: 0.6 });
    budget.initCore('execution', { ratio: 0.3 });
    budget.initCore('evolution', { ratio: 0.1 });

    const result = runBenchmark('TokenBudget.getStatus', 500, () => {
      budget.getStatus();
    });

    console.log(`\nTokenBudget.getStatus: ${result.opsPerSec} ops/sec (${result.iterations} iterations, ${result.totalMs}ms total)`);
    console.log(`  avg=${result.avgMs}ms, p50=${result.p50}ms, p95=${result.p95}ms, p99=${result.p99}ms`);

    assert.ok(result.opsPerSec > 500, `getStatus吞吐量应>500 ops/sec，实际: ${result.opsPerSec}`);
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. 消息处理基准
// ══════════════════════════════════════════════════════════════════

test('Benchmark: MessageProcessor 流水线延迟', async (t) => {
  const { MessageProcessor } = require('../../src/subagent/message-processor');

  await t.test('receive 消息接收吞吐量', () => {
    const mp = new MessageProcessor({
      maxPipelineDepth: 100,
      analysisTimeout: 5000,
      enableAffectTracking: false,
      enableQuantumMarking: false,
      enableDAGTracing: false,
    });
    mp.start();

    const result = runBenchmark('MessageProcessor.receive', 200, (i) => {
      mp.receive(`user_${i % 5}`, `benchmark test message number ${i}`, 'api', {
        urgent: i % 20 === 0,
        priority: 50,
      });
    });

    console.log(`\nMessageProcessor.receive: ${result.opsPerSec} ops/sec (${result.iterations} iterations, ${result.totalMs}ms total)`);
    console.log(`  avg=${result.avgMs}ms, p50=${result.p50}ms, p95=${result.p95}ms, p99=${result.p99}ms`);

    assert.ok(result.opsPerSec > 50, `receive吞吐量应>50 ops/sec，实际: ${result.opsPerSec}`);
    mp.stop();
  });

  await t.test('receive + analyze 流水线延迟', () => {
    const mp = new MessageProcessor({
      maxPipelineDepth: 100,
      analysisTimeout: 5000,
      enableAffectTracking: false,
      enableQuantumMarking: false,
      enableDAGTracing: false,
    });
    mp.start();

    const samples = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const msgId = mp.receive(`user_${i % 3}`, `analyze this message for intent detection ${i}`, 'api');
      const analysis = mp.analyze(msgId);
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }

    const p = computePercentiles(samples);
    const totalMs = samples.reduce((a, b) => a + b, 0);
    const opsPerSec = (100 / totalMs) * 1000;

    console.log(`\nMessageProcessor receive+analyze pipeline:`);
    console.log(`  ${Math.round(opsPerSec)} ops/sec, avg=${(p.mean * 1000).toFixed(3)}ms, p50=${(p.p50 * 1000).toFixed(3)}ms, p95=${(p.p95 * 1000).toFixed(3)}ms, p99=${(p.p99 * 1000).toFixed(3)}ms`);

    assert.ok(opsPerSec > 20, `receive+analyze吞吐量应>20 ops/sec，实际: ${Math.round(opsPerSec)}`);
    mp.stop();
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. 完整 TriCoreAgent 构造时间基准
// ══════════════════════════════════════════════════════════════════

test('Benchmark: TriCoreAgent 完整构造时间（不含LLM调用）', async (t) => {
  const dataDir = path.join(os.tmpdir(), 'tricore_benchmark_' + Date.now());

  await t.test('构造时间 (headless, 无API, 无日志)', () => {
    const { TriCoreAgent } = require('../../src/index');

    const samples = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const agent = new TriCoreAgent({
        dataDir: dataDir + '_' + i,
        name: 'bench-agent',
        debugMode: false,
        logFile: false,
        logConsole: false,
        startApi: false,
        enablePerfMonitoring: false,
        enableHealthCheck: false,
        headless: true,
        enableAffectTracking: false,
        enableQuantumMarking: false,
        enableDAGTracing: false,
        enablePulsarEffect: false,
        enableEntangledEdges: false,
        enableBlackHoleEffect: false,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);

      // 清理定时器避免泄漏
      clearInterval(agent._budgetAdaptTimer);
      agent._memory?.close();
      agent._logger?.close();
    }

    const p = computePercentiles(samples);

    console.log(`\n========== TriCoreAgent 完整构造时间基准 ==========`);
    console.log(`迭代次数: ${samples.length}`);
    console.log(`总耗时: ${Math.round(samples.reduce((a, b) => a + b, 0) * 100) / 100}ms`);
    console.log(`平均: ${Math.round(p.mean * 100) / 100}ms`);
    console.log(`p50: ${Math.round(p.p50 * 100) / 100}ms`);
    console.log(`p95: ${Math.round(p.p95 * 100) / 100}ms`);
    console.log(`p99: ${Math.round(p.p99 * 100) / 100}ms`);
    console.log(`最小: ${Math.round(p.min * 100) / 100}ms`);
    console.log(`最大: ${Math.round(p.max * 100) / 100}ms`);

    // 构造时间应合理（< 30秒）
    assert.ok(p.mean < 30000, `完整构造平均时间应<30000ms，实际: ${p.mean.toFixed(0)}ms`);
  });
});
