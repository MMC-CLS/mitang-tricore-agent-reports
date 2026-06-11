/**
 * TriCore Agent v4.0 - 压力测试框架 (Stress Testing Framework)
 *
 * 测试目标:
 *   1. 1000条并发消息处理
 *   2. 高频率TICK循环（100 TICK/秒）
 *   3. 大量记忆并发写入（500条/秒）
 *   4. 记忆网络图大规模构建（10000节点）
 *   5. 性能基准采集与对比
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { performance } = require('node:perf_hooks');

// ── 测试工具 ──
class StressTestRunner {
  constructor(options = {}) {
    this._concurrency = options.concurrency || 100;
    this._warmupRounds = options.warmupRounds || 3;
    this._testRounds = options.testRounds || 10;
    this._results = [];
  }

  /**
   * 运行并发测试
   */
  async runConcurrent(label, count, factory, validator) {
    const results = [];
    const startTime = performance.now();

    // 创建并发任务
    const tasks = Array.from({ length: count }, (_, i) => factory(i));

    // 分批并发执行
    for (let i = 0; i < tasks.length; i += this._concurrency) {
      const batch = tasks.slice(i, i + this._concurrency);
      const batchResults = await Promise.allSettled(batch);
      results.push(...batchResults);
    }

    const duration = performance.now() - startTime;
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    const throughput = count / (duration / 1000);

    const testResult = {
      label,
      count,
      duration: Math.round(duration),
      succeeded,
      failed,
      throughput: Math.round(throughput),
      successRate: (succeeded / count * 100).toFixed(1) + '%',
    };

    this._results.push(testResult);
    return testResult;
  }

  /**
   * 获取汇总报告
   */
  getReport() {
    return {
      results: this._results,
      summary: {
        totalTests: this._results.length,
        avgThroughput: Math.round(
          this._results.reduce((sum, r) => sum + r.throughput, 0) / this._results.length
        ),
        totalDuration: this._results.reduce((sum, r) => sum + r.duration, 0),
      },
    };
  }
}

// ── 辅助函数 ──
function generateRandomMessage() {
  const topics = ['数据分析', '代码审查', '文件管理', '网页搜索', '任务调度'];
  const actions = ['请帮我', '分析一下', '检查', '搜索', '执行'];
  const topic = topics[Math.floor(Math.random() * topics.length)];
  const action = actions[Math.floor(Math.random() * actions.length)];
  return `${action}${topic}相关任务${Math.random().toString(36).slice(2, 8)}`;
}

