/**
 * TriCore Agent - 速率限制器测试 (Phase 24)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RateLimiter, ALGORITHM } = require('../../src/bus/rate-limiter');

test('RateLimiter: 令牌桶算法', async (t) => {
  const limiter = new RateLimiter({
    algorithm: ALGORITHM.TOKEN_BUCKET,
    defaultCapacity: 10,
    defaultRefillRate: 100, // 快速补充
  });

  limiter.configureRule('test', { capacity: 5, refillRate: 100 });

  // 前5次应该允许
  for (let i = 0; i < 5; i++) {
    const result = limiter.check('test');
    assert.strictEqual(result.allowed, true, `Request ${i} should be allowed`);
  }

  // 第6次应该拒绝
  const result = limiter.check('test');
  assert.strictEqual(result.allowed, false);
  assert.ok(result.retryAfter >= 0);

  limiter.close();
});

test('RateLimiter: 滑动窗口算法', async (t) => {
  const limiter = new RateLimiter({
    algorithm: ALGORITHM.SLIDING_WINDOW,
    defaultMaxRequests: 3,
    defaultWindowMs: 60000,
  });

  limiter.configureRule('slide', { algorithm: ALGORITHM.SLIDING_WINDOW, maxRequests: 3, windowMs: 60000 });

  assert.strictEqual(limiter.check('slide').allowed, true);
  assert.strictEqual(limiter.check('slide').allowed, true);
  assert.strictEqual(limiter.check('slide').allowed, true);
  assert.strictEqual(limiter.check('slide').allowed, false);

  limiter.close();
});

test('RateLimiter: 固定窗口算法', async (t) => {
  const limiter = new RateLimiter({
    algorithm: ALGORITHM.FIXED_WINDOW,
    defaultMaxRequests: 2,
    defaultWindowMs: 60000,
  });

  limiter.configureRule('fixed', { algorithm: ALGORITHM.FIXED_WINDOW, maxRequests: 2, windowMs: 60000 });

  assert.strictEqual(limiter.check('fixed').allowed, true);
  assert.strictEqual(limiter.check('fixed').allowed, true);
  assert.strictEqual(limiter.check('fixed').allowed, false);

  limiter.close();
});

test('RateLimiter: 多键独立限流', async (t) => {
  const limiter = new RateLimiter({ defaultCapacity: 3, defaultRefillRate: 100 });

  limiter.configureRule('key_a', { capacity: 3, refillRate: 100 });
  limiter.configureRule('key_b', { capacity: 3, refillRate: 100 });

  // 耗尽 key_a
  limiter.check('key_a');
  limiter.check('key_a');
  limiter.check('key_a');
  assert.strictEqual(limiter.check('key_a').allowed, false);

  // key_b 应该仍然可用
  assert.strictEqual(limiter.check('key_b').allowed, true);

  limiter.close();
});

test('RateLimiter: 状态查询', async (t) => {
  const limiter = new RateLimiter({ defaultCapacity: 10, defaultRefillRate: 100 });

  limiter.configureRule('status_test', { capacity: 10, refillRate: 100 });
  limiter.check('status_test');

  const status = limiter.getStatus('status_test');
  assert.ok(status.exists);
  assert.strictEqual(status.algorithm, ALGORITHM.TOKEN_BUCKET);

  limiter.close();
});

test('RateLimiter: 重置', async (t) => {
  const limiter = new RateLimiter({ defaultCapacity: 3, defaultRefillRate: 100 });

  limiter.configureRule('reset_test', { capacity: 3, refillRate: 100 });
  limiter.check('reset_test');
  limiter.check('reset_test');
  limiter.check('reset_test');

  assert.strictEqual(limiter.check('reset_test').allowed, false);

  limiter.reset('reset_test');
  limiter.configureRule('reset_test', { capacity: 3, refillRate: 100 });

  assert.strictEqual(limiter.check('reset_test').allowed, true);

  limiter.close();
});
