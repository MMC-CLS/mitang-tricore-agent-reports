/**
 * TriCore Agent - Phase 1 核心模块测试
 *
 * 测试覆盖：
 *   1. 统一调度器 - 优先级调度、模式切换、执行任务管理
 *   2. 记忆引擎 - FTS5搜索、焦点栈、执行轨迹、技能管理
 *   3. 多模型路由 - Provider注册、模型选择、fallback链
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ═══════════════════════════════════════
// 测试：统一调度器
// ═══════════════════════════════════════

async function testScheduler() {
  console.log('\n=== 测试统一调度器 ===');

  const { UnifiedScheduler, PRIORITY, MODE, SCHEDULE_EVENTS } = require('../src/scheduler/unified-scheduler');

  // Test 1: 创建调度器
  console.log('Test 1: 创建调度器...');
  const scheduler = new UnifiedScheduler({ awakeningTicks: 5 });
  assert.strictEqual(scheduler._running, false);
  assert.strictEqual(scheduler._currentMode, MODE.IDLE);
  console.log('  ✓ 调度器创建成功');

  // Test 2: 启动/停止
  console.log('Test 2: 启动/停止...');
  const modeChanges = [];
  scheduler.on(SCHEDULE_EVENTS.MODE_CHANGE, ({ from, to }) => {
    modeChanges.push({ from, to });
  });
  scheduler.start();
  assert.strictEqual(scheduler._running, true);
  assert.strictEqual(modeChanges.length, 1);
  assert.strictEqual(modeChanges[0].to, MODE.CONSCIOUSNESS);

  // 启动并等待第一个TICK（不等觉醒期完成，太慢）
  scheduler.start();
  assert.strictEqual(scheduler._running, true);
  assert.strictEqual(modeChanges.length, 1);
  assert.strictEqual(modeChanges[0].to, MODE.CONSCIOUSNESS);

  // 等待一个TICK（觉醒期10s间隔）
  await new Promise(resolve => {
    scheduler.on(SCHEDULE_EVENTS.TICK, resolve);
  });
  console.log('  ✓ 启动和觉醒期TICK正常');

  scheduler.stop();
  assert.strictEqual(scheduler._running, false);
  console.log('  ✓ 停止正常');

  // Test 3: 提交执行任务
  console.log('Test 3: 提交执行任务...');
  const taskId = scheduler.submitExecutionTask({
    id: 'test_task_1',
    steps: [
      { action: 'read_file', params: { path: '/tmp/test.txt' } },
      { action: 'write_file', params: { path: '/tmp/output.txt', content: 'hello' } },
    ],
    priority: PRIORITY.HIGH,
  });
  assert.strictEqual(taskId, 'test_task_1');
  assert.strictEqual(scheduler._executionQueue.length, 1);
  console.log('  ✓ 执行任务提交成功');

  // Test 4: 提交进化操作
  console.log('Test 4: 提交进化操作...');
  scheduler.submitEvolutionOp({
    id: 'evo_1',
    type: 'skill_learn',
    priority: PRIORITY.LOW,
    payload: { taskId: 'test_task_1' },
  });
  assert.strictEqual(scheduler._evolutionQueue.length, 1);
  console.log('  ✓ 进化操作提交成功');

  // Test 5: 自定义TICK间隔
  console.log('Test 5: 自定义TICK间隔...');
  scheduler.setCustomTickInterval(5, 3);
  assert.strictEqual(scheduler._customInterval.seconds, 5);
  assert.strictEqual(scheduler._customInterval.ttl, 3);
  console.log('  ✓ 自定义间隔设置成功');

  // Test 6: 配额限制
  console.log('Test 6: 配额限制...');
  scheduler.notifyRateLimit(Date.now() + 60000);
  assert.strictEqual(scheduler._rateLimited, true);
  console.log('  ✓ 配额限制通知成功');

  // Test 7: 状态查询
  console.log('Test 7: 状态查询...');
  const status = scheduler.getStatus();
  assert.strictEqual(status.running, false); // 已停止
  assert.strictEqual(status.executionQueueLength, 1);
  assert.strictEqual(status.evolutionQueueLength, 1);
  console.log('  ✓ 状态查询正常');

  // Test 8: 间隔计算
  console.log('Test 8: 间隔计算...');
  scheduler._rateLimited = false;
  scheduler._customInterval = null;
  scheduler._awakeningTicksRemaining = 0;
  scheduler._activeTask = null;
  scheduler._executionQueue = [];
  scheduler._evolutionQueue = [];
  scheduler._consciousnessTickCount = 0; // 重置计数
  const idleInterval = scheduler._computeNextInterval();
  assert.ok(idleInterval > 0, `空闲间隔应大于0，实际为${idleInterval}`);
  console.log(`  ✓ 空闲间隔: ${idleInterval}ms`);

  console.log('\n✅ 调度器测试全部通过！');
}


// ═══════════════════════════════════════
// 测试：记忆引擎
// ═══════════════════════════════════════

async function testMemoryEngine() {
  console.log('\n=== 测试记忆引擎 ===');

  const { MemoryEngine, MEMORY_TIER } = require('../src/memory/memory-engine');

  // 使用临时数据库
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-test-'));
  const dbPath = path.join(tmpDir, 'test-memory.db');

  const memory = new MemoryEngine({ dbPath });
  memory.init();

  try {
    // Test 1: 写入记忆
    console.log('Test 1: 写入记忆...');
    const id1 = memory.upsert({
      content: '用户喜欢使用Python进行数据分析',
      summary: '用户偏好：Python数据分析',
      salience: 5.0,
      mem_type: 'preference',
      source: 'conversation',
    });
    const id2 = memory.upsert({
      content: '今天的工程项目会议讨论了机电预算缺口问题',
      summary: '工程会议：机电预算',
      salience: 4.0,
      mem_type: 'event',
      source: 'conversation',
    });
    assert.ok(id1 > 0);
    assert.ok(id2 > 0);
    console.log(`  ✓ 写入记忆 id1=${id1}, id2=${id2}`);

    // Test 2: FTS5搜索
    console.log('Test 2: FTS5搜索...');
    const results = memory.search({ text: 'Python数据分析', limit: 5 });
    assert.ok(results.length > 0, '搜索应有结果');
    assert.ok(results.some(r => r.content.includes('Python')), '应包含Python相关记忆');
    console.log(`  ✓ 搜索到 ${results.length} 条记忆`);

    // Test 3: 去重写入
    console.log('Test 3: 去重写入...');
    const id3 = memory.upsert({
      content: '用户喜欢使用Python进行数据分析',
      salience: 4.5,
    });
    // 相同内容应合并而非重复
    assert.ok(id3 === id1, '重复内容应返回相同ID并提升salience');
    console.log('  ✓ 去重写入正常');

    // Test 4: 关键词提取
    console.log('Test 4: 关键词提取...');
    const kw = memory._extractKeywords('白龙马AI智能体的记忆系统非常强大', 10);
    assert.ok(kw.some(k => k.includes('白龙马') || k.includes('龙马')), '应包含白龙马相关');
    assert.ok(kw.some(k => k.includes('智能体') || k.includes('智能')), '应包含智能体相关');
    assert.ok(kw.some(k => k.includes('记忆') || k.includes('记忆系')), '应包含记忆相关');
    console.log(`  ✓ 提取关键词: ${kw.join(', ')}`);

    // Test 5: 焦点栈
    console.log('Test 5: 焦点栈...');
    memory.updateFocusStack('created', ['Python', '数据分析'], 1);
    let stack = memory.getFocusStack();
    assert.strictEqual(stack.length, 1);
    assert.ok(stack[0].topics.includes('Python'));

    memory.updateFocusStack('kept', ['Python', '可视化'], 2);
    stack = memory.getFocusStack();
    assert.strictEqual(stack[0].hit_count, 2);

    memory.updateFocusStack('pushed', ['工程预算', '机电'], 3);
    stack = memory.getFocusStack();
    assert.strictEqual(stack.length, 2);

    memory.updateFocusStack('returned', ['Python', '数据分析'], 4);
    stack = memory.getFocusStack();
    assert.strictEqual(stack.length, 1);
    assert.ok(stack[0].topics.includes('Python'));
    console.log('  ✓ 焦点栈操作正常 (created/kept/pushed/returned)');

    // Test 6: 执行轨迹
    console.log('Test 6: 执行轨迹...');
    memory.recordExecutionTrace({
      task_id: 'task_001',
      step_index: 0,
      action: 'read_file',
      params: { path: '/tmp/test.txt' },
      result: '文件内容已读取',
      success: true,
      duration_ms: 150,
    });
    memory.recordExecutionTrace({
      task_id: 'task_001',
      step_index: 1,
      action: 'write_file',
      params: { path: '/tmp/output.txt', content: 'processed data' },
      result: '文件写入成功',
      success: true,
      duration_ms: 80,
    });
    const traces = memory.getExecutionTrace('task_001');
    assert.strictEqual(traces.length, 2);
    console.log('  ✓ 执行轨迹记录正常');

    // Test 7: 技能管理
    console.log('Test 7: 技能管理...');
    const saveResult = memory.saveSkill({
      name: 'data_processing',
      description: '数据处理工作流：读取→清洗→分析→输出',
      content: '# Data Processing Skill\n\n1. 读取原始数据\n2. 数据清洗\n3. 统计分析\n4. 生成报告',
      category: 'data',
      trigger_keywords: ['数据', '分析', '处理', '报告'],
      auto_created: false,
    });
    // 先审批技能（默认pending，搜索只返回approved）
    const pendingSkills = memory._db.prepare(
      "SELECT * FROM skills WHERE audit_status = 'pending'"
    ).all();
    assert.ok(pendingSkills.length > 0, '应有待审批技能');
    for (const s of pendingSkills) {
      memory.auditSkill(s.id, 'approved');
    }
    const skills = memory.searchSkills('数据分析', 5);
    assert.ok(skills.length > 0, '应搜索到技能');
    assert.strictEqual(skills[0].name, 'data_processing');
    console.log(`  ✓ 技能管理正常，搜索到 "${skills[0].name}"`);

    // Test 8: 技能审计
    console.log('Test 8: 技能审计...');
    // 技能已在Test 7中审批
    const approvedSkills = memory.searchSkills('数据', 5);
    assert.ok(approvedSkills.length > 0);
    console.log('  ✓ 技能审计正常');

    // Test 9: 记忆衰减
    console.log('Test 9: 记忆衰减...');
    memory.decay();
    console.log('  ✓ 记忆衰减执行成功');

    // Test 10: 记忆整合
    console.log('Test 10: 记忆整合...');
    memory.upsert({
      content: '用户偏好使用Python进行数据分析',
      salience: 4.0,
      source: 'conversation',
    });
    const merged = memory.consolidate();
    console.log(`  ✓ 记忆整合完成，合并${merged}条`);

    // Test 11: 统计
    console.log('Test 11: 统计...');
    const stats = memory.getStats();
    assert.ok(stats.memories.length > 0);
    assert.ok(stats.focusStackSize >= 0);
    console.log(`  ✓ 统计正常: ${JSON.stringify(stats.memories)}`);

    console.log('\n✅ 记忆引擎测试全部通过！');
  } finally {
    memory.close();
    // 清理临时文件
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 测试：多模型路由
// ═══════════════════════════════════════

async function testModelRouter() {
  console.log('\n=== 测试多模型路由 ===');

  const { ModelRouter, MODEL_PURPOSE, PROVIDER_PRESETS, ROUTE_STRATEGY } = require('../src/providers/model-router');

  // Test 1: 创建路由器
  console.log('Test 1: 创建路由器...');
  const router = new ModelRouter();
  assert.strictEqual(router._strategy, ROUTE_STRATEGY.LAYER_OPTIMAL);
  console.log('  ✓ 路由器创建成功');

  // Test 2: Provider预设
  console.log('Test 2: Provider预设...');
  assert.ok(PROVIDER_PRESETS.deepseek, '应有DeepSeek预设');
  assert.ok(PROVIDER_PRESETS.minimax, '应有MiniMax预设');
  assert.ok(PROVIDER_PRESETS.openai, '应有OpenAI预设');
  assert.ok(PROVIDER_PRESETS.qwen, '应有Qwen预设');
  assert.strictEqual(PROVIDER_PRESETS.deepseek.supportsThinking, true);
  console.log('  ✓ Provider预设完整');

  // Test 3: 注册Provider
  console.log('Test 3: 注册Provider...');
  router.registerProvider('deepseek', {
    apiKey: 'test-key-dummy',
  });
  assert.ok(router._providers.has('deepseek'));
  assert.strictEqual(router._activeProvider, 'deepseek');
  console.log('  ✓ Provider注册成功');

  // Test 4: 多Provider注册
  console.log('Test 4: 多Provider注册...');
  router.registerProvider('openai', { apiKey: 'test-openai-key' });
  router.registerProvider('qwen', { apiKey: 'test-qwen-key' });
  assert.strictEqual(router._providers.size, 3);
  console.log('  ✓ 多Provider注册成功');

  // Test 5: Fallback链
  console.log('Test 5: Fallback链...');
  router.setFallbackChain(['openai', 'qwen']);
  assert.deepStrictEqual(router._fallbackChain, ['openai', 'qwen']);
  console.log('  ✓ Fallback链设置成功');

  // Test 6: 模型选择（按层最优策略）
  console.log('Test 6: 模型选择...');
  const provider = router._providers.get('deepseek');
  const consciousnessModel = router._selectModel(provider.config, MODEL_PURPOSE.CONSCIOUSNESS);
  const executionModel = router._selectModel(provider.config, MODEL_PURPOSE.EXECUTION);
  const evolutionModel = router._selectModel(provider.config, MODEL_PURPOSE.EVOLUTION);
  assert.ok(consciousnessModel, '应返回意识层模型');
  assert.ok(executionModel, '应返回执行层模型');
  assert.ok(evolutionModel, '应返回进化层模型');
  console.log(`  ✓ 模型选择: 意识=${consciousnessModel}, 执行=${executionModel}, 进化=${evolutionModel}`);

  // Test 7: 路由策略切换
  console.log('Test 7: 路由策略切换...');
  const cheapRouter = new ModelRouter({ strategy: ROUTE_STRATEGY.CHEAPEST });
  cheapRouter.registerProvider('deepseek', { apiKey: 'test' });
  const cheapProvider = cheapRouter._providers.get('deepseek');
  const cheapModel = cheapRouter._selectModel(cheapProvider.config, MODEL_PURPOSE.CONSCIOUSNESS);
  // 最便宜策略应选择execution层模型
  assert.strictEqual(cheapModel, cheapProvider.config.models.execution);
  console.log(`  ✓ 最便宜策略模型: ${cheapModel}`);

  // Test 8: Provider调用链
  console.log('Test 8: Provider调用链...');
  const chain = router._resolveProviderChain(MODEL_PURPOSE.CONSCIOUSNESS);
  assert.strictEqual(chain[0], 'deepseek', '活跃Provider应排第一');
  assert.ok(chain.includes('openai'), '应包含fallback');
  assert.ok(chain.includes('qwen'), '应包含fallback');
  console.log(`  ✓ 调用链: ${chain.join(' → ')}`);

  // Test 9: 错误处理
  console.log('Test 9: 错误处理...');
  router._handleProviderError('deepseek', { status: 429, message: 'Rate limited' });
  assert.strictEqual(router._providers.get('deepseek').status, 'rate_limited');
  console.log('  ✓ 429限流处理正常');

  router._handleProviderError('openai', { message: 'Network error' });
  assert.strictEqual(router._failureCounts.get('openai'), 1);
  console.log('  ✓ 失败计数正常');

  // Test 10: 状态查询
  console.log('Test 10: 状态查询...');
  const status = router.getStatus();
  assert.strictEqual(status.activeProvider, 'deepseek');
  assert.strictEqual(status.strategy, ROUTE_STRATEGY.LAYER_OPTIMAL);
  assert.strictEqual(status.fallbackChain.length, 2);
  assert.ok(status.providers.deepseek);
  console.log('  ✓ 状态查询正常');

  console.log('\n✅ 多模型路由测试全部通过！');
}


// ═══════════════════════════════════════
// 运行所有测试
// ═══════════════════════════════════════

async function runAllTests() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   TriCore Agent Phase 1 测试套件      ║');
  console.log('╚══════════════════════════════════════╝');

  try {
    await testScheduler();
    await testMemoryEngine();
    await testModelRouter();

    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   ✅ 全部测试通过！                    ║');
    console.log('╚══════════════════════════════════════╝');
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runAllTests();
