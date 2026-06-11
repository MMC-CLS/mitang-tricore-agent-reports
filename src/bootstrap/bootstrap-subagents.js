'use strict';

const path = require('path');

const { SubAgentManager } = require('../subagent/subagent-manager');
const { SubAgentGuardian } = require('../subagent/subagent-guardian');
const { SubAgentScheduler, SCHEDULE_STRATEGY } = require('../subagent/subagent-scheduler');
const { TeamManager } = require('../subagent/team-manager');
const { MessageProcessor } = require('../subagent/message-processor');
const { MemoryNetworkGraph, CLUSTER_MODE, LAYOUT_MODE } = require('../subagent/memory-network-graph');
const { PersistenceStore } = require('../subagent/persistence-store');

/**
 * Bootstrap: 子智能体层 + 团队协作层 + 消息处理 + 记忆网络图 + 持久化
 *
 * 职责：
 *   1. SubAgentManager - 创建/配置/生命周期
 *   2. SubAgentGuardian - 安全边界/权限控制/行为审计
 *   3. SubAgentScheduler - 任务分配/负载均衡/资源调度
 *   4. TeamManager - 团队创建/成员管理/共识/消息
 *   5. MessageProcessor - 量子态管道/情感向量/DAG追踪
 *   6. MemoryNetworkGraph - 五层力导向/脉冲星/黑洞效应
 *   7. PersistenceStore - SQLite统一持久化
 */

/**
 * 初始化子智能体层与消息处理模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── SubAgentManager ──
  agent._subAgentManager = new SubAgentManager({
    logger: agent._logger,
    dataDir: path.join(agent._dataDir, 'subagents'),
    maxSubAgents: options.maxSubAgents || 50,
    heartbeatInterval: options.subAgentHeartbeatInterval || 10000,
    heartbeatTimeout: options.subAgentHeartbeatTimeout || 30000,
  });

  // ── SubAgentGuardian ──
  agent._subAgentGuardian = new SubAgentGuardian({
    logger: agent._logger,
    subAgentManager: agent._subAgentManager,
    securityBoundary: agent._security,
    maxTasksPerMinute: options.subAgentMaxTasksPerMinute || 20,
    maxFailRate: options.subAgentMaxFailRate || 0.5,
    minSafetyScore: options.subAgentMinSafetyScore || 20,
    lockdownDurationMs: options.subAgentLockdownDurationMs || 300000,
    monitorInterval: options.subAgentMonitorInterval || 30000,
  });

  // ── SubAgentScheduler ──
  agent._subAgentScheduler = new SubAgentScheduler({
    logger: agent._logger,
    subAgentManager: agent._subAgentManager,
    guardian: agent._subAgentGuardian,
    strategy: options.subAgentScheduleStrategy || SCHEDULE_STRATEGY.ADAPTIVE,
    maxRetries: options.subAgentMaxRetries || 3,
    retryDelay: options.subAgentRetryDelay || 2000,
    maxConcurrentTasks: options.subAgentMaxConcurrentTasks || 100,
    taskTimeout: options.subAgentTaskTimeout || 300000,
    schedulerInterval: options.subAgentSchedulerInterval || 5000,
  });

  // 恢复持久化的子智能体
  const restored = agent._subAgentManager.restore();
  if (restored > 0) {
    agent._logger.info(`恢复 ${restored} 个子智能体`);
  }

  // ── TeamManager ──
  agent._teamManager = new TeamManager({
    logger: agent._logger,
    dataDir: path.join(agent._dataDir, 'teams'),
    subAgentManager: agent._subAgentManager,
    maxTeams: options.maxTeams || 30,
    maxMembersPerTeam: options.maxMembersPerTeam || 10,
  });

  // 将 TeamManager 注入 SubAgentManager
  agent._subAgentManager.setTeamManager(agent._teamManager);

  // 恢复持久化的团队
  const restoredTeams = agent._teamManager.restore();
  if (restoredTeams > 0) {
    agent._logger.info(`恢复 ${restoredTeams} 个团队`);
  }

  // ── MessageProcessor ──
  agent._messageProcessor = new MessageProcessor({
    maxPipelineDepth: options.msgPipelineDepth || 50,
    analysisTimeout: options.msgAnalysisTimeout || 5000,
    enableAffectTracking: options.enableAffectTracking !== false,
    enableQuantumMarking: options.enableQuantumMarking !== false,
    enableDAGTracing: options.enableDAGTracing !== false,
  });

  // ── MemoryNetworkGraph ──
  agent._memoryNetworkGraph = new MemoryNetworkGraph({
    maxNodes: options.memGraphMaxNodes || 200,
    maxEdges: options.memGraphMaxEdges || 500,
    clusterMode: options.memGraphClusterMode || CLUSTER_MODE.HYBRID,
    layoutMode: options.memGraphLayoutMode || LAYOUT_MODE.FORCE,
    enablePulsarEffect: options.enablePulsarEffect !== false,
    enableEntangledEdges: options.enableEntangledEdges !== false,
    enableBlackHoleEffect: options.enableBlackHoleEffect !== false,
    updateInterval: options.memGraphUpdateInterval || 5000,
  });

  agent._logger.info('消息处理器与记忆网络图引擎已初始化');

  // ── PersistenceStore ──
  agent._persistenceStore = new PersistenceStore({
    db: agent._memory?._db || null,
    logger: agent._logger,
    maxPipelineAge: options.persistPipelineMaxAge || 24 * 3600 * 1000,
    maxGraphSnapshots: options.persistGraphMaxSnapshots || 50,
    flushInterval: options.persistFlushInterval || 5000,
  });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // 子智能体层事件绑定由内部模块自行处理
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // 子智能体层启动逻辑由 index.js start() 直接处理
}

module.exports = { init, bindEvents, startup };
