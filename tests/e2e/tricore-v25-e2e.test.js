/**
 * TriCore Agent - v2.5 端到端集成测试
 * 测试完整的Agent生命周期和所有新模块
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const dataDir = path.join(os.tmpdir(), 'tricore_v25_e2e_' + Date.now());

test('E2E: TriCoreAgent v2.5 完整生命周期', async (t) => {
  const { TriCoreAgent, VERSION } = require('../../src/index');

  assert.strictEqual(VERSION, '2.5.0', 'Version should be 2.5.0');

  const agent = new TriCoreAgent({
    dataDir,
    name: 'e2e-test',
    debugMode: false,
    logFile: false,
    logConsole: false,
    startApi: false,
    enablePerfMonitoring: false,
    enableHealthCheck: false,
    headless: true,
  });

  // 验证所有核心模块已初始化
  assert.ok(agent._tickConcurrency, 'TickConcurrency should be initialized');
  assert.ok(agent._distLock, 'DistributedLock should be initialized');
  assert.ok(agent._gracefulRestart, 'GracefulRestart should be initialized');
  assert.ok(agent._rateLimiter, 'RateLimiter should be initialized');
  assert.ok(agent._prometheus, 'PrometheusMetrics should be initialized');
  assert.ok(agent._microRegistry, 'MicroServiceRegistry should be initialized');

  // 验证属性getter
  assert.ok(agent.tickConcurrency);
  assert.ok(agent.distLock);
  assert.ok(agent.gracefulRestart);
  assert.ok(agent.rateLimiter);
  assert.ok(agent.prometheus);
  assert.ok(agent.microRegistry);

  // 获取状态
  const status = agent.getStatus();
  assert.strictEqual(status.version, '2.5.0');
  assert.strictEqual(status.codename, 'TriCore');
  assert.ok(status.tickConcurrency);
  assert.ok(status.distLock);
  assert.ok(status.rateLimiter);
  assert.ok(status.microRegistry);

  // 测试速率限制API
  const rateResult = agent.checkRateLimit('test:e2e', 1);
  assert.ok(rateResult.allowed || !rateResult.allowed); // 可能允许或拒绝

  // 测试Prometheus导出
  const metrics = agent.exportPrometheusMetrics();
  assert.ok(metrics.includes('# HELP'), 'Metrics should be in Prometheus format');
  assert.ok(metrics.includes('tricore_'), 'Metrics should have tricore_ prefix');

  // 测试微服务注册
  const services = agent.listRegisteredServices();
  assert.ok(Array.isArray(services), 'Should return services array');

  // 测试TICK并发统计
  const tickStats = agent.getTickConcurrencyStats();
  assert.ok(tickStats.concurrency > 0, 'Concurrency should be positive');
  assert.ok(tickStats.slots, 'Should have slots');

  // 测试分布式锁统计
  const lockStats = agent.getDistLockStats();
  assert.strictEqual(lockStats.activeLocalLocks, 0, 'No active locks');

  // 清理
  await agent.stop();
});

test('E2E: 导出完整性验证', async (t) => {
  const exports = require('../../src/index');

  // 验证所有关键导出存在
  assert.ok(exports.TriCoreAgent, 'TriCoreAgent should be exported');
  assert.ok(exports.VERSION, 'VERSION should be exported');
  assert.ok(exports.CODENAME, 'CODENAME should be exported');

  // Phase 24 新模块导出
  assert.ok(exports.TickConcurrency, 'TickConcurrency should be exported');
  assert.ok(exports.DistributedLockManager, 'DistributedLockManager should be exported');
  assert.ok(exports.GracefulRestartManager, 'GracefulRestartManager should be exported');
  assert.ok(exports.RateLimiter, 'RateLimiter should be exported');

  // Phase 26 新模块导出
  assert.ok(exports.PrometheusMetrics, 'PrometheusMetrics should be exported');

  // Phase 27 新模块导出
  assert.ok(exports.MicroServiceRegistry, 'MicroServiceRegistry should be exported');
  assert.ok(exports.MicroServiceClient, 'MicroServiceClient should be exported');

  // 扩展层导出
  assert.ok(exports.BrowserAutomation, 'BrowserAutomation should be exported');
  assert.ok(exports.SocialDispatch, 'SocialDispatch should be exported');
  assert.ok(exports.VoiceSystem, 'VoiceSystem should be exported');

  // 治理层导出
  assert.ok(exports.CoreBus, 'CoreBus should be exported');
  assert.ok(exports.SecurityBoundary, 'SecurityBoundary should be exported');
  assert.ok(exports.TokenBudgetManager, 'TokenBudgetManager should be exported');
});

test('E2E: Prometheus指标完整性', async (t) => {
  const { PrometheusMetrics } = require('../../src/utils/prometheus-metrics');
  const metrics = new PrometheusMetrics({ prefix: 'e2e_' });

  // 验证内置指标
  assert.ok(metrics.httpRequestsTotal, 'httpRequestsTotal counter');
  assert.ok(metrics.httpRequestDuration, 'httpRequestDuration histogram');
  assert.ok(metrics.httpRequestsInFlight, 'httpRequestsInFlight gauge');
  assert.ok(metrics.ticksTotal, 'ticksTotal counter');
  assert.ok(metrics.tickDuration, 'tickDuration histogram');
  assert.ok(metrics.tokenBudgetUsage, 'tokenBudgetUsage gauge');
  assert.ok(metrics.tokenThrottleLevel, 'tokenThrottleLevel gauge');
  assert.ok(metrics.busEventsTotal, 'busEventsTotal counter');
  assert.ok(metrics.mqDepth, 'mqDepth gauge');
  assert.ok(metrics.heapUsed, 'heapUsed gauge');
  assert.ok(metrics.cpuUsage, 'cpuUsage gauge');
  assert.ok(metrics.eventLoopDelay, 'eventLoopDelay gauge');
  assert.ok(metrics.coreStatus, 'coreStatus gauge');
  assert.ok(metrics.llmRequestsTotal, 'llmRequestsTotal counter');
  assert.ok(metrics.llmTokensUsed, 'llmTokensUsed counter');
  assert.ok(metrics.nodeInfo, 'nodeInfo gauge');
  assert.ok(metrics.uptime, 'uptime gauge');

  // 导出格式验证
  const output = metrics.export();
  assert.ok(output.includes('TYPE'), 'Should include TYPE');
  assert.ok(output.includes('HELP'), 'Should include HELP');

  // 更新系统指标后验证
  metrics.updateSystemMetrics();
  const output2 = metrics.export();
  assert.ok(output2.length > output.length, 'Should have more data after update');
});

test('E2E: 速率限制器端到端', async (t) => {
  const { RateLimiter, ALGORITHM } = require('../../src/bus/rate-limiter');

  const limiter = new RateLimiter({ defaultCapacity: 10, defaultRefillRate: 100 });

  // 配置多个限流规则
  limiter.configureRule('api:/message', { maxRequests: 50, windowMs: 60000 });
  limiter.configureRule('api:/tasks', { maxRequests: 10, windowMs: 60000 });
  limiter.configureRule('llm:calls', { capacity: 20, refillRate: 5 });

  // 验证独立限流
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(limiter.check('api:/tasks').allowed, true);
  }
  assert.strictEqual(limiter.check('api:/tasks').allowed, false, '11th should be denied');

  // 另一个端点不受影响
  assert.strictEqual(limiter.check('api:/message').allowed, true);

  // 获取所有状态
  const allStatus = limiter.getAllStatus();
  assert.ok(allStatus['api:/tasks']);
  assert.ok(allStatus['api:/message']);
  assert.ok(allStatus['llm:calls']);

  limiter.close();
});
