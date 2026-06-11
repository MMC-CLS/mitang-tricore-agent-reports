/**
 * TriCore Agent - TICK并发处理器测试 (Phase 24)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TickConcurrency, TICK_SLOT_STATE, CIRCUIT_STATE } = require('../../src/bus/tick-concurrency');

test('TickConcurrency: 基本调度', async (t) => {
  const concurrency = new TickConcurrency({ concurrency: 2 });

  const result = await concurrency.schedule(
    { type: 'test', tickNumber: 1 },
    async (tick) => {
      await new Promise(r => setTimeout(r, 10));
      return { processed: true };
    }
  );

  assert.strictEqual(result.success, true);
  assert.ok(result.latency >= 0);

  concurrency.close();
});

test('TickConcurrency: 并发处理', async (t) => {
  const concurrency = new TickConcurrency({ concurrency: 3 });
  const order = [];

  const tasks = [1, 2, 3, 4, 5].map((i) =>
    concurrency.schedule(
      { type: 'test', tickNumber: i },
      async (tick) => {
        await new Promise(r => setTimeout(r, Math.random() * 50));
        order.push(tick.tickNumber);
      },
      { priority: i }
    )
  );

  await Promise.all(tasks);
  assert.strictEqual(order.length, 5);

  concurrency.close();
});

test('TickConcurrency: 断路器机制', async (t) => {
  const concurrency = new TickConcurrency({
    concurrency: 1,
    circuitBreakerThreshold: 2,
    circuitBreakerTimeout: 100,
  });

  // 触发两次失败
  for (let i = 0; i < 2; i++) {
    await concurrency.schedule(
      { type: 'test', tickNumber: i },
      async () => { throw new Error('fail'); }
    );
  }

  // 第三次应被拒绝
  const result = await concurrency.schedule(
    { type: 'test', tickNumber: 3 },
    async () => {}
  );

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'circuit_open');

  // 等待断路器超时恢复
  await new Promise(r => setTimeout(r, 150));

  const result2 = await concurrency.schedule(
    { type: 'test', tickNumber: 4 },
    async () => {}
  );

  assert.strictEqual(result2.success, true);

  concurrency.close();
});

test('TickConcurrency: 统计信息', async (t) => {
  const concurrency = new TickConcurrency({ concurrency: 2 });

  await concurrency.schedule({ type: 'test', tickNumber: 1 }, async () => {});
  await concurrency.schedule({ type: 'test', tickNumber: 2 }, async () => {});

  const stats = concurrency.getStats();
  assert.strictEqual(stats.totalProcessed, 2);
  assert.strictEqual(stats.concurrency, 2);
  assert.strictEqual(stats.circuitState, CIRCUIT_STATE.CLOSED);

  concurrency.close();
});

test('TickConcurrency: 队列满拒绝', async (t) => {
  const concurrency = new TickConcurrency({
    concurrency: 1,
    maxQueueSize: 1,
  });

  // 占用唯一槽位
  const processing = concurrency.schedule(
    { type: 'test', tickNumber: 0 },
    async () => { await new Promise(r => setTimeout(r, 200)); }
  );

  // 填满队列
  concurrency.schedule({ type: 'test', tickNumber: 1 }, async () => {});

  // 队列满应拒绝
  const result = await concurrency.schedule(
    { type: 'test', tickNumber: 2 },
    async () => {}
  );

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'queue_full');

  await processing;
  concurrency.close();
});

test('TickConcurrency: 优雅关闭', async (t) => {
  const concurrency = new TickConcurrency({ concurrency: 1 });

  const processing = concurrency.schedule(
    { type: 'test', tickNumber: 0 },
    async () => { await new Promise(r => setTimeout(r, 100)); }
  );

  await concurrency.drain();
  const result = await processing;
  assert.strictEqual(result.success, true);

  concurrency.close();
});
