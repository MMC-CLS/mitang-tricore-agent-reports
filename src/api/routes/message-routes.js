/**
 * 消息路由 — POST /message, GET /events
 */
'use strict';

function registerRoutes(server) {
  server._addRoute('POST /message', async function(req, res) {
    const body = await this._readBody(req);
    const { content, from = 'api_user', channel = 'api' } = body;

    if (!content) {
      this._sendJson(res, 400, { error: 'content is required' });
      return;
    }

    const msgId = this._agent ? this._agent.sendMessage(from, content, { channel }) : null;
    this._sendJson(res, 200, { messageId: msgId, status: 'queued' });
  });

  server._addRoute('GET /events', async function(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const clientId = Date.now();
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    this._sseClients.add(res);

    req.on('close', () => {
      this._sseClients.delete(res);
    });
  });
}

module.exports = { registerRoutes };
