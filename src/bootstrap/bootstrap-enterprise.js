'use strict';

const path = require('path');

const { RBACManager } = require('../enterprise/rbac-manager');
const { AuditLogger } = require('../enterprise/audit-logger');
const { EncryptionService } = require('../enterprise/encryption-service');

/**
 * Bootstrap: 企业级特性层
 *
 * 职责：
 *   1. RBACManager - 角色权限/API Key/临时授权
 *   2. AuditLogger - 结构化日志/数据脱敏/合规报告
 *   3. EncryptionService - AES-256-GCM/密钥轮转/HMAC签名
 *
 * 依赖：
 *   - memory (MemoryEngine) - 提供 _db 用于持久化
 *   - logger (Logger)
 */

/**
 * 初始化企业级特性模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── RBACManager ──
  agent._rbac = new RBACManager({
    db: agent._memory?._db || null,
    memory: agent._memory,
    logger: agent._logger,
    dataDir: agent._dataDir,
    adminPassword: options.adminPassword || process.env.TRICORE_ADMIN_PASSWORD || null,
    sessionTimeout: options.sessionTimeout ?? 3600000,
    maxSessionsPerUser: options.maxSessionsPerUser ?? 5,
  });

  // ── AuditLogger ──
  agent._audit = new AuditLogger({
    db: agent._memory?._db || null,
    memory: agent._memory,
    logger: agent._logger,
    logDir: path.join(agent._dataDir, 'audit'),
    bufferSize: options.auditBufferSize ?? 100,
    flushInterval: options.auditFlushInterval ?? 5000,
    maxLogSize: options.auditMaxLogSize ?? 10 * 1024 * 1024,
  });

  // ── EncryptionService ──
  agent._encryption = new EncryptionService({
    keyDir: path.join(agent._dataDir, 'keys'),
    rotationInterval: options.keyRotationInterval ?? 90 * 24 * 3600 * 1000,
  });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // 企业级特性没有需要从外部绑定的事件
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // 企业级特性没有额外的启动逻辑
}

module.exports = { init, bindEvents, startup };
