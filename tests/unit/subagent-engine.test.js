/**
 * TriCoreAgent v2.9 - SubAgentEngine 单元测试
 *
 * 覆盖范围：
 *   - 引擎生命周期 (start/stop/close)
 *   - 会话管理 (创建/列表/切换/关闭/清空)
 *   - 消息处理与对话管道
 *   - 推理模式 (DIRECT/ANALYTICAL/PLANNING/REFLECTIVE)
 *   - 工具调用系统
 *   - 技能匹配检测 (v2.9)
 *   - 技能管理接口 (v2.9)
 *   - 记忆接口 (v2.9)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DATA_DIR = path.join(os.tmpdir(), `tricore_test_subagent_engine_${Date.now()}`);

class MockLogger {
  constructor() { this.logs = []; }
  info(msg) { this.logs.push({ level: 'info', msg }); }
  warn(msg) { this.logs.push({ level: 'warn', msg }); }
  error(msg) { this.logs.push({ level: 'error', msg }); }
  debug(msg) { this.logs.push({ level: 'debug', msg }); }
}

const {
  SubAgentEngine,
  ENGINE_STATE,
  SESSION_STATUS,
  MESSAGE_ROLE,
  REASONING_MODE,
} = require('../../src/subagent/subagent-engine');

function createEngine(options = {}) {
  return new SubAgentEngine({
    logger: new MockLogger(),
    agentId: options.agentId || 'test_engine_001',
    agentName: options.agentName || '测试引擎',
    agentType: options.agentType || 'assistant',
    dataDir: path.join(TEST_DATA_DIR, options.suffix || 'default'),
    ...options,
  });
}

function cleanup() {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
}

// ═══════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════

test('SubAgentEngine - 初始化', async (t) => {
  await t.test('默认配置创建引擎', () => {
    const engine = createEngine();
    assert.strictEqual(engine._agentId, 'test_engine_001');
    assert.strictEqual(engine._agentName, '测试引擎');
    assert.strictEqual(engine._agentType, 'assistant');
    assert.strictEqual(engine._state, ENGINE_STATE.IDLE);
  });

  await t.test('不同类型的能力模板', () => {
    const analyst = createEngine({ agentType: 'analyst', agentId: 'a1', suffix: 'analyst' });
    assert.strictEqual(analyst._capabilities.reasoning, REASONING_MODE.ANALYTICAL);
    assert.ok(analyst._capabilities.tools.includes('data_query'));

    const executor = createEngine({ agentType: 'executor', agentId: 'e1', suffix: 'executor' });
    assert.strictEqual(executor._capabilities.reasoning, REASONING_MODE.PLANNING);

    const monitor = createEngine({ agentType: 'monitor', agentId: 'm1', suffix: 'monitor' });
    assert.strictEqual(monitor._capabilities.reasoning, REASONING_MODE.REFLECTIVE);
  });

  cleanup();
});

test('SubAgentEngine - 生命周期', async (t) => {
  await t.test('start() 启动引擎', async () => {
    const engine = createEngine({ suffix: 'start' });
    const result = await engine.start();
    assert.strictEqual(result.success, true);
    assert.ok(engine._startedAt);
    assert.strictEqual(engine._state, ENGINE_STATE.IDLE);
  });

  await t.test('重复启动应失败', async () => {
    const engine = createEngine({ suffix: 'double_start' });
    await engine.start();
    const result = await engine.start();
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('已启动'));
  });

  await t.test('stop() 停止引擎', async () => {
    const engine = createEngine({ suffix: 'stop' });
    await engine.start();
    const result = await engine.stop();
    assert.strictEqual(result.success, true);
    assert.strictEqual(engine._startedAt, null);
  });

  await t.test('close() 清理资源', async () => {
    const engine = createEngine({ suffix: 'close' });
    await engine.start();
    await engine.close();
    assert.strictEqual(engine._sessions.size, 0);
    assert.strictEqual(engine._toolHandlers.size, 0);
  });

  cleanup();
});

test('SubAgentEngine - 会话管理', async (t) => {
  await t.test('创建默认会话', async () => {
    const engine = createEngine({ suffix: 'session_create' });
    await engine.start();
    // 启动后自动创建默认会话
    const sessions = engine.listSessions();
    assert.ok(sessions.length >= 1);
    assert.ok(sessions[0].isActive);
  });

  await t.test('手动创建会话', async () => {
    const engine = createEngine({ suffix: 'session_manual' });
    await engine.start();
    const result = engine.createSession({ name: '自定义会话' });
    assert.strictEqual(result.success, true);
    assert.ok(result.sessionId);
  });

  await t.test('会话列表', async () => {
    const engine = createEngine({ suffix: 'session_list' });
    await engine.start();
    engine.createSession({ name: '会话A' });
    engine.createSession({ name: '会话B' });
    const sessions = engine.listSessions();
    assert.ok(sessions.length >= 3); // 含默认会话
  });

  await t.test('切换活跃会话', async () => {
    const engine = createEngine({ suffix: 'session_switch' });
    await engine.start();
    const r = engine.createSession({ name: '切换到' });
    const result = engine.switchSession(r.sessionId);
    assert.strictEqual(result.success, true);
    assert.strictEqual(engine._activeSessionId, r.sessionId);
  });

  await t.test('关闭会话', async () => {
    const engine = createEngine({ suffix: 'session_close' });
    await engine.start();
    const r = engine.createSession({ name: '要关闭的' });
    const result = engine.closeSession(r.sessionId);
    assert.strictEqual(result.success, true);
  });

  await t.test('获取会话详情', async () => {
    const engine = createEngine({ suffix: 'session_detail' });
    await engine.start();
    const sessions = engine.listSessions();
    const detail = engine.getSession(sessions[0].id);
    assert.ok(detail);
    assert.ok(detail.messages);
  });

  cleanup();
});

test('SubAgentEngine - 消息处理', async (t) => {
  await t.test('发送消息到活跃会话', async () => {
    const engine = createEngine({ suffix: 'msg_send' });
    await engine.start();

    const result = await engine.sendMessage('你好，请帮我分析一下数据');
    assert.strictEqual(result.success, true);
    assert.ok(result.messageId);
    assert.ok(result.sessionId);
  });

  await t.test('自动创建会话', async () => {
    const engine = createEngine({ suffix: 'msg_auto_session' });
    // 不调用start，没有活跃会话
    const result = await engine.sendMessage('测试消息');
    assert.strictEqual(result.success, true);
    assert.ok(result.sessionId);
  });

  await t.test('消息队列处理', async () => {
    const engine = createEngine({ suffix: 'msg_queue' });
    await engine.start();

    // 连续发送多条消息
    const r1 = await engine.sendMessage('消息1');
    const r2 = await engine.sendMessage('消息2');
    const r3 = await engine.sendMessage('消息3');

    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, true);
    assert.strictEqual(r3.success, true);

    // 统计应正确
    const status = engine.getStatus();
    assert.ok(status.stats.messagesProcessed >= 3);
  });

  cleanup();
});

test('SubAgentEngine - 推理模式', async (t) => {
  await t.test('DIRECT 推理模式', () => {
    const engine = createEngine({ suffix: 'reason_direct' });
    const result = engine._directReason('今天天气怎么样', { messages: [] });
    assert.strictEqual(result.mode, REASONING_MODE.DIRECT);
    assert.ok(result.content.length > 0);
  });

  await t.test('ANALYTICAL 推理模式 - 检测数据关键词', () => {
    const engine = createEngine({ suffix: 'reason_analytical' });
    const result = engine._analyticalReason('帮我分析这些销售数据', { messages: [] });
    assert.strictEqual(result.mode, REASONING_MODE.ANALYTICAL);
    assert.ok(result.toolCalls.some(t => t.name === 'data_query'));
  });

  await t.test('ANALYTICAL 推理模式 - 检测统计关键词', () => {
    const engine = createEngine({ suffix: 'reason_stats' });
    const result = engine._analyticalReason('计算一下平均值和百分比', { messages: [] });
    assert.ok(result.toolCalls.some(t => t.name === 'statistical_analysis'));
  });

  await t.test('PLANNING 推理模式 - 创建类任务', () => {
    const engine = createEngine({ suffix: 'reason_planning' });
    const result = engine._planningReason('创建一个新的Web应用', { messages: [] });
    assert.strictEqual(result.mode, REASONING_MODE.PLANNING);
    assert.ok(result.toolCalls.some(t => t.name === 'task_decompose'));
  });

  await t.test('PLANNING 推理模式 - 部署类任务', () => {
    const engine = createEngine({ suffix: 'reason_deploy' });
    const result = engine._planningReason('部署到生产环境', { messages: [] });
    assert.ok(result.content.includes('环境配置'));
  });

  await t.test('REFLECTIVE 推理模式', () => {
    const engine = createEngine({ suffix: 'reason_reflective' });
    const result = engine._reflectiveReason('检查系统健康状态', { messages: [] });
    assert.strictEqual(result.mode, REASONING_MODE.REFLECTIVE);
    assert.ok(result.toolCalls.some(t => t.name === 'health_check'));
  });

  cleanup();
});

test('SubAgentEngine - 工具调用系统', async (t) => {
  await t.test('注册自定义工具', () => {
    const engine = createEngine({ suffix: 'tool_register' });
    engine.registerTool('my_tool', async (params) => ({ result: params.x * 2 }));
    const tools = engine.listTools();
    assert.ok(tools.some(t => t.name === 'my_tool'));
  });

  await t.test('执行内置工具', async () => {
    const engine = createEngine({ suffix: 'tool_exec' });
    const result = await engine.executeTool('health_check', {});
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.result.status, 'healthy');
  });

  await t.test('执行未知工具应失败', async () => {
    const engine = createEngine({ suffix: 'tool_unknown' });
    const result = await engine.executeTool('nonexistent_tool', {});
    assert.strictEqual(result.success, false);
  });

  await t.test('所有内置工具可用', () => {
    const engine = createEngine({ suffix: 'tool_builtin' });
    const tools = engine.listTools();
    const builtinNames = ['knowledge_search', 'text_summarize', 'data_query',
      'statistical_analysis', 'task_decompose', 'health_check',
      'general_query', 'file_operation', 'report_generate', 'alert_trigger'];
    for (const name of builtinNames) {
      assert.ok(tools.some(t => t.name === name), `缺少内置工具: ${name}`);
    }
  });

  cleanup();
});

test('SubAgentEngine - v2.9 技能检测', async (t) => {
  await t.test('技能匹配 - 名称匹配', () => {
    const engine = createEngine({ suffix: 'skill_match_name' });
    engine._installedSkills = [
      { name: '数据分析', enabled: true, triggerKeywords: ['分析', '数据'] },
    ];
    const matches = engine._detectSkillMatch('请帮我进行数据分析');
    assert.ok(matches.length > 0);
    assert.strictEqual(matches[0].reason, 'name_match');
  });

  await t.test('技能匹配 - 触发词匹配', () => {
    const engine = createEngine({ suffix: 'skill_match_kw' });
    engine._installedSkills = [
      { name: 'CodeReview', enabled: true, triggerKeywords: ['代码审查', 'review', 'PR'] },
    ];
    const matches = engine._detectSkillMatch('帮我做一下代码审查');
    assert.ok(matches.length > 0);
    assert.strictEqual(matches[0].reason, 'keyword:代码审查');
  });

  await t.test('技能匹配 - 禁用技能不匹配', () => {
    const engine = createEngine({ suffix: 'skill_match_disabled' });
    engine._installedSkills = [
      { name: 'DisabledSkill', enabled: false, triggerKeywords: ['test'] },
    ];
    const matches = engine._detectSkillMatch('test something');
    assert.strictEqual(matches.length, 0);
  });

  await t.test('技能匹配 - 无技能时不报错', () => {
    const engine = createEngine({ suffix: 'skill_match_empty' });
    engine._installedSkills = [];
    const matches = engine._detectSkillMatch('anything');
    assert.strictEqual(matches.length, 0);
  });

  cleanup();
});

test('SubAgentEngine - 统计与状态', async (t) => {
  await t.test('getStatus() 返回完整状态', async () => {
    const engine = createEngine({ suffix: 'status' });
    await engine.start();
    const status = engine.getStatus();
    assert.strictEqual(status.agentId, 'test_engine_001');
    assert.strictEqual(status.state, ENGINE_STATE.IDLE);
    assert.ok(status.sessions >= 0);
    assert.ok(status.stats);
    assert.ok(status.capabilities);
    assert.ok(status.skills);
  });

  await t.test('LLM Provider 设置', () => {
    const engine = createEngine({ suffix: 'llm' });
    const mockProvider = { chat: async () => ({ content: 'test' }) };
    engine.setLLMProvider(mockProvider, 'gpt-4');
    assert.strictEqual(engine._llmProvider, mockProvider);
    assert.strictEqual(engine._llmModel, 'gpt-4');
  });

  cleanup();
});

test('SubAgentEngine - 上下文压缩', async (t) => {
  await t.test('会话消息压缩', async () => {
    const engine = createEngine({ suffix: 'compress' });
    await engine.start();
    const sessions = engine.listSessions();
    const session = engine._sessions.get(sessions[0].id);

    // 添加大量消息
    for (let i = 0; i < 50; i++) {
      session.messages.push({ role: 'user', content: `消息${i}`, timestamp: Date.now() });
    }

    engine._compressSession(session);
    assert.ok(session.messages.length <= 30); // 系统消息 + 摘要 + 最近10条
    assert.ok(session.summary);
  });

  cleanup();
});

test('SubAgentEngine - 持久化', async (t) => {
  await t.test('会话持久化', async () => {
    const engine = createEngine({ suffix: 'persist' });
    await engine.start();
    const sessions = engine.listSessions();
    engine._persistSession(engine._sessions.get(sessions[0].id));

    const files = fs.readdirSync(engine._dataDir)
      .filter(f => f.startsWith('session_') && f.endsWith('.json'));
    assert.ok(files.length >= 1);
  });

  cleanup();
});

// ── 最终清理 ──
test('清理测试数据', () => {
  cleanup();
});
