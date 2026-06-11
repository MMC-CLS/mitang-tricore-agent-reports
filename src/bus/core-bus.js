/**
 * TriCore Agent - 核心总线 (Core Bus)
 *
 * 核心问题：三种不同哲学的系统融合，调试难度指数级上升。
 *   - 意识核：TICK驱动，异步事件，状态模糊
 *   - 执行核：任务闭环，同步流程，状态确定
 *   - 进化核：定时循环，后台静默，不可观测
 *
 * 解决方案：
 *   1. 统一事件总线 - 三核通过唯一通道通信，所有跨核消息可追踪
 *   2. 关联ID追踪 - 每个用户请求生成traceId，贯穿三核全链路
 *   3. 结构化日志 - 每个事件带traceId/coreName/timestamp/phase，可搜索
 *   4. 调试探针 - 按traceId回放完整事件链，定位问题根因
 *   5. 诊断API - 一键获取系统健康快照、事件统计、瓶颈分析
 *
 * 架构原则："三核不直接对话，只通过CoreBus传递消息"
 */

'use strict';

const { EventEmitter } = require('events');

// ── 事件通道（三核+基础设施） ──
const CHANNEL = Object.freeze({
  CONSCIOUSNESS: 'consciousness',  // 意识核事件
  EXECUTION: 'execution',          // 执行核事件
  EVOLUTION: 'evolution',          // 进化核事件
  SCHEDULER: 'scheduler',          // 调度器事件
  SYSTEM: 'system',                // 系统级事件
});

// ── 事件类型 ──
const BUS_EVENT = Object.freeze({
  // 意识→执行：意识核建议执行任务
  CONSCIOUSNESS_TASK_REQUEST: 'consciousness:task_request',
  // 意识→进化：意识核触发技能搜索
  CONSCIOUSNESS_SKILL_QUERY: 'consciousness:skill_query',
  // 执行→意识：执行核上报任务完成
  EXECUTION_TASK_COMPLETE: 'execution:task_complete',
  // 执行→意识：执行核上报任务失败
  EXECUTION_TASK_FAILED: 'execution:task_failed',
  // 执行→进化：执行核请求技能沉淀
  EXECUTION_SKILL_EXTRACT: 'execution:skill_extract',
  // 进化→执行：进化核发布已审计技能
  EVOLUTION_SKILL_PUBLISHED: 'evolution:skill_published',
  // 进化→意识：进化核通知整合完成
  EVOLUTION_CONSOLIDATION_DONE: 'evolution:consolidation_done',
  // 调度器→全局：模式切换
  SCHEDULER_MODE_CHANGE: 'scheduler:mode_change',
  // 调度器→全局：TICK事件
  SCHEDULER_TICK: 'scheduler:tick',
  // 意识→全局：TICK完成（v1.0新增）
  CONSCIOUSNESS_TICK_COMPLETE: 'consciousness:tick_complete',
  // 系统级：错误
  SYSTEM_ERROR: 'system:error',
  // 系统级：警告
  SYSTEM_WARNING: 'system:warning',
  // 系统级：预算告警
  SYSTEM_BUDGET_WARNING: 'system:budget_warning',
});

// ── 事件优先级 ──
const EVENT_PRIORITY = Object.freeze({
  CRITICAL: 0,          // 错误、安全告警 — 立即同步处理
  PRIORITY_IMMEDIATE: 0, // v2.0: CRITICAL别名，语义更明确
  HIGH: 1,              // 任务完成/失败 — 立即同步处理
  PRIORITY_HIGH: 1,      // v2.0: HIGH别名
  NORMAL: 2,            // 正常跨核消息 — 异步队列
  LOW: 3,               // 整合完成、模式切换 — 异步队列
  TRACE: 4,             // 调试追踪 — 异步队列
});

