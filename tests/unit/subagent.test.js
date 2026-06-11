/**
 * 蜜糖 TriCore Agent - 子智能体系统测试
 * Phase 28: 子智能体管理器 + 安全守护者 + 调度引擎
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 测试用的临时数据目录
function getTestDir() {
  const dir = path.join(os.tmpdir(), `tricore_subagent_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTestDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── 日志模拟 ──
const mockLogger = {
  _logs: [],
  info(msg) { this._logs.push({ level: 'info', msg }); },
  warn(msg) { this._logs.push({ level: 'warn', msg }); },
  error(msg) { this._logs.push({ level: 'error', msg }); },
  debug(msg) { this._logs.push({ level: 'debug', msg }); },
  fatal(msg) { this._logs.push({ level: 'fatal', msg }); },
  clear() { this._logs = []; },
};

// ═══════════════════════════════════════
// SubAgentManager 测试
// ═══════════════════════════════════════

describe('SubAgentManager - 子智能体管理器', () => {
  let manager, testDir;

  beforeEach(() => {
    testDir = getTestDir();
    const { SubAgentManager } = require('../../src/subagent/subagent-manager');
    manager = new SubAgentManager({
      logger: mockLogger,
      dataDir: testDir,
      maxSubAgents: 10,
    });
    mockLogger.clear();
  });

  afterEach(() => {
    if (manager) manager.close();
    cleanTestDir(testDir);
  });

  test('create - 创建子智能体', () => {
    const result = manager.create({
      name: '测试助手',
      type: 'assistant',
      description: '测试用助手',
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.agentId);
    assert.strictEqual(result.agent.name, '测试助手');
    assert.strictEqual(result.agent.type, 'assistant');
    assert.strictEqual(manager._agents.size, 1);
  });

  test('create - 自动启动', () => {
    const result = manager.create({ name: '自动启动助手' });
    const agent = manager._agents.get(result.agentId);
    assert.strictEqual(agent.status, 'running');
    assert.ok(agent.startedAt);
  });

  test('create - 不自动启动', () => {
    const result = manager.create({ name: '手动启动助手', autoStart: false });
    const agent = manager._agents.get(result.agentId);
    assert.strictEqual(agent.status, 'pending');
  });

  test('create - 名称重复检查', () => {
    manager.create({ name: '唯一名称' });
    const result = manager.create({ name: '唯一名称' });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('已存在'));
  });

  test('create - 容量限制', () => {
    const smallMgr = new (require('../../src/subagent/subagent-manager').SubAgentManager)({
      logger: mockLogger,
      dataDir: getTestDir(),
      maxSubAgents: 2,
    });

    smallMgr.create({ name: 'Agent1' });
    smallMgr.create({ name: 'Agent2' });
    const result = smallMgr.create({ name: 'Agent3' });

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('已达最大'));

    smallMgr.close();
    cleanTestDir(smallMgr._dataDir);
  });

  test('stop - 停止运行中的子智能体', () => {
    const { agentId } = manager.create({ name: '待停止助手' });
    const result = manager.stop(agentId);
    assert.strictEqual(result.success, true);
    const agent = manager._agents.get(agentId);
    assert.strictEqual(agent.status, 'stopped');
  });

  test('destroy - 销毁子智能体', () => {
    const { agentId } = manager.create({ name: '待销毁助手' });
    const result = manager.destroy(agentId);
    assert.strictEqual(result.success, true);
    assert.strictEqual(manager._agents.has(agentId), false);
  });

  test('assignTask - 分配任务', () => {
    const { agentId } = manager.create({ name: '任务接收助手' });
    const result = manager.assignTask(agentId, { content: '分析数据' });
    assert.strictEqual(result.success, true);
    assert.ok(result.taskId);

    const agent = manager._agents.get(agentId);
    assert.strictEqual(agent.tasks.length, 1);
    assert.strictEqual(agent.tasks[0].content, '分析数据');
  });

  test('assignTaskSmart - 智能任务分配', () => {
    manager.create({ name: '分析师', type: 'analyst' });
    const result = manager.assignTaskSmart({
      content: '生成报表',
      requiredCapability: 'data_analysis',
    });
    assert.strictEqual(result.success, true);
  });

  test('completeTask - 完成任务', () => {
    const { agentId } = manager.create({ name: '任务完成助手' });
    const assign = manager.assignTask(agentId, { content: '测试任务' });

    const result = manager.completeTask(agentId, assign.taskId, { output: '完成' });
    assert.strictEqual(result.success, true);

    const agent = manager._agents.get(agentId);
    assert.strictEqual(agent.tasks.length, 0);
    assert.strictEqual(agent.performance.tasksCompleted, 1);
  });

  test('list - 列出所有子智能体', () => {
    manager.create({ name: 'Agent A', type: 'assistant' });
    manager.create({ name: 'Agent B', type: 'analyst', autoStart: false });

    const list = manager.list();
    assert.strictEqual(list.length, 2);
  });

  test('list - 按类型过滤', () => {
    manager.create({ name: '助手A', type: 'assistant' });
    manager.create({ name: '分析师B', type: 'analyst' });

    const analysts = manager.list({ type: 'analyst' });
    assert.strictEqual(analysts.length, 1);
    assert.strictEqual(analysts[0].name, '分析师B');
  });

  test('list - 按状态过滤', () => {
    manager.create({ name: '运行中' });
    manager.create({ name: '已停止', autoStart: false });

    const running = manager.list({ status: 'running' });
    assert.strictEqual(running.length, 1);
    assert.strictEqual(running[0].name, '运行中');
  });

  test('getStats - 获取统计信息', () => {
    manager.create({ name: 'A', type: 'assistant' });
    manager.create({ name: 'B', type: 'analyst', autoStart: false });

    const stats = manager.getStats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.active, 1);
    assert.strictEqual(stats.safetyStatus, '正常');
  });

  test('persist & restore - 持久化与恢复', () => {
    manager.create({ name: '持久化助手' });
    manager.close();

    // 新实例恢复
    const { SubAgentManager } = require('../../src/subagent/subagent-manager');
    const manager2 = new SubAgentManager({ logger: mockLogger, dataDir: testDir });
    const restored = manager2.restore();

    assert.strictEqual(restored, 1);
    assert.strictEqual(manager2._agents.size, 1);

    const agents = manager2.list();
    assert.strictEqual(agents[0].name, '持久化助手');

    manager2.close();
  });
});

// ═══════════════════════════════════════
// SubAgentGuardian 测试
// ═══════════════════════════════════════

describe('SubAgentGuardian - 安全守护者', () => {
  let manager, guardian, testDir;

  beforeEach(() => {
    testDir = getTestDir();
    const { SubAgentManager } = require('../../src/subagent/subagent-manager');
    const { SubAgentGuardian } = require('../../src/subagent/subagent-guardian');

    manager = new SubAgentManager({ logger: mockLogger, dataDir: testDir });
    guardian = new SubAgentGuardian({
      logger: mockLogger,
      subAgentManager: manager,
      monitorInterval: 5000,
    });
    mockLogger.clear();
  });

  afterEach(() => {
    if (guardian) guardian.close();
    if (manager) manager.close();
    cleanTestDir(testDir);
  });

  test('authorize - 允许正常操作', () => {
    const { agentId } = manager.create({ name: '安全助手' });
    const result = guardian.authorize(agentId, 'read_data', {});
    assert.strictEqual(result.allowed, true);
  });

  test('authorize - 拒绝配置修改（铁律一）', () => {
    const { agentId } = manager.create({ name: '助手' });
    const result = guardian.authorize(agentId, 'set_config', { key: 'model' });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('铁律一'));
  });

  test('authorize - 拒绝系统危险操作（铁律三）', () => {
    const { agentId } = manager.create({ name: '助手' });
    const result = guardian.authorize(agentId, 'execute_shell', { cmd: 'rm -rf /' });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('铁律三'));
  });

  test('authorize - 高安全等级拒绝删除操作', () => {
    const { agentId } = manager.create({ name: '高安全助手', safetyLevel: 'high' });
    const result = guardian.authorize(agentId, 'delete', { target: 'file' });
    assert.strictEqual(result.allowed, false);
  });

  test('authorize - 隔离中拒绝操作', () => {
    const { agentId } = manager.create({ name: '隔离助手' });
    guardian._lockdownAgents.add(agentId);
    const result = guardian.authorize(agentId, 'read_data', {});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('隔离'));
  });

  test('runAnomalyCheck - 检测安全评分过低', () => {
    const { agentId } = manager.create({ name: '低分助手' });
    const agent = manager._agents.get(agentId);
    agent.safetyScore = 10;

    const anomalies = guardian.runAnomalyCheck();
    const agentAnomaly = anomalies.find(a => a.agentId === agentId);
    assert.ok(agentAnomaly);
    assert.strictEqual(agentAnomaly.severity, 'critical');
  });

  test('getStats - 获取安全统计', () => {
    const { agentId } = manager.create({ name: '助手' });
    guardian.authorize(agentId, 'set_config', {}); // 触发违规

    const stats = guardian.getStats();
    assert.ok(stats.violationsDetected > 0);
    assert.strictEqual(stats.state, 'normal');
  });
});

// ═══════════════════════════════════════
// SubAgentScheduler 测试
// ═══════════════════════════════════════

describe('SubAgentScheduler - 调度引擎', () => {
  let manager, scheduler, testDir;

  beforeEach(() => {
    testDir = getTestDir();
    const { SubAgentManager } = require('../../src/subagent/subagent-manager');
    const { SubAgentScheduler } = require('../../src/subagent/subagent-scheduler');

    manager = new SubAgentManager({ logger: mockLogger, dataDir: testDir });
    scheduler = new SubAgentScheduler({
      logger: mockLogger,
      subAgentManager: manager,
      strategy: 'least_loaded',
    });
    mockLogger.clear();
  });

  afterEach(() => {
    if (scheduler) scheduler.close();
    if (manager) manager.close();
    cleanTestDir(testDir);
  });

  test('submitTask - 提交任务', () => {
    const result = scheduler.submitTask({ content: '测试任务', priority: 2 });
    assert.strictEqual(result.success, true);
    assert.ok(result.taskId);
    assert.strictEqual(scheduler._taskQueue.length, 1);
  });

  test('submitTask - 优先级排序', () => {
    scheduler.submitTask({ content: '低优先级', priority: 0 });
    scheduler.submitTask({ content: '高优先级', priority: 3 });
    scheduler.submitTask({ content: '中优先级', priority: 1 });

    assert.strictEqual(scheduler._taskQueue[0].priority, 3);
    assert.strictEqual(scheduler._taskQueue[1].priority, 1);
    assert.strictEqual(scheduler._taskQueue[2].priority, 0);
  });

  test('submitCompositeTask - 复合任务分解', () => {
    const result = scheduler.submitCompositeTask({
      mainGoal: '综合分析',
      subtasks: [
        { content: '数据采集', requiredCapability: 'data_analysis' },
        { content: '报告生成', requiredCapability: 'report_generation' },
      ],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.totalSubtasks, 2);
    assert.strictEqual(result.tasks.length, 2);
    assert.ok(result.groupId);
  });

  test('_trySchedule - 自动分配任务', () => {
    manager.create({ name: '执行者', type: 'executor' });
    scheduler.submitTask({ content: '执行任务' });

    scheduler._trySchedule();

    assert.strictEqual(scheduler._taskQueue.length, 0);
    assert.strictEqual(scheduler._activeTasks.size, 1);
  });

  test('completeTask - 完成任务', () => {
    manager.create({ name: '完成者' });
    scheduler.submitTask({ content: '待完成' });
    scheduler._trySchedule();

    const activeTask = scheduler._activeTasks.values().next().value;
    const result = scheduler.completeTask(activeTask.id, { output: '完成' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(scheduler._activeTasks.size, 0);
    assert.strictEqual(scheduler._stats.tasksCompleted, 1);
  });

  test('cancelTask - 取消任务', () => {
    const { taskId } = scheduler.submitTask({ content: '待取消' });
    const result = scheduler.cancelTask(taskId);

    assert.strictEqual(result.success, true);
    assert.strictEqual(scheduler._taskQueue.length, 0);
  });

  test('setStrategy - 切换策略', () => {
    const result = scheduler.setStrategy('round_robin');
    assert.strictEqual(result.success, true);
    assert.strictEqual(scheduler.getStrategy(), 'round_robin');
  });

  test('getQueueStats - 获取统计', () => {
    scheduler.submitTask({ content: 'Task1' });
    scheduler.submitTask({ content: 'Task2' });

    const stats = scheduler.getQueueStats();
    assert.strictEqual(stats.queueDepth, 2);
    assert.strictEqual(stats.tasksSubmitted, 2);
    assert.strictEqual(stats.strategy, 'least_loaded');
  });
});

// ═══════════════════════════════════════
// 集成测试：子智能体全生命周期
// ═══════════════════════════════════════

describe('集成测试 - 子智能体全生命周期', () => {
  let manager, guardian, scheduler, testDir;

  beforeEach(() => {
    testDir = getTestDir();
    const { SubAgentManager } = require('../../src/subagent/subagent-manager');
    const { SubAgentGuardian } = require('../../src/subagent/subagent-guardian');
    const { SubAgentScheduler } = require('../../src/subagent/subagent-scheduler');

    manager = new SubAgentManager({ logger: mockLogger, dataDir: testDir });
    guardian = new SubAgentGuardian({ logger: mockLogger, subAgentManager: manager });
    scheduler = new SubAgentScheduler({ logger: mockLogger, subAgentManager: manager, guardian });
    mockLogger.clear();
  });

  afterEach(() => {
    if (scheduler) scheduler.close();
    if (guardian) guardian.close();
    if (manager) manager.close();
    cleanTestDir(testDir);
  });

  test('完整流程: 创建 → 运行 → 分配任务 → 完成任务 → 停止', () => {
    // 1. 创建子智能体
    const createResult = manager.create({
      name: '全流程助手',
      type: 'executor',
      description: '端到端测试',
      safetyLevel: 'medium',
    });
    assert.strictEqual(createResult.success, true);
    const agentId = createResult.agentId;

    // 2. 安全检查通过
    const authResult = guardian.authorize(agentId, 'read_data', {});
    assert.strictEqual(authResult.allowed, true);

    // 3. 分配任务
    const assignResult = manager.assignTask(agentId, { content: '处理文件' });
    assert.strictEqual(assignResult.success, true);

    // 4. 完成任务
    const completeResult = manager.completeTask(agentId, assignResult.taskId, { output: '成功' });
    assert.strictEqual(completeResult.success, true);

    // 5. 检查统计
    const agent = manager._agents.get(agentId);
    assert.strictEqual(agent.performance.tasksCompleted, 1);

    // 6. 停止
    const stopResult = manager.stop(agentId);
    assert.strictEqual(stopResult.success, true);
    assert.strictEqual(agent.status, 'stopped');
  });

  test('安全流程: 违规操作 → 自动隔离', () => {
    const { agentId } = manager.create({ name: '违规助手' });

    // 触发铁律违规
    guardian.authorize(agentId, 'set_config', { key: 'critical' });

    // 检查违规记录
    const agent = manager._agents.get(agentId);
    assert.ok(agent.violations.length > 0);
  });

  test('调度流程: 提交 → 分配 → 完成', () => {
    manager.create({ name: '调度助手', type: 'assistant' });

    // 提交任务
    const submitResult = scheduler.submitTask({
      content: '调度测试任务',
      priority: 2,
    });
    assert.strictEqual(submitResult.success, true);

    // 手动触发调度
    scheduler._trySchedule();

    // 任务应被分配
    assert.strictEqual(scheduler._taskQueue.length, 0);
    assert.strictEqual(scheduler._activeTasks.size, 1);

    // 完成任务
    const task = scheduler._activeTasks.values().next().value;
    const completeResult = scheduler.completeTask(task.id, { output: '完成' });
    assert.strictEqual(completeResult.success, true);
  });
});

console.log('\n✅ 子智能体系统测试全部完成');
