'use strict';

const path = require('path');

const { Logger, LOG_LEVEL, getLogger, setLogger } = require('../utils/logger');
const { ErrorHandler, RETRY_STRATEGY } = require('../utils/error-handler');

/**
 * Bootstrap: Logger + ErrorHandler
 *
 * 职责：
 *   1. 创建统一日志实例（替代所有 console.log/console.error）
 *   2. 创建统一错误处理器（替代散落的 try-catch）
 *   3. 注册为全局 Logger（通过 setLogger）
 */

/**
 * 初始化 Logger 和 ErrorHandler
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── 统一日志系统（Phase 19） ──
  agent._logger = new Logger({
    name: agent._name,
    level: options.logLevel ?? (options.debugMode ? LOG_LEVEL.DEBUG : LOG_LEVEL.INFO),
    logDir: path.join(agent._dataDir, 'logs'),
    enableConsole: options.logConsole !== false,
    enableFile: options.logFile !== false,
    enableJSON: options.logJSON !== false,
    maxFileSize: options.logMaxFileSize ?? 10 * 1024 * 1024,
    maxFiles: options.logMaxFiles ?? 30,
  });
  setLogger(agent._logger);

  // ── 统一错误处理器（Phase 19） ──
  agent._errorHandler = new ErrorHandler({
    logger: agent._logger,
    bus: null, // 将在 _bus 初始化后注入
    maxRetries: options.errorRetryMax ?? 3,
    baseDelay: options.errorRetryBaseDelay ?? 1000,
    maxDelay: options.errorRetryMaxDelay ?? 30000,
    retryStrategy: options.errorRetryStrategy || RETRY_STRATEGY.EXPONENTIAL,
    onCritical: (error) => {
      agent._logger.fatal(`Critical error: ${error.message}`, { error });
      agent.emit('critical_error', error);
    },
  });
}

/**
 * 绑定事件（Logger/ErrorHandler 无额外事件绑定）
 */
function bindEvents(agent) {
  // Logger 和 ErrorHandler 没有需要从外部绑定的事件
}

/**
 * 启动逻辑（无额外启动操作）
 */
function startup(agent, config) {
  // Logger 和 ErrorHandler 在 init 阶段已完成配置，无额外启动逻辑
}

module.exports = { init, bindEvents, startup };
