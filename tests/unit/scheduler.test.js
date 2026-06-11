/**
 * Unit Tests: UnifiedScheduler
 * Phase 16: 测试体系
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { UnifiedScheduler, PRIORITY, MODE, SCHEDULE_EVENTS } = require('../../src/scheduler/unified-scheduler');

describe('UnifiedScheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = new UnifiedScheduler({ awakeningTicks: 3 });
  });

  afterEach(() => {
    if (scheduler._running) scheduler.stop();
  });

  describe('初始化', () => {
    it('应正确创建调度器实例', () => {
      assert.ok(scheduler instanceof UnifiedScheduler);
      assert.equal(scheduler._running, false);
      assert.equal(scheduler._currentMode, MODE.IDLE);
      assert.equal(scheduler._tickCounter, 0);
    });

    it('应接受配置参数', () => {
      const s = new UnifiedScheduler({
        awakeningTicks: 5,
        maxConsciousnessTicksPerHour: 20,
        watchdogTimeout: 60000,
      });
      assert.equal(s._awakeningTicksRemaining, 5);
      assert.equal(s._maxConsciousnessTicksPerHour, 20);
      assert.equal(s._watchdogTimeout, 60000);
    });
  });

  describe('启动和停止', () => {
    it('启动后应处于CONSCIOUSNESS模式', () => {
      scheduler.start();
      assert.equal(scheduler._running, true);
      assert.equal(scheduler._currentMode, MODE.CONSCIOUSNESS);
    });

    it('重复启动不应改变状态', () => {
      scheduler.start();
      const mode = scheduler._currentMode;
      scheduler.start();
      assert.equal(scheduler._currentMode, mode);
    });

    it('停止后应清理timer', () => {
      scheduler.start();
      scheduler.stop();
      assert.equal(scheduler._running, false);
      assert.equal(scheduler._timer, null);
    });

    it('应触发MODE_CHANGE事件', (t, done) => {
      scheduler.on(SCHEDULE_EVENTS.MODE_CHANGE, ({ from, to }) => {
        assert.equal(from, MODE.IDLE);
        assert.equal(to, MODE.CONSCIOUSNESS);
        done();
      });
      scheduler.start();
    });
  });

  describe('任务提交', () => {
    it('应接受执行任务', () => {
      const taskId = scheduler.submitExecutionTask({
        id: 'test_1',
        steps: [{ action: 'read_file', params: { path: 'test.txt' } }],
        priority: PRIORITY.HIGH,
      });
      assert.ok(taskId);
      assert.equal(scheduler._executionQueue.length, 1);
    });

    it('应接受进化操作', () => {
      scheduler.submitEvolutionOp({
        id: 'evo_1',
        type: 'skill_learn',
        priority: PRIORITY.LOW,
        payload: { taskId: 't1' },
      });
      assert.equal(scheduler._evolutionQueue.length, 1);
    });

    it('应按优先级排序执行队列', () => {
      scheduler.submitExecutionTask({ id: 'low', steps: [], priority: PRIORITY.LOW });
      scheduler.submitExecutionTask({ id: 'high', steps: [], priority: PRIORITY.HIGH });
      assert.equal(scheduler._executionQueue[0].id, 'high');
    });
  });

  describe('模式决策', () => {
    it('有高优先级任务时应选择EXECUTION模式', () => {
      scheduler.submitExecutionTask({
        id: 'urgent',
        steps: [{ action: 'send_message', params: { content: 'hello' } }],
        priority: PRIORITY.IMMEDIATE,
      });
      const mode = scheduler._decideMode();
      assert.equal(mode, MODE.EXECUTION);
    });

    it('觉醒期应选择CONSCIOUSNESS模式', () => {
      scheduler._awakeningTicksRemaining = 5;
      const mode = scheduler._decideMode();
      assert.equal(mode, MODE.CONSCIOUSNESS);
    });
  });

  describe('TICK间隔计算', () => {
    it('觉醒期应返回10秒间隔', () => {
      scheduler._awakeningTicksRemaining = 5;
      const interval = scheduler._computeNextInterval();
      assert.equal(interval, 10000);
    });

    it('有活跃任务应返回30秒间隔', () => {
      scheduler._awakeningTicksRemaining = 0;
      scheduler._activeTask = { id: 't1', steps: [], currentStep: 0 };
      const interval = scheduler._computeNextInterval();
      assert.equal(interval, 30000);
    });
  });

  describe('状态查询', () => {
    it('应返回正确的状态快照', () => {
      const status = scheduler.getStatus();
      assert.equal(status.running, false);
      assert.equal(status.mode, MODE.IDLE);
      assert.equal(status.tickCounter, 0);
      assert.equal(status.executionQueueLength, 0);
    });
  });
});
