/**
 * TriCore Agent - 安全边界 (Security Boundary)
 *
 * 核心问题：意识层的"自主思考"与执行层的"自主操作"之间
 *          需要极严格的隔离，但当前边界模糊。
 *
 * 解决方案：
 *   1. 能力令牌 - 意识核只能"建议"，不能直接执行；
 *                  执行核只能"执行"，不能自主决策
 *   2. 授权网关 - 所有跨核操作必须经过授权检查
 *   3. 操作分级 - SAFE/MODERATE/CRITICAL三级，高级操作需多签
 *   4. 跨核审计 - 所有跨核请求和授权记录永久可查
 *   5. 安全策略 - 可配置的安全策略引擎，支持动态规则
 *
 * 三条铁律：
 *   铁律1: 意识不碰手 - 意识核不能直接调用任何工具/IO操作
 *   铁律2: 执行不经脑 - 执行核不能自主发起LLM推理/决策
 *   铁律3: 进化受约束 - 进化核产出必须审计才能激活
 */

'use strict';

const { EventEmitter } = require('events');

// ── 操作安全级别 ──
const SECURITY_LEVEL = Object.freeze({
  SAFE: 'safe',           // 只读、查询，无风险
  MODERATE: 'moderate',   // 有限写入，可回滚
  CRITICAL: 'critical',   // 不可逆操作，需确认+多签
  FORBIDDEN: 'forbidden', // 绝对禁止（意识核直接执行shell等）
});

// ── 核心身份 ──
const CORE_IDENTITY = Object.freeze({
  CONSCIOUSNESS: 'consciousness',
  EXECUTION: 'execution',
  EVOLUTION: 'evolution',
  SCHEDULER: 'scheduler',
  EXTERNAL: 'external',   // API/UI等外部调用方
});

// ── 能力类型 ──
const CAPABILITY = Object.freeze({
  // 意识核能力
  THINK: 'think',                    // LLM推理
  SUGGEST_TASK: 'suggest_task',      // 建议执行任务
  QUERY_MEMORY: 'query_memory',      // 查询记忆
  QUERY_SKILL: 'query_skill',        // 查询技能
  FOCUS_MANAGE: 'focus_manage',      // 管理焦点栈

  // 执行核能力
  EXECUTE_TASK: 'execute_task',      // 执行任务
  CALL_TOOL: 'call_tool',            // 调用工具
  FILE_READ: 'file_read',           // 读文件
  FILE_WRITE: 'file_write',         // 写文件
  SHELL_EXEC: 'shell_exec',         // 执行命令
  BROWSER_CONTROL: 'browser_control', // 浏览器控制
  SEND_MESSAGE: 'send_message',     // 发送消息

  // 进化核能力
  EXTRACT_SKILL: 'extract_skill',    // 提取技能
  AUDIT_SKILL: 'audit_skill',        // 审计技能
  CONSOLIDATE: 'consolidate',        // 记忆整合
  PUBLISH_SKILL: 'publish_skill',    // 发布技能

  // 跨核请求能力
  REQUEST_EXECUTION: 'request_execution', // 请求执行核执行
  REQUEST_EVOLUTION: 'request_evolution', // 请求进化核处理
  NOTIFY_CONSCIOUSNESS: 'notify_consciousness', // 通知意识核
});

// ── 能力映射表：哪个核拥有什么能力 ──
const CORE_CAPABILITIES = Object.freeze({
  [CORE_IDENTITY.CONSCIOUSNESS]: new Set([
    CAPABILITY.THINK,
    CAPABILITY.SUGGEST_TASK,
    CAPABILITY.QUERY_MEMORY,
    CAPABILITY.QUERY_SKILL,
    CAPABILITY.FOCUS_MANAGE,
    CAPABILITY.REQUEST_EXECUTION,   // 意识可以请求执行
    CAPABILITY.REQUEST_EVOLUTION,   // 意识可以请求进化
  ]),
  [CORE_IDENTITY.EXECUTION]: new Set([
    CAPABILITY.EXECUTE_TASK,
    CAPABILITY.CALL_TOOL,
    CAPABILITY.FILE_READ,
    CAPABILITY.FILE_WRITE,
    CAPABILITY.SHELL_EXEC,
    CAPABILITY.BROWSER_CONTROL,
    CAPABILITY.SEND_MESSAGE,
    CAPABILITY.NOTIFY_CONSCIOUSNESS, // 执行可以通知意识
    CAPABILITY.REQUEST_EVOLUTION,    // 执行可以请求进化
  ]),
  [CORE_IDENTITY.EVOLUTION]: new Set([
    CAPABILITY.EXTRACT_SKILL,
    CAPABILITY.AUDIT_SKILL,
    CAPABILITY.CONSOLIDATE,
    CAPABILITY.PUBLISH_SKILL,
    CAPABILITY.NOTIFY_CONSCIOUSNESS, // 进化可以通知意识
  ]),
});