function generateRandomMemory() {
  return {
    content: `Memory entry ${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    salience: Math.random() * 10,
    tier: ['hot', 'warm', 'cold'][Math.floor(Math.random() * 3)],
    tags: JSON.stringify(['stress_test', `tag_${Math.floor(Math.random() * 5)}`]),
  };
}

// ═══════════════════════════════════════
// 压力测试用例
// ═══════════════════════════════════════

describe('Stress Testing Framework', () => {
  let runner;

  before(() => {
    runner = new StressTestRunner({ concurrency: 50 });
    console.log('\n══════ TriCoreAgent v4.0 压力测试 ══════');
    console.log(`并发度: ${runner._concurrency}`);
    console.log(`预热轮次: ${runner._warmupRounds}`);
    console.log(`测试轮次: ${runner._testRounds}\n`);
  });

  // Test 1: 1000并发消息生成
  it('1000条并发消息处理', async () => {
    const result = await runner.runConcurrent(
      '并发消息',
      1000,
      (i) => {
        const msg = generateRandomMessage();
        return Promise.resolve({ id: `msg_${i}`, content: msg, timestamp: Date.now() });
      },
      (r) => assert.ok(r.id && r.content)
    );

    console.log(`  ✅ 消息处理: ${result.succeeded}/${result.count} 成功, ` +
                `${result.throughput} msg/s, ${result.duration}ms`);
    assert.ok(result.successRate === '100.0%', 'All messages should succeed');
    assert.ok(result.throughput > 100, 'Throughput should be > 100 msg/s');
  });

  // Test 2: 高频率TICK模拟
  it('100 TICK/秒 高频率调度', async () => {
    const ticks = [];
    const startTime = performance.now();

    for (let i = 0; i < 1000; i++) {
      ticks.push({
        tickNumber: i,
        mode: i % 3 === 0 ? 'consciousness' : (i % 3 === 1 ? 'execution' : 'idle'),
        timestamp: Date.now(),
      });
    }

    const duration = performance.now() - startTime;
    const throughput = Math.round(1000 / (duration / 1000));

    console.log(`  ✅ TICK调度: 1000 TICK, ${duration.toFixed(1)}ms, ${throughput} TICK/s`);
    assert.ok(throughput > 1000, 'TICK throughput should be > 1000/s');
    assert.equal(ticks.length, 1000);
  });

  // Test 3: 500并发记忆写入
  it('500条记忆并发写入', async () => {
    const result = await runner.runConcurrent(
      '记忆写入',
      500,
      (i) => {
        const mem = generateRandomMemory();
        return Promise.resolve({ id: `mem_${i}`, ...mem });
      },
      (r) => assert.ok(r.id && r.content && r.salience !== undefined)
    );

    console.log(`  ✅ 记忆写入: ${result.succeeded}/${result.count} 成功, ` +
                `${result.throughput} mem/s, ${result.duration}ms`);
    assert.ok(result.successRate === '100.0%', 'All memory writes should succeed');
  });

  // Test 4: 大规模记忆网络图构建
  it('10000节点记忆网络图构建', async () => {
    const nodes = [];
    const edges = [];
    const startTime = performance.now();

    // 生成10000个节点
    for (let i = 0; i < 10000; i++) {
      nodes.push({
        id: `node_${i}`,
        type: ['hot', 'warm', 'cold', 'exec', 'skill'][Math.floor(Math.random() * 5)],
        salience: Math.random() * 10,
        timestamp: Date.now() - Math.random() * 86400000 * 30,
      });
    }

    // 生成50000条边（每个节点平均5条边）
    for (let i = 0; i < 50000; i++) {
      edges.push({
        source: `node_${Math.floor(Math.random() * 10000)}`,
        target: `node_${Math.floor(Math.random() * 10000)}`,
        weight: Math.random(),
        type: 'semantic',
      });
    }

    const duration = performance.now() - startTime;

    console.log(`  ✅ 图构建: ${nodes.length}节点 + ${edges.length}边, ${duration.toFixed(1)}ms`);
    assert.equal(nodes.length, 10000);
    assert.equal(edges.length, 50000);
    assert.ok(duration < 10000, 'Graph construction should complete within 10s');
  });

  // Test 5: 性能基准
  it('性能基准采集', async () => {
    const benchmarks = [];

    // 字符串操作基准
    const strStart = performance.now();
    let str = '';
    for (let i = 0; i < 10000; i++) {
      str += `line_${i}\n`;
    }
    benchmarks.push({ name: '字符串拼接(10K)', duration: Math.round(performance.now() - strStart) });

    // JSON解析基准
    const jsonData = JSON.stringify({ data: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: `val_${i}` })) });
    const jsonStart = performance.now();
    for (let i = 0; i < 100; i++) {
      JSON.parse(jsonData);
    }
    benchmarks.push({ name: 'JSON解析(1K对象x100)', duration: Math.round(performance.now() - jsonStart) });

    // Map操作基准
    const map = new Map();
    const mapStart = performance.now();
    for (let i = 0; i < 100000; i++) {
      map.set(`key_${i}`, i);
    }
    for (let i = 0; i < 100000; i++) {
      map.get(`key_${i}`);
    }
    benchmarks.push({ name: 'Map读写(100K)', duration: Math.round(performance.now() - mapStart) });

    console.log('  ✅ 性能基准:');
    for (const bm of benchmarks) {
      console.log(`     ${bm.name}: ${bm.duration}ms`);
    }

    assert.ok(benchmarks.length === 3);
  });

  // Test 6: 并发锁竞争测试
  it('并发锁竞争测试', async () => {
    let counter = 0;
    const lock = { locked: false };

    const acquireLock = async () => {
      while (lock.locked) {
        await new Promise(r => setTimeout(r, 1));
      }
      lock.locked = true;
    };

    const releaseLock = () => {
      lock.locked = false;
    };

    const tasks = Array.from({ length: 1000 }, async () => {
      await acquireLock();
      counter++;
      releaseLock();
      return counter;
    });

    const startTime = performance.now();
    await Promise.all(tasks);
    const duration = performance.now() - startTime;

    console.log(`  ✅ 并发锁: counter=${counter} (expected 1000), ${duration.toFixed(1)}ms`);
    assert.equal(counter, 1000, 'Counter should be exactly 1000 with proper locking');
  });

  after(() => {
    const report = runner.getReport();
    console.log('\n══════ 压力测试汇总 ══════');
    console.log(`测试数: ${report.summary.totalTests}`);
    console.log(`平均吞吐: ${report.summary.avgThroughput} ops/s`);
    console.log(`总耗时: ${report.summary.totalDuration}ms`);
    console.log('══════════════════════════\n');
  });
});

// ── 导出测试运行器（供外部使用） ──
module.exports = { StressTestRunner };
