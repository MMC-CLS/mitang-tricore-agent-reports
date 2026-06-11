/**
 * TriCore Agent - 多Agent协作框架 (Agent Coordination)
 *
 * 能力：
 *   1. Agent注册与发现 - 本地/远程Agent注册到协调中心
 *   2. 任务分解与分配 - 大任务拆解为子任务，分配给最合适的Agent
 *   3. Agent间通信 - 消息传递协议，支持请求/响应/广播
 *   4. 能力声明 - 每个Agent声明自己的能力（工具/技能/模型）
 *   5. 冲突检测 - 防止多个Agent同时操作相同资源
 *   6. 结果聚合 - 子任务结果合并为最终输出
 *
 * 协议设计：
 *   - 本地Agent通过EventBus通信
 *   - 远程Agent通过HTTP/WebSocket通信
 *   - 任务分配基于能力匹配 + 负载均衡
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 常量 ──
const AGENT_STATUS = Object.freeze({
  ONLINE: 'online',
  BUSY: 'busy',
  OFFLINE: 'offline',
  ERROR: 'error',
});

const TASK_PRIORITY = Object.freeze({
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
});

const MESSAGE_TYPE = Object.freeze({
  REQUEST: 'request',
  RESPONSE: 'response',
  BROADCAST: 'broadcast',
  TASK_ASSIGN: 'task_assign',
  TASK_RESULT: 'task_result',
  HEARTBEAT: 'heartbeat',
});

class AgentCoordination extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── Agent注册表 ──
    this._agents = new Map();  // agentId → { info, status, capabilities, lastHeartbeat }

    // ── 任务分配表 ──
    this._tasks = new Map();   // taskId → { goal, subtasks, status, assignedTo, results }

    // ── 资源锁 ──
    this._locks = new Map();   // resourceKey → { agentId, expiresAt }

    // ── 本地Agent引用 ──
    this._localAgent = options.localAgent || null;

    // ── 心跳间隔 ──
    this._heartbeatInterval = options.heartbeatInterval || 30000;
    this._heartbeatTimer = null;

    // ── 超时 ──
    this._agentTimeout = options.agentTimeout || 90000; // 3次心跳
  }

  // ═══════════════════════════════════════
  // Agent注册与发现
  // ═══════════════════════════════════════

  /**
   * 注册Agent
   * @param {Object} info - { id, name, type, capabilities, endpoint? }
   */
  registerAgent(info) {
    const agentId = info.id || `agent_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const agent = {
      id: agentId,
      name: info.name || agentId,
      type: info.type || 'generic',    // tricore / specialist / worker
      capabilities: info.capabilities || [], // ['file_ops', 'web_search', 'code_gen', ...]
      skills: info.skills || [],        // 已审批的技能名列表
      models: info.models || [],        // 可用模型列表
      endpoint: info.endpoint || null,  // 远程Agent的HTTP端点
      status: AGENT_STATUS.ONLINE,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      activeTasks: 0,
      completedTasks: 0,
      loadScore: 0,  // 0-100，0=空闲
    };

    this._agents.set(agentId, agent);
    this.emit('agent_registered', { agentId, name: agent.name });

    return agentId;
  }

  /**
   * 注销Agent
   */
  unregisterAgent(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return false;

    // 释放该Agent持有的资源锁
    for (const [key, lock] of this._locks) {
      if (lock.agentId === agentId) this._locks.delete(key);
    }

    this._agents.delete(agentId);
    this.emit('agent_unregistered', { agentId });
    return true;
  }

  /**
   * 发现具有指定能力的Agent
   */
  discoverAgents(requiredCapabilities = []) {
    const results = [];

    for (const [agentId, agent] of this._agents) {
      if (agent.status === AGENT_STATUS.OFFLINE) continue;

      const hasAll = requiredCapabilities.every(cap =>
        agent.capabilities.includes(cap) || agent.skills.includes(cap)
      );

      if (hasAll || requiredCapabilities.length === 0) {
        results.push({
          ...agent,
          matchScore: requiredCapabilities.length > 0
            ? requiredCapabilities.filter(c => agent.capabilities.includes(c) || agent.skills.includes(c)).length / requiredCapabilities.length
            : 1,
        });
      }
    }

    // 按匹配度 + 负载排序
    results.sort((a, b) => {
      const scoreDiff = b.matchScore - a.matchScore;
      if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
      return a.loadScore - b.loadScore; // 同匹配度选低负载
    });

    return results;
  }

  /**
   * Agent心跳
   */
  heartbeat(agentId, data = {}) {
    const agent = this._agents.get(agentId);
    if (!agent) return false;

    agent.lastHeartbeat = Date.now();
    agent.status = data.status || AGENT_STATUS.ONLINE;
    agent.activeTasks = data.activeTasks ?? agent.activeTasks;
    agent.completedTasks = data.completedTasks ?? agent.completedTasks;
    agent.loadScore = data.loadScore ?? agent.loadScore;

    return true;
  }

  // ═══════════════════════════════════════
  // 任务分解与分配
  // ═══════════════════════════════════════

  /**
   * 创建协作任务
   * @param {Object} task - { goal, priority, requiredCapabilities, context, maxSubtasks? }
   */
  createCoordinationTask(task) {
    const taskId = `coord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const coordTask = {
      id: taskId,
      goal: task.goal,
      priority: task.priority || TASK_PRIORITY.NORMAL,
      requiredCapabilities: task.requiredCapabilities || [],
      context: task.context || {},
      status: 'pending',        // pending / decomposing / assigned / running / completed / failed
      subtasks: [],             // [{ id, goal, assignedTo, status, result }]
      results: [],
      createdAt: Date.now(),
      completedAt: null,
      maxSubtasks: task.maxSubtasks || 5,
    };

    this._tasks.set(taskId, coordTask);
    this.emit('task_created', { taskId, goal: task.goal });

    return taskId;
  }

  /**
   * 分解任务（基于能力的简单策略，复杂分解由LLM完成）
   */
  decomposeTask(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return null;

    task.status = 'decomposing';

    const availableAgents = this.discoverAgents(task.requiredCapabilities);

    if (availableAgents.length === 0) {
      // 无可用Agent，分配给本地Agent
      task.subtasks = [{
        id: `sub_${taskId}_0`,
        goal: task.goal,
        assignedTo: 'local',
        status: 'pending',
        result: null,
      }];
    } else {
      // 按能力分配
      // 简单策略：每个Agent一个子任务
      const agentsToUse = availableAgents.slice(0, task.maxSubtasks);

      if (agentsToUse.length === 1) {
        // 单Agent直接执行
        task.subtasks = [{
          id: `sub_${taskId}_0`,
          goal: task.goal,
          assignedTo: agentsToUse[0].id,
          status: 'pending',
          result: null,
        }];
      } else {
        // 多Agent协作分解
        // 将目标按能力域拆分
        const capabilityGroups = this._groupByCapability(task.goal, agentsToUse);
        task.subtasks = capabilityGroups.map((group, i) => ({
          id: `sub_${taskId}_${i}`,
          goal: group.subGoal,
          assignedTo: group.agentId,
          status: 'pending',
          result: null,
          dependencies: group.dependencies || [],
        }));
      }
    }

    task.status = 'assigned';
    this.emit('task_decomposed', { taskId, subtaskCount: task.subtasks.length });

    return task.subtasks;
  }

  /**
   * 按能力分组（简单策略）
   */
  _groupByCapability(goal, agents) {
    // 简单策略：轮询分配
    return agents.map((agent, i) => ({
      subGoal: `[子任务${i + 1}] ${goal}`,
      agentId: agent.id,
      dependencies: i > 0 ? [`sub_*_${i - 1}`] : [],
    }));
  }

  /**
   * 提交子任务结果
   */
  submitSubtaskResult(taskId, subtaskId, result) {
    const task = this._tasks.get(taskId);
    if (!task) return false;

    const subtask = task.subtasks.find(st => st.id === subtaskId);
    if (!subtask) return false;

    subtask.status = 'completed';
    subtask.result = result;
    task.results.push({ subtaskId, result });

    // 更新Agent状态
    const agent = this._agents.get(subtask.assignedTo);
    if (agent) {
      agent.activeTasks = Math.max(0, agent.activeTasks - 1);
      agent.completedTasks++;
    }

    // 检查是否全部完成
    const allCompleted = task.subtasks.every(st => st.status === 'completed');
    if (allCompleted) {
      task.status = 'completed';
      task.completedAt = Date.now();
      this.emit('task_completed', { taskId, results: task.results });
    }

    return true;
  }

  // ═══════════════════════════════════════
  // Agent间通信
  // ═══════════════════════════════════════

  /**
   * 发送消息给指定Agent
   */
  async sendMessage(fromAgentId, toAgentId, content, type = MESSAGE_TYPE.REQUEST) {
    const from = this._agents.get(fromAgentId);
    const to = this._agents.get(toAgentId);

    if (!to || to.status === AGENT_STATUS.OFFLINE) {
      return { error: `Agent ${toAgentId} not available` };
    }

    const message = {
      id: `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      from: fromAgentId,
      to: toAgentId,
      content,
      type,
      timestamp: Date.now(),
    };

    this.emit('message_sent', message);

    // 本地Agent直接通过事件总线
    if (toAgentId === 'local' && this._localAgent) {
      this.emit('local_message', message);
      return { delivered: true, method: 'local' };
    }

    // 远程Agent通过HTTP
    if (to.endpoint) {
      try {
        const response = await fetch(`${to.endpoint}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        });
        const data = await response.json();
        return { delivered: response.ok, response: data };
      } catch (error) {
        return { delivered: false, error: error.message };
      }
    }

    return { delivered: false, error: 'No delivery method' };
  }

  /**
   * 广播消息给所有在线Agent
   */
  broadcast(fromAgentId, content) {
    const results = [];
    for (const [agentId, agent] of this._agents) {
      if (agentId === fromAgentId) continue;
      if (agent.status === AGENT_STATUS.OFFLINE) continue;
      results.push(this.sendMessage(fromAgentId, agentId, content, MESSAGE_TYPE.BROADCAST));
    }
    return Promise.all(results);
  }

  // ═══════════════════════════════════════
  // 资源锁
  // ═══════════════════════════════════════

  /**
   * 尝试获取资源锁
   */
  acquireLock(agentId, resourceKey, ttl = 60000) {
    const existing = this._locks.get(resourceKey);
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.agentId !== agentId) {
        return { acquired: false, heldBy: existing.agentId };
      }
      // 续期
      existing.expiresAt = Date.now() + ttl;
      return { acquired: true, renewed: true };
    }

    this._locks.set(resourceKey, {
      agentId,
      expiresAt: Date.now() + ttl,
      acquiredAt: Date.now(),
    });

    this.emit('lock_acquired', { agentId, resourceKey });
    return { acquired: true };
  }

  /**
   * 释放资源锁
   */
  releaseLock(agentId, resourceKey) {
    const lock = this._locks.get(resourceKey);
    if (!lock) return true;
    if (lock.agentId !== agentId) return false;
    this._locks.delete(resourceKey);
    this.emit('lock_released', { agentId, resourceKey });
    return true;
  }

  // ═══════════════════════════════════════
  // 心跳监控
  // ═══════════════════════════════════════

  startHeartbeatMonitor() {
    if (this._heartbeatTimer) return;

    this._heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [agentId, agent] of this._agents) {
        if (agentId === 'local') continue;

        if (now - agent.lastHeartbeat > this._agentTimeout) {
          agent.status = AGENT_STATUS.OFFLINE;
          this.emit('agent_timeout', { agentId });
        }
      }

      // 清理过期锁
      for (const [key, lock] of this._locks) {
        if (lock.expiresAt <= now) {
          this._locks.delete(key);
          this.emit('lock_expired', { resourceKey: key, agentId: lock.agentId });
        }
      }

      // 清理长时间离线的Agent（超过1小时）
      const offlineThreshold = now - 3600000; // 1小时
      for (const [agentId, agent] of this._agents) {
        if (agentId === 'local') continue;
        if (agent.status === AGENT_STATUS.OFFLINE && agent.lastHeartbeat < offlineThreshold) {
          this._agents.delete(agentId);
          this.emit('agent_cleaned', { agentId, reason: 'offline_timeout' });
        }
      }
    }, this._heartbeatInterval);
  }

  stopHeartbeatMonitor() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ═══════════════════════════════════════
  // 状态
  // ═══════════════════════════════════════

  getStatus() {
    return {
      agents: {
        total: this._agents.size,
        online: [...this._agents.values()].filter(a => a.status === AGENT_STATUS.ONLINE).length,
        busy: [...this._agents.values()].filter(a => a.status === AGENT_STATUS.BUSY).length,
        offline: [...this._agents.values()].filter(a => a.status === AGENT_STATUS.OFFLINE).length,
      },
      tasks: {
        total: this._tasks.size,
        pending: [...this._tasks.values()].filter(t => t.status === 'pending').length,
        running: [...this._tasks.values()].filter(t => t.status === 'running' || t.status === 'assigned').length,
        completed: [...this._tasks.values()].filter(t => t.status === 'completed').length,
      },
      locks: this._locks.size,
    };
  }

  getAgentInfo(agentId) {
    return this._agents.get(agentId) || null;
  }

  getTaskInfo(taskId) {
    return this._tasks.get(taskId) || null;
  }

  listAgents() {
    return [...this._agents.values()];
  }

  listTasks() {
    return [...this._tasks.values()];
  }
}

module.exports = {
  AgentCoordination,
  AGENT_STATUS,
  TASK_PRIORITY,
  MESSAGE_TYPE,
};
