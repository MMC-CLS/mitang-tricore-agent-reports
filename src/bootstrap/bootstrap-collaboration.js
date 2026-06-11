'use strict';

const path = require('path');

const { AgentCoordination } = require('../coordination/agent-coordination');
const { SkillMarket } = require('../market/skill-market');
const { ProcessManager } = require('../deploy/process-manager');

/**
 * Bootstrap: 协作层 + 部署层
 *
 * 职责：
 *   1. AgentCoordination - 注册发现/任务分配/消息传递
 *   2. SkillMarket - 发布/搜索/下载/评分
 *   3. ProcessManager - 守护/健康检查/日志/监控
 */

/**
 * 初始化协作层与部署层模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── AgentCoordination ──
  agent._coordination = new AgentCoordination({
    localAgent: agent,
  });

  // ── SkillMarket ──
  agent._skillMarket = new SkillMarket({
    downloadDir: path.join(agent._dataDir, 'skill_market'),
  });

  // ── ProcessManager ──
  agent._processManager = new ProcessManager({
    logDir: path.join(agent._dataDir, 'logs'),
  });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // 协作层没有需要从外部绑定的事件
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // 协作层启动逻辑由 index.js start() 直接处理
}

module.exports = { init, bindEvents, startup };
