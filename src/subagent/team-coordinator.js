/**
 * 蜜糖 TriCore Agent - 团队协调器 (Team Coordinator)
 *
 * 核心职责：
 *   1. 子智能体间消息传递 - 团队成员间双向通信管道
 *   2. 团队对话协调 - 管理团队级对话上下文与消息路由
 *   3. 任务协作分配 - 将团队任务分解并分配给各子智能体
 *   4. 共识协调 - 多子智能体协商达成一致
 *   5. 结果聚合 - 汇总各子智能体的输出为统一结果
 *
 * 通信模式：
 *   - DIRECT:  直接发送到指定子智能体
 *   - BROADCAST: 广播到所有团队成员
 *   - ROUND_ROBIN: 轮流发言
 *   - CONSENSUS: 协商达成共识
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 常量 ──

const COORDINATION_MODE = Object.freeze({
  DIRECT: 'direct',
  BROADCAST: 'broadcast',
  ROUND_ROBIN: 'round_robin',
  CONSENSUS: 'consensus',
});

const MESSAGE_STATUS = Object.freeze({
  SENT: 'sent',
  DELIVERED: 'delivered',
  PROCESSING: 'processing',
  RESPONDED: 'responded',
  FAILED: 'failed',
  BLOCKED: 'blocked',  // 被确认门控阻塞
});

const TEAM_ROLE = Object.freeze({
  LEADER: 'leader',       // 团队领导 - 负责最终决策
  MEMBER: 'member',       // 普通成员
  OBSERVER: 'observer',   // 观察者 - 只读
  COORDINATOR: 'coordinator', // 协调者 - 管理消息路由
});

class TeamMessage {
  constructor(options = {}) {
    this.id = options.id || `tm_${crypto.randomUUID().slice(0, 8)}`;
    this.teamId = options.teamId;
    this.fromAgentId = options.fromAgentId;
    this.fromAgentName = options.fromAgentName || '未知';
    this.toAgentId = options.toAgentId || null;  // null = 广播
    this.content = options.content || '';
    this.type = options.type || 'text';           // text/task/query/response/notification
    this.mode = options.mode || COORDINATION_MODE.DIRECT;
    this.status = MESSAGE_STATUS.SENT;
    this.priority = options.priority || 1;
    this.createdAt = Date.now();
    this.deliveredAt = null;
    this.respondedAt = null;
    this.response = null;
    this.requiresConsent = options.requiresConsent !== false; // 默认需要确认
    this.consentId = null;
    this.metadata = options.metadata || {};
  }

  getSummary() {
    return {
      id: this.id,
      teamId: this.teamId,
      fromAgentId: this.fromAgentId,
      fromAgentName: this.fromAgentName,
      toAgentId: this.toAgentId,
      contentPreview: (this.content || '').substring(0, 80),
      type: this.type,
      status: this.status,
      createdAt: this.createdAt,
    };
  }
}

class TeamCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._consentGate = options.consentGate || null;       // 确认门控引用
    this._subAgentManager = options.subAgentManager || null; // 子智能体管理器引用

    // 团队上下文
    this._teamContexts = new Map();  // teamId → { members, messages, state, config }

    // 消息历史
    this._messageHistory = [];       // TeamMessage[]
    this._maxHistory = options.maxMessageHistory || 1000;

    // 对话轮次管理
    this._roundRobinIndex = new Map(); // teamId → currentIndex

    // 共识投票
    this._consensusPolls = new Map();  // pollId → { question, votes, ... }
  }

  // ═══════════════════════════════════════
  // 团队上下文管理
  // ═══════════════════════════════════════

  /**
   * 初始化团队上下文
   */
  initTeamContext(teamId, members = [], config = {}) {
    const context = {
      teamId,
      members: members.map(m => ({
        agentId: m.agentId || m.id,
        name: m.name || '未命名',
        role: m.role || TEAM_ROLE.MEMBER,
        type: m.type || 'assistant',
        status: 'active',
      })),
      messages: [],          // 团队级对话消息
      activeTasks: [],       // 活跃协作任务
      config: {
        requireConsent: config.requireConsent !== false,
        allowBroadcast: config.allowBroadcast !== false,
        maxRoundRobinTurns: config.maxRoundRobinTurns || 20,
        consensusThreshold: config.consensusThreshold || 0.6, // 60%通过
        ...config,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this._teamContexts.set(teamId, context);
    this._roundRobinIndex.set(teamId, 0);

    this._logger.info(`[TeamCoordinator] 团队上下文已初始化: ${teamId} (${members.length} 成员)`);

    return context;
  }

  /**
   * 获取团队上下文
   */
  getTeamContext(teamId) {
    return this._teamContexts.get(teamId) || null;
  }

  /**
   * 更新团队成员
   */
  updateTeamMembers(teamId, members) {
    const context = this._teamContexts.get(teamId);
    if (!context) return { success: false, error: '团队不存在' };

    context.members = members.map(m => ({
      agentId: m.agentId || m.id,
      name: m.name || '未命名',
      role: m.role || TEAM_ROLE.MEMBER,
      type: m.type || 'assistant',
      status: m.status || 'active',
    }));
    context.updatedAt = Date.now();

    return { success: true, memberCount: members.length };
  }

  /**
   * 移除团队上下文
   */
  removeTeamContext(teamId) {
    this._teamContexts.delete(teamId);
    this._roundRobinIndex.delete(teamId);
  }

  // ═══════════════════════════════════════
  // 子智能体间消息传递
  // ═══════════════════════════════════════

  /**
   * 发送消息（子智能体间通信）
   * @param {object} options
   * @returns {Promise<object>}
   */
  async sendMessage(options = {}) {
    const {
      teamId,
      fromAgentId,
      fromAgentName,
      toAgentId,         // null = 广播
      content,
      type = 'text',
      mode = COORDINATION_MODE.DIRECT,
      requiresConsent = true,
    } = options;

    // 获取团队上下文
    const context = this._teamContexts.get(teamId);
    if (!context) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    // 验证发送方是团队成员
    const sender = context.members.find(m => m.agentId === fromAgentId);
    if (!sender) {
      return { success: false, error: `发送方不是团队成员: ${fromAgentId}` };
    }

    // 验证接收方
    if (toAgentId) {
      const receiver = context.members.find(m => m.agentId === toAgentId);
      if (!receiver) {
        return { success: false, error: `接收方不是团队成员: ${toAgentId}` };
      }
    }

    const message = new TeamMessage({
      teamId,
      fromAgentId,
      fromAgentName: fromAgentName || sender.name,
      toAgentId,
      content,
      type,
      mode,
      requiresConsent: requiresConsent && context.config.requireConsent,
    });

    // 如果启用了确认门控，先请求用户确认
    if (message.requiresConsent && this._consentGate) {
      const consentResult = this._consentGate.requestInterAgentMessage(
        fromAgentId,
        fromAgentName || sender.name,
        toAgentId || '所有成员',
        toAgentId
          ? (context.members.find(m => m.agentId === toAgentId)?.name || '未知')
          : '所有成员',
        teamId,
        content,
        {
          onApprove: async () => {
            message.status = MESSAGE_STATUS.SENT;
            await this._deliverMessage(message, context);
          },
          onReject: () => {
            message.status = MESSAGE_STATUS.BLOCKED;
            this._addMessageToHistory(message);
            this.emit('message_blocked', {
              messageId: message.id,
              teamId,
              reason: '用户拒绝确认',
            });
          },
        }
      );

      if (consentResult.success) {
        message.consentId = consentResult.consentId;
        message.status = MESSAGE_STATUS.BLOCKED; // 等待确认
        this._addMessageToHistory(message);

        return {
          success: true,
          messageId: message.id,
          status: 'pending_consent',
          consentId: consentResult.consentId,
        };
      }

      return { success: false, error: consentResult.error };
    }

    // 无需确认，直接投递
    await this._deliverMessage(message, context);
    this._addMessageToHistory(message);

    return { success: true, messageId: message.id, status: message.status };
  }

  /**
   * 广播消息到所有团队成员
   */
  async broadcastToTeam(teamId, fromAgentId, fromAgentName, content, options = {}) {
    return this.sendMessage({
      teamId,
      fromAgentId,
      fromAgentName,
      toAgentId: null, // null = 广播
      content,
      type: options.type || 'notification',
      mode: COORDINATION_MODE.BROADCAST,
      requiresConsent: options.requiresConsent !== false,
    });
  }

  /**
   * 轮流发言（Round Robin）
   */
  async roundRobinSpeak(teamId, content, options = {}) {
    const context = this._teamContexts.get(teamId);
    if (!context) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    const activeMembers = context.members.filter(m => m.status === 'active');
    if (activeMembers.length === 0) {
      return { success: false, error: '团队没有活跃成员' };
    }

    let currentIndex = this._roundRobinIndex.get(teamId) || 0;
    if (currentIndex >= activeMembers.length) {
      currentIndex = 0;
    }

    const currentSpeaker = activeMembers[currentIndex];
    const nextIndex = (currentIndex + 1) % activeMembers.length;
    this._roundRobinIndex.set(teamId, nextIndex);

    return this.sendMessage({
      teamId,
      fromAgentId: currentSpeaker.agentId,
      fromAgentName: currentSpeaker.name,
      toAgentId: activeMembers[nextIndex]?.agentId || null,
      content,
      type: 'response',
      mode: COORDINATION_MODE.ROUND_ROBIN,
      ...options,
    });
  }

  /**
   * 启动共识投票
   */
  async startConsensus(teamId, question, proposerId, proposerName, options = {}) {
    const context = this._teamContexts.get(teamId);
    if (!context) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    const pollId = `poll_${crypto.randomUUID().slice(0, 8)}`;
    const activeMembers = context.members.filter(m => m.status === 'active' && m.agentId !== proposerId);

    const poll = {
      id: pollId,
      teamId,
      question,
      proposerId,
      proposerName,
      options: options.options || ['同意', '反对', '弃权'],
      threshold: options.threshold || context.config.consensusThreshold,
      votes: new Map(),     // agentId → vote
      voters: activeMembers.map(m => m.agentId),
      status: 'open',
      createdAt: Date.now(),
      timeout: options.timeout || 60000,
      expiresAt: Date.now() + (options.timeout || 60000),
      onResolve: options.onResolve || null,
    };

    this._consensusPolls.set(pollId, poll);

    // 广播投票请求给所有成员
    const voteRequest = `[共识投票] 问题: "${question}"\n选项: ${poll.options.join(' / ')}\n投票ID: ${pollId}`;

    await this.broadcastToTeam(
      teamId,
      proposerId,
      proposerName,
      voteRequest,
      { type: 'consensus_vote', requiresConsent: false }
    );

    this._logger.info(`[TeamCoordinator] 共识投票已启动: ${pollId} - "${question}"`);

    this.emit('consensus_started', {
      pollId,
      teamId,
      question,
      proposerId,
      proposerName,
    });

    // 超时处理
    setTimeout(() => this._resolveConsensus(pollId), poll.timeout);

    return { success: true, pollId, voterCount: poll.voters.length };
  }

  /**
   * 投票
   */
  castVote(pollId, agentId, agentName, vote) {
    const poll = this._consensusPolls.get(pollId);
    if (!poll) {
      return { success: false, error: `投票不存在: ${pollId}` };
    }

    if (poll.status !== 'open') {
      return { success: false, error: `投票已关闭 (状态: ${poll.status})` };
    }

    if (!poll.voters.includes(agentId)) {
      return { success: false, error: '您不是有效投票人' };
    }

    if (!poll.options.includes(vote)) {
      return { success: false, error: `无效选项: ${vote}，有效选项: ${poll.options.join(', ')}` };
    }

    poll.votes.set(agentId, { vote, agentName, timestamp: Date.now() });

    this._logger.info(`[TeamCoordinator] 投票: ${pollId} - ${agentName} → "${vote}"`);

    this.emit('vote_cast', {
      pollId,
      teamId: poll.teamId,
      agentId,
      agentName,
      vote,
    });

    // 检查是否所有人都已投票
    if (poll.votes.size >= poll.voters.length) {
      this._resolveConsensus(pollId);
    }

    return { success: true, pollId, voteCount: poll.votes.size, totalVoters: poll.voters.length };
  }

  /**
   * 解析共识结果
   */
  _resolveConsensus(pollId) {
    const poll = this._consensusPolls.get(pollId);
    if (!poll || poll.status !== 'open') return;

    poll.status = 'resolved';

    const voteCounts = {};
    for (const opt of poll.options) {
      voteCounts[opt] = 0;
    }
    for (const [, voteData] of poll.votes) {
      voteCounts[voteData.vote] = (voteCounts[voteData.vote] || 0) + 1;
    }

    const totalVotes = poll.votes.size;
    const leadingOption = Object.entries(voteCounts)
      .sort((a, b) => b[1] - a[1])[0];

    const agreementRate = leadingOption
      ? leadingOption[1] / Math.max(1, totalVotes)
      : 0;

    const consensus = agreementRate >= poll.threshold;
    const result = {
      pollId,
      consensus,
      leadingOption: leadingOption?.[0] || '无',
      agreementRate: Math.round(agreementRate * 100),
      threshold: Math.round(poll.threshold * 100),
      voteCounts,
      totalVotes,
      voterCount: poll.voters.length,
      status: 'resolved',
    };

    this._logger.info(`[TeamCoordinator] 共识结果: ${pollId} - ${consensus ? '达成' : '未达成'} (${result.agreementRate}%)`);

    // 执行回调
    if (typeof poll.onResolve === 'function') {
      try {
        poll.onResolve(result);
      } catch (e) {
        this._logger.error(`[TeamCoordinator] 共识回调失败: ${e.message}`);
      }
    }

    this.emit('consensus_resolved', {
      ...result,
      teamId: poll.teamId,
      question: poll.question,
    });

    return result;
  }

  // ═══════════════════════════════════════
  // 团队对话
  // ═══════════════════════════════════════

  /**
   * 获取团队对话历史
   */
  getTeamMessages(teamId, limit = 50) {
    const messages = this._messageHistory
      .filter(m => m.teamId === teamId)
      .slice(-limit);
    return messages.map(m => m.getSummary());
  }

  /**
   * 获取团队活跃任务
   */
  getTeamTasks(teamId) {
    const context = this._teamContexts.get(teamId);
    return context ? context.activeTasks : [];
  }

  // ═══════════════════════════════════════
  // 统计
  // ═══════════════════════════════════════

  getStats() {
    const teamCount = this._teamContexts.size;
    let totalMembers = 0;
    for (const ctx of this._teamContexts.values()) {
      totalMembers += ctx.members.length;
    }

    return {
      teams: teamCount,
      totalMembers,
      messages: this._messageHistory.length,
      activePolls: this._consensusPolls.size,
      teams: Array.from(this._teamContexts.keys()),
    };
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  async _deliverMessage(message, context) {
    message.status = MESSAGE_STATUS.DELIVERED;
    message.deliveredAt = Date.now();

    // 如果是定向消息且有子智能体管理器
    if (message.toAgentId && this._subAgentManager) {
      try {
        const engine = this._subAgentManager.getEngine(message.toAgentId);
        if (engine) {
          // 通过引擎的sendMessage发送，标记为team消息
          message.status = MESSAGE_STATUS.PROCESSING;
          const result = await engine.sendMessage(
            `[来自 ${message.fromAgentName}] ${message.content}`,
            null,
            { isTeamMessage: true, teamId: message.teamId, coordinatorMessageId: message.id }
          );
          if (result.success) {
            message.status = MESSAGE_STATUS.RESPONDED;
            message.respondedAt = Date.now();
          }
        }
      } catch (e) {
        message.status = MESSAGE_STATUS.FAILED;
        this._logger.warn(`[TeamCoordinator] 消息投递失败: ${e.message}`);
      }
    }

    // 广播时记录到团队上下文
    if (!message.toAgentId || message.mode === COORDINATION_MODE.BROADCAST) {
      context.messages.push({
        id: message.id,
        from: message.fromAgentName,
        content: message.content,
        type: message.type,
        timestamp: message.createdAt,
      });

      // 如果广播且有管理器，向所有活跃成员发送
      if (this._subAgentManager) {
        for (const member of context.members) {
          if (member.agentId === message.fromAgentId) continue;
          if (member.status !== 'active') continue;
          try {
            const engine = this._subAgentManager.getEngine(member.agentId);
            if (engine) {
              await engine.sendMessage(
                `[团队广播 - 来自 ${message.fromAgentName}] ${message.content}`,
                null,
                { isTeamMessage: true, teamId: message.teamId, isBroadcast: true }
              );
            }
          } catch (e) {
            // 静默跳过失败的投递
          }
        }
      }
    }

    this.emit('message_delivered', {
      messageId: message.id,
      teamId: message.teamId,
      fromAgentId: message.fromAgentId,
      toAgentId: message.toAgentId,
      status: message.status,
    });
  }

  _addMessageToHistory(message) {
    this._messageHistory.push(message);
    if (this._messageHistory.length > this._maxHistory) {
      this._messageHistory = this._messageHistory.slice(-this._maxHistory);
    }
  }

  /**
   * 清理资源
   */
  close() {
    this._teamContexts.clear();
    this._roundRobinIndex.clear();
    this._consensusPolls.clear();
    this._messageHistory = [];
    this.removeAllListeners();
  }
}

module.exports = {
  TeamCoordinator,
  TeamMessage,
  COORDINATION_MODE,
  MESSAGE_STATUS,
  TEAM_ROLE,
};
