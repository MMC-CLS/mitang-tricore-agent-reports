/**
 * 蜜糖 TriCore Agent — Agent外观类 (Agent Facade)
 *
 * 提供统一的公共API，内部路由到注册模块。
 * 解决 index.js 中 120+ 个薄代理方法的问题。
 *
 * 设计原则：
 *   - 路由声明式：通过 _routes 映射声明每个公共方法的目标模块和方法
 *   - 自动代理：对于简单的一对一代理，使用 _autoProxy 自动生成
 *   - 权限集成：需要安全边界检查的方法在路由定义中声明 auth 参数
 *   - 新功能添加路径：创建模块 → 注册到 registry → 在此添加路由
 *
 * 使用方式：
 *   const registry = new ModuleRegistry();
 *   const facade = new AgentFacade(registry);
 *   facade.sendMessage(userId, content, meta); // 自动路由到 consciousness.processUserMessage
 */

'use strict';

class AgentFacade {
  /**
   * @param {ModuleRegistry} registry - 模块注册表
   * @param {Object} options
   * @param {Object} options.security - 安全边界实例（用于需要授权的操作）
   * @param {Object} options.budget - Token预算实例（用于需要预算检查的操作）
   * @param {Object} options.logger - 日志记录器
   */
  constructor(registry, options = {}) {
    this._registry = registry;
    this._security = options.security || null;
    this._budget = options.budget || null;
    this._logger = options.logger || null;

    // 自动代理映射：方法名 → [模块名, 方法名]
    // 对于简单的一对一代理，只需在此声明即可自动生成方法
    this._buildAutoProxies();
  }

  /**
   * 构建所有自动代理方法
   */
  _buildAutoProxies() {
    const proxyDefs = this._getProxyDefinitions();
    for (const [methodName, [moduleName, targetMethod, authConfig]] of Object.entries(proxyDefs)) {
      this._createProxyMethod(methodName, moduleName, targetMethod, authConfig);
    }
  }

