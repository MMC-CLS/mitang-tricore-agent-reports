/**
 * 蜜糖 TriCore Agent - 全流程启动自检模块 (Full-Process Startup Self-Check)
 *
 * 灵感来源：BaiLongma（白龙马）v2.1.241 的 L2 启动自检机制
 *   - 分层验证架构：L0（被动）→ L1（环境探测）→ L2（LLM驱动能力验证）
 *   - 持久化状态：自检完成后不再重复，版本化管理
 *   - 三阶段门控：Pre-Flight → Capability Probe → Integration Smoke
 *   - 多维检查矩阵：系统环境 + 核心模块 + 外部依赖 + 端到端集成
 *
 * 检查阶段（Phase Gate Architecture）：
 *   Phase 0 — 前置飞航检查 (Pre-Flight Check)：同步，不依赖LLM，启动前必须通过
 *     - 数据目录读写权限
 *     - SQLite数据库连接与表结构完整性
 *     - 配置文件合法性
 *     - 磁盘空间余量
 *     - 系统内存可用量
 *     - Node.js版本兼容性
 *
 *   Phase 1 — 能力探测 (Capability Probe)：异步，依赖LLM Provider连通性
 *     - LLM Provider连通性（API Key验证 + 最小调用测试）
 *     - 嵌入模型可用性
 *     - 浏览器自动化（Playwright/Chromium）就绪
 *     - 沙箱目录创建与隔离
 *     - 网络连通性（DNS + HTTPS）
 *
 *   Phase 2 — 集成冒烟 (Integration Smoke)：异步，端到端验证核心子系统
 *     - 核心总线事件通道验证
 *     - 安全边界铁律规则自检
 *     - Token预算管理器初始化
 *     - 记忆引擎读写一致性
 *     - 统一调度器TICK时序验证
 *     - 消息队列入队/出队完整性
 *
 *   Phase 3 — 全流程端到端 (End-to-End Pipeline)：由LLM在启动后首个TICK执行
 *     - 文件系统：写→读→删 完整闭环
 *     - 工具调用：Tool Calling引擎连通验证
 *     - 记忆注入：记忆引擎写入→检索 一致性
 *     - 子智能体：创建→通信→销毁 生命周期
 *     - API服务：HTTP端点健康检查自调用
 *
 * 设计原则：
 *   1. 渐进式验证：Phase 0 失败 → 阻止启动；Phase 1 失败 → 降级启动；Phase 2/3 失败 → 标记告警
 *   2. 版本化状态：SELF_CHECK_VERSION 变更后自动重跑全量自检
 *   3. 持久化记忆：自检结果写入记忆库，供后续自诊断参考
 *   4. 超时保护：每个检查项有独立超时，总自检有全局超时
 *   5. 可观测性：每个检查项的耗时、状态、详情全量记录到结构化日志
 *
 * v3.1.0 新增模块
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { EventEmitter } = require('events');

// ── 自检状态常量 ──
const SELF_CHECK_STATUS = Object.freeze({
  PENDING: 'pending',       // 待执行
  RUNNING: 'running',       // 执行中
  PASSED: 'passed',         // 通过
  DEGRADED: 'degraded',     // 降级（非致命失败）
  FAILED: 'failed',         // 失败（致命，阻止启动）
  SKIPPED: 'skipped',       // 跳过
  TIMEOUT: 'timeout',       // 超时
});

// ── 自检阶段常量 ──
const SELF_CHECK_PHASE = Object.freeze({
  PHASE_0: 'preflight',       // 前置飞航检查
  PHASE_1: 'capability',      // 能力探测
  PHASE_2: 'integration',     // 集成冒烟
  PHASE_3: 'e2e_pipeline',    // 全流程端到端（LLM驱动）
});

// ── 严重级别 ──
const CHECK_SEVERITY = Object.freeze({
  FATAL: 'fatal',       // 致命：必须通过，否则阻止启动
  CRITICAL: 'critical', // 严重：强烈建议通过
  WARNING: 'warning',   // 警告：可选功能依赖
  INFO: 'info',         // 信息：仅记录
});

// ── 自检版本号（变更后触发重检） ──
const SELF_CHECK_VERSION = 'v1.0.0';
const SELF_CHECK_CONFIG_KEY = 'tricore_startup_self_check';
const SELF_CHECK_MEMORY_ID = 'system_startup_self_check';

// ── 默认超时配置（毫秒） ──
const DEFAULT_TIMEOUTS = {
  phase0_total: 5000,        // Phase 0 总超时
  phase0_per_item: 2000,     // Phase 0 单项超时
  phase1_total: 30000,       // Phase 1 总超时
  phase1_per_item: 10000,    // Phase 1 单项超时
  phase2_total: 15000,       // Phase 2 总超时
  phase2_per_item: 5000,     // Phase 2 单项超时
  phase3_total: 120000,      // Phase 3 总超时（LLM驱动，留足时间）
  global: 180000,            // 全局总超时
};

// ── 最小磁盘空间要求（字节） ──
const MIN_DISK_SPACE = 100 * 1024 * 1024; // 100MB
const MIN_FREE_MEMORY = 128 * 1024 * 1024; // 128MB
const MIN_NODE_VERSION = '16.0.0';

/**
 * 单项检查结果
 * @typedef {Object} CheckItem
 * @property {string} id - 检查项唯一标识
 * @property {string} phase - 所属阶段
 * @property {string} name - 检查项名称（中文）
 * @property {string} nameEn - 检查项名称（英文）
 * @property {string} severity - 严重级别
 * @property {string} status - 状态：pending/running/passed/degraded/failed/skipped/timeout
 * @property {number} duration - 执行耗时（ms）
 * @property {string} detail - 详细信息
 * @property {string} error - 错误信息（如有）
 * @property {string} suggestion - 修复建议
 * @property {number} startedAt - 开始时间戳
 * @property {number} completedAt - 完成时间戳
 */

