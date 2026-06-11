/**
 * 蜜糖 TriCore Agent - Electron主进程
 *
 * 职责：
 *   1. 创建BrowserWindow（Brain UI）
 *   2. 管理蜜糖 TriCore Agent生命周期
 *   3. IPC桥接：渲染进程 ↔ Agent核心
 *   4. 系统托盘
 *   5. 自启动
 *
 * 架构：
 *   主进程(Node.js) ← IPC → 渲染进程(Brain UI/HTML)
 *        ↓
 *   蜜糖 TriCore Agent (三核 + 扩展 + 子智能体)
 */

'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

// ── 配置常量 ──
const WINDOW_CONFIG = {
  width: 1400,
  height: 900,
  minWidth: 1000,
  minHeight: 700,
  title: '蜜糖 TriCore Agent — Brain UI',
  backgroundColor: '#0a0a1a',
  icon: null, // 从assets加载
};

const TRAY_ICON_SIZE = 16;

class TriCoreMainProcess {
  constructor() {
    this._mainWindow = null;
    this._tray = null;
    this._agent = null;
    this._isQuitting = false;
  }

  // ═══════════════════════════════════════
  // 应用生命周期
  // ═══════════════════════════════════════

  async init() {
    // 等待Electron就绪
    await app.whenReady();

    // 单实例锁
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return;
    }

    app.on('second-instance', () => {
      if (this._mainWindow) {
        if (this._mainWindow.isMinimized()) this._mainWindow.restore();
        this._mainWindow.focus();
      }
    });

    // 创建窗口
    this._createWindow();

    // 创建托盘
    this._createTray();

    // 初始化Agent
    await this._initAgent();

    // 注册IPC处理器
    this._registerIpcHandlers();

