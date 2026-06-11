/**
 * TriCore Agent - Token 预算管理器 (Token Budget Manager)
 *
 * 核心问题：意识TICK + 任务执行 + 技能沉淀三层同时运行，
 *          Token成本可能是单一产品的3-5倍。
 *
 * 解决方案：
 *   1. 三层预算分配 - 意识60% / 执行30% / 进化10%（可调）
 *   2. 自动节流 - 预算即将耗尽时自动降级
 *   3. 经济模式 - 空闲思考用最便宜模型，深度思考才用强模型
 *   4. 调用缓存 - 相似请求复用结果
 *   5. 批量合并 - 多个小请求合并为一次LLM调用
 *   6. 实时监控 - 按层/按小时/按天的Token消耗可视化
 */

'use strict';

const { EventEmitter } = require('events');

const THROTTLE_LEVEL = Object.freeze({
  NONE: 'none',
  LIGHT: 'light',
  MODERATE: 'moderate',
  HEAVY: 'heavy',
  EMERGENCY: 'emergency',
});

const CALL_PRIORITY = Object.freeze({
  CRITICAL: 100,
  HIGH: 80,
  NORMAL: 50,
  LOW: 20,
  IDLE: 5,
});

const BUDGET_STRATEGY = Object.freeze({
  FIXED: 'fixed',
  ADAPTIVE: 'adaptive',
  COST_OPTIMIZED: 'cost_optimized',
  QUALITY_FIRST: 'quality_first',
});

const CACHE_POLICY = Object.freeze({
  NONE: 'none',
  EXACT: 'exact',
  SEMANTIC: 'semantic',
});

class TokenBudgetManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this._hourlyBudget = options.hourlyBudget ?? 50000;
    this._dailyBudget = options.dailyBudget ?? 500000;
    this._strategy = options.strategy || BUDGET_STRATEGY.ADAPTIVE;

    this._coreRatios = {
      consciousness: options.consciousnessRatio ?? 0.6,
      execution: options.executionRatio ?? 0.3,
      evolution: options.evolutionRatio ?? 0.1,
    };

    this._coreBudgets = new Map();

    this._throttleLevel = THROTTLE_LEVEL.NONE;
    this._throttleHistory = [];

    this._cachePolicy = options.cachePolicy || CACHE_POLICY.EXACT;
    this._cache = new Map();
    this._cacheMaxSize = options.cacheMaxSize ?? 200;
    this._cacheTTL = options.cacheTTL ?? 300000;

    this._batchQueue = new Map();
    this._batchTimer = null;
    this._batchInterval = options.batchInterval ?? 2000;
    this._batchMaxSize = options.batchMaxSize ?? 5;

    this._usageHistory = [];
    this._windowStartHour = Date.now();
    this._windowStartDay = Date.now();

    this._economyModelMapping = options.economyModelMapping || {
      [THROTTLE_LEVEL.LIGHT]: { consciousness: 'execution', execution: 'execution', evolution: 'evolution' },
      [THROTTLE_LEVEL.MODERATE]: { consciousness: 'evolution', execution: 'execution', evolution: 'evolution' },
      [THROTTLE_LEVEL.HEAVY]: { consciousness: null, execution: 'execution', evolution: null },
      [THROTTLE_LEVEL.EMERGENCY]: { consciousness: null, execution: 'execution', evolution: null },
    };

    this._priceTable = options.priceTable || {
      consciousness: { input: 0.003, output: 0.015 },
      execution: { input: 0.00015, output: 0.0006 },
      evolution: { input: 0.0001, output: 0.0002 },
    };
  }

  initCore(coreName, config = {}) {
    const ratio = config.ratio ?? this._coreRatios[coreName] ?? 0.3;
    this._coreRatios[coreName] = ratio;
    this._coreBudgets.set(coreName, {
      ratio,
      hourlyBudget: Math.floor(this._hourlyBudget * ratio),
      dailyBudget: Math.floor(this._dailyBudget * ratio),
      hourlyUsed: 0,
      dailyUsed: 0,
      maxTokensPerCall: config.maxTokensPerCall ?? 4096,
      minReserve: config.minReserve ?? 500,
      totalUsed: 0,
      callCount: 0,
      skippedCount: 0,
      cachedCount: 0,
    });
  }

  requestTokens(coreName, estimatedTokens, options = {}) {
    const { priority = CALL_PRIORITY.NORMAL, callType = 'default', cacheKey = null } = options;

    if (cacheKey && this._cachePolicy !== CACHE_POLICY.NONE) {
      const cached = this._checkCache(cacheKey);
      if (cached) {
        const budget = this._coreBudgets.get(coreName);
        if (budget) budget.cachedCount++;
        this.emit('cache_hit', { core: coreName, cacheKey, tokensSaved: cached.usage?.total_tokens || 0 });
        return { allowed: true, throttleLevel: this._throttleLevel, adjustedMaxTokens: 0, suggestedPurpose: null, fromCache: true, cacheResult: cached.result };
      }
    }

    this._updateThrottleLevel();
    const decision = this._evaluateRequest(coreName, estimatedTokens, priority, callType);

    if (decision.allowed) {
      this._reserveTokens(coreName, decision.adjustedMaxTokens || estimatedTokens);
    } else {
      const budget = this._coreBudgets.get(coreName);
      if (budget) budget.skippedCount++;
      this.emit('request_denied', { core: coreName, estimatedTokens, priority, callType, throttleLevel: this._throttleLevel, reason: decision.reason });
    }

    return decision;
  }

  reportUsage(coreName, usage, result = null, cacheKey = null) {
    if (!usage) return;
    const totalTokens = usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    const budget = this._coreBudgets.get(coreName);
    if (!budget) return;

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const priceConfig = this._priceTable[coreName] || this._priceTable.execution;
    const cost = (promptTokens / 1000) * priceConfig.input + (completionTokens / 1000) * priceConfig.output;

    this._usageHistory.push({ core: coreName, promptTokens, completionTokens, totalTokens, cost, throttleLevel: this._throttleLevel, timestamp: Date.now() });
    if (this._usageHistory.length > 1000) this._usageHistory = this._usageHistory.slice(-1000);

    if (cacheKey && this._cachePolicy !== CACHE_POLICY.NONE && result) {
      this._storeCache(cacheKey, { result, usage, timestamp: Date.now() });
    }
    this.emit('usage_reported', { core: coreName, totalTokens, cost });
  }

  _updateThrottleLevel() {
    this._resetWindowsIfNeeded();
    let totalHourlyUsed = 0;
    for (const budget of this._coreBudgets.values()) totalHourlyUsed += budget.hourlyUsed;
    const hourlyUsageRate = totalHourlyUsed / this._hourlyBudget;

    let newLevel;
    if (hourlyUsageRate < 0.5) newLevel = THROTTLE_LEVEL.NONE;
    else if (hourlyUsageRate < 0.7) newLevel = THROTTLE_LEVEL.LIGHT;
    else if (hourlyUsageRate < 0.85) newLevel = THROTTLE_LEVEL.MODERATE;
    else if (hourlyUsageRate < 0.95) newLevel = THROTTLE_LEVEL.HEAVY;
    else newLevel = THROTTLE_LEVEL.EMERGENCY;

    if (newLevel !== this._throttleLevel) {
      const oldLevel = this._throttleLevel;
      this._throttleLevel = newLevel;
      this._throttleHistory.push({ from: oldLevel, to: newLevel, hourlyUsageRate, timestamp: Date.now() });
      this.emit('throttle_changed', { from: oldLevel, to: newLevel, hourlyUsageRate });
    }
  }

  _evaluateRequest(coreName, estimatedTokens, priority, callType) {
    const budget = this._coreBudgets.get(coreName);
    if (!budget) return { allowed: false, reason: 'Unknown core', throttleLevel: this._throttleLevel, adjustedMaxTokens: 0, suggestedPurpose: null, fromCache: false };

    if (this._throttleLevel === THROTTLE_LEVEL.EMERGENCY) {
      if (coreName !== 'execution' || priority < CALL_PRIORITY.CRITICAL) {
        return { allowed: false, reason: 'Emergency throttle', throttleLevel: this._throttleLevel, adjustedMaxTokens: 0, suggestedPurpose: null, fromCache: false };
      }
    }

    if (this._throttleLevel === THROTTLE_LEVEL.HEAVY) {
      if (priority <= CALL_PRIORITY.LOW || callType === 'idle_think') {
        return { allowed: false, reason: 'Heavy throttle', throttleLevel: this._throttleLevel, adjustedMaxTokens: 0, suggestedPurpose: null, fromCache: false };
      }
    }

    if (budget.hourlyUsed + estimatedTokens > budget.hourlyBudget) {
      if (priority >= CALL_PRIORITY.HIGH) {
        const borrowed = this._borrowTokens(coreName, estimatedTokens);
        if (!borrowed) return { allowed: false, reason: 'Budget exhausted', throttleLevel: this._throttleLevel, adjustedMaxTokens: 0, suggestedPurpose: null, fromCache: false };
      } else {
        return { allowed: false, reason: 'Budget insufficient', throttleLevel: this._throttleLevel, adjustedMaxTokens: 0, suggestedPurpose: null, fromCache: false };
      }
    }

    let adjustedMaxTokens = estimatedTokens;
    if (this._throttleLevel === THROTTLE_LEVEL.LIGHT) adjustedMaxTokens = Math.min(estimatedTokens, Math.floor(budget.maxTokensPerCall * 0.7));
    else if (this._throttleLevel === THROTTLE_LEVEL.MODERATE) adjustedMaxTokens = Math.min(estimatedTokens, Math.floor(budget.maxTokensPerCall * 0.5));

    const suggestedPurpose = this._getSuggestedPurpose(coreName);
    return { allowed: true, throttleLevel: this._throttleLevel, adjustedMaxTokens, suggestedPurpose, fromCache: false };
  }

  _getSuggestedPurpose(coreName) {
    if (this._throttleLevel === THROTTLE_LEVEL.NONE) return null;
    const mapping = this._economyModelMapping[this._throttleLevel];
    if (!mapping) return null;
    return mapping[coreName] || null;
  }

  _borrowTokens(fromCore, amount) {
    let bestLender = null, maxAvailable = 0;
    for (const [coreName, budget] of this._coreBudgets) {
      if (coreName === fromCore) continue;
      const available = budget.hourlyBudget - budget.hourlyUsed;
      if (available > maxAvailable) { maxAvailable = available; bestLender = coreName; }
    }
    if (bestLender && maxAvailable >= amount) { this.emit('budget_borrowed', { from: bestLender, to: fromCore, amount }); return true; }
    return false;
  }

  _reserveTokens(coreName, amount) {
    const budget = this._coreBudgets.get(coreName);
    if (!budget) return;
    budget.hourlyUsed += amount; budget.dailyUsed += amount; budget.totalUsed += amount; budget.callCount++;
  }

  _resetWindowsIfNeeded() {
    const now = Date.now();
    if (now - this._windowStartHour >= 3600000) { for (const b of this._coreBudgets.values()) b.hourlyUsed = 0; this._windowStartHour = now; this.emit('hourly_reset'); }
    if (now - this._windowStartDay >= 86400000) { for (const b of this._coreBudgets.values()) b.dailyUsed = 0; this._windowStartDay = now; this.emit('daily_reset'); }
  }

  _checkCache(cacheKey) {
    const cached = this._cache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this._cacheTTL) { this._cache.delete(cacheKey); return null; }
    return cached;
  }

  _storeCache(cacheKey, data) {
    if (this._cache.size >= this._cacheMaxSize) { const k = this._cache.keys().next().value; this._cache.delete(k); }
    this._cache.set(cacheKey, data);
  }

  generateCacheKey(messages, purpose) {
    const content = messages.map(m => `${m.role}:${m.content}`).join('|');
    let hash = 0;
    for (let i = 0; i < content.length; i++) { const c = content.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash |= 0; }
    return `${purpose}:${Math.abs(hash).toString(36)}`;
  }

  clearCache() { this._cache.clear(); }

  adaptBudgetAllocation() {
    if (this._strategy !== BUDGET_STRATEGY.ADAPTIVE) return;
    const recentUsage = this._usageHistory.filter(h => Date.now() - h.timestamp < 3600000);
    if (recentUsage.length < 10) return;
    const coreUsage = {};
    for (const h of recentUsage) coreUsage[h.core] = (coreUsage[h.core] || 0) + h.totalTokens;
    const total = Object.values(coreUsage).reduce((s, v) => s + v, 0);
    if (total === 0) return;
    const DAMPING = 0.3;
    for (const [core, usage] of Object.entries(coreUsage)) {
      const actualRatio = usage / total;
      const currentRatio = this._coreRatios[core] || 0.3;
      this._coreRatios[core] = Math.max(0.05, Math.min(0.8, DAMPING * actualRatio + (1 - DAMPING) * currentRatio));
    }
    for (const [coreName, budget] of this._coreBudgets) {
      budget.ratio = this._coreRatios[coreName];
      budget.hourlyBudget = Math.floor(this._hourlyBudget * budget.ratio);
      budget.dailyBudget = Math.floor(this._dailyBudget * budget.ratio);
    }
    this.emit('budget_adapted', { ratios: { ...this._coreRatios } });
  }

  getStatus() {
    const coreStatus = {};
    for (const [name, budget] of this._coreBudgets) {
      coreStatus[name] = { ratio: budget.ratio, hourlyBudget: budget.hourlyBudget, hourlyUsed: budget.hourlyUsed, hourlyRemaining: Math.max(0, budget.hourlyBudget - budget.hourlyUsed), hourlyUsageRate: budget.hourlyBudget > 0 ? (budget.hourlyUsed / budget.hourlyBudget * 100).toFixed(1) + '%' : '0%', dailyBudget: budget.dailyBudget, dailyUsed: budget.dailyUsed, totalUsed: budget.totalUsed, callCount: budget.callCount, skippedCount: budget.skippedCount, cachedCount: budget.cachedCount };
    }
    const recentHour = this._usageHistory.filter(h => Date.now() - h.timestamp < 3600000);
    const hourlyCost = recentHour.reduce((s, h) => s + h.cost, 0);
    const recentDay = this._usageHistory.filter(h => Date.now() - h.timestamp < 86400000);
    const dailyCost = recentDay.reduce((s, h) => s + h.cost, 0);
    return { throttleLevel: this._throttleLevel, strategy: this._strategy, coreRatios: { ...this._coreRatios }, cores: coreStatus, cacheSize: this._cache.size, estimatedCost: { hourly: hourlyCost.toFixed(4), daily: dailyCost.toFixed(4) } };
  }

  resetBudgets() {
    for (const b of this._coreBudgets.values()) { b.hourlyUsed = 0; b.dailyUsed = 0; }
    this._throttleLevel = THROTTLE_LEVEL.NONE; this._windowStartHour = Date.now(); this._windowStartDay = Date.now();
    this.emit('budgets_reset');
  }

  setHourlyBudget(tokens) {
    this._hourlyBudget = tokens;
    for (const [coreName, budget] of this._coreBudgets) budget.hourlyBudget = Math.floor(tokens * budget.ratio);
    this.emit('budget_changed', { hourlyBudget: tokens });
  }
}

module.exports = { TokenBudgetManager, THROTTLE_LEVEL, CALL_PRIORITY, BUDGET_STRATEGY, CACHE_POLICY };
