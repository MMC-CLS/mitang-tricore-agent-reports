/**
 * SecurityBoundary 单元测试
 * Phase 20: 安全边界测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SecurityBoundary, SECURITY_LEVEL, CORE_IDENTITY, CAPABILITY } = require('../../src/security/security-boundary');

test('SecurityBoundary - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const sb = new SecurityBoundary();
    assert.ok(sb);
  });

  await t.test('自定义限制', () => {
    const sb = new SecurityBoundary({
      maxConsciousnessTaskBudget: 5000,
      maxAutonomousSteps: 10,
      maxIdleThinkPerHour: 12,
    });
    assert.ok(sb);
  });
});

test('SecurityBoundary - 授权检查', async (t) => {
  const sb = new SecurityBoundary();

  await t.test('意识核请求执行', () => {
    const auth = sb.authorize(
      CORE_IDENTITY.CONSCIOUSNESS,
      CAPABILITY.REQUEST_EXECUTION,
      { target: CORE_IDENTITY.EXECUTION, params: { goal: 'test' } }
    );
    assert.ok(auth.allowed);
  });

  await t.test('执行核直接使用意识能力', () => {
    const auth = sb.authorize(
      CORE_IDENTITY.EXECUTION,
      CAPABILITY.THINK,
      { target: CORE_IDENTITY.CONSCIOUSNESS }
    );
    assert.strictEqual(auth.allowed, false);
    assert.ok(auth.reason);
  });

  await t.test('执行核执行任务', () => {
    const auth = sb.authorize(
      CORE_IDENTITY.EXECUTION,
      CAPABILITY.EXECUTE_TASK,
      { params: { taskId: 'task-1' } }
    );
    assert.ok(auth.allowed);
  });

  await t.test('进化核发布技能', () => {
    const auth = sb.authorize(
      CORE_IDENTITY.EVOLUTION,
      CAPABILITY.PUBLISH_SKILL,
      { params: { skillName: 'test-skill' } }
    );
    assert.ok(auth.allowed);
  });
});

test('SecurityBoundary - 铁律检查', async (t) => {
  const sb = new SecurityBoundary();

  await t.test('铁律1: 意识不碰手', () => {
    // 意识核尝试直接执行任务
    const auth = sb.authorize(
      CORE_IDENTITY.CONSCIOUSNESS,
      CAPABILITY.EXECUTE_TASK,
      { params: { action: 'delete_file' } }
    );
    assert.strictEqual(auth.allowed, false);
    assert.ok(auth.reason.includes('意识') || auth.reason.includes('consciousness'));
  });

  await t.test('铁律2: 执行不经脑', () => {
    // 执行核尝试修改意识参数
    const auth = sb.authorize(
      CORE_IDENTITY.EXECUTION,
      CAPABILITY.THINK,
      { params: { action: 'modify_persona' } }
    );
    assert.strictEqual(auth.allowed, false);
  });
});

test('SecurityBoundary - 安全模式', async (t) => {
  const sb = new SecurityBoundary();

  await t.test('开启安全模式', () => {
    sb.setSafeMode(true);
    const auth = sb.authorize(
      CORE_IDENTITY.EXECUTION,
      CAPABILITY.EXECUTE_TASK,
      { params: { action: 'delete_file' } }
    );
    // 安全模式下高风险操作可能需要确认
    assert.ok(auth);
  });

  await t.test('关闭安全模式', () => {
    sb.setSafeMode(false);
    const auth = sb.authorize(
      CORE_IDENTITY.EXECUTION,
      CAPABILITY.EXECUTE_TASK,
      { params: { action: 'delete_file' } }
    );
    assert.ok(auth);
  });
});

test('SecurityBoundary - 事件', async (t) => {
  const sb = new SecurityBoundary();

  await t.test('铁律违反事件', () => {
    return new Promise((resolve) => {
      sb.on('iron_law_violation', (violation) => {
        assert.ok(violation.law);
        assert.ok(violation.message);
        resolve();
      });
      // 直接调用铁律执行方法
      sb.enforceIronLaw1(CORE_IDENTITY.CONSCIOUSNESS, 'execute_task');
    });
  });

  await t.test('授权拒绝事件', () => {
    return new Promise((resolve) => {
      sb.on('authorization_denied', (data) => {
        assert.ok(data.reason);
        resolve();
      });
      // 意识核请求不允许的能力会触发拒绝
      sb.authorize(
        CORE_IDENTITY.CONSCIOUSNESS,
        CAPABILITY.SHELL_EXEC,
        { params: { action: 'rm -rf /' } }
      );
    });
  });
});

test('SecurityBoundary - 审计日志', async (t) => {
  const sb = new SecurityBoundary();

  await t.test('查询审计日志', () => {
    sb.authorize(CORE_IDENTITY.EXECUTION, CAPABILITY.EXECUTE_TASK, { params: { taskId: 't1' } });
    sb.authorize(CORE_IDENTITY.CONSCIOUSNESS, CAPABILITY.REQUEST_EXECUTION, { params: { goal: 'g1' } });
    const log = sb.queryAuditLog();
    assert.ok(Array.isArray(log));
    assert.ok(log.length >= 2);
  });

  await t.test('按来源过滤', () => {
    const log = sb.queryAuditLog({ coreName: CORE_IDENTITY.EXECUTION });
    assert.ok(log.every(e => e.coreName === CORE_IDENTITY.EXECUTION));
  });

  await t.test('按能力过滤', () => {
    const log = sb.queryAuditLog({ capability: CAPABILITY.EXECUTE_TASK });
    assert.ok(log.every(e => e.capability === CAPABILITY.EXECUTE_TASK));
  });
});

test('SecurityBoundary - 状态', async (t) => {
  const sb = new SecurityBoundary();

  await t.test('getStatus', () => {
    const status = sb.getStatus();
    assert.ok(status);
    assert.ok(status.hasOwnProperty('safeMode'));
    assert.ok(status.hasOwnProperty('auditLogSize'));
  });
});
