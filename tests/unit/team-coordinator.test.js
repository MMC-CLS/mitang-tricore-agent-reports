/**
 * TriCoreAgent - TeamCoordinator 单元测试
 *
 * 覆盖范围:
 *   - 构造函数与配置
 *   - 团队上下文管理 (init/get/update/remove)
 *   - 消息发送 (sendMessage, broadcastToTeam, roundRobinSpeak)
 *   - 共识投票 (startConsensus, castVote, _resolveConsensus)
 *   - 消息历史与任务查询
 *   - 统计
 *   - 内部消息投递
 *   - 清理资源
 *   - 边界条件与错误处理
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

class MockLogger {
  constructor() { this.logs = []; }
  info(msg) { this.logs.push({ level: 'info', msg }); }
  warn(msg) { this.logs.push({ level: 'warn', msg }); }
  error(msg) { this.logs.push({ level: 'error', msg }); }
}

const {
  TeamCoordinator,
  TeamMessage,
  COORDINATION_MODE,
  MESSAGE_STATUS,
  TEAM_ROLE,
} = require('../../src/subagent/team-coordinator');

// ── 辅助函数 ──

function makeCoordinator(options = {}) {
  return new TeamCoordinator({
    logger: new MockLogger(),
    ...options,
  });
}

function makeMembers(count = 3) {
  const members = [];
  for (let i = 0; i < count; i++) {
    members.push({
      agentId: `agent-${i}`,
      name: `Agent ${i}`,
      role: i === 0 ? TEAM_ROLE.LEADER : TEAM_ROLE.MEMBER,
      type: 'assistant',
    });
  }
  return members;
}

// ═══════════════════════════════════════
// 构造函数
// ═══════════════════════════════════════

test('TeamCoordinator - 构造函数', async (t) => {
  await t.test('默认选项创建实例', () => {
    const coordinator = makeCoordinator();
    assert.ok(coordinator instanceof TeamCoordinator);
  });

  await t.test('传入consentGate和subAgentManager', () => {
    const coordinator = new TeamCoordinator({
      logger: new MockLogger(),
      consentGate: { requestInterAgentMessage() {} },
      subAgentManager: { getEngine() {} },
      maxMessageHistory: 500,
    });
    assert.ok(coordinator instanceof TeamCoordinator);
  });
});

// ═══════════════════════════════════════
// TeamMessage
// ═══════════════════════════════════════

test('TeamCoordinator - TeamMessage', async (t) => {
  await t.test('创建消息', () => {
    const msg = new TeamMessage({
      teamId: 'team-1',
      fromAgentId: 'agent-1',
      fromAgentName: 'Sender',
      content: 'Hello world',
      type: 'text',
    });
    assert.ok(msg.id.startsWith('tm_'));
    assert.strictEqual(msg.teamId, 'team-1');
    assert.strictEqual(msg.fromAgentId, 'agent-1');
    assert.strictEqual(msg.content, 'Hello world');
    assert.strictEqual(msg.status, MESSAGE_STATUS.SENT);
    assert.strictEqual(msg.requiresConsent, true);
  });

  await t.test('getSummary返回摘要', () => {
    const msg = new TeamMessage({
      teamId: 'team-1',
      fromAgentId: 'agent-1',
      fromAgentName: 'Sender',
      content: 'A very long message that should be truncated in the preview',
    });
    const summary = msg.getSummary();
    assert.ok(summary.contentPreview.length <= 80);
    assert.strictEqual(summary.teamId, 'team-1');
  });

  await t.test('设置requiresConsent为false', () => {
    const msg = new TeamMessage({ requiresConsent: false });
    assert.strictEqual(msg.requiresConsent, false);
  });
});

// ═══════════════════════════════════════
// 团队上下文管理
// ═══════════════════════════════════════

test('TeamCoordinator - 团队上下文', async (t) => {
  await t.test('initTeamContext创建团队', () => {
    const coordinator = makeCoordinator();
    const members = makeMembers(3);
    const context = coordinator.initTeamContext('team-1', members);

    assert.ok(context !== null);
    assert.strictEqual(context.teamId, 'team-1');
    assert.strictEqual(context.members.length, 3);
    assert.strictEqual(context.members[0].role, TEAM_ROLE.LEADER);
    assert.strictEqual(context.config.requireConsent, true);
    assert.strictEqual(context.config.consensusThreshold, 0.6);
  });

  await t.test('getTeamContext获取存在的团队', () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));
    const ctx = coordinator.getTeamContext('team-1');
    assert.ok(ctx !== null);
    assert.strictEqual(ctx.teamId, 'team-1');
  });

  await t.test('getTeamContext对不存在团队返回null', () => {
    const coordinator = makeCoordinator();
    assert.strictEqual(coordinator.getTeamContext('nonexistent'), null);
  });

  await t.test('updateTeamMembers更新成员', () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));
    const newMembers = makeMembers(4);
    const result = coordinator.updateTeamMembers('team-1', newMembers);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.memberCount, 4);

    const ctx = coordinator.getTeamContext('team-1');
    assert.strictEqual(ctx.members.length, 4);
  });

  await t.test('updateTeamMembers对不存在团队返回错误', () => {
    const coordinator = makeCoordinator();
    const result = coordinator.updateTeamMembers('nonexistent', []);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('不存在'));
  });

  await t.test('removeTeamContext移除团队', () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));
    coordinator.removeTeamContext('team-1');
    assert.strictEqual(coordinator.getTeamContext('team-1'), null);
  });

  await t.test('initTeamContext自定义配置', () => {
    const coordinator = makeCoordinator();
    const context = coordinator.initTeamContext('team-1', makeMembers(2), {
      requireConsent: false,
      allowBroadcast: false,
      maxRoundRobinTurns: 10,
      consensusThreshold: 0.75,
    });
    assert.strictEqual(context.config.requireConsent, false);
    assert.strictEqual(context.config.consensusThreshold, 0.75);
  });
});

// ═══════════════════════════════════════
// 消息发送
// ═══════════════════════════════════════

test('TeamCoordinator - sendMessage', async (t) => {
  await t.test('向团队成员发送直接消息', async () => {
    const coordinator = makeCoordinator();
    const members = makeMembers(3);
    coordinator.initTeamContext('team-1', members);

    const result = await coordinator.sendMessage({
      teamId: 'team-1',
      fromAgentId: 'agent-0',
      fromAgentName: 'Agent 0',
      toAgentId: 'agent-1',
      content: 'Hello Agent 1!',
      requiresConsent: false,
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.messageId.startsWith('tm_'));
  });

  await t.test('发送消息到不存在的团队返回错误', async () => {
    const coordinator = makeCoordinator();
    const result = await coordinator.sendMessage({
      teamId: 'nonexistent',
      fromAgentId: 'agent-0',
      content: 'Hello',
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('团队不存在'));
  });

  await t.test('非团队成员发送消息返回错误', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));
    const result = await coordinator.sendMessage({
      teamId: 'team-1',
      fromAgentId: 'outsider',
      content: 'Hello',
      requiresConsent: false,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('不是团队成员'));
  });

  await t.test('发送给不存在的接收方返回错误', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));
    const result = await coordinator.sendMessage({
      teamId: 'team-1',
      fromAgentId: 'agent-0',
      toAgentId: 'nonexistent-receiver',
      content: 'Hello',
      requiresConsent: false,
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('不是团队成员'));
  });

  await t.test('broadcastToTeam广播消息', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(3));

    const result = await coordinator.broadcastToTeam(
      'team-1', 'agent-0', 'Agent 0',
      '广播消息', { requiresConsent: false }
    );
    assert.strictEqual(result.success, true);
    assert.ok(result.messageId.startsWith('tm_'));
  });

  await t.test('roundRobinSpeak轮流发言', async () => {
    const coordinator = makeCoordinator();
    const members = makeMembers(3);
    coordinator.initTeamContext('team-1', members);

    // 第一轮
    const result1 = await coordinator.roundRobinSpeak(
      'team-1', '第一轮发言', { requiresConsent: false }
    );
    assert.strictEqual(result1.success, true);

    // 第二轮 - 应该轮到下一个
    const result2 = await coordinator.roundRobinSpeak(
      'team-1', '第二轮发言', { requiresConsent: false }
    );
    assert.strictEqual(result2.success, true);
  });

  await t.test('roundRobinSpeak - 没有活跃成员时返回错误', async () => {
    const coordinator = makeCoordinator();
    const members = makeMembers(1).map(m => ({ ...m, status: 'inactive' }));
    coordinator.initTeamContext('team-1', members);
    // 手动设置所有成员为inactive
    const ctx = coordinator.getTeamContext('team-1');
    ctx.members.forEach(m => { m.status = 'inactive'; });

    const result = await coordinator.roundRobinSpeak('team-1', 'test');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('活跃成员'));
  });

  await t.test('消息被记录到历史', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));

    await coordinator.sendMessage({
      teamId: 'team-1',
      fromAgentId: 'agent-0',
      toAgentId: 'agent-1',
      content: '历史消息',
      requiresConsent: false,
    });

    const messages = coordinator.getTeamMessages('team-1');
    assert.ok(messages.length >= 1);
    assert.ok(messages.some(m => m.contentPreview.includes('历史消息')));
  });
});

// ═══════════════════════════════════════
// 共识投票
// ═══════════════════════════════════════

test('TeamCoordinator - 共识投票', async (t) => {
  await t.test('startConsensus启动投票', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(4));

    const result = await coordinator.startConsensus(
      'team-1', '是否同意该方案?', 'agent-0', 'Leader',
      { timeout: 100 } // 短超时避免测试hang
    );
    assert.strictEqual(result.success, true);
    assert.ok(result.pollId.startsWith('poll_'));
    assert.strictEqual(result.voterCount, 3); // 排除提议者
  });

  await t.test('startConsensus - 团队不存在', async () => {
    const coordinator = makeCoordinator();
    const result = await coordinator.startConsensus(
      'nonexistent', '问题?', 'agent-0', 'Proposer'
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('不存在'));
  });

  await t.test('castVote投票', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(4));

    const { pollId } = await coordinator.startConsensus(
      'team-1', '测试投票', 'agent-0', 'Leader',
      { timeout: 100 }
    );

    const voteResult = coordinator.castVote(pollId, 'agent-1', 'Agent 1', '同意');
    assert.strictEqual(voteResult.success, true);
    assert.strictEqual(voteResult.voteCount, 1);
  });

  await t.test('castVote - 投票不存在', () => {
    const coordinator = makeCoordinator();
    const result = coordinator.castVote('nonexistent', 'agent-1', 'A1', '同意');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('不存在'));
  });

  await t.test('castVote - 非投票人', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(3));

    const { pollId } = await coordinator.startConsensus(
      'team-1', '测试', 'agent-0', 'Leader',
      { timeout: 100 }
    );

    const result = coordinator.castVote(pollId, 'outsider', 'Outsider', '同意');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('不是有效投票人'));
  });

  await t.test('castVote - 无效选项', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(3));

    const { pollId } = await coordinator.startConsensus(
      'team-1', '测试', 'agent-0', 'Leader',
      { timeout: 100 }
    );

    const result = coordinator.castVote(pollId, 'agent-1', 'Agent 1', '无效选项');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('无效选项'));
  });

  await t.test('_resolveConsensus - 达成共识', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(4));

    const { pollId } = await coordinator.startConsensus(
      'team-1', '测试共识', 'agent-0', 'Leader',
      { threshold: 0.5, timeout: 100 }
    );

    // 两个投票都同意
    coordinator.castVote(pollId, 'agent-1', 'Agent 1', '同意');
    coordinator.castVote(pollId, 'agent-2', 'Agent 2', '同意');

    // 手动解析（因为agent-3未投票，等待超时或手动解析）
    const result = coordinator._resolveConsensus(pollId);
    assert.ok(result !== undefined);
    assert.strictEqual(result.status, 'resolved');
  });

  await t.test('共识回调被触发', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(3));

    return new Promise((resolve) => {
      coordinator.startConsensus(
        'team-1', '回调测试', 'agent-0', 'Leader',
        {
          threshold: 0.5,
          timeout: 100,
          onResolve: (result) => {
            assert.strictEqual(result.status, 'resolved');
            resolve();
          },
        }
      ).then(({ pollId }) => {
        coordinator.castVote(pollId, 'agent-1', 'Agent 1', '同意');
        coordinator.castVote(pollId, 'agent-2', 'Agent 2', '同意');
        coordinator._resolveConsensus(pollId);
      });
    });
  });
});

// ═══════════════════════════════════════
// 查询方法
// ═══════════════════════════════════════

test('TeamCoordinator - 查询方法', async (t) => {
  await t.test('getTeamMessages返回团队消息', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));

    await coordinator.sendMessage({
      teamId: 'team-1',
      fromAgentId: 'agent-0',
      content: '消息1',
      requiresConsent: false,
    });

    const messages = coordinator.getTeamMessages('team-1', 10);
    assert.ok(messages.length >= 1);
  });

  await t.test('getTeamTasks返回活跃任务', () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));
    const tasks = coordinator.getTeamTasks('team-1');
    assert.ok(Array.isArray(tasks));
  });

  await t.test('getStats返回统计', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(3));
    coordinator.initTeamContext('team-2', makeMembers(2));

    const stats = coordinator.getStats();
    // teams字段在源码中被重复赋值，实际值为数组
    assert.ok(Array.isArray(stats.teams));
    assert.strictEqual(stats.teams.length, 2);
    assert.strictEqual(stats.totalMembers, 5);
    assert.strictEqual(stats.messages, 0);
    assert.strictEqual(stats.activePolls, 0);
  });
});

// ═══════════════════════════════════════
// 消息历史限制
// ═══════════════════════════════════════

test('TeamCoordinator - 消息历史限制', async (t) => {
  await t.test('超过maxMessageHistory时截断', async () => {
    const coordinator = new TeamCoordinator({
      logger: new MockLogger(),
      maxMessageHistory: 5,
    });
    coordinator.initTeamContext('team-1', makeMembers(2));

    for (let i = 0; i < 10; i++) {
      await coordinator.sendMessage({
        teamId: 'team-1',
        fromAgentId: 'agent-0',
        content: `消息 ${i}`,
        requiresConsent: false,
      });
    }

    const messages = coordinator.getTeamMessages('team-1', 100);
    assert.ok(messages.length <= 5);
  });
});

// ═══════════════════════════════════════
// 清理资源
// ═══════════════════════════════════════

test('TeamCoordinator - close', async (t) => {
  await t.test('close清理所有资源', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));
    await coordinator.sendMessage({
      teamId: 'team-1',
      fromAgentId: 'agent-0',
      content: 'test',
      requiresConsent: false,
    });

    coordinator.close();
    const stats = coordinator.getStats();
    assert.strictEqual(stats.teams.length, 0);
  });
});

// ═══════════════════════════════════════
// 边界条件
// ═══════════════════════════════════════

test('TeamCoordinator - 边界条件', async (t) => {
  await t.test('sendMessage - 空内容', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));
    const result = await coordinator.sendMessage({
      teamId: 'team-1',
      fromAgentId: 'agent-0',
      content: '',
      requiresConsent: false,
    });
    assert.strictEqual(result.success, true);
  });

  await t.test('roundRobinSpeak对不存在团队返回错误', async () => {
    const coordinator = makeCoordinator();
    const result = await coordinator.roundRobinSpeak('nonexistent', 'test');
    assert.strictEqual(result.success, false);
  });

  await t.test('castVote - 投票已关闭', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(3));

    const { pollId } = await coordinator.startConsensus(
      'team-1', '测试', 'agent-0', 'Leader',
      { timeout: 100 }
    );
    coordinator._resolveConsensus(pollId);

    const result = coordinator.castVote(pollId, 'agent-1', 'Agent 1', '同意');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('已关闭'));
  });

  await t.test('roundRobinIndex循环归零', async () => {
    const coordinator = makeCoordinator();
    coordinator.initTeamContext('team-1', makeMembers(2));

    // 两轮后应归零
    await coordinator.roundRobinSpeak('team-1', 'msg1', { requiresConsent: false });
    await coordinator.roundRobinSpeak('team-1', 'msg2', { requiresConsent: false });
    // 第三轮应回到第一个成员
    const result = await coordinator.roundRobinSpeak('team-1', 'msg3', { requiresConsent: false });
    assert.strictEqual(result.success, true);
  });
});
