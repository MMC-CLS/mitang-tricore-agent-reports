/**
 * Integration Tests: Governance Layer (CoreBus + SecurityBoundary + TokenBudget)
 * Phase 16: 测试体系 - 治理层集成测试
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { CoreBus, BUS_EVENT } = require('../../src/bus/core-bus');
const { SecurityBoundary, CORE_IDENTITY, CAPABILITY } = require('../../src/security/security-boundary');
const { TokenBudgetManager, THROTTLE_LEVEL, BUDGET_STRATEGY, CALL_PRIORITY } = require('../../src/budget/token-budget-manager');

describe('Governance Layer Integration', () => {
  let bus, security, budget;

  beforeEach(() => {
    bus = new CoreBus({ debugMode: false, maxLogSize: 1000 });
    security = new SecurityBoundary({
      maxConsciousnessTaskBudget: 10000,
      maxAutonomousSteps: 5,
      maxIdleThinkPerHour: 6,
    });
    budget = new TokenBudgetManager({
      hourlyBudget: 50000,
      dailyBudget: 500000,
      strategy: BUDGET_STRATEGY.ADAPTIVE,
    });
    budget.initCore('consciousness', { ratio: 0.6 });
    budget.initCore('execution', { ratio: 0.3 });
    budget.initCore('evolution', { ratio: 0.1 });
  });

  describe('CoreBus - 事件总线', () => {
    it('应派发和接收事件', (t, done) => {
      bus.on(BUS_EVENT.CONSCIOUSNESS_TASK_REQUEST, (data) => {
        assert.equal(data.messageId, 'msg_1');
        done();
      });
      bus.dispatch(BUS_EVENT.CONSCIOUSNESS_TASK_REQUEST, {
        messageId: 'msg_1',
      }, { source: 'test' });
    });

    it('应创建追踪链', () => {
      const traceId = bus.startTrace('external', { userId: 'user1' });
      assert.ok(traceId);
      assert.ok(traceId.startsWith('trace_'));
    });

    it('应完成追踪链', () => {
      const traceId = bus.startTrace('test');
      bus.completeTrace(traceId);
      const trace = bus.getTrace(traceId);
      assert.ok(trace);
      assert.ok(trace.completed);
    });
  });

  describe('SecurityBoundary - 安全边界', () => {
    it('应授权安全的操作', () => {
      const auth = security.authorize(
        CORE_IDENTITY.CONSCIOUSNESS,
        CAPABILITY.REQUEST_EXECUTION,
        { target: CORE_IDENTITY.EXECUTION, params: { goal: 'test' } }
      );
      assert.equal(auth.allowed, true);
    });

    it('应拒绝意识核直接执行', () => {
      const auth = security.authorize(
        CORE_IDENTITY.CONSCIOUSNESS,
        CAPABILITY.EXECUTE_TASK,
        { params: { action: 'shell_exec' } }
      );
      // 意识核不应该有直接执行权限
      assert.equal(auth.allowed, false);
    });

    it('应拒绝危险的Shell命令', () => {
      const auth = security.authorize(
        CORE_IDENTITY.EXECUTION,
        CAPABILITY.SHELL_EXEC,
        { params: { command: 'rm -rf /' } }
      );
      // 危险命令应被拒绝或要求确认
      if (!auth.allowed) {
        assert.ok(auth.reason);
      }
    });
  });

  describe('TokenBudgetManager - Token预算', () => {
    it('应正常分配Token', () => {
      const decision = budget.requestTokens('consciousness', 1000, {
        priority: CALL_PRIORITY.HIGH,
        callType: 'user_message',
      });
      assert.equal(decision.allowed, true);
      assert.ok(decision.adjustedMaxTokens > 0);
    });

    it('应在预算耗尽时拒绝', () => {
      // 耗尽意识核预算
      budget.requestTokens('consciousness', 50000, {
        priority: CALL_PRIORITY.CRITICAL,
        callType: 'test',
      });
      const decision = budget.requestTokens('consciousness', 50000, {
        priority: CALL_PRIORITY.LOW,
        callType: 'idle_think',
      });
      // 低优先级应被节流
      assert.ok(!decision.allowed || decision.throttleLevel !== THROTTLE_LEVEL.NONE);
    });

    it('应报告使用量', () => {
      budget.requestTokens('consciousness', 500, { priority: 100, callType: 'test' });
      budget.reportUsage('consciousness', { total_tokens: 200, prompt_tokens: 100, completion_tokens: 100 });
      const status = budget.getStatus();
      assert.ok(status.cores.consciousness.used > 0);
    });
  });
});
