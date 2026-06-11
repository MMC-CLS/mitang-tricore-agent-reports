/**
 * TriCore Agent - 分布式锁测试 (Phase 24)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { DistributedLockManager, LOCK_TYPE } = require('../../src/bus/distributed-lock');

const dataDir = path.join(os.tmpdir(), 'tricore_lock_test_' + Date.now());

test('DistributedLockManager: 本地锁获取和释放', async (t) => {
  const lock = new DistributedLockManager({ dataDir, defaultTTL: 5000 });

  const result = await lock.acquire('test_key', { type: LOCK_TYPE.LOCAL, owner: 'test_owner' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.lockKey, 'test_key');

  // 同一所有者可重入
  const result2 = await lock.acquire('test_key', { type: LOCK_TYPE.LOCAL, owner: 'test_owner' });
  assert.strictEqual(result2.success, true);
  assert.strictEqual(result2.reentry, true);

  // 释放（第一次）
  const release1 = await lock.release('test_key', { type: LOCK_TYPE.LOCAL, owner: 'test_owner' });
  assert.strictEqual(release1.success, true);

  // 释放（第二次，完全释放）
  const release2 = await lock.release('test_key', { type: LOCK_TYPE.LOCAL, owner: 'test_owner' });
  assert.strictEqual(release2.success, true);

  lock.close();
});

test('DistributedLockManager: 锁互斥', async (t) => {
  const lock = new DistributedLockManager({ dataDir, defaultTTL: 5000 });

  await lock.acquire('exclusive_key', { type: LOCK_TYPE.LOCAL, owner: 'owner_a' });

  const result = await lock.acquire('exclusive_key', { type: LOCK_TYPE.LOCAL, owner: 'owner_b' });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'Lock held by another owner');

  await lock.release('exclusive_key', { type: LOCK_TYPE.LOCAL, owner: 'owner_a' });

  lock.close();
});

test('DistributedLockManager: 锁续期', async (t) => {
  const lock = new DistributedLockManager({ dataDir, defaultTTL: 1000 });

  await lock.acquire('renew_key', { type: LOCK_TYPE.LOCAL, owner: 'test' });

  const result = await lock.renew('renew_key', { type: LOCK_TYPE.LOCAL, owner: 'test', ttl: 30000 });
  assert.strictEqual(result.success, true);

  lock.close();
});

test('DistributedLockManager: 统计信息', async (t) => {
  const lock = new DistributedLockManager({ dataDir });

  await lock.acquire('key1', { type: LOCK_TYPE.LOCAL, owner: 'test' });
  await lock.acquire('key2', { type: LOCK_TYPE.LOCAL, owner: 'test' });

  const stats = lock.getStats();
  assert.strictEqual(stats.activeLocalLocks, 2);

  await lock.release('key1', { owner: 'test' });
  await lock.release('key2', { owner: 'test' });

  const stats2 = lock.getStats();
  assert.strictEqual(stats2.activeLocalLocks, 0);

  lock.close();
});

test('DistributedLockManager: 文件锁', async (t) => {
  const lock = new DistributedLockManager({ dataDir });

  const result = await lock.acquire('file_key', {
    type: LOCK_TYPE.FILE,
    owner: 'test',
    ttl: 5000,
  });
  assert.strictEqual(result.success, true);

  // 同一文件锁不能被其他所有者获取
  const result2 = await lock.acquire('file_key', {
    type: LOCK_TYPE.FILE,
    owner: 'other',
    ttl: 5000,
  });
  assert.strictEqual(result2.success, false);

  await lock.release('file_key', { type: LOCK_TYPE.FILE, owner: 'test' });

  lock.close();
});
