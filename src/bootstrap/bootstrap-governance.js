'use strict';

const { CoreBus } = require('../bus/core-bus');
const { SecurityBoundary } = require('../security/security-boundary');
const { TokenBudgetManager, BUDGET_STRATEGY, CACHE_POLICY } = require('../budget/token-budget-manager');

/**
 * Bootstrap: 治理层（v2.0新增：三大中间件）
 *
 * 职责：
 *   1. 核心总线 (CoreBus) - 统一事件通道
 *   2. 安全边界 (SecurityBoundary) - 三条铁律 + 授权网关
 *   3. Token预算管理器 (TokenBudgetManager) - 三层预算 + 自动节流
 *
 * 依赖：
 *   - CoreBus 需在 SecurityBoundary 和 TokenBudgetManager 之前初始化
 *   - ErrorHandler._bus 在 CoreBus 创建后注入
 */

/**
 * 初始化治理层模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // 1. 核心总线 - 统一事件通道
  agent._bus = new CoreBus({
    debugMode: options.debugMode ?? false,
    maxLogSize: 10000,
  });

  // 将总线注入错误处理器
  agent._errorHandler._bus = agent._bus;

  // 2. 安全边界 - 三条铁律 + 授权网关
  agent._security = new SecurityBoundary({
    maxConsciousnessTaskBudget: options.maxConsciousnessTaskBudget ?? 10000,
    maxAutonomousSteps: options.maxAutonomousSteps ?? 5,
    maxIdleThinkPerHour: options.maxIdleThinkPerHour ?? 6,
  });

  // 3. Token预算管理器 - 三层预算 + 自动节流
  agent._budget = new TokenBudgetManager({
    hourlyBudget: options.hourlyBudget ?? 50000,
    dailyBudget: options.dailyBudget ?? 500000,
    strategy: options.budgetStrategy || BUDGET_STRATEGY.ADAPTIVE,
    consciousnessRatio: options.consciousnessBudgetRatio ?? 0.6,
    executionRatio: options.executionBudgetRatio ?? 0.3,
    evolutionRatio: options.evolutionBudgetRatio ?? 0.1,
    cachePolicy: CACHE_POLICY.EXACT,
  });

  // 初始化三层预算
  agent._budget.initCore('consciousness', { ratio: options.consciousnessBudgetRatio ?? 0.6 });
  agent._budget.initCore('execution', { ratio: options.executionBudgetRatio ?? 0.3 });
  agent._budget.initCore('evolution', { ratio: options.evolutionBudgetRatio ?? 0.1 });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // 治理层事件绑定在 index.js 的 _bindGovernanceEvents() 中处理
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // 治理层在构造函数中完成初始化，无额外启动逻辑
}

module.exports = { init, bindEvents, startup };
