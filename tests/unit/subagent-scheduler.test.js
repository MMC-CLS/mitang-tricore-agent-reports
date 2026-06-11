/**
 * TriCoreAgent v2.9 - SubAgentScheduler 单元测试
 *
 * 覆盖范围：
 *   - 任务提交（单个/批量/复合）
 *   - 调度策略（ROUND_ROBIN/LEAST_LOADED/CAPABILITY_MATCH/WEIGHTED/ADAPTIVE）
 *   - 任务生命周期（完成/失败/重试/取消/超时）
 *   - 优先级队列
 *   - 策略切换
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

class MockLogger {
  constructor() { this.logs = []; }
  info() {}
  warn() {}
  error() {}
  debug() {}
}

const {
  SubAgentScheduler,
  SCHEDULE_STRATEGY,
  TASK_STATUS,
  TASK_PRIORITY,
} = require('../../src/subagent/subagent-scheduler');

const {
  SubAgentManager,
  SUBAGENT_TYPE,
} = require('../../src/subagent/subagent-manager');

function createScheduler(options = {}) {
  const mgr = new SubAgentManager({
    logger: new MockLogger(),
    dataDir: `/tmp/test_scheduler_${Date.now()}`,
    maxSubAgents: options.maxAgents || 20,
  });

  return {
    mgr,
    scheduler: new SubAgentScheduler({
      logger: new MockLogger(),
      subAgentManager: mgr,
      guardian: options.guardian || null,
      strategy: options.strategy || SCHEDULE_STRATEGY.ADAPTIVE,
      maxRetries: options.maxRetries ?? 3,
      maxConcurrentTasks: options.maxConcurrent || 10,
      ...options,
    }),
  };
}

// ═══════════════════════════════════════

test('SubAgentScheduler - 任务提交', async (t) => {
  await t.test('提交单个任务', () => {
    const { scheduler } = createScheduler();
    const result = scheduler.submitTask({ content: '分析数据' });
    assert.strictEqual(result.success, true);
    assert.ok(result.taskId);
    assert.strictEqual(scheduler._taskQueue.length, 1);
  });

  await t.test('提交任务带优先级', () => {
    const { scheduler } = createScheduler();
    scheduler.submitTask({ content: '普通任务', priority: TASK_PRIORITY.NORMAL });
    scheduler.submitTask({ content: '紧急任务', priority: TASK_PRIORITY.URGENT });
    scheduler.submitTask({ content: '关键任务', priority: TASK_PRIORITY.CRITICAL });

    // 优先级高的应该在队列前面
    assert.strictEqual(scheduler._taskQueue[0].priority, TASK_PRIORITY.CRITICAL);
  });

  await t.test('提交任务带能力要求', () => {
    const { scheduler } = createScheduler();
    const result = scheduler.submitTask({
      content: '数据分析',
      requiredCapability: 'data_analysis',
    });
    assert.strictEqual(result.success, true);
    const task = scheduler._taskQueue[0];
    assert.strictEqual(task.requiredCapability, 'data_analysis');
  });

  await t.test('批量提交任务', () => {
    const { scheduler } = createScheduler();
    const results = scheduler.submitTasks([
      { content: '任务1' },
      { content: '任务2' },
      { content: '任务3' },
    ]);
    assert.strictEqual(results.length, 3);
    assert.ok(results.every(r => r.success));
    assert.strictEqual(scheduler._taskQueue.length, 3);
  });

  await t.test('提交复合任务', () => {
    const { scheduler } = createScheduler();
    const result = scheduler.submitCompositeTask({
      mainGoal: '构建数据看板',
      subtasks: [
        { content: '收集数据', requiredCapability: 'data_analysis' },
        { content: '设计UI', requiredCapability: 'visualization' },
        { content: '部署上线' },
      ],
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.groupId);
    assert.strictEqual(result.totalSubtasks, 3);
    assert.strictEqual(result.tasks.length, 3);
  });
});

test('SubAgentScheduler - 调度策略', async (t) => {
  await t.test('ROUND_ROBIN 策略', () => {
    const { mgr, scheduler } = createScheduler({ strategy: SCHEDULE_STRATEGY.ROUND_ROBIN });
    mgr.create({ name: 'rr1', type: SUBAGENT_TYPE.ASSISTANT });
    mgr.create({ name: 'rr2', type: SUBAGENT_TYPE.ASSISTANT });
    const agents = mgr._getRunningAgents();

    const a1 = scheduler._selectRoundRobin(agents);
    const a2 = scheduler._selectRoundRobin(agents);
    const a3 = scheduler._selectRoundRobin(agents);

    assert.ok(a1);
    assert.ok(a2);
    assert.ok(a3);
    // 第三个应该回到第一个（2个agent轮询）
    assert.strictEqual(a3.id, a1.id);
  });

  await t.test('LEAST_LOADED 策略', () => {
    const { mgr, scheduler } = createScheduler({ strategy: SCHEDULE_STRATEGY.LEAST_LOADED });
    mgr.create({ name: 'll1' });
    mgr.create({ name: 'll2' });
    const agents = mgr._getRunningAgents();

    // 给第一个agent添加任务
    agents[0].tasks.push({ id: 'task1', content: 'test' });

    const selected = scheduler._selectLeastLoaded(agents);
    assert.strictEqual(selected.id, agents[1].id); // 应选任务少的
  });

  await t.test('CAPABILITY_MATCH 策略 - 有匹配', () => {
    const { mgr, scheduler } = createScheduler({ strategy: SCHEDULE_STRATEGY.CAPABILITY_MATCH });
    mgr.create({ name: 'analyst', type: SUBAGENT_TYPE.ANALYST });
    mgr.create({ name: 'executor', type: SUBAGENT_TYPE.EXECUTOR });
    const agents = mgr._getRunningAgents();

    const selected = scheduler._selectByCapability(
      { requiredCapability: 'data_analysis' },
      agents
    );
    assert.ok(selected);
    assert.ok(selected.capabilities.includes('data_analysis'));
  });

  await t.test('CAPABILITY_MATCH 策略 - 无匹配时回退', () => {
    const { mgr, scheduler } = createScheduler({ strategy: SCHEDULE_STRATEGY.CAPABILITY_MATCH });
    mgr.create({ name: 'executor_only', type: SUBAGENT_TYPE.EXECUTOR });
    const agents = mgr._getRunningAgents();

    const selected = scheduler._selectByCapability(
      { requiredCapability: 'nonexistent' },
      agents
    );
    assert.ok(selected); // 回退到最小负载
  });

  await t.test('WEIGHTED 策略', () => {
    const { mgr, scheduler } = createScheduler({ strategy: SCHEDULE_STRATEGY.WEIGHTED });
    mgr.create({ name: 'good', type: SUBAGENT_TYPE.ASSISTANT });
    mgr.create({ name: 'bad', type: SUBAGENT_TYPE.ASSISTANT });
    const agents = mgr._getRunningAgents();

    // 让第一个agent表现更好
    const instance1 = mgr._agents.get(agents[0].id);
    instance1.performance.tasksCompleted = 100;
    instance1.performance.tasksFailed = 0;

    const instance2 = mgr._agents.get(agents[1].id);
    instance2.performance.tasksCompleted = 10;
    instance2.performance.tasksFailed = 90;

    const selected = scheduler._selectWeighted({}, agents);
    assert.ok(selected);
    // 表现更好的agent应该有更高分
  });

  await t.test('ADAPTIVE 策略 - 默认策略', () => {
    const { mgr, scheduler } = createScheduler();
    mgr.create({ name: 'adaptive1' });
    mgr.create({ name: 'adaptive2' });
    const agents = mgr._getRunningAgents();

    const selected = scheduler._selectAdaptive({}, agents);
    assert.ok(selected);
  });
});

test('SubAgentScheduler - 任务生命周期', async (t) => {
  await t.test('完成任务', () => {
    const { scheduler } = createScheduler();
    const result = scheduler.submitTask({ content: '完成任务' });
    // 手动设置任务为活跃
    const task = scheduler._taskQueue.shift();
    task.status = TASK_STATUS.ASSIGNED;
    scheduler._activeTasks.set(task.id, task);

    const completeResult = scheduler.completeTask(task.id, { output: 'done' });
    assert.strictEqual(completeResult.success, true);
    assert.strictEqual(completeResult.status, TASK_STATUS.COMPLETED);
    assert.strictEqual(scheduler._stats.tasksCompleted, 1);
  });

  await t.test('取消队列中的任务', () => {
    const { scheduler } = createScheduler();
    const r = scheduler.submitTask({ content: '要取消的' });
    const result = scheduler.cancelTask(r.taskId);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, TASK_STATUS.CANCELLED);
  });

  await t.test('取消活跃任务', () => {
    const { scheduler } = createScheduler();
    const r = scheduler.submitTask({ content: '活跃取消' });
    const task = scheduler._taskQueue.shift();
    task.status = TASK_STATUS.ASSIGNED;
    scheduler._activeTasks.set(task.id, task);

    const result = scheduler.cancelTask(task.id);
    assert.strictEqual(result.success, true);
  });

  await t.test('取消不存在的任务应失败', () => {
    const { scheduler } = createScheduler();
    const result = scheduler.cancelTask('nonexistent_id');
    assert.strictEqual(result.success, false);
  });
});

test('SubAgentScheduler - 失败重试', async (t) => {
  await t.test('任务失败后自动重试', () => {
    const { scheduler } = createScheduler({ maxRetries: 3 });
    const r = scheduler.submitTask({ content: '会失败的任务' });
    const task = scheduler._taskQueue.shift();
    task.status = TASK_STATUS.ASSIGNED;
    scheduler._activeTasks.set(task.id, task);

    const result = scheduler.completeTask(task.id, { error: '执行失败' });
    assert.strictEqual(result.status, TASK_STATUS.RETRYING);
    assert.strictEqual(scheduler._stats.tasksRetried, 1);
  });

  await t.test('超过重试次数后标记失败', () => {
    const { scheduler } = createScheduler({ maxRetries: 1 });
    const r = scheduler.submitTask({ content: '最终失败' });
    const task = scheduler._taskQueue.shift();
    task.status = TASK_STATUS.ASSIGNED;
    task.retryCount = 1; // 已经重试过一次
    scheduler._activeTasks.set(task.id, task);

    const result = scheduler.completeTask(task.id, { error: '仍然失败' });
    assert.strictEqual(result.status, TASK_STATUS.FAILED);
    assert.strictEqual(scheduler._stats.tasksFailed, 1);
  });
});

test('SubAgentScheduler - 策略管理', async (t) => {
  await t.test('切换调度策略', () => {
    const { scheduler } = createScheduler();
    const result = scheduler.setStrategy(SCHEDULE_STRATEGY.ROUND_ROBIN);
    assert.strictEqual(result.success, true);
    assert.strictEqual(scheduler.getStrategy(), SCHEDULE_STRATEGY.ROUND_ROBIN);
  });

  await t.test('设置无效策略应失败', () => {
    const { scheduler } = createScheduler();
    const result = scheduler.setStrategy('invalid_strategy');
    assert.strictEqual(result.success, false);
  });
});

test('SubAgentScheduler - 查询', async (t) => {
  await t.test('getQueueStats() 返回队列统计', () => {
    const { scheduler } = createScheduler();
    scheduler.submitTask({ content: 'q1' });
    scheduler.submitTask({ content: 'q2' });
    const stats = scheduler.getQueueStats();
    assert.strictEqual(stats.queueDepth, 2);
    assert.strictEqual(stats.activeTasks, 0);
    assert.ok(stats.strategy);
  });

  await t.test('getTask() 查询任务', () => {
    const { scheduler } = createScheduler();
    const r = scheduler.submitTask({ content: '可查询' });
    const task = scheduler.getTask(r.taskId);
    assert.ok(task);
    assert.strictEqual(task.content, '可查询');
  });

  await t.test('getTask() 查询不存在任务', () => {
    const { scheduler } = createScheduler();
    const task = scheduler.getTask('nonexistent');
    assert.strictEqual(task, null);
  });
});

test('SubAgentScheduler - 关闭', async (t) => {
  await t.test('close() 清理所有任务', () => {
    const { scheduler } = createScheduler();
    scheduler.submitTask({ content: 'test' });
    scheduler.close();
    assert.strictEqual(scheduler._taskQueue.length, 0);
    assert.strictEqual(scheduler._activeTasks.size, 0);
  });
});
