/**
 * 蜜糖 TriCore Agent v2.7 - 子智能体独立对话功能验证脚本
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const testDir = path.join(os.tmpdir(), `mitang_sa_chat_test_${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label} (expected ${expected}, got ${actual})`); }
}

console.log('\n╔══════════════════════════════════════════╗');
console.log('║  蜜糖 TriCore Agent v2.7 集成验证      ║');
console.log('║  子智能体独立对话功能                  ║');
console.log('╚══════════════════════════════════════════╝\n');

// ── 1. SubAgentEngine 测试 ──
console.log('[1] SubAgentEngine - 独立对话引擎');
{
  const { SubAgentEngine, ENGINE_STATE, SESSION_STATUS } = require('../src/subagent/subagent-engine');

  const engine = new SubAgentEngine({
    agentId: 'sa_test_001',
    agentName: '测试助手',
    agentType: 'assistant',
    dataDir: path.join(testDir, 'engine1'),
  });

  assert(engine !== null, '引擎创建成功');
  assertEqual(engine._state, ENGINE_STATE.IDLE, '初始状态为 IDLE');

  // 启动引擎
  engine.start().then(async () => {
    assert(engine._startedAt !== null, '引擎启动成功');

    // 创建会话
    const sessionResult = engine.createSession({ name: '测试会话' });
    assert(sessionResult.success, '会话创建成功');
    assert(sessionResult.sessionId !== null, '会话ID已生成');

    // 会话列表 (包含自动创建的默认会话)
    const sessions = engine.listSessions();
    assert(sessions.length >= 1, '会话列表至少包含1个会话');

    // 发送消息到新创建的测试会话
    const msgResult = await engine.sendMessage('你好，请介绍一下你自己', sessionResult.sessionId);
    assert(msgResult.success, '消息发送成功');
    assert(msgResult.messageId !== null, '消息ID已生成');

    // 等待处理完成
    await new Promise(r => setTimeout(r, 500));

    // 检查消息历史
    const session = engine.getSession(sessionResult.sessionId);
    assert(session !== null, '会话详情可获取');
    assert(session.messages.length >= 2, `会话包含消息 (实际: ${session.messages.length})`);
    assert(session.messages.some(m => m.role === 'user'), '包含用户消息');
    assert(session.messages.some(m => m.role === 'assistant'), '包含助手回复');

    // 多会话支持
    const currentCount = engine.listSessions().length;
    const session2Result = engine.createSession({ name: '第二会话' });
    assert(session2Result.success, '第二会话创建成功');
    const sessions2 = engine.listSessions();
    assertEqual(sessions2.length, currentCount + 1, '会话列表增加1个');

    // 切换会话
    const switchResult = engine.switchSession(session2Result.sessionId);
    assert(switchResult.success, '会话切换成功');

    // 在第二会话中发消息
    await engine.sendMessage('第二条会话的消息');
    const session2 = engine.getSession(session2Result.sessionId);
    assert(session2.messages.length >= 1, '第二会话包含消息');

    // 关闭会话
    const closeResult = engine.closeSession(session2Result.sessionId);
    assert(closeResult.success, '会话关闭成功');

    // 清空会话
    const clearResult = engine.clearSession(sessionResult.sessionId);
    assert(clearResult.success, '会话清空成功');

    // 获取状态
    const status = engine.getStatus();
    assertEqual(status.agentName, '测试助手', '引擎状态包含名称');
    assert(status.stats.messagesProcessed >= 2, '消息处理计数正确');

    // 工具列表
    const tools = engine.listTools();
    assert(Array.isArray(tools), '工具列表为数组');
    assert(tools.length > 0, '工具列表非空');

    // 工具执行
    const toolResult = await engine.executeTool('knowledge_search', { query: 'test' });
    assert(toolResult.success, '工具执行成功');

    // 停止引擎
    await engine.stop();
    assert(engine._startedAt === null, '引擎停止成功');
  }).then(() => {
    console.log('  [SubAgentEngine] 全部测试完成\n');
  });
}

// ── 2. SubAgentWebSocket 测试 ──
console.log('[2] SubAgentWebSocket - 实时通信通道');
{
  const { SubAgentWebSocket } = require('../src/subagent/subagent-websocket');

  const ws = new SubAgentWebSocket({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  assert(ws !== null, 'WebSocket通道创建成功');

  const stats = ws.getStats();
  assertEqual(stats.totalClients, 0, '初始连接数为0');
  assertEqual(stats.activeStreams, 0, '初始活跃流为0');
  assertEqual(stats.totalMessages, 0, '初始消息数为0');

  // 模拟客户端连接
  const mockWs = {
    readyState: 1,
    on: () => {},
    send: (data) => {
      const parsed = JSON.parse(data);
      if (parsed.type === 'connected') {
        assert(parsed.clientId !== null, '连接消息包含clientId');
        assertEqual(parsed.serverInfo.name, '蜜糖 TriCore Agent - 子智能体通信通道', '服务器信息正确');
      }
    },
    close: () => {},
  };
  const clientId = ws.handleConnection(mockWs, { socket: { remoteAddress: '127.0.0.1' } });
  assert(clientId !== null, '客户端连接成功');

  const stats2 = ws.getStats();
  assertEqual(stats2.totalClients, 1, '连接后客户端数为1');

  ws.close();
  console.log('  [SubAgentWebSocket] 全部测试完成\n');
}

// ── 3. SubAgentManager + Engine 集成测试 ──
console.log('[3] SubAgentManager + Engine 集成');
{
  const { SubAgentManager } = require('../src/subagent/subagent-manager');
  const mgrDir = path.join(testDir, 'mgr_integration');

  const manager = new SubAgentManager({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    dataDir: mgrDir,
    maxSubAgents: 10,
  });

  // 创建子智能体
  const createResult = manager.create({
    name: '集成测试智能体',
    type: 'assistant',
    description: '用于集成测试',
    safetyLevel: 'medium',
    quota: 'medium',
  });
  assert(createResult.success, '子智能体创建成功');
  const agentId = createResult.agentId;

  // 初始化引擎
  manager.initEngine(agentId, {
    parentAgent: {},
  }).then(async (initResult) => {
    assert(initResult.success, '引擎初始化成功');

    // 验证引擎存在
    const engine = manager.getEngine(agentId);
    assert(engine !== null, '引擎可获取');

    // 发送消息
    const msgResult = await manager.sendMessageToAgent(agentId, '测试消息');
    assert(msgResult.success, '通过Manager发送消息成功');

    // 会话列表
    const sessions = manager.listAgentSessions(agentId);
    assert(Array.isArray(sessions), '会话列表为数组');
    assert(sessions.length >= 1, '至少有一个会话');

    // 创建会话
    const sessResult = manager.createAgentSession(agentId, { name: '新建会话' });
    assert(sessResult.success, '新建会话成功');

    // 获取会话详情
    const session = manager.getAgentSession(agentId, sessResult.sessionId);
    assert(session !== null, '会话详情可获取');

    // 切换会话
    const switchResult = manager.switchAgentSession(agentId, sessResult.sessionId);
    assert(switchResult.success, '会话切换成功');

    // 关闭会话
    const closeResult = manager.closeAgentSession(agentId, sessResult.sessionId);
    assert(closeResult.success, '会话关闭成功');

    // 清空会话
    const firstSessions = manager.listAgentSessions(agentId);
    if (firstSessions.length > 0) {
      const clearResult = manager.clearAgentSession(agentId, firstSessions[0].id);
      assert(clearResult.success, '会话清空成功');
    }

    // 工具列表
    const tools = manager.listAgentTools(agentId);
    assert(Array.isArray(tools), '工具列表为数组');
    assert(tools.length > 0, '工具列表非空');

    // 工具执行
    const toolResult = await manager.executeAgentTool(agentId, 'knowledge_search', { query: 'test' });
    assert(toolResult.success, '通过Manager执行工具成功');

    // 引擎状态
    const engStatus = manager.getAgentEngineStatus(agentId);
    assert(engStatus !== null, '引擎状态可获取');
    assertEqual(engStatus.agentName, '集成测试智能体', '引擎状态包含名称');

    // 销毁引擎
    await manager.destroyEngine(agentId);
    const engineAfter = manager.getEngine(agentId);
    assert(engineAfter === null, '引擎已销毁');

    // 销毁子智能体
    const destroyResult = manager.destroy(agentId);
    assert(destroyResult.success, '子智能体销毁成功');

    manager.close();
    console.log('  [Manager+Engine集成] 全部测试完成\n');
  });
}

// ── 4. 推理模式测试 ──
console.log('[4] 推理模式测试');
{
  const { SubAgentEngine, REASONING_MODE } = require('../src/subagent/subagent-engine');

  const modes = [
    { type: 'assistant', mode: REASONING_MODE.DIRECT, label: 'Assistant→DIRECT' },
    { type: 'analyst', mode: REASONING_MODE.ANALYTICAL, label: 'Analyst→ANALYTICAL' },
    { type: 'executor', mode: REASONING_MODE.PLANNING, label: 'Executor→PLANNING' },
    { type: 'monitor', mode: REASONING_MODE.REFLECTIVE, label: 'Monitor→REFLECTIVE' },
  ];

  for (const { type, mode, label } of modes) {
    const engine = new SubAgentEngine({
      agentId: `sa_${type}`,
      agentName: `${type}测试`,
      agentType: type,
      dataDir: path.join(testDir, `engine_${type}`),
    });

    assertEqual(engine._capabilities.reasoning, mode, label);

    // 测试内置推理
    const result = engine._builtinReason(
      { messages: [{ role: 'user', content: '测试问题' }], agentId: engine._agentId },
      mode
    );
    assert(result !== null, `${type} 内置推理有结果`);
    assert(typeof result.content === 'string', `${type} 推理结果包含content`);

    engine.close().catch(() => {});
  }

  console.log('  [推理模式] 全部测试完成\n');
}

// ── 5. 消息持久化测试 ──
console.log('[5] 消息持久化测试');
{
  const { SubAgentEngine } = require('../src/subagent/subagent-engine');
  const persistDir = path.join(testDir, 'persist_test');

  const engine = new SubAgentEngine({
    agentId: 'sa_persist',
    agentName: '持久化测试',
    agentType: 'assistant',
    dataDir: persistDir,
    persistEnabled: true,
  });

  engine.start().then(async () => {
    engine.createSession({ name: '持久化会话' });
    await engine.sendMessage('持久化测试消息');

    // 验证文件已创建
    const files = fs.readdirSync(persistDir);
    const sessionFiles = files.filter(f => f.startsWith('session_') && f.endsWith('.json'));
    assert(sessionFiles.length >= 1, '会话文件已持久化');

    // 关闭引擎
    await engine.close();

    // 创建新引擎并恢复
    const engine2 = new SubAgentEngine({
      agentId: 'sa_persist',
      agentName: '持久化测试',
      agentType: 'assistant',
      dataDir: persistDir,
      persistEnabled: true,
    });

    await engine2.start();
    const sessions = engine2.listSessions();
    assert(sessions.length >= 1, '会话已恢复');

    await engine2.close();
    console.log('  [持久化] 全部测试完成\n');
  });
}

// ── 结果汇总 ──
setTimeout(() => {
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  验证完成: ${passed} 通过, ${failed} 失败       ║`);
  console.log('╚══════════════════════════════════════════╝');

  // 清理
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}

  if (failed > 0) process.exit(1);
  else process.exit(0);
}, 3000);
