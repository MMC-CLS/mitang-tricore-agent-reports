'use strict';

const path = require('path');

const { ConfigSchemaValidator } = require('../config/config-schema-validator');
const { MessageQueueManager, OVERFLOW_STRATEGY } = require('../bus/message-queue-manager');
const { PerformanceMonitor } = require('../utils/performance-monitor');
const { TickConcurrency } = require('../bus/tick-concurrency');
const { DistributedLockManager } = require('../bus/distributed-lock');
const { GracefulRestartManager } = require('../bus/graceful-restart');
const { RateLimiter, ALGORITHM } = require('../bus/rate-limiter');
const { StartupSelfCheck } = require('../bus/startup-self-check');
const { PrometheusMetrics } = require('../utils/prometheus-metrics');
const { MicroServiceRegistry, REGISTRY_TYPE } = require('../deploy/microservice-registry');

const VERSION = '1.0.0';
const CODENAME = 'MitangTriCore';
const BRAND_NAME = '蜜糖 TriCore Agent';

/**
 * Bootstrap: 基础设施层
 *
 * 职责：
 *   ConfigValidator + MessageQueue + PerfMonitor + TickConcurrency +
 *   DistLock + GracefulRestart + RateLimiter + StartupSelfCheck +
 *   Prometheus + MicroRegistry
 */

/**
 * 初始化所有基础设施模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── Phase 23: 配置Schema验证器 ──
  agent._configValidator = new ConfigSchemaValidator({
    logger: agent._logger,
    strictMode: options.strictConfigValidation ?? false,
    autoMigrate: options.autoConfigMigrate ?? true,
  });

  // ── Phase 23: 消息队列管理器 ──
  agent._messageQueueManager = new MessageQueueManager({
    logger: agent._logger,
    dataDir: agent._dataDir,
    maxSize: options.mqMaxSize ?? 10000,
    overflowStrategy: options.mqOverflowStrategy || OVERFLOW_STRATEGY.REJECT_NEW,
    persistEnabled: options.mqPersistEnabled ?? true,
    persistInterval: options.mqPersistInterval ?? 30000,
    deadLetterEnabled: options.mqDeadLetterEnabled ?? true,
    maxRetries: options.mqMaxRetries ?? 3,
    retryDelay: options.mqRetryDelay ?? 1000,
    retryBackoff: options.mqRetryBackoff ?? 'exponential',
    maxRetryDelay: options.mqMaxRetryDelay ?? 60000,
    messageTTL: options.mqMessageTTL ?? 3600000,
  });

  // ── Phase 22/23: 性能监控 ──
  agent._perfMonitor = new PerformanceMonitor({
    logger: agent._logger,
    enableResourceMonitoring: options.enablePerfMonitoring !== false,
    enableHealthCheck: options.enableHealthCheck !== false,
    maxLatencySamples: options.perfMaxLatencySamples ?? 1000,
    throughputWindow: options.perfThroughputWindow ?? 60000,
    slowThreshold: options.perfSlowThreshold ?? 1000,
    criticalThreshold: options.perfCriticalThreshold ?? 5000,
    resourceInterval: options.perfResourceInterval ?? 30000,
    healthCheckInterval: options.perfHealthCheckInterval ?? 60000,
  });

  // ── Phase 24: TICK并发处理器 ──
  agent._tickConcurrency = new TickConcurrency({
    logger: agent._logger,
    concurrency: options.tickConcurrency || Math.max(1, require('os').cpus().length),
    maxQueueSize: options.tickMaxQueueSize || 100,
    circuitBreakerThreshold: options.tickCircuitBreakerThreshold || 5,
    circuitBreakerTimeout: options.tickCircuitBreakerTimeout || 30000,
  });

  // ── Phase 24: 分布式锁管理器 ──
  agent._distLock = new DistributedLockManager({
    logger: agent._logger,
    dataDir: agent._dataDir,
    defaultTTL: options.lockTTL || 30000,
  });

  // ── Phase 24: 优雅重启管理器 ──
  agent._gracefulRestart = new GracefulRestartManager({
    logger: agent._logger,
    agent: agent,
    healthPort: options.healthPort || 3722,
    drainTimeout: options.drainTimeout || 30000,
    shutdownTimeout: options.shutdownTimeout || 10000,
    warmupTime: options.warmupTime || 5000,
  });

  // ── v3.1: 全流程启动自检 ──
  agent._startupSelfCheck = new StartupSelfCheck({
    logger: agent._logger,
    dataDir: agent._dataDir,
    configManager: null, // 将在 _config 初始化后注入
    timeouts: options.selfCheckTimeouts || {},
  });

  // ── Phase 24: 速率限制器 ──
  agent._rateLimiter = new RateLimiter({
    logger: agent._logger,
    algorithm: options.rateLimitAlgorithm || ALGORITHM.TOKEN_BUCKET,
    defaultCapacity: options.rateLimitCapacity || 100,
    defaultRefillRate: options.rateLimitRefillRate || 10,
    defaultWindowMs: options.rateLimitWindowMs || 60000,
    defaultMaxRequests: options.rateLimitMaxRequests || 60,
  });

  // 配置默认限流规则
  agent._rateLimiter.configureRule('api:/message', { maxRequests: 120, windowMs: 60000 });
  agent._rateLimiter.configureRule('api:/tasks', { maxRequests: 30, windowMs: 60000 });
  agent._rateLimiter.configureRule('llm:calls', { capacity: 100, refillRate: 5 });
  agent._rateLimiter.configureRule('tick:processing', { capacity: 50, refillRate: 10 });

  // ── Phase 26: Prometheus指标导出器 ──
  agent._prometheus = new PrometheusMetrics({
    prefix: 'tricore_',
    defaultLabels: { instance: options.name || 'default' },
  });

  // ── Phase 27: 微服务注册中心 ──
  agent._microRegistry = new MicroServiceRegistry({
    dataDir: agent._dataDir,
    registryType: options.registryType || REGISTRY_TYPE.LOCAL,
    heartbeatInterval: options.registryHeartbeatInterval || 10000,
    ttl: options.registryTTL || 45000,
  });

  // 注册本机服务
  agent._microRegistry.register('mitang-tricore-agent', {
    host: options.host || '127.0.0.1',
    port: options.port || 3721,
    metadata: {
      version: VERSION,
      codename: CODENAME,
      brandName: BRAND_NAME,
    },
    tags: ['mitang', 'tricore', 'agent', `v${VERSION}`],
  });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // 基础设施模块的事件绑定在 index.js 的 _bindMessageQueueEvents() 和 _bindGovernanceEvents() 中处理
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // 基础设施层没有额外的启动逻辑
  // Prometheus / MicroRegistry 的定时器在 index.js start() 中启动
}

module.exports = { init, bindEvents, startup };
