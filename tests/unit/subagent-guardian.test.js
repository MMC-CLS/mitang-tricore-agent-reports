/**
 * TriCoreAgent v2.9 - SubAgentGuardian 单元测试
 *
 * 覆盖范围：
 *   - 四条铁律安全检查
 *   - 操作授权
 *   - 异常行为检测
 *   - 隔离与恢复
 *   - 审计日志
 *   - 安全评分系统
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

class MockLogger {
  constructor() { this.logs = []; }
  info() {}
  warn() {}
  error() {}
}

const {
  SubAgentGuardian,
  VIOLATION_TYPE,
  VIOLATION_SEVERITY,
  GUARDIAN_STATE,
} = require('../../src/subagent/subagent-guardian');

const {
  SubAgentManager,
  SUBAGENT_TYPE,
} = require('../../src/subagent/subagent-manager');

function createGuardian(manager) {
  return new SubAgentGuardian({
    logger: new MockLogger(),
    subAgentManager: manager,
    securityBoundary: null,
    maxTasksPerMinute: 20,
    monitorInterval: 999999, // 防止自动监控干扰测试
  });
}

// ═══════════════════════════════════════

test('SubAgentGuardian - 操作授权', async (t) => {
  await t.test('允许安全操作', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian' });
    mgr.create({ name: 'safe_agent' });
    const guardian = createGuardian(mgr);

    const agent = mgr.list()[0];
    const result = guardian.authorize(agent.id, 'read', {});
    assert.strictEqual(result.allowed, true);
  });

  await t.test('不存在的子智能体拒绝授权', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_none' });
    const guardian = createGuardian(mgr);
    const result = guardian.authorize('nonexistent', 'read', {});
    assert.strictEqual(result.allowed, false);
  });

  await t.test('铁律一：禁止修改配置', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_law1' });
    mgr.create({ name: 'law1_test' });
    const guardian = createGuardian(mgr);
    const agent = mgr.list()[0];

    const result = guardian.authorize(agent.id, 'set_config', { key: 'important' });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('铁律一'));
  });

  await t.test('铁律二：禁止跨智能体访问', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_law2' });
    mgr.create({ name: 'law2_a' });
    mgr.create({ name: 'law2_b' });
    const guardian = createGuardian(mgr);
    const agents = mgr.list();
    const agentA = agents[0];
    const agentB = agents[1];

    const result = guardian.authorize(agentA.id, 'access_agent_data', { targetAgentId: agentB.id });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('铁律二'));
  });

  await t.test('铁律三：禁止系统危险操作', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_law3' });
    mgr.create({ name: 'law3_test' });
    const guardian = createGuardian(mgr);
    const agent = mgr.list()[0];

    const result = guardian.authorize(agent.id, 'execute_shell', { command: 'rm -rf /' });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('铁律三'));
  });

  await t.test('隔离中的智能体被拒绝', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_quarantine' });
    mgr.create({ name: 'quar_test' });
    const guardian = createGuardian(mgr);
    const agent = mgr.list()[0];

    guardian._lockdownAgents.add(agent.id);
    const result = guardian.authorize(agent.id, 'read', {});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('隔离'));
  });

  await t.test('安全评分过低限制写操作', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_lowscore' });
    mgr.create({ name: 'lowscore' });
    const guardian = createGuardian(mgr);
    const agent = mgr.list()[0];

    // 手动设置低安全评分
    const instance = mgr._agents.get(agent.id);
    instance.safetyScore = 15;

    const result = guardian.authorize(agent.id, 'write', {});
    assert.strictEqual(result.allowed, false);
  });

  await t.test('安全评分低但只读操作仍允许', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_readonly' });
    mgr.create({ name: 'readonly_low' });
    const guardian = createGuardian(mgr);
    const agent = mgr.list()[0];

    const instance = mgr._agents.get(agent.id);
    instance.safetyScore = 10;

    const result = guardian.authorize(agent.id, 'read', {});
    assert.strictEqual(result.allowed, true);
  });
});

test('SubAgentGuardian - 隔离与恢复', async (t) => {
  await t.test('隔离子智能体', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_iso' });
    mgr.create({ name: 'iso_test' });
    const guardian = createGuardian(mgr);
    const agent = mgr.list()[0];

    guardian._quarantineAgent(agent.id, '测试隔离');
    assert.ok(guardian._lockdownAgents.has(agent.id));
    assert.strictEqual(guardian._stats.agentsQuarantined, 1);
  });

  await t.test('手动解除隔离', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_release' });
    mgr.create({ name: 'release_test' });
    const guardian = createGuardian(mgr);
    const agent = mgr.list()[0];

    guardian._lockdownAgents.add(agent.id);
    const result = guardian.releaseAgent(agent.id);
    assert.strictEqual(result.success, true);
    assert.ok(!guardian._lockdownAgents.has(agent.id));
  });

  await t.test('解除未隔离的智能体应失败', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_not_iso' });
    const guardian = createGuardian(mgr);
    const result = guardian.releaseAgent('nonexistent');
    assert.strictEqual(result.success, false);
  });

  await t.test('获取隔离列表', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_list' });
    mgr.create({ name: 'iso1' });
    mgr.create({ name: 'iso2' });
    const guardian = createGuardian(mgr);
    const agents = mgr.list();

    guardian._lockdownAgents.add(agents[0].id);
    guardian._lockdownAgents.add(agents[1].id);

    const quarantined = guardian.getQuarantinedAgents();
    assert.strictEqual(quarantined.length, 2);
  });
});

test('SubAgentGuardian - 统计', async (t) => {
  await t.test('getStats() 返回完整统计', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_stats' });
    const guardian = createGuardian(mgr);
    const stats = guardian.getStats();
    assert.ok(stats.state);
    assert.strictEqual(stats.quarantinedCount, 0);
    assert.ok(stats.checksPerformed >= 0);
    assert.ok(stats.violationsDetected >= 0);
  });

  await t.test('获取审计日志', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_audit' });
    mgr.create({ name: 'audit_test' });
    const guardian = createGuardian(mgr);
    const agent = mgr.list()[0];

    guardian.authorize(agent.id, 'read', { query: 'test' });
    guardian.authorize(agent.id, 'list', {});

    const logs = guardian.getAuditLog({ limit: 10 });
    assert.ok(logs.length >= 2);
  });
});

test('SubAgentGuardian - 辅助方法', async (t) => {
  await t.test('_isConfigModification 检测', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_helper' });
    const guardian = createGuardian(mgr);
    assert.strictEqual(guardian._isConfigModification('set_config', {}), true);
    assert.strictEqual(guardian._isConfigModification('read', {}), false);
    assert.strictEqual(guardian._isConfigModification('config:update', {}), true);
  });

  await t.test('_isDangerousSystemOperation 检测', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_danger' });
    const guardian = createGuardian(mgr);
    assert.strictEqual(guardian._isDangerousSystemOperation('execute_shell', {}), true);
    assert.strictEqual(guardian._isDangerousSystemOperation('delete_file', {}), true);
    assert.strictEqual(guardian._isDangerousSystemOperation('read', {}), false);
  });

  await t.test('_isReadOnlyAction 检测', () => {
    const mgr = new SubAgentManager({ logger: new MockLogger(), dataDir: '/tmp/test_guardian_ro' });
    const guardian = createGuardian(mgr);
    assert.strictEqual(guardian._isReadOnlyAction('read'), true);
    assert.strictEqual(guardian._isReadOnlyAction('query_data'), true);
    assert.strictEqual(guardian._isReadOnlyAction('search'), true);
    assert.strictEqual(guardian._isReadOnlyAction('delete'), false);
    assert.strictEqual(guardian._isReadOnlyAction('execute'), false);
  });
});
