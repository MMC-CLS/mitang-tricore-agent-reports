/**
 * TriCore Agent - API速率限制器测试 (v1.0 QA)
 *
 * 测试 ApiServer 内置的令牌桶速率限制功能。
 * 通过构造模拟请求对象验证限流逻辑。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// 直接引用 ApiServer 类
const { ApiServer } = require('../../src/api/api-server');

test('API速率限制: 令牌桶初始状态允许请求', async (t) => {
  const server = new ApiServer({
    port: 0, // 不启动实际服务器
    host: '127.0.0.1',
    rateLimitEnabled: true,
    rateLimitPerMinute: 60,
    rateLimitBurst: 10,
  });

  const clientId = 'test-client-1';
  const result = server._checkRateLimit(clientId);

  assert.strictEqual(result.allowed, true, '首次请求应被允许');
  assert.ok(result.remaining > 0, '应有剩余令牌');
  assert.ok(result.remaining <= 70, '剩余令牌不应超过桶容量(60+10)');
});

test('API速率限制: 令牌耗尽后拒绝请求', async (t) => {
  const server = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    rateLimitEnabled: true,
    rateLimitPerMinute: 5,
    rateLimitBurst: 0,
  });

  const clientId = 'test-client-deplete';

  // 消耗所有5个令牌
  for (let i = 0; i < 5; i++) {
    const result = server._checkRateLimit(clientId);
    assert.strictEqual(result.allowed, true, `第${i + 1}次请求应被允许`);
  }

  // 第6次应被拒绝
  const denied = server._checkRateLimit(clientId);
  assert.strictEqual(denied.allowed, false, '令牌耗尽后应拒绝请求');
  assert.strictEqual(denied.remaining, 0, '剩余令牌应为0');
  assert.ok(denied.retryAfterSeconds > 0, '应提供重试等待时间');
});

test('API速率限制: 多客户端独立限流', async (t) => {
  const server = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    rateLimitEnabled: true,
    rateLimitPerMinute: 3,
    rateLimitBurst: 0,
  });

  // 耗尽 client-a
  for (let i = 0; i < 3; i++) {
    server._checkRateLimit('client-a');
  }
  assert.strictEqual(server._checkRateLimit('client-a').allowed, false, 'client-a应被限流');

  // client-b 应不受影响
  assert.strictEqual(server._checkRateLimit('client-b').allowed, true, 'client-b不应受影响');
  assert.strictEqual(server._checkRateLimit('client-b').allowed, true, 'client-b第2次仍应允许');
});

test('API速率限制: 速率限制可禁用', async (t) => {
  const server = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    rateLimitEnabled: false,
    rateLimitPerMinute: 1,
    rateLimitBurst: 0,
  });

  // 当 rateLimitEnabled=false 时，_checkRateLimit 不应被 _handleRequest 调用
  // 验证构造器正确存储了该配置
  assert.strictEqual(server._rateLimitEnabled, false, '速率限制应被禁用');

  // 即使直接调用 _checkRateLimit（绕过 _handleRequest 的门控），
  // 桶仍会按配置工作 — 这是底层行为，实际API请求不会经过此路径
  const clientId = 'test-client-disabled-direct';
  const result = server._checkRateLimit(clientId);
  // 底层桶仍然工作，但实际HTTP请求处理会先检查 _rateLimitEnabled
  assert.strictEqual(result.allowed, true, '首次直接调用应允许');
});

test('API速率限制: 默认不信任X-Forwarded-For', async (t) => {
  const server = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    trustProxy: false,
  });

  const mockReq = {
    socket: { remoteAddress: '192.168.1.100' },
    headers: {
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
    },
  };

  const clientId = server._getRateLimitClientId(mockReq);
  assert.strictEqual(clientId, '192.168.1.100', '不应信任X-Forwarded-For，应使用socket.remoteAddress');
});

test('API速率限制: 信任代理时使用X-Forwarded-For', async (t) => {
  const server = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    trustProxy: true,
  });

  const mockReq = {
    socket: { remoteAddress: '10.0.0.1' },
    headers: {
      'x-forwarded-for': '203.0.113.1, 198.51.100.2',
    },
  };

  const clientId = server._getRateLimitClientId(mockReq);
  assert.strictEqual(clientId, '198.51.100.2', '应取X-Forwarded-For最后一个IP');
});

test('API速率限制: 清理过期令牌桶', async (t) => {
  const server = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    rateLimitEnabled: true,
    rateLimitPerMinute: 60,
  });

  // 创建一个活动客户端
  server._checkRateLimit('active-client');

  // 创建一个"过期"的客户端（手动设置lastRefill为很久以前）
  server._rateLimitBuckets.set('stale-client', {
    tokens: 50,
    lastRefill: Date.now() - 20 * 60 * 1000, // 20分钟前
    windowStart: Date.now() - 20 * 60 * 1000,
  });

  assert.ok(server._rateLimitBuckets.has('stale-client'), '过期客户端应在清理前存在');

  server._cleanupRateLimitBuckets();

  assert.ok(!server._rateLimitBuckets.has('stale-client'), '过期客户端应被清理');
  assert.ok(server._rateLimitBuckets.has('active-client'), '活跃客户端不应被清理');
});
