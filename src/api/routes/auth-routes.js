/**
 * 认证路由 — POST /auth/login, POST /auth/logout, GET /auth/me
 */
'use strict';

function registerRoutes(server) {
  server._addRoute('POST /auth/login', async function(req, res) {
    const body = await this._readBody(req);
    const { username, password } = body;
    if (!username || !password) {
      this._sendJson(res, 400, { error: 'username and password are required' });
      return;
    }
    const result = this._agent?._rbac?.authenticate(username, password, {
      ip: req.socket.remoteAddress,
    });
    if (!result?.success) {
      this._sendJson(res, 401, { error: result?.error || 'Invalid credentials' });
      return;
    }
    this._sendJson(res, 200, result);
  });

  server._addRoute('POST /auth/logout', async function(req, res) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token) this._agent?._rbac?.logout(token);
    this._sendJson(res, 200, { loggedOut: true });
  });

  server._addRoute('GET /auth/me', async function(req, res) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const session = this._agent?._rbac?.validateToken(token);
    if (!session) { this._sendJson(res, 401, { error: 'Invalid or expired token' }); return; }
    this._sendJson(res, 200, session);
  });
}

module.exports = { registerRoutes };
