/**
 * 蜜糖 TriCore Agent - 子智能体管理器 (Sub-Agent Manager)
 *
 * 核心职责：
 *   1. 子智能体的创建与销毁（全生命周期管理）
 *   2. 子智能体配置管理（类型、资源配额、安全等级）
 *   3. 子智能体状态监控（运行状态、心跳检测）
 *   4. 子智能体注册表（ID索引、快速查找）
 *   5. 子智能体能力声明与匹配
 *
 * 子智能体类型：
 *   - assistant:  通用对话助手
 *   - analyst:    数据分析专用
 *   - executor:   任务执行专用
 *   - monitor:    监控守护专用
 *   - custom:     自定义类型
 *
 * 安全等级：
 *   - low:      基础监控（允许所有操作，仅记录日志）
 *   - medium:   标准防护（关键操作需确认）
 *   - high:     严格沙箱（隔离执行，限制资源访问）
 *   - maximum:  完全隔离（只读观察，禁止修改）
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { SubAgentEngine } = require('./subagent-engine');
const { SubAgentWebSocket } = require('./subagent-websocket');
const { SubAgentSkillInstaller } = require('./subagent-skill-installer');
const { SubAgentMemoryBinder } = require('./subagent-memory-binder');

// ── 常量 ──

const SUBAGENT_TYPE = Object.freeze({
  ASSISTANT: 'assistant',
  ANALYST: 'analyst',
  EXECUTOR: 'executor',
  MONITOR: 'monitor',
  CUSTOM: 'custom',
});

const SUBAGENT_STATUS = Object.freeze({
  CREATING: 'creating',
  PENDING: 'pending',
  RUNNING: 'running',
  STOPPED: 'stopped',
  ERROR: 'error',
  DESTROYED: 'destroyed',
});

const SAFETY_LEVEL = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  MAXIMUM: 'maximum',
});

const QUOTA_LEVEL = Object.freeze({
  MINIMAL: 'minimal',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

const QUOTA_MAP = {
  minimal: 0.10,
  low: 0.25,
  medium: 0.50,
  high: 0.75,
};

const DEFAULT_CONFIG = {
  maxSubAgents: 50,
  heartbeatInterval: 10000,
  heartbeatTimeout: 30000,
  maxTaskQueuePerAgent: 100,
  sandboxBaseDir: null,
};

class SubAgentInstance {
  constructor(options = {}) {
    this.id = options.id || `sa_${crypto.randomUUID().slice(0, 8)}`;
    this.name = options.name || '未命名子智能体';
    this.type = options.type || SUBAGENT_TYPE.ASSISTANT;
    this.description = options.description || '';
    this.status = SUBAGENT_STATUS.CREATING;
    this.safetyLevel = options.safetyLevel || SAFETY_LEVEL.MEDIUM;
    this.quota = options.quota || QUOTA_LEVEL.MEDIUM;

    // 运行时数据
    this.capabilities = options.capabilities || this._defaultCapabilities();
    this.tasks = [];           // 任务队列
    this.taskResults = [];     // 任务结果历史
    this.violations = [];      // 安全违规记录
    this.performance = {       // 性能统计
      tasksCompleted: 0,
      tasksFailed: 0,
      avgResponseTime: 0,
      totalTokensUsed: 0,
    };

    // 时间戳
    this.createdAt = options.createdAt || Date.now();
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastHeartbeat = null;
    this.lastActive = null;

    // 安全评分
    this.safetyScore = 100;

    // 父Agent引用
    this._parent = options.parent || null;

    // 资源限制
    this._maxTasks = options.maxTasks || 100;
    this._resourceQuota = QUOTA_MAP[this.quota] || 0.5;

    // v2.8: 团队关联
    this.teams = options.teams || [];          // 所属团队ID列表
    this.teamRoles = options.teamRoles || {};  // teamId → role
    this.displayName = options.displayName || this.name; // 显示名称（支持独立命名）
  }

  _defaultCapabilities() {
    const caps = {
      [SUBAGENT_TYPE.ASSISTANT]: ['conversation', 'knowledge_retrieval', 'summarization'],
      [SUBAGENT_TYPE.ANALYST]: ['data_analysis', 'report_generation', 'visualization'],
      [SUBAGENT_TYPE.EXECUTOR]: ['task_execution', 'file_operations', 'automation'],
      [SUBAGENT_TYPE.MONITOR]: ['health_check', 'alerting', 'logging'],
      [SUBAGENT_TYPE.CUSTOM]: [],
    };
    return caps[this.type] || caps[SUBAGENT_TYPE.ASSISTANT];
  }

  getSummary() {
    return {
      id: this.id,
      name: this.name,
      displayName: this.displayName,
      type: this.type,
      description: this.description,
      status: this.status,
      safetyLevel: this.safetyLevel,
      quota: this.quota,
      capabilities: this.capabilities,
      safetyScore: this.safetyScore,
      performance: {
        tasksCompleted: this.performance.tasksCompleted,
        tasksFailed: this.performance.tasksFailed,
      },
      createdAt: this.createdAt,
      lastActive: this.lastActive,
      violations: this.violations.length,
      // v2.8: 团队关联
      teams: this.teams,
      teamRoles: this.teamRoles,
    };
  }

  getDetail() {
    return {
      ...this.getSummary(),
      taskQueue: this.tasks.length,
      taskResults: this.taskResults.slice(-10),
      violations: this.violations.slice(-20),
      performance: { ...this.performance },
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastHeartbeat: this.lastHeartbeat,
      safetyReport: {
        score: this.safetyScore,
        violations: this.violations.length,
        recentViolations: this.violations.slice(-5),
        lastActive: this.lastActive,
      },
    };
  }
}

class SubAgentManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._config = { ...DEFAULT_CONFIG, ...options };
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data', 'subagents');

    // 子智能体注册表
    this._agents = new Map();  // agentId → SubAgentInstance

    // 子智能体引擎映射（v2.7新增 - 独立对话能力）
    this._engines = new Map();  // agentId → SubAgentEngine

    // WebSocket通信通道（v2.7新增）
    this._websocket = null;

    // v2.8: 团队管理器引用
    this._teamManager = options.teamManager || null;

    // v2.9: 技能安装器与记忆绑定器
    this._skillInstaller = new SubAgentSkillInstaller({
      logger: this._logger,
      dataDir: this._dataDir,
      memoryEngine: options.memoryEngine || null,
      guardian: options.guardian || null,
    });

    this._memoryBinder = new SubAgentMemoryBinder({
      logger: this._logger,
      dataDir: this._dataDir,
      parentMemoryEngine: options.memoryEngine || null,
    });

    // 全局锁
    this._globalLock = false;

    // 安全统计数据
    this._safetyStats = {
      totalViolations: 0,
      blockedActions: 0,
      safetyAlerts: 0,
    };

    // 确保数据目录存在
    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir, { recursive: true });
    }

    // 心跳定时器
    this._heartbeatTimer = null;
  }

  // ═══════════════════════════════════════
  // WebSocket 通信初始化（v2.7新增）
  // ═══════════════════════════════════════

  /**
   * 初始化WebSocket通道
   */
  initWebSocket(options = {}) {
    this._websocket = new SubAgentWebSocket({
      logger: this._logger,
      subAgentManager: this,
      guardian: options.guardian || null,
      heartbeatInterval: options.wsHeartbeatInterval || 30000,
      heartbeatTimeout: options.wsHeartbeatTimeout || 60000,
      maxConnectionsPerAgent: options.wsMaxConnectionsPerAgent || 10,
    });

    // 监听WebSocket事件
    this._websocket.on('client_connected', ({ clientId }) => {
      this.emit('ws_client_connected', { clientId });
    });

    this._websocket.on('client_disconnected', ({ clientId, reason }) => {
      this.emit('ws_client_disconnected', { clientId, reason });
    });

    this._logger.info('[SubAgentManager] WebSocket通道已初始化');
    return this._websocket;
  }

  /**
   * 获取WebSocket实例
   */
  getWebSocket() {
    return this._websocket;
  }

  // ═══════════════════════════════════════
  // 子智能体引擎管理（v2.7新增 - 独立对话）
  // ═══════════════════════════════════════

  /**
   * 为子智能体创建并启动引擎
   */
  async initEngine(agentId, engineOptions = {}) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    // 检查是否已存在
    if (this._engines.has(agentId)) {
      return { success: true, engineId: agentId, message: '引擎已存在' };
    }

    const engine = new SubAgentEngine({
      logger: this._logger,
      agentId: agent.id,
      agentName: agent.name,
      agentType: agent.type,
      agentDescription: agent.description,
      safetyLevel: agent.safetyLevel,
      quota: agent.quota,
      capabilities: engineOptions.capabilities || agent.capabilities,
      systemPrompt: engineOptions.systemPrompt || null,
      parentAgent: engineOptions.parentAgent || null,
      guardian: engineOptions.guardian || null,
      manager: this,
      dataDir: path.join(this._dataDir, agentId, 'engine'),
      llmProvider: engineOptions.llmProvider || null,
      llmModel: engineOptions.llmModel || null,
      maxSessions: engineOptions.maxSessions || 20,
      maxMessagesPerSession: engineOptions.maxMessagesPerSession || 500,
      // v2.9: 技能与记忆系统
      skillInstaller: this._skillInstaller,
      memoryBinder: this._memoryBinder,
    });

    // 绑定引擎事件到WebSocket广播
    engine.on('started', (data) => {
      if (this._websocket) {
        this._websocket.broadcastEngineEvent(agentId, 'started', data);
      }
      this.emit('engine_started', { agentId, ...data });
    });

    engine.on('stopped', (data) => {
      if (this._websocket) {
        this._websocket.broadcastEngineEvent(agentId, 'stopped', data);
      }
      this.emit('engine_stopped', { agentId, ...data });
    });

    engine.on('thinking_started', (data) => {
      if (this._websocket) {
        this._websocket.broadcastStateChange(agentId, 'thinking');
      }
    });

    engine.on('executing_started', (data) => {
      if (this._websocket) {
        this._websocket.broadcastStateChange(agentId, 'executing');
      }
    });

    engine.on('response_generated', (data) => {
      if (this._websocket) {
        this._websocket.broadcastToAgent(agentId, {
          type: 'response',
          agentId,
          sessionId: data.sessionId,
          messageId: data.messageId,
          content: data.content,
          metadata: data.metadata,
          timestamp: Date.now(),
        });
        this._websocket.broadcastStateChange(agentId, 'idle');
      }
      this.emit('engine_response', { agentId, ...data });
    });

    engine.on('error', (data) => {
      if (this._websocket) {
        this._websocket.broadcastToAgent(agentId, {
          type: 'error',
          agentId,
          error: data.error,
          timestamp: Date.now(),
        });
      }
      this.emit('engine_error', { agentId, ...data });
    });

    engine.on('session_created', (data) => {
      if (this._websocket) {
        this._websocket.broadcastToAgent(agentId, {
          type: 'session_event',
          agentId,
          event: 'created',
          session: data,
          timestamp: Date.now(),
        });
      }
    });

    engine.on('session_closed', (data) => {
      if (this._websocket) {
        this._websocket.broadcastToAgent(agentId, {
          type: 'session_event',
          agentId,
          event: 'closed',
          sessionId: data.sessionId,
          timestamp: Date.now(),
        });
      }
    });

    this._engines.set(agentId, engine);

    // 启动引擎
    const startResult = await engine.start();
    if (!startResult.success) {
      this._engines.delete(agentId);
      return startResult;
    }

    this._logger.info(`[SubAgentManager] 引擎已创建并启动: "${agent.name}" (${agentId})`);
    return { success: true, engineId: agentId };
  }

  /**
   * 获取子智能体引擎
   */
  getEngine(agentId) {
    return this._engines.get(agentId) || null;
  }

  /**
   * 停止并销毁子智能体引擎
   */
  async destroyEngine(agentId) {
    const engine = this._engines.get(agentId);
    if (engine) {
      await engine.close();
      this._engines.delete(agentId);
      this._logger.info(`[SubAgentManager] 引擎已销毁: ${agentId}`);
    }
    return { success: true };
  }

  /**
   * 向子智能体发送消息（v2.7新增 - 独立对话入口）
   */
  async sendMessageToAgent(agentId, message, sessionId = null, options = {}) {
    const engine = this._engines.get(agentId);
    if (!engine) {
      return { success: false, error: `子智能体引擎未启动: ${agentId}` };
    }

    return engine.sendMessage(message, sessionId, options);
  }

  /**
   * 获取子智能体会话列表（v2.7新增）
   */
  listAgentSessions(agentId) {
    const engine = this._engines.get(agentId);
    if (!engine) return [];
    return engine.listSessions();
  }

  /**
   * 获取子智能体会话详情（v2.7新增）
   */
  getAgentSession(agentId, sessionId) {
    const engine = this._engines.get(agentId);
    if (!engine) return null;
    return engine.getSession(sessionId);
  }

  /**
   * 创建子智能体会话（v2.7新增）
   */
  createAgentSession(agentId, options = {}) {
    const engine = this._engines.get(agentId);
    if (!engine) return { success: false, error: `子智能体引擎未启动: ${agentId}` };
    return engine.createSession(options);
  }

  /**
   * 切换子智能体活跃会话（v2.7新增）
   */
  switchAgentSession(agentId, sessionId) {
    const engine = this._engines.get(agentId);
    if (!engine) return { success: false, error: `子智能体引擎未启动: ${agentId}` };
    return engine.switchSession(sessionId);
  }

  /**
   * 关闭子智能体会话（v2.7新增）
   */
  closeAgentSession(agentId, sessionId) {
    const engine = this._engines.get(agentId);
    if (!engine) return { success: false, error: `子智能体引擎未启动: ${agentId}` };
    return engine.closeSession(sessionId);
  }

  /**
   * 清空子智能体会话（v2.7新增）
   */
  clearAgentSession(agentId, sessionId) {
    const engine = this._engines.get(agentId);
    if (!engine) return { success: false, error: `子智能体引擎未启动: ${agentId}` };
    return engine.clearSession(sessionId);
  }

  /**
   * 子智能体工具调用（v2.7新增）
   */
  async executeAgentTool(agentId, toolName, params = {}) {
    const engine = this._engines.get(agentId);
    if (!engine) return { success: false, error: `子智能体引擎未启动: ${agentId}` };
    return engine.executeTool(toolName, params);
  }

  /**
   * 获取子智能体工具列表（v2.7新增）
   */
  listAgentTools(agentId) {
    const engine = this._engines.get(agentId);
    if (!engine) return [];
    return engine.listTools();
  }

  /**
   * 获取子智能体引擎状态（v2.7新增）
   */
  getAgentEngineStatus(agentId) {
    const engine = this._engines.get(agentId);
    if (!engine) return null;
    return engine.getStatus();
  }

  // ═══════════════════════════════════════
  // 子智能体生命周期管理
  // ═══════════════════════════════════════

  /**
   * 创建子智能体
   */
  create(options = {}) {
    const { name, displayName, type, description, safetyLevel, quota, autoStart } = options;

    // 容量检查
    if (this._agents.size >= this._config.maxSubAgents) {
      return { success: false, error: `已达最大子智能体数量 (${this._config.maxSubAgents})` };
    }

    // 名称检查
    if (!name || name.trim().length === 0) {
      return { success: false, error: '子智能体名称不能为空' };
    }

    // 名称唯一性检查
    for (const agent of this._agents.values()) {
      if (agent.name === name.trim()) {
        return { success: false, error: `子智能体名称 "${name}" 已存在` };
      }
    }

    // 类型检查
    if (type && !Object.values(SUBAGENT_TYPE).includes(type)) {
      return { success: false, error: `无效的子智能体类型: ${type}` };
    }

    // 安全等级检查
    if (safetyLevel && !Object.values(SAFETY_LEVEL).includes(safetyLevel)) {
      return { success: false, error: `无效的安全等级: ${safetyLevel}` };
    }

    const agent = new SubAgentInstance({
      name: name.trim(),
      displayName: (displayName || name).trim(),
      type: type || SUBAGENT_TYPE.ASSISTANT,
      description: description || '',
      safetyLevel: safetyLevel || SAFETY_LEVEL.MEDIUM,
      quota: quota || QUOTA_LEVEL.MEDIUM,
      parent: this,
      maxTasks: this._config.maxTaskQueuePerAgent,
    });

    agent.status = SUBAGENT_STATUS.PENDING;
    this._agents.set(agent.id, agent);

    this._logger.info(`子智能体创建: "${agent.name}" (${agent.id}) 类型=${agent.type} 安全=${agent.safetyLevel}`);

    // 自动启动
    if (autoStart !== false) {
      this.start(agent.id);
    }

    this.emit('created', { agentId: agent.id, name: agent.name, type: agent.type });
    this._persist();

    return { success: true, agentId: agent.id, agent: agent.getSummary() };
  }

  /**
   * 启动子智能体
   */
  start(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    if (agent.status === SUBAGENT_STATUS.RUNNING) {
      return { success: false, error: '子智能体已在运行中' };
    }

    if (agent.status === SUBAGENT_STATUS.DESTROYED) {
      return { success: false, error: '子智能体已被销毁，无法启动' };
    }

    agent.status = SUBAGENT_STATUS.RUNNING;
    agent.startedAt = Date.now();
    agent.lastHeartbeat = Date.now();
    agent.lastActive = Date.now();

    // v2.9: 初始化独立记忆空间
    this._memoryBinder.initAgentMemory(agentId, {
      agentName: agent.name,
      agentType: agent.type,
    });

    this._logger.info(`子智能体启动: "${agent.name}" (${agentId})`);

    // 启动心跳监控
    this._startHeartbeat(agentId);

    // v2.7: 自动初始化引擎（独立对话能力）
    this.initEngine(agentId).then(result => {
      if (result.success) {
        this._logger.info(`子智能体引擎自动启动: "${agent.name}" (${agentId})`);
      }
    }).catch(err => {
      this._logger.warn(`子智能体引擎启动失败: "${agent.name}" (${agentId}) - ${err.message}`);
    });

    this.emit('started', { agentId, name: agent.name });
    this._persist();

    return { success: true, agentId, status: agent.status };
  }

  /**
   * 停止子智能体
   */
  stop(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    if (agent.status !== SUBAGENT_STATUS.RUNNING) {
      return { success: false, error: `子智能体未在运行中 (当前状态: ${agent.status})` };
    }

    agent.status = SUBAGENT_STATUS.STOPPED;
    agent.stoppedAt = Date.now();
    agent.lastActive = Date.now();

    // v2.7: 停止引擎
    this.destroyEngine(agentId).catch(err => {
      this._logger.warn(`子智能体引擎停止失败: ${err.message}`);
    });

    this._logger.info(`子智能体停止: "${agent.name}" (${agentId})`);
    this.emit('stopped', { agentId, name: agent.name });
    this._persist();

    return { success: true, agentId, status: agent.status };
  }

  /**
   * 销毁子智能体
   */
  destroy(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    // 先停止
    if (agent.status === SUBAGENT_STATUS.RUNNING) {
      this.stop(agentId);
    }

    const name = agent.name;
    agent.status = SUBAGENT_STATUS.DESTROYED;
    this._agents.delete(agentId);

    // v2.9: 关闭独立记忆空间
    this._memoryBinder.closeAgentMemory(agentId);

    this._logger.info(`子智能体销毁: "${name}" (${agentId})`);
    this.emit('destroyed', { agentId, name });
    this._persist();

    return { success: true, agentId, name };
  }

  /**
   * 重启子智能体
   */
  restart(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    this.stop(agentId);
    return this.start(agentId);
  }

  // ═══════════════════════════════════════
  // 任务分配与调度
  // ═══════════════════════════════════════

  /**
   * 向子智能体分配任务
   */
  assignTask(agentId, task) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    if (agent.status !== SUBAGENT_STATUS.RUNNING) {
      return { success: false, error: `子智能体未在运行中 (当前状态: ${agent.status})` };
    }

    // 队列容量检查
    if (agent.tasks.length >= agent._maxTasks) {
      return { success: false, error: '子智能体任务队列已满' };
    }

    const taskObj = {
      id: `task_${crypto.randomUUID().slice(0, 8)}`,
      content: task.content || task,
      priority: task.priority || 1,
      assignedAt: Date.now(),
      status: 'pending',
    };

    agent.tasks.push(taskObj);
    agent.lastActive = Date.now();

    this.emit('task_assigned', { agentId, taskId: taskObj.id });
    return { success: true, agentId, taskId: taskObj.id };
  }

  /**
   * 批量分配任务（基于能力匹配+负载均衡）
   */
  assignTaskSmart(task) {
    const requiredCapability = task.requiredCapability || null;
    const runningAgents = this._getRunningAgents();

    if (runningAgents.length === 0) {
      return { success: false, error: '没有可用的运行中子智能体' };
    }

    // 能力匹配过滤
    let candidates = runningAgents;
    if (requiredCapability) {
      candidates = runningAgents.filter(a =>
        a.capabilities.includes(requiredCapability)
      );
      if (candidates.length === 0) {
        return { success: false, error: `没有子智能体具备能力: ${requiredCapability}` };
      }
    }

    // 负载均衡：选任务队列最短的
    candidates.sort((a, b) => a.tasks.length - b.tasks.length);
    const selected = candidates[0];

    return this.assignTask(selected.id, task);
  }

  /**
   * 标记任务完成
   */
  completeTask(agentId, taskId, result) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    const taskIdx = agent.tasks.findIndex(t => t.id === taskId);
    if (taskIdx === -1) {
      return { success: false, error: `任务不存在: ${taskId}` };
    }

    const task = agent.tasks.splice(taskIdx, 1)[0];
    task.status = result?.error ? 'failed' : 'completed';
    task.completedAt = Date.now();
    task.result = result;
    agent.taskResults.push(task);

    // 更新性能统计
    if (task.status === 'completed') {
      agent.performance.tasksCompleted++;
    } else {
      agent.performance.tasksFailed++;
    }
    agent.lastActive = Date.now();

    this.emit('task_completed', { agentId, taskId, status: task.status });
    return { success: true, agentId, taskId, status: task.status };
  }

  // ═══════════════════════════════════════
  // 安全监控
  // ═══════════════════════════════════════

  /**
   * 记录安全违规
   */
  recordViolation(agentId, violation) {
    const agent = this._agents.get(agentId);
    if (!agent) return;

    const record = {
      id: `viol_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: Date.now(),
      type: violation.type || 'unknown',
      description: violation.description || '未描述的违规行为',
      severity: violation.severity || 'warning',
      action: violation.action || 'logged',
    };

    agent.violations.push(record);
    this._safetyStats.totalViolations++;

    // 降低安全评分
    const penalty = record.severity === 'critical' ? 20 :
      record.severity === 'high' ? 10 :
      record.severity === 'medium' ? 5 : 2;
    agent.safetyScore = Math.max(0, agent.safetyScore - penalty);

    this._logger.warn(`子智能体安全违规: "${agent.name}" (${agentId}) - ${record.description} [${record.severity}]`);

    // 高严重性：自动停止
    if (record.severity === 'critical') {
      this._safetyStats.blockedActions++;
      this._safetyStats.safetyAlerts++;
      this.stop(agentId);
      this._logger.error(`子智能体因严重违规被强制停止: "${agent.name}" (${agentId})`);
      this.emit('safety_stop', { agentId, name: agent.name, violation: record });
    }

    if (record.severity === 'high') {
      this._safetyStats.safetyAlerts++;
    }

    this.emit('violation', { agentId, name: agent.name, violation: record });
  }

  /**
   * 检查操作是否在安全范围内
   */
  checkSafety(agentId, action) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { allowed: false, reason: '子智能体不存在' };
    }

    if (agent.status !== SUBAGENT_STATUS.RUNNING) {
      return { allowed: false, reason: '子智能体未在运行中' };
    }

    // 根据安全等级限制操作
    const blockedActions = {
      [SAFETY_LEVEL.MAXIMUM]: ['write', 'delete', 'execute', 'network', 'modify_config', 'create_subagent'],
      [SAFETY_LEVEL.HIGH]: ['delete', 'execute_binary', 'modify_config', 'create_subagent'],
      [SAFETY_LEVEL.MEDIUM]: ['delete_system', 'modify_config'],
      [SAFETY_LEVEL.LOW]: [],
    };

    const blocked = blockedActions[agent.safetyLevel] || [];
    if (blocked.includes(action)) {
      this.recordViolation(agentId, {
        type: 'unauthorized_action',
        description: `尝试执行受限操作: ${action}`,
        severity: agent.safetyLevel === SAFETY_LEVEL.MAXIMUM ? 'critical' : 'high',
        action: 'blocked',
      });
      return { allowed: false, reason: `安全等级 ${agent.safetyLevel} 不允许操作: ${action}` };
    }

    // 安全评分过低时限制
    if (agent.safetyScore < 30 && action !== 'read') {
      return { allowed: false, reason: `安全评分过低 (${agent.safetyScore})，操作受限` };
    }

    return { allowed: true };
  }

  // ═══════════════════════════════════════
  // 查询与统计
  // ═══════════════════════════════════════

  /**
   * 获取所有子智能体列表
   */
  list(options = {}) {
    const { type, status, safetyLevel } = options;
    let agents = Array.from(this._agents.values());

    if (type) agents = agents.filter(a => a.type === type);
    if (status) agents = agents.filter(a => a.status === status);
    if (safetyLevel) agents = agents.filter(a => a.safetyLevel === safetyLevel);

    return agents.map(a => a.getSummary());
  }

  /**
   * 获取子智能体详情
   */
  get(agentId) {
    const agent = this._agents.get(agentId);
    return agent ? agent.getDetail() : null;
  }

  /**
   * 获取子智能体统计
   */
  getStats() {
    const agents = Array.from(this._agents.values());
    const byStatus = {};
    const byType = {};
    const bySafety = {};

    for (const a of agents) {
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      byType[a.type] = (byType[a.type] || 0) + 1;
      bySafety[a.safetyLevel] = (bySafety[a.safetyLevel] || 0) + 1;
    }

    const running = agents.filter(a => a.status === SUBAGENT_STATUS.RUNNING);
    const safetyStatus = agents.some(a => a.safetyScore < 30) ? '危险' :
      agents.some(a => a.safetyScore < 60) ? '告警' : '正常';

    return {
      total: agents.length,
      active: running.length,
      byStatus,
      byType,
      bySafety,
      safetyStatus,
      safetyStats: { ...this._safetyStats },
      totalTasksCompleted: agents.reduce((s, a) => s + a.performance.tasksCompleted, 0),
      totalTasksFailed: agents.reduce((s, a) => s + a.performance.tasksFailed, 0),
    };
  }

  // ═══════════════════════════════════════
  // 心跳监控
  // ═══════════════════════════════════════

  _startHeartbeat(agentId) {
    if (this._heartbeatTimer) return; // 全局定时器已存在

    this._heartbeatTimer = setInterval(() => {
      this._checkHeartbeats();
    }, this._config.heartbeatInterval);

    this._heartbeatTimer.unref && this._heartbeatTimer.unref();
  }

  _checkHeartbeats() {
    const now = Date.now();
    const timeout = this._config.heartbeatTimeout;
    let hasRunning = false;

    for (const agent of this._agents.values()) {
      if (agent.status !== SUBAGENT_STATUS.RUNNING) continue;
      hasRunning = true;

      if (agent.lastHeartbeat && (now - agent.lastHeartbeat) > timeout) {
        this._logger.warn(`子智能体心跳超时: "${agent.name}" (${agentId})`);
        this.emit('heartbeat_timeout', { agentId: agent.id, name: agent.name });
        // 心跳超时不会自动停止，只记录告警
      }
    }

    // 没有运行中的智能体时停止定时器
    if (!hasRunning && this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * 更新子智能体心跳（由子智能体主动上报）
   */
  heartbeat(agentId) {
    const agent = this._agents.get(agentId);
    if (agent && agent.status === SUBAGENT_STATUS.RUNNING) {
      agent.lastHeartbeat = Date.now();
      agent.lastActive = Date.now();
    }
  }

  // ═══════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════

  _persist() {
    try {
      const data = Array.from(this._agents.values()).map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        description: a.description,
        status: a.status,
        safetyLevel: a.safetyLevel,
        quota: a.quota,
        capabilities: a.capabilities,
        safetyScore: a.safetyScore,
        performance: a.performance,
        violations: a.violations.slice(-50),
        createdAt: a.createdAt,
        startedAt: a.startedAt,
        stoppedAt: a.stoppedAt,
        lastHeartbeat: a.lastHeartbeat,
        lastActive: a.lastActive,
      }));
      fs.writeFileSync(
        path.join(this._dataDir, 'subagents.json'),
        JSON.stringify(data, null, 2),
        'utf8'
      );
    } catch (e) {
      this._logger?.warn?.(`子智能体数据持久化失败: ${e.message}`);
    }
  }

  /**
   * 从持久化恢复
   */
  restore() {
    try {
      const filePath = path.join(this._dataDir, 'subagents.json');
      if (!fs.existsSync(filePath)) return 0;

      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let count = 0;

      for (const item of data) {
        if (item.status === SUBAGENT_STATUS.DESTROYED) continue;
        const agent = new SubAgentInstance({
          ...item,
          parent: this,
        });
        this._agents.set(agent.id, agent);
        count++;
      }

      this._logger?.info?.(`从持久化恢复 ${count} 个子智能体`);
      return count;
    } catch (e) {
      this._logger?.warn?.(`子智能体恢复失败: ${e.message}`);
      return 0;
    }
  }

  /**
   * 关闭管理器
   */
  close() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // v2.7: 关闭所有引擎
    for (const [agentId, engine] of this._engines) {
      engine.close().catch(err => {
        this._logger?.warn?.(`引擎关闭失败: ${agentId} - ${err.message}`);
      });
    }
    this._engines.clear();

    // v2.7: 关闭WebSocket
    if (this._websocket) {
      this._websocket.close();
      this._websocket = null;
    }

    // v2.9: 关闭技能安装器与记忆绑定器
    if (this._skillInstaller) {
      this._skillInstaller.close();
    }
    if (this._memoryBinder) {
      this._memoryBinder.close();
    }

    this._persist();
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _getRunningAgents() {
    return Array.from(this._agents.values()).filter(
      a => a.status === SUBAGENT_STATUS.RUNNING
    );
  }

  _getRunningAgentsByCapability(capability) {
    return this._getRunningAgents().filter(
      a => a.capabilities.includes(capability)
    );
  }

  // ═══════════════════════════════════════
  // v2.8: 团队关联管理
  // ═══════════════════════════════════════

  /**
   * 设置团队管理器引用
   */
  setTeamManager(teamManager) {
    this._teamManager = teamManager;
  }

  /**
   * 获取团队管理器
   */
  getTeamManager() {
    return this._teamManager;
  }

  /**
   * 将子智能体关联到团队
   */
  linkToTeam(agentId, teamId, role = 'member') {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    if (!agent.teams.includes(teamId)) {
      agent.teams.push(teamId);
    }
    agent.teamRoles[teamId] = role;

    this._logger.info(`[SubAgentManager] 子智能体 "${agent.name}" 关联到团队: ${teamId} (角色: ${role})`);
    return { success: true, agentId, teamId, role };
  }

  /**
   * 解除子智能体与团队的关联
   */
  unlinkFromTeam(agentId, teamId) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    agent.teams = agent.teams.filter(t => t !== teamId);
    delete agent.teamRoles[teamId];

    this._logger.info(`[SubAgentManager] 子智能体 "${agent.name}" 解除团队关联: ${teamId}`);
    return { success: true, agentId, teamId };
  }

  /**
   * 获取子智能体所属团队列表
   */
  getAgentTeams(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return [];
    return agent.teams.map(tid => ({
      teamId: tid,
      role: agent.teamRoles[tid] || 'member',
    }));
  }

  /**
   * 更新子智能体显示名称
   */
  setAgentDisplayName(agentId, displayName) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    if (!displayName || displayName.trim().length === 0) {
      return { success: false, error: '显示名称不能为空' };
    }

    agent.displayName = displayName.trim();
    this._logger.info(`[SubAgentManager] 子智能体 "${agent.name}" 显示名称更新为: "${agent.displayName}"`);
    return { success: true, agentId, displayName: agent.displayName };
  }

  // ═══════════════════════════════════════
  // v2.9: 技能安装与管理 API
  // ═══════════════════════════════════════

  /**
   * 为子智能体安装技能（从文件）
   */
  async installSkillFromFile(agentId, filePath, options = {}) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    const result = await this._skillInstaller.installFromFile(agentId, filePath, options);

    // 同步到引擎
    if (result.success) {
      const engine = this._engines.get(agentId);
      if (engine) {
        engine._refreshSkills();
      }
    }

    return result;
  }

  /**
   * 为子智能体安装技能（从内容）
   */
  installSkillFromContent(agentId, content, options = {}) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    const result = this._skillInstaller.installFromContent(agentId, content, options);

    if (result.success) {
      const engine = this._engines.get(agentId);
      if (engine) {
        engine._refreshSkills();
      }
    }

    return result;
  }

  /**
   * 为子智能体安装技能（从市场）
   */
  installSkillFromMarket(agentId, marketSkill, options = {}) {
    const agent = this._agents.get(agentId);
    if (!agent) {
      return { success: false, error: `子智能体不存在: ${agentId}` };
    }

    const result = this._skillInstaller.installFromMarket(agentId, marketSkill, options);

    if (result.success) {
      const engine = this._engines.get(agentId);
      if (engine) {
        engine._refreshSkills();
      }
    }

    return result;
  }

  /**
   * 卸载子智能体技能
   */
  uninstallAgentSkill(agentId, skillId) {
    const result = this._skillInstaller.uninstallSkill(agentId, skillId);

    if (result.success) {
      const engine = this._engines.get(agentId);
      if (engine) {
        engine._refreshSkills();
      }
    }

    return result;
  }

  /**
   * 获取子智能体已安装技能列表
   */
  listAgentSkills(agentId) {
    return this._skillInstaller.getAgentSkills(agentId);
  }

  /**
   * 获取子智能体技能详情
   */
  getAgentSkillDetail(agentId, skillId) {
    return this._skillInstaller.getAgentSkillDetail(agentId, skillId);
  }

  /**
   * 搜索子智能体技能
   */
  searchAgentSkills(agentId, keyword) {
    return this._skillInstaller.searchAgentSkills(agentId, keyword);
  }

  /**
   * 获取子智能体技能统计
   */
  getAgentSkillStats(agentId) {
    return this._skillInstaller.getAgentSkillStats(agentId);
  }

  /**
   * 获取子智能体技能安装历史
   */
  getAgentSkillHistory(agentId, limit = 20) {
    return this._skillInstaller.getInstallHistory(agentId, limit);
  }

  /**
   * 启用/禁用子智能体技能
   */
  toggleAgentSkill(agentId, skillId, enabled) {
    const result = this._skillInstaller.toggleSkill(agentId, skillId, enabled);

    if (result.success) {
      const engine = this._engines.get(agentId);
      if (engine) {
        engine._refreshSkills();
      }
    }

    return result;
  }

  /**
   * 固化技能到子智能体记忆
   */
  bindSkillToMemory(agentId, skillId) {
    return this._memoryBinder.bindSkill(agentId, skillId);
  }

  /**
   * 锁定技能为核心记忆（永不衰减）
   */
  lockSkillAsCore(agentId, skillId) {
    return this._memoryBinder.lockSkillAsCore(agentId, skillId);
  }

  /**
   * 获取子智能体固化技能列表
   */
  getBoundSkills(agentId) {
    return this._memoryBinder.getBoundSkills(agentId);
  }

  /**
   * 获取子智能体记忆统计
   */
  getAgentMemoryStats(agentId) {
    return this._memoryBinder.getMemoryStats(agentId);
  }

  /**
   * 获取子智能体记忆内容
   */
  searchAgentMemory(agentId, query) {
    return this._memoryBinder.searchMemory(agentId, query);
  }

  /**
   * 导出子智能体技能记忆（备份/迁移）
   */
  exportAgentSkillMemory(agentId) {
    return this._memoryBinder.exportSkillMemories(agentId);
  }

  /**
   * 导入子智能体技能记忆（从备份恢复）
   */
  importAgentSkillMemory(agentId, data) {
    return this._memoryBinder.importSkillMemories(agentId, data);
  }

  /**
   * 获取技能安装器实例
   */
  getSkillInstaller() {
    return this._skillInstaller;
  }

  /**
   * 获取记忆绑定器实例
   */
  getMemoryBinder() {
    return this._memoryBinder;
  }
}

module.exports = {
  SubAgentManager,
  SubAgentInstance,
  SUBAGENT_TYPE,
  SUBAGENT_STATUS,
  SAFETY_LEVEL,
  QUOTA_LEVEL,
  // v2.7 re-exports
  SubAgentEngine,
  SubAgentWebSocket,
  // v2.9 re-exports
  SubAgentSkillInstaller,
  SubAgentMemoryBinder,
};