  /**
   * 声明所有需要自动代理的方法
   * 格式：方法名 → [模块名, 目标方法, 可选的授权配置]
   *
   * 授权配置格式（可选）：
   *   { capability: '...', coreIdentity: '...', budgetCore: '...', budgetTokens: N, budgetCallType: '...' }
   */
  _getProxyDefinitions() {
    return {
      // ═══ 消息接口 ═══
      sendMessage: ['messageProcessor', 'receive'],

      // ═══ 记忆接口 ═══
      searchMemories: ['memory', 'search'],
      searchSkills: ['memory', 'searchSkills'],
      auditSkill: ['evolution', 'auditSkill'],

      // ═══ 插件接口 ═══
      installPlugin: ['execution', 'installPlugin', {
        capability: 'EXECUTE_TASK',
        coreIdentity: 'EXECUTION',
      }],

      // ═══ 社交接口 ═══
      configureSocial: ['social', 'configure'],
      dispatchMessage: ['social', 'dispatch', {
        capability: 'SEND_MESSAGE',
        coreIdentity: 'EXECUTION',
      }],

      // ═══ 语音接口 ═══
      recognizeSpeech: ['voice', 'recognize'],
      synthesizeSpeech: ['voice', 'synthesize'],

      // ═══ 浏览器接口 ═══
      browserAction: ['browser', 'execute', {
        capability: 'BROWSER_CONTROL',
        coreIdentity: 'EXECUTION',
      }],

      // ═══ 协作层 ═══
      registerAgent: ['coordination', 'registerAgent'],
      discoverAgents: ['coordination', 'discoverAgents'],
      createCoordinationTask: ['coordination', 'createCoordinationTask', {
        budgetCore: 'execution', budgetTokens: 1000, budgetCallType: 'coordination_task',
      }],

      // ═══ 技能市场 ═══
      publishSkill: ['skillMarket', 'publishSkill', {
        capability: 'PUBLISH_SKILL',
        coreIdentity: 'EVOLUTION',
      }],
      searchMarketSkills: ['skillMarket', 'searchSkills'],
      downloadSkill: ['skillMarket', 'downloadSkill', {
        capability: 'EXECUTE_TASK',
        coreIdentity: 'EXECUTION',
      }],
      rateSkill: ['skillMarket', 'rateSkill'],

      // ═══ 配置 ═══
      getConfig: ['config', 'get'],
      setConfig: ['config', 'set'],

      // ═══ 治理层 v2.0 ═══
      assignProvider: ['router', 'assignProvider'],
      assignProviders: ['router', 'assignProviders'],
      getDiagnostics: ['bus', 'getDiagnostics'],
      getBudgetStatus: ['budget', 'getStatus'],
      getSecurityLog: ['security', 'queryAuditLog'],
      setHourlyBudget: ['budget', 'setHourlyBudget'],
      setSafeMode: ['security', 'setSafeMode'],
      getTrace: ['bus', 'getTrace'],
      getPerformanceReport: ['router', 'getPerformanceReport'],

      // ═══ Tool Calling ═══
      registerTool: ['toolCalling', 'registerTool'],
      registerTools: ['toolCalling', 'registerTools'],
      executeTool: ['toolCalling', 'execute'],
      executeToolsParallel: ['toolCalling', 'executeParallel'],
      executeToolsSequential: ['toolCalling', 'executeSequential'],
      selectTools: ['toolCalling', 'selectTools'],
      getToolDefinitions: ['toolCalling', 'getToolDefinitions'],
      clearToolCache: ['toolCalling', 'clearCache'],

      // ═══ RAG ═══
      addDocument: ['rag', 'addDocument'],
      loadDocument: ['rag', 'loadFile'],
      loadURLDocument: ['rag', 'loadURL'],
      ragRetrieve: ['rag', 'retrieve'],
      ragAsk: ['rag', 'ask'],
      removeDocument: ['rag', 'removeDocument'],
      listRagDocuments: ['rag', 'listDocuments'],

      // ═══ Multi-Modal ═══
      analyzeImage: ['multimodal', 'analyzeImage'],
      compareImages: ['multimodal', 'compareImages'],
      captureScreen: ['multimodal', 'captureScreen'],
      ocr: ['multimodal', 'ocr'],
      parseDocument: ['multimodal', 'parseDocument'],
      visualQA: ['multimodal', 'visualQA'],

      // ═══ RBAC ═══
      createUser: ['rbac', 'createUser'],
      authenticate: ['rbac', 'authenticate'],
      logout: ['rbac', 'logout'],
      validateToken: ['rbac', 'validateToken'],
      hasPermission: ['rbac', 'hasPermission'],
      createRole: ['rbac', 'createRole'],
      assignRole: ['rbac', 'assignRole'],
      revokeRole: ['rbac', 'revokeRole'],
      generateApiKey: ['rbac', 'generateApiKey'],
      validateApiKey: ['rbac', 'validateApiKey'],
      grantTemporaryPermission: ['rbac', 'grantTemporaryPermission'],

      // ═══ Audit ═══
      auditLog: ['audit', 'log'],
      trackConfigChange: ['audit', 'trackConfigChange'],
      trackPermissionChange: ['audit', 'trackPermissionChange'],
      generateComplianceReport: ['audit', 'generateComplianceReport'],
      exportAuditLogs: ['audit', 'exportLogs'],
      queryAuditLogs: ['audit', 'query'],

      // ═══ Encryption ═══
      initializeEncryption: ['encryption', 'initialize'],
      encrypt: ['encryption', 'encrypt'],
      decrypt: ['encryption', 'decrypt'],
      encryptJSON: ['encryption', 'encryptJSON'],
      decryptJSON: ['encryption', 'decryptJSON'],
      sign: ['encryption', 'sign'],
      verify: ['encryption', 'verify'],
      generateToken: ['encryption', 'generateToken'],
      rotateEncryptionKey: ['encryption', 'rotateKey'],
      maskPhone: ['encryption', 'maskPhone'],
      maskEmail: ['encryption', 'maskEmail'],

      // ═══ 配置验证 ═══
      validateConfig: ['configValidator', 'validate'],
      validateAndMigrateConfig: ['configValidator', 'validateAndMigrate'],
      getConfigSchema: ['configValidator', 'getSchema'],

      // ═══ 消息队列 ═══
      getMessageQueueStats: ['messageQueue', 'getStats'],
      getDeadLetters: ['messageQueue', 'getDeadLetters'],
      replayDeadLetter: ['messageQueue', 'replayDeadLetter'],
      replayAllDeadLetters: ['messageQueue', 'replayAllDeadLetters'],
      clearDeadLetters: ['messageQueue', 'clearDeadLetters'],

      // ═══ 日志 ═══
      setLogLevel: ['logger', 'setLevel'],
      getLogLevel: ['logger', 'getLevel'],

      // ═══ 性能监控 ═══
      getFullPerformanceReport: ['perfMonitor', 'getReport'],
      getResourceSnapshot: ['perfMonitor', 'getResourceSnapshot'],
      runHealthChecks: ['perfMonitor', 'runHealthChecks'],
      registerHealthCheck: ['perfMonitor', 'registerHealthCheck'],

      // ═══ TICK并发 ═══
      getTickConcurrencyStats: ['tickConcurrency', 'getStats'],
      resetTickCircuitBreaker: ['tickConcurrency', 'resetCircuitBreaker'],

      // ═══ 分布式锁 ═══
      getDistLockStats: ['distLock', 'getStats'],

      // ═══ 优雅重启 ═══
      getGracefulRestartStatus: ['gracefulRestart', 'getStatus'],

      // ═══ 速率限制 ═══
      checkRateLimit: ['rateLimiter', 'check'],
      configureRateLimit: ['rateLimiter', 'configureRule'],

      // ═══ Prometheus ═══
      exportPrometheusMetrics: ['prometheus', 'export'],
      recordHttpMetric: ['prometheus', 'recordHttpMetric'],
      recordLLMMetric: ['prometheus', 'recordLLMMetric'],

      // ═══ 消息处理器 ═══
      getMessageProcessorStats: ['messageProcessor', 'getStats'],
      getActiveMessagePipelines: ['messageProcessor', 'getActivePipelines'],
      getMessagePipeline: ['messageProcessor', 'getPipeline'],
      getRecentMessageSummary: ['messageProcessor', 'getRecentSummary'],
      getMessageDAGData: ['messageProcessor', 'getDAGData'],
      getEntityGraph: ['messageProcessor', 'getEntityGraph'],

      // ═══ 记忆网络图 ═══
      getMemoryGraphData: ['memoryNetworkGraph', 'getGraphData'],
      getMemoryNodeDetail: ['memoryNetworkGraph', 'getNodeDetail'],
      searchMemoryGraphNodes: ['memoryNetworkGraph', 'searchNodes'],
      findMemoryPath: ['memoryNetworkGraph', 'findPath'],
      getMemoryClusterDetail: ['memoryNetworkGraph', 'getClusterDetail'],
      selectMemoryNode: ['memoryNetworkGraph', 'selectNode'],
      clearMemorySelection: ['memoryNetworkGraph', 'clearSelection'],
      setMemoryGraphPhysics: ['memoryNetworkGraph', 'setPhysics'],
      setMemoryGraphLayout: ['memoryNetworkGraph', 'setLayoutMode'],
      setMemoryGraphClusterMode: ['memoryNetworkGraph', 'setClusterMode'],
      getMemoryGraphStats: ['memoryNetworkGraph', 'getStats'],
      rebuildMemoryGraph: ['memoryNetworkGraph', 'rebuildGraph'],

      // ═══ 持久化 ═══
      getPersistenceStats: ['persistenceStore', 'getStats'],
      flushPersistence: ['persistenceStore', 'flush'],

      // ═══ 子智能体 ═══
      createSubAgent: ['subAgentManager', 'create'],
      startSubAgent: ['subAgentManager', 'start'],
      stopSubAgent: ['subAgentManager', 'stop'],
      restartSubAgent: ['subAgentManager', 'restart'],
      destroySubAgent: ['subAgentManager', 'destroy'],
      listSubAgents: ['subAgentManager', 'list'],
      getSubAgent: ['subAgentManager', 'get'],
      assignSubAgentTask: ['subAgentManager', 'assignTask'],
      assignSubAgentTaskSmart: ['subAgentManager', 'assignTaskSmart'],
      completeSubAgentTask: ['subAgentManager', 'completeTask'],
      submitScheduledTask: ['subAgentScheduler', 'submitTask'],
      submitCompositeScheduledTask: ['subAgentScheduler', 'submitCompositeTask'],
      getSchedulerStats: ['subAgentScheduler', 'getQueueStats'],
      getGuardianStats: ['subAgentGuardian', 'getStats'],
      getQuarantinedSubAgents: ['subAgentGuardian', 'getQuarantinedAgents'],
      releaseSubAgent: ['subAgentGuardian', 'releaseAgent'],
      checkSubAgentSafety: ['subAgentGuardian', 'authorize'],

      // ═══ 子智能体独立对话 ═══
      sendMessageToSubAgent: ['subAgentManager', 'sendMessageToAgent'],
      listSubAgentSessions: ['subAgentManager', 'listAgentSessions'],
      createSubAgentSession: ['subAgentManager', 'createAgentSession'],
      getSubAgentSession: ['subAgentManager', 'getAgentSession'],
      switchSubAgentSession: ['subAgentManager', 'switchAgentSession'],
      closeSubAgentSession: ['subAgentManager', 'closeAgentSession'],
      clearSubAgentSession: ['subAgentManager', 'clearAgentSession'],
      executeSubAgentTool: ['subAgentManager', 'executeAgentTool'],
      listSubAgentTools: ['subAgentManager', 'listAgentTools'],
      getSubAgentEngineStatus: ['subAgentManager', 'getAgentEngineStatus'],
      getSubAgentWSStats: ['subAgentManager', 'getWSStats'],
      listSubAgentEngines: ['subAgentManager', 'listEngines'],
      initSubAgentWebSocket: ['subAgentManager', 'initWebSocket'],
      getSubAgentWebSocket: ['subAgentManager', 'getWebSocket'],
      setSubAgentDisplayName: ['subAgentManager', 'setAgentDisplayName'],
      getSubAgentTeams: ['subAgentManager', 'getAgentTeams'],

      // ═══ 团队协作 ═══
      createTeam: ['teamManager', 'create'],
      activateTeam: ['teamManager', 'activate'],
      pauseTeam: ['teamManager', 'pause'],
      dissolveTeam: ['teamManager', 'dissolve'],
      removeTeam: ['teamManager', 'remove'],
      listTeams: ['teamManager', 'list'],
      getTeam: ['teamManager', 'get'],
      addTeamMember: ['teamManager', 'addMember'],
      removeTeamMember: ['teamManager', 'removeMember'],
      updateTeamMemberRole: ['teamManager', 'updateMemberRole'],
      sendTeamMessage: ['teamManager', 'sendTeamMessage'],
      broadcastToTeam: ['teamManager', 'broadcastToTeam'],
      getTeamMessages: ['teamManager', 'getTeamMessages'],
      startTeamConsensus: ['teamManager', 'startTeamConsensus'],
      castTeamVote: ['teamManager', 'castTeamVote'],
      getPendingConsents: ['teamManager', 'getPendingConsents'],
      approveConsent: ['teamManager', 'approveConsent'],
      rejectConsent: ['teamManager', 'rejectConsent'],
      getConsentStats: ['teamManager', 'getConsentStats'],
      getConsentHistory: ['teamManager', 'getConsentHistory'],
      getTeamStats: ['teamManager', 'getStats'],

      // ═══ 技能安装与固化 ═══
      installAgentSkillFromFile: ['subAgentManager', 'installSkillFromFile'],
      installAgentSkillFromContent: ['subAgentManager', 'installSkillFromContent'],
      installAgentSkillFromMarket: ['subAgentManager', 'installSkillFromMarket'],
      uninstallAgentSkill: ['subAgentManager', 'uninstallAgentSkill'],
      listAgentSkills: ['subAgentManager', 'listAgentSkills'],
      getAgentSkillDetail: ['subAgentManager', 'getAgentSkillDetail'],
      searchAgentSkills: ['subAgentManager', 'searchAgentSkills'],
      getAgentSkillStats: ['subAgentManager', 'getAgentSkillStats'],
      getAgentSkillHistory: ['subAgentManager', 'getAgentSkillHistory'],
      toggleAgentSkill: ['subAgentManager', 'toggleAgentSkill'],
      bindSkillToMemory: ['subAgentManager', 'bindSkillToMemory'],
      lockSkillAsCore: ['subAgentManager', 'lockSkillAsCore'],
      getBoundSkills: ['subAgentManager', 'getBoundSkills'],
      getAgentMemoryStats: ['subAgentManager', 'getAgentMemoryStats'],
      searchAgentMemory: ['subAgentManager', 'searchAgentMemory'],
      exportAgentSkillMemory: ['subAgentManager', 'exportAgentSkillMemory'],
      importAgentSkillMemory: ['subAgentManager', 'importAgentSkillMemory'],
      getSkillInstaller: ['subAgentManager', 'getSkillInstaller'],
      getMemoryBinder: ['subAgentManager', 'getMemoryBinder'],

      // ═══ 微服务 ═══
      registerService: ['microRegistry', 'register'],
      deregisterService: ['microRegistry', 'deregister'],
      discoverServices: ['microRegistry', 'discover'],
      selectServiceInstance: ['microRegistry', 'selectInstance'],
      listRegisteredServices: ['microRegistry', 'listServices'],
      getMicroRegistryStats: ['microRegistry', 'getStats'],
    };
  }

