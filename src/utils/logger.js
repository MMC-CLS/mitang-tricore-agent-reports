/**
 * TriCore Agent - 统一日志系统 (Unified Logger)
 *
 * Phase 18: 统一日志、结构化输出、多级别、多输出目标
 * Phase 23: 异步写入、缓冲区批处理、热更新日志级别、优雅关闭
 *
 * 核心能力:
 *   1. 多级别日志 - TRACE/DEBUG/INFO/WARN/ERROR/FATAL
 *   2. 多输出目标 - Console/File/DB/Memory
 *   3. 结构化输出 - JSON格式，带上下文追踪
 *   4. 请求追踪 - 关联ID全链路追踪
 *   5. 日志轮转 - 按大小自动归档
 *   6. 性能统计 - 延迟、吞吐量
 *   7. 异步写入 - 非阻塞IO，缓冲区批处理 (Phase 23)
 *   8. 热更新 - 运行时动态调整日志级别 (Phase 23)
 *   9. 优雅关闭 - flush缓冲区确保日志不丢失 (Phase 23)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// ── 日志级别 ──
const LOG_LEVEL = Object.freeze({
  TRACE: 0,
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50,
});

const LOG_LEVEL_NAMES = Object.freeze({
  0: 'TRACE',
  10: 'DEBUG',
  20: 'INFO',
  30: 'WARN',
  40: 'ERROR',
  50: 'FATAL',
});

// ── 级别名称→值 映射（用于热更新） ──
const LOG_LEVEL_MAP = Object.freeze({
  trace: LOG_LEVEL.TRACE,
  debug: LOG_LEVEL.DEBUG,
  info: LOG_LEVEL.INFO,
  warn: LOG_LEVEL.WARN,
  error: LOG_LEVEL.ERROR,
  fatal: LOG_LEVEL.FATAL,
});

class Logger extends EventEmitter {
  constructor(options = {}) {
    super();

    this._name = options.name || 'TriCore';
    this._level = options.level ?? LOG_LEVEL.INFO;
    this._logDir = options.logDir || path.join(process.cwd(), 'data', 'logs');
    this._maxFileSize = options.maxFileSize ?? 10 * 1024 * 1024; // 10MB
    this._maxFiles = options.maxFiles ?? 30;
    this._enableConsole = options.enableConsole !== false;
    this._enableFile = options.enableFile !== false;
    this._enableJSON = options.enableJSON !== false;
    this._contextFields = options.contextFields || ['traceId', 'spanId', 'userId', 'sessionId'];

    // ── Phase 23: 异步写入配置 ──
    this._asyncWrite = options.asyncWrite ?? true;
    this._bufferSize = options.bufferSize ?? 100;      // 缓冲区大小
    this._flushInterval = options.flushInterval ?? 5000; // 刷新间隔(ms)
    this._writeBuffer = [];                             // 写缓冲区
    this._flushTimer = null;                            // 定时刷新器
    this._flushing = false;                             // 是否正在刷新
    this._closed = false;                               // 是否已关闭

    // 统计
    this._stats = {
      total: 0,
      byLevel: {},
      errors: 0,
      warnings: 0,
      bufferFlushes: 0,
      bufferOverflows: 0,
      asyncWriteErrors: 0,
    };

    // 初始化
    if (this._enableFile) {
      this._ensureLogDir();
    }

    // 启动异步写入定时器
    if (this._asyncWrite && this._enableFile) {
      this._startFlushTimer();
    }
  }

  // ═══════════════════════════════════════
  // 核心日志接口
  // ═══════════════════════════════════════

  /**
   * v1.0安全修复: 日志注入防护 — 转义用户可控输入中的换行和控制字符
   * 防止攻击者通过CRLF注入伪造日志条目（如伪造WARN/ERROR级别混淆运维判断）
   * @param {string} input - 用户输入
   * @returns {string} 消毒后的输入
   */
  _sanitizeLogInput(input) {
    if (typeof input !== 'string') return input;
    return input
      .replace(/\r\n/g, '\\n')   // CRLF → literal \n
      .replace(/[\r\n]/g, '\\n')  // LF/CR → literal \n
      .replace(/\x00/g, '')       // 移除NULL字节
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // 移除其他控制字符
  }

  /**
   * 记录日志
   * @param {number} level - LOG_LEVEL常量
   * @param {string} message - 日志消息
   * @param {Object} context - { traceId?, spanId?, userId?, sessionId?, module?, error?, data? }
   */
  log(level, message, context = {}) {
    if (level < this._level) return;
    if (this._closed) return; // 关闭后不再接受日志

    // v1.0安全修复: 对用户可控的message进行注入防护
    message = this._sanitizeLogInput(message);

    const entry = this._buildEntry(level, message, context);

    // 更新统计
    this._updateStats(level);

    // 输出到控制台（始终同步，因为需要即时可见）
    if (this._enableConsole) {
      this._writeConsole(entry);
    }

    // 输出到文件（异步缓冲区模式）
    if (this._enableFile) {
      if (this._asyncWrite) {
        this._bufferWrite(entry);
      } else {
        this._writeFile(entry);
      }
    }

    // 触发事件
    this.emit('log', entry);

    if (level >= LOG_LEVEL.ERROR) {
      this.emit('error', entry);
    }
  }

  // ── 便捷方法 ──

  trace(message, context = {}) {
    return this.log(LOG_LEVEL.TRACE, message, context);
  }

  debug(message, context = {}) {
    return this.log(LOG_LEVEL.DEBUG, message, context);
  }

  info(message, context = {}) {
    return this.log(LOG_LEVEL.INFO, message, context);
  }

  warn(message, context = {}) {
    return this.log(LOG_LEVEL.WARN, message, context);
  }

  error(message, context = {}) {
    return this.log(LOG_LEVEL.ERROR, message, context);
  }

  fatal(message, context = {}) {
    return this.log(LOG_LEVEL.FATAL, message, context);
  }

  // ═══════════════════════════════════════
  // 构建日志条目
  // ═══════════════════════════════════════

  _buildEntry(level, message, context = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: LOG_LEVEL_NAMES[level],
      levelValue: level,
      message,
      module: context.module || this._name,
    };

    // 注入追踪字段（v1.0安全修复: 对用户可控字段进行注入防护）
    for (const field of this._contextFields) {
      if (context[field]) {
        entry[field] = this._sanitizeLogInput(String(context[field]));
      }
    }

    // 注入错误信息
    if (context.error) {
      entry.error = {
        message: context.error.message || String(context.error),
        stack: context.error.stack || '',
        code: context.error.code || '',
      };
    }

    // 注入附加数据（限制大小）
    if (context.data && typeof context.data === 'object') {
      try {
        const dataStr = JSON.stringify(context.data);
        if (dataStr.length <= 4096) {
          entry.data = context.data;
        } else {
          entry.data = { _truncated: true, _size: dataStr.length };
        }
      } catch {
        entry.data = { _error: 'Failed to serialize data' };
      }
    }

    return entry;
  }

  // ═══════════════════════════════════════
  // 输出目标
  // ═══════════════════════════════════════

  _writeConsole(entry) {
    const color = this._getConsoleColor(entry.levelValue);
    const reset = '\x1b[0m';

    if (this._enableJSON) {
      const json = JSON.stringify(entry);
      if (entry.levelValue >= LOG_LEVEL.ERROR) {
        console.error(`${color}${json}${reset}`);
      } else if (entry.levelValue >= LOG_LEVEL.WARN) {
        console.warn(`${color}${json}${reset}`);
      } else {
        console.log(`${color}${json}${reset}`);
      }
    } else {
      const prefix = `[${entry.timestamp}] [${entry.level}] [${entry.module}]`;
      const msg = `${prefix} ${entry.message}`;
      if (entry.levelValue >= LOG_LEVEL.ERROR) {
        console.error(`${color}${msg}${reset}`);
      } else if (entry.levelValue >= LOG_LEVEL.WARN) {
        console.warn(`${color}${msg}${reset}`);
      } else {
        console.log(`${color}${msg}${reset}`);
      }
    }
  }

  _writeFile(entry) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const filePath = path.join(this._logDir, `${this._name.toLowerCase()}_${today}.log`);

      const line = this._enableJSON
        ? JSON.stringify(entry) + '\n'
        : `[${entry.timestamp}] [${entry.level}] [${entry.module}] ${entry.message}\n`;

      fs.appendFileSync(filePath, line, 'utf-8');

      // 检查文件大小并轮转
      this._checkRotation(filePath);
    } catch {
      // 文件写入失败不影响主流程
    }
  }

  // ═══════════════════════════════════════
  // Phase 23: 异步缓冲区写入
  // ═══════════════════════════════════════

  /**
   * 将日志条目加入写缓冲区（非阻塞）
   */
  _bufferWrite(entry) {
    this._writeBuffer.push(entry);

    // 缓冲区满时立即刷新
    if (this._writeBuffer.length >= this._bufferSize) {
      // 不阻塞：使用 setImmediate 避免在调用栈中执行IO
      if (!this._flushing) {
        setImmediate(() => this._flushBuffer());
      }
    }
  }

  /**
   * 启动定时刷新
   */
  _startFlushTimer() {
    if (this._flushTimer) return;
    this._flushTimer = setInterval(() => {
      if (this._writeBuffer.length > 0) {
        this._flushBuffer();
      }
    }, this._flushInterval);
    // 允许定时器不阻止进程退出
    if (this._flushTimer.unref) {
      this._flushTimer.unref();
    }
  }

  /**
   * 刷新写缓冲区到磁盘
   */
  _flushBuffer() {
    if (this._writeBuffer.length === 0 || this._flushing) return;

    this._flushing = true;
    const batch = this._writeBuffer.splice(0, this._writeBuffer.length);
    this._stats.bufferFlushes++;

    try {
      // 按文件分组写入，减少IO次数
      const fileGroups = new Map();
      const today = new Date().toISOString().split('T')[0];
      const defaultPath = path.join(this._logDir, `${this._name.toLowerCase()}_${today}.log`);

      for (const entry of batch) {
        // 使用 entry 中可能存在的日期信息，否则默认今天
        const entryDate = entry.timestamp
          ? entry.timestamp.split('T')[0]
          : today;
        const filePath = path.join(this._logDir, `${this._name.toLowerCase()}_${entryDate}.log`);

        if (!fileGroups.has(filePath)) {
          fileGroups.set(filePath, []);
        }
        fileGroups.get(filePath).push(entry);
      }

      // 批量写入每个文件
      for (const [filePath, entries] of fileGroups) {
        const lines = entries.map(entry => {
          return this._enableJSON
            ? JSON.stringify(entry)
            : `[${entry.timestamp}] [${entry.level}] [${entry.module}] ${entry.message}`;
        }).join('\n') + '\n';

        fs.appendFileSync(filePath, lines, 'utf-8');

        // 检查轮转（使用实际写入的文件路径）
        this._checkRotation(filePath);
      }
    } catch (err) {
      this._stats.asyncWriteErrors++;
      // 异步写入失败：降级到控制台错误输出
      try {
        console.error(`[Logger] 异步写入失败: ${err.message}`);
      } catch {
        // 最后的兜底
      }
    } finally {
      this._flushing = false;
    }
  }

  /**
   * 强制刷新（用于优雅关闭）
   * @returns {Promise<void>}
   */
  async flush() {
    return new Promise((resolve) => {
      // 停止定时器
      if (this._flushTimer) {
        clearInterval(this._flushTimer);
        this._flushTimer = null;
      }

      // 刷新剩余缓冲
      const doFlush = () => {
        if (this._writeBuffer.length > 0) {
          this._flushBuffer();
        }
        if (this._flushing) {
          // 如果正在刷新，等待完成
          setImmediate(doFlush);
        } else {
          resolve();
        }
      };

      doFlush();
    });
  }

  // ═══════════════════════════════════════
  // Phase 23: 日志级别热更新
  // ═══════════════════════════════════════

  /**
   * 设置日志级别（支持数值和字符串）
   * @param {number|string} level - LOG_LEVEL 常量或 'trace'/'debug'/'info'/'warn'/'error'/'fatal'
   */
  setLevel(level) {
    if (typeof level === 'string') {
      const mapped = LOG_LEVEL_MAP[level.toLowerCase()];
      if (mapped !== undefined) {
        this._level = mapped;
        this.info(`日志级别热更新: ${level.toUpperCase()}`, { module: 'logger' });
      } else {
        this.warn(`无效日志级别 "${level}"，保持当前级别`, { module: 'logger' });
      }
    } else if (typeof level === 'number' && level >= 0 && level <= 50) {
      this._level = level;
      this.info(`日志级别热更新: ${LOG_LEVEL_NAMES[level]}`, { module: 'logger' });
    }
  }

  /**
   * 获取当前日志级别（字符串形式）
   */
  getLevel() {
    return LOG_LEVEL_NAMES[this._level] || 'UNKNOWN';
  }

  /**
   * 获取当前日志级别数值
   */
  getLevelValue() {
    return this._level;
  }

  /**
   * 临时提高日志级别（用于调试）
   * @param {string} tempLevel - 临时级别
   * @param {number} durationMs - 持续时间(ms)
   */
  setTempLevel(tempLevel, durationMs = 60000) {
    const previousLevel = this._level;
    this.setLevel(tempLevel);

    if (this._tempLevelTimer) {
      clearTimeout(this._tempLevelTimer);
    }

    this._tempLevelTimer = setTimeout(() => {
      this._level = previousLevel;
      this.info(`临时日志级别已恢复: ${LOG_LEVEL_NAMES[previousLevel]}`, { module: 'logger' });
      this._tempLevelTimer = null;
    }, durationMs);
  }

  // ═══════════════════════════════════════
  // 日志轮转
  // ═══════════════════════════════════════

  _checkRotation(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > this._maxFileSize) {
        this._rotateFile(filePath);
      }
    } catch {
      // 检查失败跳过
    }
  }

  _rotateFile(filePath) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const newPath = filePath.replace('.log', `_${timestamp}.log`);
      fs.renameSync(filePath, newPath);

      // 清理旧日志文件
      this._cleanupOldLogs();
    } catch {
      // 轮转失败跳过
    }
  }

  _cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this._logDir)
        .filter(f => f.startsWith(`${this._name.toLowerCase()}_`) && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this._logDir, f),
          mtime: fs.statSync(path.join(this._logDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // 删除超出保留数量的旧文件
      for (let i = this._maxFiles; i < files.length; i++) {
        try {
          fs.unlinkSync(files[i].path);
        } catch {
          // 删除失败跳过
        }
      }
    } catch {
      // 清理失败跳过
    }
  }

  // ═══════════════════════════════════════
  // 请求追踪
  // ═══════════════════════════════════════

  /**
   * 创建带追踪ID的子日志器
   */
  child(context = {}) {
    const childLogger = new Logger({
      name: this._name,
      level: this._level,
      enableConsole: false,
      enableFile: false,
    });

    // 代理到父日志器但注入上下文
    const originalBuild = childLogger._buildEntry.bind(childLogger);
    childLogger._buildEntry = (level, message, ctx = {}) => {
      return originalBuild(level, message, { ...context, ...ctx });
    };

    // 代理log方法
    childLogger.log = (level, message, ctx = {}) => {
      return this.log(level, message, { ...context, ...ctx });
    };

    return childLogger;
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _getConsoleColor(level) {
    if (level >= LOG_LEVEL.FATAL) return '\x1b[41m\x1b[37m'; // 红底白字
    if (level >= LOG_LEVEL.ERROR) return '\x1b[31m';          // 红色
    if (level >= LOG_LEVEL.WARN) return '\x1b[33m';           // 黄色
    if (level >= LOG_LEVEL.INFO) return '\x1b[36m';           // 青色
    if (level >= LOG_LEVEL.DEBUG) return '\x1b[90m';          // 灰色
    return '\x1b[37m';                                         // 白色
  }

  _updateStats(level) {
    this._stats.total++;
    const levelName = LOG_LEVEL_NAMES[level];
    this._stats.byLevel[levelName] = (this._stats.byLevel[levelName] || 0) + 1;
    if (level >= LOG_LEVEL.ERROR) this._stats.errors++;
    if (level >= LOG_LEVEL.WARN) this._stats.warnings++;
  }

  _ensureLogDir() {
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
  }

  /**
   * 获取统计（含Phase 23新增指标）
   */
  getStats() {
    return {
      ...this._stats,
      currentLevel: LOG_LEVEL_NAMES[this._level],
      currentLevelValue: this._level,
      asyncWriteEnabled: this._asyncWrite,
      bufferSize: this._writeBuffer.length,
      bufferMaxSize: this._bufferSize,
      flushInterval: this._flushInterval,
      closed: this._closed,
    };
  }

  /**
   * 刷新并关闭（优雅关闭）
   * Phase 23: 异步flush确保缓冲区日志不丢失
   */
  async close() {
    this._closed = true;

    // 停止定时刷新
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    // 清除临时级别定时器
    if (this._tempLevelTimer) {
      clearTimeout(this._tempLevelTimer);
      this._tempLevelTimer = null;
    }

    // 刷新缓冲区
    await this.flush();

    this.emit('close');
  }

  /**
   * 同步关闭（向后兼容）
   */
  closeSync() {
    this._closed = true;
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._tempLevelTimer) {
      clearTimeout(this._tempLevelTimer);
      this._tempLevelTimer = null;
    }
    this._flushBuffer(); // 同步刷新剩余缓冲
    this.emit('close');
  }
}

// ── 全局日志器实例 ──
let _globalLogger = null;

function getLogger(options = {}) {
  if (!_globalLogger) {
    _globalLogger = new Logger(options);
  }
  return _globalLogger;
}

function setLogger(logger) {
  _globalLogger = logger;
}

module.exports = {
  Logger,
  LOG_LEVEL,
  LOG_LEVEL_NAMES,
  LOG_LEVEL_MAP,
  getLogger,
  setLogger,
};
