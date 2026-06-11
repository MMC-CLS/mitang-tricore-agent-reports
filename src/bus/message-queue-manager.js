/**
 * TriCore Agent - 消息队列管理器 (Message Queue Manager)
 *
 * Phase 23: 持久化、容量限制、死信队列、重试策略
 *
 * 核心能力:
 *   1. 容量限制 - 最大消息数控制，溢出策略（丢弃旧/拒绝新/死信）
 *   2. 持久化 - 消息队列持久化到磁盘，重启后恢复
 *   3. 死信队列 - 处理失败的消息自动进入DLQ，支持重放
 *   4. 重试策略 - 指数退避重试，最大重试次数限制
 *   5. 消息TTL - 超时消息自动过期
 *   6. 优先级队列 - 按优先级排序消费
 *   7. 统计监控 - 队列深度/吞吐/死信/延迟统计
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// ── 消息状态 ──
const MQ_MESSAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD: 'dead',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
});

// ── 溢出策略 ──
const OVERFLOW_STRATEGY = Object.freeze({
  REJECT_NEW: 'reject_new',       // 拒绝新消息
  DROP_OLDEST: 'drop_oldest',     // 丢弃最旧消息
  DROP_LOWEST_PRIORITY: 'drop_lowest_priority', // 丢弃最低优先级
  DEAD_LETTER: 'dead_letter',     // 将溢出消息送入死信
});

// ── 消息优先级 ──
const MQ_PRIORITY = Object.freeze({
  LOWEST: 0,
  LOW: 25,
  NORMAL: 50,
  HIGH: 75,
  HIGHEST: 100,
  CRITICAL: 100,
});

class MessageQueueManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || null;
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data');

    // ── 容量控制 ──
    this._maxSize = options.maxSize ?? 10000;
    this._overflowStrategy = options.overflowStrategy || OVERFLOW_STRATEGY.REJECT_NEW;

    // ── 持久化 ──
    this._persistEnabled = options.persistEnabled ?? true;
    this._persistPath = options.persistPath || path.join(this._dataDir, 'message_queue.json');
    this._persistInterval = options.persistInterval ?? 30000; // 30秒
    this._persistTimer = null;

    // ── 死信队列 ──
    this._deadLetterEnabled = options.deadLetterEnabled ?? true;
    this._deadLetterPath = options.deadLetterPath || path.join(this._dataDir, 'dead_letter_queue.json');
    this._maxDeadLetterSize = options.maxDeadLetterSize ?? 1000;

    // ── 重试策略 ──
    this._maxRetries = options.maxRetries ?? 3;
    this._retryDelay = options.retryDelay ?? 1000;       // 基础延迟(ms)
    this._retryBackoff = options.retryBackoff ?? 'exponential'; // linear|exponential|fibonacci
    this._maxRetryDelay = options.maxRetryDelay ?? 60000; // 最大延迟(ms)

    // ── TTL ──
    this._messageTTL = options.messageTTL ?? 3600000;    // 默认1小时

    // ── 内部状态 ──
    this._mainQueue = [];          // 主消息队列
    this._processingSet = new Set(); // 正在处理的消息ID
    this._deadLetterQueue = [];    // 死信队列
    this._messageRegistry = new Map(); // msgId → message (用于快速查找)
    this._closed = false;

    // ── 统计 ──
    this._stats = {
      enqueued: 0,
      dequeued: 0,
      completed: 0,
      failed: 0,
      deadLettered: 0,
      rejected: 0,
      expired: 0,
      retried: 0,
      persisted: 0,
      restored: 0,
      overflowDropped: 0,
    };

    // ── 初始化 ──
    if (this._persistEnabled) {
      this._ensureDataDir();
      this._restoreFromDisk();
      this._startPersistTimer();
    }
  }

  // ═══════════════════════════════════════
  // 入队操作
  // ═══════════════════════════════════════

  /**
   * 消息入队
   * @param {Object} message - { id, content, priority?, from?, channel?, ttl?, metadata? }
   * @returns {{ success: boolean, messageId?: string, reason?: string }}
   */
  enqueue(message) {
    if (this._closed) {
      return { success: false, reason: 'Queue is closed' };
    }

    const msgId = message.id || `mq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const priority = message.priority ?? MQ_PRIORITY.NORMAL;

    const entry = {
      id: msgId,
      content: message.content,
      from: message.from || 'unknown',
      channel: message.channel || 'api',
      priority,
      status: MQ_MESSAGE_STATUS.PENDING,
      retryCount: 0,
      maxRetries: message.maxRetries ?? this._maxRetries,
      ttl: message.ttl ?? this._messageTTL,
      enqueuedAt: Date.now(),
      expiresAt: Date.now() + (message.ttl ?? this._messageTTL),
      traceId: message.traceId || '',
      metadata: message.metadata || {},
      processingStartedAt: null,
      lastError: null,
      errorHistory: [],
    };

    // 检查容量
    if (this._mainQueue.length >= this._maxSize) {
      const overflowResult = this._handleOverflow(entry);
      if (!overflowResult.accepted) {
        this._stats.rejected++;
        return { success: false, reason: overflowResult.reason, messageId: msgId };
      }
    }

    // 入队并排序（优先级降序）
    this._mainQueue.push(entry);
    this._mainQueue.sort((a, b) => b.priority - a.priority);
    this._messageRegistry.set(msgId, entry);
    this._stats.enqueued++;

    this._log('debug', `消息入队: ${msgId} (优先级=${priority}, 队列深度=${this._mainQueue.length})`);

    this.emit('enqueued', { messageId: msgId, queueDepth: this._mainQueue.length });

    return { success: true, messageId: msgId };
  }

  /**
   * 批量入队
   */
  enqueueBatch(messages) {
    const results = [];
    for (const msg of messages) {
      results.push(this.enqueue(msg));
    }
    return results;
  }

  // ═══════════════════════════════════════
  // 出队操作
  // ═══════════════════════════════════════

  /**
   * 取出下一条待处理消息
   * @returns {Object|null} 消息对象或null
   */
  dequeue() {
    // 清理过期消息
    this._purgeExpired();

    // 跳过正在处理的消息
    let message = null;
    let index = -1;

    for (let i = 0; i < this._mainQueue.length; i++) {
      if (!this._processingSet.has(this._mainQueue[i].id)) {
        message = this._mainQueue[i];
        index = i;
        break;
      }
    }

    if (!message) return null;

    // 标记为处理中
    this._mainQueue.splice(index, 1);
    this._processingSet.add(message.id);
    message.status = MQ_MESSAGE_STATUS.PROCESSING;
    message.processingStartedAt = Date.now();
    this._stats.dequeued++;

    this._log('debug', `消息出队: ${message.id}`);

    this.emit('dequeued', { messageId: message.id, remainingQueue: this._mainQueue.length });

    return message;
  }

  /**
   * 查看下一条消息（不出队）
   */
  peek() {
    this._purgeExpired();
    for (const msg of this._mainQueue) {
      if (!this._processingSet.has(msg.id)) {
        return msg;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════
  // 消息生命周期管理
  // ═══════════════════════════════════════

  /**
   * 标记消息处理成功
   */
  complete(messageId) {
    const message = this._messageRegistry.get(messageId);
    if (!message) return false;

    message.status = MQ_MESSAGE_STATUS.COMPLETED;
    this._processingSet.delete(messageId);
    this._stats.completed++;

    this.emit('completed', { messageId });

    return true;
  }

  /**
   * 标记消息处理失败（自动重试或送入死信）
   */
  fail(messageId, error) {
    const message = this._messageRegistry.get(messageId);
    if (!message) return false;

    message.lastError = error?.message || String(error || 'Unknown error');
    message.errorHistory.push({
      timestamp: Date.now(),
      error: message.lastError,
      attempt: message.retryCount + 1,
    });

    // 判断是否需要重试
    if (message.retryCount < message.maxRetries) {
      // 重试：计算退避延迟后重新入队
      message.retryCount++;
      message.status = MQ_MESSAGE_STATUS.PENDING;
      this._processingSet.delete(messageId);

      const delay = this._computeRetryDelay(message.retryCount);
      message.metadata._retryAfter = Date.now() + delay;
      this._stats.retried++;

      this._log('warn', `消息重试: ${messageId} (第${message.retryCount}次, 延迟${delay}ms)`);

      // 延迟后重新入队
      setTimeout(() => {
        if (!this._closed) {
          message.metadata._retryAfter = 0;
          this._mainQueue.push(message);
          this._mainQueue.sort((a, b) => b.priority - a.priority);
          this.emit('retried', { messageId, retryCount: message.retryCount });
        }
      }, delay);

      return { status: 'retrying', retryCount: message.retryCount, delay };
    } else {
      // 重试耗尽：送入死信队列
      this._processingSet.delete(messageId);
      return this._moveToDeadLetter(message, error);
    }
  }

  /**
   * 拒绝消息（不重试，直接丢弃或送入死信）
   */
  reject(messageId, reason = 'Rejected') {
    const message = this._messageRegistry.get(messageId);
    if (!message) return false;

    message.status = MQ_MESSAGE_STATUS.REJECTED;
    this._processingSet.delete(messageId);
    this._stats.rejected++;

    if (this._deadLetterEnabled) {
      this._moveToDeadLetter(message, new Error(reason));
    }

    this.emit('rejected', { messageId, reason });

    return true;
  }

  // ═══════════════════════════════════════
  // 死信队列
  // ═══════════════════════════════════════

  /**
   * 将消息移入死信队列
   */
  _moveToDeadLetter(message, error) {
    if (!this._deadLetterEnabled) {
      message.status = MQ_MESSAGE_STATUS.FAILED;
      this._stats.failed++;
      return { status: 'failed' };
    }

    // 死信队列容量检查
    if (this._deadLetterQueue.length >= this._maxDeadLetterSize) {
      // 丢弃最旧的死信
      this._deadLetterQueue.shift();
    }

    message.status = MQ_MESSAGE_STATUS.DEAD;
    message.deadLetteredAt = Date.now();
    message.deadReason = error?.message || String(error || 'Max retries exceeded');

    this._deadLetterQueue.push(message);
    this._stats.deadLettered++;

    this._log('error', `消息进入死信: ${message.id} (原因: ${message.deadReason})`);

    this.emit('dead_lettered', {
      messageId: message.id,
      reason: message.deadReason,
      retryCount: message.retryCount,
      deadLetterDepth: this._deadLetterQueue.length,
    });

    return { status: 'dead_lettered', reason: message.deadReason };
  }

  /**
   * 从死信队列重放消息
   */
  replayDeadLetter(messageId) {
    const index = this._deadLetterQueue.findIndex(m => m.id === messageId);
    if (index === -1) return { success: false, reason: 'Message not found in DLQ' };

    const message = this._deadLetterQueue.splice(index, 1)[0];
    message.status = MQ_MESSAGE_STATUS.PENDING;
    message.retryCount = 0;
    message.deadLetteredAt = null;
    message.deadReason = null;
    message.errorHistory = [];

    // 检查主队列容量
    if (this._mainQueue.length >= this._maxSize) {
      // 容量满，重新放入死信
      this._deadLetterQueue.push(message);
      return { success: false, reason: 'Main queue is full' };
    }

    this._mainQueue.push(message);
    this._mainQueue.sort((a, b) => b.priority - a.priority);

    this._log('info', `死信重放: ${messageId}`);

    this.emit('dead_letter_replayed', { messageId });

    return { success: true, messageId };
  }

  /**
   * 重放所有死信
   */
  replayAllDeadLetters() {
    const results = [];
    const deadLetters = [...this._deadLetterQueue];

    for (const message of deadLetters) {
      results.push(this.replayDeadLetter(message.id));
    }

    return results;
  }

  /**
   * 清空死信队列
   */
  clearDeadLetters() {
    const count = this._deadLetterQueue.length;
    this._deadLetterQueue = [];
    this._log('info', `死信队列已清空: ${count} 条消息`);
    return count;
  }

  // ═══════════════════════════════════════
  // 容量与溢出
  // ═══════════════════════════════════════

  _handleOverflow(entry) {
    this._stats.overflowDropped++;

    switch (this._overflowStrategy) {
      case OVERFLOW_STRATEGY.REJECT_NEW:
        this._log('warn', `队列溢出: 拒绝新消息 ${entry.id} (深度=${this._mainQueue.length})`);
        return { accepted: false, reason: 'Queue is full' };

      case OVERFLOW_STRATEGY.DROP_OLDEST: {
        const dropped = this._mainQueue.shift();
        if (dropped) {
          this._messageRegistry.delete(dropped.id);
          this._log('warn', `队列溢出: 丢弃最旧消息 ${dropped.id}`);
        }
        return { accepted: true };
      }

      case OVERFLOW_STRATEGY.DROP_LOWEST_PRIORITY: {
        // 找到最低优先级的消息
        let lowestIdx = 0;
        let lowestPrio = Infinity;
        for (let i = 0; i < this._mainQueue.length; i++) {
          if (this._mainQueue[i].priority < lowestPrio) {
            lowestPrio = this._mainQueue[i].priority;
            lowestIdx = i;
          }
        }
        const dropped = this._mainQueue.splice(lowestIdx, 1)[0];
        this._messageRegistry.delete(dropped.id);
        this._log('warn', `队列溢出: 丢弃最低优先级消息 ${dropped.id} (优先级=${lowestPrio})`);
        return { accepted: true };
      }

      case OVERFLOW_STRATEGY.DEAD_LETTER: {
        if (this._deadLetterEnabled) {
          entry.status = MQ_MESSAGE_STATUS.DEAD;
          entry.deadLetteredAt = Date.now();
          entry.deadReason = 'Queue overflow';
          this._deadLetterQueue.push(entry);
          this._messageRegistry.set(entry.id, entry);
          this._stats.deadLettered++;
          this._log('warn', `队列溢出: 消息 ${entry.id} 直接送入死信`);
        }
        return { accepted: false, reason: 'Queue overflow, sent to DLQ' };
      }

      default:
        return { accepted: false, reason: 'Queue is full' };
    }
  }

  // ═══════════════════════════════════════
  // 消息过期
  // ═══════════════════════════════════════

  _purgeExpired() {
    const now = Date.now();
    let purged = 0;

    // 清理主队列过期消息
    for (let i = this._mainQueue.length - 1; i >= 0; i--) {
      if (this._mainQueue[i].expiresAt < now) {
        const expired = this._mainQueue.splice(i, 1)[0];
        expired.status = MQ_MESSAGE_STATUS.EXPIRED;
        this._stats.expired++;
        purged++;
      }
    }

    // 清理处理中过期消息
    for (const msgId of this._processingSet) {
      const message = this._messageRegistry.get(msgId);
      if (message && message.expiresAt < now) {
        message.status = MQ_MESSAGE_STATUS.EXPIRED;
        this._processingSet.delete(msgId);
        this._stats.expired++;
        purged++;
      }
    }

    if (purged > 0) {
      this._log('debug', `清理过期消息: ${purged} 条`);
    }
  }

  // ═══════════════════════════════════════
  // 重试延迟计算
  // ═══════════════════════════════════════

  _computeRetryDelay(retryCount) {
    let delay;
    switch (this._retryBackoff) {
      case 'linear':
        delay = this._retryDelay * retryCount;
        break;
      case 'fibonacci': {
        // 迭代法计算 Fibonacci，O(n) 复杂度，避免递归栈溢出
        delay = this._retryDelay * this._fibonacciIterative(retryCount + 1);
        break;
      }
      case 'exponential':
      default:
        delay = this._retryDelay * Math.pow(2, retryCount - 1);
        // 添加随机抖动(±25%)
        delay = delay + (Math.random() - 0.5) * delay * 0.5;
        break;
    }
    return Math.min(delay, this._maxRetryDelay);
  }

  /**
   * 迭代法计算第 n 个 Fibonacci 数
   * O(n) 时间复杂度，O(1) 空间复杂度，避免递归调用栈溢出
   */
  _fibonacciIterative(n) {
    if (n <= 1) return n;
    let a = 0, b = 1;
    for (let i = 2; i <= n; i++) {
      [a, b] = [b, a + b];
    }
    return b;
  }

  // ═══════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════

  _ensureDataDir() {
    const dir = path.dirname(this._persistPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _startPersistTimer() {
    if (this._persistTimer) return;
    this._persistTimer = setInterval(() => {
      this._persistToDisk();
    }, this._persistInterval);
    if (this._persistTimer.unref) {
      this._persistTimer.unref();
    }
  }

  /**
   * 持久化消息队列到磁盘
   */
  _persistToDisk() {
    try {
      const data = {
        timestamp: Date.now(),
        version: '1.0.0',
        mainQueue: this._mainQueue.map(m => this._serializeForPersist(m)),
        deadLetterQueue: this._deadLetterQueue.map(m => this._serializeForPersist(m)),
        stats: { ...this._stats },
      };

      // 原子写入：先写临时文件再重命名
      const tmpPath = this._persistPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._persistPath);

      this._stats.persisted++;
      this._log('trace', `消息队列已持久化 (${data.mainQueue.length} 主队列, ${data.deadLetterQueue.length} 死信)`);
    } catch (err) {
      this._log('warn', `消息队列持久化失败: ${err.message}`);
    }
  }

  /**
   * 从磁盘恢复消息队列
   */
  _restoreFromDisk() {
    if (!fs.existsSync(this._persistPath)) return;

    try {
      const raw = fs.readFileSync(this._persistPath, 'utf-8');
      const data = JSON.parse(raw);

      if (data.mainQueue && Array.isArray(data.mainQueue)) {
        for (const msg of data.mainQueue) {
          const restored = this._deserializeFromPersist(msg);
          if (restored) {
            // 检查是否过期
            if (restored.expiresAt < Date.now()) {
              restored.status = MQ_MESSAGE_STATUS.EXPIRED;
              this._stats.expired++;
            } else {
              restored.status = MQ_MESSAGE_STATUS.PENDING;
              this._mainQueue.push(restored);
              this._messageRegistry.set(restored.id, restored);
              this._stats.restored++;
            }
          }
        }
      }

      if (data.deadLetterQueue && Array.isArray(data.deadLetterQueue)) {
        for (const msg of data.deadLetterQueue) {
          const restored = this._deserializeFromPersist(msg);
          if (restored) {
            restored.status = MQ_MESSAGE_STATUS.DEAD;
            this._deadLetterQueue.push(restored);
            this._messageRegistry.set(restored.id, restored);
          }
        }
      }

      this._mainQueue.sort((a, b) => b.priority - a.priority);

      if (this._stats.restored > 0) {
        this._log('info', `消息队列已恢复: ${this._stats.restored} 条主队列消息, ${this._deadLetterQueue.length} 条死信`);
      }
    } catch (err) {
      this._log('warn', `消息队列恢复失败: ${err.message}`);
    }
  }

  _serializeForPersist(message) {
    return {
      id: message.id,
      content: message.content,
      from: message.from,
      channel: message.channel,
      priority: message.priority,
      status: message.status,
      retryCount: message.retryCount,
      maxRetries: message.maxRetries,
      ttl: message.ttl,
      enqueuedAt: message.enqueuedAt,
      expiresAt: message.expiresAt,
      traceId: message.traceId,
      metadata: message.metadata,
      deadLetteredAt: message.deadLetteredAt,
      deadReason: message.deadReason,
      errorHistory: message.errorHistory?.slice(-5), // 仅保留最近5条错误
    };
  }

  _deserializeFromPersist(data) {
    if (!data || !data.id) return null;
    return {
      id: data.id,
      content: data.content,
      from: data.from || 'unknown',
      channel: data.channel || 'api',
      priority: data.priority ?? MQ_PRIORITY.NORMAL,
      status: MQ_MESSAGE_STATUS.PENDING,
      retryCount: data.retryCount || 0,
      maxRetries: data.maxRetries ?? this._maxRetries,
      ttl: data.ttl ?? this._messageTTL,
      enqueuedAt: data.enqueuedAt || Date.now(),
      expiresAt: data.expiresAt || (Date.now() + this._messageTTL),
      traceId: data.traceId || '',
      metadata: data.metadata || {},
      processingStartedAt: null,
      lastError: null,
      errorHistory: data.errorHistory || [],
      deadLetteredAt: data.deadLetteredAt || null,
      deadReason: data.deadReason || null,
    };
  }

  // ═══════════════════════════════════════
  // 查询与统计
  // ═══════════════════════════════════════

  /**
   * 获取队列深度
   */
  getDepth() {
    return this._mainQueue.length;
  }

  /**
   * 获取处理中消息数量
   */
  getProcessingCount() {
    return this._processingSet.size;
  }

  /**
   * 获取死信队列深度
   */
  getDeadLetterDepth() {
    return this._deadLetterQueue.length;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this._stats,
      mainQueueDepth: this._mainQueue.length,
      processingCount: this._processingSet.size,
      deadLetterDepth: this._deadLetterQueue.length,
      maxSize: this._maxSize,
      usagePercent: this._maxSize > 0
        ? Math.round((this._mainQueue.length / this._maxSize) * 100)
        : 0,
      persistEnabled: this._persistEnabled,
      deadLetterEnabled: this._deadLetterEnabled,
      closed: this._closed,
    };
  }

  /**
   * 获取死信队列消息列表
   */
  getDeadLetters(limit = 50) {
    return this._deadLetterQueue.slice(0, limit).map(m => ({
      id: m.id,
      from: m.from,
      content: typeof m.content === 'string' ? m.content.substring(0, 100) : '[non-string]',
      deadReason: m.deadReason,
      retryCount: m.retryCount,
      deadLetteredAt: m.deadLetteredAt,
      errorHistory: m.errorHistory,
    }));
  }

  /**
   * 查找消息
   */
  findMessage(messageId) {
    return this._messageRegistry.get(messageId) || null;
  }

  // ═══════════════════════════════════════
  // 配置热更新
  // ═══════════════════════════════════════

  /**
   * 设置最大队列容量
   */
  setMaxSize(maxSize) {
    this._maxSize = Math.max(100, maxSize);
    this._log('info', `消息队列最大容量更新: ${this._maxSize}`);
  }

  /**
   * 设置最大重试次数
   */
  setMaxRetries(maxRetries) {
    this._maxRetries = Math.max(0, Math.min(10, maxRetries));
  }

  /**
   * 设置消息TTL
   */
  setMessageTTL(ttlMs) {
    this._messageTTL = Math.max(1000, ttlMs);
  }

  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  /**
   * 关闭消息队列（持久化并清理）
   */
  async close() {
    this._closed = true;

    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }

    // 最终持久化
    if (this._persistEnabled) {
      this._persistToDisk();
    }

    this._log('info', `消息队列已关闭 (主队列=${this._mainQueue.length}, 死信=${this._deadLetterQueue.length}, 处理中=${this._processingSet.size})`);

    this.emit('closed');
  }

  // ═══════════════════════════════════════
  // 内部日志
  // ═══════════════════════════════════════

  _log(level, message) {
    if (this._logger) {
      this._logger[level](`[MQ] ${message}`, { module: 'message_queue' });
    }
  }
}

module.exports = {
  MessageQueueManager,
  MQ_MESSAGE_STATUS,
  MQ_PRIORITY,
  OVERFLOW_STRATEGY,
};
