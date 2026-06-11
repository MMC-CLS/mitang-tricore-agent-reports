'use strict';

const path = require('path');

const { UnifiedScheduler } = require('../scheduler/unified-scheduler');
const { MemoryEngine } = require('../memory/memory-engine');
const { ModelRouter, ROUTE_STRATEGY } = require('../providers/model-router');

/**
 * Bootstrap: 基础设施层（Scheduler + MemoryEngine + ModelRouter）
 *
 * 职责：
 *   1. UnifiedScheduler - 统一调度器，TICK驱动
 *   2. MemoryEngine - 记忆引擎，分层存储
 *   3. ModelRouter - 多模型协同路由，成本感知
 *
 * 依赖：
 *   - ModelRouter 需要 TokenBudgetManager（注入实现成本感知）
 */

/**
 * 初始化基础设施层模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── UnifiedScheduler ──
  agent._scheduler = new UnifiedScheduler({
    awakeningTicks: options.awakeningTicks ?? 10,
    maxConsciousnessTicksPerHour: options.maxConsciousnessTicksPerHour ?? 12,
    watchdogTimeout: options.watchdogTimeout ?? 180_000,
  });

  // ── MemoryEngine ──
  agent._memory = new MemoryEngine({
    dbPath: path.join(agent._dataDir, 'memory.db'),
    embeddingCacheSize: options.embeddingCacheSize ?? 500,
  });

  // ── ModelRouter（注入 BudgetManager 实现成本感知） ──
  agent._router = new ModelRouter({
    strategy: options.routeStrategy || ROUTE_STRATEGY.LAYER_OPTIMAL,
    budgetManager: agent._budget,
  });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // 基础设施层事件绑定在 index.js 的 _bindSchedulerEvents() 中处理
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // 基础设施层没有额外的启动逻辑
}

module.exports = { init, bindEvents, startup };
