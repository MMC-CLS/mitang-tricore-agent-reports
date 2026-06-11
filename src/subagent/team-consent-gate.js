/**
 * 蜜糖 TriCore Agent - 团队执行确认门控 (Team Consent Gate)
 *
 * 核心职责：
 *   1. 执行前用户确认 - 任何团队级执行操作都必须获得用户确认
 *   2. 确认请求管理 - 生成/发送/跟踪确认请求及其状态
 *   3. 超时自动拒绝 - 超时未确认自动拒绝，防止无限等待
 *   4. 批量确认 - 支持多操作合并为一个确认请求
 *   5. 确认审计 - 记录所有确认/拒绝操作供审计
 *
 * 确认类型：
 *   - execute_tool:    执行工具
 *   - send_message:    发送消息（子智能体间通信）
 *   - modify_state:    修改团队状态
 *   - create_agent:    创建子智能体
 *   - destroy_agent:   销毁子智能体
 *   - external_action: 外部操作（文件/网络等）
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 常量 ──

const CONSENT_TYPE = Object.freeze({
  EXECUTE_TOOL: 'execute_tool',
  SEND_MESSAGE: 'send_message',
  MODIFY_STATE: 'modify_state',
  CREATE_AGENT: 'create_agent',
  DESTROY_AGENT: 'destroy_agent',
  EXTERNAL_ACTION: 'external_action',
});

const CONSENT_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

const DEFAULT_CONFIG = {
  defaultTimeout: 120000,      // 默认确认超时 2分钟
  maxTimeout: 600000,           // 最大超时 10分钟
  maxPendingRequests: 50,       // 最大待处理确认数
  auditEnabled: true,
};

class ConsentRequest {
  constructor(options = {}) {
    this.id = options.id || `consent_${crypto.randomUUID().slice(0, 8)}`;
    this.type = options.type || CONSENT_TYPE.EXECUTE_TOOL;
    this.status = CONSENT_STATUS.PENDING;
    this.teamId = options.teamId || null;
    this.agentId = options.agentId || null;       // 发起请求的子智能体
    this.agentName = options.agentName || '未知';
    this.action = options.action || '';            // 操作描述
    this.details = options.details || {};          // 操作详情
    this.risk = options.risk || 'medium';          // 风险等级: low/medium/high/critical
    this.timeout = options.timeout || DEFAULT_CONFIG.defaultTimeout;
    this.createdAt = Date.now();
    this.expiresAt = this.createdAt + this.timeout;
    this.respondedAt = null;
    this.response = null;                          // 用户回复内容
    this.metadata = options.metadata || {};
    this.onApprove = options.onApprove || null;    // 批准回调
    this.onReject = options.onReject || null;      // 拒绝回调
  }

  getSummary() {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      teamId: this.teamId,
      agentId: this.agentId,
      agentName: this.agentName,
      action: this.action,
      risk: this.risk,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      remainingMs: Math.max(0, this.expiresAt - Date.now()),
    };
  }
}

class TeamConsentGate extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._config = { ...DEFAULT_CONFIG, ...options };

    // 待处理确认请求
    this._pending = new Map();   // consentId → ConsentRequest

    // 确认历史
    this._history = [];          // 最近N条
    this._maxHistory = options.maxHistory || 200;

    // 超时检查定时器
    this._timeoutTimer = null;
    this._timeoutInterval = options.timeoutInterval || 5000;
  }

  // ═══════════════════════════════════════
  // 确认请求管理
  // ═══════════════════════════════════════

  /**
   * 创建确认请求
   * @param {object} options - 请求选项
   * @returns {object} { success, consentId, request }
   */
  requestConsent(options = {}) {
    // 容量检查
    if (this._pending.size >= this._config.maxPendingRequests) {
      return { success: false, error: '待确认请求过多，请先处理已有请求' };
    }

    const request = new ConsentRequest({
      ...options,
      id: options.id || `consent_${crypto.randomUUID().slice(0, 8)}`,
    });

    this._pending.set(request.id, request);

    // 启动超时定时器
    if (!this._timeoutTimer) {
      this._startTimeoutCheck();
    }

    this._logger.info(`[TeamConsentGate] 确认请求: ${request.id} - "${request.action}" [${request.risk}]`);

    this.emit('consent_requested', {
      consentId: request.id,
      type: request.type,
      teamId: request.teamId,
      agentId: request.agentId,
      agentName: request.agentName,
      action: request.action,
      risk: request.risk,
      details: request.details,
      expiresAt: request.expiresAt,
    });

    return {
      success: true,
      consentId: request.id,
      request: request.getSummary(),
    };
  }

  /**
   * 用户批准确认请求
   * @param {string} consentId
   * @param {string} [response] - 用户附加回复
   * @returns {object}
   */
  approve(consentId, response = '') {
    const request = this._pending.get(consentId);
    if (!request) {
      return { success: false, error: `确认请求不存在或已过期: ${consentId}` };
    }

    if (request.status !== CONSENT_STATUS.PENDING) {
      return { success: false, error: `确认请求状态为 ${request.status}，无法批准` };
    }

    request.status = CONSENT_STATUS.APPROVED;
    request.respondedAt = Date.now();
    request.response = response;

    this._pending.delete(consentId);
    this._addToHistory(request);

    this._logger.info(`[TeamConsentGate] 确认批准: ${consentId} - "${request.action}"`);

    // 执行批准回调
    if (typeof request.onApprove === 'function') {
      try {
        request.onApprove(request);
      } catch (e) {
        this._logger.error(`[TeamConsentGate] 批准回调执行失败: ${e.message}`);
      }
    }

    this.emit('consent_approved', {
      consentId,
      agentId: request.agentId,
      teamId: request.teamId,
      action: request.action,
      response,
    });

    return { success: true, consentId, status: CONSENT_STATUS.APPROVED };
  }

  /**
   * 用户拒绝确认请求
   * @param {string} consentId
   * @param {string} [reason] - 拒绝原因
   * @returns {object}
   */
  reject(consentId, reason = '用户拒绝') {
    const request = this._pending.get(consentId);
    if (!request) {
      return { success: false, error: `确认请求不存在或已过期: ${consentId}` };
    }

    if (request.status !== CONSENT_STATUS.PENDING) {
      return { success: false, error: `确认请求状态为 ${request.status}，无法拒绝` };
    }

    request.status = CONSENT_STATUS.REJECTED;
    request.respondedAt = Date.now();
    request.response = reason;

    this._pending.delete(consentId);
    this._addToHistory(request);

    this._logger.info(`[TeamConsentGate] 确认拒绝: ${consentId} - "${request.action}" - 原因: ${reason}`);

    // 执行拒绝回调
    if (typeof request.onReject === 'function') {
      try {
        request.onReject(request);
      } catch (e) {
        this._logger.error(`[TeamConsentGate] 拒绝回调执行失败: ${e.message}`);
      }
    }

    this.emit('consent_rejected', {
      consentId,
      agentId: request.agentId,
      teamId: request.teamId,
      action: request.action,
      reason,
    });

    return { success: true, consentId, status: CONSENT_STATUS.REJECTED };
  }

  /**
   * 取消确认请求（由发起方主动取消）
   */
  cancel(consentId) {
    const request = this._pending.get(consentId);
    if (!request) {
      return { success: false, error: `确认请求不存在: ${consentId}` };
    }

    request.status = CONSENT_STATUS.CANCELLED;
    request.respondedAt = Date.now();

    this._pending.delete(consentId);
    this._addToHistory(request);

    this.emit('consent_cancelled', { consentId });
    return { success: true };
  }

  /**
   * 获取待确认请求列表
   */
  listPending() {
    return Array.from(this._pending.values()).map(r => r.getSummary());
  }

  /**
   * 获取单个确认请求详情
   */
  getRequest(consentId) {
    const request = this._pending.get(consentId);
    if (!request) {
      // 尝试从历史中查找
      const historyItem = this._history.find(h => h.id === consentId);
      return historyItem ? historyItem.getSummary() : null;
    }
    return request.getSummary();
  }

  /**
   * 获取确认历史
   */
  getHistory(limit = 50) {
    return this._history.slice(-limit).map(r => r.getSummary());
  }

  /**
   * 获取统计
   */
  getStats() {
    const pending = this._pending.size;
    const approved = this._history.filter(h => h.status === CONSENT_STATUS.APPROVED).length;
    const rejected = this._history.filter(h => h.status === CONSENT_STATUS.REJECTED).length;
    const expired = this._history.filter(h => h.status === CONSENT_STATUS.EXPIRED).length;

    return {
      pending,
      total: this._history.length,
      approved,
      rejected,
      expired,
      approvalRate: approved + rejected > 0
        ? Math.round((approved / (approved + rejected)) * 100)
        : 100,
    };
  }

  // ═══════════════════════════════════════
  // 便捷方法
  // ═══════════════════════════════════════

  /**
   * 请求执行工具确认
   */
  requestToolExecution(agentId, agentName, teamId, toolName, params, options = {}) {
    return this.requestConsent({
      type: CONSENT_TYPE.EXECUTE_TOOL,
      agentId,
      agentName,
      teamId,
      action: `子智能体 "${agentName}" 想要执行工具: ${toolName}`,
      details: { toolName, params },
      risk: options.risk || this._assessToolRisk(toolName),
      ...options,
    });
  }

  /**
   * 请求子智能体间通信确认
   */
  requestInterAgentMessage(fromAgentId, fromName, toAgentId, toName, teamId, message, options = {}) {
    return this.requestConsent({
      type: CONSENT_TYPE.SEND_MESSAGE,
      agentId: fromAgentId,
      agentName: fromName,
      teamId,
      action: `子智能体 "${fromName}" 向 "${toName}" 发送消息`,
      details: { fromAgentId, toAgentId, messagePreview: (message || '').substring(0, 100) },
      risk: 'low',
      ...options,
    });
  }

  /**
   * 请求外部操作确认
   */
  requestExternalAction(agentId, agentName, teamId, action, details, options = {}) {
    return this.requestConsent({
      type: CONSENT_TYPE.EXTERNAL_ACTION,
      agentId,
      agentName,
      teamId,
      action: `子智能体 "${agentName}" 想要执行外部操作: ${action}`,
      details,
      risk: options.risk || 'high',
      ...options,
    });
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  _startTimeoutCheck() {
    this._timeoutTimer = setInterval(() => {
      this._checkTimeouts();
    }, this._timeoutInterval);
    this._timeoutTimer.unref && this._timeoutTimer.unref();
  }

  _checkTimeouts() {
    const now = Date.now();
    for (const [id, request] of this._pending) {
      if (now >= request.expiresAt) {
        request.status = CONSENT_STATUS.EXPIRED;
        request.respondedAt = now;

        this._pending.delete(id);
        this._addToHistory(request);

        this._logger.warn(`[TeamConsentGate] 确认超时: ${id} - "${request.action}"`);

        // 执行拒绝回调（超时视为拒绝）
        if (typeof request.onReject === 'function') {
          try {
            request.onReject(request);
          } catch (e) {
            this._logger.error(`[TeamConsentGate] 超时回调执行失败: ${e.message}`);
          }
        }

        this.emit('consent_expired', {
          consentId: id,
          agentId: request.agentId,
          action: request.action,
        });
      }
    }

    // 无待处理请求时停止定时器
    if (this._pending.size === 0 && this._timeoutTimer) {
      clearInterval(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  _addToHistory(request) {
    this._history.push(request);
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }
  }

  _assessToolRisk(toolName) {
    const highRiskTools = ['file_operation', 'delete', 'execute', 'write', 'modify_config',
      'automation_script', 'schedule_task'];
    const mediumRiskTools = ['report_generate', 'alert_trigger', 'web_fetch'];

    if (highRiskTools.includes(toolName)) return 'high';
    if (mediumRiskTools.includes(toolName)) return 'medium';
    return 'low';
  }

  /**
   * 清理资源
   */
  close() {
    if (this._timeoutTimer) {
      clearInterval(this._timeoutTimer);
      this._timeoutTimer = null;
    }
    this._pending.clear();
    this._history = [];
    this.removeAllListeners();
  }
}

module.exports = {
  TeamConsentGate,
  ConsentRequest,
  CONSENT_TYPE,
  CONSENT_STATUS,
};