class CoreBus extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── 事件日志 ──
    this._eventLog = [];            // 所有事件的结构化日志
    this._maxLogSize = options.maxLogSize ?? 10000;

    // ── 关联追踪 ──
    this._activeTraces = new Map(); // traceId → { startTime, events, cores }

    // ── 订阅管理 ──
    this._subscriptions = new Map(); // channel → Set<callback>
    this._interceptors = [];         // 拦截器（中间件）

    // ── 调试模式 ──
    this._debugMode = options.debugMode ?? false;
    this._breakpoints = new Map();   // eventType → callback(condition)

    // ── 性能统计 ──
    this._stats = {
      totalEvents: 0,
      eventsByChannel: {},
      eventsByType: {},
      avgLatency: 0,
      latencySum: 0,
      errorCount: 0,
    };

    // ── 跨核调用计时 ──
    this._pendingRequests = new Map(); // requestId → { traceId, startTime, core, type }

    // ── v2.0: 事件优先级队列 ──
    // 按 EVENT_PRIORITY 分级处理：CRITICAL(0) > HIGH(1) > NORMAL(2) > LOW(3) > TRACE(4)
    this._priorityQueues = [
      [], // CRITICAL (0)
      [], // HIGH (1)
      [], // NORMAL (2)
      [], // LOW (3)
      [], // TRACE (4)
    ];
    this._priorityProcessing = false; // 防止并发处理
    this._priorityBatchSize = 32;      // 每轮最多处理事件数，防止饥饿
  }

  // ═══════════════════════════════════════
  // 核心接口：发送事件
  // ═══════════════════════════════════════

  /**
   * 发送跨核事件（唯一合法的跨核通信方式，v2.0: 优先级队列）
   *
   * v2.0 优先级队列策略：
   *   - PRIORITY_IMMEDIATE (CRITICAL): 立即同步处理，不进入队列
   *   - PRIORITY_HIGH: 进入高优先级队列，优先于 NORMAL/LOW
   *   - NORMAL/LOW/TRACE: 按序排队，批处理
   *   - 队列满时触发 _flushPriorityQueue 批量处理
   *
   * @param {string} eventType - BUS_EVENT中的类型
   * @param {Object} data - 事件数据
   * @param {Object} meta - { source, traceId?, priority? }
   * @returns {string} eventId
   */
  dispatch(eventType, data = {}, meta = {}) {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = Date.now();
    const priority = meta.priority ?? EVENT_PRIORITY.NORMAL;

    const event = {
      id: eventId,
      type: eventType,
      data,
      meta: {
        source: meta.source || 'unknown',
        traceId: meta.traceId || null,
        priority,
        timestamp,
        sequence: this._stats.totalEvents,
      },
    };

    // 拦截器
    for (const interceptor of this._interceptors) {
      try {
        const result = interceptor(event);
        if (result === false) {
          // 拦截器拒绝，事件被丢弃
          this._logEvent({ ...event, intercepted: true });
          return eventId;
        }
      } catch (e) {
        // 拦截器出错，不影响主流程
      }
    }

    // 断点检查
    if (this._debugMode && this._breakpoints.has(eventType)) {
      const bpCallback = this._breakpoints.get(eventType);
      if (bpCallback(event)) {
        this.emit('breakpoint_hit', { event });
        // 断点命中，事件暂停（需要手动resume）
        this._logEvent({ ...event, breakpoint: true });
        return eventId;
      }
    }

    // 记录日志
    this._logEvent(event);

    // 更新追踪链
    if (event.meta.traceId) {
      this._updateTrace(event.meta.traceId, event);
    }

    // 更新统计
    this._updateStats(event);

    // ── v2.0: 按优先级分发 ──
    if (priority <= EVENT_PRIORITY.HIGH) {
      // CRITICAL (0) 和 HIGH (1) 事件立即处理，不走队列
      this._deliver(event);
    } else {
      // NORMAL (2), LOW (3), TRACE (4) 事件入队，批量异步处理
      const queueIdx = Math.min(priority, this._priorityQueues.length - 1);
      this._priorityQueues[queueIdx].push(event);

      // 队列积压达到阈值时触发刷新
      const totalQueued = this._priorityQueues.reduce((sum, q) => sum + q.length, 0);
      if (totalQueued >= this._priorityBatchSize) {
        this._flushPriorityQueue();
      }
    }

    // 同时emit给外部监听者（保留同步emit，向后兼容）
    this.emit(eventType, event);
    this.emit('*', event);  // 全局监听

    return eventId;
  }

  /**
   * 刷新优先级队列（v2.0新增）
   *
   * 按优先级从高到低批量处理队列中的事件。
   * 使用 setImmediate 异步执行，防止饥饿高优先级事件。
   * 每轮最多处理 _priorityBatchSize 个事件，防止事件循环阻塞。
   */
  _flushPriorityQueue() {
    if (this._priorityProcessing) return; // 已在处理中
    this._priorityProcessing = true;

    setImmediate(() => {
      try {
        let processed = 0;
        // 从高优先级(0)到低优先级(4)依次处理
        for (let pri = 0; pri < this._priorityQueues.length && processed < this._priorityBatchSize; pri++) {
          const queue = this._priorityQueues[pri];
          while (queue.length > 0 && processed < this._priorityBatchSize) {
            const event = queue.shift();
            this._deliver(event);
            processed++;
          }
        }

        // 如果还有剩余事件，安排下一轮处理
        const remaining = this._priorityQueues.reduce((sum, q) => sum + q.length, 0);
        if (remaining > 0) {
          setImmediate(() => {
            this._priorityProcessing = false;
            this._flushPriorityQueue();
          });
        }
      } catch (e) {
        // 队列处理异常不应丢失事件
      }
      this._priorityProcessing = false;
    });
  }

  // ═══════════════════════════════════════
  // 订阅机制
  // ═══════════════════════════════════════

  /**
   * 订阅某个通道的所有事件
   * @param {string} channel - CHANNEL中的通道
   * @param {Function} callback - (event) => void
   * @returns {Function} unsubscribe函数
   */
  subscribe(channel, callback) {
    if (!this._subscriptions.has(channel)) {
      this._subscriptions.set(channel, new Set());
    }
    this._subscriptions.get(channel).add(callback);

    // 返回取消订阅函数
    return () => {
      const subs = this._subscriptions.get(channel);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          this._subscriptions.delete(channel);
        }
      }
    };
  }

  /**
   * 订阅特定事件类型
   * @param {string} eventType - BUS_EVENT中的类型
   * @param {Function} callback
   * @returns {Function} unsubscribe函数
   */
  onEventType(eventType, callback) {
    return this.on(eventType, callback);
  }

  // ═══════════════════════════════════════
  // 拦截器（中间件）
  // ═══════════════════════════════════════

  /**
   * 添加拦截器
   * @param {Function} interceptor - (event) => boolean|void
   *   返回false表示拦截（丢弃事件）
   */
  use(interceptor) {
    this._interceptors.push(interceptor);
  }

  // ═══════════════════════════════════════
  // 关联追踪
  // ═══════════════════════════════════════

  /**
   * 创建新的追踪ID（用于用户请求的全链路追踪）
   * @param {string} source - 发起方
   * @param {Object} context - 初始上下文
   * @returns {string} traceId
   */
  startTrace(source, context = {}) {
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this._activeTraces.set(traceId, {
      startTime: Date.now(),
      source,
      context,
      events: [],
      cores: new Set([source]),
      status: 'active',  // active | completed | failed | timeout
    });

    // 超时自动清理（5分钟）
    setTimeout(() => {
      const trace = this._activeTraces.get(traceId);
      if (trace && trace.status === 'active') {
        trace.status = 'timeout';
        this.emit('trace_timeout', { traceId });
      }
    }, 300000);

    return traceId;
  }

  /**
   * 完成追踪
   */
  completeTrace(traceId, status = 'completed') {
    const trace = this._activeTraces.get(traceId);
    if (trace) {
      trace.status = status;
      trace.endTime = Date.now();
      trace.duration = trace.endTime - trace.startTime;
    }
  }

  /**
   * 获取追踪链（用于调试回放）
   * @param {string} traceId
   * @returns {Object} 完整追踪信息
   */
  getTrace(traceId) {
    const trace = this._activeTraces.get(traceId);
    if (!trace) return null;

    return {
      traceId,
      startTime: trace.startTime,
      endTime: trace.endTime || null,
      duration: trace.duration || null,
      source: trace.source,
      status: trace.status,
      cores: [...trace.cores],
      eventCount: trace.events.length,
      events: trace.events.map(e => ({
        id: e.id,
        type: e.type,
        source: e.meta?.source,
        timestamp: e.meta?.timestamp,
        dataKeys: Object.keys(e.data || {}),
      })),
      timeline: this._buildTimeline(trace.events),
    };
  }

  /**
   * 获取所有活跃追踪
   */
  getActiveTraces() {
    const result = [];
    for (const [traceId, trace] of this._activeTraces) {
      if (trace.status === 'active') {
        result.push({
          traceId,
          source: trace.source,
          startTime: trace.startTime,
          duration: Date.now() - trace.startTime,
          eventCount: trace.events.length,
          cores: [...trace.cores],
        });
      }
    }
    return result;
  }

  /**
   * 构建时间线（事件链可视化）
   */
  _buildTimeline(events) {
    if (events.length === 0) return [];

    const baseTime = events[0].meta?.timestamp || Date.now();
    return events.map(e => ({
      offset: ((e.meta?.timestamp || Date.now()) - baseTime) + 'ms',
      type: e.type,
      source: e.meta?.source || '?',
      summary: this._summarizeEvent(e),
    }));
  }

  _summarizeEvent(event) {
    const d = event.data || {};
    switch (event.type) {
      case BUS_EVENT.CONSCIOUSNESS_TASK_REQUEST:
        return `任务请求: ${d.goal?.substring(0, 50) || 'unknown'}`;
      case BUS_EVENT.EXECUTION_TASK_COMPLETE:
        return `任务完成: ${d.taskId}`;
      case BUS_EVENT.EXECUTION_TASK_FAILED:
        return `任务失败: ${d.taskId} - ${d.error?.substring(0, 30) || 'unknown'}`;
      case BUS_EVENT.EXECUTION_SKILL_EXTRACT:
        return `技能提取: ${d.taskId}`;
      case BUS_EVENT.EVOLUTION_SKILL_PUBLISHED:
        return `技能发布: ${d.name}`;
      case BUS_EVENT.SCHEDULER_MODE_CHANGE:
        return `模式切换: ${d.from} → ${d.to}`;
      default:
        return event.type;
    }
  }

  // ═══════════════════════════════════════
  // 调试探针
  // ═══════════════════════════════════════

  /**
   * 设置断点
   * @param {string} eventType - 事件类型
   * @param {Function} condition - (event) => boolean 命中条件
   */
  setBreakpoint(eventType, condition = () => true) {
    this._breakpoints.set(eventType, condition);
    this._debugMode = true;
  }

  /**
   * 移除断点
   */
  removeBreakpoint(eventType) {
    this._breakpoints.delete(eventType);
    if (this._breakpoints.size === 0) {
      this._debugMode = false;
    }
  }

  /**
   * 查询事件日志
   * @param {Object} filter - { traceId?, source?, type?, since?, limit? }
   * @returns {Array} 匹配的事件列表
   */
  queryEvents(filter = {}) {
    let results = this._eventLog;

    if (filter.traceId) {
      results = results.filter(e => e.meta?.traceId === filter.traceId);
    }
    if (filter.source) {
      results = results.filter(e => e.meta?.source === filter.source);
    }
    if (filter.type) {
      results = results.filter(e => e.type === filter.type);
    }
    if (filter.since) {
      results = results.filter(e => (e.meta?.timestamp || 0) >= filter.since);
    }

    return results.slice(-(filter.limit || 100));
  }

  // ═══════════════════════════════════════
  // 诊断API
  // ═══════════════════════════════════════

  /**
   * 获取系统诊断快照
   */
  getDiagnostics() {
    const traceStats = {
      total: this._activeTraces.size,
      active: [...this._activeTraces.values()].filter(t => t.status === 'active').length,
      completed: [...this._activeTraces.values()].filter(t => t.status === 'completed').length,
      failed: [...this._activeTraces.values()].filter(t => t.status === 'failed').length,
      timeout: [...this._activeTraces.values()].filter(t => t.status === 'timeout').length,
    };

    // 瓶颈分析：哪个核产生最多事件
    const coreEventCounts = {};
    for (const event of this._eventLog.slice(-1000)) {
      const source = event.meta?.source || 'unknown';
      coreEventCounts[source] = (coreEventCounts[source] || 0) + 1;
    }

    // 事件类型分布
    const typeDistribution = {};
    for (const [type, count] of Object.entries(this._stats.eventsByType)) {
      typeDistribution[type] = count;
    }

    return {
      stats: {
        totalEvents: this._stats.totalEvents,
        errorCount: this._stats.errorCount,
        avgLatency: this._stats.avgLatency.toFixed(2) + 'ms',
        eventsByChannel: this._stats.eventsByChannel,
        typeDistribution,
      },
      traces: traceStats,
      bottleneck: {
        coreEventCounts,
        topCore: Object.entries(coreEventCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([core, count]) => ({ core, events: count })),
      },
      debugMode: this._debugMode,
      breakpoints: [...this._breakpoints.keys()],
      logSize: this._eventLog.length,
    };
  }

  /**
   * 获取事件时间线（用于可视化）
   * @param {number} lastN - 最近N个事件
   */
  getTimeline(lastN = 50) {
    return this._eventLog.slice(-lastN).map(e => ({
      id: e.id,
      type: e.type,
      source: e.meta?.source,
      timestamp: e.meta?.timestamp,
      traceId: e.meta?.traceId,
      priority: e.meta?.priority,
    }));
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  _logEvent(event) {
    this._eventLog.push(event);
    if (this._eventLog.length > this._maxLogSize) {
      this._eventLog = this._eventLog.slice(-this._maxLogSize);
    }
  }

  _updateTrace(traceId, event) {
    const trace = this._activeTraces.get(traceId);
    if (!trace) return;

    trace.events.push(event);
    if (event.meta?.source) {
      trace.cores.add(event.meta.source);
    }
  }

  _updateStats(event) {
    this._stats.totalEvents++;

    const source = event.meta?.source || 'unknown';
    this._stats.eventsByChannel[source] = (this._stats.eventsByChannel[source] || 0) + 1;

    this._stats.eventsByType[event.type] = (this._stats.eventsByType[event.type] || 0) + 1;

    if (event.type === BUS_EVENT.SYSTEM_ERROR) {
      this._stats.errorCount++;
    }
  }

  /**
   * 分发事件到订阅者（v2.0: 异步化，避免订阅者阻塞事件循环）
   *
   * 异步化策略：
   *   - 订阅者回调通过 setImmediate 异步执行
   *   - 每个订阅者独立 try/catch，单个失败不影响其他
   *   - 同步 emit 保留用于向后兼容（EventEmitter.on 的监听者）
   *   - 按通道分发和按事件类型分发的订阅者均异步化
   */
  _deliver(event) {
    // 按通道分发（异步化）
    const source = event.meta?.source;
    if (source && this._subscriptions.has(source)) {
      for (const callback of this._subscriptions.get(source)) {
        // ── v2.0: setImmediate 异步执行，不阻塞当前 dispatch 调用栈 ──
        setImmediate(() => {
          try {
            callback(event);
          } catch (e) {
            // v1.0: 记录订阅者异常（不再静默吞错误）
            this._logSubscriberError(source, event.type, e);
          }
        });
      }
    }

    // 按事件类型分发（从事件类型推断目标通道，异步化）
    const targetChannel = this._inferTargetChannel(event.type);
    if (targetChannel && targetChannel !== source && this._subscriptions.has(targetChannel)) {
      for (const callback of this._subscriptions.get(targetChannel)) {
        // ── v2.0: setImmediate 异步执行 ──
        setImmediate(() => {
          try {
            callback(event);
          } catch (e) {
            // v1.0: 记录订阅者异常（不再静默吞错误）
            this._logSubscriberError(targetChannel, event.type, e);
          }
        });
      }
    }
  }

  _inferTargetChannel(eventType) {
    if (eventType.startsWith('consciousness:')) return CHANNEL.CONSCIOUSNESS;
    if (eventType.startsWith('execution:')) return CHANNEL.EXECUTION;
    if (eventType.startsWith('evolution:')) return CHANNEL.EVOLUTION;
    if (eventType.startsWith('scheduler:')) return CHANNEL.SCHEDULER;
    return CHANNEL.SYSTEM;
  }

  /**
   * v1.0: 记录订阅者异常（不再静默吞错误）
   *
   * 将订阅者抛出的异常写入事件日志并递增错误计数，
   * 确保调试时能追踪到订阅者代码中的bug。
   *
   * @param {string} channel - 订阅通道
   * @param {string} eventType - 事件类型
   * @param {Error} error - 订阅者抛出的异常
   */
  _logSubscriberError(channel, eventType, error) {
    const errorEntry = {
      type: 'subscriber_error',
      channel,
      eventType,
      error: error.message,
      stack: error.stack?.substring(0, 500) || '',
      timestamp: Date.now(),
    };
    this._eventLog.push(errorEntry);
    this._stats.errorCount++;
    // 同时emit错误事件，供外部监听
    this.emit('subscriber_error', errorEntry);
  }
}

// ── 导出 ──
module.exports = {
  CoreBus,
  CHANNEL,
  BUS_EVENT,
  EVENT_PRIORITY,
};
