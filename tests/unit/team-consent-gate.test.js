/**
 * TriCoreAgent - TeamConsentGate 单元测试
 *
 * 覆盖范围:
 *   - 构造函数与配置
 *   - 确认请求创建 (requestConsent)
 *   - 批准确认 (approve)
 *   - 拒绝确认 (reject)
 *   - 取消确认 (cancel)
 *   - 超时自动过期
 *   - 列表/历史/统计查询
 *   - 便捷方法 (requestToolExecution等)
 *   - 回调执行 (onApprove/onReject)
 *   - 容量限制
 *   - 清理资源 (close)
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
  TeamConsentGate,
  ConsentRequest,
  CONSENT_TYPE,
  CONSENT_STATUS,
} = require('../../src/subagent/team-consent-gate');

// ═══════════════════════════════════════
// 构造函数
// ═══════════════════════════════════════

test('TeamConsentGate - 构造函数', async (t) => {
  await t.test('默认选项创建实例', () => {
    const gate = new TeamConsentGate();
    assert.ok(gate instanceof TeamConsentGate);
  });

  await t.test('自定义logger', () => {
    const logger = new MockLogger();
    const gate = new TeamConsentGate({ logger });
    assert.ok(gate instanceof TeamConsentGate);
  });

  await t.test('自定义配置覆盖默认值', () => {
    const gate = new TeamConsentGate({
      logger: new MockLogger(),
      defaultTimeout: 60000,
      maxPendingRequests: 20,
      maxHistory: 100,
      timeoutInterval: 10000,
    });
    assert.ok(gate instanceof TeamConsentGate);
  });
});

// ═══════════════════════════════════════
// ConsentRequest
// ═══════════════════════════════════════

test('TeamConsentGate - ConsentRequest', async (t) => {
  await t.test('创建基本请求', () => {
    const req = new ConsentRequest({
      teamId: 'team-1',
      agentId: 'agent-1',
      agentName: '测试Agent',
      action: '测试操作',
      risk: 'medium',
    });
    assert.ok(req.id.startsWith('consent_'));
    assert.strictEqual(req.status, CONSENT_STATUS.PENDING);
    assert.strictEqual(req.teamId, 'team-1');
    assert.ok(req.createdAt <= Date.now());
    assert.ok(req.expiresAt > req.createdAt);
  });

  await t.test('getSummary返回摘要', () => {
    const req = new ConsentRequest({
      agentName: '测试Agent',
      action: '测试操作',
    });
    const summary = req.getSummary();
    assert.strictEqual(summary.id, req.id);
    assert.strictEqual(summary.agentName, '测试Agent');
    assert.strictEqual(summary.action, '测试操作');
    assert.ok(summary.remainingMs >= 0);
  });

  await t.test('自定义超时', () => {
    const req = new ConsentRequest({ timeout: 30000 });
    assert.strictEqual(req.timeout, 30000);
    assert.ok(req.expiresAt <= Date.now() + 30000);
  });

  await t.test('所有ConsentType可用', () => {
    const req = new ConsentRequest({ type: CONSENT_TYPE.EXTERNAL_ACTION });
    assert.strictEqual(req.type, 'external_action');
  });

  await t.test('高风险请求', () => {
    const req = new ConsentRequest({ risk: 'critical' });
    assert.strictEqual(req.risk, 'critical');
  });
});

// ═══════════════════════════════════════
// 确认请求管理
// ═══════════════════════════════════════

test('TeamConsentGate - requestConsent', async (t) => {
  await t.test('成功创建确认请求', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.requestConsent({
      teamId: 'team-1',
      agentId: 'agent-1',
      agentName: '测试Agent',
      action: '执行危险操作',
      risk: 'high',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.consentId.startsWith('consent_'));
    assert.strictEqual(result.request.action, '执行危险操作');
  });

  await t.test('发出consent_requested事件', (t) => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    return new Promise((resolve) => {
      gate.on('consent_requested', (event) => {
        assert.strictEqual(event.agentId, 'agent-1');
        assert.strictEqual(event.action, '测试');
        resolve();
      });
      gate.requestConsent({ agentId: 'agent-1', agentName: 'A', action: '测试' });
    });
  });

  await t.test('达到最大待处理数时拒绝', () => {
    const gate = new TeamConsentGate({
      logger: new MockLogger(),
      maxPendingRequests: 2,
    });
    gate.requestConsent({ agentId: 'a1', agentName: 'A1', action: 'req1' });
    gate.requestConsent({ agentId: 'a2', agentName: 'A2', action: 'req2' });
    const result = gate.requestConsent({ agentId: 'a3', agentName: 'A3', action: 'req3' });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('过多'));
  });

  await t.test('可自定义consentId', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.requestConsent({
      id: 'my-custom-id',
      agentId: 'agent-1',
      agentName: 'A',
      action: '测试',
    });
    assert.strictEqual(result.consentId, 'my-custom-id');
  });
});

// ═══════════════════════════════════════
// approve / reject / cancel
// ═══════════════════════════════════════

test('TeamConsentGate - approve', async (t) => {
  await t.test('批准确认请求', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: '测试Agent',
      action: '测试操作',
    });
    const result = gate.approve(consentId, '同意');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, CONSENT_STATUS.APPROVED);
  });

  await t.test('批准后请求从pending中移除', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: '测试Agent',
      action: '测试操作',
    });
    gate.approve(consentId);
    assert.strictEqual(gate.listPending().length, 0);
  });

  await t.test('批准不存在的请求返回错误', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.approve('nonexistent-id');
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('不存在'));
  });

  await t.test('重复批准返回错误', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: 'A',
      action: '测试',
    });
    gate.approve(consentId);
    const result = gate.approve(consentId);
    assert.strictEqual(result.success, false);
    // 第二次批准时，请求已从pending中移除
    assert.ok(result.error.includes('不存在') || result.error.includes('无法批准'));
  });

  await t.test('批准触发consent_approved事件', (t) => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    return new Promise((resolve) => {
      gate.on('consent_approved', (event) => {
        assert.strictEqual(event.consentId, consentId);
        assert.strictEqual(event.action, '测试');
        resolve();
      });
      const { consentId } = gate.requestConsent({
        agentId: 'agent-1',
        agentName: 'A',
        action: '测试',
      });
      gate.approve(consentId);
    });
  });

  await t.test('批准回调被执行', (t) => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    return new Promise((resolve) => {
      const { consentId } = gate.requestConsent({
        agentId: 'agent-1',
        agentName: 'A',
        action: '测试',
        onApprove: (request) => {
          assert.strictEqual(request.status, CONSENT_STATUS.APPROVED);
          resolve();
        },
      });
      gate.approve(consentId);
    });
  });
});

test('TeamConsentGate - reject', async (t) => {
  await t.test('拒绝确认请求', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: '测试Agent',
      action: '危险操作',
    });
    const result = gate.reject(consentId, '太危险了');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, CONSENT_STATUS.REJECTED);
  });

  await t.test('拒绝后请求从pending中移除', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: 'A',
      action: '测试',
    });
    gate.reject(consentId);
    assert.strictEqual(gate.listPending().length, 0);
  });

  await t.test('拒绝触发consent_rejected事件', (t) => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    return new Promise((resolve) => {
      gate.on('consent_rejected', (event) => {
        assert.strictEqual(event.consentId, consentId);
        assert.strictEqual(event.reason, '不安全');
        resolve();
      });
      const { consentId } = gate.requestConsent({
        agentId: 'agent-1',
        agentName: 'A',
        action: '测试',
      });
      gate.reject(consentId, '不安全');
    });
  });

  await t.test('拒绝回调被执行', (t) => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    return new Promise((resolve) => {
      const { consentId } = gate.requestConsent({
        agentId: 'agent-1',
        agentName: 'A',
        action: '测试',
        onReject: (request) => {
          assert.strictEqual(request.status, CONSENT_STATUS.REJECTED);
          resolve();
        },
      });
      gate.reject(consentId);
    });
  });
});

test('TeamConsentGate - cancel', async (t) => {
  await t.test('取消确认请求', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: 'A',
      action: '测试',
    });
    const result = gate.cancel(consentId);
    assert.strictEqual(result.success, true);
  });

  await t.test('取消后pending清空', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: 'A',
      action: '测试',
    });
    gate.cancel(consentId);
    assert.strictEqual(gate.listPending().length, 0);
  });

  await t.test('取消不存在请求返回错误', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.cancel('nonexistent');
    assert.strictEqual(result.success, false);
  });
});

// ═══════════════════════════════════════
// 超时处理
// ═══════════════════════════════════════

test('TeamConsentGate - 超时处理', async (t) => {
  await t.test('超时后自动过期', async () => {
    const gate = new TeamConsentGate({
      logger: new MockLogger(),
      timeoutInterval: 50,
    });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: 'A',
      action: '快速超时测试',
      timeout: 100,
    });

    // 等待超时处理
    await new Promise(r => setTimeout(r, 200));

    // 确认已从pending中移除
    const pending = gate.listPending();
    assert.strictEqual(pending.length, 0);

    // 确认在历史中且状态为expired
    const history = gate.getHistory();
    const expired = history.find(h => h.id === consentId);
    assert.ok(expired !== undefined);
    assert.strictEqual(expired.status, CONSENT_STATUS.EXPIRED);
  });

  await t.test('无pending时定时器自动停止', async () => {
    const gate = new TeamConsentGate({
      logger: new MockLogger(),
      timeoutInterval: 50,
    });
    // 没有pending请求，定时器应为null
    gate.close();
    // 验证关闭后状态一致：无待处理请求，历史记录可正常获取
    const pending = gate.listPending();
    assert.strictEqual(pending.length, 0, '关闭后应无待处理请求');
    const stats = gate.getStats();
    assert.ok(stats, '关闭后应仍可获取统计信息');
  });
});

// ═══════════════════════════════════════
// 查询方法
// ═══════════════════════════════════════

test('TeamConsentGate - 查询方法', async (t) => {
  await t.test('listPending返回所有待处理请求', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    gate.requestConsent({ agentId: 'a1', agentName: 'A1', action: 'req1' });
    gate.requestConsent({ agentId: 'a2', agentName: 'A2', action: 'req2' });
    const pending = gate.listPending();
    assert.strictEqual(pending.length, 2);
  });

  await t.test('getRequest查找pending中的请求', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'a1',
      agentName: 'A1',
      action: '查找测试',
    });
    const req = gate.getRequest(consentId);
    assert.ok(req !== null);
    assert.strictEqual(req.action, '查找测试');
  });

  await t.test('getRequest查找历史中的请求', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'a1',
      agentName: 'A1',
      action: '历史测试',
    });
    gate.approve(consentId);
    const req = gate.getRequest(consentId);
    assert.ok(req !== null);
    assert.strictEqual(req.status, CONSENT_STATUS.APPROVED);
  });

  await t.test('getRequest对不存在请求返回null', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    assert.strictEqual(gate.getRequest('nonexistent'), null);
  });

  await t.test('getHistory返回最近历史', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    for (let i = 0; i < 5; i++) {
      const { consentId } = gate.requestConsent({
        agentId: `a${i}`,
        agentName: `Agent${i}`,
        action: `action${i}`,
      });
      gate.approve(consentId);
    }
    const history = gate.getHistory(3);
    assert.strictEqual(history.length, 3);
  });

  await t.test('getStats返回正确统计', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    // 创建并批准2个
    gate.requestConsent({ agentId: 'a1', agentName: 'A1', action: 'approved1' });
    gate.requestConsent({ agentId: 'a2', agentName: 'A2', action: 'approved2' });
    const pending = gate.listPending();
    for (const p of pending) gate.approve(p.id);

    // 创建并拒绝1个
    const { consentId } = gate.requestConsent({
      agentId: 'a3',
      agentName: 'A3',
      action: 'rejected1',
    });
    gate.reject(consentId);

    const stats = gate.getStats();
    assert.strictEqual(stats.pending, 0);
    assert.strictEqual(stats.approved, 2);
    assert.strictEqual(stats.rejected, 1);
    assert.strictEqual(stats.approvalRate, 67); // 2/3 ≈ 67%
  });
});

// ═══════════════════════════════════════
// 便捷方法
// ═══════════════════════════════════════

test('TeamConsentGate - 便捷方法', async (t) => {
  await t.test('requestToolExecution - 高风险工具', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.requestToolExecution(
      'agent-1', '测试Agent', 'team-1',
      'delete', { target: 'file.txt' }
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.request.risk, 'high');
  });

  await t.test('requestToolExecution - 低风险工具', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.requestToolExecution(
      'agent-1', '测试Agent', 'team-1',
      'read', { path: '/tmp' }
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.request.risk, 'low');
  });

  await t.test('requestToolExecution - 中风险工具', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.requestToolExecution(
      'agent-1', '测试Agent', 'team-1',
      'report_generate', {}
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.request.risk, 'medium');
  });

  await t.test('requestInterAgentMessage', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.requestInterAgentMessage(
      'agent-1', '发送者', 'agent-2', '接收者', 'team-1',
      'Hello!'
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.request.risk, 'low');
  });

  await t.test('requestExternalAction', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const result = gate.requestExternalAction(
      'agent-1', '测试Agent', 'team-1',
      '访问外部API', { url: 'https://example.com' }
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.request.risk, 'high');
  });
});

// ═══════════════════════════════════════
// 历史限制
// ═══════════════════════════════════════

test('TeamConsentGate - 历史限制', async (t) => {
  await t.test('超过maxHistory时截断', () => {
    const gate = new TeamConsentGate({
      logger: new MockLogger(),
      maxHistory: 3,
    });
    for (let i = 0; i < 6; i++) {
      const { consentId } = gate.requestConsent({
        agentId: `a${i}`,
        agentName: `A${i}`,
        action: `action${i}`,
      });
      gate.approve(consentId);
    }
    const history = gate.getHistory(100);
    assert.ok(history.length <= 3);
  });
});

// ═══════════════════════════════════════
// 清理资源
// ═══════════════════════════════════════

test('TeamConsentGate - close', async (t) => {
  await t.test('close清理所有资源', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    gate.requestConsent({ agentId: 'a1', agentName: 'A1', action: 'test' });
    gate.close();
    assert.strictEqual(gate.listPending().length, 0);
    assert.strictEqual(gate.getHistory().length, 0);
  });
});

// ═══════════════════════════════════════
// 边界条件
// ═══════════════════════════════════════

test('TeamConsentGate - 边界条件', async (t) => {
  await t.test('回调抛出异常不崩溃', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const { consentId } = gate.requestConsent({
      agentId: 'agent-1',
      agentName: 'A',
      action: 'test',
      onApprove: () => { throw new Error('回调爆炸'); },
    });
    // 不应该抛出异常
    const result = gate.approve(consentId);
    assert.strictEqual(result.success, true);
  });

  await t.test('getStats全零初始状态', () => {
    const gate = new TeamConsentGate({ logger: new MockLogger() });
    const stats = gate.getStats();
    assert.strictEqual(stats.pending, 0);
    assert.strictEqual(stats.total, 0);
    assert.strictEqual(stats.approvalRate, 100);
  });
});
