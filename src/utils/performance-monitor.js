/**
 * TriCore Agent - 性能监控 (Performance Monitor)
 *
 * Phase 22: 系统性能监控 - 延迟/吞吐/资源使用/健康检查
 *
 * 核心能力:
 *   1. 请求延迟追踪 - P50/P90/P99/P999
 *   2. 吞吐量监控 - RPS/TPS实时统计
 *   3. 资源使用 - CPU/内存/事件循环延迟
 *   4. 健康检查 - 各模块健康状态汇总
 *   5. 慢查询检测 - 自动识别性能瓶颈
 *   6. 告警阈值 - 自定义告警规则
 */
'use strict';

const { EventEmitter } = require('events');
const os = require('os');

// ── 告警级别 ──
const ALERT_LEVEL = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  CRITICAL: 'critical',
});

class PerformanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || null;

    // 延迟追踪
    this._latencyBuckets = new Map(); // name → [{latency, timestamp}]
    this._maxLatencySamples = options.maxLatencySamples || 1000;

    // 吞吐量追踪
    this._throughputCounters = new Map(); // name → { count, windowStart }
    this._throughputWindow = options.throughputWindow || 60000; // 1分钟

    // 慢操作阈值 (ms)
    this._slowThreshold = options.slowThreshold || 1000;
    this._criticalThreshold = options.criticalThreshold || 5000;

    // 资源监控
    this._resourceInterval = null;
    this._resourceIntervalMs = options.resourceInterval || 30000; // 30秒
    this._resourceHistory = [];
    this._maxResourceHistory = options.maxResourceHistory || 1440; // 24小时(每分钟一条)

    // 健康状态
    this._healthChecks = new Map(); // name → { check: () => boolean, lastResult, lastCheck }
    this._healthCheckInterval = options.healthCheckInterval || 60000; // 1分钟
    this._healthCheckTimer = null;

    // 告警规则
    this._alertRules = [];

    // 启动资源监控
    if (options.enableResourceMonitoring !== false) {
      this._startResourceMonitoring();
    }

    // 启动健康检查
    if (options.enableHealthCheck !== false) {
      this._startHealthCheck();
    }
  }

  // ═══════════════════════════════════════
  // 延迟追踪
  // ═══════════════════════════════════════

  /**
   * 记录操作延迟
   */
  recordLatency(name, latencyMs) {
    if (!this._latencyBuckets.has(name)) {
      this._latencyBuckets.set(name, []);
    }

    const bucket = this._latencyBuckets.get(name);
    bucket.push({ latency: latencyMs, timestamp: Date.now() });

    // 限制样本数量
    if (bucket.length > this._maxLatencySamples) {
      bucket.shift();
    }

    // 慢操作检测
    if (latencyMs > this._criticalThreshold) {
      this._alert(ALERT_LEVEL.CRITICAL, `Critical latency: ${name} took ${latencyMs}ms`);
    } else if (latencyMs > this._slowThreshold) {
      this._alert(ALERT_LEVEL.WARN, `Slow operation: ${name} took ${latencyMs}ms`);
    }
  }

  /**
   * 获取延迟统计
   */
  getLatencyStats(name) {
    const bucket = this._latencyBuckets.get(name);
    if (!bucket || bucket.length === 0) {
      return { p50: 0, p90: 0, p99: 0, avg: 0, min: 0, max: 0, count: 0 };
    }

    const latencies = bucket.map(s => s.latency).sort((a, b) => a - b);
    const len = latencies.length;

    return {
      p50: latencies[Math.floor(len * 0.5)],
      p90: latencies[Math.floor(len * 0.9)],
      p99: latencies[Math.floor(len * 0.99)],
      p999: latencies[Math.floor(len * 0.999)],
      avg: Math.round(latencies.reduce((a, b) => a + b, 0) / len),
      min: latencies[0],
      max: latencies[len - 1],
      count: len,
    };
  }

  /**
   * 获取所有延迟统计
   */
  getAllLatencyStats() {
    const stats = {};
    for (const [name] of this._latencyBuckets) {
      stats[name] = this.getLatencyStats(name);
    }
    return stats;
  }

  // ═══════════════════════════════════════
  // 吞吐量追踪
  // ═══════════════════════════════════════

  /**
   * 记录一次操作（用于吞吐量统计）
   */
  recordThroughput(name, count = 1) {
    const now = Date.now();
    let counter = this._throughputCounters.get(name);

    if (!counter || now - counter.windowStart > this._throughputWindow) {
      counter = { count: 0, windowStart: now, lastRPS: 0 };
      this._throughputCounters.set(name, counter);
    }

    counter.count += count;
    const elapsed = (now - counter.windowStart) / 1000;
    counter.lastRPS = elapsed > 0 ? counter.count / elapsed : 0;
  }

  /**
   * 获取吞吐量统计
   */
  getThroughputStats() {
    const stats = {};
    for (const [name, counter] of this._throughputCounters) {
      stats[name] = {
        totalCount: counter.count,
        rps: counter.lastRPS.toFixed(2),
        windowStart: counter.windowStart,
      };
    }
    return stats;
  }

  // ═══════════════════════════════════════
  // 资源监控
  // ═══════════════════════════════════════

  _startResourceMonitoring() {
    this._resourceInterval = setInterval(() => {
      const snapshot = this._collectResourceSnapshot();
      this._resourceHistory.push(snapshot);

      if (this._resourceHistory.length > this._maxResourceHistory) {
        this._resourceHistory.shift();
      }

      // CPU高负载告警
      if (snapshot.cpuUsage > 90) {
        this._alert(ALERT_LEVEL.CRITICAL, `CPU usage critical: ${snapshot.cpuUsage.toFixed(1)}%`);
      } else if (snapshot.cpuUsage > 70) {
        this._alert(ALERT_LEVEL.WARN, `CPU usage high: ${snapshot.cpuUsage.toFixed(1)}%`);
      }

      // 内存高负载告警
      if (snapshot.memoryUsagePercent > 90) {
        this._alert(ALERT_LEVEL.CRITICAL, `Memory usage critical: ${snapshot.memoryUsagePercent.toFixed(1)}%`);
      }

      this.emit('resource_snapshot', snapshot);
    }, this._resourceIntervalMs);
  }

  _collectResourceSnapshot() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const cpus = os.cpus();
    const cpuUsage = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle || 0;
      return acc + ((total - idle) / total) * 100;
    }, 0) / cpus.length;

    return {
      timestamp: Date.now(),
      cpuUsage: Math.round(cpuUsage * 10) / 10,
      cpuCores: cpus.length,
      memoryTotal: totalMem,
      memoryUsed: usedMem,
      memoryFree: freeMem,
      memoryUsagePercent: Math.round((usedMem / totalMem) * 1000) / 10,
      uptime: process.uptime(),
      heapUsed: (process.memoryUsage ? process.memoryUsage().heapUsed : 0) || 0,
      heapTotal: (process.memoryUsage ? process.memoryUsage().heapTotal : 0) || 0,
      eventLoopDelay: this._measureEventLoopDelay(),
    };
  }

  _measureEventLoopDelay() {
    // 精确的事件循环延迟测量 (使用 perf_hooks)
    // 原理: 记录上一次 setImmediate 的实际延迟作为事件循环繁忙程度的指标
    const now = process.hrtime.bigint();

    if (this._lastEventLoopCheck) {
      const elapsed = Number(now - this._lastEventLoopCheck) / 1e6; // 转换为毫秒
      // 预期间隔是 resourceIntervalMs，实际延迟 = 实际间隔 - 预期间隔
      const expectedInterval = this._resourceIntervalMs;
      const delay = Math.max(0, elapsed - expectedInterval);
      this._currentEventLoopDelay = Math.round(delay * 100) / 100;

      // 事件循环延迟告警
      if (delay > 100) {
        this._alert(ALERT_LEVEL.WARN, `Event loop delay high: ${delay.toFixed(1)}ms`);
      }
      if (delay > 500) {
        this._alert(ALERT_LEVEL.CRITICAL, `Event loop blocked: ${delay.toFixed(1)}ms`);
      }
    }

    this._lastEventLoopCheck = now;

    // 同时使用 perf_hooks.monitorEventLoopDelay (Node.js 11.10+)
    if (!this._eventLoopMonitor && typeof require('perf_hooks').monitorEventLoopDelay === 'function') {
      try {
        const { monitorEventLoopDelay } = require('perf_hooks');
        this._eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
        this._eventLoopMonitor.enable();
      } catch {
        // 降级：使用上面的手动测量
      }
    }

    // 从 monitor 获取最新值
    if (this._eventLoopMonitor) {
      const hist = this._eventLoopMonitor;
      if (hist.max > this._currentEventLoopDelay) {
        this._currentEventLoopDelay = Math.round(hist.max / 1e6 * 100) / 100;
      }
    }

    return this._currentEventLoopDelay || 0;
  }

  /**
   * 获取最新资源快照
   */
  getResourceSnapshot() {
    return this._resourceHistory.length > 0
      ? this._resourceHistory[this._resourceHistory.length - 1]
      : this._collectResourceSnapshot();
  }

  /**
   * 获取资源历史
   */
  getResourceHistory(minutes = 60) {
    const cutoff = Date.now() - minutes * 60000;
    return this._resourceHistory.filter(s => s.timestamp >= cutoff);
  }

  // ═══════════════════════════════════════
  // 健康检查
  // ═══════════════════════════════════════

  _startHealthCheck() {
    this._healthCheckTimer = setInterval(() => {
      this.runHealthChecks();
    }, this._healthCheckInterval);
  }

  /**
   * 注册健康检查
   */
  registerHealthCheck(name, checkFn) {
    this._healthChecks.set(name, {
      check: checkFn,
      lastResult: null,
      lastCheck: 0,
    });
  }

  /**
   * 运行所有健康检查
   */
  runHealthChecks() {
    const results = {};
    let allHealthy = true;

    for (const [name, hc] of this._healthChecks) {
      try {
        const result = hc.check();
        hc.lastResult = result;
        hc.lastCheck = Date.now();
        results[name] = result;

        if (!result) {
          allHealthy = false;
          this._alert(ALERT_LEVEL.WARN, `Health check failed: ${name}`);
        }
      } catch (e) {
        results[name] = false;
        allHealthy = false;
        this._alert(ALERT_LEVEL.CRITICAL, `Health check error: ${name} - ${e.message}`);
      }
    }

    this.emit('health_check', { allHealthy, results });
    return { healthy: allHealthy, checks: results };
  }

  /**
   * 获取健康状态
   */
  getHealthStatus() {
    const results = {};
    for (const [name, hc] of this._healthChecks) {
      results[name] = {
        healthy: hc.lastResult,
        lastCheck: hc.lastCheck,
      };
    }

    const allHealthy = Object.values(results).every(r => r.healthy);
    return { healthy: allHealthy, checks: results };
  }

  // ═══════════════════════════════════════
  // 告警
  // ═══════════════════════════════════════

  addAlertRule(rule) {
    this._alertRules.push(rule);
  }

  _alert(level, message) {
    if (this._logger) {
      if (level === ALERT_LEVEL.CRITICAL) {
        this._logger.error(message, { module: 'perf_monitor' });
      } else {
        this._logger.warn(message, { module: 'perf_monitor' });
      }
    }

    this.emit('alert', { level, message, timestamp: Date.now() });
  }

  // ═══════════════════════════════════════
  // 综合报告
  // ═══════════════════════════════════════

  /**
   * 获取完整性能报告
   */
  getReport() {
    return {
      timestamp: Date.now(),
      latency: this.getAllLatencyStats(),
      throughput: this.getThroughputStats(),
      resources: this.getResourceSnapshot(),
      health: this.getHealthStatus(),
    };
  }

  /**
   * 关闭监控
   */
  close() {
    if (this._resourceInterval) {
      clearInterval(this._resourceInterval);
      this._resourceInterval = null;
    }
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }
}

module.exports = {
  PerformanceMonitor,
  ALERT_LEVEL,
};
