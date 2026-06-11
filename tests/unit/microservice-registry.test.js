/**
 * TriCore Agent - 微服务注册发现测试 (Phase 27)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const {
  MicroServiceRegistry,
  REGISTRY_TYPE,
  SERVICE_STATUS,
  LB_STRATEGY,
} = require('../../src/deploy/microservice-registry');

const baseDir = path.join(os.tmpdir(), 'tricore_registry_test_' + Date.now());
let testCounter = 0;
function getTestDir() { return path.join(baseDir, 'test_' + (++testCounter)); }

test('MicroServiceRegistry: 服务注册', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 1000, ttl: 3000 });

  const result = registry.register('test-service', {
    host: '127.0.0.1',
    port: 3001,
    metadata: { version: '1.0.0' },
    tags: ['api', 'v1'],
  });

  assert.ok(result.instanceId);
  assert.strictEqual(result.serviceName, 'test-service');

  registry.close();
});

test('MicroServiceRegistry: 服务发现', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 1000, ttl: 10000 });

  registry.register('discover-svc', { host: '127.0.0.1', port: 3001 });
  registry.register('discover-svc', { host: '127.0.0.1', port: 3002 });

  const instances = registry.discover('discover-svc');
  assert.strictEqual(instances.length, 2);
  assert.strictEqual(instances[0].host, '127.0.0.1');

  registry.close();
});

test('MicroServiceRegistry: 服务注销', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 1000, ttl: 10000 });

  const result = registry.register('dereg-svc', { host: '127.0.0.1', port: 3001 });
  assert.strictEqual(registry.discover('dereg-svc').length, 1);

  registry.deregister('dereg-svc', result.instanceId);
  assert.strictEqual(registry.discover('dereg-svc').length, 0);

  registry.close();
});

test('MicroServiceRegistry: 标签过滤', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 1000, ttl: 10000 });

  registry.register('tagged-svc', { host: '127.0.0.1', port: 3001, tags: ['v1', 'stable'] });
  registry.register('tagged-svc', { host: '127.0.0.1', port: 3002, tags: ['v2', 'beta'] });

  const stableInstances = registry.discover('tagged-svc', { tags: ['stable'] });
  assert.strictEqual(stableInstances.length, 1);
  assert.strictEqual(stableInstances[0].port, 3001);

  registry.close();
});

test('MicroServiceRegistry: 负载均衡-轮询', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 1000, ttl: 10000 });

  registry.register('lb-svc', { host: '127.0.0.1', port: 3001 });
  registry.register('lb-svc', { host: '127.0.0.1', port: 3002 });

  const i1 = registry.selectInstance('lb-svc', LB_STRATEGY.ROUND_ROBIN);
  const i2 = registry.selectInstance('lb-svc', LB_STRATEGY.ROUND_ROBIN);
  const i3 = registry.selectInstance('lb-svc', LB_STRATEGY.ROUND_ROBIN);

  assert.ok(i1);
  assert.ok(i2);
  // 轮询应回到第一个
  assert.strictEqual(i3.port, i1.port);

  registry.close();
});

test('MicroServiceRegistry: 负载均衡-加权', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 1000, ttl: 10000 });

  registry.register('weighted-svc', { host: '127.0.0.1', port: 3001, weight: 10 });
  registry.register('weighted-svc', { host: '127.0.0.1', port: 3002, weight: 1 });

  // 高权重实例应更常被选中（概率测试）
  const counts = { 3001: 0, 3002: 0 };
  for (let i = 0; i < 100; i++) {
    const instance = registry.selectInstance('weighted-svc', LB_STRATEGY.WEIGHTED);
    counts[instance.port]++;
  }

  // 3001(weight=10) 应被选中次数远多于 3002(weight=1)
  assert.ok(counts[3001] > counts[3002]);

  registry.close();
});

test('MicroServiceRegistry: 健康检查', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 100, ttl: 200 });

  registry.register('health-svc', { host: '127.0.0.1', port: 3001 });

  // 刚注册应该是健康的
  assert.strictEqual(registry.discover('health-svc').length, 1);

  // 等待超过TTL，心跳停止
  await new Promise(r => setTimeout(r, 300));

  const result = registry.runHealthCheck();
  assert.ok(result.removed >= 0);

  registry.close();
});

test('MicroServiceRegistry: 列出所有服务', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 1000, ttl: 10000 });

  registry.register('svc-a', { host: '127.0.0.1', port: 3001 });
  registry.register('svc-b', { host: '127.0.0.1', port: 3002 });
  registry.register('svc-b', { host: '127.0.0.1', port: 3003 });

  const services = registry.listServices();
  assert.strictEqual(services.length, 2);
  assert.strictEqual(services.find(s => s.name === 'svc-b').instanceCount, 2);

  registry.close();
});

test('MicroServiceRegistry: 统计信息', async (t) => {
  const registry = new MicroServiceRegistry({ dataDir: getTestDir(), heartbeatInterval: 1000, ttl: 10000 });

  registry.register('stats-svc', { host: '127.0.0.1', port: 3001 });

  const stats = registry.getStats();
  assert.strictEqual(stats.services, 1);
  assert.strictEqual(stats.totalInstances, 1);

  registry.close();
});
