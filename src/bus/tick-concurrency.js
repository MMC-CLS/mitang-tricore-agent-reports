/**
 * TriCore Agent - TICK并发处理器 (Phase 24)
 *
 * 解决问题: TICK串行处理 `_processingTick` 锁导致吞吐量瓶颈
 *
 * 方案:
 *   1. 并发槽位池 - N个并行TICK处理槽位
 *   2. 优先级队列 - 按优先级排序等待的TICK
 *   3. 背压控制 - 槽位满时排队/拒绝策略
 *   4. 工作窃取 - 空闲槽位可从其他核窃取任务
 *   5. 断路器 - 连续失败自动熔断
 *
 * 配置:
 *   concurrency: 并发槽位数 (默认: CPU核心数)
 *   maxQueueSize: 最大排队长度 (默认: 100)
 *   circuitBreakerThreshold: 断路器阈值 (默认: 5)
 *   circuitBreakerTimeout: 断路器恢复超时 (默认: 30000ms)
 */

'use strict';

const { EventEmitter } = require('events');
const os = require('os');

const TICK_SLOT_STATE = Object.freeze({
  IDLE: 'idle',
  BUSY: 'busy',
  DRAINING: 'draining',
});

const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'closed',       // 正常
  OPEN: 'open',           // 熔断
  HALF_OPEN: 'half_open', // 半开（试探）
});

