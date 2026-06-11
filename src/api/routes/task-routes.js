/**
 * 任务路由 — GET /tasks, POST /tasks
 */
'use strict';

function registerRoutes(server) {
  server._addRoute('GET /tasks', async function(req, res) {
    const tasks = this._agent ? this._agent._execution.getTasks() : [];
    this._sendJson(res, 200, { tasks });
  });

  server._addRoute('POST /tasks', async function(req, res) {
    const body = await this._readBody(req);
    const { goal, context } = body;

    if (!goal) {
      this._sendJson(res, 400, { error: 'goal is required' });
      return;
    }

    const taskId = this._agent ? await this._agent.submitTask(goal, context) : null;
    this._sendJson(res, 200, { taskId, status: 'created' });
  });
}

module.exports = { registerRoutes };