  /**
   * 为单个代理方法创建实现
   */
  _createProxyMethod(methodName, moduleName, targetMethod, authConfig) {
    this[methodName] = (...args) => {
      const module = this._registry.get(moduleName);
      if (!module) {
        throw new Error(
          `Cannot proxy "${methodName}": module "${moduleName}" is not registered`
        );
      }

      if (typeof module[targetMethod] !== 'function') {
        throw new Error(
          `Cannot proxy "${methodName}": module "${moduleName}" has no method "${targetMethod}"`
        );
      }

      // 安全边界检查
      if (authConfig && this._security) {
        if (authConfig.capability && authConfig.coreIdentity) {
          const { CORE_IDENTITY, CAPABILITY } = require('../security/security-boundary');
          const identityKey = authConfig.coreIdentity;
          const capKey = authConfig.capability;

          const auth = this._security.authorize(
            CORE_IDENTITY[identityKey],
            CAPABILITY[capKey],
            { params: { method: methodName, args } }
          );
          if (!auth.allowed) {
            if (this._logger) {
              this._logger.warn(`安全边界拒绝 ${methodName}: ${auth.reason}`);
            }
            return { error: `Security denied: ${auth.reason}` };
          }
        }

        // Token预算检查
        if (authConfig.budgetCore && this._budget) {
          const { CALL_PRIORITY } = require('../budget/token-budget-manager');
          const budgetDecision = this._budget.requestTokens(
            authConfig.budgetCore,
            authConfig.budgetTokens || 1000,
            {
              priority: CALL_PRIORITY.NORMAL,
              callType: authConfig.budgetCallType || methodName,
            }
          );
          if (!budgetDecision.allowed) {
            return { error: `Budget denied: ${budgetDecision.reason}` };
          }
        }
      }

      return module[targetMethod](...args);
    };
  }

  /**
   * 获取注册表
   */
  getRegistry() {
    return this._registry;
  }

  /**
   * 注册新模块并立即为其创建代理方法
   * @param {string} name - 模块名
   * @param {Object} instance - 模块实例
   * @param {Object} proxyMap - { methodName: targetMethod } 映射
   * @param {string[]} dependencies - 依赖模块名
   */
  registerAndProxy(name, instance, proxyMap = {}, dependencies = []) {
    this._registry.register(name, instance, dependencies);

    for (const [methodName, targetMethod] of Object.entries(proxyMap)) {
      this._createProxyMethod(methodName, name, targetMethod);
    }

    return this;
  }
}

module.exports = { AgentFacade };
