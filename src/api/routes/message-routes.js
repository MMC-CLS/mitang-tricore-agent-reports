/**
 * 消息路由 — POST /message, GET /events
 */
'use strict';

// v1.0安全修复: 消息内容长度限制（防止超长消息导致内存/LLM资源耗尽）
const MAX_MESSAGE_LENGTH = 50000;   // 50K字符
const MAX_FROM_LENGTH = 128;       // from字段最大长度

function registerRoutes(server) {
  server._addRoute('POST /message', async function(req, res) {
    const body = await this._readBody(req);
    const { content, from = 'api_user', channel = 'api' } = body;

    // v1.0安全修复: 参数验证增强
    if (!content || typeof content !== 'string') {
      this._sendJson(res, 400, { error: 'content is required and must be a string' });
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      this._sendJson(res, 400, {
        error: `content too long (max ${MAX_MESSAGE_LENGTH} characters)`,
        code: 'CONTENT_TOO_LONG',
      });
      return;
    }
    if (content.trim().length === 0) {
      this._sendJson(res, 400, { error: 'content must not be empty' });
      return;
    }
    // 验证 from 字段
    if (typeof from !== 'string' || from.length > MAX_FROM_LENGTH) {
      this._sendJson(res, 400, { error: `from must be a string (max ${MAX_FROM_LENGTH} characters)` });
      return;
    }
    // 验证 channel 字段
    const allowedChannels = ['api', 'websocket', 'wechat', 'feishu', 'discord'];
    if (channel && !allowedChannels.includes(channel)) {
      this._sendJson(res, 400, { error: `invalid channel: ${channel}` });
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
