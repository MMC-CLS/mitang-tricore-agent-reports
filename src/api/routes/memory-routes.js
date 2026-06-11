/**
 * 记忆路由 — GET /memories, PATCH/DELETE /memories/:id, GET /conversations
 */
'use strict';

function registerRoutes(server) {
  server._addRoute('GET /memories', async function(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = url.searchParams.get('q');
    if (query && this._agent) {
      const results = this._agent.searchMemories(query, 20);
      this._sendJson(res, 200, { memories: results });
    } else {
      this._sendJson(res, 200, { memories: [] });
    }
  });

  server._addRoute('GET /conversations', async function(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    try {
      const memory = this._agent?._memory;
      if (!memory || !memory._db) {
        this._sendJson(res, 200, { conversations: [], total: 0, limit, offset });
        return;
      }

      const conversations = memory._db.prepare(`
        SELECT id, content, created_at, source, mem_type
        FROM memories WHERE source = 'conversation'
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);

      const totalRow = memory._db.prepare(`
        SELECT COUNT(*) as total FROM memories WHERE source = 'conversation'
      `).get();

      const result = conversations.map(c => ({
        id: c.id,
        content: c.content,
        timestamp: c.created_at,
        from: c.source || 'conversation',
        type: c.mem_type || 'conversation',
      }));

      this._sendJson(res, 200, {
        conversations: result,
        total: totalRow?.total || 0,
        limit,
        offset,
      });
    } catch (err) {
      this._sendJson(res, 500, { error: `Failed to query conversations: ${err.message}` });
    }
  });

  // Pattern routes for PATCH/DELETE /memories/:id and GET /memories/:id
  server._addPatternRoute(/^PATCH \/memories\/\d+$/, async function(req, res, url) {
    const id = parseInt(url.pathname.split('/').pop());
    const body = await this._readBody(req);
    try {
      if (this._agent && this._agent._memory) {
        const parsed = JSON.parse(body);
        const updated = this._agent._memory.update(id, parsed);
        if (updated) {
          this._sendJson(res, 200, { id, updated: true, memory: updated });
        } else {
          this._sendJson(res, 404, { id, error: 'Memory not found' });
        }
      } else {
        this._sendJson(res, 503, { error: 'Memory engine not available' });
      }
    } catch (err) {
      this._sendJson(res, 400, { id, error: `Invalid request: ${err.message}` });
    }
  });

  server._addPatternRoute(/^DELETE \/memories\/\d+$/, async function(req, res, url) {
    const id = parseInt(url.pathname.split('/').pop());
    try {
      if (this._agent && this._agent._memory) {
        const deleted = this._agent._memory.delete(id);
        if (deleted) {
          this._sendJson(res, 200, { id, deleted: true });
        } else {
          this._sendJson(res, 404, { id, error: 'Memory not found' });
        }
      } else {
        this._sendJson(res, 503, { error: 'Memory engine not available' });
      }
    } catch (err) {
      this._sendJson(res, 500, { id, error: `Delete failed: ${err.message}` });
    }
  });

  server._addPatternRoute(/^GET \/memories\/\d+$/, async function(req, res, url) {
    const id = parseInt(url.pathname.split('/').pop());
    this._sendJson(res, 200, { id, note: 'Memory detail endpoint' });
  });
}

module.exports = { registerRoutes };
