/**
 * TriCore Agent - 统一调度器 (Unified Scheduler)
 *
 * 核心设计原则："意识不碰手，执行不经脑"
 *
 * 三层调度：
 *   意识层 (Consciousness) - TICK驱动，自主思考，只建议不执行
 *   执行层 (Execution)     - 任务闭环，桌面控制，按确定流程运行
 *   进化层 (Evolution)     - 技能沉淀，知识积累，受安全审计约束
 *
 * 调度规则：
 *   1. 意识TICK和执行任务通过优先级仲裁，不会同时占用LLM
 *   2. 执行任务有明确的开始/结束，不与TICK循环冲突
 *   3. 进化操作在空闲时段执行，不抢占意识/执行资源
 */

'use strict';

const { EventEmitter } = require('events');

// ── 调度优先级常量 ──
const PRIORITY = Object.freeze({
  IMMEDIATE: 1000,   // 用户消息 / 紧急执行任务
  HIGH: 500,         // 后台消息 / 执行任务步骤
  NORMAL: 100,       // 意识TICK / 常规进化操作
  LOW: 50,           // 记忆整合 / 技能审计
  IDLE: 10,          // 空闲探索 / 背景进化
});

// ── 运行模式 ──
const MODE = Object.freeze({
  CONSCIOUSNESS: 'consciousness',  // 意识模式：TICK驱动，自主思考
  EXECUTION: 'execution',          // 执行模式：任务闭环，桌面控制
  EVOLUTION: 'evolution',          // 进化模式：技能沉淀，知识整合
  IDLE: 'idle',                    // 空闲模式：等待事件
});

// ── TICK间隔策略 (毫秒) ──
const TICK_INTERVALS = Object.freeze({
  AWAKENING: 10_000,     // 觉醒期：10秒
  TASK_ACTIVE: 30_000,   // 有活跃任务：30秒
  CONSCIOUSNESS: 300_000, // 意识TICK：5分钟（比白龙马20分钟更省Token）
  EVOLUTION: 600_000,    // 进化操作：10分钟
  IDLE: 1_200_000,       // 空闲：20分钟
  RATE_LIMITED: 600_000, // 限流：10分钟
});

// ── 调度事件类型 ──
const SCHEDULE_EVENTS = Object.freeze({
  TICK: 'tick',
  MODE_CHANGE: 'mode_change',
  TASK_START: 'task_start',
  TASK_STEP: 'task_step',
  TASK_COMPLETE: 'task_complete',
  TASK_FAILED: 'task_failed',
  SKILL_LEARN: 'skill_learn',
  SKILL_AUDIT: 'skill_audit',
  MEMORY_CONSOLIDATE: 'memory_consolidate',
  AWAKENING_START: 'awakening_start',
  AWAKENING_COMPLETE: 'awakening_complete',
});

