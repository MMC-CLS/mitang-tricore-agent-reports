/**
 * Logger 单元测试
 * Phase 20: 统一日志系统测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { Logger, LOG_LEVEL, getLogger, setLogger } = require('../../src/utils/logger');

// 临时目录
const testLogDir = path.join(__dirname, '..', '..', 'data', 'test_logs');

test('Logger - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const logger = new Logger({ logDir: testLogDir, enableFile: false });
    assert.ok(logger);
  });

  await t.test('自定义级别', () => {
    const logger = new Logger({ level: LOG_LEVEL.DEBUG, logDir: testLogDir, enableFile: false });
    assert.strictEqual(logger._level, LOG_LEVEL.DEBUG);
  });

  await t.test('禁用控制台输出', () => {
    const logger = new Logger({ enableConsole: false, logDir: testLogDir, enableFile: false });
    assert.strictEqual(logger._enableConsole, false);
  });

  await t.test('禁用JSON格式', () => {
    const logger = new Logger({ enableJSON: false, logDir: testLogDir, enableFile: false });
    assert.strictEqual(logger._enableJSON, false);
  });
});

test('Logger - 日志级别', async (t) => {
  const logger = new Logger({ level: LOG_LEVEL.TRACE, logDir: testLogDir, enableFile: false, enableConsole: false });

  await t.test('trace 级别', () => {
    logger.trace('trace message');
    const stats = logger.getStats();
    assert.ok(stats.total >= 1);
  });

  await t.test('debug 级别', () => {
    logger.debug('debug message', { module: 'test' });
    const stats = logger.getStats();
    assert.ok(stats.total >= 1);
  });

  await t.test('info 级别', () => {
    logger.info('info message');
    const stats = logger.getStats();
    assert.ok(stats.total >= 1);
  });

  await t.test('warn 级别', () => {
    logger.warn('warn message');
    const stats = logger.getStats();
    assert.ok(stats.warnings >= 1);
  });

  await t.test('error 级别', () => {
    // Add error event listener to prevent unhandled error
    logger.on('error', () => {});
    logger.error('error message', { error: new Error('test error') });
    const stats = logger.getStats();
    assert.ok(stats.errors >= 1);
  });

  await t.test('fatal 级别', () => {
    // Add error event listener to prevent unhandled error
    logger.on('error', () => {});
    logger.fatal('fatal message');
    const stats = logger.getStats();
    assert.ok(stats.errors >= 1);
  });

  await t.test('级别过滤', () => {
    const infoLogger = new Logger({ level: LOG_LEVEL.INFO, logDir: testLogDir, enableFile: false, enableConsole: false });
    infoLogger.debug('should be filtered');
    infoLogger.trace('should be filtered');
    infoLogger.info('should appear');
    const stats = infoLogger.getStats();
    assert.strictEqual(stats.total, 1);
  });
});

test('Logger - 结构化上下文', async (t) => {
  const logger = new Logger({ logDir: testLogDir, enableFile: false, enableConsole: false });

  await t.test('traceId 注入', () => {
    let captured = null;
    logger.on('log', (entry) => { captured = entry; });
    logger.info('test', { traceId: 'trace-123', spanId: 'span-456' });
    assert.strictEqual(captured.traceId, 'trace-123');
    assert.strictEqual(captured.spanId, 'span-456');
  });

  await t.test('userId 注入', () => {
    let captured = null;
    logger.on('log', (entry) => { captured = entry; });
    logger.info('user action', { userId: 'user-001' });
    assert.strictEqual(captured.userId, 'user-001');
  });

  await t.test('错误对象序列化', () => {
    let captured = null;
    // Add error event listener to prevent unhandled error
    logger.on('error', () => {});
    logger.on('log', (entry) => { captured = entry; });
    logger.error('error with context', { error: new Error('test error') });
    assert.ok(captured.error);
    assert.ok(captured.error.message.includes('test error'));
  });

  await t.test('大数据截断', () => {
    let captured = null;
    logger.on('log', (entry) => { captured = entry; });
    const largeData = { key: 'x'.repeat(5000) };
    logger.info('large data', { data: largeData });
    assert.ok(captured.data._truncated);
  });
});

test('Logger - 子日志器', async (t) => {
  const parent = new Logger({ logDir: testLogDir, enableFile: false, enableConsole: false });

  await t.test('创建子日志器', () => {
    const child = parent.child({ traceId: 'child-trace' });
    assert.ok(child);
  });

  await t.test('子日志器继承上下文', () => {
    let captured = null;
    parent.on('log', (entry) => { captured = entry; });
    const child = parent.child({ traceId: 'inherited-trace' });
    child.info('child message');
    assert.strictEqual(captured.traceId, 'inherited-trace');
  });

  await t.test('子日志器可覆盖上下文', () => {
    let captured = null;
    parent.on('log', (entry) => { captured = entry; });
    const child = parent.child({ traceId: 'base-trace' });
    child.info('override message', { traceId: 'override-trace' });
    assert.strictEqual(captured.traceId, 'override-trace');
  });
});

test('Logger - 事件', async (t) => {
  // Use a fresh logger to avoid listener contamination
  const eventLogger = new Logger({ logDir: testLogDir, enableFile: false, enableConsole: false });

  await t.test('log 事件', () => {
    return new Promise((resolve) => {
      eventLogger.once('log', (entry) => {
        assert.strictEqual(entry.message, 'event test');
        resolve();
      });
      eventLogger.info('event test');
    });
  });

  await t.test('error 事件', () => {
    return new Promise((resolve) => {
      eventLogger.once('error', (entry) => {
        assert.ok(entry.levelValue >= LOG_LEVEL.ERROR);
        resolve();
      });
      eventLogger.error('trigger error event');
    });
  });
});

test('Logger - 文件写入', async (t) => {
  const logDir = path.join(testLogDir, 'file_test');
  // Disable async write to ensure file is written synchronously
  const logger = new Logger({ logDir, enableConsole: false, enableJSON: false, asyncWrite: false });

  await t.test('写入文件', () => {
    logger.info('file log test', { module: 'test' });
    const today = new Date().toISOString().split('T')[0];
    const filePath = path.join(logDir, `tricore_${today}.log`);
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(content.includes('file log test'));
  });

  // 清理
  try { fs.rmSync(logDir, { recursive: true }); } catch {}
});

test('Logger - 全局实例', async (t) => {
  await t.test('getLogger 返回同一实例', () => {
    const logger1 = getLogger({ logDir: testLogDir, enableFile: false });
    const logger2 = getLogger();
    assert.strictEqual(logger1, logger2);
  });

  await t.test('setLogger 设置新实例', () => {
    const newLogger = new Logger({ name: 'new', logDir: testLogDir, enableFile: false });
    setLogger(newLogger);
    assert.strictEqual(getLogger(), newLogger);
  });
});

test('Logger - 统计', async (t) => {
  const logger = new Logger({ logDir: testLogDir, enableFile: false, enableConsole: false });

  await t.test('初始统计', () => {
    const stats = logger.getStats();
    assert.strictEqual(stats.total, 0);
    assert.strictEqual(stats.errors, 0);
  });

  await t.test('累积统计', () => {
    // Add error event listener to prevent unhandled error
    logger.on('error', () => {});
    logger.info('msg1');
    logger.info('msg2');
    logger.error('err1');
    logger.warn('warn1');
    const stats = logger.getStats();
    assert.strictEqual(stats.total, 4);
    assert.strictEqual(stats.errors, 1);
    assert.strictEqual(stats.warnings, 2);
  });
});

// 清理
test('Logger - 清理', async () => {
  try { fs.rmSync(testLogDir, { recursive: true }); } catch {}
});
