/**
 * TriCore Agent - 企业审计日志 (Enterprise Audit Logger)
 *
 * Phase 14: 企业级特性 - 增强审计与合规
 *
 * 核心能力:
 *   1. 结构化审计日志 - JSON格式，可搜索可导出
 *   2. 多级审计 - INFO/WARN/ERROR/CRITICAL/COMPLIANCE
 *   3. 数据脱敏 - 自动识别并脱敏敏感数据
 *   4. 日志轮转 - 按大小/时间自动归档
 *   5. 合规报告 - 自动生成合规审计报告
 *   6. 变更追踪 - 配置/权限/数据变更全记录
 *   7. 异常检测 - 异常行为自动告警
 *   8. 导出格式 - JSON/CSV/Syslog多格式导出
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ── 审计级别 ──
const AUDIT_LEVEL = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  CRITICAL: 'critical',
  COMPLIANCE: 'compliance',
});

// ── 审计类别 ──
const AUDIT_CATEGORY = Object.freeze({
  AUTH: 'auth',               // 认证相关
  ACCESS: 'access',           // 访问控制
  DATA: 'data',               // 数据操作
  CONFIG: 'config',           // 配置变更
  SYSTEM: 'system',           // 系统操作
  SECURITY: 'security',       // 安全事件
  COMPLIANCE: 'compliance',   // 合规事件
  API: 'api',                 // API调用
  AGENT: 'agent',             // Agent操作
});

// ── 敏感数据模式 ──
const SENSITIVE_PATTERNS = [
  { name: 'api_key', pattern: /(?:api[_-]?key|apikey|secret)[=:]\s*['"]?([\w-]{20,})['"]?/gi, mask: '***API_KEY***' },
  { name: 'password', pattern: /(?:password|passwd|pwd)[=:]\s*['"]?([^\s'"]+)['"]?/gi, mask: '***PASSWORD***' },
  { name: 'token', pattern: /(?:token|jwt)[=:]\s*['"]?([\w.-]{20,})['"]?/gi, mask: '***TOKEN***' },
  { name: 'email', pattern: /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, mask: '***EMAIL***' },
  { name: 'phone', pattern: /(1[3-9]\d{9})/g, mask: '***PHONE***' },
  { name: 'id_card', pattern: /(\d{17}[\dXx])/g, mask: '***ID_CARD***' },
  { name: 'ip_private', pattern: /(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}/g, mask: '***PRIVATE_IP***' },
  { name: 'credit_card', pattern: /(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})/g, mask: '***CREDIT_CARD***' },
];

class AuditLogger extends EventEmitter {
  constructor(options = {}) {
    super();

    this._db = options.db || null;
    this._memory = options.memory || null;

    // 日志存储
    this._logDir = options.logDir || path.join(process.cwd(), 'data', 'audit');
    this._logBuffer = [];
    this._bufferSize = options.bufferSize ?? 100;
    this._flushInterval = options.flushInterval ?? 5000;

    // 轮转配置
    this._maxLogSize = options.maxLogSize ?? 10 * 1024 * 1024; // 10MB
    this._maxLogAge = options.maxLogAge ?? 30 * 24 * 3600 * 1000; // 30天
    this._rotationCheckInterval = options.rotationCheckInterval ?? 3600000; // 1小时

    // 告警阈值
    this._alertThresholds = {
      failedLogins: options.failedLoginThreshold ?? 5,       // 5分钟内
      criticalEvents: options.criticalEventThreshold ?? 3,    // 1小时内
      apiRateLimit: options.apiRateLimitThreshold ?? 100,     // 每分钟
    };

    // 异常检测
    this._anomalyWindow = options.anomalyWindow ?? 300000; // 5分钟
    this._eventCounters = new Map(); // category → { count, windowStart }

    // 统计
    this._stats = {
      totalEvents: 0,
      eventsByLevel: {},
      eventsByCategory: {},
      sensitiveDataRedacted: 0,
    };

    // 初始化
    this._ensureLogDir();
    this._initTables();

    // 定时刷新
    this._flushTimer = setInterval(() => this._flush(), this._flushInterval);
    this._rotationTimer = setInterval(() => this._checkRotation(), this._rotationCheckInterval);

    // 进程退出时刷盘
    process.on('beforeExit', () => this._flush());
    process.on('SIGINT', () => { this._flush(); this.close(); });
  }

  // ═══════════════════════════════════════
  // 核心日志接口
  // ═══════════════════════════════════════

  /**
   * 记录审计事件
   * @param {string} category - 审计类别
   * @param {string} action - 操作描述
   * @param {Object} context - { userId?, ip?, resource?, details?, level? }
   */
  log(category, action, context = {}) {
    const level = context.level || this._inferLevel(category, action);

    const entry = {
      id: this._generateEventId(),
      timestamp: Date.now(),
      level,
      category,
      action,
      userId: context.userId || 'system',
      username: context.username || '',
      ip: context.ip || '',
      resource: context.resource || '',
      resourceId: context.resourceId || '',
      details: this._redactSensitiveData(context.details || {}),
      result: context.result || 'success',
      sessionId: context.sessionId || '',
      traceId: context.traceId || '',
      metadata: context.metadata || {},
    };

    // 更新统计
    this._updateStats(entry);

    // 异常检测
    this._detectAnomaly(entry);

    // 加入缓冲区
    this._logBuffer.push(entry);

    // 触发事件
    this.emit('audit_event', entry);
    if (level === AUDIT_LEVEL.CRITICAL || level === AUDIT_LEVEL.COMPLIANCE) {
      this.emit('critical_audit', entry);
    }

    // 缓冲区满则刷新
    if (this._logBuffer.length >= this._bufferSize) {
      this._flush();
    }

    return entry.id;
  }

  /**
   * 便捷方法
   */
  info(category, action, context = {}) {
    return this.log(category, action, { ...context, level: AUDIT_LEVEL.INFO });
  }

  warn(category, action, context = {}) {
    return this.log(category, action, { ...context, level: AUDIT_LEVEL.WARN });
  }

  error(category, action, context = {}) {
    return this.log(category, action, { ...context, level: AUDIT_LEVEL.ERROR });
  }

  critical(category, action, context = {}) {
    return this.log(category, action, { ...context, level: AUDIT_LEVEL.CRITICAL });
  }

  compliance(category, action, context = {}) {
    return this.log(category, action, { ...context, level: AUDIT_LEVEL.COMPLIANCE });
  }

  // ═══════════════════════════════════════
  // 变更追踪
  // ═══════════════════════════════════════

  /**
   * 记录配置变更
   */
  trackConfigChange(key, oldValue, newValue, userId = 'system') {
    const oldRedacted = this._redactSensitiveData({ value: oldValue }).value;
    const newRedacted = this._redactSensitiveData({ value: newValue }).value;

    return this.log(AUDIT_CATEGORY.CONFIG, `Config changed: ${key}`, {
      userId,
      resource: 'config',
      resourceId: key,
      details: {
        key,
        oldValue: oldRedacted,
        newValue: newRedacted,
      },
    });
  }

  /**
   * 记录权限变更
   */
  trackPermissionChange(userId, targetUserId, change, adminId) {
    return this.log(AUDIT_CATEGORY.ACCESS, `Permission change: ${change}`, {
      userId: adminId,
      resource: 'permission',
      resourceId: targetUserId,
      details: { targetUser: targetUserId, change },
    });
  }

  /**
   * 记录数据变更
   */
  trackDataChange(resource, resourceId, operation, before, after, userId) {
    return this.log(AUDIT_CATEGORY.DATA, `Data ${operation}: ${resource}#${resourceId}`, {
      userId,
      resource,
      resourceId,
      details: {
        operation,
        before: this._redactSensitiveData(before || {}),
        after: this._redactSensitiveData(after || {}),
      },
    });
  }

  // ═══════════════════════════════════════
  // 合规报告
  // ═══════════════════════════════════════

  /**
   * 生成合规审计报告
   * @param {Object} options - { startDate, endDate, categories?, format? }
   */
  async generateComplianceReport(options = {}) {
    const startDate = options.startDate || (Date.now() - 7 * 86400000);
    const endDate = options.endDate || Date.now();
    const categories = options.categories || Object.values(AUDIT_CATEGORY);

    const events = await this.query({
      since: startDate,
      until: endDate,
      categories,
      limit: 100000,
    });

    const report = {
      generatedAt: Date.now(),
      period: { start: startDate, end: endDate },
      summary: {
        totalEvents: events.length,
        byLevel: {},
        byCategory: {},
        byUser: {},
        criticalEvents: [],
        securityEvents: [],
      },
      details: events,
    };

    // 聚合统计
    for (const event of events) {
      report.summary.byLevel[event.level] = (report.summary.byLevel[event.level] || 0) + 1;
      report.summary.byCategory[event.category] = (report.summary.byCategory[event.category] || 0) + 1;
      report.summary.byUser[event.userId] = (report.summary.byUser[event.userId] || 0) + 1;

      if (event.level === AUDIT_LEVEL.CRITICAL) {
        report.summary.criticalEvents.push(event);
      }
      if (event.category === AUDIT_CATEGORY.SECURITY) {
        report.summary.securityEvents.push(event);
      }
    }

    return report;
  }

  /**
   * 导出日志
   * @param {string} format - json | csv | syslog
   */
  async exportLogs(options = {}, format = 'json') {
    const events = await this.query(options);

    switch (format) {
      case 'csv':
        return this._exportCSV(events);
      case 'syslog':
        return this._exportSyslog(events);
      case 'json':
      default:
        return JSON.stringify(events, null, 2);
    }
  }

  _exportCSV(events) {
    if (events.length === 0) return '';
    const headers = ['id', 'timestamp', 'level', 'category', 'action', 'userId', 'ip', 'resource', 'result'];
    const lines = [headers.join(',')];
    for (const e of events) {
      lines.push(headers.map(h => {
        const val = String(e[h] || '');
        return val.includes(',') ? `"${val}"` : val;
      }).join(','));
    }
    return lines.join('\n');
  }

  _exportSyslog(events) {
    return events.map(e => {
      const date = new Date(e.timestamp).toISOString();
      return `<${this._syslogSeverity(e.level)}>1 ${date} ${e.ip || '-'} TriCoreAgent - - - [${e.category}] ${e.action} user=${e.userId} result=${e.result}`;
    }).join('\n');
  }

  _syslogSeverity(level) {
    const map = {
      [AUDIT_LEVEL.INFO]: 6,
      [AUDIT_LEVEL.WARN]: 4,
      [AUDIT_LEVEL.ERROR]: 3,
      [AUDIT_LEVEL.CRITICAL]: 2,
      [AUDIT_LEVEL.COMPLIANCE]: 5,
    };
    return map[level] || 6;
  }

  // ═══════════════════════════════════════
  // 查询
  // ═══════════════════════════════════════

  /**
   * 查询审计日志
   */
  async query(options = {}) {
    let results = [];

    // 从内存缓冲区查询
    results.push(...this._logBuffer);

    // 从数据库查询
    if (this._db) {
      try {
        const dbResults = this._queryFromDB(options);
        results.push(...dbResults);
      } catch { /* DB查询失败 */ }
    }

    // 从文件查询
    const fileResults = await this._queryFromFiles(options);
    results.push(...fileResults);

    // 过滤
    if (options.userId) results = results.filter(e => e.userId === options.userId);
    if (options.level) results = results.filter(e => e.level === options.level);
    if (options.category) results = results.filter(e => e.category === options.category);
    if (options.categories) results = results.filter(e => options.categories.includes(e.category));
    if (options.since) results = results.filter(e => e.timestamp >= options.since);
    if (options.until) results = results.filter(e => e.timestamp <= options.until);
    if (options.action) results = results.filter(e => e.action.includes(options.action));

    // 排序
    results.sort((a, b) => b.timestamp - a.timestamp);

    return results.slice(0, options.limit || 1000);
  }

  _queryFromDB(options) {
    let sql = 'SELECT * FROM audit_events WHERE 1=1';
    const params = [];

    if (options.since) { sql += ' AND timestamp >= ?'; params.push(options.since); }
    if (options.until) { sql += ' AND timestamp <= ?'; params.push(options.until); }
    if (options.userId) { sql += ' AND user_id = ?'; params.push(options.userId); }
    if (options.level) { sql += ' AND level = ?'; params.push(options.level); }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(options.limit || 1000);

    return this._db.prepare(sql).all(...params).map(r => ({
      ...r,
      details: r.details ? JSON.parse(r.details) : {},
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
    }));
  }

  async _queryFromFiles(options) {
    // 从日志文件读取（支持 JSON 数组和 NDJSON 两种格式）
    const results = [];
    try {
      const files = fs.readdirSync(this._logDir)
        .filter(f => f.startsWith('audit_') && (f.endsWith('.json') || f.endsWith('.log')))
        .sort();

      for (const file of files) {
        const fileDate = file.replace('audit_', '').replace('.json', '').replace('.log', '');
        if (options.since) {
          const sinceDate = new Date(options.since).toISOString().split('T')[0];
          if (fileDate < sinceDate) continue;
        }
        if (options.until) {
          const untilDate = new Date(options.until).toISOString().split('T')[0];
          if (fileDate > untilDate) continue;
        }

        const filePath = path.join(this._logDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (!content.trim()) continue;

          // 尝试作为 JSON 数组解析
          try {
            const entries = JSON.parse(content);
            if (Array.isArray(entries)) {
              results.push(...entries);
              continue;
            }
          } catch {
            // 不是数组，尝试 NDJSON 逐行解析
          }

          // NDJSON 格式：每行一个 JSON 对象
          const lines = content.trim().split('\n');
          for (const line of lines) {
            try {
              const entry = JSON.parse(line.trim());
              if (entry && entry.timestamp) {
                results.push(entry);
              }
            } catch {
              // 跳过无效行
            }
          }
        } catch (e) {
          if (this._logger) {
            this._logger.warn(`Failed to read audit file: ${file}`, { module: 'audit', error: e.message });
          }
        }
      }
    } catch (e) {
      if (this._logger) {
        this._logger.warn('Failed to query audit files', { module: 'audit', error: e.message });
      }
    }
    return results;
  }

  // ═══════════════════════════════════════
  // 数据脱敏
  // ═══════════════════════════════════════

  _redactSensitiveData(data) {
    if (typeof data === 'string') {
      let redacted = data;
      for (const { pattern, mask } of SENSITIVE_PATTERNS) {
        const matches = redacted.match(pattern);
        if (matches) {
          this._stats.sensitiveDataRedacted += matches.length;
          redacted = redacted.replace(pattern, mask);
        }
      }
      return redacted;
    }

    if (typeof data === 'object' && data !== null) {
      const redacted = {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
          redacted[key] = this._redactSensitiveData(value);
        } else if (typeof value === 'object' && value !== null) {
          redacted[key] = this._redactSensitiveData(value);
        } else {
          redacted[key] = value;
        }
      }
      return redacted;
    }

    return data;
  }

  // ═══════════════════════════════════════
  // 异常检测
  // ═══════════════════════════════════════

  _detectAnomaly(entry) {
    const key = `${entry.category}:${entry.level}`;
    const now = Date.now();
    const counter = this._eventCounters.get(key) || { count: 0, windowStart: now };

    if (now - counter.windowStart > this._anomalyWindow) {
      counter.count = 0;
      counter.windowStart = now;
    }

    counter.count++;
    this._eventCounters.set(key, counter);

    // 检测异常
    if (entry.category === AUDIT_CATEGORY.AUTH && entry.result === 'failure') {
      if (counter.count >= this._alertThresholds.failedLogins) {
        this.emit('anomaly_detected', {
          type: 'brute_force',
          message: `检测到暴力破解: ${counter.count}次失败登录`,
          details: entry,
        });
      }
    }

    if (entry.level === AUDIT_LEVEL.CRITICAL && counter.count >= this._alertThresholds.criticalEvents) {
      this.emit('anomaly_detected', {
        type: 'critical_surge',
        message: `严重事件激增: ${counter.count}个事件`,
        details: entry,
      });
    }
  }

  // ═══════════════════════════════════════
  // 日志轮转
  // ═══════════════════════════════════════

  _checkRotation() {
    try {
      const files = fs.readdirSync(this._logDir)
        .filter(f => (f.startsWith('audit_') && (f.endsWith('.json') || f.endsWith('.log'))))
        .map(f => ({
          name: f,
          path: path.join(this._logDir, f),
          stat: fs.statSync(path.join(this._logDir, f)),
        }));

      for (const file of files) {
        // 按大小轮转
        if (file.stat.size > this._maxLogSize) {
          this._rotateFile(file.path);
        }
        // 按时间清理
        if (Date.now() - file.stat.mtimeMs > this._maxLogAge) {
          fs.unlinkSync(file.path);
          this.emit('log_purged', { file: file.name });
        }
      }
    } catch (e) {
      // 轮转检查失败记录但不影响主流程
      console.warn(`[Audit] Rotation check failed: ${e.message}`);
    }
  }

  _rotateFile(filePath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const newPath = filePath.replace('.json', `_${timestamp}.json.gz`);
    try {
      // 简单轮转：压缩并重命名
      const zlib = require('zlib');
      const content = fs.readFileSync(filePath);
      const compressed = zlib.gzipSync(content);
      fs.writeFileSync(newPath, compressed);
      fs.writeFileSync(filePath, '[]'); // 清空原文件
      this.emit('log_rotated', { from: filePath, to: newPath });
    } catch {
      // 压缩失败，直接重命名
      fs.renameSync(filePath, newPath);
    }
  }

  // ═══════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════

  _flush() {
    if (this._logBuffer.length === 0) return;

    const batch = this._logBuffer.splice(0);
    this._writeToFile(batch);
    this._writeToDB(batch);
  }

  _writeToFile(batch) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const filePath = path.join(this._logDir, `audit_${today}.json`);

      // 使用追加模式写入，避免全量读取重写
      const isNewFile = !fs.existsSync(filePath) || fs.statSync(filePath).size === 0;

      if (isNewFile) {
        // 新文件：写入完整数组
        fs.writeFileSync(filePath, JSON.stringify(batch));
      } else {
        // 已有文件：追加新条目（读末尾、追加、写回）
        // 对于大量日志，使用NDJSON格式更高效
        const lines = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
        fs.appendFileSync(filePath, lines, 'utf-8');
      }
    } catch (e) {
      // 写入失败不影响主流程，但记录错误
      if (this._logger) {
        this._logger.error('Failed to write audit log to file', { module: 'audit', error: e.message });
      }
    }
  }

  _writeToDB(batch) {
    if (!this._db) return;
    try {
      const insert = this._db.prepare(`
        INSERT INTO audit_events (id, timestamp, level, category, action, user_id, username, ip, resource, resource_id, details, result, session_id, trace_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const txn = this._db.transaction(() => {
        for (const e of batch) {
          insert.run(
            e.id, e.timestamp, e.level, e.category, e.action,
            e.userId, e.username, e.ip, e.resource, e.resourceId,
            JSON.stringify(e.details), e.result, e.sessionId, e.traceId,
            JSON.stringify(e.metadata)
          );
        }
      });
      txn();
    } catch { /* DB写入失败 */ }
  }

  _ensureLogDir() {
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
  }

  _initTables() {
    if (!this._db) return;
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          level TEXT NOT NULL,
          category TEXT NOT NULL,
          action TEXT NOT NULL,
          user_id TEXT,
          username TEXT,
          ip TEXT,
          resource TEXT,
          resource_id TEXT,
          details TEXT,
          result TEXT DEFAULT 'success',
          session_id TEXT,
          trace_id TEXT,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_level ON audit_events(level);
        CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_events(category);
        CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id);
      `);
    } catch { /* tables may exist */ }
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _generateEventId() {
    return `audit_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  }

  _inferLevel(category, action) {
    if (action.includes('failed') || action.includes('error') || action.includes('denied')) {
      return AUDIT_LEVEL.WARN;
    }
    if (category === AUDIT_CATEGORY.SECURITY) {
      return AUDIT_LEVEL.WARN;
    }
    return AUDIT_LEVEL.INFO;
  }

  _updateStats(entry) {
    this._stats.totalEvents++;
    this._stats.eventsByLevel[entry.level] = (this._stats.eventsByLevel[entry.level] || 0) + 1;
    this._stats.eventsByCategory[entry.category] = (this._stats.eventsByCategory[entry.category] || 0) + 1;
  }

  close() {
    this._flush();
    if (this._flushTimer) clearInterval(this._flushTimer);
    if (this._rotationTimer) clearInterval(this._rotationTimer);
  }

  getStats() {
    return { ...this._stats, bufferSize: this._logBuffer.length };
  }
}

module.exports = {
  AuditLogger,
  AUDIT_LEVEL,
  AUDIT_CATEGORY,
};
