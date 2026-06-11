/**
 * TriCore Agent - Phase 9-11 测试套件
 *
 * 测试覆盖：
 *   Phase 9:  配置管理 - 加载/保存/路径访问/安全导出
 *   Phase 10: 多Agent协作 - 注册/发现/任务分配/通信/资源锁
 *             技能市场 - 发布/搜索/下载/评分/验证/安全扫描
 *   Phase 11: 进程管理 - 状态/指标/重启策略
 *             全量集成 - v1.0.0所有模块
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');


// ═══════════════════════════════════════
// 测试：配置管理（Phase 9）
// ═══════════════════════════════════════

async function testConfigManager() {
  console.log('\n=== 测试配置管理 (Phase 9) ===');

  const { ConfigManager, DEFAULT_CONFIG } = require('../src/config/config-manager');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-cfg-'));
  const manager = new ConfigManager({ configDir: tmpDir });

  try {
    // Test 1: 默认配置
    console.log('Test 1: 默认配置...');
    assert.ok(DEFAULT_CONFIG.llm, '应有llm配置');
    assert.ok(DEFAULT_CONFIG.scheduler, '应有scheduler配置');
    assert.ok(DEFAULT_CONFIG.social, '应有social配置');
    assert.ok(DEFAULT_CONFIG.voice, '应有voice配置');
    assert.ok(DEFAULT_CONFIG.ui, '应有ui配置');
    assert.ok(DEFAULT_CONFIG.api, '应有api配置');
    console.log('  ✓ 默认配置结构完整');

    // Test 2: 加载配置
    console.log('Test 2: 加载配置...');
    const config = manager.load();
    assert.strictEqual(config.llm.provider, 'deepseek');
    assert.strictEqual(config.scheduler.awakeningTicks, 10);
    assert.strictEqual(config.ui.theme, 'dark');
    console.log('  ✓ 配置加载成功');

    // Test 3: 点号路径获取
    console.log('Test 3: 点号路径获取...');
    assert.strictEqual(manager.get('llm.provider'), 'deepseek');
    assert.strictEqual(manager.get('scheduler.tickIntervalIdle'), 300000);
    assert.strictEqual(manager.get('ui.nonexistent'), undefined);
    const fullConfig = manager.get();
    assert.ok(fullConfig.llm);
    console.log('  ✓ 路径访问正常');

    // Test 4: 设置配置
    console.log('Test 4: 设置配置...');
    manager.set('llm.provider', 'openai');
    manager.set('llm.apiKey', 'sk-test-123');
    assert.strictEqual(manager.get('llm.provider'), 'openai');
    assert.strictEqual(manager.get('llm.apiKey'), 'sk-test-123');
    console.log('  ✓ 配置设置正常');

    // Test 5: 保存并重新加载
    console.log('Test 5: 保存并重新加载...');
    manager.save();
    const manager2 = new ConfigManager({ configDir: tmpDir });
    const reloaded = manager2.load();
    assert.strictEqual(reloaded.llm.provider, 'openai');
    assert.strictEqual(reloaded.llm.apiKey, 'sk-test-123');
    console.log('  ✓ 配置持久化正常');

    // Test 6: 安全导出
    console.log('Test 6: 安全导出...');
    const safe = manager.exportSafe();
    assert.ok(safe.llm.apiKey.includes('***'), 'API Key应被遮蔽');
    assert.ok(!safe.llm.apiKey.includes('sk-test-123'), '完整Key不应出现');
    console.log('  ✓ 敏感信息已遮蔽');

    // Test 7: 重置配置
    console.log('Test 7: 重置配置...');
    manager.reset();
    assert.strictEqual(manager.get('llm.provider'), 'deepseek');
    assert.strictEqual(manager.get('llm.apiKey'), '');
    console.log('  ✓ 配置重置正常');

    // Test 8: 深度路径设置
    console.log('Test 8: 深度路径设置...');
    manager.set('social.discord.botToken', 'test_token_abc');
    assert.strictEqual(manager.get('social.discord.botToken'), 'test_token_abc');
    console.log('  ✓ 深度路径设置正常');

    console.log('\n✅ 配置管理测试全部通过！');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 测试：多Agent协作（Phase 10前半）
// ═══════════════════════════════════════

async function testAgentCoordination() {
  console.log('\n=== 测试多Agent协作 (Phase 10) ===');

  const { AgentCoordination, AGENT_STATUS, TASK_PRIORITY, MESSAGE_TYPE } = require('../src/coordination/agent-coordination');

  const coordination = new AgentCoordination({ heartbeatInterval: 5000 });

  try {
    // Test 1: 常量定义
    console.log('Test 1: 常量定义...');
    assert.strictEqual(AGENT_STATUS.ONLINE, 'online');
    assert.strictEqual(AGENT_STATUS.BUSY, 'busy');
    assert.strictEqual(AGENT_STATUS.OFFLINE, 'offline');
    assert.strictEqual(TASK_PRIORITY.CRITICAL, 3);
    assert.strictEqual(MESSAGE_TYPE.REQUEST, 'request');
    console.log('  ✓ 常量定义正确');

    // Test 2: Agent注册
    console.log('Test 2: Agent注册...');
    const registered = [];
    coordination.on('agent_registered', (data) => registered.push(data));

    const agent1Id = coordination.registerAgent({
      name: 'Worker-1',
      type: 'worker',
      capabilities: ['file_ops', 'code_gen'],
    });

    const agent2Id = coordination.registerAgent({
      name: 'Specialist-1',
      type: 'specialist',
      capabilities: ['web_search', 'data_analysis'],
      skills: ['python_script'],
    });

    assert.strictEqual(registered.length, 2);
    assert.ok(agent1Id.startsWith('agent_'));
    assert.ok(agent2Id.startsWith('agent_'));
    console.log(`  ✓ 注册2个Agent: ${agent1Id.substring(0,20)}..., ${agent2Id.substring(0,20)}...`);

    // Test 3: Agent发现 - 按能力
    console.log('Test 3: Agent发现...');
    const fileOpsAgents = coordination.discoverAgents(['file_ops']);
    assert.strictEqual(fileOpsAgents.length, 1);
    assert.strictEqual(fileOpsAgents[0].name, 'Worker-1');

    const allAgents = coordination.discoverAgents();
    assert.strictEqual(allAgents.length, 2);

    const noMatch = coordination.discoverAgents(['nonexistent_capability']);
    assert.strictEqual(noMatch.length, 0);
    console.log('  ✓ 按能力发现Agent正常');

    // Test 4: Agent心跳
    console.log('Test 4: Agent心跳...');
    const hbResult = coordination.heartbeat(agent1Id, {
      status: AGENT_STATUS.BUSY,
      activeTasks: 2,
      loadScore: 60,
    });
    assert.ok(hbResult);
    const info = coordination.getAgentInfo(agent1Id);
    assert.strictEqual(info.status, AGENT_STATUS.BUSY);
    assert.strictEqual(info.loadScore, 60);
    console.log('  ✓ 心跳更新正常');

    // Test 5: 协作任务创建
    console.log('Test 5: 协作任务创建...');
    const taskId = coordination.createCoordinationTask({
      goal: '分析项目数据并生成报告',
      priority: TASK_PRIORITY.HIGH,
      requiredCapabilities: ['file_ops'],
    });
    assert.ok(taskId.startsWith('coord_'));
    console.log(`  ✓ 任务创建: ${taskId.substring(0,25)}...`);

    // Test 6: 任务分解
    console.log('Test 6: 任务分解...');
    const subtasks = coordination.decomposeTask(taskId);
    assert.ok(subtasks.length > 0);
    console.log(`  ✓ 分解为 ${subtasks.length} 个子任务`);

    // Test 7: 子任务结果提交
    console.log('Test 7: 子任务结果提交...');
    const subtask = subtasks[0];
    coordination.submitSubtaskResult(taskId, subtask.id, {
      success: true,
      output: '分析完成：共100条数据',
    });
    const taskInfo = coordination.getTaskInfo(taskId);
    assert.strictEqual(taskInfo.subtasks[0].status, 'completed');
    console.log('  ✓ 子任务结果提交正常');

    // Test 8: 资源锁
    console.log('Test 8: 资源锁...');
    const lock1 = coordination.acquireLock(agent1Id, 'file:/data/report.csv');
    assert.ok(lock1.acquired);

    const lock2 = coordination.acquireLock(agent2Id, 'file:/data/report.csv');
    assert.ok(!lock2.acquired);
    assert.strictEqual(lock2.heldBy, agent1Id);

    const release = coordination.releaseLock(agent1Id, 'file:/data/report.csv');
    assert.ok(release);

    const lock3 = coordination.acquireLock(agent2Id, 'file:/data/report.csv');
    assert.ok(lock3.acquired);
    coordination.releaseLock(agent2Id, 'file:/data/report.csv');
    console.log('  ✓ 资源锁获取/释放正常');

    // Test 9: Agent间消息
    console.log('Test 9: Agent间消息...');
    const sentMessages = [];
    coordination.on('message_sent', (msg) => sentMessages.push(msg));

    const msgResult = await coordination.sendMessage(agent1Id, agent2Id, '请帮我搜索数据');
    assert.ok(msgResult);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].content, '请帮我搜索数据');
    console.log('  ✓ 消息发送正常');

    // Test 10: Agent注销
    console.log('Test 10: Agent注销...');
    const unregistered = [];
    coordination.on('agent_unregistered', (data) => unregistered.push(data));
    coordination.unregisterAgent(agent2Id);
    assert.strictEqual(unregistered.length, 1);
    const remaining = coordination.discoverAgents();
    assert.strictEqual(remaining.length, 1);
    console.log('  ✓ Agent注销正常');

    // Test 11: 状态查询
    console.log('Test 11: 状态查询...');
    const status = coordination.getStatus();
    assert.strictEqual(status.agents.total, 1);
    assert.ok(status.tasks.total > 0);
    assert.strictEqual(status.locks, 0); // 已释放
    console.log('  ✓ 状态查询正常');

    coordination.stopHeartbeatMonitor();
    console.log('\n✅ 多Agent协作测试全部通过！');
  } finally {
    coordination.stopHeartbeatMonitor();
  }
}


// ═══════════════════════════════════════
// 测试：技能市场（Phase 10后半）
// ═══════════════════════════════════════

async function testSkillMarket() {
  console.log('\n=== 测试技能市场 (Phase 10) ===');

  const { SkillMarket, SKILL_MARKET_STATUS, SKILL_VALIDATION } = require('../src/market/skill-market');
  const { MemoryEngine } = require('../src/memory/memory-engine');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-market-'));
  const memory = new MemoryEngine({ dbPath: path.join(tmpDir, 'test.db') });
  memory.init();

  const market = new SkillMarket({
    db: memory._db,
    downloadDir: path.join(tmpDir, 'market'),
  });
  market.init();

  try {
    // Test 1: 常量
    console.log('Test 1: 常量...');
    assert.strictEqual(SKILL_MARKET_STATUS.PUBLISHED, 'published');
    assert.strictEqual(SKILL_MARKET_STATUS.DEPRECATED, 'deprecated');
    assert.strictEqual(SKILL_VALIDATION.VALID, 'valid');
    assert.strictEqual(SKILL_VALIDATION.INVALID, 'invalid');
    console.log('  ✓ 常量定义正确');

    // Test 2: 发布技能 - 有效
    console.log('Test 2: 发布技能 - 有效...');
    const publishResult = await market.publishSkill({
      name: '数据分析助手',
      description: '自动读取CSV文件并生成统计报告',
      category: 'data_processing',
      content: '# 数据分析助手\n\n## 描述\n自动读取CSV文件并生成统计报告\n\n## 步骤\n1. 读取文件\n2. 分析数据\n3. 生成报告',
      authorId: 'agent_worker_1',
      tags: ['data', 'csv', 'analysis'],
    });
    assert.ok(publishResult.skillId);
    assert.strictEqual(publishResult.status, 'published');
    console.log(`  ✓ 技能发布成功: ${publishResult.skillId}`);

    // Test 3: 发布技能 - 无效（缺少必填项）
    console.log('Test 3: 发布技能 - 无效...');
    const badResult = await market.publishSkill({
      description: '没有名字的技能',
      content: '',
    });
    assert.ok(badResult.error);
    console.log('  ✓ 无效技能正确拒绝');

    // Test 4: 发布技能 - 安全威胁
    console.log('Test 4: 发布技能 - 安全威胁...');
    const dangerResult = await market.publishSkill({
      name: '危险技能',
      description: '包含危险命令',
      content: '# 危险技能\n执行 rm -rf / 删除所有文件\nprocess.exit(1)',
    });
    assert.ok(dangerResult.error);
    assert.ok(dangerResult.error.includes('Security'));
    console.log('  ✓ 安全威胁正确拦截');

    // Test 5: 搜索技能
    console.log('Test 5: 搜索技能...');
    const searchResult = market.searchSkills({ keyword: '数据' });
    assert.strictEqual(searchResult.length, 1);
    assert.strictEqual(searchResult[0].name, '数据分析助手');
    console.log('  ✓ 搜索到1个技能');

    // Test 6: 按分类搜索
    console.log('Test 6: 按分类搜索...');
    const catResult = market.searchSkills({ category: 'data_processing' });
    assert.strictEqual(catResult.length, 1);
    console.log('  ✓ 分类搜索正常');

    // Test 7: 下载技能
    console.log('Test 7: 下载技能...');
    const skillId = publishResult.skillId;
    const downloadResult = await market.downloadSkill(skillId);
    assert.strictEqual(downloadResult.name, '数据分析助手');
    assert.ok(downloadResult.content);
    console.log('  ✓ 技能下载成功');

    // Test 8: 下载不存在的技能
    console.log('Test 8: 下载不存在的技能...');
    const noResult = await market.downloadSkill('nonexistent_skill');
    assert.ok(noResult.error);
    console.log('  ✓ 不存在的技能正确返回错误');

    // Test 9: 技能评分
    console.log('Test 9: 技能评分...');
    const rate1 = market.rateSkill(skillId, 5);
    assert.strictEqual(rate1.newAvg, 5);
    const rate2 = market.rateSkill(skillId, 3);
    assert.strictEqual(rate2.newAvg, 4); // (5+3)/2 = 4
    assert.strictEqual(rate2.totalRatings, 2);
    console.log('  ✓ 评分计算正确');

    // Test 10: 无效评分
    console.log('Test 10: 无效评分...');
    const badRate = market.rateSkill(skillId, 6);
    assert.ok(badRate.error);
    console.log('  ✓ 无效评分正确拒绝');

    // Test 11: 技能废弃
    console.log('Test 11: 技能废弃...');
    const deprecateResult = market.deprecateSkill(skillId, '已过时');
    assert.ok(deprecateResult.deprecated);
    const afterDeprecate = market.searchSkills({ keyword: '数据' });
    assert.strictEqual(afterDeprecate.length, 0, '废弃技能不应出现在搜索结果');
    console.log('  ✓ 技能废弃正常');

    // Test 12: 统计
    console.log('Test 12: 统计...');
    const stats = market.getStats();
    assert.strictEqual(stats.totalSkills, 0); // 已废弃
    assert.ok(Array.isArray(stats.categories));
    console.log('  ✓ 统计数据正常');

    console.log('\n✅ 技能市场测试全部通过！');
  } finally {
    memory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 测试：进程管理（Phase 11）
// ═══════════════════════════════════════

async function testProcessManager() {
  console.log('\n=== 测试进程管理 (Phase 11) ===');

  const { ProcessManager, RESTART_POLICY, HEALTH_STATUS } = require('../src/deploy/process-manager');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-proc-'));
  const pm = new ProcessManager({
    logDir: tmpDir,
    restartPolicy: RESTART_POLICY.ON_FAILURE,
    maxRestarts: 3,
    healthCheckInterval: 5000,
  });

  try {
    // Test 1: 常量
    console.log('Test 1: 常量...');
    assert.strictEqual(RESTART_POLICY.NEVER, 'never');
    assert.strictEqual(RESTART_POLICY.ON_FAILURE, 'on_failure');
    assert.strictEqual(RESTART_POLICY.ALWAYS, 'always');
    assert.strictEqual(HEALTH_STATUS.HEALTHY, 'healthy');
    assert.strictEqual(HEALTH_STATUS.UNHEALTHY, 'unhealthy');
    console.log('  ✓ 常量定义正确');

    // Test 2: 初始状态
    console.log('Test 2: 初始状态...');
    const status = pm.getStatus();
    assert.strictEqual(status.running, false);
    assert.strictEqual(status.healthStatus, HEALTH_STATUS.STOPPED);
    assert.strictEqual(status.restartCount, 0);
    console.log('  ✓ 初始状态正确');

    // Test 3: 指标获取
    console.log('Test 3: 指标获取...');
    const metrics = pm.getMetrics();
    assert.strictEqual(metrics.healthStatus, HEALTH_STATUS.STOPPED);
    assert.strictEqual(metrics.restartCount, 0);
    assert.strictEqual(metrics.pid, process.pid);
    console.log('  ✓ 指标获取正常');

    // Test 4: 日志初始化
    console.log('Test 4: 日志目录...');
    assert.ok(fs.existsSync(tmpDir));
    console.log('  ✓ 日志目录存在');

    // Test 5: 不启动Agent直接stop
    console.log('Test 5: 未启动时stop...');
    await pm.stop();
    const stoppedStatus = pm.getStatus();
    assert.strictEqual(stoppedStatus.running, false);
    console.log('  ✓ 未启动时stop安全');

    console.log('\n✅ 进程管理测试全部通过！');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 测试：v1.0.0全量集成
// ═══════════════════════════════════════

async function testV1Integration() {
  console.log('\n=== 测试v1.0.0全量集成 ===');

  const {
    TriCoreAgent, VERSION, CODENAME,
    // 新模块
    ConfigManager, AgentCoordination, SkillMarket,
    ProcessManager, RESTART_POLICY, HEALTH_STATUS,
    AGENT_STATUS, SKILL_MARKET_STATUS,
  } = require('../src/index');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-v1-'));
  const agent = new TriCoreAgent({ dataDir: tmpDir, awakeningTicks: 2 });

  try {
    // Test 1: 版本号确认v1.0.0
    console.log('Test 1: 版本号确认...');
    assert.strictEqual(VERSION, '1.0.0', `版本应为1.0.0，实际: ${VERSION}`);
    console.log(`  ✓ ${CODENAME} v${VERSION}`);

    // Test 2: 新模块实例化
    console.log('Test 2: 新模块实例化...');
    assert.ok(agent._config, '应有config实例');
    assert.ok(agent._coordination, '应有coordination实例');
    assert.ok(agent._skillMarket, '应有skillMarket实例');
    assert.ok(agent._processManager, '应有processManager实例');
    console.log('  ✓ 四个新模块实例化成功');

    // Test 3: 初始化memory
    console.log('Test 3: 初始化...');
    agent._memory.init();
    agent._running = true;
    console.log('  ✓ 记忆引擎初始化成功');

    // Test 4: 协作层 - 注册Agent
    console.log('Test 4: 协作层 - 注册Agent...');
    const remoteId = agent.registerAgent({
      name: 'Remote-Worker',
      type: 'worker',
      capabilities: ['code_gen', 'file_ops'],
    });
    assert.ok(remoteId);
    console.log(`  ✓ 远程Agent注册: ${remoteId.substring(0,20)}...`);

    // Test 5: 协作层 - 发现Agent
    console.log('Test 5: 协作层 - 发现Agent...');
    const agents = agent.discoverAgents(['file_ops']);
    assert.ok(agents.length >= 1);
    console.log(`  ✓ 发现 ${agents.length} 个Agent`);

    // Test 6: 协作层 - 创建协作任务
    console.log('Test 6: 协作层 - 创建协作任务...');
    const coordTaskId = agent.createCoordinationTask({
      goal: '协作完成数据分析',
      priority: AGENT_STATUS.ONLINE ? 1 : 0,
      requiredCapabilities: ['file_ops'],
    });
    assert.ok(coordTaskId);
    console.log(`  ✓ 协作任务创建: ${coordTaskId.substring(0,20)}...`);

    // Test 7: 技能市场 - 发布技能
    console.log('Test 7: 技能市场 - 发布技能...');
    agent._skillMarket._db = agent._memory._db;
    try { agent._skillMarket.init(); } catch {}
    const pubResult = await agent.publishSkill({
      name: '测试技能',
      description: 'v1.0.0集成测试技能',
      category: 'testing',
      content: '# 测试技能\n\n这是一个测试技能的内容描述，包含完整的步骤说明。',
      authorId: 'local',
    });
    assert.ok(pubResult.skillId, `发布失败: ${JSON.stringify(pubResult)}`);
    console.log(`  ✓ 技能发布成功`);

    // Test 8: 技能市场 - 搜索技能
    console.log('Test 8: 技能市场 - 搜索技能...');
    const marketResults = agent.searchMarketSkills({ keyword: '测试' });
    assert.ok(marketResults.length >= 1);
    console.log(`  ✓ 搜索到 ${marketResults.length} 个市场技能`);

    // Test 9: 技能市场 - 下载技能
    console.log('Test 9: 技能市场 - 下载技能...');
    const dlResult = await agent.downloadSkill(pubResult.skillId);
    assert.strictEqual(dlResult.name, '测试技能');
    console.log('  ✓ 技能下载成功');

    // Test 10: 技能评分
    console.log('Test 10: 技能评分...');
    const rateResult = agent.rateSkill(pubResult.skillId, 5);
    assert.ok(rateResult.newAvg);
    console.log(`  ✓ 评分: ${rateResult.newAvg}`);

    // Test 11: 配置管理
    console.log('Test 11: 配置管理...');
    agent._config.load();
    agent.setConfig('llm.provider', 'qwen');
    assert.strictEqual(agent.getConfig('llm.provider'), 'qwen');
    console.log('  ✓ 配置读写正常');

    // Test 12: 完整状态包含新模块
    console.log('Test 12: 完整状态包含新模块...');
    const fullStatus = agent.getStatus();
    assert.strictEqual(fullStatus.version, '1.0.0');
    assert.ok(fullStatus.coordination, '状态应含coordination');
    assert.ok(fullStatus.skillMarket, '状态应含skillMarket');
    console.log(`  ✓ v1.0.0完整状态正常`);

    // 清理
    agent._coordination.stopHeartbeatMonitor();
    agent._evolution.stopConsolidationLoop();
    agent._running = false;
    agent._memory.close();

    console.log('\n✅ v1.0.0全量集成测试全部通过！');
  } finally {
    try {
      agent._coordination.stopHeartbeatMonitor();
      agent._evolution.stopConsolidationLoop();
      agent._memory.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 运行所有测试
// ═══════════════════════════════════════

async function runAllTests() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   TriCore Agent Phase 9-11 测试套件   ║');
  console.log('╚══════════════════════════════════════╝');

  try {
    await testConfigManager();        // Phase 9: 8项
    await testAgentCoordination();    // Phase 10前半: 11项
    await testSkillMarket();          // Phase 10后半: 12项
    await testProcessManager();       // Phase 11: 5项
    await testV1Integration();        // 集成: 12项

    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   ✅ 全部Phase 9-11测试通过！         ║');
    console.log('║   共计: 48项测试                      ║');
    console.log('╚══════════════════════════════════════╝');
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runAllTests();