// ── 跨核操作安全级别映射 ──
const CROSS_CORE_SECURITY = Object.freeze({
  // 意识→执行
  'consciousness→execution:suggest_task': SECURITY_LEVEL.SAFE,
  'consciousness→execution:execute_task': SECURITY_LEVEL.MODERATE,
  'consciousness→execution:call_tool': SECURITY_LEVEL.CRITICAL,
  'consciousness→execution:shell_exec': SECURITY_LEVEL.FORBIDDEN,
  'consciousness→execution:file_write': SECURITY_LEVEL.CRITICAL,

  // 执行→意识
  'execution→consciousness:notify': SECURITY_LEVEL.SAFE,
  'execution→consciousness:think': SECURITY_LEVEL.FORBIDDEN, // 执行核不能要求意识思考

  // 执行→进化
  'execution→evolution:extract_skill': SECURITY_LEVEL.SAFE,
  'execution→evolution:audit_skill': SECURITY_LEVEL.MODERATE,

  // 进化→执行
  'evolution→execution:publish_skill': SECURITY_LEVEL.MODERATE,
  'evolution→execution:call_tool': SECURITY_LEVEL.FORBIDDEN,

  // 进化→意识
  'evolution→consciousness:notify': SECURITY_LEVEL.SAFE,
  'evolution→consciousness:think': SECURITY_LEVEL.FORBIDDEN,
});

