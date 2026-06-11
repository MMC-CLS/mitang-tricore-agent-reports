/**
 * 蜜糖 TriCore Agent - 团队管理器 (Team Manager)
 *
 * 核心职责：
 *   1. 团队创建与销毁 - 完整的团队生命周期管理
 *   2. 团队成员管理 - 添加/移除/角色分配
 *   3. 团队对话协调 - 委派给 TeamCoordinator
 *   4. 执行确认门控 - 委派给 TeamConsentGate
 *   5. 团队状态监控 - 成员活跃度/任务进度/安全状态
 *
 * 团队类型：
 *   - task_force:    任务执行团队 - 分解并执行复杂任务
 *   - discussion:    讨论组 - 多角度分析讨论
 *   - pipeline:      流水线 - 顺序处理任务链
 *   - custom:        自定义团队
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { TeamCoordinator, COORDINATION_MODE, MESSAGE_STATUS, TEAM_ROLE } = require('./team-coordinator');
const { TeamConsentGate, CONSENT_TYPE, CONSENT_STATUS } = require('./team-consent-gate');

// ── 常量 ──

const TEAM_TYPE = Object.freeze({
  TASK_FORCE: 'task_force',
  DISCUSSION: 'discussion',
  PIPELINE: 'pipeline',
  CUSTOM: 'custom',
});

const TEAM_STATUS = Object.freeze({
  FORMING: 'forming',
  ACTIVE: 'active',
  PAUSED: 'paused',
  DISSOLVED: 'dissolved',
});

const DEFAULT_CONFIG = {
  maxTeams: 30,
  maxMembersPerTeam: 10,
  dataDir: null,
};

class TeamInstance {
  constructor(options = {}) {
    this.id = options.id || `team_${crypto.randomUUID().slice(0, 8)}`;
    this.name = options.name || '未命名团队';
    this.type = options.type || TEAM_TYPE.TASK_FORCE;
    this.description = options.description || '';
    this.status = TEAM_STATUS.FORMING;
    this.goal = options.goal || '';           // 团队目标
    this.members = options.members || [];     // [{ agentId, name, role, type, status }]
    this.createdAt = options.createdAt || Date.now();
    this.activatedAt = null;
    this.dissolvedAt = null;
    this.lastActive = null;

    // 团队配置
    this.config = {
      requireConsent: options.requireConsent !== false,
      allowBroadcast: options.allowBroadcast !== false,
      consensusThreshold: options.consensusThreshold || 0.6,
      ...options.teamConfig,
    };

    // 统计
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      consentRequests: 0,
      consentApproved: 0,
      consentRejected: 0,
    };
  }

  getSummary() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      description: this.description,
      status: this.status,
      goal: this.goal,
      memberCount: this.members.length,
      members: this.members.map(m => ({
        agentId: m.agentId,
        name: m.name,
        role: m.role,
        status: m.status,
      })),
      config: this.config,
      stats: { ...this.stats },
      createdAt: this.createdAt,
      activatedAt: this.activatedAt,
      lastActive: this.lastActive,
    };
  }

  getDetail() {
    return {
      ...this.getSummary(),
      dissolvedAt: this.dissolvedAt,
    };
  }
}

class TeamManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._config = { ...DEFAULT_CONFIG, ...options };
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data', 'teams');
    this._subAgentManager = options.subAgentManager || null;

    // 团队注册表
    this._teams = new Map();  // teamId → TeamInstance

    // 子组件
    this._consentGate = new TeamConsentGate({
      logger: this._logger,
      ...options.consentGateOptions,
    });

    this._coordinator = new TeamCoordinator({
      logger: this._logger,
      consentGate: this._consentGate,
      subAgentManager: this._subAgentManager,
      ...options.coordinatorOptions,
    });

    // 绑定事件转发
    this._bindConsentEvents();
    this._bindCoordinatorEvents();

    // 确保数据目录存在
    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir, { recursive: true });
    }
  }

  // ═══════════════════════════════════════
  // 团队生命周期管理
  // ═══════════════════════════════════════

  /**
   * 创建团队
   * @param {object} options
   * @returns {object} { success, teamId, team }
   */
  create(options = {}) {
    const { name, type, description, goal, members = [], teamConfig = {} } = options;

    // 容量检查
    if (this._teams.size >= this._config.maxTeams) {
      return { success: false, error: `已达最大团队数量 (${this._config.maxTeams})` };
    }

    // 名称检查
    if (!name || name.trim().length === 0) {
      return { success: false, error: '团队名称不能为空' };
    }

    // 名称唯一性检查
    for (const team of this._teams.values()) {
      if (team.name === name.trim()) {
        return { success: false, error: `团队名称 "${name}" 已存在` };
      }
    }

    // 成员数量检查
    if (members.length > this._config.maxMembersPerTeam) {
      return { success: false, error: `团队成员不能超过 ${this._config.maxMembersPerTeam} 个` };
    }

    // 验证成员有效性
    const validMembers = [];
    for (const member of members) {
      if (this._subAgentManager) {
        const agent = this._subAgentManager.get(member.agentId || member.id);
        if (!agent) {
          return { success: false, error: `子智能体不存在: ${member.agentId || member.id}` };
        }
      }
      validMembers.push({
        agentId: member.agentId || member.id,
        name: member.name || '未命名',
        role: member.role || TEAM_ROLE.MEMBER,
        type: member.type || 'assistant',
        status: 'active',
      });
    }

    const team = new TeamInstance({
      name: name.trim(),
      type: type || TEAM_TYPE.TASK_FORCE,
      description: description || '',
      goal: goal || '',
      members: validMembers,
      requireConsent: teamConfig.requireConsent !== false,
      allowBroadcast: teamConfig.allowBroadcast !== false,
      consensusThreshold: teamConfig.consensusThreshold || 0.6,
      teamConfig,
    });

    this._teams.set(team.id, team);

    // 初始化团队协调上下文
    this._coordinator.initTeamContext(team.id, validMembers, team.config);

    this._logger.info(`[TeamManager] 团队创建: "${team.name}" (${team.id}) 类型=${team.type} 成员=${validMembers.length}`);

    this.emit('team_created', {
      teamId: team.id,
      name: team.name,
      type: team.type,
      memberCount: validMembers.length,
    });

    this._persist();

    return { success: true, teamId: team.id, team: team.getSummary() };
  }

  /**
   * 激活团队
   */
  activate(teamId) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    if (team.status === TEAM_STATUS.ACTIVE) {
      return { success: false, error: '团队已激活' };
    }

    if (team.status === TEAM_STATUS.DISSOLVED) {
      return { success: false, error: '团队已解散，无法激活' };
    }

    team.status = TEAM_STATUS.ACTIVE;
    team.activatedAt = team.activatedAt || Date.now();
    team.lastActive = Date.now();

    this._logger.info(`[TeamManager] 团队激活: "${team.name}" (${teamId})`);

    this.emit('team_activated', { teamId, name: team.name });
    this._persist();

    return { success: true, teamId, status: team.status };
  }

  /**
   * 暂停团队
   */
  pause(teamId) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    if (team.status !== TEAM_STATUS.ACTIVE) {
      return { success: false, error: `团队未激活 (当前状态: ${team.status})` };
    }

    team.status = TEAM_STATUS.PAUSED;
    team.lastActive = Date.now();

    this._logger.info(`[TeamManager] 团队暂停: "${team.name}" (${teamId})`);

    this.emit('team_paused', { teamId, name: team.name });
    this._persist();

    return { success: true, teamId, status: team.status };
  }

  /**
   * 解散团队
   */
  dissolve(teamId) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    const name = team.name;
    team.status = TEAM_STATUS.DISSOLVED;
    team.dissolvedAt = Date.now();
    team.lastActive = Date.now();

    // 清理协调器上下文
    this._coordinator.removeTeamContext(teamId);

    this._logger.info(`[TeamManager] 团队解散: "${name}" (${teamId})`);

    this.emit('team_dissolved', { teamId, name });
    this._persist();

    return { success: true, teamId, name };
  }

  /**
   * 删除团队（从注册表移除）
   */
  remove(teamId) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    // 先解散
    if (team.status !== TEAM_STATUS.DISSOLVED) {
      this.dissolve(teamId);
    }

    const name = team.name;
    this._teams.delete(teamId);
    this._coordinator.removeTeamContext(teamId);

    this._logger.info(`[TeamManager] 团队已移除: "${name}" (${teamId})`);

    this.emit('team_removed', { teamId, name });
    this._persist();

    return { success: true, teamId, name };
  }

  // ═══════════════════════════════════════
  // 团队成员管理
  // ═══════════════════════════════════════

  /**
   * 添加成员到团队
   */
  addMember(teamId, agentId, role = TEAM_ROLE.MEMBER) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    if (team.status === TEAM_STATUS.DISSOLVED) {
      return { success: false, error: '团队已解散' };
    }

    if (team.members.length >= this._config.maxMembersPerTeam) {
      return { success: false, error: `团队成员已满 (${this._config.maxMembersPerTeam})` };
    }

    // 检查是否已在团队中
    if (team.members.find(m => m.agentId === agentId)) {
      return { success: false, error: '该子智能体已在团队中' };
    }

    // 获取子智能体信息
    let memberInfo = { agentId, name: '未命名', role, type: 'assistant', status: 'active' };
    if (this._subAgentManager) {
      const agent = this._subAgentManager.get(agentId);
      if (!agent) {
        return { success: false, error: `子智能体不存在: ${agentId}` };
      }
      memberInfo = {
        agentId,
        name: agent.name || '未命名',
        role,
        type: agent.type || 'assistant',
        status: 'active',
      };
    }

    team.members.push(memberInfo);
    team.lastActive = Date.now();

    // 更新协调器上下文
    this._coordinator.updateTeamMembers(teamId, team.members);

    this._logger.info(`[TeamManager] 成员加入: ${memberInfo.name} → "${team.name}"`);

    this.emit('member_added', {
      teamId,
      teamName: team.name,
      agentId,
      agentName: memberInfo.name,
      role,
    });

    this._persist();

    return { success: true, teamId, member: memberInfo };
  }

  /**
   * 从团队移除成员
   */
  removeMember(teamId, agentId) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    const idx = team.members.findIndex(m => m.agentId === agentId);
    if (idx === -1) {
      return { success: false, error: '该子智能体不在团队中' };
    }

    const removed = team.members.splice(idx, 1)[0];
    team.lastActive = Date.now();

    // 更新协调器上下文
    this._coordinator.updateTeamMembers(teamId, team.members);

    this._logger.info(`[TeamManager] 成员移出: ${removed.name} ← "${team.name}"`);

    this.emit('member_removed', {
      teamId,
      teamName: team.name,
      agentId,
      agentName: removed.name,
    });

    this._persist();

    return { success: true, teamId, removedMember: removed };
  }

  /**
   * 更新成员角色
   */
  updateMemberRole(teamId, agentId, newRole) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    const member = team.members.find(m => m.agentId === agentId);
    if (!member) {
      return { success: false, error: '该子智能体不在团队中' };
    }

    if (!Object.values(TEAM_ROLE).includes(newRole)) {
      return { success: false, error: `无效角色: ${newRole}` };
    }

    member.role = newRole;
    team.lastActive = Date.now();

    this._logger.info(`[TeamManager] 角色变更: ${member.name} → ${newRole} (${team.name})`);

    this.emit('member_role_changed', {
      teamId,
      agentId,
      agentName: member.name,
      role: newRole,
    });

    return { success: true, teamId, agentId, role: newRole };
  }

  // ═══════════════════════════════════════
  // 团队对话与协作（委托给协调器）
  // ═══════════════════════════════════════

  /**
   * 向团队发送消息（子智能体间通信入口）
   */
  async sendTeamMessage(teamId, fromAgentId, fromAgentName, content, options = {}) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    if (team.status !== TEAM_STATUS.ACTIVE) {
      return { success: false, error: `团队未激活 (当前状态: ${team.status})` };
    }

    const result = await this._coordinator.sendMessage({
      teamId,
      fromAgentId,
      fromAgentName,
      toAgentId: options.toAgentId || null,
      content,
      type: options.type || 'text',
      mode: options.mode || COORDINATION_MODE.DIRECT,
      requiresConsent: options.requiresConsent !== false,
    });

    if (result.success) {
      team.stats.messagesSent++;
      team.lastActive = Date.now();
    }

    return result;
  }

  /**
   * 广播消息到团队所有成员
   */
  async broadcastToTeam(teamId, fromAgentId, fromAgentName, content, options = {}) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    if (team.status !== TEAM_STATUS.ACTIVE) {
      return { success: false, error: `团队未激活` };
    }

    const result = await this._coordinator.broadcastToTeam(
      teamId, fromAgentId, fromAgentName, content, options
    );

    if (result.success) {
      team.stats.messagesSent++;
      team.lastActive = Date.now();
    }

    return result;
  }

  /**
   * 获取团队消息历史
   */
  getTeamMessages(teamId, limit = 50) {
    return this._coordinator.getTeamMessages(teamId, limit);
  }

  /**
   * 启动团队共识投票
   */
  async startTeamConsensus(teamId, question, proposerId, proposerName, options = {}) {
    const team = this._teams.get(teamId);
    if (!team) {
      return { success: false, error: `团队不存在: ${teamId}` };
    }

    if (team.status !== TEAM_STATUS.ACTIVE) {
      return { success: false, error: `团队未激活` };
    }

    return this._coordinator.startConsensus(teamId, question, proposerId, proposerName, options);
  }

  /**
   * 投票
   */
  castTeamVote(teamId, pollId, agentId, agentName, vote) {
    return this._coordinator.castVote(pollId, agentId, agentName, vote);
  }

  // ═══════════════════════════════════════
  // 确认门控（委托给 ConsentGate）
  // ═══════════════════════════════════════

  /**
   * 获取待确认请求列表
   */
  getPendingConsents() {
    return this._consentGate.listPending();
  }

  /**
   * 批准确认请求
   */
  approveConsent(consentId, response = '') {
    const result = this._consentGate.approve(consentId, response);
    if (result.success) {
      // 更新相关团队统计
      const request = this._consentGate.getRequest(consentId);
      if (request && request.teamId) {
        const team = this._teams.get(request.teamId);
        if (team) team.stats.consentApproved++;
      }
    }
    return result;
  }

  /**
   * 拒绝确认请求
   */
  rejectConsent(consentId, reason = '用户拒绝') {
    const result = this._consentGate.reject(consentId, reason);
    if (result.success) {
      const request = this._consentGate.getRequest(consentId);
      if (request && request.teamId) {
        const team = this._teams.get(request.teamId);
        if (team) team.stats.consentRejected++;
      }
    }
    return result;
  }

  /**
   * 获取确认统计
   */
  getConsentStats() {
    return this._consentGate.getStats();
  }

  /**
   * 获取确认历史
   */
  getConsentHistory(limit = 50) {
    return this._consentGate.getHistory(limit);
  }

  // ═══════════════════════════════════════
  // 查询与统计
  // ═══════════════════════════════════════

  /**
   * 获取所有团队列表
   */
  list(options = {}) {
    let teams = Array.from(this._teams.values());

    if (options.type) teams = teams.filter(t => t.type === options.type);
    if (options.status) teams = teams.filter(t => t.status === options.status);

    return teams.map(t => t.getSummary());
  }

  /**
   * 获取团队详情
   */
  get(teamId) {
    const team = this._teams.get(teamId);
    return team ? team.getDetail() : null;
  }

  /**
   * 获取子智能体所属的团队
   */
  getTeamsForAgent(agentId) {
    const teams = [];
    for (const team of this._teams.values()) {
      if (team.members.some(m => m.agentId === agentId)) {
        teams.push(team.getSummary());
      }
    }
    return teams;
  }

  /**
   * 获取团队统计
   */
  getStats() {
    const teams = Array.from(this._teams.values());
    const byStatus = {};
    const byType = {};

    for (const t of teams) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byType[t.type] = (byType[t.type] || 0) + 1;
    }

    const activeTeams = teams.filter(t => t.status === TEAM_STATUS.ACTIVE);

    return {
      total: teams.length,
      active: activeTeams.length,
      byStatus,
      byType,
      totalMembers: teams.reduce((s, t) => s + t.members.length, 0),
      consent: this._consentGate.getStats(),
      coordinator: this._coordinator.getStats(),
    };
  }

  // ═══════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════

  _persist() {
    try {
      const data = Array.from(this._teams.values()).map(t => ({
        id: t.id,
        name: t.name,
        type: t.type,
        description: t.description,
        status: t.status,
        goal: t.goal,
        members: t.members,
        config: t.config,
        stats: t.stats,
        createdAt: t.createdAt,
        activatedAt: t.activatedAt,
        dissolvedAt: t.dissolvedAt,
        lastActive: t.lastActive,
      }));
      fs.writeFileSync(
        path.join(this._dataDir, 'teams.json'),
        JSON.stringify(data, null, 2),
        'utf8'
      );
    } catch (e) {
      this._logger?.warn?.(`团队数据持久化失败: ${e.message}`);
    }
  }

  /**
   * 从持久化恢复团队
   */
  restore() {
    try {
      const filePath = path.join(this._dataDir, 'teams.json');
      if (!fs.existsSync(filePath)) return 0;

      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let count = 0;

      for (const item of data) {
        if (item.status === TEAM_STATUS.DISSOLVED) continue;
        const team = new TeamInstance(item);
        this._teams.set(team.id, team);

        // 恢复协调器上下文
        this._coordinator.initTeamContext(team.id, team.members, team.config);

        count++;
      }

      this._logger?.info?.(`从持久化恢复 ${count} 个团队`);
      return count;
    } catch (e) {
      this._logger?.warn?.(`团队恢复失败: ${e.message}`);
      return 0;
    }
  }

  // ═══════════════════════════════════════
  // 事件绑定
  // ═══════════════════════════════════════

  _bindConsentEvents() {
    this._consentGate.on('consent_requested', (data) => {
      this.emit('consent_requested', data);
    });

    this._consentGate.on('consent_approved', (data) => {
      this.emit('consent_approved', data);
    });

    this._consentGate.on('consent_rejected', (data) => {
      this.emit('consent_rejected', data);
    });

    this._consentGate.on('consent_expired', (data) => {
      this.emit('consent_expired', data);
    });
  }

  _bindCoordinatorEvents() {
    this._coordinator.on('message_delivered', (data) => {
      const team = this._teams.get(data.teamId);
      if (team) {
        team.stats.messagesReceived++;
        team.lastActive = Date.now();
      }
      this.emit('team_message_delivered', data);
    });

    this._coordinator.on('message_blocked', (data) => {
      this.emit('team_message_blocked', data);
    });

    this._coordinator.on('consensus_started', (data) => {
      this.emit('team_consensus_started', data);
    });

    this._coordinator.on('vote_cast', (data) => {
      this.emit('team_vote_cast', data);
    });

    this._coordinator.on('consensus_resolved', (data) => {
      this.emit('team_consensus_resolved', data);
    });
  }

  // ═══════════════════════════════════════
  // 访问器
  // ═══════════════════════════════════════

  get consentGate() { return this._consentGate; }
  get coordinator() { return this._coordinator; }

  /**
   * 关闭管理器
   */
  close() {
    this._consentGate.close();
    this._coordinator.close();
    this._teams.clear();
    this._persist();
    this.removeAllListeners();
  }
}

module.exports = {
  TeamManager,
  TeamInstance,
  TEAM_TYPE,
  TEAM_STATUS,
  TEAM_ROLE,
  TeamCoordinator,
  TeamConsentGate,
  COORDINATION_MODE,
  MESSAGE_STATUS,
  CONSENT_TYPE,
  CONSENT_STATUS,
};
