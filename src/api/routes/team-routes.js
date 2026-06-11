/**
 * 团队协作路由 — GET/POST /teams, /teams/:id, /teams/:id/activate, etc.
 * 以及 /consents 相关端点
 */
'use strict';

function registerRoutes(server) {
  // ── 团队列表和创建 ──
  server._addRoute('GET /teams', async function(req, res, url) {
    const type = url.searchParams.get('type');
    const status = url.searchParams.get('status');
    const teams = this._agent?.listTeams({ type, status }) || [];
    this._sendJson(res, 200, { teams });
  });

  server._addRoute('POST /teams', async function(req, res) {
    const body = await this._readBody(req);
    const result = this._agent?.createTeam(body);
    this._sendJson(res, result?.success ? 201 : 400, result);
  });

  server._addRoute('GET /teams/stats', async function(req, res) {
    const stats = this._agent?.getTeamStats() || {};
    this._sendJson(res, 200, stats);
  });

  // ── 团队模式路由 ──
  server._addPatternRoute(/^GET \/teams\/[^/]+$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const team = this._agent?.getTeam(teamId);
    if (!team) { this._sendJson(res, 404, { error: '团队不存在' }); return; }
    this._sendJson(res, 200, team);
  });

  server._addPatternRoute(/^DELETE \/teams\/[^/]+$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const result = this._agent?.removeTeam(teamId);
    this._sendJson(res, result?.success ? 200 : 404, result);
  });

  server._addPatternRoute(/^POST \/teams\/[^/]+\/activate$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const result = this._agent?.activateTeam(teamId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/teams\/[^/]+\/pause$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const result = this._agent?.pauseTeam(teamId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/teams\/[^/]+\/dissolve$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const result = this._agent?.dissolveTeam(teamId);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/teams\/[^/]+\/members$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const body = await this._readBody(req);
    const result = this._agent?.addTeamMember(teamId, body.agentId, body.role);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^DELETE \/teams\/[^/]+\/members\/[^/]+$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const teamId = parts[2];
    const agentId = parts[4];
    const result = this._agent?.removeTeamMember(teamId, agentId);
    this._sendJson(res, result?.success ? 200 : 404, result);
  });

  server._addPatternRoute(/^PATCH \/teams\/[^/]+\/members\/[^/]+\/role$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const teamId = parts[2];
    const agentId = parts[4];
    const body = await this._readBody(req);
    const result = this._agent?.updateTeamMemberRole(teamId, agentId, body.role);
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/teams\/[^/]+\/message$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const body = await this._readBody(req);
    const result = await this._agent?.sendTeamMessage(
      teamId, body.fromAgentId, body.fromAgentName, body.content, body
    );
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/teams\/[^/]+\/broadcast$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const body = await this._readBody(req);
    const result = await this._agent?.broadcastToTeam(
      teamId, body.fromAgentId, body.fromAgentName, body.content, body
    );
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^GET \/teams\/[^/]+\/messages$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const messages = this._agent?.getTeamMessages(teamId, limit) || [];
    this._sendJson(res, 200, { messages });
  });

  server._addPatternRoute(/^POST \/teams\/[^/]+\/consensus$/, async function(req, res, url) {
    const teamId = url.pathname.split('/')[2];
    const body = await this._readBody(req);
    const result = await this._agent?.startTeamConsensus(
      teamId, body.question, body.proposerId, body.proposerName, body
    );
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  server._addPatternRoute(/^POST \/teams\/[^/]+\/consensus\/[^/]+\/vote$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const teamId = parts[2];
    const pollId = parts[4];
    const body = await this._readBody(req);
    const result = this._agent?.castTeamVote(
      teamId, pollId, body.agentId, body.agentName, body.vote
    );
    this._sendJson(res, result?.success ? 200 : 400, result);
  });

  // ── 确认端点 ──
  server._addRoute('GET /consents', async function(req, res) {
    const consents = this._agent?.getPendingConsents() || [];
    this._sendJson(res, 200, { consents });
  });

  server._addRoute('POST /consents/approve', async function(req, res) {
    const body = await this._readBody(req);
    const result = this._agent?.approveConsent(body.consentId, body.response || '');
    this._sendJson(res, result?.success ? 200 : 404, result);
  });

  server._addRoute('POST /consents/reject', async function(req, res) {
    const body = await this._readBody(req);
    const result = this._agent?.rejectConsent(body.consentId, body.reason || '用户拒绝');
    this._sendJson(res, result?.success ? 200 : 404, result);
  });

  server._addRoute('GET /consents/history', async function(req, res, url) {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const history = this._agent?.getConsentHistory(limit) || [];
    this._sendJson(res, 200, { history });
  });
}

module.exports = { registerRoutes };