class UnifiedScheduler extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── 调度状态 ──
    this._running = false;
    this._currentMode = MODE.IDLE;
    this._tickCounter = 0;
    this._awakeningTicksRemaining = options.awakeningTicks ?? 10;
    this._initialAwakeningTicks = this._awakeningTicksRemaining;

    // ── 计时器 ──
    this._timer = null;
    this._customInterval = null;     // { seconds, ttl, consumed }
    this._lastTickAt = 0;

    // ── 执行任务队列 ──
    this._executionQueue = [];       // { id, steps, currentStep, priority }
    this._activeTask = null;

    // ── 进化队列 ──
    this._evolutionQueue = [];       // { id, type, priority, payload }

    // ── 配额状态 ──
    this._rateLimited = false;
    this._rateLimitUntil = 0;

    // ── 安全约束 ──
    this._maxConsciousnessTicksPerHour = options.maxConsciousnessTicksPerHour ?? 12;
    this._consciousnessTickCount = 0;
    this._consciousnessTickWindowStart = Date.now();

    // ── 看门狗 ──
    this._watchdogTimeout = options.watchdogTimeout ?? 180_000; // 180秒
    this._watchdogTimer = null;
  }

  // ═══════════════════════════════════════
  // 公共接口
  // ═══════════════════════════════════════

  /**
   * 启动调度器
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._awakeningTicksRemaining = this._initialAwakeningTicks;
    this._currentMode = MODE.CONSCIOUSNESS;
    this.emit(SCHEDULE_EVENTS.MODE_CHANGE, { from: MODE.IDLE, to: MODE.CONSCIOUSNESS });
    this.emit(SCHEDULE_EVENTS.AWAKENING_START, { ticksRemaining: this._awakeningTicksRemaining });
    this._scheduleNextTick();
  }

  /**
   * 停止调度器
   */
  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._clearWatchdog();
  }

  /**
   * 暂停调度（不停止，保留状态）
   */
  pause() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._clearWatchdog();
  }

  /**
   * 恢复调度
   */
  resume() {
    if (this._running && !this._timer) {
      this._scheduleNextTick();
    }
  }

  /**
   * 提交执行任务
   * @param {Object} task - { id, steps: [{action, params}], priority }
   * @returns {string} taskId
   */
  submitExecutionTask(task) {
    const entry = {
      id: task.id || `exec_${Date.now()}`,
      steps: task.steps || [],
      currentStep: 0,
      priority: task.priority ?? PRIORITY.HIGH,
      createdAt: Date.now(),
    };
    this._executionQueue.push(entry);
    this._executionQueue.sort((a, b) => b.priority - a.priority);

    // 如果当前在意识TICK，可以中断让执行任务优先
    if (this._currentMode === MODE.CONSCIOUSNESS && entry.priority >= PRIORITY.HIGH) {
      this._triggerImmediateTick();
    }

    return entry.id;
  }

  /**
   * 提交进化操作
   * @param {Object} op - { id, type, priority, payload }
   */
  submitEvolutionOp(op) {
    const entry = {
      id: op.id || `evo_${Date.now()}`,
      type: op.type,  // skill_learn | skill_audit | memory_consolidate | ...
      priority: op.priority ?? PRIORITY.LOW,
      payload: op.payload,
      createdAt: Date.now(),
    };
    this._evolutionQueue.push(entry);
    this._evolutionQueue.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 设置自定义TICK间隔（意识层自主调节）
   * @param {number} seconds - 间隔秒数
   * @param {number} ttl - 持续轮数
   */
  setCustomTickInterval(seconds, ttl) {
    this._customInterval = { seconds, ttl, consumed: 0 };
  }

  /**
   * 通知配额限制
   * @param {number} until - 限流截止时间戳
   */
  notifyRateLimit(until) {
    this._rateLimited = true;
    this._rateLimitUntil = until;
  }

  /**
   * 获取调度器状态快照
   */
  getStatus() {
    return {
      running: this._running,
      mode: this._currentMode,
      tickCounter: this._tickCounter,
      awakeningTicksRemaining: this._awakeningTicksRemaining,
      activeTask: this._activeTask ? {
        id: this._activeTask.id,
        currentStep: this._activeTask.currentStep,
        totalSteps: this._activeTask.steps.length,
      } : null,
      executionQueueLength: this._executionQueue.length,
      evolutionQueueLength: this._evolutionQueue.length,
      rateLimited: this._rateLimited,
      customInterval: this._customInterval,
    };
  }

  // ═══════════════════════════════════════
  // 核心调度逻辑
  // ═══════════════════════════════════════

  /**
   * 计算下一次TICK间隔
   * 优先级：执行任务 > 限流 > 自定义间隔 > 觉醒期 > 活跃任务 > 意识TICK > 空闲
   */
  _computeNextInterval() {
    // 1. 有高优先级执行任务 → 立即
    if (this._hasHighPriorityExecutionTask()) {
      return 0;
    }

    // 2. 限流中
    if (this._rateLimited && Date.now() < this._rateLimitUntil) {
      return TICK_INTERVALS.RATE_LIMITED;
    }
    this._rateLimited = false;

    // 3. L2自定义节奏
    if (this._customInterval && this._customInterval.consumed < this._customInterval.ttl) {
      return this._customInterval.seconds * 1000;
    }

    // 4. 觉醒期
    if (this._awakeningTicksRemaining > 0) {
      return TICK_INTERVALS.AWAKENING;
    }

    // 5. 有活跃执行任务
    if (this._activeTask) {
      return TICK_INTERVALS.TASK_ACTIVE;
    }

    // 6. 有待处理进化操作
    if (this._evolutionQueue.length > 0) {
      return TICK_INTERVALS.EVOLUTION;
    }

    // 7. 空闲意识TICK（受小时配额约束）
    if (this._consciousnessTickCount < this._maxConsciousnessTicksPerHour) {
      return TICK_INTERVALS.CONSCIOUSNESS;
    }

    // 8. 意识TICK配额耗尽，进入空闲
    return TICK_INTERVALS.IDLE;
  }

  /**
   * 决定本轮运行模式
   */
  _decideMode() {
    // 优先处理执行任务
    if (this._activeTask || this._hasHighPriorityExecutionTask()) {
      return MODE.EXECUTION;
    }

    // 觉醒期强制意识模式
    if (this._awakeningTicksRemaining > 0) {
      return MODE.CONSCIOUSNESS;
    }

    // 低优先级进化操作在空闲时段执行
    if (this._currentMode === MODE.IDLE && this._evolutionQueue.length > 0) {
      return MODE.EVOLUTION;
    }

    // 意识TICK配额未耗尽
    if (this._consciousnessTickCount < this._maxConsciousnessTicksPerHour) {
      return MODE.CONSCIOUSNESS;
    }

    return MODE.IDLE;
  }

  /**
   * 执行一个TICK
   */
  _onTick() {
    if (!this._running) return;

    this._tickCounter++;
    this._lastTickAt = Date.now();
    // v4.0: 重置看门狗，防止TICK执行超时
    this._resetWatchdog();

    // 重置意识TICK小时配额
    this._resetConsciousnessWindowIfNeeded();

    // 决定模式
    const newMode = this._decideMode();
    if (newMode !== this._currentMode) {
      const oldMode = this._currentMode;
      this._currentMode = newMode;
      this.emit(SCHEDULE_EVENTS.MODE_CHANGE, { from: oldMode, to: newMode });
    }

    // 按模式执行
    switch (this._currentMode) {
      case MODE.EXECUTION:
        this._executeTaskStep();
        break;
      case MODE.CONSCIOUSNESS:
        this._executeConsciousnessTick();
        break;
      case MODE.EVOLUTION:
        this._executeEvolutionOp();
        break;
      case MODE.IDLE:
        // 空闲，等待事件
        break;
    }

    // 更新自定义间隔消耗（仅在意识模式下消耗）
    if (this._customInterval && this._currentMode === MODE.CONSCIOUSNESS) {
      this._customInterval.consumed++;
      if (this._customInterval.consumed >= this._customInterval.ttl) {
        this._customInterval = null;
      }
    }

    // 调度下一轮
    this._resetWatchdog();
    this._scheduleNextTick();
  }

  /**
   * 意识层TICK执行
   */
  _executeConsciousnessTick() {
    // 觉醒期递减
    if (this._awakeningTicksRemaining > 0) {
      this._awakeningTicksRemaining--;
      if (this._awakeningTicksRemaining === 0) {
        this.emit(SCHEDULE_EVENTS.AWAKENING_COMPLETE);
      }
    }

    // 意识TICK配额计数
    this._consciousnessTickCount++;

    // 发出TICK事件，由意识层处理器响应
    this.emit(SCHEDULE_EVENTS.TICK, {
      tickNumber: this._tickCounter,
      mode: MODE.CONSCIOUSNESS,
      isAwakening: this._awakeningTicksRemaining > 0,
      awakeningRemaining: this._awakeningTicksRemaining,
    });
  }

  /**
   * 执行层任务步骤执行
   */
  _executeTaskStep() {
    // 如果没有活跃任务，从队列取一个
    if (!this._activeTask) {
      if (this._executionQueue.length === 0) return;
      this._activeTask = this._executionQueue.shift();
      this.emit(SCHEDULE_EVENTS.TASK_START, {
        taskId: this._activeTask.id,
        totalSteps: this._activeTask.steps.length,
      });
    }

    const step = this._activeTask.steps[this._activeTask.currentStep];
    if (!step) {
      // 任务完成
      this.emit(SCHEDULE_EVENTS.TASK_COMPLETE, {
        taskId: this._activeTask.id,
      });
      this._activeTask = null;
      return;
    }

    this.emit(SCHEDULE_EVENTS.TASK_STEP, {
      taskId: this._activeTask.id,
      stepIndex: this._activeTask.currentStep,
      totalSteps: this._activeTask.steps.length,
      step,
    });

    this._activeTask.currentStep++;
  }

  /**
   * 进化层操作执行
   */
  _executeEvolutionOp() {
    if (this._evolutionQueue.length === 0) return;

    const op = this._evolutionQueue.shift();

    switch (op.type) {
      case 'skill_learn':
        this.emit(SCHEDULE_EVENTS.SKILL_LEARN, op);
        break;
      case 'skill_audit':
        this.emit(SCHEDULE_EVENTS.SKILL_AUDIT, op);
        break;
      case 'memory_consolidate':
        this.emit(SCHEDULE_EVENTS.MEMORY_CONSOLIDATE, op);
        break;
      default:
        // 未知类型，跳过
        break;
    }
  }

  /**
   * 调度下一次TICK
   */
  _scheduleNextTick() {
    if (!this._running) return;

    const interval = this._computeNextInterval();
    this._timer = setTimeout(() => this._onTick(), interval);
  }

  /**
   * 立即触发TICK
   */
  _triggerImmediateTick() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._onTick();
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _hasHighPriorityExecutionTask() {
    return this._executionQueue.some(t => t.priority >= PRIORITY.HIGH);
  }

  _resetConsciousnessWindowIfNeeded() {
    const now = Date.now();
    if (now - this._consciousnessTickWindowStart >= 3600_000) {
      this._consciousnessTickCount = 0;
      this._consciousnessTickWindowStart = now;
    }
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // v4.0: 看门狗重置（借鉴白龙马BaiLongma runTurnWithWatchdog模式）
  _resetWatchdog() {
    this._clearWatchdog();
    this._watchdogTimer = setTimeout(() => {
      this.emit('watchdog_timeout', { tickNumber: this._tickCounter, mode: this._currentMode });
      // Force recover by scheduling next tick
      this._scheduleNextTick();
    }, this._watchdogTimeout);
  }
}

// ── 导出 ──
module.exports = {
  UnifiedScheduler,
  PRIORITY,
  MODE,
  TICK_INTERVALS,
  SCHEDULE_EVENTS,
};
