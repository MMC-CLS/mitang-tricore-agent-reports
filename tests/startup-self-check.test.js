/**
 * TriCoreAgent v3.1 — 全流程启动自检 单元测试
 *
 * 测试范围：
 *   1. StartupSelfCheck 实例化与基本状态
 *   2. Phase 0 前置飞航检查（Node版本/磁盘/内存/CPU/权限）
 *   3. Phase 1 能力探测（LLM Provider/嵌入模型/浏览器/沙箱/网络/SQLite）
 *   4. Phase 2 集成冒烟（核心总线/安全边界/预算/记忆/调度器/消息队列）
 *   5. Phase 3 LLM方向构建
 *   6. 持久化状态读写
 *   7. 版本化管理（跳过一次后不再重复）
 *   8. 超时保护
 *   9. 重置功能
 *   10. getStatus() / getFullReport() / generateSummary()
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

// 加载被测模块
const {
  StartupSelfCheck,
  SELF_CHECK_STATUS,
  SELF_CHECK_PHASE,
  CHECK_SEVERITY,
  SELF_CHECK_VERSION,
  SELF_CHECK_CONFIG_KEY,
  SELF_CHECK_MEMORY_ID,
  DEFAULT_TIMEOUTS,
  MIN_DISK_SPACE,
  MIN_FREE_MEMORY,
  MIN_NODE_VERSION,
} = require('../src/bus/startup-self-check');

// ── 测试辅助 ──
const TEST_DATA_DIR = path.join(os.tmpdir(), `tricore_selfcheck_test_${Date.now()}`);
let testCounter = 0;

function createTestDir() {
  const dir = path.join(TEST_DATA_DIR, `test_${testCounter++}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

// ── 模拟依赖 ──
function createMockLogger() {
  const logs = [];
  return {
    logs,
    info: (msg, data) => logs.push({ level: 'info', msg, data }),
    warn: (msg, data) => logs.push({ level: 'warn', msg, data }),
    error: (msg, data) => logs.push({ level: 'error', msg, data }),
    debug: (msg, data) => logs.push({ level: 'debug', msg, data }),
    fatal: (msg, data) => logs.push({ level: 'fatal', msg, data }),
    getStats: () => ({ logCount: logs.length }),
  };
}

function createMockConfigManager() {
  const store = {};
  return {
    store,
    get: (key) => store[key] || null,
    set: (key, value) => { store[key] = value; },
    load: () => ({}),
    save: () => {},
  };
}

function createMockBus() {
  const handlers = {};
  return {
    on: (event, handler) => { handlers[event] = handler; },
    off: (event, handler) => { delete handlers[event]; },
    emit: (event, data) => { if (handlers[event]) handlers[event](data); },
    getDiagnostics: () => ({ events: 0 }),
    startTrace: () => 'test-trace-id',
    dispatch: () => {},
  };
}

function createMockMemory(db) {
  return {
    _db: db || null,
    _computeEmbedding: null,
    init: () => {},
    searchMemory: () => [],
    insertMemory: () => {},
    getStats: () => ({ total: 0 }),
  };
}

function createMockRouter() {
  return {
    getStatus: () => ({ providers: [] }),
    registerProvider: () => {},
    embed: async () => [0.1, 0.2, 0.3],
  };
}

// ═══════════════════════════════════════
// 测试 1: 实例化与基本状态
// ═══════════════════════════════════════

function test_instantiation() {
  console.log('\n[TEST 1] 实例化与基本状态');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({
    logger,
    dataDir,
    configManager,
  });

  const status = sc.getStatus();
  assert.strictEqual(status.version, SELF_CHECK_VERSION, '版本应匹配');
  assert.strictEqual(status.status, SELF_CHECK_STATUS.PENDING, '初始状态应为PENDING');
  assert.strictEqual(status.overallResult, null, '未运行时overallResult应为null');
  assert.strictEqual(status.stats.total, 0, '初始统计应为0');
  assert.strictEqual(status.phase3, null, '初始Phase3应为null');

  console.log('  ✅ 实例化通过');
  console.log(`  版本: ${status.version}`);
  console.log(`  状态: ${status.status}`);
}

// ═══════════════════════════════════════
// 测试 2: Phase 0 前置飞航检查
// ═══════════════════════════════════════

function test_phase0_checks() {
  console.log('\n[TEST 2] Phase 0 前置飞航检查');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  // 手动构建Phase 0检查
  const checks = sc._buildPhase0Checks();
  assert.ok(checks.length >= 5, `Phase 0应有至少5项检查，实际: ${checks.length}`);

  // 验证每个检查项的结构
  for (const check of checks) {
    assert.ok(check.id, '检查项应有id');
    assert.ok(check.name, '检查项应有name');
    assert.ok(check.phase === SELF_CHECK_PHASE.PHASE_0, '检查项应在Phase 0');
    assert.ok(Object.values(CHECK_SEVERITY).includes(check.severity), '严重级别应合法');
    assert.strictEqual(check.status, SELF_CHECK_STATUS.PENDING, '初始状态应为PENDING');
  }

  // 检查Node版本验证
  const nodeCheck = checks.find(c => c.id === 'p0-node-version');
  assert.ok(nodeCheck, '应有Node版本检查');
  assert.strictEqual(nodeCheck.severity, CHECK_SEVERITY.FATAL, 'Node版本应为FATAL级别');

  const nodeResult = sc._checkNodeVersion();
  assert.strictEqual(nodeResult.status, SELF_CHECK_STATUS.PASSED, 'Node版本应通过');
  console.log(`  ✅ Node版本: ${nodeResult.detail}`);

  // 检查数据目录权限
  const dirCheck = checks.find(c => c.id === 'p0-data-dir');
  assert.ok(dirCheck, '应有数据目录检查');
  const dirResult = sc._checkDataDir();
  assert.strictEqual(dirResult.status, SELF_CHECK_STATUS.PASSED, '数据目录应可读写');
  console.log(`  ✅ 数据目录: ${dirResult.detail}`);

  // 检查磁盘空间
  const diskCheck = checks.find(c => c.id === 'p0-disk-space');
  assert.ok(diskCheck, '应有磁盘空间检查');
  const diskResult = sc._checkDiskSpace();
  const validDiskStatuses = [SELF_CHECK_STATUS.PASSED, SELF_CHECK_STATUS.DEGRADED, SELF_CHECK_STATUS.FAILED];
  assert.ok(validDiskStatuses.includes(diskResult.status), '磁盘检查状态应合法');
  console.log(`  ✅ 磁盘空间: ${diskResult.status} - ${diskResult.detail}`);

  // 检查内存
  const memCheck = checks.find(c => c.id === 'p0-memory');
  assert.ok(memCheck, '应有内存检查');
  const memResult = sc._checkMemory();
  assert.ok(validDiskStatuses.includes(memResult.status), '内存检查状态应合法');
  console.log(`  ✅ 系统内存: ${memResult.status} - ${memResult.detail}`);

  console.log('  ✅ Phase 0 检查项构建与单项验证通过');
}

// ═══════════════════════════════════════
// 测试 3: Phase 1 能力探测
// ═══════════════════════════════════════

function test_phase1_checks() {
  console.log('\n[TEST 3] Phase 1 能力探测');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  const deps = {
    router: createMockRouter(),
    memory: createMockMemory(),
    browser: null,
    sandboxDir: path.join(dataDir, 'sandbox'),
    provider: 'deepseek',
    apiKey: 'test-key',
  };

  const checks = sc._buildPhase1Checks(deps);
  assert.ok(checks.length >= 5, `Phase 1应有至少5项检查，实际: ${checks.length}`);

  for (const check of checks) {
    assert.strictEqual(check.phase, SELF_CHECK_PHASE.PHASE_1, '检查项应在Phase 1');
  }

  // 验证网络检查
  const netCheck = checks.find(c => c.id === 'p1-network');
  assert.ok(netCheck, '应有网络检查');

  // 验证沙箱检查
  const sandboxCheck = checks.find(c => c.id === 'p1-sandbox');
  assert.ok(sandboxCheck, '应有沙箱检查');

  console.log('  ✅ Phase 1 检查项构建通过');
  console.log(`  检查项: ${checks.map(c => c.id).join(', ')}`);
}

// ═══════════════════════════════════════
// 测试 4: Phase 2 集成冒烟
// ═══════════════════════════════════════

function test_phase2_checks() {
  console.log('\n[TEST 4] Phase 2 集成冒烟');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  const deps = {
    bus: createMockBus(),
    security: { getStatus: () => ({}), _rules: { law1: true, law2: true, law3: true } },
    budget: { getStatus: () => ({}), _coreRatios: { consciousness: 0.6, execution: 0.3, evolution: 0.1 } },
    memory: createMockMemory(),
    scheduler: { getStatus: () => ({ mode: 'consciousness', awakeningTicksRemaining: 10 }) },
    messageQueue: { getStats: () => ({ maxSize: 10000, persistEnabled: true, deadLetterEnabled: true }) },
    configValidator: null,
    config: {},
  };

  const checks = sc._buildPhase2Checks(deps);
  assert.ok(checks.length >= 6, `Phase 2应有至少6项检查，实际: ${checks.length}`);

  for (const check of checks) {
    assert.strictEqual(check.phase, SELF_CHECK_PHASE.PHASE_2, '检查项应在Phase 2');
  }

  // 验证核心总线检查
  const busCheck = checks.find(c => c.id === 'p2-core-bus');
  assert.ok(busCheck, '应有核心总线检查');

  // 验证安全边界检查
  const secCheck = checks.find(c => c.id === 'p2-security');
  assert.ok(secCheck, '应有安全边界检查');

  console.log('  ✅ Phase 2 检查项构建通过');
  console.log(`  检查项: ${checks.map(c => c.id).join(', ')}`);
}

// ═══════════════════════════════════════
// 测试 5: Phase 3 LLM方向构建
// ═══════════════════════════════════════

function test_phase3_directions() {
  console.log('\n[TEST 5] Phase 3 LLM方向构建');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  // 初始状态：Phase 3 应活跃
  assert.strictEqual(sc.isPhase3Active(), true, '初始Phase 3应活跃');
  assert.strictEqual(sc.isPhase3Complete(), false, '初始Phase 3未完成');

  // 构建方向
  const directions = sc.buildPhase3LLMDirections();
  assert.ok(directions, '应生成Phase 3方向');
  assert.ok(directions.includes('全流程端到端自检'), '方向应包含自检说明');
  assert.ok(directions.includes('文件系统闭环'), '方向应包含文件系统检查');
  assert.ok(directions.includes('工具调用验证'), '方向应包含工具调用检查');
  assert.ok(directions.includes('记忆注入验证'), '方向应包含记忆注入检查');
  assert.ok(directions.includes('子智能体生命周期'), '方向应包含子智能体检查');
  assert.ok(directions.includes('API端点验证'), '方向应包含API端点检查');
  assert.ok(directions.includes('complete_startup_self_check'), '方向应包含完成调用');
  assert.ok(directions.includes('严禁调用 send_message'), '方向应包含硬规则');

  console.log('  ✅ Phase 3 方向生成通过');
  console.log(`  方向长度: ${directions.length} 字符`);

  // 模拟完成Phase 3
  const completed = sc.completePhase3('全流程端到端验证通过', {
    file_ops: 'ok',
    tool_call: 'ok',
    memory: 'ok',
    subagent: 'ok',
    api_health: 'ok',
  });

  assert.strictEqual(completed.status, SELF_CHECK_STATUS.PASSED, '完成后状态应为PASSED');
  assert.ok(completed.completedAt, '应有完成时间');
  assert.strictEqual(sc.isPhase3Complete(), true, '完成后Phase 3应标记完成');
  assert.strictEqual(sc.isPhase3Active(), false, '完成后Phase 3不应活跃');

  // 完成后不应再生成方向
  const directionsAfter = sc.buildPhase3LLMDirections();
  assert.strictEqual(directionsAfter, null, '完成后不应再生成方向');

  console.log('  ✅ Phase 3 完成与状态切换通过');
}

// ═══════════════════════════════════════
// 测试 6: 持久化状态读写
// ═══════════════════════════════════════

function test_persistence() {
  console.log('\n[TEST 6] 持久化状态读写');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  // 初始应无持久化状态
  assert.strictEqual(sc._readPersistedState(), null, '初始无持久化状态');

  // 写入状态
  const testState = {
    version: SELF_CHECK_VERSION,
    status: SELF_CHECK_STATUS.PASSED,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalDuration: 1234,
    stats: { total: 10, passed: 8, degraded: 2, failed: 0, skipped: 0, timeout: 0 },
    phases: { preflight: { passed: 5, failed: 0 } },
  };
  sc._writePersistedState(testState);

  // 读取验证
  const read = sc._readPersistedState();
  assert.ok(read, '应能读取持久化状态');
  assert.strictEqual(read.version, SELF_CHECK_VERSION, '版本应匹配');
  assert.strictEqual(read.status, SELF_CHECK_STATUS.PASSED, '状态应匹配');
  assert.strictEqual(read.stats.total, 10, '统计应匹配');

  // _shouldReRun: 已完成且版本匹配 → 不应重新运行
  assert.strictEqual(sc._shouldReRun(), false, '已完成的不应重跑');

  console.log('  ✅ 持久化读写通过');
  console.log(`  持久化数据: ${JSON.stringify(configManager.store).length} 字符`);
}

// ═══════════════════════════════════════
// 测试 7: 版本化管理
// ═══════════════════════════════════════

function test_version_management() {
  console.log('\n[TEST 7] 版本化管理');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  // 首次运行 → 应重新检查
  assert.strictEqual(sc._shouldReRun(), true, '首次应重跑');

  // 写入旧版本状态
  sc._writePersistedState({
    version: 'v0.9.0',
    status: SELF_CHECK_STATUS.PASSED,
    completedAt: new Date().toISOString(),
  });

  // 版本不匹配 → 应重新检查
  assert.strictEqual(sc._shouldReRun(), true, '版本不匹配应重跑');

  // 写入当前版本
  sc._writePersistedState({
    version: SELF_CHECK_VERSION,
    status: SELF_CHECK_STATUS.PASSED,
    completedAt: new Date().toISOString(),
  });

  // 版本匹配 + 已完成 → 不应重跑
  assert.strictEqual(sc._shouldReRun(), false, '版本匹配且已完成不应重跑');

  // 版本匹配 + 失败 → 应重跑
  sc._writePersistedState({
    version: SELF_CHECK_VERSION,
    status: SELF_CHECK_STATUS.FAILED,
    completedAt: new Date().toISOString(),
  });
  assert.strictEqual(sc._shouldReRun(), true, '上次失败应重跑');

  // getLastCheckSnapshot
  const snapshot = sc.getLastCheckSnapshot();
  assert.ok(snapshot, '应有快照');
  assert.strictEqual(snapshot.version, SELF_CHECK_VERSION, '快照版本应匹配');
  assert.strictEqual(snapshot.status, SELF_CHECK_STATUS.FAILED, '快照状态应为FAILED');

  console.log('  ✅ 版本化管理通过');
}

// ═══════════════════════════════════════
// 测试 8: 重置功能
// ═══════════════════════════════════════

function test_reset() {
  console.log('\n[TEST 8] 重置功能');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  // 写入持久化状态
  sc._writePersistedState({
    version: SELF_CHECK_VERSION,
    status: SELF_CHECK_STATUS.PASSED,
    completedAt: new Date().toISOString(),
  });

  // 手动设置一些内部状态
  sc._status = SELF_CHECK_STATUS.PASSED;
  sc._overallResult = SELF_CHECK_STATUS.PASSED;
  sc._phase3State = { active: false, completedAt: new Date().toISOString() };
  sc._stats = { total: 10, passed: 10, degraded: 0, failed: 0, skipped: 0, timeout: 0, totalDuration: 1000 };

  // 重置
  sc.reset();

  // 验证重置后状态
  assert.strictEqual(sc._status, SELF_CHECK_STATUS.PENDING, '重置后状态应为PENDING');
  assert.strictEqual(sc._overallResult, null, '重置后overallResult应为null');
  assert.strictEqual(sc._phase3State, null, '重置后Phase3应为null');
  assert.strictEqual(sc._stats.total, 0, '重置后统计应为0');
  assert.strictEqual(sc._readPersistedState(), null, '重置后持久化状态应清除');

  // 重置后应重跑
  assert.strictEqual(sc._shouldReRun(), true, '重置后应重跑');

  console.log('  ✅ 重置功能通过');
}

// ═══════════════════════════════════════
// 测试 9: 超时保护机制
// ═══════════════════════════════════════

async function test_timeout_protection() {
  console.log('\n[TEST 9] 超时保护机制');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({
    logger,
    dataDir,
    configManager,
    timeouts: {
      phase0_total: 1000,
      phase0_per_item: 500,
    },
  });

  // 创建一个会超时的检查项
  const checkItem = sc._createCheckItem(
    'test-timeout', SELF_CHECK_PHASE.PHASE_0,
    '超时测试', 'Timeout Test',
    CHECK_SEVERITY.INFO
  );

  // 模拟一个长时间运行的操作（1500ms > 500ms超时）
  const result = await sc._runWithTimeout(
    () => new Promise((resolve) => setTimeout(() => resolve(true), 600)),
    500,
    checkItem
  );

  assert.strictEqual(result.status, SELF_CHECK_STATUS.TIMEOUT, '应标记为超时');
  assert.ok(result.detail.includes('超时'), '详情应包含超时信息');

  console.log('  ✅ 超时保护通过');
}

// ═══════════════════════════════════════
// 测试 10: 完整报告生成
// ═══════════════════════════════════════

async function test_full_report() {
  console.log('\n[TEST 10] 完整报告生成');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  // 运行完整自检（仅Phase 0，因为Phase 1/2需要真实依赖）
  const bus = createMockBus();
  const memory = createMockMemory();
  const report = await sc.runAll({
    router: createMockRouter(),
    memory,
    bus,
    security: { getStatus: () => ({}), _rules: { law1: true } },
    budget: { getStatus: () => ({}), _coreRatios: { consciousness: 0.6, execution: 0.3, evolution: 0.1 } },
    scheduler: { getStatus: () => ({ mode: 'idle' }) },
    browser: null,
    messageQueue: { getStats: () => ({}) },
    configValidator: null,
    config: {},
    provider: null,
    apiKey: null,
    sandboxDir: path.join(dataDir, 'sandbox'),
  });

  // 验证报告结构
  assert.ok(report, '应有报告');
  assert.ok(report.version, '应有版本');
  assert.ok(report.startedAt, '应有开始时间');
  assert.ok(report.completedAt, '应有完成时间');
  assert.ok(report.totalDuration >= 0, '应有耗时');
  assert.ok(report.stats, '应有统计');
  assert.ok(report.phases, '应有阶段数据');

  // 验证Phase 0
  assert.ok(report.phases[SELF_CHECK_PHASE.PHASE_0], '应有Phase 0数据');
  const p0 = report.phases[SELF_CHECK_PHASE.PHASE_0];
  assert.ok(p0.checks.length > 0, 'Phase 0应有检查项');

  // 验证总体结果
  const validOveralls = ['passed', 'degraded', 'failed'];
  assert.ok(validOveralls.includes(report.overall), `总体结果应合法: ${report.overall}`);

  // 测试摘要生成
  const summary = sc.generateSummary(report);
  assert.ok(summary.includes('全流程自检报告'), '摘要应包含标题');
  assert.ok(summary.length > 100, '摘要应有一定长度');

  // 验证getFullReport
  const fullReport = sc.getFullReport();
  assert.ok(fullReport.phases, '完整报告应有阶段数据');

  console.log('  ✅ 完整报告生成通过');
  console.log(`  总体结果: ${report.overall}`);
  console.log(`  统计: ${report.stats.passed}/${report.stats.total} 通过 (${report.totalDuration}ms)`);
  console.log(`  摘要: ${summary.split('\n').length} 行`);
}

// ═══════════════════════════════════════
// 测试 11: canStartSafely 逻辑
// ═══════════════════════════════════════

function test_can_start_safely() {
  console.log('\n[TEST 11] canStartSafely 启动安全判断');

  const logger = createMockLogger();
  const dataDir = createTestDir();
  const configManager = createMockConfigManager();

  const sc = new StartupSelfCheck({ logger, dataDir, configManager });

  // PENDING状态 → 可以尝试启动
  assert.strictEqual(sc.canStartSafely(), true, 'PENDING应允许启动');

  // PASSED状态 → 可以安全启动
  sc._status = SELF_CHECK_STATUS.PASSED;
  assert.strictEqual(sc.canStartSafely(), true, 'PASSED应允许启动');

  // DEGRADED状态 → 可以启动（降级模式）
  sc._status = SELF_CHECK_STATUS.DEGRADED;
  assert.strictEqual(sc.canStartSafely(), true, 'DEGRADED应允许启动');

  // FAILED状态 → 不应启动
  sc._status = SELF_CHECK_STATUS.FAILED;
  assert.strictEqual(sc.canStartSafely(), false, 'FAILED不应允许启动');

  console.log('  ✅ canStartSafely 逻辑通过');
}

// ═══════════════════════════════════════
// 测试 12: 常量定义完整性
// ═══════════════════════════════════════

function test_constants() {
  console.log('\n[TEST 12] 常量定义完整性');

  // SELF_CHECK_STATUS
  const requiredStatuses = ['PENDING', 'RUNNING', 'PASSED', 'DEGRADED', 'FAILED', 'SKIPPED', 'TIMEOUT'];
  for (const s of requiredStatuses) {
    assert.ok(SELF_CHECK_STATUS[s], `应有状态: ${s}`);
  }

  // SELF_CHECK_PHASE
  const requiredPhases = ['PHASE_0', 'PHASE_1', 'PHASE_2', 'PHASE_3'];
  for (const p of requiredPhases) {
    assert.ok(SELF_CHECK_PHASE[p], `应有阶段: ${p}`);
  }

  // CHECK_SEVERITY
  const requiredSeverities = ['FATAL', 'CRITICAL', 'WARNING', 'INFO'];
  for (const s of requiredSeverities) {
    assert.ok(CHECK_SEVERITY[s], `应有严重级别: ${s}`);
  }

  // 版本号
  assert.ok(SELF_CHECK_VERSION.startsWith('v'), '版本号应以v开头');

  // 超时配置
  assert.ok(DEFAULT_TIMEOUTS.global > 0, '全局超时应>0');
  assert.ok(DEFAULT_TIMEOUTS.phase0_total > 0, 'Phase 0超时应>0');
  assert.ok(DEFAULT_TIMEOUTS.phase1_total > 0, 'Phase 1超时应>0');
  assert.ok(DEFAULT_TIMEOUTS.phase2_total > 0, 'Phase 2超时应>0');
  assert.ok(DEFAULT_TIMEOUTS.phase3_total > 0, 'Phase 3超时应>0');

  // 最小资源要求
  assert.ok(MIN_DISK_SPACE > 0, '最小磁盘空间应>0');
  assert.ok(MIN_FREE_MEMORY > 0, '最小内存应>0');
  assert.ok(MIN_NODE_VERSION, '应有Node版本要求');

  console.log('  ✅ 常量定义完整');
}

// ═══════════════════════════════════════
// 运行所有测试
// ═══════════════════════════════════════

async function runAllTests() {
  console.log('══════ TriCoreAgent v3.1 全流程启动自检 单元测试 ══════');
  console.log(`Node版本: ${process.version}`);
  console.log(`平台: ${os.platform()} ${os.arch()}`);
  console.log(`自检版本: ${SELF_CHECK_VERSION}`);
  console.log(`测试目录: ${TEST_DATA_DIR}`);

  const startTime = Date.now();
  let passed = 0;
  let failed = 0;
  const failures = [];

  const tests = [
    { name: '实例化与基本状态', fn: test_instantiation },
    { name: 'Phase 0 前置飞航检查', fn: test_phase0_checks },
    { name: 'Phase 1 能力探测', fn: test_phase1_checks },
    { name: 'Phase 2 集成冒烟', fn: test_phase2_checks },
    { name: 'Phase 3 LLM方向构建', fn: test_phase3_directions },
    { name: '持久化状态读写', fn: test_persistence },
    { name: '版本化管理', fn: test_version_management },
    { name: '重置功能', fn: test_reset },
    { name: '超时保护机制', fn: test_timeout_protection },
    { name: '完整报告生成', fn: test_full_report },
    { name: '启动安全判断', fn: test_can_start_safely },
    { name: '常量定义完整性', fn: test_constants },
  ];

  for (const test of tests) {
    try {
      if (test.fn.constructor.name === 'AsyncFunction') {
        await test.fn();
      } else {
        test.fn();
      }
      passed++;
    } catch (e) {
      failed++;
      failures.push({ name: test.name, error: e.message, stack: e.stack });
      console.log(`  ❌ 失败: ${e.message}`);
    }
  }

  const duration = Date.now() - startTime;

  console.log('\n══════ 测试结果 ══════');
  console.log(`总计: ${tests.length} | 通过: ${passed} | 失败: ${failed} | 耗时: ${duration}ms`);

  if (failures.length > 0) {
    console.log('\n── 失败详情 ──');
    for (const f of failures) {
      console.log(`  ❌ ${f.name}: ${f.error}`);
    }
    console.log(`\n❌ 测试失败: ${passed}/${tests.length} 通过`);
    process.exit(1);
  } else {
    console.log(`\n✅ 所有测试通过 (${passed}/${tests.length})`);
  }

  // 清理测试目录
  cleanupTestDir();
}

// 运行
runAllTests().catch((e) => {
  console.error('测试运行异常:', e);
  cleanupTestDir();
  process.exit(1);
});