class SecurityBoundary extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── 安全策略 ──
    this._policies = new Map();     // policyName → { condition, action }
    this._customRules = new Map();  // 自定义规则

    // ── 审计日志 ──
    this._auditLog = [];
    this._maxAuditLog = options.maxAuditLog ?? 50000;

    // ── 多签确认 ──
    this._pendingConfirmations = new Map(); // confirmId → { request, approvals, required, timeout }

    // ── 运行时约束 ──
    this._constraints = {
      // 意识核单次任务建议的最大Token消耗
      maxConsciousnessTaskBudget: options.maxConsciousnessTaskBudget ?? 10000,
      // 执行核单次自主操作最大执行时间
      maxExecutionAutonomyMs: options.maxExecutionAutonomyMs ?? 30000,
      // 进化核自动审计的技能类别限制
      autoAuditSafeCategories: options.autoAuditSafeCategories ?? [
        'data_processing', 'analysis', 'communication',
      ],
      // 意识核空闲思考频率限制
      maxIdleThinkPerHour: options.maxIdleThinkPerHour ?? 6,
      // 执行核连续自主步骤上限（超过需上报意识核）
      maxAutonomousSteps: options.maxAutonomousSteps ?? 5,
    };

    // ── 速率限制 ──
    this._rateLimits = new Map();  // coreName:capability → { count, windowStart }

    // ── 安全模式 ──
    this._safeMode = false;  // 安全模式开启后，所有CRITICAL操作需人工确认

    // ── 注册默认安全策略 ──
    this._registerDefaultPolicies();
  }

  // ═══════════════════════════════════════
  // 核心接口：授权检查
  // ═══════════════════════════════════════

  /**
   * 检查一个核心是否有权执行某个操作
   * @param {string} coreName - 发起方核心
   * @param {string} capability - 请求的能力
   * @param {Object} context - { target?, params?, securityLevel? }
   * @returns {Object} { allowed, reason, securityLevel, confirmationRequired }
   */
  authorize(coreName, capability, context = {}) {
    const { target, params } = context;

    // 1. 检查能力归属
    const allowedCapabilities = CORE_CAPABILITIES[coreName];
    if (!allowedCapabilities || !allowedCapabilities.has(capability)) {
      const result = {
        allowed: false,
        reason: `Core "${coreName}" does not have capability "${capability}"`,
        securityLevel: SECURITY_LEVEL.FORBIDDEN,
        confirmationRequired: false,
      };
      this._logAudit('deny', coreName, capability, result.reason, context);
      this.emit('authorization_denied', { coreName, capability, reason: result.reason });
      return result;
    }

    // 2. 检查跨核操作安全级别
    if (target && target !== coreName) {
      const crossCoreKey = `${coreName}→${target}:${capability}`;
      const securityLevel = CROSS_CORE_SECURITY[crossCoreKey];

      if (securityLevel === SECURITY_LEVEL.FORBIDDEN) {
        const result = {
          allowed: false,
          reason: `Cross-core operation "${crossCoreKey}" is FORBIDDEN`,
          securityLevel: SECURITY_LEVEL.FORBIDDEN,
          confirmationRequired: false,
        };
        this._logAudit('deny', coreName, capability, result.reason, context);
        this.emit('authorization_denied', { coreName, capability, target, reason: result.reason });
        return result;
      }

      if (securityLevel === SECURITY_LEVEL.CRITICAL || this._safeMode) {
        const result = {
          allowed: true,
          reason: 'Critical operation requires confirmation',
          securityLevel: securityLevel || SECURITY_LEVEL.CRITICAL,
          confirmationRequired: true,
        };
        this._logAudit('pending', coreName, capability, 'Requires confirmation', context);
        return result;
      }
    }

    // 3. 检查自定义策略
    for (const [policyName, policy] of this._policies) {
      try {
        const policyResult = policy.check(coreName, capability, context);
        if (policyResult === false) {
          const result = {
            allowed: false,
            reason: `Blocked by policy "${policyName}"`,
            securityLevel: SECURITY_LEVEL.FORBIDDEN,
            confirmationRequired: false,
          };
          this._logAudit('deny', coreName, capability, result.reason, context);
          return result;
        }
      } catch (e) {
        // 策略执行出错，保守拒绝
        const result = {
          allowed: false,
          reason: `Policy "${policyName}" error: ${e.message}`,
          securityLevel: SECURITY_LEVEL.FORBIDDEN,
          confirmationRequired: false,
        };
        this._logAudit('deny', coreName, capability, result.reason, context);
        return result;
      }
    }

    // 4. 检查速率限制
    const rateLimitKey = `${coreName}:${capability}`;
    const rateLimit = this._rateLimits.get(rateLimitKey);
    if (rateLimit && rateLimit.limit) {
      const now = Date.now();
      if (now - rateLimit.windowStart < rateLimit.window) {
        if (rateLimit.count >= rateLimit.limit) {
          const result = {
            allowed: false,
            reason: `Rate limit exceeded for ${rateLimitKey}`,
            securityLevel: SECURITY_LEVEL.SAFE,
            confirmationRequired: false,
          };
          this._logAudit('deny', coreName, capability, result.reason, context);
          return result;
        }
        rateLimit.count++;
      } else {
        rateLimit.count = 1;
        rateLimit.windowStart = now;
      }
    }

    // 5. 通过所有检查
    const securityLevel = context.securityLevel || this._inferSecurityLevel(capability);
    const result = {
      allowed: true,
      reason: 'Authorized',
      securityLevel,
      confirmationRequired: securityLevel === SECURITY_LEVEL.CRITICAL,
    };

    this._logAudit('allow', coreName, capability, 'Authorized', context);
    this.emit('authorized', { coreName, capability, securityLevel });
    return result;
  }

  // ═══════════════════════════════════════
  // 确认机制
  // ═══════════════════════════════════════

  /**
   * 请求确认（用于CRITICAL操作）
   * @param {string} coreName - 请求方
   * @param {string} capability - 操作能力
   * @param {Object} context - 操作上下文
   * @param {number} requiredApprovals - 需要的确认数
   * @returns {string} confirmId
   */
  requestConfirmation(coreName, capability, context = {}, requiredApprovals = 1) {
    const confirmId = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    this._pendingConfirmations.set(confirmId, {
      coreName,
      capability,
      context,
      approvals: 0,
      required: requiredApprovals,
      createdAt: Date.now(),
      status: 'pending',  // pending | approved | rejected | expired
    });

    this.emit('confirmation_requested', {
      confirmId,
      coreName,
      capability,
      context,
      requiredApprovals,
    });

    // 超时自动拒绝（60秒）
    setTimeout(() => {
      const pending = this._pendingConfirmations.get(confirmId);
      if (pending && pending.status === 'pending') {
        pending.status = 'expired';
        this._logAudit('expire', coreName, capability, 'Confirmation expired', context);
        this.emit('confirmation_expired', { confirmId });
      }
    }, 60000);

    return confirmId;
  }

  /**
   * 批准确认
   * @param {string} confirmId
   * @param {boolean} approved
   * @param {string} approver - 确认方身份
   * @param {string} reason
   */
  resolveConfirmation(confirmId, approved, approver = 'user', reason = '') {
    const pending = this._pendingConfirmations.get(confirmId);
    if (!pending) return { error: 'Confirmation not found' };
    if (pending.status !== 'pending') return { error: `Already ${pending.status}` };

    if (approved) {
      pending.approvals++;
      if (pending.approvals >= pending.required) {
        pending.status = 'approved';
        this._logAudit('confirm', pending.coreName, pending.capability,
          `Approved by ${approver}: ${reason}`, pending.context);
        this.emit('confirmation_approved', { confirmId, approver, reason });
        return { approved: true };
      }
      return { approved: false, message: `${pending.approvals}/${pending.required} approvals` };
    } else {
      pending.status = 'rejected';
      this._logAudit('reject', pending.coreName, pending.capability,
        `Rejected by ${approver}: ${reason}`, pending.context);
      this.emit('confirmation_rejected', { confirmId, approver, reason });
      return { approved: false, rejected: true };
    }
  }

  // ═══════════════════════════════════════
  // 安全策略
  // ═══════════════════════════════════════

  /**
   * 添加自定义安全策略
   * @param {string} name - 策略名称
   * @param {Object} policy - { check: (coreName, capability, context) => boolean }
   *   返回false表示阻止操作
   */
  addPolicy(name, policy) {
    this._policies.set(name, policy);
  }

  /**
   * 移除策略
   */
  removePolicy(name) {
    this._policies.delete(name);
  }

  /**
   * 设置速率限制
   * @param {string} coreName
   * @param {string} capability
   * @param {number} limit - 窗口内最大调用次数
   * @param {number} windowMs - 窗口时间（毫秒）
   */
  setRateLimit(coreName, capability, limit, windowMs = 3600000) {
    this._rateLimits.set(`${coreName}:${capability}`, {
      limit,
      window: windowMs,
      count: 0,
      windowStart: Date.now(),
    });
  }

  /**
   * 开启/关闭安全模式
   */
  setSafeMode(enabled) {
    this._safeMode = enabled;
    this.emit('safe_mode_changed', { enabled });
  }

  _registerDefaultPolicies() {
    // 策略1：意识核不能直接调用任何工具
    this.addPolicy('consciousness_no_direct_tool', {
      check: (coreName, capability, context) => {
        if (coreName !== CORE_IDENTITY.CONSCIOUSNESS) return true;
        const toolCapabilities = [
          CAPABILITY.CALL_TOOL, CAPABILITY.FILE_WRITE,
          CAPABILITY.SHELL_EXEC, CAPABILITY.BROWSER_CONTROL,
        ];
        return !toolCapabilities.includes(capability);
      },
    });

    // 策略2：执行核不能自主发起LLM推理
    this.addPolicy('execution_no_llm_think', {
      check: (coreName, capability, context) => {
        if (coreName !== CORE_IDENTITY.EXECUTION) return true;
        return capability !== CAPABILITY.THINK;
      },
    });

    // 策略3：进化核的自动审计技能只能批准安全类别
    this.addPolicy('evolution_safe_audit_only', {
      check: (coreName, capability, context) => {
        if (coreName !== CORE_IDENTITY.EVOLUTION) return true;
        if (capability !== CAPABILITY.AUDIT_SKILL) return true;
        if (context?.autoApproved && context?.category) {
          return this._constraints.autoAuditSafeCategories.includes(context.category);
        }
        return true;
      },
    });

    // 策略4：shell_exec必须经过确认
    this.addPolicy('shell_exec_confirmation', {
      check: (coreName, capability, context) => {
        if (capability !== CAPABILITY.SHELL_EXEC) return true;
        // shell_exec总是需要确认，由确认机制处理
        return true; // 不直接阻止，但authorize会标记为CRITICAL
      },
    });
  }

  // ═══════════════════════════════════════
  // 铁律验证
  // ═══════════════════════════════════════

  /**
   * 验证铁律1：意识不碰手
   * 意识核不能直接执行任何工具/IO操作
   */
  enforceIronLaw1(coreName, operation) {
    const forbiddenOps = [
      'file_write', 'shell_exec', 'browser_control',
      'send_message', 'call_tool', 'execute_task',
    ];

    if (coreName === CORE_IDENTITY.CONSCIOUSNESS && forbiddenOps.includes(operation)) {
      const violation = {
        law: 1,
        core: coreName,
        operation,
        message: `铁律1违反：意识核不能直接执行 "${operation}"`,
        timestamp: Date.now(),
      };
      this.emit('iron_law_violation', violation);
      this._logAudit('violation', coreName, operation, violation.message, {});
      return false;
    }
    return true;
  }

  /**
   * 验证铁律2：执行不经脑
   * 执行核不能自主发起LLM推理/决策
   */
  enforceIronLaw2(coreName, operation) {
    if (coreName === CORE_IDENTITY.EXECUTION && operation === 'think') {
      const violation = {
        law: 2,
        core: coreName,
        operation,
        message: '铁律2违反：执行核不能自主发起LLM推理',
        timestamp: Date.now(),
      };
      this.emit('iron_law_violation', violation);
      this._logAudit('violation', coreName, operation, violation.message, {});
      return false;
    }
    return true;
  }

  /**
   * 验证铁律3：进化受约束
   * 进化核产出必须审计才能激活
   */
  enforceIronLaw3(coreName, operation, context = {}) {
    if (coreName === CORE_IDENTITY.EVOLUTION && operation === 'publish_skill') {
      if (context.auditStatus !== 'approved') {
        const violation = {
          law: 3,
          core: coreName,
          operation,
          message: '铁律3违反：技能未经审计不能激活发布',
          timestamp: Date.now(),
        };
        this.emit('iron_law_violation', violation);
        this._logAudit('violation', coreName, operation, violation.message, context);
        return false;
      }
    }
    return true;
  }

  // ═══════════════════════════════════════
  // 审计日志
  // ═══════════════════════════════════════

  _logAudit(action, coreName, capability, reason, context) {
    const entry = {
      action,       // allow | deny | confirm | reject | expire | violation
      coreName,
      capability,
      reason,
      timestamp: Date.now(),
      contextKeys: context ? Object.keys(context) : [],
    };

    this._auditLog.push(entry);
    if (this._auditLog.length > this._maxAuditLog) {
      this._auditLog = this._auditLog.slice(-this._maxAuditLog);
    }
  }

  /**
   * 查询审计日志
   * @param {Object} filter - { action?, coreName?, capability?, since?, limit? }
   */
  queryAuditLog(filter = {}) {
    let results = this._auditLog;

    if (filter.action) {
      results = results.filter(e => e.action === filter.action);
    }
    if (filter.coreName) {
      results = results.filter(e => e.coreName === filter.coreName);
    }
    if (filter.capability) {
      results = results.filter(e => e.capability === filter.capability);
    }
    if (filter.since) {
      results = results.filter(e => e.timestamp >= filter.since);
    }

    return results.slice(-(filter.limit || 100));
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _inferSecurityLevel(capability) {
    const levelMap = {
      [CAPABILITY.THINK]: SECURITY_LEVEL.SAFE,
      [CAPABILITY.QUERY_MEMORY]: SECURITY_LEVEL.SAFE,
      [CAPABILITY.QUERY_SKILL]: SECURITY_LEVEL.SAFE,
      [CAPABILITY.SUGGEST_TASK]: SECURITY_LEVEL.SAFE,
      [CAPABILITY.FOCUS_MANAGE]: SECURITY_LEVEL.SAFE,
      [CAPABILITY.EXECUTE_TASK]: SECURITY_LEVEL.MODERATE,
      [CAPABILITY.FILE_READ]: SECURITY_LEVEL.SAFE,
      [CAPABILITY.FILE_WRITE]: SECURITY_LEVEL.CRITICAL,
      [CAPABILITY.SHELL_EXEC]: SECURITY_LEVEL.CRITICAL,
      [CAPABILITY.BROWSER_CONTROL]: SECURITY_LEVEL.MODERATE,
      [CAPABILITY.SEND_MESSAGE]: SECURITY_LEVEL.MODERATE,
      [CAPABILITY.EXTRACT_SKILL]: SECURITY_LEVEL.SAFE,
      [CAPABILITY.AUDIT_SKILL]: SECURITY_LEVEL.MODERATE,
      [CAPABILITY.CONSOLIDATE]: SECURITY_LEVEL.SAFE,
      [CAPABILITY.PUBLISH_SKILL]: SECURITY_LEVEL.MODERATE,
    };
    return levelMap[capability] || SECURITY_LEVEL.CRITICAL;
  }

  getStatus() {
    return {
      safeMode: this._safeMode,
      policyCount: this._policies.size,
      auditLogSize: this._auditLog.length,
      pendingConfirmations: this._pendingConfirmations.size,
      rateLimits: Object.fromEntries(
        [...this._rateLimits].map(([k, v]) => [k, { limit: v.limit, window: v.window }])
      ),
      violations: this._auditLog.filter(e => e.action === 'violation').length,
      denials: this._auditLog.filter(e => e.action === 'deny').length,
    };
  }
}

// ── 导出 ──
module.exports = {
  SecurityBoundary,
  SECURITY_LEVEL,
  CORE_IDENTITY,
  CAPABILITY,
  CORE_CAPABILITIES,
  CROSS_CORE_SECURITY,
};