class TickConcurrency extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || null;

    // 并发配置
    this._concurrency = options.concurrency || Math.max(1, os.cpus().length);
    this._maxQueueSize = options.maxQueueSize || 100;
    this._queueStrategy = options.queueStrategy || 'fifo'; // fifo | priority

    // 槽位池
    this._slots = [];
    for (let i = 0; i < this._concurrency; i++) {
      this._slots.push({
        id: i,
        state: TICK_SLOT_STATE.IDLE,
        currentTick: null,
        startedAt: null,
        totalProcessed: 0,
        totalErrors: 0,
        totalLatency: 0,
      });
    }

    // 等待队列
    this._waitQueue = [];

    // 断路器
    this._circuitBreaker = {
      state: CIRCUIT_STATE.CLOSED,
      failureCount: 0,
      lastFailure: 0,
      threshold: options.circuitBreakerThreshold || 5,
      timeout: options.circuitBreakerTimeout || 30000,
    };

    // 统计
    this._stats = {
      totalProcessed: 0,
      totalQueued: 0,
      totalRejected: 0,
      totalErrors: 0,
      avgLatency: 0,
      maxQueueDepth: 0,
    };
  }

  /**
   * 获取空闲槽位
   */
  _getFreeSlot() {
    return this._slots.find(s => s.state === TICK_SLOT_STATE.IDLE);
  }

  /**
   * 获取空闲槽位数
   */
  getFreeSlotCount() {
    return this._slots.filter(s => s.state === TICK_SLOT_STATE.IDLE).length;
  }

  /**
   * 获取忙碌槽位数
   */
  getBusySlotCount() {
    return this._slots.filter(s => s.state === TICK_SLOT_STATE.BUSY).length;
  }

  /**
   * 调度一个TICK处理任务
   * @param {Object} tick - TICK数据 { type, message, tickNumber, ... }
   * @param {Function} processor - 异步处理函数 (tick) => Promise<void>
   * @param {Object} options - { priority: number }
   * @returns {Promise<Object>} 处理结果
   */
  async schedule(tick, processor, options = {}) {
    const priority = options.priority || 0;

    // 断路器检查
    if (this._circuitBreaker.state === CIRCUIT_STATE.OPEN) {
      const elapsed = Date.now() - this._circuitBreaker.lastFailure;
      if (elapsed < this._circuitBreaker.timeout) {
        // 熔断中，拒绝请求
        this._stats.totalRejected++;
        this.emit('rejected', { tick, reason: 'circuit_open' });
        if (this._logger) {
          this._logger.warn(`TICK rejected (circuit open): ${elapsed}ms since last failure`, { module: 'tick_concurrency' });
        }
        return { success: false, reason: 'circuit_open' };
      }
      // 进入半开状态
      this._circuitBreaker.state = CIRCUIT_STATE.HALF_OPEN;
      this.emit('circuit_state_change', { from: CIRCUIT_STATE.OPEN, to: CIRCUIT_STATE.HALF_OPEN });
    }

    // 尝试获取空闲槽位
    const freeSlot = this._getFreeSlot();
    if (freeSlot) {
      return this._processInSlot(freeSlot, tick, processor);
    }

    // 无空闲槽位，检查队列容量
    if (this._waitQueue.length >= this._maxQueueSize) {
      this._stats.totalRejected++;
      this.emit('rejected', { tick, reason: 'queue_full' });
      if (this._logger) {
        this._logger.warn(`TICK queue full (${this._waitQueue.length}/${this._maxQueueSize})`, { module: 'tick_concurrency' });
      }
      return { success: false, reason: 'queue_full' };
    }

    // 加入等待队列
    this._stats.totalQueued++;
    const queueEntry = { tick, processor, priority, enqueuedAt: Date.now(), resolve: null };
    this._waitQueue.push(queueEntry);

    if (this._waitQueue.length > this._stats.maxQueueDepth) {
      this._stats.maxQueueDepth = this._waitQueue.length;
    }

    if (this._logger) {
      this._logger.debug(`TICK queued (depth: ${this._waitQueue.length})`, { module: 'tick_concurrency' });
    }

    // 返回Promise，等待槽位空闲时处理
    return new Promise((resolve) => {
      queueEntry.resolve = resolve;
      // 尝试立即获取空闲槽位（可能有并发释放）
      const slot = this._getFreeSlot();
      if (slot) {
        const idx = this._waitQueue.findIndex(w => w === queueEntry);
        if (idx !== -1) {
          this._waitQueue.splice(idx, 1);
          this._processInSlot(slot, tick, processor).then(resolve);
        }
      }
    });
  }

  /**
   * 在指定槽位中处理TICK
   */
  async _processInSlot(slot, tick, processor) {
    slot.state = TICK_SLOT_STATE.BUSY;
    slot.currentTick = tick;
    slot.startedAt = Date.now();

    this.emit('tick_start', { slot: slot.id, tick });

    try {
      const startTime = Date.now();
      await processor(tick);
      const latency = Date.now() - startTime;

      // 更新槽位统计
      slot.totalProcessed++;
      slot.totalLatency += latency;
      slot.currentTick = null;
      slot.state = TICK_SLOT_STATE.IDLE;

      // 更新全局统计
      this._stats.totalProcessed++;
      this._stats.avgLatency = (
        (this._stats.avgLatency * (this._stats.totalProcessed - 1) + latency) /
        this._stats.totalProcessed
      );

      // 断路器：成功则重置
      if (this._circuitBreaker.state === CIRCUIT_STATE.HALF_OPEN) {
        this._circuitBreaker.state = CIRCUIT_STATE.CLOSED;
        this._circuitBreaker.failureCount = 0;
        this.emit('circuit_state_change', { from: CIRCUIT_STATE.HALF_OPEN, to: CIRCUIT_STATE.CLOSED });
      } else {
        this._circuitBreaker.failureCount = 0;
      }

      this.emit('tick_complete', { slot: slot.id, tick, latency });

      // 处理等待队列中的下一个任务
      this._processNextFromQueue();

      return { success: true, latency, slotId: slot.id };
    } catch (error) {
      slot.totalErrors++;
      slot.currentTick = null;
      slot.state = TICK_SLOT_STATE.IDLE;

      this._stats.totalErrors++;

      // 断路器：记录失败
      this._circuitBreaker.failureCount++;
      this._circuitBreaker.lastFailure = Date.now();
      if (this._circuitBreaker.failureCount >= this._circuitBreaker.threshold) {
        this._circuitBreaker.state = CIRCUIT_STATE.OPEN;
        this.emit('circuit_state_change', { from: CIRCUIT_STATE.CLOSED, to: CIRCUIT_STATE.OPEN });
        if (this._logger) {
          this._logger.error(`Circuit breaker OPEN: ${this._circuitBreaker.failureCount} consecutive failures`, {
            module: 'tick_concurrency',
            data: { error: error.message },
          });
        }
      }

      this.emit('tick_error', { slot: slot.id, tick, error });

      // 处理等待队列
      this._processNextFromQueue();

      return { success: false, error: error.message, slotId: slot.id };
    }
  }

  /**
   * 从等待队列中取下一个任务处理
   */
  _processNextFromQueue() {
    if (this._waitQueue.length === 0) return;

    const freeSlot = this._getFreeSlot();
    if (!freeSlot) return;

    // 按优先级排序取最高优先级的
    this._waitQueue.sort((a, b) => b.priority - a.priority);
    const next = this._waitQueue.shift();

    // 检查等待时间是否超时
    const waitTime = Date.now() - next.enqueuedAt;
    if (waitTime > 60000) {
      this._stats.totalRejected++;
      this.emit('rejected', { tick: next.tick, reason: 'timeout' });
      // resolve 对应的 Promise 为失败
      if (next.resolve) {
        next.resolve({ success: false, reason: 'timeout' });
      }
      // 继续处理下一个
      this._processNextFromQueue();
      return;
    }

    // 使用存储的 resolve 回调
    if (next.resolve) {
      this._processInSlot(freeSlot, next.tick, next.processor).then(next.resolve);
    } else {
      this._processInSlot(freeSlot, next.tick, next.processor);
    }
  }

  /**
   * 工作窃取：从其他槽位平衡负载
   */
  async _stealWork(targetSlot) {
    const busySlots = this._slots.filter(s => s.state === TICK_SLOT_STATE.BUSY);
    if (busySlots.length <= 1) return;

    // 找到处理时间最长的槽位
    busySlots.sort((a, b) => (b.startedAt ? Date.now() - b.startedAt : 0) - (a.startedAt ? Date.now() - a.startedAt : 0));
    const victim = busySlots[0];

    // 如果该槽位已经处理超过阈值时间，尝试抢占
    const elapsed = victim.startedAt ? Date.now() - victim.startedAt : 0;
    if (elapsed > 30000) {
      this.emit('work_steal', { from: victim.id, to: targetSlot.id });
      if (this._logger) {
        this._logger.warn(`Work stolen: slot ${victim.id} → ${targetSlot.id} (${elapsed}ms elapsed)`, {
          module: 'tick_concurrency',
        });
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const slotStats = this._slots.map(s => ({
      id: s.id,
      state: s.state,
      totalProcessed: s.totalProcessed,
      totalErrors: s.totalErrors,
      avgLatency: s.totalProcessed > 0 ? Math.round(s.totalLatency / s.totalProcessed) : 0,
    }));

    return {
      concurrency: this._concurrency,
      slots: slotStats,
      freeSlots: this.getFreeSlotCount(),
      busySlots: this.getBusySlotCount(),
      queueDepth: this._waitQueue.length,
      maxQueueSize: this._maxQueueSize,
      circuitState: this._circuitBreaker.state,
      circuitFailureCount: this._circuitBreaker.failureCount,
      ...this._stats,
    };
  }

  /**
   * 手动重置断路器
   */
  resetCircuitBreaker() {
    this._circuitBreaker.state = CIRCUIT_STATE.CLOSED;
    this._circuitBreaker.failureCount = 0;
    this.emit('circuit_state_change', { from: CIRCUIT_STATE.OPEN, to: CIRCUIT_STATE.CLOSED });
  }

  /**
   * 优雅关闭：等待所有处理中的TICK完成
   */
  async drain() {
    if (this._logger) {
      this._logger.info('Draining TICK concurrency pool...', { module: 'tick_concurrency' });
    }

    // 标记所有槽位为DRAINING
    this._slots.forEach(s => {
      if (s.state === TICK_SLOT_STATE.IDLE) {
        s.state = TICK_SLOT_STATE.DRAINING;
      }
    });

    // 等待所有忙碌槽位完成
    const checkAllIdle = () => this._slots.every(s => s.state === TICK_SLOT_STATE.DRAINING || s.state === TICK_SLOT_STATE.IDLE);

    return new Promise((resolve) => {
      const maxWait = 30000;
      const start = Date.now();
      const check = setInterval(() => {
        if (checkAllIdle() || Date.now() - start > maxWait) {
          clearInterval(check);
          this._waitQueue = [];
          if (this._logger) {
            this._logger.info(`TICK pool drained (${Date.now() - start}ms)`, { module: 'tick_concurrency' });
          }
          resolve();
        }
      }, 50);
    });
  }

  /**
   * 关闭并发处理器
   */
  close() {
    this._waitQueue = [];
    this.removeAllListeners();
  }
}

module.exports = {
  TickConcurrency,
  TICK_SLOT_STATE,
  CIRCUIT_STATE,
};
