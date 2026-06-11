/**
 * TriCore Agent - 分布式锁管理器 (Phase 24)
 *
 * 解决问题: 单进程架构瓶颈，无法横向扩展
 *
 * 功能:
 *   1. 本地互斥锁 - 进程内并发控制
 *   2. 文件锁 - 跨进程协调 (flock-based)
 *   3. 分布式锁接口 - 为Redis/ZooKeeper预留
 *   4. 锁超时自动释放 - 防止死锁
 *   5. 可重入锁 - 同一所有者可重复获取
 *
 * 使用场景:
 *   - TICK处理互斥
 *   - 配置热更新
 *   - 记忆引擎写入
 *   - 技能市场并发控制
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOCK_TYPE = Object.freeze({
  LOCAL: 'local',       // 进程内互斥锁
  FILE: 'file',         // 文件锁（跨进程）
  REDIS: 'redis',       // Redis分布式锁（预留接口）
  ZK: 'zookeeper',      // ZooKeeper分布式锁（预留接口）
});

const LOCK_STATE = Object.freeze({
  FREE: 'free',
  LOCKED: 'locked',
  EXPIRED: 'expired',
});

class DistributedLockManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger = options.logger || null;
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this._lockDir = path.join(this._dataDir, 'locks');
    this._defaultTTL = options.defaultTTL || 30000; // 默认30秒
    this._cleanupInterval = options.cleanupInterval || 60000;

    // 本地锁存储
    this._localLocks = new Map();   // key → { owner, acquiredAt, ttl, reentryCount }
    this._fileHandles = new Map();  // key → fs file descriptor

    // 自动清理
    this._cleanupTimer = null;
    this._startCleanup();
  }

  /**
   * 获取锁
   * @param {string} key - 锁标识
   * @param {Object} options - { type, ttl, owner, blocking, timeout }
   * @returns {Promise<Object>} { success, lockId, ... }
   */
  async acquire(key, options = {}) {
    const type = options.type || LOCK_TYPE.LOCAL;
    const ttl = options.ttl || this._defaultTTL;
    const owner = options.owner || `pid_${process.pid}`;
    const blocking = options.blocking || false;
    const timeout = options.timeout || 0;

    const startTime = Date.now();
    let lastError = 'Lock busy';

    while (true) {
      let result;
      switch (type) {
        case LOCK_TYPE.LOCAL:
          result = this._acquireLocal(key, owner, ttl);
          break;
        case LOCK_TYPE.FILE:
          result = await this._acquireFile(key, owner, ttl);
          break;
        default:
          return { success: false, error: `Unsupported lock type: ${type}` };
      }

      if (result.success) return result;
      lastError = result.error || 'Lock busy';

      if (!blocking) {
        return { success: false, error: lastError, lockKey: key };
      }

      if (timeout > 0 && Date.now() - startTime > timeout) {
        return { success: false, error: 'Lock timeout', lockKey: key };
      }

      // 等待重试
      await this._sleep(Math.min(100, timeout || 100));
    }
  }

  /**
   * 释放锁
   * @param {string} key - 锁标识
   * @param {Object} options - { type, owner, lockId }
   */
  async release(key, options = {}) {
    const type = options.type || LOCK_TYPE.LOCAL;
    const owner = options.owner || `pid_${process.pid}`;

    switch (type) {
      case LOCK_TYPE.LOCAL:
        return this._releaseLocal(key, owner);
      case LOCK_TYPE.FILE:
        return await this._releaseFile(key, owner);
      default:
        return { success: false, error: `Unsupported lock type: ${type}` };
    }
  }

  /**
   * 续期锁
   */
  async renew(key, options = {}) {
    const type = options.type || LOCK_TYPE.LOCAL;
    const owner = options.owner || `pid_${process.pid}`;
    const ttl = options.ttl || this._defaultTTL;

    const lock = this._localLocks.get(key);
    if (!lock || lock.owner !== owner) {
      return { success: false, error: 'Lock not held' };
    }

    lock.ttl = ttl;
    lock.acquiredAt = Date.now();
    return { success: true, lockKey: key, ttl };
  }

  // ═══════════════════════════════════════
  // 本地锁实现
  // ═══════════════════════════════════════

  _acquireLocal(key, owner, ttl) {
    const existing = this._localLocks.get(key);

    if (existing) {
      // 检查是否过期
      if (Date.now() - existing.acquiredAt > existing.ttl) {
        this._localLocks.delete(key);
        this.emit('lock_expired', { key, owner: existing.owner });
      } else if (existing.owner === owner) {
        // 可重入锁
        existing.reentryCount++;
        existing.acquiredAt = Date.now();
        return {
          success: true,
          lockKey: key,
          owner,
          reentry: true,
          reentryCount: existing.reentryCount,
        };
      } else {
        return { success: false, error: 'Lock held by another owner', currentOwner: existing.owner };
      }
    }

    const lockId = `lock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._localLocks.set(key, {
      lockId,
      owner,
      acquiredAt: Date.now(),
      ttl,
      reentryCount: 1,
    });

    this.emit('lock_acquired', { key, owner, lockId });
    return { success: true, lockKey: key, owner, lockId };
  }

  _releaseLocal(key, owner) {
    const lock = this._localLocks.get(key);
    if (!lock) {
      return { success: false, error: 'Lock not found' };
    }

    if (lock.owner !== owner) {
      return { success: false, error: 'Lock not owned by requester' };
    }

    lock.reentryCount--;
    if (lock.reentryCount > 0) {
      return { success: true, lockKey: key, remainingReentry: lock.reentryCount };
    }

    this._localLocks.delete(key);
    this.emit('lock_released', { key, owner });
    return { success: true, lockKey: key };
  }

  // ═══════════════════════════════════════
  // 文件锁实现（跨进程）
  // ═══════════════════════════════════════

  async _acquireFile(key, owner, ttl) {
    // 确保锁目录存在
    if (!fs.existsSync(this._lockDir)) {
      fs.mkdirSync(this._lockDir, { recursive: true });
    }

    const lockFile = path.join(this._lockDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.lock`);

    try {
      // 尝试创建锁文件（原子操作）
      const fd = fs.openSync(lockFile, 'wx');
      const lockData = JSON.stringify({
        owner,
        pid: process.pid,
        acquiredAt: Date.now(),
        ttl,
      });
      fs.writeSync(fd, lockData);
      this._fileHandles.set(key, fd);

      return { success: true, lockKey: key, owner, type: 'file' };
    } catch (err) {
      if (err.code === 'EEXIST') {
        // 文件已存在，检查是否过期
        try {
          const data = fs.readFileSync(lockFile, 'utf-8');
          const lockInfo = JSON.parse(data);
          if (Date.now() - lockInfo.acquiredAt > lockInfo.ttl) {
            // 锁已过期，强制获取
            fs.unlinkSync(lockFile);
            return this._acquireFile(key, owner, ttl);
          }
        } catch {
          // 读取失败，文件可能已损坏
          try { fs.unlinkSync(lockFile); } catch {}
          return this._acquireFile(key, owner, ttl);
        }
        return { success: false, error: 'File lock busy' };
      }
      throw err;
    }
  }

  async _releaseFile(key, owner) {
    const lockFile = path.join(this._lockDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.lock`);

    try {
      const fd = this._fileHandles.get(key);
      if (fd) {
        fs.closeSync(fd);
        this._fileHandles.delete(key);
      }

      if (fs.existsSync(lockFile)) {
        const data = fs.readFileSync(lockFile, 'utf-8');
        const lockInfo = JSON.parse(data);
        if (lockInfo.owner === owner || lockInfo.pid === process.pid) {
          fs.unlinkSync(lockFile);
        }
      }

      return { success: true, lockKey: key };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ═══════════════════════════════════════
  // 清理
  // ═══════════════════════════════════════

  _startCleanup() {
    this._cleanupTimer = setInterval(() => {
      this._cleanupExpiredLocks();
    }, this._cleanupInterval);
  }

  _cleanupExpiredLocks() {
    const now = Date.now();
    let cleaned = 0;

    // 清理本地锁
    for (const [key, lock] of this._localLocks) {
      if (now - lock.acquiredAt > lock.ttl) {
        this._localLocks.delete(key);
        cleaned++;
      }
    }

    // 清理过期文件锁
    if (fs.existsSync(this._lockDir)) {
      const files = fs.readdirSync(this._lockDir);
      for (const file of files) {
        if (!file.endsWith('.lock')) continue;
        const lockFile = path.join(this._lockDir, file);
        try {
          const data = fs.readFileSync(lockFile, 'utf-8');
          const lockInfo = JSON.parse(data);
          if (now - lockInfo.acquiredAt > (lockInfo.ttl || this._defaultTTL)) {
            fs.unlinkSync(lockFile);
            cleaned++;
          }
        } catch {
          // 损坏的锁文件直接删除
          try { fs.unlinkSync(lockFile); cleaned++; } catch {}
        }
      }
    }

    if (cleaned > 0 && this._logger) {
      this._logger.debug(`Cleaned ${cleaned} expired locks`, { module: 'dist_lock' });
    }
  }

  // ═══════════════════════════════════════
  // 状态与工具
  // ═══════════════════════════════════════

  getStats() {
    const activeLocalLocks = [];
    for (const [key, lock] of this._localLocks) {
      activeLocalLocks.push({
        key,
        owner: lock.owner,
        acquiredAt: lock.acquiredAt,
        ttl: lock.ttl,
        age: Date.now() - lock.acquiredAt,
        reentryCount: lock.reentryCount,
      });
    }

    return {
      activeLocalLocks: activeLocalLocks.length,
      lockDetails: activeLocalLocks,
      fileLocks: this._fileHandles.size,
    };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  close() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    // 释放所有文件锁
    for (const [key, fd] of this._fileHandles) {
      try { fs.closeSync(fd); } catch {}
    }
    this._fileHandles.clear();
    this._localLocks.clear();
    this.removeAllListeners();
  }
}

module.exports = {
  DistributedLockManager,
  LOCK_TYPE,
  LOCK_STATE,
};
