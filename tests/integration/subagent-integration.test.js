/**
 * TriCoreAgent v2.9 - 子智能体系统集成测试
 *
 * 覆盖范围：
 *   - 子智能体创建 → 启动 → 对话 → 团队协作 → 技能安装 → 记忆固化 全流程
 *   - 安全检查集成
 *   - 调度集成
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DATA_DIR = path.join(os.tmpdir(), `tricore_test_integration_${Date.now()}`);

class MockLogger {
  constructor() { this.logs = []; }
  info() {}
  warn() {}
  error() {}
  debug() {}
}

function cleanup() {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
}

// ═══════════════════════════════════════

test('集成测试 - 子智能体全生命周期', async (t) => {
  await t.test('创建→启动→对话→停止→销毁', async () => {
    const { SubAgentManager, SUBAGENT_TYPE, SUBAGENT_STATUS } = require('../../src/subagent/subagent-manager');

    const mgr = new SubAgentManager({
      logger: new MockLogger(),
      dataDir: path.join(TEST_DATA_DIR, 'lifecycle'),
      maxSubAgents: 10,
    });

    // 1. 创建
    const createResult = mgr.create({
      name: '集成测试智能体',
      displayName: '集成小助手',
      type: SUBAGENT_TYPE.ASSISTANT,
      safetyLevel: 'medium',
      quota: 'medium',
    });
    assert.strictEqual(createResult.success, true);
    const agentId = createResult.agentId;

    // 2. 验证状态
    const agent = mgr.get(agentId);
    assert.strictEqual(agent.status, SUBAGENT_STATUS.RUNNING);
    assert.strictEqual(agent.displayName, '集成小助手');

    // 3. 分配任务
    const taskResult = mgr.assignTask(agentId, { content: '帮我分析一下数据' });
    assert.strictEqual(taskResult.success, true);

    // 4. 完成任务
    const completeResult = mgr.completeTask(agentId, taskResult.taskId, { output: '分析完成' });
    assert.strictEqual(completeResult.success, true);

    // 5. 停止
    mgr.stop(agentId);
    assert.strictEqual(mgr.get(agentId).status, SUBAGENT_STATUS.STOPPED);

    // 6. 重启
    mgr.restart(agentId);
    assert.strictEqual(mgr.get(agentId).status, SUBAGENT_STATUS.RUNNING);

    // 7. 销毁
    mgr.destroy(agentId);
    assert.strictEqual(mgr.get(agentId), null);

    mgr.close();
  });

  cleanup();
});

test('集成测试 - 安全守护者集成', async (t) => {
  await t.test('Guardian保护子智能体安全', () => {
    const { SubAgentManager } = require('../../src/subagent/subagent-manager');
    const { SubAgentGuardian } = require('../../src/subagent/subagent-guardian');

    const mgr = new SubAgentManager({
      logger: new MockLogger(),
      dataDir: path.join(TEST_DATA_DIR, 'guardian_integration'),
    });

    const guardian = new SubAgentGuardian({
      logger: new MockLogger(),
      subAgentManager: mgr,
      monitorInterval: 999999,
    });

    // 创建agent
    mgr.create({ name: '被守护的智能体' });
    const agents = mgr.list();
    const agentId = agents[0].id;

    // 安全操作应被允许
    const safeResult = guardian.authorize(agentId, 'read', {});
    assert.strictEqual(safeResult.allowed, true);

    // 危险操作应被拒绝
    const dangerResult = guardian.authorize(agentId, 'execute_shell', { cmd: 'rm -rf /' });
    assert.strictEqual(dangerResult.allowed, false);

    // 隔离后应拒绝所有操作
    guardian._quarantineAgent(agentId, '测试隔离');
    const quarResult = guardian.authorize(agentId, 'read', {});
    assert.strictEqual(quarResult.allowed, false);

    // 释放后应恢复
    guardian.releaseAgent(agentId);
    const releaseResult = guardian.authorize(agentId, 'read', {});
    assert.strictEqual(releaseResult.allowed, true);

    mgr.close();
  });

  cleanup();
});

test('集成测试 - 调度器集成', async (t) => {
  await t.test('调度器+管理器协同工作', () => {
    const { SubAgentManager, SUBAGENT_TYPE } = require('../../src/subagent/subagent-manager');
    const { SubAgentScheduler, SCHEDULE_STRATEGY } = require('../../src/subagent/subagent-scheduler');

    const mgr = new SubAgentManager({
      logger: new MockLogger(),
      dataDir: path.join(TEST_DATA_DIR, 'scheduler_integration'),
    });

    const scheduler = new SubAgentScheduler({
      logger: new MockLogger(),
      subAgentManager: mgr,
      strategy: SCHEDULE_STRATEGY.LEAST_LOADED,
      maxConcurrentTasks: 5,
    });

    // 创建多个agent
    mgr.create({ name: 'worker1', type: SUBAGENT_TYPE.ASSISTANT });
    mgr.create({ name: 'worker2', type: SUBAGENT_TYPE.EXECUTOR });
    mgr.create({ name: 'analyst1', type: SUBAGENT_TYPE.ANALYST });

    // 提交多个任务
    scheduler.submitTask({ content: '任务1', priority: 1 });
    scheduler.submitTask({ content: '任务2', priority: 3 });
    scheduler.submitTask({
      content: '数据分析任务',
      requiredCapability: 'data_analysis',
      priority: 2,
    });

    // 验证队列状态
    const stats = scheduler.getQueueStats();
    assert.strictEqual(stats.queueDepth, 3);
    assert.ok(stats.strategy === SCHEDULE_STRATEGY.LEAST_LOADED);

    scheduler.close();
    mgr.close();
  });

  cleanup();
});

test('集成测试 - 团队+子智能体集成', async (t) => {
  await t.test('创建团队并添加成员', () => {
    const { SubAgentManager, SUBAGENT_TYPE } = require('../../src/subagent/subagent-manager');
    const { TeamManager, TEAM_TYPE, TEAM_ROLE } = require('../../src/subagent/team-manager');

    const subMgr = new SubAgentManager({
      logger: new MockLogger(),
      dataDir: path.join(TEST_DATA_DIR, 'team_integration', 'subagents'),
    });

    const teamMgr = new TeamManager({
      logger: new MockLogger(),
      dataDir: path.join(TEST_DATA_DIR, 'team_integration', 'teams'),
      subAgentManager: subMgr,
    });

    // 创建智能体
    subMgr.create({ name: '队长', type: SUBAGENT_TYPE.ASSISTANT });
    subMgr.create({ name: '开发员', type: SUBAGENT_TYPE.EXECUTOR });
    subMgr.create({ name: '分析师', type: SUBAGENT_TYPE.ANALYST });
    const agents = subMgr.list();

    // 创建团队
    const team = teamMgr.create({
      name: '开发团队',
      type: TEAM_TYPE.COLLABORATIVE,
      description: '协作开发团队',
    });
    assert.strictEqual(team.success, true);

    // 添加成员
    teamMgr.addMember(team.teamId, agents[0].id, TEAM_ROLE.LEADER);
    teamMgr.addMember(team.teamId, agents[1].id, TEAM_ROLE.DEVELOPER);
    teamMgr.addMember(team.teamId, agents[2].id, TEAM_ROLE.ANALYST);

    // 获取团队详情
    const detail = teamMgr.get(team.teamId);
    assert.ok(detail);
    assert.ok(detail.members);

    // 获取团队统计
    const stats = teamMgr.getStats();
    assert.strictEqual(stats.total, 1);

    teamMgr.close();
    subMgr.close();
  });

  cleanup();
});

test('集成测试 - 技能安装+记忆固化集成', async (t) => {
  await t.test('安装技能并固化到记忆', () => {
    const { SubAgentSkillInstaller } = require('../../src/subagent/subagent-skill-installer');
    const { SubAgentMemoryBinder } = require('../../src/subagent/subagent-memory-binder');

    const installer = new SubAgentSkillInstaller({
      logger: new MockLogger(),
      dataDir: path.join(TEST_DATA_DIR, 'skill_mem_integration'),
    });

    const binder = new SubAgentMemoryBinder({
      logger: new MockLogger(),
      dataDir: path.join(TEST_DATA_DIR, 'skill_mem_integration'),
    });

    // 安装技能
    const skillContent = `# 测试技能
> 集成测试技能

## Category
test

## Trigger Keywords
test, 测试, integration

## Instructions
执行集成测试验证

## Version
1.0.0
`;

    const installResult = installer.installFromContent('agent_integration', skillContent);
    assert.strictEqual(installResult.success, true);

    // 初始化记忆空间
    binder.initAgentMemory('agent_integration', { agentName: '集成测试' });

    // 绑定技能到记忆
    const skill = installResult.skill;
    const bindResult = binder.bindSkill('agent_integration', skill);
    assert.ok(bindResult);

    // 锁定为核心记忆
    const lockResult = binder.lockSkillAsCore('agent_integration', skill.name);
    assert.ok(lockResult);

    // 写入相关记忆
    binder.writeMemory('agent_integration', '执行了集成测试，技能安装成功', 5.0);

    // 获取固化技能
    const boundSkills = binder.getBoundSkills('agent_integration');
    assert.ok(Array.isArray(boundSkills));

    installer.close?.();
    binder.close?.();
  });

  cleanup();
});

// ── 最终清理 ──
test('清理测试数据', () => {
  cleanup();
});