    // macOS激活
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        this._createWindow();
      }
    });

    app.on('before-quit', () => {
      this._isQuitting = true;
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        this._shutdown();
      }
    });
  }

  // ═══════════════════════════════════════
  // 窗口管理
  // ═══════════════════════════════════════

  _createWindow() {
    const preloadPath = path.join(__dirname, 'preload.js');

    this._mainWindow = new BrowserWindow({
      ...WINDOW_CONFIG,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // 需要访问better-sqlite3
      },
      show: false, // 先隐藏，加载完再显示
    });

    // 加载Brain UI
    const uiPath = path.join(__dirname, 'brain-ui', 'index.html');
    this._mainWindow.loadFile(uiPath);

    // 加载完成后显示窗口
    this._mainWindow.once('ready-to-show', () => {
      this._mainWindow.show();
    });

    // 关闭时最小化到托盘（非退出）
    this._mainWindow.on('close', (event) => {
      if (!this._isQuitting) {
        event.preventDefault();
        this._mainWindow.hide();
      }
    });

    // 开发工具（开发模式）
    if (process.env.TRICORE_DEV === '1') {
      this._mainWindow.webContents.openDevTools();
    }
  }

  // ═══════════════════════════════════════
  // 系统托盘
  // ═══════════════════════════════════════

  _createTray() {
    // 使用简单图标（实际项目应从assets加载）
    const icon = nativeImage.createEmpty();
    this._tray = new Tray(icon);
    this._tray.setToolTip('蜜糖 TriCore Agent');

    const contextMenu = Menu.buildFromTemplate([
      { label: '打开 Brain UI', click: () => this._mainWindow?.show() },
      { type: 'separator' },
      { label: '状态: 运行中', id: 'status', enabled: false },
      { type: 'separator' },
      { label: '暂停', click: () => this._ipcBroadcast('agent:paused') },
      { label: '恢复', click: () => this._ipcBroadcast('agent:resumed') },
      { type: 'separator' },
      { label: '退出', click: () => this._shutdown() },
    ]);

    this._tray.setContextMenu(contextMenu);

    // 双击托盘图标打开窗口
    this._tray.on('double-click', () => {
      this._mainWindow?.show();
    });
  }

  // ═══════════════════════════════════════
  // Agent初始化
  // ═══════════════════════════════════════

  async _initAgent() {
    try {
      const { TriCoreAgent } = require('../index');
      const dataDir = path.join(app.getPath('userData'), 'data');

      this._agent = new TriCoreAgent({
        dataDir,
        awakeningTicks: 5,
        headless: true,
        port: 0, // 随机端口，避免冲突
        startApi: false, // 通过IPC而非HTTP
      });

      // 从环境变量或配置文件读取Provider
      const provider = process.env.LLM_PROVIDER || 'deepseek';
      const apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';

      if (apiKey) {
        await this._agent.start({ provider, apiKey, startApi: false });
      } else {
        // 无API Key时仅初始化记忆
        this._agent._memory.init();
        this._agent._running = true;
      }

      // 将Agent事件转发到渲染进程
      this._bindAgentEvents();

      console.log('[蜜糖 TriCore Main] Agent初始化成功');
    } catch (error) {
      console.error('[蜜糖 TriCore Main] Agent初始化失败:', error.message);
    }
  }

  // ═══════════════════════════════════════
  // Agent事件 → 渲染进程
  // ═══════════════════════════════════════

  _bindAgentEvents() {
    if (!this._agent) return;

    // 调度器事件
    const scheduler = this._agent._scheduler;
    scheduler.on('mode_change', (data) => {
      this._ipcBroadcast('scheduler:mode_change', data);
    });
    scheduler.on('tick', (data) => {
      this._ipcBroadcast('scheduler:tick', data);
    });

    // 意识核事件
    const consciousness = this._agent._consciousness;
    consciousness.on('task_needed', (data) => {
      this._ipcBroadcast('consciousness:task_needed', data);
    });

    // 执行核事件
    const execution = this._agent._execution;
    execution.on('task_completed', (data) => {
      this._ipcBroadcast('execution:task_completed', data);
    });
    execution.on('dangerous_action', (data) => {
      this._ipcBroadcast('execution:dangerous_action', data);
    });

    // 进化核事件
    const evolution = this._agent._evolution;
    evolution.on('skill_extracted', (data) => {
      this._ipcBroadcast('evolution:skill_extracted', data);
    });
    evolution.on('skill_audited', (data) => {
      this._ipcBroadcast('evolution:skill_audited', data);
    });
    evolution.on('consolidation_complete', (data) => {
      this._ipcBroadcast('evolution:consolidation_complete', data);
    });

    // 社交事件
    const social = this._agent._social;
    social.on('message_received', (data) => {
      this._ipcBroadcast('social:message_received', data);
    });

    // v3.0: 消息处理器事件
    const msgProcessor = this._agent._messageProcessor;
    if (msgProcessor) {
      msgProcessor.on('message:received', (data) => {
        this._ipcBroadcast('agent:message_received', data);
      });
      msgProcessor.on('message:analyzed', (data) => {
        this._ipcBroadcast('agent:message_analyzed', data);
      });
      msgProcessor.on('message:routed', (data) => {
        this._ipcBroadcast('agent:message_routed', data);
      });
      msgProcessor.on('message:completed', (data) => {
        this._ipcBroadcast('agent:message_completed', data);
      });
      msgProcessor.on('message:interrupted', (data) => {
        this._ipcBroadcast('agent:message_interrupted', data);
      });
    }

    // v3.0: 记忆网络图事件
    const memGraph = this._agent._memoryNetworkGraph;
    if (memGraph) {
      memGraph.on('graph:built', (data) => {
        this._ipcBroadcast('agent:memory_graph_built', data);
      });
      memGraph.on('pulsar:beat', (data) => {
        this._ipcBroadcast('agent:memory_pulsar_beat', data);
      });
      memGraph.on('selection:changed', (data) => {
        this._ipcBroadcast('agent:memory_selection_changed', data);
      });
      memGraph.on('physics:changed', (data) => {
        this._ipcBroadcast('agent:memory_physics_changed', data);
      });
    }
  }

  // ═══════════════════════════════════════
  // IPC处理器（渲染进程 → 主进程）
  // ═══════════════════════════════════════

  _registerIpcHandlers() {
    // ── 状态查询 ──
    ipcMain.handle('agent:getStatus', async () => {
      return this._agent ? this._agent.getStatus() : { running: false };
    });

    // ── 发送消息 ──
    ipcMain.handle('agent:sendMessage', async (_, { from, content }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      const msgId = this._agent.sendMessage(from || 'ui_user', content);
      return { messageId: msgId };
    });

    // ── 提交任务 ──
    ipcMain.handle('agent:submitTask', async (_, { goal, context }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      const taskId = await this._agent.submitTask(goal, context || {});
      return { taskId };
    });

    // ── 搜索记忆 ──
    ipcMain.handle('agent:searchMemories', async (_, { query, limit }) => {
      if (!this._agent) return [];
      return this._agent.searchMemories(query, limit || 10);
    });

    // ── 搜索技能 ──
    ipcMain.handle('agent:searchSkills', async (_, { query, limit }) => {
      if (!this._agent) return [];
      return this._agent.searchSkills(query, limit || 5);
    });

    // ── 审计技能 ──
    ipcMain.handle('agent:auditSkill', async (_, { skillId, decision, reason }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      this._agent.auditSkill(skillId, decision, reason || '');
      return { audited: true };
    });

    // ── 浏览器操作 ──
    ipcMain.handle('agent:browserAction', async (_, { action, params }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      return this._agent.browserAction(action, params || {});
    });

    // ── 语音识别 ──
    ipcMain.handle('agent:recognizeSpeech', async (_, { audioPath }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      return this._agent.recognizeSpeech(audioPath);
    });

    // ── 语音合成 ──
    ipcMain.handle('agent:synthesizeSpeech', async (_, { text, options }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      return this._agent.synthesizeSpeech(text, options || {});
    });

    // ── 社交配置 ──
    ipcMain.handle('agent:configureSocial', async (_, { channel, config }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      this._agent.configureSocial(channel, config);
      return { configured: true };
    });

    // ── 社交分发 ──
    ipcMain.handle('agent:dispatchMessage', async (_, { target, content }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      return this._agent.dispatchMessage(target, content);
    });

    // ── 安装插件 ──
    ipcMain.handle('agent:installPlugin', async (_, plugin) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      this._agent.installPlugin(plugin);
      return { installed: true };
    });

    // ── 危险操作确认 ──
    ipcMain.handle('agent:confirmDangerousAction', async (_, { taskId, stepIndex, confirmed }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      this._agent._execution.confirmDangerousAction(taskId, !!confirmed);
      return { confirmed: !!confirmed };
    });

    // ── 激活Provider ──
    ipcMain.handle('agent:activate', async (_, { provider, apiKey, model }) => {
      if (!this._agent) return { error: 'Agent not initialized' };
      this._agent._router.registerProvider(provider, { apiKey, model });
      return { activated: true };
    });

    // ── 控制命令 ──
    ipcMain.handle('agent:pause', async () => {
      if (this._agent?._scheduler) this._agent._scheduler.pause();
      return { paused: true };
    });

    ipcMain.handle('agent:resume', async () => {
      if (this._agent?._scheduler) this._agent._scheduler.resume();
      return { resumed: true };
    });

    // ── 获取任务列表 ──
    ipcMain.handle('agent:getTasks', async () => {
      if (!this._agent) return [];
      return this._agent._execution.getTasks();
    });

    // ── 获取插件列表 ──
    ipcMain.handle('agent:getPlugins', async () => {
      if (!this._agent) return [];
      return this._agent._execution.listPlugins();
    });

    // ── 子智能体管理 (v2.6) ──
    ipcMain.handle('agent:getSubAgents', async () => {
      if (!this._agent) return { agents: [], stats: {} };
      const agents = this._agent.listSubAgents();
      const stats = this._agent._subAgentManager?.getStats() || {};
      return { agents, stats };
    });

    ipcMain.handle('agent:createSubAgent', async (_, options) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.createSubAgent(options);
    });

    ipcMain.handle('agent:getSubAgentDetail', async (_, { agentId }) => {
      if (!this._agent) return null;
      return this._agent.getSubAgent(agentId);
    });

    ipcMain.handle('agent:startSubAgent', async (_, { agentId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.startSubAgent(agentId);
    });

    ipcMain.handle('agent:stopSubAgent', async (_, { agentId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.stopSubAgent(agentId);
    });

    ipcMain.handle('agent:deleteSubAgent', async (_, { agentId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.destroySubAgent(agentId);
    });

    // ── 子智能体独立对话 (v2.7) ──
    ipcMain.handle('agent:sendMessageToSubAgent', async (_, { agentId, content, sessionId, options }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.sendMessageToSubAgent(agentId, content, sessionId, options);
    });

    ipcMain.handle('agent:listSubAgentSessions', async (_, { agentId }) => {
      if (!this._agent) return [];
      return this._agent.listSubAgentSessions(agentId);
    });

    ipcMain.handle('agent:createSubAgentSession', async (_, { agentId, options }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.createSubAgentSession(agentId, options);
    });

    ipcMain.handle('agent:getSubAgentSession', async (_, { agentId, sessionId }) => {
      if (!this._agent) return null;
      return this._agent.getSubAgentSession(agentId, sessionId);
    });

    ipcMain.handle('agent:switchSubAgentSession', async (_, { agentId, sessionId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.switchSubAgentSession(agentId, sessionId);
    });

    ipcMain.handle('agent:closeSubAgentSession', async (_, { agentId, sessionId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.closeSubAgentSession(agentId, sessionId);
    });

    ipcMain.handle('agent:clearSubAgentSession', async (_, { agentId, sessionId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.clearSubAgentSession(agentId, sessionId);
    });

    ipcMain.handle('agent:getSubAgentEngineStatus', async (_, { agentId }) => {
      if (!this._agent) return null;
      return this._agent.getSubAgentEngineStatus(agentId);
    });

    ipcMain.handle('agent:listSubAgentTools', async (_, { agentId }) => {
      if (!this._agent) return [];
      return this._agent.listSubAgentTools(agentId);
    });

    ipcMain.handle('agent:executeSubAgentTool', async (_, { agentId, toolName, params }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.executeSubAgentTool(agentId, toolName, params);
    });

    // ── v2.8: 团队协作 ──
    ipcMain.handle('agent:getTeams', async () => {
      if (!this._agent) return { teams: [], stats: {} };
      const teams = this._agent.listTeams();
      const stats = this._agent.getTeamStats();
      return { teams, stats };
    });

    ipcMain.handle('agent:createTeam', async (_, options) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.createTeam(options);
    });

    ipcMain.handle('agent:getTeam', async (_, { teamId }) => {
      if (!this._agent) return null;
      return this._agent.getTeam(teamId);
    });

    ipcMain.handle('agent:deleteTeam', async (_, { teamId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.removeTeam(teamId);
    });

    ipcMain.handle('agent:activateTeam', async (_, { teamId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.activateTeam(teamId);
    });

    ipcMain.handle('agent:pauseTeam', async (_, { teamId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.pauseTeam(teamId);
    });

    ipcMain.handle('agent:dissolveTeam', async (_, { teamId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.dissolveTeam(teamId);
    });

    ipcMain.handle('agent:addTeamMember', async (_, { teamId, agentId, role }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.addTeamMember(teamId, agentId, role);
    });

    ipcMain.handle('agent:removeTeamMember', async (_, { teamId, agentId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.removeTeamMember(teamId, agentId);
    });

    ipcMain.handle('agent:sendTeamMessage', async (_, { teamId, fromAgentId, fromAgentName, content, options }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.sendTeamMessage(teamId, fromAgentId, fromAgentName, content, options);
    });

    ipcMain.handle('agent:broadcastToTeam', async (_, { teamId, fromAgentId, fromAgentName, content, options }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.broadcastToTeam(teamId, fromAgentId, fromAgentName, content, options);
    });

    ipcMain.handle('agent:getTeamMessages', async (_, { teamId, limit }) => {
      if (!this._agent) return [];
      return this._agent.getTeamMessages(teamId, limit);
    });

    ipcMain.handle('agent:startTeamConsensus', async (_, { teamId, question, proposerId, proposerName, options }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.startTeamConsensus(teamId, question, proposerId, proposerName, options);
    });

    ipcMain.handle('agent:castTeamVote', async (_, { teamId, pollId, agentId, agentName, vote }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.castTeamVote(teamId, pollId, agentId, agentName, vote);
    });

    ipcMain.handle('agent:getPendingConsents', async () => {
      if (!this._agent) return [];
      return this._agent.getPendingConsents();
    });

    ipcMain.handle('agent:approveConsent', async (_, { consentId, response }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.approveConsent(consentId, response);
    });

    ipcMain.handle('agent:rejectConsent', async (_, { consentId, reason }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.rejectConsent(consentId, reason);
    });

    ipcMain.handle('agent:getConsentHistory', async (_, { limit }) => {
      if (!this._agent) return [];
      return this._agent.getConsentHistory(limit);
    });

    ipcMain.handle('agent:setSubAgentDisplayName', async (_, { agentId, displayName }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.setSubAgentDisplayName(agentId, displayName);
    });

    // ── v2.9: 技能安装与管理 ──
    ipcMain.handle('agent:installSkillFromFile', async (_, { agentId, filePath, options }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.installAgentSkillFromFile(agentId, filePath, options);
    });

    ipcMain.handle('agent:installSkillFromContent', async (_, { agentId, content, options }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.installAgentSkillFromContent(agentId, content, options);
    });

    ipcMain.handle('agent:installSkillFromMarket', async (_, { agentId, marketSkill, options }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.installAgentSkillFromMarket(agentId, marketSkill, options);
    });

    ipcMain.handle('agent:uninstallSkill', async (_, { agentId, skillId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.uninstallAgentSkill(agentId, skillId);
    });

    ipcMain.handle('agent:listAgentSkills', async (_, { agentId }) => {
      if (!this._agent) return [];
      return this._agent.listAgentSkills(agentId);
    });

    ipcMain.handle('agent:getAgentSkillDetail', async (_, { agentId, skillId }) => {
      if (!this._agent) return null;
      return this._agent.getAgentSkillDetail(agentId, skillId);
    });

    ipcMain.handle('agent:searchAgentSkills', async (_, { agentId, keyword }) => {
      if (!this._agent) return [];
      return this._agent.searchAgentSkills(agentId, keyword);
    });

    ipcMain.handle('agent:getAgentSkillStats', async (_, { agentId }) => {
      if (!this._agent) return {};
      return this._agent.getAgentSkillStats(agentId);
    });

    ipcMain.handle('agent:getAgentSkillHistory', async (_, { agentId, limit }) => {
      if (!this._agent) return [];
      return this._agent.getAgentSkillHistory(agentId, limit);
    });

    ipcMain.handle('agent:toggleAgentSkill', async (_, { agentId, skillId, enabled }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.toggleAgentSkill(agentId, skillId, enabled);
    });

    ipcMain.handle('agent:bindSkillToMemory', async (_, { agentId, skillId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.bindSkillToMemory(agentId, skillId);
    });

    ipcMain.handle('agent:lockSkillAsCore', async (_, { agentId, skillId }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.lockSkillAsCore(agentId, skillId);
    });

    ipcMain.handle('agent:getBoundSkills', async (_, { agentId }) => {
      if (!this._agent) return [];
      return this._agent.getBoundSkills(agentId);
    });

    ipcMain.handle('agent:getAgentMemoryStats', async (_, { agentId }) => {
      if (!this._agent) return null;
      return this._agent.getAgentMemoryStats(agentId);
    });

    ipcMain.handle('agent:searchAgentMemory', async (_, { agentId, query }) => {
      if (!this._agent) return [];
      return this._agent.searchAgentMemory(agentId, query);
    });

    ipcMain.handle('agent:exportAgentSkillMemory', async (_, { agentId }) => {
      if (!this._agent) return null;
      return this._agent.exportAgentSkillMemory(agentId);
    });

    ipcMain.handle('agent:importAgentSkillMemory', async (_, { agentId, data }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      return this._agent.importAgentSkillMemory(agentId, data);
    });

    // ── v3.0: 消息处理器 ──
    ipcMain.handle('agent:getMessageProcessorStats', async () => {
      if (!this._agent?._messageProcessor) return {};
      return this._agent._messageProcessor.getStats();
    });

    ipcMain.handle('agent:getActivePipelines', async () => {
      if (!this._agent?._messageProcessor) return [];
      return this._agent._messageProcessor.getActivePipelines();
    });

    ipcMain.handle('agent:getMessagePipeline', async (_, { msgId }) => {
      if (!this._agent?._messageProcessor) return null;
      return this._agent._messageProcessor.getPipeline(msgId);
    });

    ipcMain.handle('agent:getRecentMessageSummary', async (_, { limit }) => {
      if (!this._agent?._messageProcessor) return [];
      return this._agent._messageProcessor.getRecentSummary(limit || 20);
    });

    ipcMain.handle('agent:getMessageDAGData', async (_, { limit }) => {
      if (!this._agent?._messageProcessor) return { nodes: [], edges: [] };
      return this._agent._messageProcessor.getDAGData(limit || 50);
    });

    ipcMain.handle('agent:getEntityGraph', async () => {
      if (!this._agent?._messageProcessor) return { nodes: [], edges: [] };
      return this._agent._messageProcessor.getEntityGraph();
    });

    // ── v3.0: 记忆网络图 ──
    ipcMain.handle('agent:getMemoryGraphData', async () => {
      if (!this._agent?._memoryNetworkGraph) return { nodes: [], edges: [], clusters: [] };
      // 从记忆引擎获取最新数据并构建图
      const memoryData = this._agent._memory?.getStats() || {};
      this._agent._memoryNetworkGraph.buildFromMemory(memoryData);
      return this._agent._memoryNetworkGraph.getGraphData();
    });

    ipcMain.handle('agent:getMemoryNodeDetail', async (_, { nodeId }) => {
      if (!this._agent?._memoryNetworkGraph) return null;
      return this._agent._memoryNetworkGraph.getNodeDetail(nodeId);
    });

    ipcMain.handle('agent:searchMemoryNodes', async (_, { query, limit }) => {
      if (!this._agent?._memoryNetworkGraph) return [];
      return this._agent._memoryNetworkGraph.searchNodes(query, limit);
    });

    ipcMain.handle('agent:findMemoryPath', async (_, { fromId, toId, maxDepth }) => {
      if (!this._agent?._memoryNetworkGraph) return null;
      return this._agent._memoryNetworkGraph.findPath(fromId, toId, maxDepth);
    });

    ipcMain.handle('agent:getMemoryClusterDetail', async (_, { clusterId }) => {
      if (!this._agent?._memoryNetworkGraph) return null;
      return this._agent._memoryNetworkGraph.getClusterDetail(clusterId);
    });

    ipcMain.handle('agent:setMemoryGraphPhysics', async (_, { params }) => {
      if (!this._agent?._memoryNetworkGraph) return { success: false };
      this._agent._memoryNetworkGraph.setPhysics(params);
      return { success: true };
    });

    ipcMain.handle('agent:setMemoryGraphLayout', async (_, { mode }) => {
      if (!this._agent?._memoryNetworkGraph) return { success: false };
      this._agent._memoryNetworkGraph.setLayoutMode(mode);
      return { success: true };
    });

    ipcMain.handle('agent:setMemoryGraphCluster', async (_, { mode }) => {
      if (!this._agent?._memoryNetworkGraph) return { success: false };
      this._agent._memoryNetworkGraph.setClusterMode(mode);
      return { success: true };
    });

    ipcMain.handle('agent:getMemoryGraphStats', async () => {
      if (!this._agent?._memoryNetworkGraph) return {};
      return this._agent._memoryNetworkGraph.getStats();
    });

    // ── v5.0: 系统设置 ──
    ipcMain.handle('agent:getConfig', async (_, { key }) => {
      if (!this._agent) return null;
      return this._agent.getConfig(key);
    });

    ipcMain.handle('agent:setConfig', async (_, { key, value }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      try {
        this._agent.setConfig(key, value);
        // 配置变更广播给所有渲染进程
        this._ipcBroadcast('agent:config_changed', { key, value });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('agent:getAllConfig', async () => {
      if (!this._agent) return {};
      return this._agent._config ? this._agent._config.exportSafe() : {};
    });

    ipcMain.handle('agent:resetConfig', async () => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      try {
        this._agent._config.reset();
        this._ipcBroadcast('agent:config_reset', {});
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('agent:getConfigSchema', async () => {
      if (!this._agent?._configValidator) return {};
      return this._agent._configValidator.getSchema();
    });

    ipcMain.handle('agent:exportConfig', async () => {
      if (!this._agent) return {};
      return this._agent._config ? this._agent._config.exportSafe() : {};
    });

    ipcMain.handle('agent:importConfig', async (_, { config }) => {
      if (!this._agent) return { success: false, error: 'Agent not initialized' };
      try {
        // 合并导入配置
        for (const [key, value] of Object.entries(config)) {
          if (typeof value === 'object' && !Array.isArray(value)) {
            for (const [subKey, subValue] of Object.entries(value)) {
              this._agent.setConfig(`${key}.${subKey}`, subValue);
            }
          } else {
            this._agent.setConfig(key, value);
          }
        }
        this._ipcBroadcast('agent:config_imported', {});
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
  }

  // ═══════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════

  _ipcBroadcast(channel, data) {
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      this._mainWindow.webContents.send(channel, data);
    }
  }

  _shutdown() {
    if (this._agent) {
      this._agent.stop();
      this._agent = null;
    }

    if (this._tray) {
      this._tray.destroy();
      this._tray = null;
    }

    this._isQuitting = true;
    app.quit();
  }

  getStatus() {
    return {
      windowVisible: this._mainWindow?.isVisible() ?? false,
      agentRunning: this._agent?._running ?? false,
      trayActive: !!this._tray,
    };
  }
}

// ── 启动 ──
if (require.main === module) {
  const main = new TriCoreMainProcess();
  main.init().catch(console.error);
}

module.exports = { TriCoreMainProcess };
