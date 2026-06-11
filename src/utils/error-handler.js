/**
 * TriCore Agent - 统一错误处理 (Error Handler)
 *
 * Phase 18: 统一异常处理、错误分类、优雅降级、重试策略
 */

'use strict';

// ── 错误类型 ──
const ERROR_TYPE = Object.freeze({
  // 系统错误
  SYSTEM: 'SystemError',
  CONFIG: 'ConfigError',
  NETWORK: 'NetworkError',
  TIMEOUT: 'TimeoutError',
  RESOURCE: 'ResourceError',

  // 业务错误
  VALIDATION: 'ValidationError',
  AUTHENTICATION: 'AuthenticationError',
  AUTHORIZATION: 'AuthorizationError',
  NOT_FOUND: 'NotFoundError',
  CONFLICT: 'ConflictError',
  RATE_LIMIT: 'RateLimitError',

  // 三核特有
  CONSCIOUSNESS: 'ConsciousnessError',
  EXECUTION: 'ExecutionError',
  EVOLUTION: 'EvolutionError',
  MEMORY: 'MemoryError',
  BUDGET: 'BudgetError',
  SECURITY: 'SecurityError',
  IRON_LAW: 'IronLawViolationError',
});

// ── 错误严重程度 ──
const ERROR_SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

// ── 重试策略 ──
const RETRY_STRATEGY = Object.freeze({
  NONE: 'none',
  LINEAR: 'linear',
  EXPONENTIAL: 'exponential',
  FIBONACCI: 'fibonacci',
});

class TriCoreError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.type || ERROR_TYPE.SYSTEM;
    this.code = options.code || 'UNKNOWN';
    this.severity = options.severity || ERROR_SEVERITY.MEDIUM;
    this.module = options.module || 'core';
    this.cause = options.cause || null;
    this.retryable = options.retryable !== false;
    this.context = options.context || {};
    this.timestamp = Date.now();
    this.traceId = options.traceId || '';

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TriCoreError);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      severity: this.severity,
      module: this.module,
      retryable: this.retryable,
      timestamp: this.timestamp,
      traceId: this.traceId,
      stack: this.stack,
    };
  }
}

// ── 预定义错误工厂 ──
const Errors = {
  // 系统
  system: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.SYSTEM }),
  config: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.CONFIG }),
  network: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.NETWORK, retryable: true }),
  timeout: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.TIMEOUT, retryable: true }),
  resource: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.RESOURCE }),

  // 业务
  validation: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.VALIDATION, severity: ERROR_SEVERITY.LOW }),
  authentication: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.AUTHENTICATION, severity: ERROR_SEVERITY.HIGH }),
  authorization: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.AUTHORIZATION, severity: ERROR_SEVERITY.HIGH }),
  notFound: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.NOT_FOUND, severity: ERROR_SEVERITY.LOW }),
  conflict: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.CONFLICT }),
  rateLimit: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.RATE_LIMIT, retryable: true }),

  // 三核
  consciousness: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.CONSCIOUSNESS }),
  execution: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.EXECUTION, retryable: true }),
  evolution: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.EVOLUTION }),
  memory: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.MEMORY }),
  budget: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.BUDGET }),
  security: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.SECURITY, severity: ERROR_SEVERITY.CRITICAL }),
  ironLaw: (msg, opts = {}) => new TriCoreError(msg, { ...opts, type: ERROR_TYPE.IRON_LAW, severity: ERROR_SEVERITY.CRITICAL, retryable: false }),
};

// ── 错误处理器 ──
class ErrorHandler {
  constructor(options = {}) {
    this._logger = options.logger || null;
    this._bus = options.bus || null;
    this._errorCounts = new Map(); // errorType → count
    this._lastErrors = [];          // 最近N个错误
    this._maxLastErrors = options.maxLastErrors || 100;
    this._onCritical = options.onCritical || null;

    // 重试配置
    this._retryConfig = {
      maxRetries: options.maxRetries || 3,
      baseDelay: options.baseDelay || 1000,    // 1秒
      maxDelay: options.maxDelay || 30000,      // 30秒
      strategy: options.retryStrategy || RETRY_STRATEGY.EXPONENTIAL,
    };
  }

  /**
   * 处理错误
   */
  handle(error, context = {}) {
    const triCoreError = this._normalize(error, context);

    // 记录
    this._record(triCoreError);

    // 日志
    if (this._logger) {
      const logLevel = triCoreError.severity === ERROR_SEVERITY.CRITICAL ? 'fatal'
        : triCoreError.severity === ERROR_SEVERITY.HIGH ? 'error'
        : 'warn';

      this._logger[logLevel](`[${triCoreError.name}] ${triCoreError.message}`, {
        module: triCoreError.module,
        error: triCoreError,
        data: triCoreError.context,
      });
    }

    // 总线通知
    if (this._bus && triCoreError.severity >= ERROR_SEVERITY.HIGH) {
      try {
        const { BUS_EVENT } = require('../bus/core-bus');
        this._bus.dispatch(BUS_EVENT.SYSTEM_ERROR, {
          type: triCoreError.name,
          message: triCoreError.message,
          severity: triCoreError.severity,
          module: triCoreError.module,
        }, { source: 'error_handler' });
      } catch {
        // 总线不可用
      }
    }

    // 关键错误回调
    if (triCoreError.severity === ERROR_SEVERITY.CRITICAL && this._onCritical) {
      try {
        this._onCritical(triCoreError);
      } catch {
        // 回调失败不影响
      }
    }

    return triCoreError;
  }

