/**
 * RAG + Tool Calling + Vision + Audit + Encryption 路由
 */
'use strict';

function registerRoutes(server) {
  // ── Tool Calling ──
  server._addRoute('GET /tools', async function(req, res) {
    const tools = this._agent?._toolCalling?.listTools() || [];
    this._sendJson(res, 200, { tools, stats: this._agent?._toolCalling?.getStats() });
  });

  server._addRoute('POST /tools/execute', async function(req, res) {
    const body = await this._readBody(req);
    const { toolCall, context } = body;
    if (!toolCall) { this._sendJson(res, 400, { error: 'toolCall is required' }); return; }
    const result = await this._agent?.executeTool(toolCall, context);
    this._sendJson(res, 200, result);
  });

  // ── RAG ──
  server._addRoute('GET /rag/documents', async function(req, res) {
    const docs = this._agent?.listRagDocuments() || [];
    this._sendJson(res, 200, { documents: docs, stats: this._agent?._rag?.getStats() });
  });

  server._addRoute('POST /rag/documents', async function(req, res) {
    const body = await this._readBody(req);
    const { content, title, source, sourceType, metadata } = body;
    if (!content) { this._sendJson(res, 400, { error: 'content is required' }); return; }
    const docId = await this._agent?.addDocument({ content, title, source, sourceType, metadata });
    this._sendJson(res, 200, { docId });
  });

  server._addRoute('POST /rag/ask', async function(req, res) {
    const body = await this._readBody(req);
    const { question, topK, mode } = body;
    if (!question) { this._sendJson(res, 400, { error: 'question is required' }); return; }
    const answer = await this._agent?.ragAsk(question, { topK, mode });
    this._sendJson(res, 200, answer);
  });

  // ── Vision / Multi-Modal ──
  server._addRoute('POST /vision/analyze', async function(req, res) {
    const body = await this._readBody(req);
    const { imagePath, prompt } = body;
    if (!imagePath) { this._sendJson(res, 400, { error: 'imagePath is required' }); return; }
    const result = await this._agent?.analyzeImage(imagePath, prompt || '请描述这张图片');
    this._sendJson(res, 200, result);
  });

  server._addRoute('POST /vision/ocr', async function(req, res) {
    const body = await this._readBody(req);
    const { imagePath, language } = body;
    if (!imagePath) { this._sendJson(res, 400, { error: 'imagePath is required' }); return; }
    const result = await this._agent?.ocr(imagePath, { language });
    this._sendJson(res, 200, result);
  });

  // ── Audit ──
  server._addRoute('GET /audit/logs', async function(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const params = url.searchParams;
    const logs = await this._agent?.queryAuditLogs({
      userId: params.get('userId') || undefined,
      level: params.get('level') || undefined,
      category: params.get('category') || undefined,
      limit: parseInt(params.get('limit')) || 100,
    });
    this._sendJson(res, 200, { logs, stats: this._agent?._audit?.getStats() });
  });

  server._addRoute('GET /audit/report', async function(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const days = parseInt(url.searchParams.get('days')) || 7;
    const report = await this._agent?.generateComplianceReport({
      startDate: Date.now() - days * 86400000,
      endDate: Date.now(),
    });
    this._sendJson(res, 200, report);
  });

  // ── Encryption ──
  server._addRoute('POST /encrypt', async function(req, res) {
    const body = await this._readBody(req);
    const { plaintext } = body;
    if (!plaintext) { this._sendJson(res, 400, { error: 'plaintext is required' }); return; }
    try {
      const result = this._agent?.encrypt(plaintext);
      this._sendJson(res, 200, result);
    } catch (e) {
      const isProduction = process.env.NODE_ENV === 'production';
      this._sendJson(res, 500, { error: isProduction ? 'Encryption failed' : e.message });
    }
  });

  server._addRoute('POST /decrypt', async function(req, res) {
    const body = await this._readBody(req);
    const { ciphertext, iv, authTag, version } = body;
    if (!ciphertext || !iv || !authTag) {
      this._sendJson(res, 400, { error: 'ciphertext, iv, and authTag are required' });
      return;
    }
    try {
      const result = this._agent?.decrypt({ ciphertext, iv, authTag, version });
      this._sendJson(res, 200, { plaintext: result });
    } catch (e) {
      const isProduction = process.env.NODE_ENV === 'production';
      this._sendJson(res, 500, { error: isProduction ? 'Decryption failed' : e.message });
    }
  });
}

module.exports = { registerRoutes };
