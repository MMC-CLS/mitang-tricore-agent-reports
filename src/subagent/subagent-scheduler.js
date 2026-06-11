/**
 * 蜜糖 TriCore Agent - 子智能体调度引擎 (Sub-Agent Scheduler)
 *
 * 核心职责：
 *   1. 任务分解与分配 - 复杂任务拆解为子任务，智能分配到子智能体
 *   2. 负载均衡 - 多种负载均衡策略（轮询/最少任务/权重/能力匹配）
 *   3. 优先级调度 - 多级优先级队列，紧急任务优先处理
 *   4. 资源协调 - 全局资源池管理，避免资源争抢
 *   5. 结果聚合 - 子任务结果收集与合并
 *   6. 失败重试 - 任务失败自动重试与降级策略
 *
 * 调度策略：
 *   - ROUND_ROBIN: 轮询分配
 *   - LEAST_LOADED: 最少任务优先
 *   - CAPABILITY_MATCH: 能力匹配优先
 *   - WEIGHTED: 加权分配（基于历史表现）
 *   - ADAPTIVE: 自适应策略（综合考量）
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 常量 ──

const SCHEDULE_STRATEGY = Object.freeze({
  ROUND_ROBIN: 'round_robin',
  LEAST_LOADED: 'least_loaded',
  CAPABILITY_MATCH: 'capability_match',
  WEIGHTED: 'weighted',
  ADAPTIVE: 'adaptive',
});

const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRYING: 'retrying',
  CANCELLED: 'cancelled',
});

const TASK_PRIORITY = Object.freeze({
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
  CRITICAL: 4,
});

class SubAgentScheduler extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._subAgentManager = options.subAgentManager || null;
    this._guardian = options.guardian || null;

    // 配置
    this._strategy = options.strategy || SCHEDULE_STRATEGY.ADAPTIVE;
    this._maxRetries = options.maxRetries || 3;
    this._retryDelay = options.retryDelay || 2000;
    this._maxConcurrentTasks = options.maxConcurrentTasks || 100;
    this._taskTimeout = options.taskTimeout || 300000; // 5分钟默认超时

    // 任务队列
    this._taskQueue = [];        // 待分配任务
    this._activeTasks = new Map(); // taskId → task详情
    this._completedTasks = [];    // 已完成任务（最近N个）
    this._maxCompletedTasks = options.maxCompletedTasks || 500;

    // 轮询索引
    this._roundRobinIndex = 0;

    // 调度定时器
    this._schedulerTimer = null;
    this._schedulerInterval = options.schedulerInterval || 5000;

    // 统计
    this._stats = {
      tasksSubmitted: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksRetried: 0,
      totalExecutionTime: 0,
      avgExecutionTime: 0,
    };
  }

  // ═══════════════════════════════════════
  // 任务提交
  // ═══════════════════════════════════════

  /**
   * 提交单个任务
   */
  submitTask(task) {
    const taskObj = {
      id: `st_${crypto.randomUUID().slice(0, 8)}`,
      content: task.content || task,
      type: task.type || 'general',
      priority: task.priority || TASK_PRIORITY.NORMAL,
      requiredCapability: task.requiredCapability || null,
      targetAgentId: task.targetAgentId || null,
      context: task.context || {},
      timeout: task.timeout || this._taskTimeout,
      maxRetries: task.maxRetries ?? this._maxRetries,
      status: TASK_STATUS.PENDING,
      retryCount: 0,
      submittedAt: Date.now(),
      assignedAt: null,
      startedAt: null,
      completedAt: null,
      assignedTo: null,
      result: null,
      error: null,
    };

    this._taskQueue.push(taskObj);
    this._stats.tasksSubmitted++;

    // 按优先级排序
    this._sortQueueByPriority();

    this.emit('task_submitted', { taskId: taskObj.id, priority: taskObj.priority });

    // 立即尝试调度
    this._trySchedule();

    return { success: true, taskId: taskObj.id };
  }

  /**
   * 提交复合任务（自动分解）
   */
  submitCompositeTask(compositeTask) {
    const { mainGoal, subtasks = [] } = compositeTask;

    if (subtasks.length === 0) {
      return this.submitTask({ content: mainGoal, priority: TASK_PRIORITY.HIGH });
    }

    // 创建复合任务组
    const groupId = `group_${crypto.randomUUID().slice(0, 8)}`;
    const results = [];

    for (let i = 0; i < subtasks.length; i++) {
      const st = subtasks[i];
      const result = this.submitTask({
        content: st.content || st,
        type: st.type || 'general',
        priority: st.priority || TASK_PRIORITY.NORMAL,
        requiredCapability: st.requiredCapability,
        context: {
          ...compositeTask.context,
          groupId,
          mainGoal,
          subtaskIndex: i,
          totalSubtasks: subtasks.length,
          ...st.context,
        },
      });

      if (result.success) {
        results.push({ index: i, taskId: result.taskId });
      }
    }

    return {
      success: true,
      groupId,
      mainGoal,
      totalSubtasks: subtasks.length,
      tasks: results,
    };
  }

  /**
   * 批量提交任务
   */
  submitTasks(tasks) {
    const results = [];
    for (const task of tasks) {
      results.push(this.submitTask(task));
    }
    return results;
  }

  // ═══════════════════════════════════════
  // 调度逻辑
  // ═══════════════════════════════════════

  _trySchedule() {
    if (this._taskQueue.length === 0) return;

    const runningAgents = this._subAgentManager?._getRunningAgents() || [];
    if (runningAgents.length === 0) return;

    // 检查并发限制
    if (this._activeTasks.size >= this._maxConcurrentTasks) return;

    const availableSlots = this._maxConcurrentTasks - this._activeTasks.size;
    let scheduled = 0;

    for (const task of this._taskQueue) {
      if (scheduled >= availableSlots) break;

      const agent = this._selectAgent(task, runningAgents);
      if (!agent) continue;

      // 安全检查
      if (this._guardian) {
        const auth = this._guardian.authorize(agent.id, 'execute_task', {
          taskId: task.id,
          content: task.content?.substring(0, 100),
        });
        if (!auth.allowed) {
          task.status = TASK_STATUS.FAILED;
          task.error = auth.reason;
          this._stats.tasksFailed++;
          continue;
        }
      }

      // 分配任务
      const assignResult = this._subAgentManager.assignTask(agent.id, task);
      if (assignResult.success) {
        task.status = TASK_STATUS.ASSIGNED;
        task.assignedTo = agent.id;
        task.assignedAt = Date.now();

        this._activeTasks.set(task.id, task);
        this._taskQueue = this._taskQueue.filter(t => t.id !== task.id);

        scheduled++;
        this.emit('task_scheduled', { taskId: task.id, agentId: agent.id });
      }
    }

    if (scheduled > 0) {
      this._logger?.debug?.(`调度完成: ${scheduled} 个任务已分配`);
    }
  }

  /**
   * 根据策略选择Agent
   */
  _selectAgent(task, runningAgents) {
    // 如果指定了目标Agent
    if (task.targetAgentId) {
      const target = runningAgents.find(a => a.id === task.targetAgentId);
      if (target && target.tasks.length < target._maxTasks) return target;
    }

    switch (this._strategy) {
      case SCHEDULE_STRATEGY.ROUND_ROBIN:
        return this._selectRoundRobin(runningAgents);
      case SCHEDULE_STRATEGY.LEAST_LOADED:
        return this._selectLeastLoaded(runningAgents);
      case SCHEDULE_STRATEGY.CAPABILITY_MATCH:
        return this._selectByCapability(task, runningAgents);
      case SCHEDULE_STRATEGY.WEIGHTED:
        return this._selectWeighted(task, runningAgents);
      case SCHEDULE_STRATEGY.ADAPTIVE:
      default:
        return this._selectAdaptive(task, runningAgents);
    }
  }

  _selectRoundRobin(agents) {
    if (agents.length === 0) return null;
    const idx = this._roundRobinIndex % agents.length;
    this._roundRobinIndex++;
    return agents[idx];
  }

  _selectLeastLoaded(agents) {
    if (agents.length === 0) return null;
    return agents.reduce((min, a) => a.tasks.length < min.tasks.length ? a : min, agents[0]);
  }

  _selectByCapability(task, agents) {
    if (!task.requiredCapability) return this._selectLeastLoaded(agents);

    const capable = agents.filter(a => a.capabilities.includes(task.requiredCapability));
    if (capable.length === 0) return this._selectLeastLoaded(agents);

    return this._selectLeastLoaded(capable);
  }

  _selectWeighted(task, agents) {
    // 基于历史表现的加权选择
    const scored = agents.map(a => ({
      agent: a,
      score: this._calculateAgentScore(a),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.agent || null;
  }

  _selectAdaptive(task, agents) {
    // 自适应：能力匹配 + 负载 + 评分综合考量
    let candidates = agents;

    // 能力匹配
    if (task.requiredCapability) {
      const capable = agents.filter(a => a.capabilities.includes(task.requiredCapability));
      if (capable.length > 0) candidates = capable;
    }

    // 综合评分排序
    const scored = candidates.map(a => ({
      agent: a,
      score: this._calculateAgentScore(a) - (a.tasks.length * 0.1),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.agent || null;
  }

  _calculateAgentScore(agent) {
    const total = agent.performance.tasksCompleted + agent.performance.tasksFailed;
    const successRate = total > 0 ? agent.performance.tasksCompleted / total : 0.5;
    const safetyFactor = agent.safetyScore / 100;
    const capacityFactor = 1 - (agent.tasks.length / agent._maxTasks);

    return (successRate * 0.4) + (safetyFactor * 0.4) + (capacityFactor * 0.2);
  }

  // ═══════════════════════════════════════
  // 任务生命周期
  // ═══════════════════════════════════════

  /**
   * 完成任务
   */
  completeTask(taskId, result) {
    const task = this._activeTasks.get(taskId);
    if (!task) {
      return { success: false, error: `任务不存在: ${taskId}` };
    }

    if (result?.error) {
      return this._handleTaskFailure(task, result.error);
    }

    task.status = TASK_STATUS.COMPLETED;
    task.result = result;
    task.completedAt = Date.now();
    task.executionTime = task.completedAt - (task.startedAt || task.assignedAt);

    this._activeTasks.delete(taskId);
    this._addToCompleted(task);
    this._stats.tasksCompleted++;

    // 更新执行时间统计
    this._stats.totalExecutionTime += task.executionTime;
    this._stats.avgExecutionTime = this._stats.totalExecutionTime / this._stats.tasksCompleted;

    // 通知子智能体管理器
    if (task.assignedTo && this._subAgentManager) {
      this._subAgentManager.completeTask(task.assignedTo, taskId, result);
    }

    this.emit('task_completed', { taskId, executionTime: task.executionTime });

    // 尝试调度新任务
    this._trySchedule();

    return { success: true, taskId, status: task.status };
  }

  _handleTaskFailure(task, error) {
    if (task.retryCount < task.maxRetries) {
      // 重试
      task.status = TASK_STATUS.RETRYING;
      task.retryCount++;
      task.error = error;
      this._stats.tasksRetried++;

      this._logger?.warn?.(`任务重试: ${task.id} (第${task.retryCount}/${task.maxRetries}次)`);

      // 延迟重新入队
      const delay = this._retryDelay * Math.pow(2, task.retryCount - 1);
      setTimeout(() => {
        task.status = TASK_STATUS.PENDING;
        task.assignedTo = null;
        this._taskQueue.push(task);
        this._sortQueueByPriority();
        this._trySchedule();
      }, delay);

      this.emit('task_retrying', { taskId: task.id, retryCount: task.retryCount, delay });
      return { success: true, taskId: task.id, status: TASK_STATUS.RETRYING, retryCount: task.retryCount };
    }

    // 最终失败
    task.status = TASK_STATUS.FAILED;
    task.error = error;
    task.completedAt = Date.now();
    task.executionTime = task.completedAt - (task.startedAt || task.assignedAt);

    this._activeTasks.delete(task.id);
    this._addToCompleted(task);
    this._stats.tasksFailed++;

    if (task.assignedTo && this._subAgentManager) {
      this._subAgentManager.completeTask(task.assignedTo, task.id, { error });
    }

    this.emit('task_failed', { taskId: task.id, error, retriesExhausted: true });

    return { success: false, taskId: task.id, status: TASK_STATUS.FAILED, error };
  }

  /**
   * 取消任务
   */
  cancelTask(taskId) {
    // 检查队列中
    const queueIdx = this._taskQueue.findIndex(t => t.id === taskId);
    if (queueIdx !== -1) {
      const task = this._taskQueue.splice(queueIdx, 1)[0];
      task.status = TASK_STATUS.CANCELLED;
      this._addToCompleted(task);
      return { success: true, taskId, status: TASK_STATUS.CANCELLED };
    }

    // 检查活跃任务
    const task = this._activeTasks.get(taskId);
    if (task) {
      task.status = TASK_STATUS.CANCELLED;
      this._activeTasks.delete(taskId);
      this._addToCompleted(task);
      return { success: true, taskId, status: TASK_STATUS.CANCELLED };
    }

    return { success: false, error: '任务不存在或已完成' };
  }

  // ═══════════════════════════════════════
  // 自动调度循环
  // ═══════════════════════════════════════

  startAutoSchedule() {
    if (this._schedulerTimer) return;

    this._schedulerTimer = setInterval(() => {
      this._trySchedule();
      this._checkTaskTimeouts();
    }, this._schedulerInterval);

    this._schedulerTimer.unref && this._schedulerTimer.unref();
    this._logger?.info?.('[Scheduler] 自动调度已启动');
  }

  stopAutoSchedule() {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
    }
    this._logger?.info?.('[Scheduler] 自动调度已停止');
  }

  _checkTaskTimeouts() {
    const now = Date.now();
    for (const [taskId, task] of this._activeTasks) {
      if (task.assignedAt && (now - task.assignedAt) > task.timeout) {
        this._logger?.warn?.(`任务超时: ${taskId}`);
        this._handleTaskFailure(task, '任务执行超时');
      }
    }
  }

  // ═══════════════════════════════════════
  // 查询与统计
  // ═══════════════════════════════════════

  getQueueStats() {
    return {
      queueDepth: this._taskQueue.length,
      activeTasks: this._activeTasks.size,
      completedTasks: this._completedTasks.length,
      strategy: this._strategy,
      ...this._stats,
    };
  }

  getTask(taskId) {
    // 搜索活跃任务
    if (this._activeTasks.has(taskId)) {
      return this._activeTasks.get(taskId);
    }

    // 搜索队列
    const queued = this._taskQueue.find(t => t.id === taskId);
    if (queued) return queued;

    // 搜索已完成
    const completed = this._completedTasks.find(t => t.id === taskId);
    if (completed) return completed;

    return null;
  }

  getActiveTasks() {
    return Array.from(this._activeTasks.values());
  }

  getQueuedTasks() {
    return [...this._taskQueue];
  }

  getCompletedTasks(limit = 50) {
    return this._completedTasks.slice(-limit);
  }

  // ═══════════════════════════════════════
  // 策略管理
  // ═══════════════════════════════════════

  setStrategy(strategy) {
    if (Object.values(SCHEDULE_STRATEGY).includes(strategy)) {
      this._strategy = strategy;
      this._logger?.info?.(`调度策略切换: ${strategy}`);
      return { success: true, strategy };
    }
    return { success: false, error: `无效策略: ${strategy}` };
  }

  getStrategy() {
    return this._strategy;
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _sortQueueByPriority() {
    this._taskQueue.sort((a, b) => b.priority - a.priority);
  }

  _addToCompleted(task) {
    this._completedTasks.push(task);
    if (this._completedTasks.length > this._maxCompletedTasks) {
      this._completedTasks = this._completedTasks.slice(-this._maxCompletedTasks);
    }
  }

  close() {
    this.stopAutoSchedule();
    this._activeTasks.clear();
    this._taskQueue = [];
  }
}

module.exports = {
  SubAgentScheduler,
  SCHEDULE_STRATEGY,
  TASK_STATUS,
  TASK_PRIORITY,
};