  /**
   * 安全执行函数（捕获异常）
   */
  async safeExecute(fn, context = {}) {
    try {
      return { success: true, result: await fn() };
    } catch (error) {
      return { success: false, error: this.handle(error, context) };
    }
  }

  /**
   * 带重试的执行
   */
  async retry(fn, options = {}) {
    const maxRetries = options.maxRetries ?? this._retryConfig.maxRetries;
    const baseDelay = options.baseDelay ?? this._retryConfig.baseDelay;
    const maxDelay = options.maxDelay ?? this._retryConfig.maxDelay;
    const strategy = options.strategy ?? this._retryConfig.strategy;
    const shouldRetry = options.shouldRetry || (() => true);

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return { success: true, result: await fn(), attempts: attempt + 1 };
      } catch (error) {
        lastError = error;

        if (attempt >= maxRetries || !shouldRetry(error)) {
          break;
        }

        // 计算延迟
        const delay = this._computeDelay(attempt, baseDelay, maxDelay, strategy);
        await this._sleep(delay);

        if (this._logger) {
          this._logger.debug(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`, {
            module: 'error_handler',
            error: error.message,
          });
        }
      }
    }

    return {
      success: false,
      error: this._normalize(lastError),
      attempts: maxRetries + 1,
    };
  }

  /**
   * 安全忽略（包装异步操作，失败时静默返回默认值）
   */
  async safeIgnore(fn, defaultValue = null) {
    try {
      return await fn();
    } catch {
      return defaultValue;
    }
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  _normalize(error, context = {}) {
    if (error instanceof TriCoreError) {
      return error;
    }

    // 推断错误类型
    let type = ERROR_TYPE.SYSTEM;
    let severity = ERROR_SEVERITY.MEDIUM;

    if (error.code === 'ENOENT') {
      type = ERROR_TYPE.NOT_FOUND;
      severity = ERROR_SEVERITY.LOW;
    } else if (error.code === 'EACCES' || error.code === 'EPERM') {
      type = ERROR_TYPE.AUTHORIZATION;
      severity = ERROR_SEVERITY.HIGH;
    } else if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
      type = ERROR_TYPE.TIMEOUT;
      severity = ERROR_SEVERITY.MEDIUM;
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      type = ERROR_TYPE.NETWORK;
      severity = ERROR_SEVERITY.HIGH;
    } else if (error.code === 'ERR_RATE_LIMIT' || error.status === 429) {
      type = ERROR_TYPE.RATE_LIMIT;
      severity = ERROR_SEVERITY.MEDIUM;
    }

    return new TriCoreError(error.message || String(error), {
      type,
      severity,
      code: error.code || 'UNKNOWN',
      cause: error,
      context,
    });
  }

  _record(error) {
    this._errorCounts.set(error.name, (this._errorCounts.get(error.name) || 0) + 1);
    this._lastErrors.push(error);
    if (this._lastErrors.length > this._maxLastErrors) {
      this._lastErrors.shift();
    }
  }

  _computeDelay(attempt, baseDelay, maxDelay, strategy) {
    let delay;
    switch (strategy) {
      case RETRY_STRATEGY.LINEAR:
        delay = baseDelay * (attempt + 1);
        break;
      case RETRY_STRATEGY.FIBONACCI: {
        // 迭代法计算 Fibonacci，避免递归栈溢出和 O(2^n) 复杂度
        delay = baseDelay * this._fibonacciIterative(attempt + 2);
        break;
      }
      case RETRY_STRATEGY.EXPONENTIAL:
      default:
        delay = baseDelay * Math.pow(2, attempt);
        // 添加随机抖动
        delay = delay + Math.random() * (delay * 0.1);
        break;
    }
    return Math.min(delay, maxDelay);
  }

  /**
   * 迭代法计算第 n 个 Fibonacci 数
   * O(n) 时间复杂度，O(1) 空间复杂度
   * 相比递归 O(2^n) 大幅优化
   */
  _fibonacciIterative(n) {
    if (n <= 1) return n;
    let a = 0, b = 1;
    for (let i = 2; i <= n; i++) {
      [a, b] = [b, a + b];
    }
    return b;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════
  // 状态
  // ═══════════════════════════════════════

  getErrorStats() {
    return {
      counts: Object.fromEntries(this._errorCounts),
      recent: this._lastErrors.slice(-10).map(e => ({
        name: e.name,
        message: e.message,
        timestamp: e.timestamp,
      })),
      total: this._lastErrors.length,
    };
  }
}

module.exports = {
  TriCoreError,
  Errors,
  ErrorHandler,
  ERROR_TYPE,
  ERROR_SEVERITY,
  RETRY_STRATEGY,
};
