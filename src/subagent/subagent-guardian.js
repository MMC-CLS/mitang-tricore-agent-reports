/**
 * 蜜糖 TriCore Agent - 子智能体安全守护者 (Sub-Agent Guardian)
 *
 * 核心职责：
 *   1. 安全边界强制执行 - 四条铁律对所有子智能体生效
 *   2. 行为审计与日志 - 所有子智能体操作完整记录
 *   3. 异常行为检测 - 基于规则的异常模式识别
 *   4. 自动熔断隔离 - 危险子智能体自动隔离
 *   5. 安全评分系统 - 动态安全评分与降级策略
 *   6. 权限沙箱管理 - 按安全等级限制操作权限
 *
 * 四条铁律（子智能体版）：
 *   铁律一：子智能体不得修改母体核心配置
 *   铁律二：子智能体不得访问其他子智能体的私有数据
 *   铁律三：子智能体不得执行系统级危险操作
 *   铁律四：所有子智能体操作必须可审计可追溯
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 常量 ──

const VIOLATION_TYPE = Object.freeze({
  UNAUTHORIZED_ACCESS: 'unauthorized_access',
  CONFIG_MODIFICATION: 'config_modification',
  SYSTEM_OPERATION: 'system_operation',
  DATA_LEAK: 'data_leak',
  RESOURCE_ABUSE: 'resource_abuse',
  CROSS_AGENT_ACCESS: 'cross_agent_access',
  PRIVILEGE_ESCALATION: 'privilege_escalation',
  ANOMALOUS_BEHAVIOR: 'anomalous_behavior',
});

const VIOLATION_SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const GUARDIAN_STATE = Object.freeze({
  NORMAL: 'normal',
  ALERT: 'alert',
  LOCKDOWN: 'lockdown',
});

// 异常行为检测规则
const ANOMALY_RULES = [
  {
    name: '高频任务提交',
    check: (agent, stats) => {
      const recentTasks = agent.tasks.filter(t => t.assignedAt > Date.now() - 60000);
      return recentTasks.length > 20 ? { severity: VIOLATION_SEVERITY.MEDIUM, reason: `60秒内提交${recentTasks.length}个任务` } : null;
    },
  },
  {
    name: '任务失败率过高',
    check: (agent) => {
      const total = agent.performance.tasksCompleted + agent.performance.tasksFailed;
      if (total < 5) return null;
      const failRate = agent.performance.tasksFailed / total;
      return failRate > 0.5 ? { severity: VIOLATION_SEVERITY.HIGH, reason: `任务失败率${(failRate*100).toFixed(0)}%` } : null;
    },
  },
  {
    name: '安全评分过低',
    check: (agent) => {
      return agent.safetyScore < 20 ? { severity: VIOLATION_SEVERITY.CRITICAL, reason: `安全评分降至${agent.safetyScore}` } : null;
    },
  },
  {
    name: '大量违规记录',
    check: (agent) => {
      return agent.violations.length > 10 ? { severity: VIOLATION_SEVERITY.HIGH, reason: `累计${agent.violations.length}次违规` } : null;
    },
  },
  {
    name: '长时间无响应',
    check: (agent) => {
      if (!agent.lastActive) return null;
      const idle = Date.now() - agent.lastActive;
      return idle > 600000 ? { severity: VIOLATION_SEVERITY.LOW, reason: `超过10分钟无活动` } : null;
    },
  },
];

class SubAgentGuardian extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._subAgentManager = options.subAgentManager || null;
    this._securityBoundary = options.securityBoundary || null;

    // 状态
    this._state = GUARDIAN_STATE.NORMAL;
    this._lockdownAgents = new Set();

    // 审计日志
    this._auditLog = [];
    this._maxAuditLog = options.maxAuditLog || 10000;

    // 统计
    this._stats = {
      checksPerformed: 0,
      violationsDetected: 0,
      agentsQuarantined: 0,
      alertsTriggered: 0,
    };

    // 安全规则配置
    this._rules = {
      maxTasksPerMinute: options.maxTasksPerMinute || 20,
      maxFailRate: options.maxFailRate || 0.5,
      minSafetyScore: options.minSafetyScore || 20,
      maxViolations: options.maxViolations || 10,
      idleTimeoutMs: options.idleTimeoutMs || 600000,
      lockdownDurationMs: options.lockdownDurationMs || 300000,
    };

    // 监控定时器
    this._monitorTimer = null;
    this._monitorInterval = options.monitorInterval || 30000;
  }

  // ═══════════════════════════════════════
  // 操作授权
  // ═══════════════════════════════════════

  /**
   * 授权子智能体操作
   */
  authorize(agentId, action, params = {}) {
    const agent = this._subAgentManager?._agents?.get(agentId);
    if (!agent) {
      return { allowed: false, reason: '子智能体不存在', violationType: VIOLATION_TYPE.UNAUTHORIZED_ACCESS };
    }

    // 检查是否在隔离中
    if (this._lockdownAgents.has(agentId)) {
      return { allowed: false, reason: '子智能体处于安全隔离中', violationType: VIOLATION_TYPE.ANOMALOUS_BEHAVIOR };
    }

    // 铁律一：禁止修改母体核心配置
    if (this._isConfigModification(action, params)) {
      this._recordViolation(agent, VIOLATION_TYPE.CONFIG_MODIFICATION, VIOLATION_SEVERITY.CRITICAL, `尝试修改母体配置: ${action}`);
      return { allowed: false, reason: '铁律一：禁止修改母体核心配置', violationType: VIOLATION_TYPE.CONFIG_MODIFICATION };
    }

    // 铁律二：禁止跨子智能体数据访问
    if (this._isCrossAgentAccess(action, params, agentId)) {
      this._recordViolation(agent, VIOLATION_TYPE.CROSS_AGENT_ACCESS, VIOLATION_SEVERITY.HIGH, `尝试访问其他子智能体数据: ${action}`);
      return { allowed: false, reason: '铁律二：禁止跨子智能体数据访问', violationType: VIOLATION_TYPE.CROSS_AGENT_ACCESS };
    }

    // 铁律三：禁止系统级危险操作
    if (this._isDangerousSystemOperation(action, params)) {
      this._recordViolation(agent, VIOLATION_TYPE.SYSTEM_OPERATION, VIOLATION_SEVERITY.CRITICAL, `尝试执行系统危险操作: ${action}`);
      return { allowed: false, reason: '铁律三：禁止系统级危险操作', violationType: VIOLATION_TYPE.SYSTEM_OPERATION };
    }

    // 铁律四：所有操作可审计（记录但不阻止）
    this._auditAction(agentId, action, params);

    // 安全评分检查
    if (agent.safetyScore < 30 && !this._isReadOnlyAction(action)) {
      return { allowed: false, reason: `安全评分过低 (${agent.safetyScore})，写操作受限` };
    }

    return { allowed: true };
  }

  /**
   * 记录安全违规
   */
  _recordViolation(agent, type, severity, description) {
    this._stats.violationsDetected++;

    if (this._subAgentManager) {
      this._subAgentManager.recordViolation(agent.id, {
        type,
        severity,
        description,
        action: 'blocked',
      });
    }

    this._logger.warn(`[Guardian] 违规: ${agent.name} - ${description} [${severity}]`);
    this.emit('violation', { agentId: agent.id, type, severity, description });

    // 严重违规触发隔离
    if (severity === VIOLATION_SEVERITY.CRITICAL) {
      this._quarantineAgent(agent.id, `严重违规: ${description}`);
    }
  }

  // ═══════════════════════════════════════
  // 异常检测
  // ═══════════════════════════════════════

  /**
   * 运行异常检测
   */
  runAnomalyCheck() {
    if (!this._subAgentManager) return [];

    const anomalies = [];
    this._stats.checksPerformed++;

    for (const agent of this._subAgentManager._agents.values()) {
      if (agent.status !== 'running') continue;

      for (const rule of ANOMALY_RULES) {
        const result = rule.check(agent);
        if (result) {
          anomalies.push({
            agentId: agent.id,
            agentName: agent.name,
            rule: rule.name,
            severity: result.severity,
            reason: result.reason,
            timestamp: Date.now(),
          });

          // 触发违规记录
          this._subAgentManager.recordViolation(agent.id, {
            type: VIOLATION_TYPE.ANOMALOUS_BEHAVIOR,
            severity: result.severity,
            description: `[${rule.name}] ${result.reason}`,
          });

          this._logger.warn(`[Guardian] 异常检测: ${agent.name} - ${rule.name}: ${result.reason}`);

          // 严重异常触发隔离
          if (result.severity === VIOLATION_SEVERITY.CRITICAL) {
            this._quarantineAgent(agent.id, `异常检测: ${rule.name} - ${result.reason}`);
          }
        }
      }
    }

    if (anomalies.length > 0) {
      this._stats.alertsTriggered++;
      this.emit('anomalies_detected', { anomalies, timestamp: Date.now() });
    }

    return anomalies;
  }

  // ═══════════════════════════════════════
  // 隔离与恢复
  // ═══════════════════════════════════════

  /**
   * 隔离子智能体
   */
  _quarantineAgent(agentId, reason) {
    this._lockdownAgents.add(agentId);
    this._stats.agentsQuarantined++;

    // 通知子智能体管理器停止该智能体
    if (this._subAgentManager) {
      this._subAgentManager.stop(agentId);
    }

    this._logger.error(`[Guardian] 隔离子智能体: ${agentId} - ${reason}`);
    this.emit('agent_quarantined', { agentId, reason, timestamp: Date.now() });

    // 自动恢复定时器
    setTimeout(() => {
      this._lockdownAgents.delete(agentId);
      this._logger.info(`[Guardian] 子智能体隔离期结束: ${agentId}`);
      this.emit('agent_released', { agentId, timestamp: Date.now() });
    }, this._rules.lockdownDurationMs);
  }

  /**
   * 手动解除隔离
   */
  releaseAgent(agentId) {
    if (this._lockdownAgents.has(agentId)) {
      this._lockdownAgents.delete(agentId);
      this._logger.info(`[Guardian] 手动解除隔离: ${agentId}`);
      return { success: true };
    }
    return { success: false, error: '该子智能体未处于隔离状态' };
  }

  /**
   * 获取隔离列表
   */
  getQuarantinedAgents() {
    return Array.from(this._lockdownAgents);
  }

  // ═══════════════════════════════════════
  // 监控循环
  // ═══════════════════════════════════════

  startMonitoring() {
    if (this._monitorTimer) return;

    this._monitorTimer = setInterval(() => {
      this.runAnomalyCheck();
      this._updateState();
    }, this._monitorInterval);

    this._monitorTimer.unref && this._monitorTimer.unref();
    this._logger.info('[Guardian] 安全监控已启动');
  }

  stopMonitoring() {
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
    this._logger.info('[Guardian] 安全监控已停止');
  }

  _updateState() {
    const quarantineCount = this._lockdownAgents.size;
    const totalAgents = this._subAgentManager?._agents?.size || 0;

    if (quarantineCount > totalAgents * 0.3 && totalAgents > 0) {
      this._state = GUARDIAN_STATE.LOCKDOWN;
    } else if (this._stats.violationsDetected > 10) {
      this._state = GUARDIAN_STATE.ALERT;
    } else {
      this._state = GUARDIAN_STATE.NORMAL;
    }
  }

  // ═══════════════════════════════════════
  // 审计日志
  // ═══════════════════════════════════════

  _auditAction(agentId, action, params) {
    const entry = {
      id: `audit_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: Date.now(),
      agentId,
      action,
      params: this._sanitizeParams(params),
    };

    this._auditLog.push(entry);

    // 限制日志大小
    if (this._auditLog.length > this._maxAuditLog) {
      this._auditLog = this._auditLog.slice(-this._maxAuditLog / 2);
    }
  }

  _sanitizeParams(params) {
    // 脱敏处理
    if (!params) return {};
    const sanitized = { ...params };
    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'key'];
    for (const key of sensitiveKeys) {
      if (sanitized[key]) sanitized[key] = '***REDACTED***';
    }
    return sanitized;
  }

  // ═══════════════════════════════════════
  // 安全检查辅助
  // ═══════════════════════════════════════

  _isConfigModification(action, params) {
    const configActions = ['set_config', 'modify_config', 'update_config', 'write_config',
      'change_setting', 'override_setting', 'reload_config', 'reset_config'];
    return configActions.includes(action) || action.startsWith('config:');
  }

  _isCrossAgentAccess(action, params, ownAgentId) {
    const crossActions = ['access_agent_data', 'read_agent_memory', 'modify_agent',
      'control_agent', 'stop_agent', 'start_agent'];
    if (crossActions.includes(action)) return true;
    // 检查是否在访问其他agent的数据
    if (params?.targetAgentId && params.targetAgentId !== ownAgentId) return true;
    return false;
  }

  _isDangerousSystemOperation(action, params) {
    const dangerousActions = [
      'execute_shell', 'run_command', 'system_call',
      'delete_file', 'remove_directory', 'format',
      'install_package', 'uninstall', 'modify_registry',
      'kill_process', 'shutdown', 'reboot',
      'network_scan', 'port_scan', 'raw_socket',
      'download_executable', 'run_binary',
    ];
    return dangerousActions.includes(action);
  }

  _isReadOnlyAction(action) {
    const readActions = ['read', 'get', 'list', 'query', 'search', 'view', 'fetch', 'check'];
    return readActions.some(prefix => action.startsWith(prefix)) ||
           action === 'read' || action === 'status' || action === 'heartbeat';
  }

  // ═══════════════════════════════════════
  // 统计与状态
  // ═══════════════════════════════════════

  getStats() {
    return {
      state: this._state,
      quarantinedCount: this._lockdownAgents.size,
      quarantinedAgents: this.getQuarantinedAgents(),
      auditLogSize: this._auditLog.length,
      ...this._stats,
    };
  }

  getAuditLog(options = {}) {
    let logs = [...this._auditLog];
    if (options.agentId) logs = logs.filter(l => l.agentId === options.agentId);
    if (options.limit) logs = logs.slice(-options.limit);
    return logs;
  }

  close() {
    this.stopMonitoring();
  }
}

module.exports = {
  SubAgentGuardian,
  VIOLATION_TYPE,
  VIOLATION_SEVERITY,
  GUARDIAN_STATE,
  ANOMALY_RULES,
};
