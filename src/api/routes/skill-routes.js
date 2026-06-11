/**
 * 技能路由 — GET /skills, POST /skills/:id/audit
 */
'use strict';

function registerRoutes(server) {
  server._addRoute('GET /skills', async function(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = url.searchParams.get('q');
    const skills = this._agent ? this._agent.searchSkills(query || '*', 20) : [];
    this._sendJson(res, 200, { skills });
  });

  server._addPatternRoute(/^POST \/skills\/\d+\/audit$/, async function(req, res, url) {
    const parts = url.pathname.split('/');
    const id = parseInt(parts[2]);
    const body = await this._readBody(req);
    const { decision, reason } = body;

    if (this._agent) {
      this._agent.auditSkill(id, decision, reason);
    }
    this._sendJson(res, 200, { id, decision, audited: true });
  });
}

module.exports = { registerRoutes };