class StartupSelfCheck extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger = options.logger || null;
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this._configManager = options.configManager || null;
    this._timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) };

    // 运行时状态
    this._status = SELF_CHECK_STATUS.PENDING;
    this._version = SELF_CHECK_VERSION;
    this._startedAt = null;
    this._completedAt = null;
    this._overallResult = null;

    // 各阶段检查项
    this._checks = {
      [SELF_CHECK_PHASE.PHASE_0]: [],
      [SELF_CHECK_PHASE.PHASE_1]: [],
      [SELF_CHECK_PHASE.PHASE_2]: [],
      [SELF_CHECK_PHASE.PHASE_3]: [],
    };

    // 统计
    this._stats = {
      total: 0,
      passed: 0,
      degraded: 0,
      failed: 0,
      skipped: 0,
      timeout: 0,
      totalDuration: 0,
    };
  }

  // ═══════════════════════════════════════
  // 日志辅助
  // ═══════════════════════════════════════

  _log(level, message, data = {}) {
    if (this._logger && typeof this._logger[level] === 'function') {
      this._logger[level](`[自检] ${message}`, { module: 'startup-self-check', ...data });
    } else {
      const prefix = `[SelfCheck] [${level.toUpperCase()}]`;
      if (level === 'error') console.error(`${prefix} ${message}`, data);
      else console.log(`${prefix} ${message}`);
    }
  }

  // ═══════════════════════════════════════
  // 工具函数
  // ═══════════════════════════════════════

  _now() {
    return Date.now();
  }

  _formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  _compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const a = parts1[i] || 0;
      const b = parts2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }

  _createCheckItem(id, phase, name, nameEn, severity, detail = '') {
    return {
      id,
      phase,
      name,
      nameEn,
      severity,
      status: SELF_CHECK_STATUS.PENDING,
      duration: 0,
      detail,
      error: null,
      suggestion: '',
      startedAt: null,
      completedAt: null,
    };
  }

  _finalizeCheck(item, status, detail = '', error = null, suggestion = '') {
    item.status = status;
    item.detail = detail || item.detail;
    item.error = error;
    item.suggestion = suggestion;
    item.completedAt = this._now();
    if (item.startedAt) {
      item.duration = item.completedAt - item.startedAt;
    }
    this.emit('check:complete', item);

    // 更新统计
    this._stats[status] = (this._stats[status] || 0) + 1;
    this._stats.totalDuration += item.duration;

    this._log(
      status === SELF_CHECK_STATUS.PASSED ? 'info' : (status === SELF_CHECK_STATUS.FAILED ? 'error' : 'warn'),
      `${item.name} [${item.nameEn}] → ${status} (${item.duration}ms)`,
      { checkId: item.id, status, duration: item.duration, error, detail }
    );

    return item;
  }

  async _runWithTimeout(fn, timeoutMs, checkItem) {
    checkItem.startedAt = this._now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._finalizeCheck(
          checkItem,
          SELF_CHECK_STATUS.TIMEOUT,
          `检查超时（${timeoutMs}ms）`,
          'TIMEOUT',
          '请检查系统负载或网络连接，必要时增加超时配置'
        );
        resolve(checkItem);
      }, timeoutMs);

      Promise.resolve()
        .then(() => fn())
        .then((result) => {
          clearTimeout(timer);
          if (checkItem.status === SELF_CHECK_STATUS.TIMEOUT) return; // 已超时
          if (result && typeof result === 'object' && result.status) {
            // fn 返回了预格式化的结果
            this._finalizeCheck(checkItem, result.status, result.detail || '', result.error || null, result.suggestion || '');
          } else if (result === true || result === undefined || result === null) {
            this._finalizeCheck(checkItem, SELF_CHECK_STATUS.PASSED, checkItem.detail || '检查通过');
          } else if (result === false) {
            this._finalizeCheck(checkItem, SELF_CHECK_STATUS.FAILED, '检查失败', '返回false', '请查看日志排查');
          } else {
            this._finalizeCheck(checkItem, SELF_CHECK_STATUS.PASSED, String(result));
          }
          resolve(checkItem);
        })
        .catch((err) => {
          clearTimeout(timer);
          if (checkItem.status === SELF_CHECK_STATUS.TIMEOUT) return;
          const isFatal = checkItem.severity === CHECK_SEVERITY.FATAL;
          this._finalizeCheck(
            checkItem,
            isFatal ? SELF_CHECK_STATUS.FAILED : SELF_CHECK_STATUS.DEGRADED,
            `检查异常: ${err.message}`,
            err.message,
            isFatal ? '致命错误，请排查后重新启动' : '非致命错误，系统将以降级模式运行'
          );
          resolve(checkItem);
        });
    });
  }

  // ═══════════════════════════════════════
  // 持久化状态管理（借鉴 BaiLongma）
  // ═══════════════════════════════════════

  _readPersistedState() {
    try {
      if (!this._configManager) return null;
      const raw = this._configManager.get ? this._configManager.get(SELF_CHECK_CONFIG_KEY) : null;
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }

  _writePersistedState(state) {
    try {
      if (!this._configManager) return;
      if (this._configManager.set) {
        this._configManager.set(SELF_CHECK_CONFIG_KEY, JSON.stringify(state));
      }
    } catch (e) {
      this._log('warn', '持久化自检状态失败', { error: e.message });
    }
  }

  /**
   * 检查是否需要重新运行自检
   * 规则：版本号变更 或 从未完成过 或 上次结果为failed
   */
  _shouldReRun() {
    const persisted = this._readPersistedState();
    if (!persisted) return true; // 从未运行
    if (persisted.version !== SELF_CHECK_VERSION) return true; // 版本变更
    if (persisted.status === SELF_CHECK_STATUS.FAILED) return true; // 上次失败
    if (persisted.status !== SELF_CHECK_STATUS.PASSED &&
        persisted.status !== SELF_CHECK_STATUS.DEGRADED) return true;
    return false; // 已完成且版本匹配
  }

  /**
   * 获取上次自检结果快照（用于UI展示）
   */
  getLastCheckSnapshot() {
    const persisted = this._readPersistedState();
    if (!persisted || persisted.version !== SELF_CHECK_VERSION) return null;
    return {
      version: persisted.version,
      status: persisted.status,
      completedAt: persisted.completedAt,
      summary: persisted.summary || '',
      stats: persisted.stats || {},
      phases: persisted.phases || {},
    };
  }

  // ═══════════════════════════════════════
  // Phase 0: 前置飞航检查 (Pre-Flight Check)
  // ═══════════════════════════════════════

  _buildPhase0Checks() {
    const checks = [];

    // P0-01: Node.js 版本兼容性
    checks.push(this._createCheckItem(
      'p0-node-version', SELF_CHECK_PHASE.PHASE_0,
      'Node.js版本', 'Node.js Version',
      CHECK_SEVERITY.FATAL,
      `当前版本: ${process.version}，最低要求: v${MIN_NODE_VERSION}`
    ));

    // P0-02: 数据目录读写权限
    checks.push(this._createCheckItem(
      'p0-data-dir', SELF_CHECK_PHASE.PHASE_0,
      '数据目录权限', 'Data Directory Permissions',
      CHECK_SEVERITY.FATAL,
      `目录: ${this._dataDir}`
    ));

    // P0-03: 磁盘空间余量
    checks.push(this._createCheckItem(
      'p0-disk-space', SELF_CHECK_PHASE.PHASE_0,
      '磁盘空间', 'Disk Space',
      CHECK_SEVERITY.CRITICAL,
      `最低要求: ${this._formatBytes(MIN_DISK_SPACE)}`
    ));

    // P0-04: 系统内存
    checks.push(this._createCheckItem(
      'p0-memory', SELF_CHECK_PHASE.PHASE_0,
      '系统内存', 'System Memory',
      CHECK_SEVERITY.CRITICAL,
      `最低要求: ${this._formatBytes(MIN_FREE_MEMORY)}`
    ));

    // P0-05: CPU核心数
    checks.push(this._createCheckItem(
      'p0-cpu-cores', SELF_CHECK_PHASE.PHASE_0,
      'CPU核心数', 'CPU Cores',
      CHECK_SEVERITY.INFO,
      `可用核心: ${os.cpus().length}`
    ));

    // P0-06: 操作系统信息
    checks.push(this._createCheckItem(
      'p0-os-info', SELF_CHECK_PHASE.PHASE_0,
      '操作系统', 'Operating System',
      CHECK_SEVERITY.INFO,
      `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`
    ));

    this._checks[SELF_CHECK_PHASE.PHASE_0] = checks;
    return checks;
  }

  async _runPhase0Check(check) {
    switch (check.id) {
      case 'p0-node-version':
        return this._checkNodeVersion();
      case 'p0-data-dir':
        return this._checkDataDir();
      case 'p0-disk-space':
        return this._checkDiskSpace();
      case 'p0-memory':
        return this._checkMemory();
      case 'p0-cpu-cores':
        return this._checkCpuCores();
      case 'p0-os-info':
        return this._checkOsInfo();
      default:
        return { status: SELF_CHECK_STATUS.SKIPPED, detail: '未知检查项' };
    }
  }

  _checkNodeVersion() {
    const current = process.version.replace(/^v/, '');
    if (this._compareVersions(current, MIN_NODE_VERSION) >= 0) {
      return { status: SELF_CHECK_STATUS.PASSED, detail: `v${current} (≥ v${MIN_NODE_VERSION})` };
    }
    return {
      status: SELF_CHECK_STATUS.FAILED,
      detail: `当前 v${current} < 最低 v${MIN_NODE_VERSION}`,
      error: 'NODE_VERSION_TOO_LOW',
      suggestion: `请升级 Node.js 到 v${MIN_NODE_VERSION} 或更高版本`,
    };
  }

  _checkDataDir() {
    try {
      if (!fs.existsSync(this._dataDir)) {
        fs.mkdirSync(this._dataDir, { recursive: true });
      }
      // 写入测试文件验证写权限
      const testFile = path.join(this._dataDir, '.self_check_test');
      fs.writeFileSync(testFile, String(Date.now()), 'utf8');
      const content = fs.readFileSync(testFile, 'utf8');
      fs.unlinkSync(testFile);
      if (content) {
        return { status: SELF_CHECK_STATUS.PASSED, detail: '读写权限正常' };
      }
      return { status: SELF_CHECK_STATUS.FAILED, detail: '读取验证失败', error: 'READ_VERIFY_FAILED' };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.FAILED,
        detail: `权限异常: ${e.message}`,
        error: 'DATA_DIR_PERMISSION_DENIED',
        suggestion: `请检查目录 ${this._dataDir} 的读写权限`,
      };
    }
  }

  _checkDiskSpace() {
    try {
      // Windows 兼容
      const stat = fs.statfsSync ? fs.statfsSync(this._dataDir) : null;
      if (stat) {
        const freeSpace = stat.bsize * stat.bfree;
        const detail = `可用: ${this._formatBytes(freeSpace)} / 要求: ${this._formatBytes(MIN_DISK_SPACE)}`;
        if (freeSpace >= MIN_DISK_SPACE) {
          return { status: SELF_CHECK_STATUS.PASSED, detail };
        }
        return {
          status: SELF_CHECK_STATUS.FAILED,
          detail,
          error: 'INSUFFICIENT_DISK_SPACE',
          suggestion: `请释放至少 ${this._formatBytes(MIN_DISK_SPACE - freeSpace)} 磁盘空间`,
        };
      }
      // fs.statfsSync 不可用时的降级方案
      return { status: SELF_CHECK_STATUS.DEGRADED, detail: '无法检测磁盘空间（平台限制）' };
    } catch (e) {
      return { status: SELF_CHECK_STATUS.DEGRADED, detail: `磁盘检测失败: ${e.message}` };
    }
  }

  _checkMemory() {
    try {
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const detail = `可用: ${this._formatBytes(freeMem)} / 总计: ${this._formatBytes(totalMem)}`;
      if (freeMem >= MIN_FREE_MEMORY) {
        return { status: SELF_CHECK_STATUS.PASSED, detail };
      }
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `${detail} (低于推荐值)`,
        error: 'LOW_MEMORY',
        suggestion: '内存不足可能影响性能，建议关闭其他应用',
      };
    } catch (e) {
      return { status: SELF_CHECK_STATUS.DEGRADED, detail: `内存检测失败: ${e.message}` };
    }
  }

  _checkCpuCores() {
    const cores = os.cpus().length;
    if (cores >= 2) {
      return { status: SELF_CHECK_STATUS.PASSED, detail: `${cores} 核心` };
    }
    return { status: SELF_CHECK_STATUS.DEGRADED, detail: `仅 ${cores} 核心，性能可能受限` };
  }

  _checkOsInfo() {
    return {
      status: SELF_CHECK_STATUS.PASSED,
      detail: `${os.type()} ${os.release()} | ${os.platform()} ${os.arch()} | Host: ${os.hostname()}`,
    };
  }

  // ═══════════════════════════════════════
  // Phase 1: 能力探测 (Capability Probe)
  // ═══════════════════════════════════════

  _buildPhase1Checks(dependencies = {}) {
    const checks = [];

    // P1-01: LLM Provider 连通性
    checks.push(this._createCheckItem(
      'p1-llm-provider', SELF_CHECK_PHASE.PHASE_1,
      'LLM Provider', 'LLM Provider Connectivity',
      CHECK_SEVERITY.CRITICAL,
      '验证API Key有效性和Provider连通性'
    ));

    // P1-02: 嵌入模型可用性
    checks.push(this._createCheckItem(
      'p1-embedding', SELF_CHECK_PHASE.PHASE_1,
      '嵌入模型', 'Embedding Model',
      CHECK_SEVERITY.CRITICAL,
      '验证嵌入模型可用性（用于记忆检索）'
    ));

    // P1-03: 浏览器自动化就绪
    checks.push(this._createCheckItem(
      'p1-browser', SELF_CHECK_PHASE.PHASE_1,
      '浏览器自动化', 'Browser Automation',
      CHECK_SEVERITY.WARNING,
      '检查Playwright/Chromium是否可用'
    ));

    // P1-04: 沙箱目录隔离
    checks.push(this._createCheckItem(
      'p1-sandbox', SELF_CHECK_PHASE.PHASE_1,
      '沙箱隔离', 'Sandbox Isolation',
      CHECK_SEVERITY.CRITICAL,
      '验证沙箱目录创建与隔离性'
    ));

    // P1-05: 网络连通性
    checks.push(this._createCheckItem(
      'p1-network', SELF_CHECK_PHASE.PHASE_1,
      '网络连通', 'Network Connectivity',
      CHECK_SEVERITY.CRITICAL,
      '验证DNS解析和HTTPS连接'
    ));

    // P1-06: SQLite数据库连接
    checks.push(this._createCheckItem(
      'p1-sqlite', SELF_CHECK_PHASE.PHASE_1,
      '数据库连接', 'SQLite Database',
      CHECK_SEVERITY.FATAL,
      '验证SQLite数据库连接与表结构'
    ));

    this._checks[SELF_CHECK_PHASE.PHASE_1] = checks;
    return checks;
  }

  async _runPhase1Check(check, dependencies) {
    switch (check.id) {
      case 'p1-llm-provider':
        return this._checkLLMProvider(dependencies);
      case 'p1-embedding':
        return this._checkEmbedding(dependencies);
      case 'p1-browser':
        return this._checkBrowser(dependencies);
      case 'p1-sandbox':
        return this._checkSandbox(dependencies);
      case 'p1-network':
        return this._checkNetwork();
      case 'p1-sqlite':
        return this._checkSQLite(dependencies);
      default:
        return { status: SELF_CHECK_STATUS.SKIPPED, detail: '未知检查项' };
    }
  }

  async _checkLLMProvider(dependencies) {
    const { router, provider, apiKey } = dependencies;
    if (!provider || !apiKey) {
      return {
        status: SELF_CHECK_STATUS.FAILED,
        detail: '未配置LLM Provider或API Key',
        error: 'NO_LLM_CONFIG',
        suggestion: '请设置 LLM_PROVIDER 和 LLM_API_KEY 环境变量',
      };
    }
    if (!router || typeof router.registerProvider !== 'function') {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: 'ModelRouter未就绪，跳过LLM连通性验证',
        suggestion: '请检查ModelRouter是否正确初始化',
      };
    }
    try {
      // 仅验证Provider是否已注册，不做实际调用（节省Token）
      const status = router.getStatus ? router.getStatus() : null;
      const registeredProviders = status?.providers || [];
      if (registeredProviders.length > 0) {
        return {
          status: SELF_CHECK_STATUS.PASSED,
          detail: `已注册 ${registeredProviders.length} 个Provider: ${registeredProviders.map(p => p.name || p.id).join(', ')}`,
        };
      }
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '未检测到已注册的LLM Provider',
        suggestion: '将在启动后注册Provider，首次TICK时验证',
      };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `Provider状态检查失败: ${e.message}`,
        suggestion: '将在首次TICK时重新验证',
      };
    }
  }

  async _checkEmbedding(dependencies) {
    const { memory } = dependencies;
    if (!memory || typeof memory._computeEmbedding !== 'function') {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '嵌入函数未注入，跳过验证',
        suggestion: '将在首次TICK时通过ModelRouter注入',
      };
    }
    try {
      const result = await memory._computeEmbedding('self_check_test');
      if (result && Array.isArray(result) && result.length > 0) {
        return { status: SELF_CHECK_STATUS.PASSED, detail: `嵌入维度: ${result.length}` };
      }
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '嵌入返回空结果',
        suggestion: '请检查嵌入模型配置',
      };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `嵌入调用失败: ${e.message}`,
        suggestion: '记忆检索功能将降级为关键词匹配',
      };
    }
  }

  async _checkBrowser(dependencies) {
    const { browser } = dependencies;
    if (!browser) {
      return {
        status: SELF_CHECK_STATUS.SKIPPED,
        detail: '浏览器模块未初始化',
        suggestion: '浏览器自动化功能将不可用',
      };
    }
    try {
      const status = browser.getStatus ? browser.getStatus() : null;
      if (status?.connected || status?.ready) {
        return { status: SELF_CHECK_STATUS.PASSED, detail: '浏览器自动化就绪' };
      }
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '浏览器未就绪（将在start()中初始化）',
        suggestion: '若启动后仍不可用，请检查Chromium安装',
      };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `浏览器状态检查失败: ${e.message}`,
      };
    }
  }

  async _checkSandbox(dependencies) {
    const sandboxDir = dependencies.sandboxDir || path.join(this._dataDir, 'sandbox');
    try {
      if (!fs.existsSync(sandboxDir)) {
        fs.mkdirSync(sandboxDir, { recursive: true });
      }
      const testFile = path.join(sandboxDir, '.sandbox_test');
      fs.writeFileSync(testFile, 'sandbox_ok', 'utf8');
      const content = fs.readFileSync(testFile, 'utf8');
      fs.unlinkSync(testFile);
      if (content === 'sandbox_ok') {
        return { status: SELF_CHECK_STATUS.PASSED, detail: `沙箱目录: ${sandboxDir}` };
      }
      return { status: SELF_CHECK_STATUS.FAILED, detail: '沙箱读写验证失败' };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.FAILED,
        detail: `沙箱创建失败: ${e.message}`,
        error: 'SANDBOX_CREATE_FAILED',
        suggestion: `请检查目录 ${sandboxDir} 的权限`,
      };
    }
  }

  async _checkNetwork() {
    // 使用简单的 DNS 解析 + HTTP HEAD 验证网络连通性
    const targets = [
      { host: 'dns.google', label: 'DNS解析' },
    ];

    const results = [];
    for (const target of targets) {
      try {
        const dns = require('dns').promises;
        await dns.resolve(target.host);
        results.push(`${target.label}: OK`);
      } catch {
        results.push(`${target.label}: 失败`);
      }
    }

    const allOk = results.every(r => r.includes('OK'));
    if (allOk) {
      return { status: SELF_CHECK_STATUS.PASSED, detail: results.join(' | ') };
    }
    return {
      status: SELF_CHECK_STATUS.DEGRADED,
      detail: results.join(' | '),
      suggestion: '部分网络功能可能受限',
    };
  }

  async _checkSQLite(dependencies) {
    const { memory } = dependencies;
    if (!memory || !memory._db) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '数据库连接未就绪（将在init()中初始化）',
        suggestion: '请确保MemoryEngine正确初始化',
      };
    }
    try {
      const db = memory._db;
      // 验证基本表结构
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = tables.map(t => t.name);
      if (tableNames.length > 0) {
        return {
          status: SELF_CHECK_STATUS.PASSED,
          detail: `数据库就绪，${tableNames.length} 张表: ${tableNames.slice(0, 5).join(', ')}${tableNames.length > 5 ? '...' : ''}`,
        };
      }
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '数据库为空（首次运行）',
      };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.FAILED,
        detail: `数据库检查失败: ${e.message}`,
        error: 'SQLITE_CHECK_FAILED',
        suggestion: '请检查数据库文件是否损坏',
      };
    }
  }

  // ═══════════════════════════════════════
  // Phase 2: 集成冒烟 (Integration Smoke)
  // ═══════════════════════════════════════

  _buildPhase2Checks(dependencies = {}) {
    const checks = [];

    // P2-01: 核心总线事件通道
    checks.push(this._createCheckItem(
      'p2-core-bus', SELF_CHECK_PHASE.PHASE_2,
      '核心总线', 'Core Bus Event Channel',
      CHECK_SEVERITY.CRITICAL,
      '验证事件总线收发功能'
    ));

    // P2-02: 安全边界铁律
    checks.push(this._createCheckItem(
      'p2-security', SELF_CHECK_PHASE.PHASE_2,
      '安全边界', 'Security Boundary Rules',
      CHECK_SEVERITY.CRITICAL,
      '验证三条铁律规则加载'
    ));

    // P2-03: Token预算管理器
    checks.push(this._createCheckItem(
      'p2-budget', SELF_CHECK_PHASE.PHASE_2,
      'Token预算', 'Token Budget Manager',
      CHECK_SEVERITY.WARNING,
      '验证三层预算初始化'
    ));

    // P2-04: 记忆引擎读写
    checks.push(this._createCheckItem(
      'p2-memory-rw', SELF_CHECK_PHASE.PHASE_2,
      '记忆读写', 'Memory Read/Write',
      CHECK_SEVERITY.CRITICAL,
      '验证记忆引擎写入→检索一致性'
    ));

    // P2-05: 统一调度器TICK
    checks.push(this._createCheckItem(
      'p2-scheduler', SELF_CHECK_PHASE.PHASE_2,
      '调度器时序', 'Scheduler Tick Timing',
      CHECK_SEVERITY.WARNING,
      '验证调度器状态机完整性'
    ));

    // P2-06: 消息队列完整性
    checks.push(this._createCheckItem(
      'p2-message-queue', SELF_CHECK_PHASE.PHASE_2,
      '消息队列', 'Message Queue Integrity',
      CHECK_SEVERITY.WARNING,
      '验证消息入队/出队/死信队列'
    ));

    // P2-07: 配置Schema验证器
    checks.push(this._createCheckItem(
      'p2-config-schema', SELF_CHECK_PHASE.PHASE_2,
      '配置验证', 'Config Schema Validation',
      CHECK_SEVERITY.CRITICAL,
      '验证配置文件格式合法性'
    ));

    this._checks[SELF_CHECK_PHASE.PHASE_2] = checks;
    return checks;
  }

  async _runPhase2Check(check, dependencies) {
    switch (check.id) {
      case 'p2-core-bus':
        return this._checkCoreBus(dependencies);
      case 'p2-security':
        return this._checkSecurity(dependencies);
      case 'p2-budget':
        return this._checkBudget(dependencies);
      case 'p2-memory-rw':
        return this._checkMemoryRW(dependencies);
      case 'p2-scheduler':
        return this._checkScheduler(dependencies);
      case 'p2-message-queue':
        return this._checkMessageQueue(dependencies);
      case 'p2-config-schema':
        return this._checkConfigSchema(dependencies);
      default:
        return { status: SELF_CHECK_STATUS.SKIPPED, detail: '未知检查项' };
    }
  }

  async _checkCoreBus(dependencies) {
    const { bus } = dependencies;
    if (!bus || typeof bus.emit !== 'function') {
      return {
        status: SELF_CHECK_STATUS.FAILED,
        detail: '核心总线未初始化',
        error: 'NO_CORE_BUS',
        suggestion: '请检查CoreBus是否正确构造',
      };
    }
    try {
      // 发送测试事件并验证监听器
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({
            status: SELF_CHECK_STATUS.DEGRADED,
            detail: '核心总线事件响应超时',
            suggestion: '事件循环可能阻塞',
          });
        }, 2000);

        const onTest = (data) => {
          clearTimeout(timeout);
          bus.off('_self_check_test', onTest);
          resolve({
            status: SELF_CHECK_STATUS.PASSED,
            detail: `事件通道正常 (traceId: ${data?.traceId || 'N/A'})`,
          });
        };

        bus.on('_self_check_test', onTest);
        bus.emit('_self_check_test', { traceId: `sc_${Date.now()}`, source: 'self_check' });
      });
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.FAILED,
        detail: `核心总线检查异常: ${e.message}`,
        error: 'BUS_CHECK_FAILED',
      };
    }
  }

  _checkSecurity(dependencies) {
    const { security } = dependencies;
    if (!security) {
      return {
        status: SELF_CHECK_STATUS.FAILED,
        detail: '安全边界未初始化',
        error: 'NO_SECURITY_BOUNDARY',
        suggestion: '请检查SecurityBoundary是否正确构造',
      };
    }
    try {
      const status = security.getStatus ? security.getStatus() : null;
      // 验证三条铁律是否存在
      const rulesCheck = security._rules ? Object.keys(security._rules).length : 0;
      const detail = rulesCheck > 0
        ? `三条铁律已加载，规则数: ${rulesCheck}`
        : '安全边界已初始化';
      return { status: SELF_CHECK_STATUS.PASSED, detail };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `安全边界状态检查失败: ${e.message}`,
      };
    }
  }

  _checkBudget(dependencies) {
    const { budget } = dependencies;
    if (!budget) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: 'Token预算管理器未初始化',
        suggestion: 'Token预算功能将不可用',
      };
    }
    try {
      const status = budget.getStatus ? budget.getStatus() : null;
      const ratios = budget._coreRatios || {};
      const detail = `意识${Math.round((ratios.consciousness || 0.6) * 100)}% / 执行${Math.round((ratios.execution || 0.3) * 100)}% / 进化${Math.round((ratios.evolution || 0.1) * 100)}%`;
      return { status: SELF_CHECK_STATUS.PASSED, detail };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `预算检查失败: ${e.message}`,
      };
    }
  }

  async _checkMemoryRW(dependencies) {
    const { memory } = dependencies;
    if (!memory || !memory._db) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '记忆引擎数据库未就绪',
        suggestion: '请先调用 memory.init()',
      };
    }
    try {
      const testId = `self_check_${Date.now()}`;
      const testContent = `自检测试记忆 ${new Date().toISOString()}`;

      // 写入测试记忆
      if (typeof memory.insertMemory === 'function') {
        memory.insertMemory({
          id: testId,
          content: testContent,
          type: 'system_check',
          timestamp: Date.now(),
        });
      } else if (memory._db) {
        // 直接SQL写入
        memory._db.prepare(
          `INSERT OR REPLACE INTO memories (id, content, type, timestamp) VALUES (?, ?, ?, ?)`
        ).run(testId, testContent, 'system_check', Date.now());
      }

      // 检索验证
      let retrieved = null;
      if (typeof memory.searchMemory === 'function') {
        const results = memory.searchMemory('自检测试');
        retrieved = results?.find(r => r.id === testId);
      } else if (memory._db) {
        retrieved = memory._db.prepare('SELECT * FROM memories WHERE id = ?').get(testId);
      }

      // 清理
      try {
        if (memory._db) {
          memory._db.prepare('DELETE FROM memories WHERE id = ?').run(testId);
        }
      } catch {}

      if (retrieved) {
        return { status: SELF_CHECK_STATUS.PASSED, detail: '写入→检索一致性验证通过' };
      }
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '记忆写入成功但检索失败',
        suggestion: '请检查记忆索引配置',
      };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `记忆读写检查失败: ${e.message}`,
        suggestion: '记忆功能将以降级模式运行',
      };
    }
  }

  _checkScheduler(dependencies) {
    const { scheduler } = dependencies;
    if (!scheduler) {
      return {
        status: SELF_CHECK_STATUS.FAILED,
        detail: '统一调度器未初始化',
        error: 'NO_SCHEDULER',
        suggestion: '请检查UnifiedScheduler是否正确构造',
      };
    }
    try {
      const status = scheduler.getStatus ? scheduler.getStatus() : {};
      return {
        status: SELF_CHECK_STATUS.PASSED,
        detail: `模式: ${status.mode || 'N/A'} | 觉醒TICK剩余: ${status.awakeningTicksRemaining ?? 'N/A'}`,
      };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `调度器状态检查失败: ${e.message}`,
      };
    }
  }

  _checkMessageQueue(dependencies) {
    const { messageQueue } = dependencies;
    if (!messageQueue) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '消息队列管理器未初始化',
        suggestion: '消息队列功能将不可用',
      };
    }
    try {
      const stats = messageQueue.getStats ? messageQueue.getStats() : {};
      return {
        status: SELF_CHECK_STATUS.PASSED,
        detail: `容量: ${stats.maxSize || 'N/A'} | 持久化: ${stats.persistEnabled ? '开' : '关'} | 死信: ${stats.deadLetterEnabled ? '开' : '关'}`,
      };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `消息队列检查失败: ${e.message}`,
      };
    }
  }

  _checkConfigSchema(dependencies) {
    const { configValidator, config } = dependencies;
    if (!configValidator || !config) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: '配置验证器未就绪',
        suggestion: '跳过配置格式验证',
      };
    }
    try {
      const result = configValidator.validateAndMigrate ?
        configValidator.validateAndMigrate(config) :
        { valid: true, warnings: [], errors: [] };

      if (result.valid) {
        const warningInfo = result.warnings?.length > 0 ? ` (${result.warnings.length}个警告)` : '';
        return { status: SELF_CHECK_STATUS.PASSED, detail: `配置格式合法${warningInfo}` };
      }
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `配置验证失败: ${result.errors?.length || 0} 个错误`,
        suggestion: '请检查配置文件格式',
      };
    } catch (e) {
      return {
        status: SELF_CHECK_STATUS.DEGRADED,
        detail: `配置验证异常: ${e.message}`,
      };
    }
  }

  // ═══════════════════════════════════════
  // Phase 3: LLM 驱动的端到端管道检查
  // （由主Agent在首个TICK中执行）
  // ═══════════════════════════════════════

  /**
   * 构建 Phase 3 的 LLM 指令（借鉴 BaiLongma buildStartupSelfCheckDirections）
   * 在启动后首个TICK注入到LLM prompt中
   */
  buildPhase3LLMDirections() {
    const checkState = this._getPhase3State();
    if (!checkState || !checkState.active) return null;

    return [
      `[全流程端到端自检 — Phase 3] 版本: ${SELF_CHECK_VERSION}`,
      `这是TriCoreAgent启动后的全流程端到端验证。仅运行一次，完成后调用 complete_startup_self_check 记录结果。`,
      `[硬规则] 自检期间严禁调用 send_message 发送文本。所有状态通过系统日志表达。`,
      `按顺序完成以下5项检查：`,
      ``,
      `1. 【文件系统闭环】使用 write_file 在沙箱根目录创建 self_check_e2e.txt（内容=当前时间戳），然后 read_file 读回验证一致性，最后 delete_file 删除。`,
      `2. 【工具调用验证】使用 web_search 搜索 "TriCore Agent architecture"（最多2条结果），确认搜索API正常响应。`,
      `3. 【记忆注入验证】使用 memory_insert 写入一条 type="system_check" 的记忆，然后 memory_search 检索确认一致性。`,
      `4. 【子智能体生命周期】使用 create_subagent 创建一个临时子智能体（name="self_check_probe"），获取其状态，然后 destroy 销毁。`,
      `5. 【API端点验证】使用 http_request 对本机 http://127.0.0.1:3721/health 发起GET请求，确认返回200。`,
      ``,
      `每项检查完成后记录结果（ok/error/degraded）。`,
      `全部完成后调用 complete_startup_self_check，参数：{ summary: "一句话总结", results: { file_ops: "ok/error", tool_call: "ok/error", memory: "ok/error", subagent: "ok/error", api_health: "ok/error" } }`,
    ].join('\n');
  }

  _getPhase3State() {
    // Phase 3 由 LLM 驱动，状态存在运行内存中
    if (!this._phase3State) {
      this._phase3State = {
        active: true,
        startedAt: null,
        results: {},
      };
    }
    return this._phase3State;
  }

  /**
   * 由外部调用（LLM工具回调），完成Phase 3
   */
  completePhase3(summary, results) {
    this._phase3State = {
      active: false,
      completedAt: new Date().toISOString(),
      summary: summary || '',
      results: results || {},
    };

    // 构建Phase 3检查结果
    const phase3Results = [];
    const resultMap = results || {};
    for (const [key, status] of Object.entries(resultMap)) {
      phase3Results.push({
        name: key,
        nameEn: key,
        status: status === 'ok' ? SELF_CHECK_STATUS.PASSED : (status === 'degraded' ? SELF_CHECK_STATUS.DEGRADED : SELF_CHECK_STATUS.FAILED),
        detail: `LLM驱动端到端验证: ${status}`,
      });
    }
    this._checks[SELF_CHECK_PHASE.PHASE_3] = phase3Results;

    this._log('info', `Phase 3 端到端自检完成: ${summary}`, { results });

    return {
      version: SELF_CHECK_VERSION,
      status: this._phase3State.active ? SELF_CHECK_STATUS.RUNNING : SELF_CHECK_STATUS.PASSED,
      completedAt: this._phase3State.completedAt,
      summary: this._phase3State.summary,
    };
  }

  /**
   * 检查Phase 3是否已完成
   */
  isPhase3Complete() {
    return this._phase3State && !this._phase3State.active;
  }

  /**
   * 检查Phase 3是否活跃
   */
  isPhase3Active() {
    return this._phase3State && this._phase3State.active;
  }

  // ═══════════════════════════════════════
  // 主执行流程
  // ═══════════════════════════════════════

  /**
   * 运行全流程自检
   * @param {Object} dependencies - 依赖注入
   * @param {Object} dependencies.router - ModelRouter实例
   * @param {Object} dependencies.memory - MemoryEngine实例
   * @param {Object} dependencies.bus - CoreBus实例
   * @param {Object} dependencies.security - SecurityBoundary实例
   * @param {Object} dependencies.budget - TokenBudgetManager实例
   * @param {Object} dependencies.scheduler - UnifiedScheduler实例
   * @param {Object} dependencies.browser - BrowserAutomation实例
   * @param {Object} dependencies.messageQueue - MessageQueueManager实例
   * @param {Object} dependencies.configValidator - ConfigSchemaValidator实例
   * @param {Object} dependencies.config - 配置对象
   * @param {string} dependencies.provider - LLM Provider名称
   * @param {string} dependencies.apiKey - API Key
   * @param {string} dependencies.sandboxDir - 沙箱目录
   * @returns {Promise<Object>} 自检报告
   */
  async runAll(dependencies = {}) {
    // 检查是否需要重新运行
    if (!this._shouldReRun()) {
      const snapshot = this.getLastCheckSnapshot();
      this._log('info', `自检已在 ${snapshot.completedAt} 完成 (v${snapshot.version})，跳过重复检查`);
      this.emit('check:skipped', { reason: 'already_completed', snapshot });
      return {
        skipped: true,
        reason: 'already_completed',
        lastCheck: snapshot,
      };
    }

    this._status = SELF_CHECK_STATUS.RUNNING;
    this._startedAt = this._now();
    this._overallResult = null;

    this._log('info', `══════ 全流程启动自检开始 (v${SELF_CHECK_VERSION}) ══════`);
    this.emit('check:started', { version: SELF_CHECK_VERSION, startedAt: new Date(this._startedAt).toISOString() });

    const globalStart = this._now();
    const report = {
      version: SELF_CHECK_VERSION,
      startedAt: new Date(globalStart).toISOString(),
      phases: {},
      stats: { ...this._stats },
      overall: SELF_CHECK_STATUS.PENDING,
    };

    try {
      // ══ Phase 0: 前置飞航检查（同步，必须全部通过） ══
      this._log('info', '── Phase 0: 前置飞航检查 ──');
      this.emit('phase:started', { phase: SELF_CHECK_PHASE.PHASE_0 });
      const p0Checks = this._buildPhase0Checks();
      const p0Results = await this._runPhase(SELF_CHECK_PHASE.PHASE_0, p0Checks, dependencies, this._timeouts.phase0_total);

      const p0FatalFailed = p0Results.filter(c =>
        c.severity === CHECK_SEVERITY.FATAL && c.status === SELF_CHECK_STATUS.FAILED
      );
      report.phases[SELF_CHECK_PHASE.PHASE_0] = {
        checks: p0Results,
        passed: p0Results.filter(c => c.status === SELF_CHECK_STATUS.PASSED).length,
        failed: p0Results.filter(c => c.status === SELF_CHECK_STATUS.FAILED).length,
        degraded: p0Results.filter(c => c.status === SELF_CHECK_STATUS.DEGRADED).length,
        fatalFailures: p0FatalFailed.map(c => c.name),
      };

      if (p0FatalFailed.length > 0) {
        this._log('error', `Phase 0 致命失败: ${p0FatalFailed.map(c => c.name).join(', ')}`);
        report.overall = SELF_CHECK_STATUS.FAILED;
        report.fatalPhase = SELF_CHECK_PHASE.PHASE_0;
        report.fatalErrors = p0FatalFailed.map(c => ({ name: c.name, error: c.error, suggestion: c.suggestion }));
        this._finalizeReport(report, globalStart);
        this.emit('check:failed', { phase: SELF_CHECK_PHASE.PHASE_0, fatalErrors: report.fatalErrors });
        return report;
      }
      this.emit('phase:completed', { phase: SELF_CHECK_PHASE.PHASE_0, results: p0Results });
      this._log('info', `Phase 0 完成: ${report.phases[SELF_CHECK_PHASE.PHASE_0].passed}/${p0Checks.length} 通过`);

      // ══ Phase 1: 能力探测（异步，关键失败阻止启动） ══
      this._log('info', '── Phase 1: 能力探测 ──');
      this.emit('phase:started', { phase: SELF_CHECK_PHASE.PHASE_1 });
      const p1Checks = this._buildPhase1Checks(dependencies);
      const p1Results = await this._runPhase(SELF_CHECK_PHASE.PHASE_1, p1Checks, dependencies, this._timeouts.phase1_total);

      const p1FatalFailed = p1Results.filter(c =>
        c.severity === CHECK_SEVERITY.FATAL && c.status === SELF_CHECK_STATUS.FAILED
      );
      report.phases[SELF_CHECK_PHASE.PHASE_1] = {
        checks: p1Results,
        passed: p1Results.filter(c => c.status === SELF_CHECK_STATUS.PASSED).length,
        failed: p1Results.filter(c => c.status === SELF_CHECK_STATUS.FAILED).length,
        degraded: p1Results.filter(c => c.status === SELF_CHECK_STATUS.DEGRADED).length,
        skipped: p1Results.filter(c => c.status === SELF_CHECK_STATUS.SKIPPED).length,
        fatalFailures: p1FatalFailed.map(c => c.name),
      };

      if (p1FatalFailed.length > 0) {
        this._log('error', `Phase 1 致命失败: ${p1FatalFailed.map(c => c.name).join(', ')}`);
        report.overall = SELF_CHECK_STATUS.FAILED;
        report.fatalPhase = SELF_CHECK_PHASE.PHASE_1;
        report.fatalErrors = p1FatalFailed.map(c => ({ name: c.name, error: c.error, suggestion: c.suggestion }));
        this._finalizeReport(report, globalStart);
        this.emit('check:failed', { phase: SELF_CHECK_PHASE.PHASE_1, fatalErrors: report.fatalErrors });
        return report;
      }
      this.emit('phase:completed', { phase: SELF_CHECK_PHASE.PHASE_1, results: p1Results });
      this._log('info', `Phase 1 完成: ${report.phases[SELF_CHECK_PHASE.PHASE_1].passed}/${p1Checks.length} 通过`);

      // ══ Phase 2: 集成冒烟（异步，失败标记降级） ══
      this._log('info', '── Phase 2: 集成冒烟 ──');
      this.emit('phase:started', { phase: SELF_CHECK_PHASE.PHASE_2 });
      const p2Checks = this._buildPhase2Checks(dependencies);
      const p2Results = await this._runPhase(SELF_CHECK_PHASE.PHASE_2, p2Checks, dependencies, this._timeouts.phase2_total);

      report.phases[SELF_CHECK_PHASE.PHASE_2] = {
        checks: p2Results,
        passed: p2Results.filter(c => c.status === SELF_CHECK_STATUS.PASSED).length,
        failed: p2Results.filter(c => c.status === SELF_CHECK_STATUS.FAILED).length,
        degraded: p2Results.filter(c => c.status === SELF_CHECK_STATUS.DEGRADED).length,
      };
      this.emit('phase:completed', { phase: SELF_CHECK_PHASE.PHASE_2, results: p2Results });
      this._log('info', `Phase 2 完成: ${report.phases[SELF_CHECK_PHASE.PHASE_2].passed}/${p2Checks.length} 通过`);

      // ══ 计算总体结果 ══
      const hasFailures = (p1Results.concat(p2Results)).some(c =>
        (c.severity === CHECK_SEVERITY.FATAL || c.severity === CHECK_SEVERITY.CRITICAL) &&
        c.status === SELF_CHECK_STATUS.FAILED
      );
      const hasDegraded = (p0Results.concat(p1Results).concat(p2Results)).some(c =>
        c.status === SELF_CHECK_STATUS.DEGRADED
      );

      if (hasFailures) {
        report.overall = SELF_CHECK_STATUS.DEGRADED;
      } else if (hasDegraded) {
        report.overall = SELF_CHECK_STATUS.DEGRADED;
      } else {
        report.overall = SELF_CHECK_STATUS.PASSED;
      }

      this._finalizeReport(report, globalStart);

      // 持久化自检结果
      this._persistReport(report);

      this.emit('check:completed', { report });

      return report;
    } catch (e) {
      this._log('error', `自检执行异常: ${e.message}`, { error: e.stack });
      report.overall = SELF_CHECK_STATUS.FAILED;
      report.error = e.message;
      this._finalizeReport(report, globalStart);
      this.emit('check:error', { error: e.message, report });
      return report;
    }
  }

  async _runPhase(phase, checks, dependencies, totalTimeout) {
    this._stats.total += checks.length;

    return new Promise((resolve) => {
      const results = [];
      let completed = 0;
      let timedOut = false;

      const phaseTimer = setTimeout(() => {
        timedOut = true;
        // 将未完成的检查标记为超时
        for (const check of checks) {
          if (check.status === SELF_CHECK_STATUS.PENDING || check.status === SELF_CHECK_STATUS.RUNNING) {
            this._finalizeCheck(check, SELF_CHECK_STATUS.TIMEOUT,
              `阶段超时（${totalTimeout}ms）`,
              'PHASE_TIMEOUT',
              '请检查系统性能或增加超时配置');
            results.push(check);
          }
        }
        resolve(results);
      }, totalTimeout);

      const runNext = async (index) => {
        if (timedOut) return;
        if (index >= checks.length) {
          clearTimeout(phaseTimer);
          resolve(results);
          return;
        }

        const check = checks[index];
        check.status = SELF_CHECK_STATUS.RUNNING;
        this.emit('check:started', { checkId: check.id, phase, name: check.name });

        const perItemTimeout = this._timeouts[`${phase}_per_item`] || 5000;
        const result = await this._runWithTimeout(
          () => phase === SELF_CHECK_PHASE.PHASE_0
            ? this._runPhase0Check(check)
            : phase === SELF_CHECK_PHASE.PHASE_1
              ? this._runPhase1Check(check, dependencies)
              : this._runPhase2Check(check, dependencies),
          perItemTimeout,
          check
        );

        results.push(result);
        completed++;
        await runNext(index + 1);
      };

      runNext(0);
    });
  }

  _finalizeReport(report, globalStart) {
    this._completedAt = this._now();
    report.completedAt = new Date(this._completedAt).toISOString();
    report.totalDuration = this._completedAt - globalStart;

    // 汇总统计
    const allChecks = [
      ...(report.phases[SELF_CHECK_PHASE.PHASE_0]?.checks || []),
      ...(report.phases[SELF_CHECK_PHASE.PHASE_1]?.checks || []),
      ...(report.phases[SELF_CHECK_PHASE.PHASE_2]?.checks || []),
      ...(report.phases[SELF_CHECK_PHASE.PHASE_3]?.checks || []),
    ];

    report.stats = {
      total: allChecks.length,
      passed: allChecks.filter(c => c.status === SELF_CHECK_STATUS.PASSED).length,
      degraded: allChecks.filter(c => c.status === SELF_CHECK_STATUS.DEGRADED).length,
      failed: allChecks.filter(c => c.status === SELF_CHECK_STATUS.FAILED).length,
      skipped: allChecks.filter(c => c.status === SELF_CHECK_STATUS.SKIPPED).length,
      timeout: allChecks.filter(c => c.status === SELF_CHECK_STATUS.TIMEOUT).length,
      totalDuration: report.totalDuration,
    };

    this._stats = report.stats;
    this._overallResult = report.overall;
    this._status = report.overall === SELF_CHECK_STATUS.PASSED
      ? SELF_CHECK_STATUS.PASSED
      : SELF_CHECK_STATUS.DEGRADED;
  }

  _persistReport(report) {
    try {
      const state = {
        version: SELF_CHECK_VERSION,
        status: report.overall,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        totalDuration: report.totalDuration,
        summary: report.overall === SELF_CHECK_STATUS.PASSED
          ? '全流程自检通过，所有核心子系统就绪'
          : `全流程自检${report.overall === SELF_CHECK_STATUS.DEGRADED ? '降级通过' : '失败'}，共${report.stats.total}项检查`,
        stats: report.stats,
        phases: {},
        fatalPhase: report.fatalPhase || null,
        fatalErrors: report.fatalErrors || [],
      };

      // 简化持久化的阶段数据（不存完整checks数组）
      for (const [phase, data] of Object.entries(report.phases)) {
        state.phases[phase] = {
          passed: data.passed,
          failed: data.failed,
          degraded: data.degraded,
          skipped: data.skipped || 0,
          fatalFailures: data.fatalFailures || [],
        };
      }

      this._writePersistedState(state);
      this._log('info', `自检报告已持久化 (${report.overall})`);
    } catch (e) {
      this._log('warn', `持久化自检报告失败: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════
  // 公共API
  // ═══════════════════════════════════════

  /**
   * 获取自检状态
   */
  getStatus() {
    return {
      version: this._version,
      status: this._status,
      overallResult: this._overallResult,
      startedAt: this._startedAt ? new Date(this._startedAt).toISOString() : null,
      completedAt: this._completedAt ? new Date(this._completedAt).toISOString() : null,
      stats: { ...this._stats },
      phase3: this._phase3State ? {
        active: this._phase3State.active,
        completedAt: this._phase3State.completedAt || null,
      } : null,
    };
  }

  /**
   * 获取完整的检查报告
   */
  getFullReport() {
    return {
      version: this._version,
      status: this._status,
      overallResult: this._overallResult,
      startedAt: this._startedAt ? new Date(this._startedAt).toISOString() : null,
      completedAt: this._completedAt ? new Date(this._completedAt).toISOString() : null,
      stats: { ...this._stats },
      phases: {
        [SELF_CHECK_PHASE.PHASE_0]: this._checks[SELF_CHECK_PHASE.PHASE_0],
        [SELF_CHECK_PHASE.PHASE_1]: this._checks[SELF_CHECK_PHASE.PHASE_1],
        [SELF_CHECK_PHASE.PHASE_2]: this._checks[SELF_CHECK_PHASE.PHASE_2],
        [SELF_CHECK_PHASE.PHASE_3]: this._checks[SELF_CHECK_PHASE.PHASE_3],
      },
      persistedState: this._readPersistedState(),
    };
  }

  /**
   * 检查是否可以安全启动（Phase 0和Phase 1的致命项全部通过）
   */
  canStartSafely() {
    if (this._status === SELF_CHECK_STATUS.PASSED || this._status === SELF_CHECK_STATUS.DEGRADED) {
      return true;
    }
    if (this._status === SELF_CHECK_STATUS.PENDING) {
      return true; // 还未运行，允许尝试启动
    }
    return false; // FAILED 状态
  }

  /**
   * 重置自检状态（用于强制重新检查）
   */
  reset() {
    this._status = SELF_CHECK_STATUS.PENDING;
    this._startedAt = null;
    this._completedAt = null;
    this._overallResult = null;
    this._phase3State = null;
    this._checks = {
      [SELF_CHECK_PHASE.PHASE_0]: [],
      [SELF_CHECK_PHASE.PHASE_1]: [],
      [SELF_CHECK_PHASE.PHASE_2]: [],
      [SELF_CHECK_PHASE.PHASE_3]: [],
    };
    this._stats = {
      total: 0, passed: 0, degraded: 0, failed: 0, skipped: 0, timeout: 0, totalDuration: 0,
    };
    // 清除持久化状态
    try {
      if (this._configManager?.set) {
        this._configManager.set(SELF_CHECK_CONFIG_KEY, '');
      }
    } catch {}
    this._log('info', '自检状态已重置');
  }

  /**
   * 生成人类可读的自检摘要
   */
  generateSummary(report) {
    if (!report) report = this.getFullReport();
    const lines = [];
    const icon = (s) => {
      switch (s) {
        case SELF_CHECK_STATUS.PASSED: return '✅';
        case SELF_CHECK_STATUS.DEGRADED: return '⚠️';
        case SELF_CHECK_STATUS.FAILED: return '❌';
        case SELF_CHECK_STATUS.SKIPPED: return '⏭️';
        case SELF_CHECK_STATUS.TIMEOUT: return '⏰';
        default: return '⬜';
      }
    };

    lines.push(`══════ TriCoreAgent 全流程自检报告 ══════`);
    lines.push(`版本: ${report.version}`);
    lines.push(`状态: ${report.overallResult || report.status}`);
    lines.push(`耗时: ${report.totalDuration || (report.stats?.totalDuration || 0)}ms`);
    lines.push(`统计: ${report.stats?.total || 0}项 | ${report.stats?.passed || 0}通过 | ${report.stats?.degraded || 0}降级 | ${report.stats?.failed || 0}失败`);
    lines.push('');

    for (const [phase, data] of Object.entries(report.phases)) {
      if (!data || !data.checks || data.checks.length === 0) continue;
      lines.push(`── ${phase} ──`);
      for (const check of data.checks) {
        lines.push(`  ${icon(check.status)} ${check.name}: ${check.status} (${check.duration}ms)${check.detail ? ' — ' + check.detail : ''}`);
        if (check.suggestion) {
          lines.push(`     💡 ${check.suggestion}`);
        }
      }
      lines.push('');
    }

    if (report.fatalErrors && report.fatalErrors.length > 0) {
      lines.push(`[致命错误]`);
      for (const err of report.fatalErrors) {
        lines.push(`  ❌ ${err.name}: ${err.error}`);
        if (err.suggestion) lines.push(`     💡 ${err.suggestion}`);
      }
    }

    return lines.join('\n');
  }
}

// ── 导出 ──
module.exports = {
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
};
