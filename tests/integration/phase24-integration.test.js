/**
 * TriCore Agent - Phase 24 集成测试
 * 测试 TICK并发 + 分布式锁 + 优雅重启 + 速率限制 的协同工作
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const dataDir = path.join(os.tmpdir(), 'tricore_phase24_test_' + Date.now());

test('Phase 24: TICK并发 + 分布式锁协同', async (t) => {
  const { TickConcurrency } = require('../../src/bus/tick-concurrency');
  const { DistributedLockManager, LOCK_TYPE } = require('../../src/bus/distributed-lock');

  const concurrency = new TickConcurrency({ concurrency: 3 });
  const distLock = new DistributedLockManager({ dataDir, defaultTTL: 5000 });

  const processed = [];

  // 模拟多个TICK并发处理，每个TICK获取分布式锁
  const tasks = [1, 2, 3, 4, 5].map((i) =>
    concurrency.schedule(
      { type: 'integration_test', tickNumber: i },
      async (tick) => {
        const lockResult = await distLock.acquire(`resource_${i % 2}`, {
          type: LOCK_TYPE.LOCAL,
          owner: `tick_${i}`,
          ttl: 1000,
        });

        await new Promise(r => setTimeout(r, 20));
        processed.push(tick.tickNumber);

        if (lockResult.success) {
          await distLock.release(`resource_${i % 2}`, {
            type: LOCK_TYPE.LOCAL,
            owner: `tick_${i}`,
          });
        }
      }
    )
  );

  await Promise.all(tasks);
  assert.strictEqual(processed.length, 5);

  concurrency.close();
  distLock.close();
});

test('Phase 24: 速率限制 + TICK并发协同', async (t) => {
  const { TickConcurrency } = require('../../src/bus/tick-concurrency');
  const { RateLimiter, ALGORITHM } = require('../../src/bus/rate-limiter');

  const concurrency = new TickConcurrency({ concurrency: 2 });
  const rateLimiter = new RateLimiter({
    algorithm: ALGORITHM.FIXED_WINDOW,
    defaultCapacity: 3,
    defaultWindowMs: 60000,
  });

  rateLimiter.configureRule('tick:processing', { capacity: 3, windowMs: 60000 });

  let processedCount = 0;
  let skippedCount = 0;

  const tasks = [1, 2, 3, 4, 5, 6].map((i) =>
    concurrency.schedule(
      { type: 'rate_limited', tickNumber: i },
      async (tick) => {
        const rateCheck = rateLimiter.check('tick:processing');
        if (!rateCheck.allowed) {
          skippedCount++;
          return;
        }
        processedCount++;
        await new Promise(r => setTimeout(r, 10));
      }
    )
  );

  await Promise.all(tasks);

  assert.strictEqual(processedCount, 3);
  assert.strictEqual(skippedCount, 3);

  concurrency.close();
  rateLimiter.close();
});

test('Phase 24: 断路器恢复流程', async (t) => {
  const { TickConcurrency } = require('../../src/bus/tick-concurrency');

  const concurrency = new TickConcurrency({
    concurrency: 1,
    circuitBreakerThreshold: 3,
    circuitBreakerTimeout: 100,
  });

  // 触发3次失败
  for (let i = 0; i < 3; i++) {
    await concurrency.schedule(
      { type: 'fail', tickNumber: i },
      async () => { throw new Error('test failure'); }
    );
  }

  const stats = concurrency.getStats();
  assert.strictEqual(stats.circuitState, 'open');

  // 等待恢复
  await new Promise(r => setTimeout(r, 150));

  // 半开状态应允许一次试探
  const result = await concurrency.schedule(
    { type: 'recover', tickNumber: 100 },
    async () => { /* success */ }
  );

  assert.strictEqual(result.success, true);

  concurrency.close();
});

test('Phase 24: 优雅重启管理器', async (t) => {
  const { GracefulRestartManager, SERVER_STATE } = require('../../src/bus/graceful-restart');

  const restart = new GracefulRestartManager({
    healthPort: 0, // 不启动HTTP服务
    warmupTime: 50,
  });

  await restart.start();
  assert.strictEqual(restart._warmupComplete, false);

  // 等待预热完成
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(restart._state, SERVER_STATE.RUNNING);

  // 测试请求追踪
  restart.trackRequestStart();
  assert.strictEqual(restart._activeRequests, 1);
  restart.trackRequestEnd();
  assert.strictEqual(restart._activeRequests, 0);

  restart.close();
});
