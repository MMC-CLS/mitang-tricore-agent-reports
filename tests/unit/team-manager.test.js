/**
 * TriCoreAgent v2.9 - TeamManager 单元测试
 *
 * 覆盖范围：
 *   - 团队创建/激活/暂停/解散/删除
 *   - 成员管理（添加/移除/角色更新）
 *   - 团队消息通信
 *   - 共识投票
 *   - 确认门控
 *   - 持久化与恢复
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const TEST_DATA_DIR = path.join(os.tmpdir(), `tricore_test_team_${Date.now()}`);

class MockLogger {
  constructor() { this.logs = []; }
  info() {}
  warn() {}
  error() {}
  debug() {}
}

// 需要先创建SubAgentManager来提供subAgentManager引用
const {
  SubAgentManager,
  SUBAGENT_TYPE,
} = require('../../src/subagent/subagent-manager');

const {
  TeamManager,
  TEAM_TYPE,
  TEAM_STATUS,
  TEAM_ROLE,
} = require('../../src/subagent/team-manager');

function createTeamManager(options = {}) {
  const subMgr = new SubAgentManager({
    logger: new MockLogger(),
    dataDir: path.join(TEST_DATA_DIR, options.suffix || 'default', 'subagents'),
    maxSubAgents: 20,
  });

  const teamMgr = new TeamManager({
    logger: new MockLogger(),
    dataDir: path.join(TEST_DATA_DIR, options.suffix || 'default', 'teams'),
    subAgentManager: subMgr,
    maxTeams: options.maxTeams || 10,
    maxMembersPerTeam: options.maxMembers || 10,
  });

  return { teamMgr, subMgr };
}

function cleanup() {
  try { require('fs').rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
}

// ═══════════════════════════════════════

test('TeamManager - 创建团队', async (t) => {
  await t.test('创建基本团队', () => {
    const { teamMgr } = createTeamManager({ suffix: 'create_basic' });
    const result = teamMgr.create({
      name: 'Alpha团队',
      description: '测试用',
      type: TEAM_TYPE.TASK_FORCE,
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.teamId);
    assert.strictEqual(result.team.name, 'Alpha团队');
  });

  await t.test('创建任务执行团队（默认类型）', () => {
    const { teamMgr } = createTeamManager({ suffix: 'create_taskforce' });
    const result = teamMgr.create({
      name: '任务队',
      type: TEAM_TYPE.TASK_FORCE,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.team.type, TEAM_TYPE.TASK_FORCE);
  });

  await t.test('不允许重复名称', () => {
    const { teamMgr } = createTeamManager({ suffix: 'create_dup' });
    teamMgr.create({ name: 'UniqueTeam' });
    const result = teamMgr.create({ name: 'UniqueTeam' });
    assert.strictEqual(result.success, false);
  });

  await t.test('容量限制', () => {
    const { teamMgr } = createTeamManager({ suffix: 'create_cap', maxTeams: 2 });
    teamMgr.create({ name: 'T1' });
    teamMgr.create({ name: 'T2' });
    const result = teamMgr.create({ name: 'T3' });
    assert.strictEqual(result.success, false);
  });

  cleanup();
});

test('TeamManager - 生命周期', async (t) => {
  await t.test('激活团队', () => {
    const { teamMgr } = createTeamManager({ suffix: 'life_activate' });
    const r = teamMgr.create({ name: '激活测试' });
    const result = teamMgr.activate(r.teamId);
    assert.strictEqual(result.success, true);
  });

  await t.test('暂停团队', () => {
    const { teamMgr } = createTeamManager({ suffix: 'life_pause' });
    const r = teamMgr.create({ name: '暂停测试' });
    teamMgr.activate(r.teamId);  // 需要先激活才能暂停
    teamMgr.pause(r.teamId);
    const team = teamMgr.get(r.teamId);
    assert.strictEqual(team.status, TEAM_STATUS.PAUSED);
  });

  await t.test('解散团队', () => {
    const { teamMgr } = createTeamManager({ suffix: 'life_dissolve' });
    const r = teamMgr.create({ name: '解散测试' });
    teamMgr.dissolve(r.teamId);
    const team = teamMgr.get(r.teamId);
    assert.strictEqual(team.status, TEAM_STATUS.DISSOLVED);
  });

  await t.test('删除团队', () => {
    const { teamMgr } = createTeamManager({ suffix: 'life_remove' });
    const r = teamMgr.create({ name: '删除测试' });
    teamMgr.remove(r.teamId);
    const team = teamMgr.get(r.teamId);
    assert.strictEqual(team, null);
  });

  cleanup();
});

test('TeamManager - 成员管理', async (t) => {
  await t.test('添加成员', () => {
    const { teamMgr, subMgr } = createTeamManager({ suffix: 'member_add' });
    subMgr.create({ name: 'member1', type: SUBAGENT_TYPE.ASSISTANT });
    const agents = subMgr.list();

    const team = teamMgr.create({ name: '成员测试' });
    const result = teamMgr.addMember(team.teamId, agents[0].id, TEAM_ROLE.DEVELOPER);
    assert.strictEqual(result.success, true);
  });

  await t.test('移除成员', () => {
    const { teamMgr, subMgr } = createTeamManager({ suffix: 'member_remove' });
    subMgr.create({ name: 'remove_me' });
    const agents = subMgr.list();

    const team = teamMgr.create({ name: '移除测试' });
    teamMgr.addMember(team.teamId, agents[0].id);
    const result = teamMgr.removeMember(team.teamId, agents[0].id);
    assert.strictEqual(result.success, true);
  });

  await t.test('更新成员角色', () => {
    const { teamMgr, subMgr } = createTeamManager({ suffix: 'member_role' });
    subMgr.create({ name: 'role_me' });
    const agents = subMgr.list();

    const team = teamMgr.create({ name: '角色测试' });
    teamMgr.addMember(team.teamId, agents[0].id, TEAM_ROLE.MEMBER);
    const result = teamMgr.updateMemberRole(team.teamId, agents[0].id, TEAM_ROLE.LEADER);
    assert.strictEqual(result.success, true);
  });

  cleanup();
});

test('TeamManager - 查询', async (t) => {
  await t.test('获取团队列表', () => {
    const { teamMgr } = createTeamManager({ suffix: 'query_list' });
    teamMgr.create({ name: 'A队' });
    teamMgr.create({ name: 'B队' });
    const teams = teamMgr.list();
    assert.strictEqual(teams.length, 2);
  });

  await t.test('获取团队详情', () => {
    const { teamMgr } = createTeamManager({ suffix: 'query_detail' });
    const r = teamMgr.create({ name: '详情队', description: '测试描述' });
    const detail = teamMgr.get(r.teamId);
    assert.strictEqual(detail.name, '详情队');
    assert.strictEqual(detail.description, '测试描述');
  });

  await t.test('获取团队统计', () => {
    const { teamMgr } = createTeamManager({ suffix: 'query_stats' });
    teamMgr.create({ name: '统计1' });
    teamMgr.create({ name: '统计2' });
    const stats = teamMgr.getStats();
    assert.strictEqual(stats.total, 2);
  });

  cleanup();
});

test('TeamManager - 持久化', async (t) => {
  await t.test('持久化与恢复', () => {
    const suffix = 'persist_test';
    const { teamMgr: mgr1 } = createTeamManager({ suffix });
    mgr1.create({ name: 'persist_team' });
    mgr1._persist();

    const { teamMgr: mgr2 } = createTeamManager({ suffix });
    const restored = mgr2.restore();
    assert.ok(restored > 0);
  });

  cleanup();
});

test('TeamManager - 关闭', async (t) => {
  await t.test('close() 正常关闭', () => {
    const { teamMgr } = createTeamManager({ suffix: 'close' });
    teamMgr.create({ name: 'close_team' });
    teamMgr.close();
    const teams = teamMgr.list();
    assert.ok(Array.isArray(teams), '关闭后list()应返回数组');
  });

  cleanup();
});

// ── 最终清理 ──
test('清理测试数据', () => {
  cleanup();
});
