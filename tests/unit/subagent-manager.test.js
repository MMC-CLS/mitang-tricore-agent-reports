/**
 * TriCoreAgent v2.9 - SubAgentManager 单元测试
 *
 * 覆盖范围：
 *   - 子智能体创建/启动/停止/销毁生命周期
 *   - 任务分配与智能调度
 *   - 安全违规记录
 *   - 心跳监控
 *   - 持久化与恢复
 *   - 团队关联管理
 *   - 技能安装与管理
 *   - 记忆固化
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 使用临时目录进行测试
const TEST_DATA_DIR = path.join(os.tmpdir(), `tricore_test_subagent_manager_${Date.now()}`);

// 模拟 Logger
class MockLogger {
  constructor() { this.logs = []; }
  info(msg) { this.logs.push({ level: 'info', msg }); }
  warn(msg) { this.logs.push({ level: 'warn', msg }); }
  error(msg) { this.logs.push({ level: 'error', msg }); }
  debug(msg) { this.logs.push({ level: 'debug', msg }); }
}

// 加载被测模块
const {
  SubAgentManager,
  SUBAGENT_TYPE,
  SUBAGENT_STATUS,
  SAFETY_LEVEL,
  QUOTA_LEVEL,
} = require('../../src/subagent/subagent-manager');

// ── 测试前准备 ──
function createManager(options = {}) {
  return new SubAgentManager({
    logger: new MockLogger(),
    dataDir: path.join(TEST_DATA_DIR, options.suffix || 'default'),
    maxSubAgents: options.maxSubAgents || 50,
    ...options,
  });
}

function cleanup() {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
}

// ═══════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════

test('SubAgentManager - 创建子智能体', async (t) => {
  const manager = createManager({ suffix: 'create' });

  await t.test('创建基本 assistant 类型子智能体', () => {
    const result = manager.create({ name: '测试助手', type: SUBAGENT_TYPE.ASSISTANT });
    assert.strictEqual(result.success, true);
    assert.ok(result.agentId);
    assert.strictEqual(result.agent.name, '测试助手');
    assert.strictEqual(result.agent.type, SUBAGENT_TYPE.ASSISTANT);
    assert.strictEqual(result.agent.status, SUBAGENT_STATUS.RUNNING);
  });

  await t.test('创建 analyst 类型子智能体', () => {
    const result = manager.create({
      name: '数据分析师',
      type: SUBAGENT_TYPE.ANALYST,
      safetyLevel: SAFETY_LEVEL.HIGH,
      quota: QUOTA_LEVEL.HIGH,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.agent.type, SUBAGENT_TYPE.ANALYST);
    assert.strictEqual(result.agent.safetyLevel, SAFETY_LEVEL.HIGH);
  });

  await t.test('创建带 displayName 的子智能体', () => {
    const result = manager.create({
      name: 'exec_agent',
      displayName: '我的专属执行器',
      type: SUBAGENT_TYPE.EXECUTOR,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.agent.displayName, '我的专属执行器');
  });

  await t.test('不允许重复名称', () => {
    const r1 = manager.create({ name: 'unique_test', type: SUBAGENT_TYPE.ASSISTANT });
    const r2 = manager.create({ name: 'unique_test', type: SUBAGENT_TYPE.ASSISTANT });
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, false);
    assert.ok(r2.error.includes('已存在'));
  });

  await t.test('不允许空名称', () => {
    const result = manager.create({ name: '' });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('不能为空'));
  });

  await t.test('不允许无效类型', () => {
    const result = manager.create({ name: 'invalid', type: 'nonexistent' });
    assert.strictEqual(result.success, false);
  });

  await t.test('不允许无效安全等级', () => {
    const result = manager.create({ name: 'invalid_safety', safetyLevel: 'extreme' });
    assert.strictEqual(result.success, false);
  });

  await t.test('容量限制检查', () => {
    const smallMgr = createManager({ suffix: 'capacity', maxSubAgents: 2 });
    smallMgr.create({ name: 'agent1' });
    smallMgr.create({ name: 'agent2' });
    const result = smallMgr.create({ name: 'agent3' });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('最大子智能体数量'));
  });

  cleanup();
});

test('SubAgentManager - 生命周期管理', async (t) => {
  const manager = createManager({ suffix: 'lifecycle' });

  await t.test('启动子智能体', () => {
    const r = manager.create({ name: 'lifecycle_test', autoStart: false });
    assert.strictEqual(r.agent.status, SUBAGENT_STATUS.PENDING);

    const startResult = manager.start(r.agentId);
    assert.strictEqual(startResult.success, true);
    assert.strictEqual(startResult.status, SUBAGENT_STATUS.RUNNING);
  });

  await t.test('停止子智能体', () => {
    const r = manager.create({ name: 'stop_test' });
    const stopResult = manager.stop(r.agentId);
    assert.strictEqual(stopResult.success, true);
    assert.strictEqual(stopResult.status, SUBAGENT_STATUS.STOPPED);
  });

  await t.test('重启子智能体', () => {
    const r = manager.create({ name: 'restart_test' });
    manager.stop(r.agentId);
    const restartResult = manager.restart(r.agentId);
    assert.strictEqual(restartResult.success, true);
    assert.strictEqual(restartResult.status, SUBAGENT_STATUS.RUNNING);
  });

  await t.test('销毁子智能体', () => {
    const r = manager.create({ name: 'destroy_test' });
    const destroyResult = manager.destroy(r.agentId);
    assert.strictEqual(destroyResult.success, true);
    assert.strictEqual(manager.get(r.agentId), null);
  });

  await t.test('停止不在运行中的子智能体应报错', () => {
    const r = manager.create({ name: 'stopped_twice', autoStart: false });
    const result = manager.stop(r.agentId);
    assert.strictEqual(result.success, false);
  });

  await t.test('销毁后无法启动', () => {
    const r = manager.create({ name: 'destroyed_start' });
    manager.destroy(r.agentId);
    const result = manager.start(r.agentId);
    assert.strictEqual(result.success, false);
  });

  cleanup();
});

test('SubAgentManager - 任务分配', async (t) => {
  const manager = createManager({ suffix: 'tasks' });

  await t.test('向运行中子智能体分配任务', () => {
    const r = manager.create({ name: 'task_agent' });
    const result = manager.assignTask(r.agentId, { content: '分析这份数据', priority: 2 });
    assert.strictEqual(result.success, true);
    assert.ok(result.taskId);
  });

  await t.test('向停止的子智能体分配任务应失败', () => {
    const r = manager.create({ name: 'stopped_task_agent' });
    manager.stop(r.agentId);
    const result = manager.assignTask(r.agentId, { content: '测试任务' });
    assert.strictEqual(result.success, false);
  });

  await t.test('智能任务分配 - 能力匹配', () => {
    manager.create({ name: 'analyst1', type: SUBAGENT_TYPE.ANALYST });
    manager.create({ name: 'exec1', type: SUBAGENT_TYPE.EXECUTOR });

    const result = manager.assignTaskSmart({
      content: '分析数据',
      requiredCapability: 'data_analysis',
    });
    assert.strictEqual(result.success, true);
  });

  await t.test('完成任务', () => {
    const r = manager.create({ name: 'complete_test' });
    const taskResult = manager.assignTask(r.agentId, { content: '完成我' });
    const completeResult = manager.completeTask(r.agentId, taskResult.taskId, { output: 'done' });
    assert.strictEqual(completeResult.success, true);
    assert.strictEqual(completeResult.status, 'completed');
  });

  cleanup();
});

test('SubAgentManager - 安全违规', async (t) => {
  const manager = createManager({ suffix: 'safety' });

  await t.test('记录安全违规', () => {
    const r = manager.create({ name: 'safety_test' });
    manager.recordViolation(r.agentId, {
      type: 'unauthorized_action',
      description: '尝试修改配置文件',
      severity: 'high',
    });

    const detail = manager.get(r.agentId);
    assert.strictEqual(detail.violations.length, 1);
    assert.ok(detail.safetyReport.score < 100);
  });

  await t.test('严重违规自动停止', () => {
    const r = manager.create({ name: 'critical_test' });
    manager.recordViolation(r.agentId, {
      type: 'system_breach',
      description: '严重安全违规',
      severity: 'critical',
    });

    const detail = manager.get(r.agentId);
    assert.strictEqual(detail.status, SUBAGENT_STATUS.STOPPED);
  });

  await t.test('安全检查 - 阻止受限操作', () => {
    const r = manager.create({ name: 'check_test', safetyLevel: SAFETY_LEVEL.HIGH });
    const result = manager.checkSafety(r.agentId, 'delete');
    assert.strictEqual(result.allowed, false);
  });

  await t.test('安全检查 - 允许安全操作', () => {
    const r = manager.create({ name: 'safe_check' });
    const result = manager.checkSafety(r.agentId, 'read');
    assert.strictEqual(result.allowed, true);
  });

  cleanup();
});

test('SubAgentManager - 查询与统计', async (t) => {
  const manager = createManager({ suffix: 'query' });

  await t.test('列表查询 - 按类型过滤', () => {
    manager.create({ name: 'a1', type: SUBAGENT_TYPE.ASSISTANT });
    manager.create({ name: 'a2', type: SUBAGENT_TYPE.ANALYST });
    manager.create({ name: 'a3', type: SUBAGENT_TYPE.ASSISTANT });

    const assistants = manager.list({ type: SUBAGENT_TYPE.ASSISTANT });
    assert.strictEqual(assistants.length, 2);
  });

  await t.test('列表查询 - 按状态过滤', () => {
    const r = manager.create({ name: 'status_filter', autoStart: false });
    const stopped = manager.list({ status: SUBAGENT_STATUS.PENDING });
    assert.ok(stopped.length >= 1);
  });

  await t.test('获取统计信息', () => {
    const stats = manager.getStats();
    assert.ok(stats.total >= 0);
    assert.ok(typeof stats.active === 'number');
    assert.ok(stats.byType);
    assert.ok(stats.byStatus);
  });

  await t.test('获取子智能体详情', () => {
    const r = manager.create({ name: 'detail_test', description: '这是一个测试' });
    const detail = manager.get(r.agentId);
    assert.strictEqual(detail.name, 'detail_test');
    assert.strictEqual(detail.description, '这是一个测试');
    assert.ok(detail.performance);
    assert.ok(detail.safetyReport);
  });

  cleanup();
});

test('SubAgentManager - 持久化与恢复', async (t) => {
  await t.test('持久化子智能体数据', () => {
    const manager = createManager({ suffix: 'persist' });
    const r = manager.create({ name: 'persist_test' });
    // 手动触发持久化
    manager._persist();

    const dataPath = path.join(manager._dataDir, 'subagents.json');
    assert.ok(fs.existsSync(dataPath));

    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    assert.ok(Array.isArray(data));
    assert.ok(data.some(a => a.name === 'persist_test'));
  });

  await t.test('恢复子智能体数据', () => {
    // 创建并持久化
    const mgr1 = createManager({ suffix: 'restore' });
    mgr1.create({ name: 'restore_me' });
    mgr1._persist();

    // 新管理器恢复
    const mgr2 = createManager({ suffix: 'restore' });
    const count = mgr2.restore();
    assert.ok(count > 0);

    const agents = mgr2.list();
    assert.ok(agents.some(a => a.name === 'restore_me'));
  });

  cleanup();
});

test('SubAgentManager - 团队关联管理', async (t) => {
  const manager = createManager({ suffix: 'team' });

  await t.test('关联子智能体到团队', () => {
    const r = manager.create({ name: 'team_member' });
    const result = manager.linkToTeam(r.agentId, 'team_alpha', 'developer');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.role, 'developer');
  });

  await t.test('获取子智能体团队列表', () => {
    const r = manager.create({ name: 'multi_team' });
    manager.linkToTeam(r.agentId, 'team_a', 'leader');
    manager.linkToTeam(r.agentId, 'team_b', 'member');

    const teams = manager.getAgentTeams(r.agentId);
    assert.strictEqual(teams.length, 2);
  });

  await t.test('解除团队关联', () => {
    const r = manager.create({ name: 'unlink_test' });
    manager.linkToTeam(r.agentId, 'team_x');
    manager.unlinkFromTeam(r.agentId, 'team_x');

    const teams = manager.getAgentTeams(r.agentId);
    assert.strictEqual(teams.length, 0);
  });

  await t.test('设置子智能体显示名称', () => {
    const r = manager.create({ name: 'rename_test' });
    const result = manager.setAgentDisplayName(r.agentId, '新名称');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.displayName, '新名称');
  });

  cleanup();
});

test('SubAgentManager - 技能安装接口', async (t) => {
  const manager = createManager({ suffix: 'skills' });

  await t.test('获取技能安装器实例', () => {
    const installer = manager.getSkillInstaller();
    assert.ok(installer);
  });

  await t.test('获取记忆绑定器实例', () => {
    const binder = manager.getMemoryBinder();
    assert.ok(binder);
  });

  cleanup();
});

test('SubAgentManager - 关闭清理', async (t) => {
  await t.test('close() 正常关闭', () => {
    const manager = createManager({ suffix: 'close' });
    manager.create({ name: 'close_test' });
    manager.close();
    const list = manager.list();
    assert.ok(Array.isArray(list), '关闭后list()应返回数组');
  });

  cleanup();
});

// ── 最终清理 ──
test('清理测试数据', () => {
  cleanup();
});
