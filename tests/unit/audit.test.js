/**
 * Unit Tests: AuditLogger
 * Phase 16: 测试体系 - 审计日志
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { AuditLogger, AUDIT_LEVEL, AUDIT_CATEGORY } = require('../../src/enterprise/audit-logger');

describe('AuditLogger', () => {
  let logger;
  const testDir = path.join(require('os').tmpdir(), 'tricore_test_audit_' + Date.now());

  beforeEach(() => {
    logger = new AuditLogger({
      logDir: testDir,
      bufferSize: 10,
      flushInterval: 100,
    });
  });

  afterEach(() => {
    if (logger) logger.close();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  describe('初始化', () => {
    it('应正确创建审计日志器', () => {
      assert.ok(logger instanceof AuditLogger);
      assert.ok(fs.existsSync(testDir));
    });

    it('应有默认的缓冲区大小', () => {
      assert.equal(logger._bufferSize, 10);
    });
  });

  describe('核心日志', () => {
    it('应记录审计事件并返回事件ID', () => {
      const id = logger.log(AUDIT_CATEGORY.AUTH, 'user_login', {
        userId: 'user1',
        ip: '192.168.1.1',
      });
      assert.ok(id);
      assert.ok(id.startsWith('audit_'));
    });

    it('应正确存储事件到缓冲区', () => {
      logger.log(AUDIT_CATEGORY.ACCESS, 'file_read', { userId: 'user1' });
      assert.equal(logger._logBuffer.length, 1);
    });

    it('缓冲区满时应自动刷新', () => {
      for (let i = 0; i < 15; i++) {
        logger.log(AUDIT_CATEGORY.SYSTEM, 'test_event', { userId: `user${i}` });
      }
      // 缓冲区应在满后刷新
      assert.ok(logger._logBuffer.length < 15);
    });
  });

  describe('日志级别', () => {
    it('info级别应正确记录', () => {
      logger.info(AUDIT_CATEGORY.SYSTEM, 'system_start');
      const entry = logger._logBuffer[0];
      assert.equal(entry.level, AUDIT_LEVEL.INFO);
    });

    it('warn级别应正确记录', () => {
      logger.warn(AUDIT_CATEGORY.SECURITY, 'failed_login');
      const entry = logger._logBuffer[0];
      assert.equal(entry.level, AUDIT_LEVEL.WARN);
    });

    it('error级别应正确记录', () => {
      logger.error(AUDIT_CATEGORY.SYSTEM, 'crash');
      const entry = logger._logBuffer[0];
      assert.equal(entry.level, AUDIT_LEVEL.ERROR);
    });

    it('critical级别应正确记录', () => {
      logger.critical(AUDIT_CATEGORY.SECURITY, 'breach');
      const entry = logger._logBuffer[0];
      assert.equal(entry.level, AUDIT_LEVEL.CRITICAL);
    });

    it('compliance级别应正确记录', () => {
      logger.compliance(AUDIT_CATEGORY.COMPLIANCE, 'audit_check');
      const entry = logger._logBuffer[0];
      assert.equal(entry.level, AUDIT_LEVEL.COMPLIANCE);
    });
  });

  describe('变更追踪', () => {
    it('应追踪配置变更', () => {
      logger.trackConfigChange('maxTokens', '1000', '2000', 'admin');
      const entry = logger._logBuffer[0];
      assert.equal(entry.category, AUDIT_CATEGORY.CONFIG);
      assert.equal(entry.userId, 'admin');
    });

    it('应追踪权限变更', () => {
      logger.trackPermissionChange('user1', 'user2', 'role_added', 'admin');
      const entry = logger._logBuffer[0];
      assert.equal(entry.category, AUDIT_CATEGORY.ACCESS);
    });
  });

  describe('数据脱敏', () => {
    it('应脱敏API Key', () => {
      const data = 'api_key=sk-1234567890abcdef1234567890abcdef';
      const redacted = logger._redactSensitiveData(data);
      assert.ok(redacted.includes('***API_KEY***'));
      assert.ok(!redacted.includes('sk-1234567890'));
    });

    it('应脱敏密码', () => {
      const data = 'password=mypassword123';
      const redacted = logger._redactSensitiveData(data);
      assert.ok(redacted.includes('***PASSWORD***'));
    });

    it('应脱敏邮箱', () => {
      const data = 'contact: user@example.com';
      const redacted = logger._redactSensitiveData(data);
      assert.ok(redacted.includes('***EMAIL***'));
    });

    it('应脱敏手机号', () => {
      const data = 'phone: 13812345678';
      const redacted = logger._redactSensitiveData(data);
      assert.ok(redacted.includes('***PHONE***'));
    });
  });

  describe('查询', () => {
    it('应按用户ID过滤', async () => {
      logger.log(AUDIT_CATEGORY.AUTH, 'login', { userId: 'user_a' });
      logger.log(AUDIT_CATEGORY.AUTH, 'login', { userId: 'user_b' });

      const results = await logger.query({ userId: 'user_a' });
      assert.ok(results.every(r => r.userId === 'user_a'));
    });

    it('应按时间范围过滤', async () => {
      const now = Date.now();
      logger.log(AUDIT_CATEGORY.SYSTEM, 'old_event');
      // 模拟旧事件
      logger._logBuffer[0].timestamp = now - 100000;

      logger.log(AUDIT_CATEGORY.SYSTEM, 'new_event');

      const results = await logger.query({ since: now - 1000 });
      assert.ok(results.length >= 1);
    });

    it('应按级别过滤', async () => {
      logger.info(AUDIT_CATEGORY.SYSTEM, 'info_event');
      logger.critical(AUDIT_CATEGORY.SECURITY, 'critical_event');

      const results = await logger.query({ level: AUDIT_LEVEL.CRITICAL });
      assert.ok(results.every(r => r.level === AUDIT_LEVEL.CRITICAL));
    });
  });

  describe('异常检测', () => {
    it('多次失败登录应触发异常', (t, done) => {
      logger.once('anomaly_detected', (anomaly) => {
        assert.equal(anomaly.type, 'brute_force');
        done();
      });

      for (let i = 0; i < 10; i++) {
        logger.log(AUDIT_CATEGORY.AUTH, 'login_failed', {
          userId: 'attacker',
          result: 'failure',
        });
      }
    });
  });

  describe('统计', () => {
    it('应返回正确的统计', () => {
      logger.log(AUDIT_CATEGORY.AUTH, 'event1');
      logger.log(AUDIT_CATEGORY.ACCESS, 'event2');
      logger.error(AUDIT_CATEGORY.SECURITY, 'event3');

      const stats = logger.getStats();
      assert.equal(stats.totalEvents, 3);
      assert.ok(stats.eventsByLevel);
      assert.ok(stats.eventsByCategory);
    });
  });

  describe('关闭', () => {
    it('关闭时应刷新缓冲区', () => {
      logger.log(AUDIT_CATEGORY.SYSTEM, 'pending_event');
      assert.ok(logger._logBuffer.length > 0);

      logger.close();
      assert.equal(logger._logBuffer.length, 0);
    });
  });
});
