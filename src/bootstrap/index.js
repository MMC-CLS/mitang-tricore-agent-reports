'use strict';

const logger = require('./bootstrap-logger');
const infrastructure = require('./bootstrap-infrastructure');
const governance = require('./bootstrap-governance');
const foundation = require('./bootstrap-foundation');
const tricore = require('./bootstrap-tricore');
const extensions = require('./bootstrap-extensions');
const collaboration = require('./bootstrap-collaboration');
const subagents = require('./bootstrap-subagents');
const llm = require('./bootstrap-llm');
const enterprise = require('./bootstrap-enterprise');
const v4 = require('./bootstrap-v4');
const plugins = require('./bootstrap-plugins');

/**
 * 所有 bootstrap 模块的 init 函数列表（按依赖顺序排列）
 *
 * 依赖顺序：
 *   1. Logger / ErrorHandler（无依赖）
 *   2. Infrastructure（依赖 Logger）
 *   3. Governance（依赖 ErrorHandler 用于 _bus 注入）
 *   4. Foundation（依赖 BudgetManager）
 *   5. TriCore（依赖 Foundation + Governance）
 *   6. Extensions（依赖 Foundation）
 *   7. Collaboration（无特殊依赖）
 *   8. SubAgents（依赖 Logger + Security + SubAgentManager）
 *   9. LLM（依赖 Foundation + Governance）
 *   10. Enterprise（依赖 Logger + Memory）
 *   11. v4（依赖 Logger）
 *   12. Plugins（依赖 TriCore + Extensions 之后的各模块）
 */
const modules = [
  logger,
  infrastructure,
  governance,
  foundation,
  tricore,
  extensions,
  collaboration,
  subagents,
  llm,
  enterprise,
  v4,
  plugins,
];

/**
 * 按依赖顺序初始化所有模块并挂载到 agent 上
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function bootstrapAll(agent, options) {
  for (const mod of modules) {
    mod.init(agent, options);
  }
}

/**
 * 按依赖顺序调用所有模块的 bindEvents
 * @param {TriCoreAgent} agent - Agent 实例
 */
function bindAllEvents(agent) {
  for (const mod of modules) {
    if (typeof mod.bindEvents === 'function') {
      mod.bindEvents(agent);
    }
  }
}

/**
 * 按依赖顺序调用所有模块的 startup
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} config - 启动配置
 */
function startupAll(agent, config) {
  for (const mod of modules) {
    if (typeof mod.startup === 'function') {
      mod.startup(agent, config);
    }
  }
}

module.exports = { bootstrapAll, bindAllEvents, startupAll };
