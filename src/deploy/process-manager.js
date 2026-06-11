/**
 * TriCore Agent - 进程管理器 (Process Manager)
 *
 * PM2风格进程管理，无需外部依赖：
 *   1. 守护进程 - Agent崩溃自动重启
 *   2. 优雅关闭 - SIGTERM信号处理，资源清理
 *   3. 健康检查 - 定期探测Agent状态
 *   4. 日志管理 - 日志轮转 + 错误追踪
 *   5. 性能监控 - 内存/CPU/TICK延迟
 */

'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// ── 常量 ──
const RESTART_POLICY = Object.freeze({
  NEVER: 'never',
  ON_FAILURE: 'on_failure',
  ALWAYS: 'always',
});

const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  STOPPED: 'stopped',
});

class ProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── 配置 ──
    this._restartPolicy = options.restartPolicy || RESTART_POLICY.ON_FAILURE;
    this._maxRestarts = options.maxRestarts || 5;
    this._restartCooldown = options.restartCooldown || 5000; // 5秒冷却
    this._healthCheckInterval = options.healthCheckInterval || 30000;
    this._logDir = options.logDir || path.join(process.cwd(), 'logs');
    this._maxLogSize = options.maxLogSize || 10 * 1024 * 1024; // 10MB
    this._maxLogFiles = options.maxLogFiles || 5;

    // ── 运行状态 ──
    this._agent = null;
    this._running = false;
    this._startTime = null;
    this._restartCount = 0;
    this._lastRestartAt = 0;
    this._healthStatus = HEALTH_STATUS.STOPPED;
    this._healthCheckTimer = null;
    this._restartTimer = null;  // 追踪重启定时器

    // ── 日志流 ──
    this._logStream = null;
    this._errorStream = null;
    this._logSize = 0;
    this._errorSize = 0;

    // ── 性能指标 ──
    this._metrics = {
      startTimes: [],
      tickLatencies: [],
      memorySnapshots: [],
      errors: [],
      lastTickAt: 0,
    };

    // ── 信号处理（构造时注册一次，防止重复注册） ──
    this._signalHandlersRegistered = false;
    this._registerSignalHandlers();
  }

  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  /**
   * 启动Agent并守护
   */
  async start(agent, config = {}) {
    if (this._running) return;

    this._agent = agent;
    this._startTime = Date.now();

    // 初始化日志
    this._initLogging();

    try {
      await agent.start(config);
      this._running = true;
      this._healthStatus = HEALTH_STATUS.HEALTHY;
      this._restartCount = 0;

      this._log('INFO', `Agent started (pid: ${process.pid})`);
      this.emit('started', { pid: process.pid });

      // 启动健康检查
      this._startHealthCheck();

      // 记录启动时间
      this._metrics.startTimes.push(Date.now() - this._startTime);
    } catch (error) {
      this._healthStatus = HEALTH_STATUS.UNHEALTHY;
      this._log('ERROR', `Agent start failed: ${error.message}`);
      this.emit('start_failed', { error: error.message });

      // 自动重启
      if (this._restartPolicy !== RESTART_POLICY.NEVER) {
        this._scheduleRestart(config);
      }
    }
  }

  /**
   * 优雅停止
   */
  async stop(timeout = 10000) {
    if (!this._running) return;

    this._log('INFO', 'Graceful shutdown initiated...');
    this._running = false;
    this._healthStatus = HEALTH_STATUS.STOPPED;

    // 停止健康检查
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }

    // 超时强制退出
    const forceTimer = setTimeout(() => {
      this._log('WARN', 'Force exit after timeout');
      this._closeLogging();
      process.exit(1);
    }, timeout);

    try {
      // 停止Agent
      if (this._agent) {
        this._agent.stop();
      }

      clearTimeout(forceTimer);
      this._closeLogging();
      this.emit('stopped', { uptime: Date.now() - this._startTime });
    } catch (error) {
      clearTimeout(forceTimer);
      this._log('ERROR', `Stop error: ${error.message}`);
      this._closeLogging();
    }
  }

  // ═══════════════════════════════════════
  // 信号处理
  // ═══════════════════════════════════════

  _registerSignalHandlers() {
    if (this._signalHandlersRegistered) return;
    this._signalHandlersRegistered = true;

    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];

    for (const signal of signals) {
      process.on(signal, async () => {
        this._log('INFO', `Received ${signal}`);
        await this.stop();
        process.exit(0);
      });
    }

    // 未捕获异常
    process.on('uncaughtException', (error) => {
      this._log('ERROR', `Uncaught exception: ${error.message}\n${error.stack}`);
      this._metrics.errors.push({ type: 'uncaught', message: error.message, at: Date.now() });
      this._healthStatus = HEALTH_STATUS.UNHEALTHY;
    });

    process.on('unhandledRejection', (reason) => {
      this._log('ERROR', `Unhandled rejection: ${reason}`);
      this._metrics.errors.push({ type: 'rejection', message: String(reason), at: Date.now() });
    });
  }

  // ═══════════════════════════════════════
  // 健康检查
  // ═══════════════════════════════════════

  _startHealthCheck() {
    if (this._healthCheckTimer) return;

    this._healthCheckTimer = setInterval(() => {
      this._performHealthCheck();
    }, this._healthCheckInterval);
  }

  _performHealthCheck() {
    if (!this._agent || !this._running) {
      this._healthStatus = HEALTH_STATUS.STOPPED;
      return;
    }

    try {
      const status = this._agent.getStatus();

      // 检查运行状态
      if (!status.running) {
        this._healthStatus = HEALTH_STATUS.UNHEALTHY;
        this._log('WARN', 'Agent not running');
        this.emit('unhealthy', { reason: 'Agent not running' });

        if (this._restartPolicy !== RESTART_POLICY.NEVER) {
          this._scheduleRestart();
        }
        return;
      }

      // 检查TICK延迟
      const schedulerStatus = status.scheduler;
      if (schedulerStatus?.lastTickAt) {
        const tickDelay = Date.now() - schedulerStatus.lastTickAt;
        this._metrics.tickLatencies.push(tickDelay);
        if (this._metrics.tickLatencies.length > 100) {
          this._metrics.tickLatencies.shift();
        }

        if (tickDelay > 60000) { // 超过1分钟没TICK
          this._healthStatus = HEALTH_STATUS.DEGRADED;
          this.emit('degraded', { tickDelay });
        } else {
          this._healthStatus = HEALTH_STATUS.HEALTHY;
        }
      }

      // 内存快照
      const memUsage = process.memoryUsage();
      this._metrics.memorySnapshots.push({
        rss: memUsage.rss,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        at: Date.now(),
      });
      if (this._metrics.memorySnapshots.length > 60) {
        this._metrics.memorySnapshots.shift();
      }

      // 内存告警（超过500MB）
      if (memUsage.rss > 500 * 1024 * 1024) {
        this._log('WARN', `High memory usage: ${(memUsage.rss / 1024 / 1024).toFixed(0)}MB`);
        this.emit('memory_warning', { rss: memUsage.rss });
      }

      this._metrics.lastTickAt = Date.now();
      this.emit('health_check', {
        status: this._healthStatus,
        memory: memUsage,
      });
    } catch (error) {
      this._healthStatus = HEALTH_STATUS.UNHEALTHY;
      this._log('ERROR', `Health check error: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════
  // 自动重启
  // ═══════════════════════════════════════

  _scheduleRestart(config) {
    // 冷却检查
    if (Date.now() - this._lastRestartAt < this._restartCooldown) {
      this._log('WARN', 'Restart cooldown, waiting...');
      if (this._restartTimer) clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => this._scheduleRestart(config), this._restartCooldown);
      return;
    }

    // 最大重启次数
    if (this._restartCount >= this._maxRestarts) {
      this._log('ERROR', `Max restarts (${this._maxRestarts}) reached. Giving up.`);
      this.emit('restart_failed', { restartCount: this._restartCount });
      return;
    }

    this._restartCount++;
    this._lastRestartAt = Date.now();

    this._log('INFO', `Restarting (attempt ${this._restartCount}/${this._maxRestarts})...`);
    this.emit('restarting', { attempt: this._restartCount });

    // 清除之前的重启定时器，确保只有一个
    if (this._restartTimer) clearTimeout(this._restartTimer);

    // 尝试重启
    this._restartTimer = setTimeout(async () => {
      this._restartTimer = null;
      try {
        if (this._agent) {
          this._agent.stop();
        }
        await this._agent.start(config || {});
        this._running = true;
        this._healthStatus = HEALTH_STATUS.HEALTHY;
        this._log('INFO', 'Restart successful');
        this.emit('restarted', { attempt: this._restartCount });
      } catch (error) {
        this._log('ERROR', `Restart failed: ${error.message}`);
        this._scheduleRestart(config);
      }
    }, this._restartCooldown);
  }

  // ═══════════════════════════════════════
  // 日志管理
  // ═══════════════════════════════════════

  _initLogging() {
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }

    const date = new Date().toISOString().split('T')[0];
    const logPath = path.join(this._logDir, `tricore_${date}.log`);
    const errorPath = path.join(this._logDir, `tricore_error_${date}.log`);

    this._logStream = fs.createWriteStream(logPath, { flags: 'a' });
    this._errorStream = fs.createWriteStream(errorPath, { flags: 'a' });
  }

  _log(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}\n`;

    // 控制台
    if (level === 'ERROR') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    // 文件
    try {
      if (this._logStream) {
        this._logStream.write(line);
        this._logSize += Buffer.byteLength(line);

        if (this._logSize > this._maxLogSize) {
          this._rotateLog('log');
        }
      }

      if (level === 'ERROR' && this._errorStream) {
        this._errorStream.write(line);
        this._errorSize += Buffer.byteLength(line);

        if (this._errorSize > this._maxLogSize) {
          this._rotateLog('error');
        }
      }
    } catch {}
  }

  _rotateLog(type) {
    const stream = type === 'log' ? this._logStream : this._errorStream;
    if (stream) stream.end();

    if (type === 'log') {
      this._logStream = fs.createWriteStream(
        path.join(this._logDir, `tricore_${new Date().toISOString().split('T')[0]}.log`),
        { flags: 'a' }
      );
      this._logSize = 0;
    } else {
      this._errorStream = fs.createWriteStream(
        path.join(this._logDir, `tricore_error_${new Date().toISOString().split('T')[0]}.log`),
        { flags: 'a' }
      );
      this._errorSize = 0;
    }
  }

  _closeLogging() {
    if (this._logStream) { this._logStream.end(); this._logStream = null; }
    if (this._errorStream) { this._errorStream.end(); this._errorStream = null; }
  }

  // ═══════════════════════════════════════
  // 性能指标
  // ═══════════════════════════════════════

  getMetrics() {
    const memSnapshots = this._metrics.memorySnapshots;
    const tickLatencies = this._metrics.tickLatencies;

    return {
      uptime: this._startTime ? Date.now() - this._startTime : 0,
      healthStatus: this._healthStatus,
      restartCount: this._restartCount,
      memory: memSnapshots.length > 0 ? memSnapshots[memSnapshots.length - 1] : null,
      memoryTrend: this._computeTrend(memSnapshots, 'rss'),
      tickLatency: tickLatencies.length > 0
        ? {
            avg: Math.round(tickLatencies.reduce((a, b) => a + b, 0) / tickLatencies.length),
            max: Math.max(...tickLatencies),
            min: Math.min(...tickLatencies),
          }
        : null,
      errors: this._metrics.errors.length,
      pid: process.pid,
    };
  }

  _computeTrend(data, key) {
    if (data.length < 2) return 'stable';
    const first = data[0][key];
    const last = data[data.length - 1][key];
    const change = (last - first) / first;
    if (change > 0.2) return 'increasing';
    if (change < -0.2) return 'decreasing';
    return 'stable';
  }

  getStatus() {
    return {
      running: this._running,
      healthStatus: this._healthStatus,
      restartCount: this._restartCount,
      uptime: this._startTime ? Date.now() - this._startTime : 0,
      pid: process.pid,
    };
  }
}

module.exports = {
  ProcessManager,
  RESTART_POLICY,
  HEALTH_STATUS,
};
