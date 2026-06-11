/**
 * 子智能体路由 — GET/POST /sub-agents, /sub-agents/:id, /sub-agents/:id/start, etc.
 */
'use strict';

function registerRoutes(server) {
  // ── 子智能体列表和创建 ──
  server._addRoute('GET /sub-agents', async function(req, res, url) {
    const filter = {};
    if (url.searchParams.get('type')) filter.type = url.searchParams.get('type');
    if (url.searchParams.get('status')) filter.status = url.searchParams.get('status');
    if (url.searchParams.get('safetyLevel')) filter.safetyLevel = url.searchParams.get('safetyLevel');
    const agents = this._agent?.listSubAgents(filter) || [];
    const stats = this._agent?._subAgentManager?.getStats() || {};
    this._sendJson(res, 200, { agents, stats });
  });

  server._addRoute('POST /sub-agents', async function(req, res) {
    const body = await this._readBody(req);
    const { name, type, description, safetyLevel, quota, autoStart } = body;
    if (!name) { this._sendJson(res, 400, { error: '子智能体名称不能为空' }); return; }
    const result = this._agent?.createSubAgent({ name, type, description, safetyLevel, quota, autoStart });
    this._sendJson(res, result?.success ? 201 : 400, result);
  });

  server._addRoute('GET /sub-agents/stats', async function(req, res) {
    const stats = this._agent?._subAgentManager?.getStats() || {};
    this._sendJson(res, 200, stats);
  });

  server._addRoute('POST /sub-agents/tasks', async function(req, res) {
    const body = await this._readBody(req);
    const { agentId, task, smartAssign } = body;
    if (!task) { this._sendJson(res, 400, { error: '任务内容不能为空' }); return; }
    let result;
    if (smartAssign) {
      result = this._agent?.assignSubAgentTaskSmart(task);
    } else if (agentId) {
      result = this._agent?.assignSubAgentTask(agentId, task);
    } else {
      this._sendJson(res, 400, { error: '需要指定 agentId 或启用 smartAssign' });
      return;
    }
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addRoute('GET /sub-agents/scheduler', async function(req, res) {
    const stats = this._agent?.getSchedulerStats() || {};
    this._sendJson(res, 200, stats);
  });

  server._addRoute('GET /sub-agents/guardian', async function(req, res) {
    const stats = this._agent?.getGuardianStats() || {};
    this._sendJson(res, 200, stats);
  });

  // ── 模式路由 ──
  server._addPatternRoute(/^GET \/sub-agents\/[^/]+$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const detail = this._agent?.getSubAgent(agentId);
    if (!detail) { this._sendJson(res, 404, { error: '子智能体不存在' }); return; }
    this._sendJson(res, 200, detail);
  });

  server._addPatternRoute(/^POST \/sub-agents\/[^/]+\/start$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const result = this._agent?.startSubAgent(agentId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/sub-agents\/[^/]+\/stop$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const result = this._agent?.stopSubAgent(agentId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^DELETE \/sub-agents\/[^/]+$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const result = this._agent?.destroySubAgent(agentId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/sub-agents\/[^/]+\/tasks\/complete$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const agentId = parts[2];
    const body = await this._readBody(req);
    const { taskId, result: taskResult } = body;
    if (!taskId) { this._sendJson(res, 400, { error: '需要 taskId' }); return; }
    const completeResult = this._agent?.completeSubAgentTask(agentId, taskId, taskResult);
    this._sendJson(res, completeResult?.success ? 200 : 400, completeResult);
  });

  // v2.7 子智能体独立对话
  server._addPatternRoute(/^POST \/sub-agents\/[^/]+\/message$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const body = await this._readBody(req);
    const { content, sessionId, options } = body;
    if (!content) { this._sendJson(res, 400, { error: '消息内容不能为空' }); return; }
    const result = await this._agent?.sendMessageToSubAgent(agentId, content, sessionId, options);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^GET \/sub-agents\/[^/]+\/sessions$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const sessions = this._agent?.listSubAgentSessions(agentId) || [];
    this._sendJson(res, 200, { sessions });
  });

  server._addPatternRoute(/^POST \/sub-agents\/[^/]+\/sessions$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const body = await this._readBody(req);
    const result = this._agent?.createSubAgentSession(agentId, body);
    this._sendJson(res, result?.success ? 201 : 400, result);
  });

  server._addPatternRoute(/^GET \/sub-agents\/[^/]+\/sessions\/[^/]+$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const agentId = parts[2];
    const sessionId = parts[4];
    const session = this._agent?.getSubAgentSession(agentId, sessionId);
    if (!session) { this._sendJson(res, 404, { error: '会话不存在' }); return; }
    this._sendJson(res, 200, session);
  });

  server._addPatternRoute(/^DELETE \/sub-agents\/[^/]+\/sessions\/[^/]+$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const agentId = parts[2];
    const sessionId = parts[4];
    const result = this._agent?.closeSubAgentSession(agentId, sessionId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/sub-agents\/[^/]+\/sessions\/[^/]+\/switch$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const agentId = parts[2];
    const sessionId = parts[4];
    const result = this._agent?.switchSubAgentSession(agentId, sessionId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/sub-agents\/[^/]+\/sessions\/[^/]+\/clear$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const agentId = parts[2];
    const sessionId = parts[4];
    const result = this._agent?.clearSubAgentSession(agentId, sessionId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^GET \/sub-agents\/[^/]+\/tools$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const tools = this._agent?.listSubAgentTools(agentId) || [];
    this._sendJson(res, 200, { tools });
  });

  server._addPatternRoute(/^POST \/sub-agents\/[^/]+\/tools\/execute$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const body = await this._readBody(req);
    const { tool, params } = body;
    if (!tool) { this._sendJson(res, 400, { error: '工具名称不能为空' }); return; }
    const result = await this._agent?.executeSubAgentTool(agentId, tool, params);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^GET \/sub-agents\/[^/]+\/status$/, async function(req, res, url) {
    const agentId = url.pathname.split('/')[2];
    const status = this._agent?.getSubAgentEngineStatus(agentId);
    if (!status) { this._sendJson(res, 404, { error: '子智能体引擎未启动' }); return; }
    this._sendJson(res, 200, status);
  });

  server._addRoute('GET /sub-agents/ws-stats', async function(req, res) {
    const stats = this._agent?.getSubAgentWSStats() || {};
    this._sendJson(res, 200, stats);
  });

  server._addRoute('GET /sub-agents/engines', async function(req, res) {
    const engines = this._agent?.listSubAgentEngines() || [];
    this._sendJson(res, 200, { engines });
  });
}

module.exports = { registerRoutes };
