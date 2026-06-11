'use strict';

const path = require('path');

const { ConsciousnessCore } = require('../core/consciousness-core');
const { ExecutionCore } = require('../core/execution-core');
const { EvolutionCore } = require('../core/evolution-core');

/**
 * Bootstrap: 三核（意识核 + 执行核 + 进化核）
 *
 * 职责：
 *   1. ConsciousnessCore - TICK驱动，自主思考，焦点栈注意力
 *   2. ExecutionCore - 任务闭环，桌面控制，插件生态
 *   3. EvolutionCore - 技能沉淀，知识积累，自我进化
 *
 * 依赖（已注入治理层）：
 *   - bus (CoreBus)
 *   - security (SecurityBoundary)
 *   - budget (TokenBudgetManager)
 *   - memory (MemoryEngine)
 *   - router (ModelRouter)
 */

/**
 * 初始化三核模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── 意识核 ──
  agent._consciousness = new ConsciousnessCore({
    memory: agent._memory,
    router: agent._router,
    awakeningTicks: options.awakeningTicks ?? 10,
    bus: agent._bus,              // 注入总线
    security: agent._security,    // 注入安全边界
    budget: agent._budget,        // 注入预算管理器
  });

  // ── 执行核 ──
  agent._execution = new ExecutionCore({
    memory: agent._memory,
    router: agent._router,
    sandboxDir: path.join(agent._dataDir, 'sandbox'),
    maxRetries: 3,
    bus: agent._bus,
    security: agent._security,
    budget: agent._budget,
  });

  // ── 进化核 ──
  agent._evolution = new EvolutionCore({
    memory: agent._memory,
    router: agent._router,
    consolidationInterval: 30 * 60 * 1000,
    bus: agent._bus,
    security: agent._security,
    budget: agent._budget,
  });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // 三核事件绑定在 index.js 的 _bindCoreEvents() 中处理
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // 三核没有额外的启动逻辑
}

module.exports = { init, bindEvents, startup };
