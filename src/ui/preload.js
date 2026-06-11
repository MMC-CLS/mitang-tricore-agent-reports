/**
 * 蜜糖 TriCore Agent - Electron Preload脚本
 *
 * 安全桥接：渲染进程 ↔ 主进程
 * 通过contextBridge暴露安全的API，不直接暴露Node.js能力
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ═══════════════════════════════════════
// 暴露给渲染进程的API
// ═══════════════════════════════════════

contextBridge.exposeInMainWorld('triCoreAPI', {

  // ── 状态查询 ──
  getStatus: () => ipcRenderer.invoke('agent:getStatus'),

  // ── 消息 ──
  sendMessage: (from, content) => ipcRenderer.invoke('agent:sendMessage', { from, content }),

  // ── 任务 ──
  submitTask: (goal, context) => ipcRenderer.invoke('agent:submitTask', { goal, context }),
  getTasks: () => ipcRenderer.invoke('agent:getTasks'),

  // ── 记忆 ──
  searchMemories: (query, limit) => ipcRenderer.invoke('agent:searchMemories', { query, limit }),

  // ── 技能 ──
  searchSkills: (query, limit) => ipcRenderer.invoke('agent:searchSkills', { query, limit }),
  auditSkill: (skillId, decision, reason) => ipcRenderer.invoke('agent:auditSkill', { skillId, decision, reason }),

  // ── 浏览器 ──
  browserAction: (action, params) => ipcRenderer.invoke('agent:browserAction', { action, params }),

  // ── 语音 ──
  recognizeSpeech: (audioPath) => ipcRenderer.invoke('agent:recognizeSpeech', { audioPath }),
  synthesizeSpeech: (text, options) => ipcRenderer.invoke('agent:synthesizeSpeech', { text, options }),

  // ── 社交 ──
  configureSocial: (channel, config) => ipcRenderer.invoke('agent:configureSocial', { channel, config }),
  dispatchMessage: (target, content) => ipcRenderer.invoke('agent:dispatchMessage', { target, content }),

  // ── 插件 ──
  installPlugin: (plugin) => ipcRenderer.invoke('agent:installPlugin', plugin),
  getPlugins: () => ipcRenderer.invoke('agent:getPlugins'),

  // ── 控制 ──
  pause: () => ipcRenderer.invoke('agent:pause'),
  resume: () => ipcRenderer.invoke('agent:resume'),
  confirmDangerousAction: (taskId, stepIndex, confirmed) =>
    ipcRenderer.invoke('agent:confirmDangerousAction', { taskId, stepIndex, confirmed }),
  activate: (provider, apiKey, model) =>
    ipcRenderer.invoke('agent:activate', { provider, apiKey, model }),

  // ── 子智能体管理 (v2.6) ──
  getSubAgents: () => ipcRenderer.invoke('agent:getSubAgents'),
  createSubAgent: (options) => ipcRenderer.invoke('agent:createSubAgent', options),
  getSubAgentDetail: (agentId) => ipcRenderer.invoke('agent:getSubAgentDetail', { agentId }),
  startSubAgent: (agentId) => ipcRenderer.invoke('agent:startSubAgent', { agentId }),
  stopSubAgent: (agentId) => ipcRenderer.invoke('agent:stopSubAgent', { agentId }),
  deleteSubAgent: (agentId) => ipcRenderer.invoke('agent:deleteSubAgent', { agentId }),

  // ── 子智能体独立对话 (v2.7) ──
  sendMessageToSubAgent: (agentId, content, sessionId, options) =>
    ipcRenderer.invoke('agent:sendMessageToSubAgent', { agentId, content, sessionId, options }),
  listSubAgentSessions: (agentId) =>
    ipcRenderer.invoke('agent:listSubAgentSessions', { agentId }),
  createSubAgentSession: (agentId, options) =>
    ipcRenderer.invoke('agent:createSubAgentSession', { agentId, options }),
  getSubAgentSession: (agentId, sessionId) =>
    ipcRenderer.invoke('agent:getSubAgentSession', { agentId, sessionId }),
  switchSubAgentSession: (agentId, sessionId) =>
    ipcRenderer.invoke('agent:switchSubAgentSession', { agentId, sessionId }),
  closeSubAgentSession: (agentId, sessionId) =>
    ipcRenderer.invoke('agent:closeSubAgentSession', { agentId, sessionId }),
  clearSubAgentSession: (agentId, sessionId) =>
    ipcRenderer.invoke('agent:clearSubAgentSession', { agentId, sessionId }),
  getSubAgentEngineStatus: (agentId) =>
    ipcRenderer.invoke('agent:getSubAgentEngineStatus', { agentId }),
  listSubAgentTools: (agentId) =>
    ipcRenderer.invoke('agent:listSubAgentTools', { agentId }),
  executeSubAgentTool: (agentId, toolName, params) =>
    ipcRenderer.invoke('agent:executeSubAgentTool', { agentId, toolName, params }),
  setSubAgentDisplayName: (agentId, displayName) =>
    ipcRenderer.invoke('agent:setSubAgentDisplayName', { agentId, displayName }),

  // ── 团队协作 (v2.8) ──
  getTeams: () => ipcRenderer.invoke('agent:getTeams'),
  createTeam: (options) => ipcRenderer.invoke('agent:createTeam', options),
  getTeam: (teamId) => ipcRenderer.invoke('agent:getTeam', { teamId }),
  deleteTeam: (teamId) => ipcRenderer.invoke('agent:deleteTeam', { teamId }),
  activateTeam: (teamId) => ipcRenderer.invoke('agent:activateTeam', { teamId }),
  pauseTeam: (teamId) => ipcRenderer.invoke('agent:pauseTeam', { teamId }),
  dissolveTeam: (teamId) => ipcRenderer.invoke('agent:dissolveTeam', { teamId }),
  addTeamMember: (teamId, agentId, role) =>
    ipcRenderer.invoke('agent:addTeamMember', { teamId, agentId, role }),
  removeTeamMember: (teamId, agentId) =>
    ipcRenderer.invoke('agent:removeTeamMember', { teamId, agentId }),
  sendTeamMessage: (teamId, fromAgentId, fromAgentName, content, options) =>
    ipcRenderer.invoke('agent:sendTeamMessage', { teamId, fromAgentId, fromAgentName, content, options }),
  broadcastToTeam: (teamId, fromAgentId, fromAgentName, content, options) =>
    ipcRenderer.invoke('agent:broadcastToTeam', { teamId, fromAgentId, fromAgentName, content, options }),
  getTeamMessages: (teamId, limit) =>
    ipcRenderer.invoke('agent:getTeamMessages', { teamId, limit }),
  startTeamConsensus: (teamId, question, proposerId, proposerName, options) =>
    ipcRenderer.invoke('agent:startTeamConsensus', { teamId, question, proposerId, proposerName, options }),
  castTeamVote: (teamId, pollId, agentId, agentName, vote) =>
    ipcRenderer.invoke('agent:castTeamVote', { teamId, pollId, agentId, agentName, vote }),
  getPendingConsents: () => ipcRenderer.invoke('agent:getPendingConsents'),
  approveConsent: (consentId, response) =>
    ipcRenderer.invoke('agent:approveConsent', { consentId, response }),
  rejectConsent: (consentId, reason) =>
    ipcRenderer.invoke('agent:rejectConsent', { consentId, reason }),
  getConsentHistory: (limit) => ipcRenderer.invoke('agent:getConsentHistory', { limit }),

  // ── 技能安装与管理 (v2.9) ──
  installSkillFromFile: (agentId, filePath, options) =>
    ipcRenderer.invoke('agent:installSkillFromFile', { agentId, filePath, options }),
  installSkillFromContent: (agentId, content, options) =>
    ipcRenderer.invoke('agent:installSkillFromContent', { agentId, content, options }),
  installSkillFromMarket: (agentId, marketSkill, options) =>
    ipcRenderer.invoke('agent:installSkillFromMarket', { agentId, marketSkill, options }),
  uninstallAgentSkill: (agentId, skillId) =>
    ipcRenderer.invoke('agent:uninstallSkill', { agentId, skillId }),
  listAgentSkills: (agentId) =>
    ipcRenderer.invoke('agent:listAgentSkills', { agentId }),
  getAgentSkillDetail: (agentId, skillId) =>
    ipcRenderer.invoke('agent:getAgentSkillDetail', { agentId, skillId }),
  searchAgentSkills: (agentId, keyword) =>
    ipcRenderer.invoke('agent:searchAgentSkills', { agentId, keyword }),
  getAgentSkillStats: (agentId) =>
    ipcRenderer.invoke('agent:getAgentSkillStats', { agentId }),
  getAgentSkillHistory: (agentId, limit) =>
    ipcRenderer.invoke('agent:getAgentSkillHistory', { agentId, limit }),
  toggleAgentSkill: (agentId, skillId, enabled) =>
    ipcRenderer.invoke('agent:toggleAgentSkill', { agentId, skillId, enabled }),
  bindSkillToMemory: (agentId, skillId) =>
    ipcRenderer.invoke('agent:bindSkillToMemory', { agentId, skillId }),
  lockSkillAsCore: (agentId, skillId) =>
    ipcRenderer.invoke('agent:lockSkillAsCore', { agentId, skillId }),
  getBoundSkills: (agentId) =>
    ipcRenderer.invoke('agent:getBoundSkills', { agentId }),
  getAgentMemoryStats: (agentId) =>
    ipcRenderer.invoke('agent:getAgentMemoryStats', { agentId }),
  searchAgentMemory: (agentId, query) =>
    ipcRenderer.invoke('agent:searchAgentMemory', { agentId, query }),
  exportAgentSkillMemory: (agentId) =>
    ipcRenderer.invoke('agent:exportAgentSkillMemory', { agentId }),
  importAgentSkillMemory: (agentId, data) =>
    ipcRenderer.invoke('agent:importAgentSkillMemory', { agentId, data }),

  // ── 消息处理器 (v3.0) ──
  getMessageProcessorStats: () => ipcRenderer.invoke('agent:getMessageProcessorStats'),
  getActivePipelines: () => ipcRenderer.invoke('agent:getActivePipelines'),
  getMessagePipeline: (msgId) => ipcRenderer.invoke('agent:getMessagePipeline', { msgId }),
  getRecentMessageSummary: (limit) => ipcRenderer.invoke('agent:getRecentMessageSummary', { limit }),
  getMessageDAGData: (limit) => ipcRenderer.invoke('agent:getMessageDAGData', { limit }),
  getEntityGraph: () => ipcRenderer.invoke('agent:getEntityGraph'),

  // ── 记忆网络图 (v3.0) ──
  getMemoryGraphData: () => ipcRenderer.invoke('agent:getMemoryGraphData'),
  getMemoryNodeDetail: (nodeId) => ipcRenderer.invoke('agent:getMemoryNodeDetail', { nodeId }),
  searchMemoryNodes: (query, limit) => ipcRenderer.invoke('agent:searchMemoryNodes', { query, limit }),
  findMemoryPath: (fromId, toId, maxDepth) => ipcRenderer.invoke('agent:findMemoryPath', { fromId, toId, maxDepth }),
  getMemoryClusterDetail: (clusterId) => ipcRenderer.invoke('agent:getMemoryClusterDetail', { clusterId }),
  setMemoryGraphPhysics: (params) => ipcRenderer.invoke('agent:setMemoryGraphPhysics', { params }),
  setMemoryGraphLayout: (mode) => ipcRenderer.invoke('agent:setMemoryGraphLayout', { mode }),
  setMemoryGraphCluster: (mode) => ipcRenderer.invoke('agent:setMemoryGraphCluster', { mode }),
  getMemoryGraphStats: () => ipcRenderer.invoke('agent:getMemoryGraphStats'),

  // ── 系统设置 (v5.0) ──
  getConfig: (key) => ipcRenderer.invoke('agent:getConfig', { key }),
  setConfig: (key, value) => ipcRenderer.invoke('agent:setConfig', { key, value }),
  getAllConfig: () => ipcRenderer.invoke('agent:getAllConfig'),
  resetConfig: () => ipcRenderer.invoke('agent:resetConfig'),
  getConfigSchema: () => ipcRenderer.invoke('agent:getConfigSchema'),
  exportConfig: () => ipcRenderer.invoke('agent:exportConfig'),
  importConfig: (config) => ipcRenderer.invoke('agent:importConfig', { config }),

  // ── 事件监听 ──
  on: (channel, callback) => {
    // 安全白名单：只允许特定前缀的事件
    const allowedPrefixes = [
      'scheduler:',
      'consciousness:',
      'execution:',
      'evolution:',
      'social:',
      'agent:',
    ];

    const isAllowed = allowedPrefixes.some(prefix => channel.startsWith(prefix));
    if (!isAllowed) {
      console.warn(`[TriCore Preload] Blocked event subscription: ${channel}`);
      return () => {};
    }

    const listener = (_, data) => callback(data);
    ipcRenderer.on(channel, listener);
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

console.log('[蜜糖 TriCore Preload] API已注入到window.triCoreAPI');
