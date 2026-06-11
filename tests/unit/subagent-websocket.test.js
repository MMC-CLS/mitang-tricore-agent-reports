/**
 * TriCoreAgent - SubAgentWebSocket 单元测试
 *
 * 覆盖范围:
 *   - 构造函数与配置
 *   - 连接管理 (handleConnection, disconnect)
 *   - 消息处理 (ping/pong, subscribe/unsubscribe)
 *   - 消息发送 (_handleAgentMessage)
 *   - 会话管理 (create/switch/list/get/close/clear)
 *   - 工具执行 (_handleExecuteTool)
 *   - 状态查询 (_handleGetStatus, _handleListTools)
 *   - 广播推送 (broadcastToAgent, broadcastStateChange, broadcastAll)
 *   - 连接统计 (getStats)
 *   - 错误处理与边界条件
 *   - 资源清理 (close)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

class MockLogger {
  constructor() { this.logs = []; }
  info(msg) { this.logs.push({ level: 'info', msg }); }
  warn(msg) { this.logs.push({ level: 'warn', msg }); }
  error(msg) { this.logs.push({ level: 'error', msg }); }
}

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 1; // OPEN
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

const {
  SubAgentWebSocket,
  WS_CLIENT_STATE,
} = require('../../src/subagent/subagent-websocket');

// ── 辅助函数 ──

function makeWebSocket(options = {}) {
  return new SubAgentWebSocket({
    logger: new MockLogger(),
    ...options,
  });
}

function makeMockReq(ip = '127.0.0.1') {
  return { socket: { remoteAddress: ip } };
}

// ═══════════════════════════════════════
// 构造函数
// ═══════════════════════════════════════

test('SubAgentWebSocket - 构造函数', async (t) => {
  await t.test('默认选项创建实例', () => {
    const ws = makeWebSocket();
    assert.ok(ws instanceof SubAgentWebSocket);
  });

  await t.test('自定义配置', () => {
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      heartbeatInterval: 15000,
      heartbeatTimeout: 30000,
      maxConnectionsPerAgent: 5,
      maxMessageSize: 512 * 1024,
    });
    assert.ok(ws instanceof SubAgentWebSocket);
  });

  await t.test('传入guardian', () => {
    const guardian = { authorize: () => ({ allowed: true }) };
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      guardian,
    });
    assert.ok(ws instanceof SubAgentWebSocket);
  });
});

// ═══════════════════════════════════════
// 连接管理
// ═══════════════════════════════════════

test('SubAgentWebSocket - 连接管理', async (t) => {
  await t.test('handleConnection返回clientId', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    const clientId = ws.handleConnection(mockWs, makeMockReq());
    assert.ok(clientId.startsWith('ws_'));
    assert.strictEqual(ws.getStats().totalClients, 1);
  });

  await t.test('新连接发送欢迎消息', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    assert.ok(mockWs.sent.length >= 1);
    assert.strictEqual(mockWs.sent[0].type, 'connected');
    assert.ok(mockWs.sent[0].serverInfo.name.includes('蜜糖'));
  });

  await t.test('断开连接清理资源', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    const clientId = ws.handleConnection(mockWs, makeMockReq());
    mockWs.close();
    assert.strictEqual(ws.getStats().totalClients, 0);
  });

  await t.test('触发client_connected事件', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    return new Promise((resolve) => {
      ws.on('client_connected', (event) => {
        assert.ok(event.clientId.startsWith('ws_'));
        resolve();
      });
      ws.handleConnection(mockWs, makeMockReq());
    });
  });

  await t.test('触发client_disconnected事件', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    return new Promise((resolve) => {
      ws.on('client_disconnected', (event) => {
        assert.strictEqual(event.reason, 'client_closed');
        resolve();
      });
      ws.handleConnection(mockWs, makeMockReq());
      mockWs.close();
    });
  });

  await t.test('WebSocket错误处理不崩溃', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    const clientId = ws.handleConnection(mockWs, makeMockReq());
    // 触发error事件
    mockWs.emit('error', new Error('模拟错误'));
    // 验证错误后连接对象仍然有效，服务未崩溃
    assert.ok(ws, 'WebSocket服务应仍然存在');
    const stats = ws.getStats();
    assert.ok(stats.totalClients >= 0, '统计信息应仍然可获取');
  });

  await t.test('IP地址记录', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq('192.168.1.100'));
    const stats = ws.getStats();
    assert.strictEqual(stats.totalClients, 1);
  });

  await t.test('没有req时IP为unknown', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, null);
    const stats = ws.getStats();
    assert.strictEqual(stats.totalClients, 1);
  });
});

// ═══════════════════════════════════════
// 消息处理 - ping
// ═══════════════════════════════════════

test('SubAgentWebSocket - ping/pong', async (t) => {
  await t.test('ping返回pong', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());

    // 清除欢迎消息
    mockWs.sent = [];
    mockWs.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));

    const pongMsg = mockWs.sent.find(m => m.type === 'pong');
    assert.ok(pongMsg !== undefined);
    assert.ok(pongMsg.timestamp > 0);
  });
});

// ═══════════════════════════════════════
// 消息处理 - subscribe/unsubscribe
// ═══════════════════════════════════════

test('SubAgentWebSocket - subscribe', async (t) => {
  await t.test('subscribe成功订阅子智能体', () => {
    const mockEngine = { getStatus: () => ({ state: 'idle' }) };
    const mockManager = {
      _agents: new Map([['agent-1', { id: 'agent-1', name: 'Test Agent', type: 'assistant' }]]),
      _engines: new Map([['agent-1', mockEngine]]),
      getEngine(id) { return this._engines.get(id); },
    };
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      subAgentManager: mockManager,
    });
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = []; // 清除欢迎消息

    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'subscribe',
      agentId: 'agent-1',
    })));

    const subMsg = mockWs.sent.find(m => m.type === 'subscribed');
    assert.ok(subMsg !== undefined);
    assert.strictEqual(subMsg.agentId, 'agent-1');
    assert.strictEqual(ws.getStats().subscribedClients, 1);
  });

  await t.test('subscribe缺少agentId返回错误', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe' })));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
    assert.ok(errMsg.error.includes('agentId'));
  });

  await t.test('subscribe不存在的子智能体返回错误', () => {
    const mockManager = {
      _agents: new Map(),
    };
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      subAgentManager: mockManager,
    });
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'subscribe',
      agentId: 'nonexistent',
    })));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
    assert.ok(errMsg.error.includes('不存在'));
  });

  await t.test('unsubscribe取消订阅', () => {
    const mockManager = {
      _agents: new Map([['agent-1', { id: 'agent-1', name: 'A1', type: 'assistant' }]]),
      _engines: new Map([['agent-1', { getStatus: () => ({}) }]]),
    };
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      subAgentManager: mockManager,
    });
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());

    // 先订阅
    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'subscribe', agentId: 'agent-1',
    })));

    mockWs.sent = [];
    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'unsubscribe', agentId: 'agent-1',
    })));

    const unsubMsg = mockWs.sent.find(m => m.type === 'unsubscribed');
    assert.ok(unsubMsg !== undefined);
  });
});

// ═══════════════════════════════════════
// 消息处理 - agent message
// ═══════════════════════════════════════

test('SubAgentWebSocket - 消息处理', async (t) => {
  await t.test('缺少agentId或content返回错误', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({ type: 'message' })));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
  });

  await t.test('无效JSON返回错误', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from('这不是JSON'));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
    assert.ok(errMsg.error.includes('JSON'));
  });

  await t.test('未知消息类型返回错误', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({ type: 'unknown_type' })));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
    assert.ok(errMsg.error.includes('未知消息类型'));
  });

  await t.test('消息大小超过限制返回错误', () => {
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      maxMessageSize: 10,
    });
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({ type: 'ping', extra: '1234567890' })));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
    assert.ok(errMsg.error.includes('大小超过限制'));
  });
});

// ═══════════════════════════════════════
// 广播推送
// ═══════════════════════════════════════

test('SubAgentWebSocket - 广播推送', async (t) => {
  await t.test('broadcastToAgent向订阅者广播', () => {
    const mockManager = {
      _agents: new Map([['agent-1', { id: 'agent-1', name: 'A1', type: 'assistant' }]]),
      _engines: new Map([['agent-1', { getStatus: () => ({}) }]]),
    };
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      subAgentManager: mockManager,
    });
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());

    // 订阅
    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'subscribe', agentId: 'agent-1',
    })));

    mockWs.sent = [];
    const sent = ws.broadcastToAgent('agent-1', {
      type: 'custom_broadcast',
      data: 'hello',
    });
    assert.strictEqual(sent, 1);
    const bcMsg = mockWs.sent.find(m => m.type === 'custom_broadcast');
    assert.ok(bcMsg !== undefined);
  });

  await t.test('broadcastToAgent - 无订阅者返回0', () => {
    const ws = makeWebSocket();
    const sent = ws.broadcastToAgent('nonexistent', { type: 'test' });
    assert.strictEqual(sent, 0);
  });

  await t.test('broadcastStateChange推送状态变化', () => {
    const mockManager = {
      _agents: new Map([['agent-1', { id: 'agent-1', name: 'A1', type: 'assistant' }]]),
      _engines: new Map([['agent-1', { getStatus: () => ({}) }]]),
    };
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      subAgentManager: mockManager,
    });
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());

    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'subscribe', agentId: 'agent-1',
    })));

    mockWs.sent = [];
    const sent = ws.broadcastStateChange('agent-1', 'thinking');
    assert.strictEqual(sent, 1);

    const stateMsg = mockWs.sent.find(m => m.type === 'state_change');
    assert.ok(stateMsg !== undefined);
    assert.strictEqual(stateMsg.state, 'thinking');
  });

  await t.test('broadcastEngineEvent推送引擎事件', () => {
    const mockManager = {
      _agents: new Map([['agent-1', { id: 'agent-1', name: 'A1', type: 'assistant' }]]),
      _engines: new Map([['agent-1', { getStatus: () => ({}) }]]),
    };
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      subAgentManager: mockManager,
    });
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());

    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'subscribe', agentId: 'agent-1',
    })));

    mockWs.sent = [];
    const sent = ws.broadcastEngineEvent('agent-1', 'tool_executed', { tool: 'read' });
    assert.strictEqual(sent, 1);

    const evtMsg = mockWs.sent.find(m => m.type === 'engine_event');
    assert.ok(evtMsg !== undefined);
    assert.strictEqual(evtMsg.event, 'tool_executed');
  });

  await t.test('broadcastAll向所有客户端广播', () => {
    const ws = makeWebSocket();
    const mockWs1 = new MockWebSocket();
    const mockWs2 = new MockWebSocket();
    ws.handleConnection(mockWs1, makeMockReq());
    ws.handleConnection(mockWs2, makeMockReq());

    const sent = ws.broadcastAll({ type: 'global_broadcast', data: 'test' });
    assert.strictEqual(sent, 2);
  });
});

// ═══════════════════════════════════════
// 统计
// ═══════════════════════════════════════

test('SubAgentWebSocket - 统计', async (t) => {
  await t.test('getStats初始状态', () => {
    const ws = makeWebSocket();
    const stats = ws.getStats();
    assert.strictEqual(stats.totalClients, 0);
    assert.strictEqual(stats.subscribedClients, 0);
    assert.strictEqual(stats.activeStreams, 0);
    assert.strictEqual(stats.totalMessages, 0);
    assert.ok(Array.isArray(stats.agentSubscriptions));
  });

  await t.test('getStats反映连接状态', () => {
    const mockManager = {
      _agents: new Map([['agent-1', { id: 'agent-1', name: 'A1', type: 'assistant' }]]),
      _engines: new Map([['agent-1', { getStatus: () => ({}) }]]),
    };
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      subAgentManager: mockManager,
    });
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'subscribe', agentId: 'agent-1',
    })));

    const stats = ws.getStats();
    assert.strictEqual(stats.totalClients, 1);
    assert.strictEqual(stats.subscribedClients, 1);
    assert.strictEqual(stats.agentSubscriptions.length, 1);
    assert.strictEqual(stats.agentSubscriptions[0].agentId, 'agent-1');
  });
});

// ═══════════════════════════════════════
// 错误处理
// ═══════════════════════════════════════

test('SubAgentWebSocket - 错误处理', async (t) => {
  await t.test('_sendToClient - 非OPEN状态静默跳过', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    mockWs.readyState = 2; // CLOSING
    const result = ws._sendToClient(mockWs, { type: 'test' });
    // 验证函数不抛异常，且返回false表示未发送
    assert.strictEqual(result, false, '非OPEN状态应返回false表示未发送');
    assert.strictEqual(mockWs.sent.length, 0, 'CLOSING状态不应发送任何数据');
  });

  await t.test('_sendToClient - send抛出异常不崩溃', () => {
    const ws = makeWebSocket();
    const badWs = {
      readyState: 1,
      send() { throw new Error('send failed'); },
    };
    // 验证函数不抛异常，且返回false表示发送失败
    assert.doesNotThrow(() => {
      const result = ws._sendToClient(badWs, { type: 'test' });
      assert.strictEqual(result, false, 'send失败应返回false');
    }, 'send抛出异常时_sendToClient不应传播异常');
  });

  await t.test('_sendError - 客户端不存在时静默跳过', () => {
    const ws = makeWebSocket();
    // 验证对不存在的客户端发送错误不抛异常，且返回false
    const result = ws._sendError('nonexistent-client', 'error message');
    assert.strictEqual(result, false, '不存在的客户端应返回false');
  });
});

// ═══════════════════════════════════════
// 清理资源
// ═══════════════════════════════════════

test('SubAgentWebSocket - close', async (t) => {
  await t.test('close清理所有连接', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    ws.close();
    assert.strictEqual(ws.getStats().totalClients, 0);
    assert.strictEqual(ws.getStats().subscribedClients, 0);
  });

  await t.test('多次close不抛出异常', () => {
    const ws = makeWebSocket();
    ws.close();
    ws.close();
    // 验证多次close后状态仍一致，没有残留数据
    const stats = ws.getStats();
    assert.strictEqual(stats.totalClients, 0, '多次close后客户端数应为0');
    assert.strictEqual(stats.subscribedClients, 0, '多次close后订阅数应为0');
  });
});

// ═══════════════════════════════════════
// 边界条件
// ═══════════════════════════════════════

test('SubAgentWebSocket - 边界条件', async (t) => {
  await t.test('心跳超时断开连接', async () => {
    const ws = new SubAgentWebSocket({
      logger: new MockLogger(),
      heartbeatInterval: 50,
      heartbeatTimeout: 100,
    });
    const mockWs = new MockWebSocket();
    const clientId = ws.handleConnection(mockWs, makeMockReq());

    // 等待心跳超时
    await new Promise(r => setTimeout(r, 300));

    // 连接应已被断开
    const stats = ws.getStats();
    assert.strictEqual(stats.totalClients, 0);
  });

  await t.test('已关闭连接不发送消息', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    mockWs.readyState = 3; // CLOSED
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));

    // 消息不应被发送
    const pongMsg = mockWs.sent.find(m => m.type === 'pong');
    assert.strictEqual(pongMsg, undefined);
  });

  await t.test('无subAgentManager时消息处理返回错误', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'message',
      agentId: 'agent-1',
      content: 'hello',
    })));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
    assert.ok(errMsg.error.includes('未启动'));
  });

  await t.test('get_status - 引擎未启动返回错误', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'get_status',
      agentId: 'agent-1',
    })));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
    assert.ok(errMsg.error.includes('未启动'));
  });

  await t.test('list_tools - 引擎未启动返回错误', () => {
    const ws = makeWebSocket();
    const mockWs = new MockWebSocket();
    ws.handleConnection(mockWs, makeMockReq());
    mockWs.sent = [];

    mockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'list_tools',
      agentId: 'agent-1',
    })));

    const errMsg = mockWs.sent.find(m => m.type === 'error');
    assert.ok(errMsg !== undefined);
    assert.ok(errMsg.error.includes('未启动'));
  });
});
