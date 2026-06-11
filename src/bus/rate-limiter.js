/**
 * TriCore Agent - 速率限制器 (Phase 24)
 *
 * 功能:
 *   1. 滑动窗口算法 - 精确的请求速率控制
 *   2. 令牌桶算法 - 允许突发流量
 *   3. 固定窗口算法 - 简单高效
 *   4. 多维度限制 - 支持IP/用户/API Key维度
 *   5. 分布式限流 - Redis预留接口
 *
 * 使用场景:
 *   - API端点限流
 *   - LLM调用频率控制
 *   - TICK处理速率控制
 *   - WebSocket连接限制
 */

'use strict';

const { EventEmitter } = require('events');

const ALGORITHM = Object.freeze({
  SLIDING_WINDOW: 'sliding_window',
  TOKEN_BUCKET: 'token_bucket',
  FIXED_WINDOW: 'fixed_window',
});

const RATE_LIMIT_SCOPE = Object.freeze({
  IP: 'ip',
  USER: 'user',
  API_KEY: 'api_key',
  GLOBAL: 'global',
});

class RateLimiter extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger = options.logger || null;

    // 默认算法
    this._algorithm = options.algorithm || ALGORITHM.TOKEN_BUCKET;

    // 限制规则存储
    this._rules = new Map();        // key → { maxRequests, windowMs, algorithm }
    this._windows = new Map();      // key → { tokens, lastRefill, count, windowStart }

    // 令牌桶默认参数
    this._defaultCapacity = options.defaultCapacity || 100;
    this._defaultRefillRate = options.defaultRefillRate || 10; // tokens/second
    this._defaultRefillInterval = options.defaultRefillInterval || 1000; // ms

    // 滑动窗口默认参数
    this._defaultWindowMs = options.defaultWindowMs || 60000; // 1分钟
    this._defaultMaxRequests = options.defaultMaxRequests || 60; // 60次/分钟

    // 清理定时器
    this._cleanupInterval = null;
    this._startCleanup();
  }

  /**
   * 配置限流规则
   * @param {string} key - 限流键（如 'api:/message', 'user:user123'）
   * @param {Object} rule - { algorithm, maxRequests, windowMs, capacity, refillRate }
   */
  configureRule(key, rule) {
    const cap = rule.capacity || rule.maxRequests || this._defaultCapacity;
    this._rules.set(key, {
      algorithm: rule.algorithm || this._algorithm,
      maxRequests: rule.maxRequests || cap,
      windowMs: rule.windowMs || this._defaultWindowMs,
      capacity: cap,
      refillRate: rule.refillRate || this._defaultRefillRate,
    });

    // 初始化窗口
    if (!this._windows.has(key)) {
      this._initWindow(key, this._rules.get(key));
    }
  }

  /**
   * 检查请求是否被允许
   * @param {string} key - 限流键
   * @param {Object} options - { cost: 1 }
   * @returns {Object} { allowed, remaining, resetAt, retryAfter }
   */
  check(key, options = {}) {
    const cost = options.cost || 1;

    let rule = this._rules.get(key);
    if (!rule) {
      // 使用默认规则
      rule = {
        algorithm: this._algorithm,
        maxRequests: this._defaultMaxRequests,
        windowMs: this._defaultWindowMs,
        capacity: this._defaultCapacity,
        refillRate: this._defaultRefillRate,
      };
      this._rules.set(key, rule);
      this._initWindow(key, rule);
    }

    const window = this._windows.get(key);
    if (!window) {
      this._initWindow(key, rule);
      return this.check(key, options);
    }

    switch (rule.algorithm) {
      case ALGORITHM.TOKEN_BUCKET:
        return this._checkTokenBucket(key, rule, window, cost);
      case ALGORITHM.SLIDING_WINDOW:
        return this._checkSlidingWindow(key, rule, window, cost);
      case ALGORITHM.FIXED_WINDOW:
        return this._checkFixedWindow(key, rule, window, cost);
      default:
        return { allowed: true, remaining: -1 };
    }
  }

  /**
   * 令牌桶算法检查
   */
  _checkTokenBucket(key, rule, window, cost) {
    const now = Date.now();
    const elapsed = now - window.lastRefill;

    // 补充令牌
    const tokensToAdd = (elapsed / rule.refillRate) * rule.refillRate;
    window.tokens = Math.min(rule.capacity, window.tokens + tokensToAdd);
    window.lastRefill = now;

    if (window.tokens >= cost) {
      window.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(window.tokens),
        resetAt: now + ((rule.capacity - window.tokens) / rule.refillRate) * 1000,
      };
    }

    // 计算下次可用时间
    const tokensNeeded = cost - window.tokens;
    const waitMs = (tokensNeeded / rule.refillRate) * 1000;

    return {
      allowed: false,
      remaining: 0,
      resetAt: now + waitMs,
      retryAfter: Math.ceil(waitMs / 1000),
      limit: rule.capacity,
    };
  }

  /**
   * 滑动窗口算法检查
   */
  _checkSlidingWindow(key, rule, window, cost) {
    const now = Date.now();
    const windowStart = now - rule.windowMs;
    const limit = rule.maxRequests || rule.capacity;

    // 清理过期记录
    window.requests = window.requests.filter(ts => ts > windowStart);

    if (window.requests.length + cost <= limit) {
      for (let i = 0; i < cost; i++) {
        window.requests.push(now);
      }
      return {
        allowed: true,
        remaining: limit - window.requests.length,
        resetAt: window.requests[0] + rule.windowMs,
      };
    }

    const oldestInWindow = window.requests[0];
    return {
      allowed: false,
      remaining: 0,
      resetAt: oldestInWindow + rule.windowMs,
      retryAfter: Math.ceil((oldestInWindow + rule.windowMs - now) / 1000),
      limit,
    };
  }

  /**
   * 固定窗口算法检查
   */
  _checkFixedWindow(key, rule, window, cost) {
    const now = Date.now();
    const limit = rule.maxRequests || rule.capacity;

    if (now - window.windowStart > rule.windowMs) {
      window.windowStart = now;
      window.count = 0;
    }

    if (window.count + cost <= limit) {
      window.count += cost;
      return {
        allowed: true,
        remaining: limit - window.count,
        resetAt: window.windowStart + rule.windowMs,
      };
    }

    return {
      allowed: false,
      remaining: 0,
      resetAt: window.windowStart + rule.windowMs,
      retryAfter: Math.ceil((window.windowStart + rule.windowMs - now) / 1000),
      limit,
    };
  }

  /**
   * 初始化窗口
   */
  _initWindow(key, rule) {
    this._windows.set(key, {
      tokens: rule.capacity || rule.maxRequests || 100,
      lastRefill: Date.now(),
      count: 0,
      windowStart: Date.now(),
      requests: [],
    });
  }

  /**
   * 便捷方法：检查并消耗
   * @returns {boolean} 是否允许
   */
  isAllowed(key, cost = 1) {
    return this.check(key, { cost }).allowed;
  }

  /**
   * 获取当前限流状态
   */
  getStatus(key) {
    const rule = this._rules.get(key);
    const window = this._windows.get(key);

    if (!rule || !window) {
      return { exists: false };
    }

    return {
      exists: true,
      algorithm: rule.algorithm,
      ...(rule.algorithm === ALGORITHM.TOKEN_BUCKET
        ? { tokens: Math.floor(window.tokens), capacity: rule.capacity }
        : { count: window.count, maxRequests: rule.maxRequests }
      ),
      windowMs: rule.windowMs,
    };
  }

  /**
   * 获取所有限流状态
   */
  getAllStatus() {
    const statuses = {};
    for (const [key] of this._rules) {
      statuses[key] = this.getStatus(key);
    }
    return statuses;
  }

  /**
   * 重置某个限流键
   */
  reset(key) {
    const rule = this._rules.get(key);
    if (rule) {
      this._initWindow(key, rule);
    }
    this._windows.delete(key);
    this._rules.delete(key);
  }

  /**
   * 重置所有限流
   */
  resetAll() {
    this._windows.clear();
    this._rules.clear();
  }

  /**
   * 清理过期窗口
   */
  _startCleanup() {
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, window] of this._windows) {
        const rule = this._rules.get(key);
        if (!rule) continue;

        if (rule.algorithm === ALGORITHM.SLIDING_WINDOW) {
          const cutoff = now - rule.windowMs;
          window.requests = window.requests.filter(ts => ts > cutoff);
        }
      }
    }, 30000); // 每30秒清理一次
  }

  close() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._windows.clear();
    this._rules.clear();
    this.removeAllListeners();
  }
}

module.exports = {
  RateLimiter,
  ALGORITHM,
  RATE_LIMIT_SCOPE,
};
