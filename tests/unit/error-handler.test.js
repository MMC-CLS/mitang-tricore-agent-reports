/**
 * Unit Tests: ErrorHandler
 * Phase 16: 测试体系 - 统一错误处理
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ErrorHandler, TriCoreError, Errors, ERROR_TYPE, ERROR_SEVERITY, RETRY_STRATEGY } = require('../../src/utils/error-handler');

describe('TriCoreError', () => {
  it('应创建带类型和严重程度的错误', () => {
    const err = new TriCoreError('test error', {
      type: ERROR_TYPE.NETWORK,
      severity: ERROR_SEVERITY.HIGH,
    });
    assert.equal(err.name, ERROR_TYPE.NETWORK);
    assert.equal(err.severity, ERROR_SEVERITY.HIGH);
    assert.equal(err.message, 'test error');
  });

  it('应正确序列化为JSON', () => {
    const err = new TriCoreError('json test', { code: 'TEST_001' });
    const json = err.toJSON();
    assert.equal(json.name, ERROR_TYPE.SYSTEM);
    assert.equal(json.code, 'TEST_001');
    assert.ok(json.stack);
  });
});

describe('Errors工厂', () => {
  it('应创建系统错误', () => {
    const err = Errors.system('system crash');
    assert.equal(err.name, ERROR_TYPE.SYSTEM);
  });

  it('应创建网络错误（可重试）', () => {
    const err = Errors.network('timeout');
    assert.equal(err.name, ERROR_TYPE.NETWORK);
    assert.equal(err.retryable, true);
  });

  it('应创建安全错误（严重）', () => {
    const err = Errors.security('unauthorized');
    assert.equal(err.name, ERROR_TYPE.SECURITY);
    assert.equal(err.severity, ERROR_SEVERITY.CRITICAL);
  });

  it('应创建铁律违反错误（不可重试）', () => {
    const err = Errors.ironLaw('law 1 violated');
    assert.equal(err.name, ERROR_TYPE.IRON_LAW);
    assert.equal(err.retryable, false);
  });
});

describe('ErrorHandler', () => {
  let handler;

  beforeEach(() => {
    handler = new ErrorHandler();
  });

  describe('错误处理', () => {
    it('应处理并返回标准化错误', () => {
      const err = handler.handle(new Error('raw error'));
      assert.ok(err instanceof TriCoreError);
    });

    it('应正确归类系统错误', () => {
      const err = handler.handle({ code: 'ENOENT', message: 'not found' });
      assert.equal(err.name, ERROR_TYPE.NOT_FOUND);
    });

    it('应正确归类权限错误', () => {
      const err = handler.handle({ code: 'EACCES', message: 'permission denied' });
      assert.equal(err.name, ERROR_TYPE.AUTHORIZATION);
    });

    it('应正确归类超时错误', () => {
      const err = handler.handle({ code: 'ETIMEDOUT', message: 'timeout' });
      assert.equal(err.name, ERROR_TYPE.TIMEOUT);
    });
  });

  describe('安全执行', () => {
    it('成功时应返回result', async () => {
      const result = await handler.safeExecute(() => 'success');
      assert.equal(result.success, true);
      assert.equal(result.result, 'success');
    });

    it('失败时应返回error', async () => {
      const result = await handler.safeExecute(() => {
        throw new Error('fail');
      });
      assert.equal(result.success, false);
      assert.ok(result.error instanceof TriCoreError);
    });
  });

  describe('重试机制', () => {
    it('成功时应返回结果', async () => {
      let calls = 0;
      const result = await handler.retry(() => {
        calls++;
        if (calls < 2) throw new Error('temp fail');
        return 'eventual success';
      }, { maxRetries: 3, baseDelay: 10 });
      assert.equal(result.success, true);
      assert.equal(result.result, 'eventual success');
      assert.equal(calls, 2);
    });

    it('超过重试次数应失败', async () => {
      const result = await handler.retry(() => {
        throw new Error('persistent fail');
      }, { maxRetries: 2, baseDelay: 10 });
      assert.equal(result.success, false);
      assert.ok(result.error instanceof TriCoreError);
    });

    it('指数退避应增加延迟', () => {
      const d1 = handler._computeDelay(0, 100, 10000, RETRY_STRATEGY.EXPONENTIAL);
      const d2 = handler._computeDelay(2, 100, 10000, RETRY_STRATEGY.EXPONENTIAL);
      assert.ok(d2 > d1);
    });
  });

  describe('安全忽略', () => {
    it('成功时应返回值', async () => {
      const result = await handler.safeIgnore(() => 'value', 'default');
      assert.equal(result, 'value');
    });

    it('失败时应返回默认值', async () => {
      const result = await handler.safeIgnore(() => {
        throw new Error('fail');
      }, 'default');
      assert.equal(result, 'default');
    });
  });

  describe('统计', () => {
    it('应追踪错误统计', () => {
      handler.handle(new Error('error1'));
      handler.handle(new Error('error2'));
      const stats = handler.getErrorStats();
      assert.equal(stats.total, 2);
    });
  });
});
