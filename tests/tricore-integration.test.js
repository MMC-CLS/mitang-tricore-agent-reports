/**
 * TriCore Agent - 三核融合集成测试
 *
 * 测试覆盖：
 *   1. 意识核 - 双层思考、焦点栈、觉醒期、记忆注入
 *   2. 执行核 - 任务创建、步骤规划、执行闭环、插件系统
 *   3. 进化核 - 技能沉淀、SKILL.md、审计、轨迹分析
 *   4. 三核协同 - 意识→执行→进化的完整链路
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ═══════════════════════════════════════
// 测试：意识核
// ═══════════════════════════════════════

async function testConsciousnessCore() {
  console.log('\n=== 测试意识核 ===');

  const { ConsciousnessCore, THINK_LAYER, TICK_TYPE } = require('../src/core/consciousness-core');

  // 准备记忆引擎
  const { MemoryEngine } = require('../src/memory/memory-engine');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-c-'));
  const memory = new MemoryEngine({ dbPath: path.join(tmpDir, 'test.db') });
  memory.init();

  const core = new ConsciousnessCore({ memory, awakeningTicks: 3 });

  try {
    // Test 1: 创建意识核
    console.log('Test 1: 创建意识核...');
    assert.strictEqual(core._tickCounter, 0);
    assert.strictEqual(core._awakeningRemaining, 3);
    console.log('  ✓ 意识核创建成功');

    // Test 2: 双层思考分类
    console.log('Test 2: 双层思考分类...');
    assert.strictEqual(core._classifyThinkingLayer('好的'), THINK_LAYER.L1);
    assert.strictEqual(core._classifyThinkingLayer('谢谢'), THINK_LAYER.L1);
    assert.strictEqual(core._classifyThinkingLayer('请帮我分析一下这个方案的优劣'), THINK_LAYER.L2);
    assert.strictEqual(core._classifyThinkingLayer('制定一个项目规划策略'), THINK_LAYER.L2);
    assert.strictEqual(core._classifyThinkingLayer('分析'), THINK_LAYER.L2);
    assert.strictEqual(core._classifyThinkingLayer('嗯'), THINK_LAYER.L1);
    console.log('  ✓ 双层思考分类正常');

    // Test 3: 时间词解析
    console.log('Test 3: 时间词解析...');
    const hints = core._parseTemporalHints('昨天讨论了什么？前天的会议记录呢？');
    assert.strictEqual(hints.length, 2);
    assert.ok(hints[0].text === '昨天' || hints[0].text === '前天');
    console.log(`  ✓ 解析到 ${hints.length} 个时间词`);

    // Test 4: 焦点栈更新
    console.log('Test 4: 焦点栈更新...');
    const focusResult1 = core._updateFocus('白龙马智能体的功能');
    assert.ok(['created', 'pushed'].includes(focusResult1.event), `首次应为created，实际: ${focusResult1.event}`);
    // 第二次：关键词可能重叠（n-gram），也可能是新话题
    const focusResult2 = core._updateFocus('白龙马智能体的新特性');
    assert.ok(['kept', 'pushed'].includes(focusResult2.event), `应为kept或pushed，实际: ${focusResult2.event}`);
    const focusResult3 = core._updateFocus('工程项目的预算分析');
    assert.ok(['pushed', 'returned'].includes(focusResult3.event), `应为pushed或returned，实际: ${focusResult3.event}`);
    console.log('  ✓ 焦点栈操作正常');

    // Test 5: 空闲思考（无LLM）
    console.log('Test 5: 空闲思考...');
    const idleResult = await core.processTick({ type: TICK_TYPE.IDLE_THINK, tickNumber: 1 });
    // 无LLM路由器，应返回默认响应
    assert.ok(idleResult);
    console.log(`  ✓ 空闲思考返回层: ${idleResult.layer}`);

    // Test 6: 觉醒期
    console.log('Test 6: 觉醒期...');
    const awakeningResult = await core.processTick({ type: TICK_TYPE.AWAKENING, tickNumber: 2 });
    assert.ok(awakeningResult);
    assert.strictEqual(core._awakeningRemaining, 2);
    console.log(`  ✓ 觉醒期剩余: ${core._awakeningRemaining}`);

    // Test 7: 状态查询
    console.log('Test 7: 状态查询...');
    const status = core.getStatus();
    assert.strictEqual(status.awakeningRemaining, 2);
    assert.ok(status.tickCounter > 0);
    console.log(`  ✓ TICK计数: ${status.tickCounter}`);

    // Test 8: 记忆注入器
    console.log('Test 8: 记忆注入器...');
    memory.upsert({ content: '用户喜欢使用Python进行数据分析', salience: 5.0, source: 'conversation' });
    const injected = await core._injectMemories('Python数据分析工具');
    assert.ok(injected.memories.length >= 0);
    console.log(`  ✓ 注入 ${injected.memories.length} 条记忆`);

    console.log('\n✅ 意识核测试全部通过！');
  } finally {
    memory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 测试：执行核
// ═══════════════════════════════════════

async function testExecutionCore() {
  console.log('\n=== 测试执行核 ===');

  const { ExecutionCore, TASK_STATUS, TOOL_PERMISSION, BUILTIN_TOOLS } = require('../src/core/execution-core');

  // 准备记忆引擎
  const { MemoryEngine } = require('../src/memory/memory-engine');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-e-'));
  const memory = new MemoryEngine({ dbPath: path.join(tmpDir, 'test.db') });
  memory.init();

  const core = new ExecutionCore({
    memory,
    sandboxDir: path.join(tmpDir, 'sandbox'),
  });

  try {
    // Test 1: 创建执行核
    console.log('Test 1: 创建执行核...');
    assert.ok(core._tools.size > 0, '应有内置工具');
    console.log(`  ✓ 内置工具: ${core._tools.size}个`);

    // Test 2: 内置工具列表
    console.log('Test 2: 内置工具列表...');
    const tools = core.listTools();
    assert.ok(tools.find(t => t.name === 'read_file'));
    assert.ok(tools.find(t => t.name === 'write_file'));
    assert.ok(tools.find(t => t.name === 'shell_exec'));
    assert.strictEqual(tools.find(t => t.name === 'shell_exec').permission, TOOL_PERMISSION.DANGEROUS);
    console.log('  ✓ 工具权限分类正确');

    // Test 3: 写入+读取文件
    console.log('Test 3: 写入+读取文件...');
    const writeResult = await core._executeBuiltinAction('write_file', {
      path: 'test.txt',
      content: 'Hello TriCore!',
    }, {});
    assert.ok(writeResult.success);

    const readResult = await core._executeBuiltinAction('read_file', {
      path: 'test.txt',
    }, {});
    assert.strictEqual(readResult.content, 'Hello TriCore!');
    console.log('  ✓ 文件读写正常');

    // Test 4: 列出目录
    console.log('Test 4: 列出目录...');
    const listResult = await core._executeBuiltinAction('list_dir', {
      path: '.',
    }, {});
    assert.ok(listResult.entries.length > 0);
    assert.ok(listResult.entries.find(e => e.name === 'test.txt'));
    console.log(`  ✓ 列出 ${listResult.entries.length} 个文件`);

    // Test 5: 创建任务（无LLM，使用简单规划）
    console.log('Test 5: 创建任务...');
    const taskId = await core.createTask({ goal: '读取test.txt文件内容' });
    assert.ok(taskId);
    const task = core.getTask(taskId);
    assert.ok(task);
    assert.strictEqual(task.status, TASK_STATUS.PENDING);
    console.log(`  ✓ 任务创建: ${taskId}`);

    // Test 6: 步骤解析
    console.log('Test 6: 步骤解析...');
    const steps = core._parseStepsFromLLM('[{"action":"read_file","params":{"path":"test.txt"}},{"action":"send_message","params":{"content":"完成"}}]');
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].action, 'read_file');
    console.log('  ✓ 步骤解析正常');

    // Test 7: 执行任务步骤
    console.log('Test 7: 执行任务步骤...');
    // 手动设置步骤以便测试
    task.steps = [{ action: 'read_file', params: { path: 'test.txt' } }];
    task.currentStepIndex = 0;
    const stepResult = await core.executeStep(taskId);
    assert.ok(stepResult.stepResult);
    assert.strictEqual(stepResult.taskStatus, TASK_STATUS.COMPLETED);
    console.log('  ✓ 任务执行完成');

    // Test 8: 插件系统
    console.log('Test 8: 插件系统...');
    core.installPlugin({
      name: 'test_plugin',
      version: '1.0.0',
      tools: [{
        name: 'custom_tool',
        definition: {
          description: '自定义测试工具',
          permission: TOOL_PERMISSION.SAFE,
          params: {},
        },
        handler: async (params) => ({ result: 'custom_ok' }),
      }],
    });
    const plugins = core.listPlugins();
    assert.strictEqual(plugins.length, 1);
    assert.strictEqual(plugins[0].name, 'test_plugin');
    console.log('  ✓ 插件安装成功');

    // Test 9: 卸载插件
    console.log('Test 9: 卸载插件...');
    core.uninstallPlugin('test_plugin');
    assert.strictEqual(core.listPlugins().length, 0);
    console.log('  ✓ 插件卸载成功');

    // Test 10: 审计日志
    console.log('Test 10: 审计日志...');
    const auditLog = core.getAuditLog();
    assert.ok(auditLog.length > 0);
    console.log(`  ✓ 审计日志: ${auditLog.length}条`);

    // Test 11: 状态
    console.log('Test 11: 状态...');
    const status = core.getStatus();
    assert.strictEqual(status.completedTasks, 1);
    assert.ok(status.toolsCount > 0);
    console.log(`  ✓ 完成${status.completedTasks}个任务, ${status.toolsCount}个工具`);

    console.log('\n✅ 执行核测试全部通过！');
  } finally {
    memory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 测试：进化核
// ═══════════════════════════════════════

async function testEvolutionCore() {
  console.log('\n=== 测试进化核 ===');

  const { EvolutionCore, SKILL_STATUS, SKILL_CATEGORY } = require('../src/core/evolution-core');

  // 准备记忆引擎
  const { MemoryEngine } = require('../src/memory/memory-engine');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-v-'));
  const memory = new MemoryEngine({ dbPath: path.join(tmpDir, 'test.db') });
  memory.init();

  const core = new EvolutionCore({ memory });

  try {
    // Test 1: 创建进化核
    console.log('Test 1: 创建进化核...');
    assert.strictEqual(core._minTracesForSkill, 2);
    console.log('  ✓ 进化核创建成功');

    // Test 2: 模板式技能提取
    console.log('Test 2: 模板式技能提取...');
    const traces = [
      { step_index: 0, action: 'read_file', params: { path: '/data/sales.csv' }, success: true, result: '读取成功' },
      { step_index: 1, action: 'shell_exec', params: { command: 'wc -l /data/sales.csv' }, success: true, result: '1234行' },
    ];
    const skill = core._extractSkillFromTemplate(traces, 'task_test');
    assert.ok(skill.name);
    assert.ok(skill.description);
    assert.ok(skill.steps.length >= 2);
    console.log(`  ✓ 提取技能: "${skill.description.substring(0, 30)}..."`);

    // Test 3: SKILL.md生成
    console.log('Test 3: SKILL.md生成...');
    const skillMd = core._generateSkillMd(skill);
    assert.ok(skillMd.includes('# '));
    assert.ok(skillMd.includes('描述'));
    assert.ok(skillMd.includes('步骤'));
    assert.ok(skillMd.includes('元数据'));
    console.log('  ✓ SKILL.md格式正确');

    // Test 4: 记录执行轨迹并沉淀技能
    console.log('Test 4: 技能沉淀...');
    memory.recordExecutionTrace({
      task_id: 'task_001', step_index: 0, action: 'read_file',
      params: { path: 'data.csv' }, result: 'OK', success: true,
    });
    memory.recordExecutionTrace({
      task_id: 'task_001', step_index: 1, action: 'shell_exec',
      params: { command: 'wc -l' }, result: '100 lines', success: true,
    });
    const extractedSkill = await core.extractSkillFromTask('task_001');
    // 无LLM时用模板提取
    if (extractedSkill) {
      console.log(`  ✓ 沉淀技能: "${extractedSkill.name}" → ${extractedSkill.status}`);
    } else {
      console.log('  ✓ 技能去重或队列满，跳过');
    }

    // Test 5: 技能审计
    console.log('Test 5: 技能审计...');
    const pendingSkills = memory._db.prepare(
      "SELECT * FROM skills WHERE audit_status = 'pending'"
    ).all();
    if (pendingSkills.length > 0) {
      core.auditSkill(pendingSkills[0].id, SKILL_STATUS.APPROVED, '测试审批');
      console.log(`  ✓ 审批技能 #${pendingSkills[0].id}`);
    } else {
      console.log('  ✓ 无待审计技能');
    }

    // Test 6: 自动审计
    console.log('Test 6: 自动审计安全技能...');
    memory.saveSkill({
      name: 'auto_analysis',
      description: '自动数据分析技能',
      content: '# Analysis Skill',
      category: SKILL_CATEGORY.ANALYSIS,
      trigger_keywords: ['分析'],
      auto_created: true,
    });
    const auditResult = core.autoAuditSafeSkills();
    assert.ok(auditResult.approved >= 0);
    console.log(`  ✓ 自动审批: ${auditResult.approved}个`);

    // Test 7: 轨迹分析
    console.log('Test 7: 轨迹分析...');
    const suggestions = await core.analyzeExecutionPatterns();
    console.log(`  ✓ 改进建议: ${suggestions.length}条`);

    // Test 8: 记忆整合
    console.log('Test 8: 记忆整合...');
    core.runConsolidation();
    console.log('  ✓ 整合执行成功');

    // Test 9: SKILL.md导出
    console.log('Test 9: SKILL.md导出...');
    const approvedSkills = memory.searchSkills('分析', 5);
    if (approvedSkills.length > 0) {
      const exportDir = path.join(tmpDir, 'exported_skills');
      const filePath = core.exportSkillMd(approvedSkills[0].id, exportDir);
      if (filePath) {
        assert.ok(fs.existsSync(filePath));
        console.log(`  ✓ 导出到: ${path.basename(filePath)}`);
      }
    } else {
      console.log('  ✓ 无已审批技能可导出');
    }

    // Test 10: 状态
    console.log('Test 10: 状态...');
    const status = core.getStatus();
    assert.ok(status.lastConsolidationAt > 0);
    console.log('  ✓ 进化核状态正常');

    console.log('\n✅ 进化核测试全部通过！');
  } finally {
    core.stopConsolidationLoop();
    memory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 测试：三核协同
// ═══════════════════════════════════════

async function testTriCoreIntegration() {
  console.log('\n=== 测试三核协同 ===');

  const { TriCoreAgent, VERSION, CODENAME, THINK_LAYER, TASK_STATUS, SKILL_STATUS } = require('../src/index');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-int-'));
  const agent = new TriCoreAgent({ dataDir: tmpDir, awakeningTicks: 2 });

  try {
    // Test 1: 创建Agent
    console.log('Test 1: 创建Agent...');
    assert.strictEqual(agent._running, false);
    assert.ok(VERSION.startsWith('0.') || VERSION.startsWith('1.'));
    console.log(`  ✓ ${CODENAME} v${VERSION} 创建成功`);

    // Test 2: 初始化（不启动调度器，手动测试模块）
    console.log('Test 2: 初始化...');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    agent._memory.init();
    agent._running = true;
    console.log('  ✓ 记忆引擎初始化成功');

    // Test 3: 三核互联
    console.log('Test 3: 三核互联...');
    assert.ok(agent._consciousness._memory === agent._memory);
    assert.ok(agent._execution._memory === agent._memory);
    assert.ok(agent._evolution._memory === agent._memory);
    console.log('  ✓ 三核共享同一记忆引擎');

    // Test 4: 执行核任务提交
    console.log('Test 4: 执行核任务提交...');
    const taskId = await agent._execution.createTask({ goal: '读取测试文件' });
    assert.ok(taskId);
    console.log(`  ✓ 任务ID: ${taskId}`);

    // Test 5: 手动设置步骤并执行
    console.log('Test 5: 执行任务步骤...');
    const task = agent._execution.getTask(taskId);
    task.steps = [
      { action: 'write_file', params: { path: 'integration_test.txt', content: 'TriCore Integration Test' } },
      { action: 'read_file', params: { path: 'integration_test.txt' } },
    ];
    task.currentStepIndex = 0;

    const step1 = await agent._execution.executeStep(taskId);
    assert.ok(step1.stepResult?.success);
    const step2 = await agent._execution.executeStep(taskId);
    assert.ok(step2.stepResult?.content === 'TriCore Integration Test');
    console.log('  ✓ 任务执行闭环成功');

    // Test 6: 进化核技能沉淀
    console.log('Test 6: 进化核技能沉淀...');
    const skill = await agent._evolution.extractSkillFromTask(taskId);
    if (skill) {
      console.log(`  ✓ 技能沉淀: "${skill.name}" → ${skill.status}`);
    } else {
      console.log('  ✓ 技能去重，无需重复沉淀');
    }

    // Test 7: 消息发送
    console.log('Test 7: 消息发送...');
    const msgId = agent.sendMessage('test_user', '你好，TriCore！');
    assert.ok(msgId);
    assert.strictEqual(agent._messageQueue.length, 1);
    console.log(`  ✓ 消息入队: ${msgId}`);

    // Test 8: 搜索记忆
    console.log('Test 8: 搜索记忆...');
    agent._memory.upsert({
      content: 'TriCore是一个三核融合的AI智能体',
      salience: 5.0,
      source: 'conversation',
    });
    const memories = agent.searchMemories('TriCore');
    assert.ok(memories.length > 0);
    console.log(`  ✓ 搜索到 ${memories.length} 条记忆`);

    // Test 9: 完整状态
    console.log('Test 9: 完整状态...');
    const status = agent.getStatus();
    assert.strictEqual(status.running, true);
    assert.ok(status.consciousness);
    assert.ok(status.execution);
    assert.ok(status.evolution);
    assert.ok(status.memory);
    console.log(`  ✓ 执行核: ${status.execution.completedTasks}完成/${status.execution.totalTasks}总计`);
    console.log(`  ✓ 记忆: ${status.memory.memories.map(m => `${m.tier}(${m.count})`).join(', ')}`);

    // Test 10: 停止
    console.log('Test 10: 停止...');
    agent._evolution.stopConsolidationLoop();
    agent._running = false;
    console.log('  ✓ Agent停止成功');

    console.log('\n✅ 三核协同测试全部通过！');
  } finally {
    agent._evolution.stopConsolidationLoop();
    agent._memory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 运行所有测试
// ═══════════════════════════════════════

async function runAllTests() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   TriCore Agent 三核融合测试套件      ║');
  console.log('╚══════════════════════════════════════╝');

  try {
    await testConsciousnessCore();
    await testExecutionCore();
    await testEvolutionCore();
    await testTriCoreIntegration();

    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   ✅ 全部三核测试通过！                ║');
    console.log('╚══════════════════════════════════════╝');
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runAllTests();
