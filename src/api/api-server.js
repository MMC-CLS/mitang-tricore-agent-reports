/**
 * 蜜糖 TriCore Agent - API服务层 (HTTP API Server)
 *
 * 提供完整的HTTP接口。路由已模块化到 src/api/routes/ 目录。
 *
 * 核心职责：
 *   1. HTTP服务器 + WebSocket升级
 *   2. 请求路由分发到各路由模块
 *   3. SSE事件广播
 *   4. WebSocket帧解析与心跳
 *   5. CORS、认证、版本化路由
 *
 * 路由模块（按功能拆分）：
 *   message-routes.js    — POST /message, GET /events
 *   memory-routes.js     — GET/PATCH/DELETE /memories, GET /conversations
 *   task-routes.js       — GET/POST /tasks
 *   skill-routes.js      — GET /skills, POST /skills/:id/audit
 *   settings-routes.js   — GET/POST/PATCH /settings, /settings/*, 共14个端点
 *   admin-routes.js      — POST /admin/stop|start|restart, POST /activate
 *   auth-routes.js       — POST /auth/login|logout, GET /auth/me
 *   rag-routes.js        — /tools, /rag, /vision, /audit, /encrypt, /decrypt
 *   subagent-routes.js   — /sub-agents 全部端点
 *   team-routes.js       — /teams, /consents 全部端点
 *   voice-browser-routes.js — /voice/asr|tts, /browser/navigate
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// i18n
const { I18n, LOCALE } = require('../utils/i18n');

/**
 * WebSocket 帧解析与生成（RFC 6455）
 * 纯 Node.js 实现，无外部依赖
 */
const WS_OPCODE = { TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xA };
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── 路由模块列表 ──
const routeModules = [
  require('./routes/message-routes'),
  require('./routes/memory-routes'),
  require('./routes/task-routes'),
  require('./routes/skill-routes'),
  require('./routes/settings-routes'),
  require('./routes/admin-routes'),
  require('./routes/auth-routes'),
  require('./routes/rag-routes'),
  require('./routes/subagent-routes'),
  require('./routes/team-routes'),
  require('./routes/voice-browser-routes'),
];

class ApiServer extends EventEmitter {
  constructor(options = {}) {
    super();

    this._port = options.port || 3721;
    this._host = options.host || '127.0.0.1';
    this._agent = options.agent || null;
    this._apiToken = options.apiToken || process.env.TRICORE_API_TOKEN || null;
    this._allowLan = options.allowLan || process.env.TRICORE_ALLOW_LAN === '1';
    this._apiVersion = options.apiVersion || '1.0.0';
    this._codename = options.codename || 'TriCore';
    this._brandName = options.brandName || '蜜糖 TriCore Agent';

    this._server = null;
    this._sseClients = new Set();
    this._wsClients = new Map();
    this._wsHeartbeatInterval = null;
    this._versionedRoutes = null;

    // 路由存储
    this._routes = {};
    this._patternRoutes = [];

    // 设置变更历史
    this._settingsHistory = [];

    // i18n 实例
    this._i18n = new I18n(LOCALE.ZH_CN);
    // 注册 API 专用错误消息
    this._i18n.registerLocale(LOCALE.ZH_CN, {
      errors: {
        accessDenied: '访问被拒绝',
        notFound: '未找到',
        invalidJson: '无效的 JSON 格式',
        internalError: '内部服务器错误',
        wsUnknownType: '未知消息类型: {type}',
      },
    });
    this._i18n.registerLocale(LOCALE.EN_US, {
      errors: {
        accessDenied: 'Access denied',
        notFound: 'Not found',
        invalidJson: 'Invalid JSON',
        internalError: 'Internal server error',
        wsUnknownType: 'Unknown message type: {type}',
      },
    });

    // 注册所有路由模块
    this._loadRouteModules();
  }

  // ═══════════════════════════════════════
  // 路由注册辅助方法（供路由模块使用）
  // ═══════════════════════════════════════

  /**
   * 注册精确路由
   * @param {string} routeKey - "METHOD /path"
   * @param {Function} handler - 处理函数
   */
  _addRoute(routeKey, handler) {
    this._routes[routeKey] = handler;
  }

  /**
   * 注册模式匹配路由
   * @param {RegExp} pattern - 正则表达式
   * @param {Function} handler - 处理函数
   */
  _addPatternRoute(pattern, handler) {
    this._patternRoutes.push({ pattern, handler });
  }

  /**
   * 加载所有路由模块
   */
  _loadRouteModules() {
    for (const mod of routeModules) {
      if (typeof mod.registerRoutes === 'function') {
        mod.registerRoutes(this);
      }
    }
    // 添加通用端点（不属于任何路由模块分类的）
    this._addCommonRoutes();
  }

  /**
   * 添加通用路由：状态、配额、版本、健康检查
   */
  _addCommonRoutes() {
    const server = this;
    this._addRoute('GET /status', async function(req, res) {
      const status = this._agent ? this._agent.getStatus() : { running: false };
      this._sendJson(res, 200, status);
    });

    this._addRoute('GET /quota', async function(req, res) {
      this._sendJson(res, 200, { quota: 'unlimited', note: 'Quota tracking depends on provider' });
    });
  }

  /**
   * 挂载版本化路由 — 将所有现有路由复制到 /api/v1/ 前缀
   */
  _mountVersionedRoutes() {
    if (this._versionedRoutes) return;

    const v1Prefix = '/api/v1';
    this._versionedRoutes = {};

    for (const [key, handler] of Object.entries(this._routes)) {
      const [method, path] = key.split(' ');
      const v1Key = `${method} ${v1Prefix}${path}`;
      this._versionedRoutes[v1Key] = handler;
    }

    // 版本和健康检查端点
    const server = this;
    this._versionedRoutes['GET /api/version'] = async function(req, res) {
      const pkg = this._agent?.VERSION || '1.0.0';
      this._sendJson(res, 200, {
        version: pkg,
        apiVersion: server._apiVersion,
        codename: server._codename,
        brandName: server._brandName,
        nodeVersion: process.version,
        uptime: process.uptime(),
        endpoints: Object.keys(server._routes).length,
        timestamp: Date.now(),
      });
    };

    this._versionedRoutes['GET /api/health'] = async function(req, res) {
      const status = this._agent ? this._agent.getStatus() : { running: false };
      this._sendJson(res, 200, {
        status: status.running ? 'healthy' : 'degraded',
        agent: status,
        apiVersion: server._apiVersion,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        timestamp: Date.now(),
      });
    };
  }

  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  start() {
    return new Promise((resolve, reject) => {
      this._mountVersionedRoutes();

      this._server = http.createServer((req, res) => this._handleRequest(req, res));

      // WebSocket upgrade
      this._server.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws' || req.url?.startsWith('/ws')) {
          this._handleWebSocketUpgrade(req, socket, head);
        } else {
          socket.destroy();
        }
      });

      this._server.listen(this._port, this._host, () => {
        this._wsHeartbeatInterval = setInterval(() => this._wsHeartbeat(), 30000);
        this.emit('started', { port: this._port, host: this._host });
        resolve();
      });

      this._server.on('error', reject);
    });
  }

  stop() {
    if (this._wsHeartbeatInterval) {
      clearInterval(this._wsHeartbeatInterval);
      this._wsHeartbeatInterval = null;
    }

    for (const [socket] of this._wsClients) {
      try { this._wsSendClose(socket, 1001, 'Server shutting down'); } catch { /* ignore */ }
    }
    this._wsClients.clear();

    if (this._server) {
      for (const res of this._sseClients) {
        res.end();
      }
      this._sseClients.clear();
      this._server.close();
      this._server = null;
    }
  }

  // ═══════════════════════════════════════
  // 请求处理
  // ═══════════════════════════════════════

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // CORS
    const allowedOrigins = ['http://localhost:3721', 'http://127.0.0.1:3721'];
    const origin = req.headers.origin;
    const corsOrigin = (!origin || allowedOrigins.includes(origin)) ? (origin || '*') : allowedOrigins[0];
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-API-Version', this._apiVersion);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 安全检查
    if (!this._isAllowed(req)) {
      this._sendJson(res, 403, this._i18nError('errors.accessDenied'));
      return;
    }

    // 路由分发
    try {
      const routeKey = `${method} ${pathname}`;
      let handler = this._routes[routeKey]
        || (this._versionedRoutes ? this._versionedRoutes[routeKey] : null)
        || this._findPatternRoute(method, pathname);
      if (handler) {
        await handler.call(this, req, res, url);
      } else {
        this._sendJson(res, 404, Object.assign({ path: pathname }, this._i18nError('errors.notFound')));
      }
    } catch (error) {
      this._sendJson(res, 500, Object.assign({ detail: error.message }, this._i18nError('errors.internalError')));
    }
  }

  _isAllowed(req) {
    const remoteAddr = req.socket.remoteAddress || '';
    const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
    const isLan = this._allowLan && /^(::ffff:)?(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(remoteAddr);

    if (isLoopback || isLan) return true;

    const auth = req.headers.authorization || '';
    const expected = this._apiToken ? `Bearer ${this._apiToken}` : '';
    if (expected && auth.length === expected.length) {
      const crypto = require('crypto');
      try {
        return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
      } catch { return false; }
    }
    return false;
  }

  _findPatternRoute(method, pathname) {
    const routeKey = `${method} ${pathname}`;
    for (const { pattern, handler } of this._patternRoutes) {
      if (pattern.test(routeKey)) return handler;
    }
    return null;
  }

  // ═══════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════

  _sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  /**
   * 生成 i18n 错误响应对象
   * @param {string} key - i18n 键路径 (如 'errors.notFound')
   * @param {Object} params - 模板参数
   * @returns {{ error: string, code: string }}
   */
  _i18nError(key, params = {}) {
    return { error: this._i18n.t(key, params), code: key };
  }

  _readBody(req) {
    const MAX_BODY_SIZE = 10 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          req.destroy(new Error('Request body too large'));
          resolve({});
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }

  _recordSettingsHistory(key, oldValue, newValue) {
    if (!this._settingsHistory) this._settingsHistory = [];
    this._settingsHistory.push({
      key, oldValue, newValue,
      timestamp: new Date().toISOString(),
    });
    if (this._settingsHistory.length > 200) {
      this._settingsHistory = this._settingsHistory.slice(-200);
    }
  }

  // ═══════════════════════════════════════
  // SSE 广播
  // ═══════════════════════════════════════

  broadcastEvent(eventType, data) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this._sseClients) {
      try { res.write(payload); } catch { /* client disconnected */ }
    }
  }

  // ═══════════════════════════════════════
  // WebSocket 实时通信（RFC 6455）
  // ═══════════════════════════════════════

  _handleWebSocketUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    let authenticated = false;
    let authIdentity = 'anonymous';

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const effectiveToken = token || headerToken;

    if (effectiveToken) {
      try {
        const decoded = this._agent?._rbac?.validateToken?.(effectiveToken);
        if (decoded) { authenticated = true; authIdentity = decoded.username || decoded.sub || 'authenticated_user'; }
      } catch (e) { /* auth failed */ }
    }

    if (!authenticated && this._agent?._config?.apiToken) {
      const apiKey = url.searchParams.get('api_key') || req.headers['x-api-key'];
      if (apiKey && apiKey === this._agent._config.apiToken) {
        authenticated = true;
        authIdentity = 'api_key_user';
      }
    }

    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && !authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n'
    );

    const clientId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client = {
      id: clientId,
      connectedAt: Date.now(),
      subscriptions: new Set(),
      authenticated,
      identity: authIdentity,
    };
    this._wsClients.set(socket, client);

    this._wsSend(socket, JSON.stringify({
      type: 'connected', clientId,
      version: this._agent?.VERSION || '1.0.0',
      timestamp: Date.now(),
    }));

    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      this._wsProcessFrames(socket, buffer, (remaining) => { buffer = remaining; });
    });

    socket.on('close', () => { this._wsClients.delete(socket); });
    socket.on('error', () => { this._wsClients.delete(socket); socket.destroy(); });

    this.emit('ws:connected', { clientId });
  }

  _wsProcessFrames(socket, buffer, setRemaining) {
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const opcode = firstByte & 0x0F;
      const secondByte = buffer[1];
      const masked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7F;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) break;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) break;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLength) break;

      let maskKey = null;
      if (masked) { maskKey = buffer.slice(offset, offset + 4); offset += 4; }

      let payload = buffer.slice(offset, offset + payloadLength);
      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) { payload[i] ^= maskKey[i % 4]; }
      }

      switch (opcode) {
        case WS_OPCODE.TEXT:
          try {
            const msg = JSON.parse(payload.toString('utf8'));
            this._handleWsMessage(socket, msg);
          } catch { this._wsSend(socket, JSON.stringify({ type: 'error', message: this._i18n.t('errors.invalidJson') })); }
          break;
        case WS_OPCODE.CLOSE:
          this._wsSendClose(socket, 1000, 'Normal closure');
          socket.end();
          return;
        case WS_OPCODE.PING:
          this._wsSendFrame(socket, WS_OPCODE.PONG, payload);
          break;
        case WS_OPCODE.PONG:
          break;
      }

      buffer = buffer.slice(offset + payloadLength);
    }
    setRemaining(buffer);
  }

  _handleWsMessage(socket, msg) {
    const client = this._wsClients.get(socket);
    if (!client) return;

    switch (msg.type) {
      case 'subscribe':
        if (msg.channel) {
          client.subscriptions.add(msg.channel);
          this._wsSend(socket, JSON.stringify({
            type: 'subscribed', channel: msg.channel,
            subscriptions: [...client.subscriptions],
          }));
        }
        break;
      case 'unsubscribe':
        if (msg.channel) {
          client.subscriptions.delete(msg.channel);
          this._wsSend(socket, JSON.stringify({
            type: 'unsubscribed', channel: msg.channel,
            subscriptions: [...client.subscriptions],
          }));
        }
        break;
      case 'ping':
        this._wsSend(socket, JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      case 'message':
        if (msg.content && this._agent) {
          const msgId = this._agent.sendMessage(client.id, msg.content, { channel: 'websocket' });
          this._wsSend(socket, JSON.stringify({
            type: 'message_queued', messageId: msgId, timestamp: Date.now(),
          }));
        }
        break;
      default:
        this._wsSend(socket, JSON.stringify({
          type: 'error', message: this._i18n.t('errors.wsUnknownType', { type: msg.type }),
        }));
    }
  }

  _wsSend(socket, message) {
    const payload = Buffer.from(message, 'utf8');
    this._wsSendFrame(socket, WS_OPCODE.TEXT, payload);
  }

  _wsSendFrame(socket, opcode, payload) {
    let frame;
    const length = payload.length;

    if (length < 126) {
      frame = Buffer.alloc(2 + length);
      frame[0] = 0x80 | opcode;
      frame[1] = length;
      payload.copy(frame, 2);
    } else if (length < 65536) {
      frame = Buffer.alloc(4 + length);
      frame[0] = 0x80 | opcode;
      frame[1] = 126;
      frame.writeUInt16BE(length, 2);
      payload.copy(frame, 4);
    } else {
      frame = Buffer.alloc(10 + length);
      frame[0] = 0x80 | opcode;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
      payload.copy(frame, 10);
    }

    try { socket.write(frame); } catch { /* socket closed */ }
  }

  _wsSendClose(socket, code, reason) {
    const reasonBuf = Buffer.from(reason || '', 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._wsSendFrame(socket, WS_OPCODE.CLOSE, payload);
  }

  _wsHeartbeat() {
    for (const socket of this._wsClients.keys()) {
      try {
        this._wsSendFrame(socket, WS_OPCODE.PING, Buffer.alloc(0));
      } catch {
        this._wsClients.delete(socket);
        socket.destroy();
      }
    }
  }

  broadcastWs(channel, data) {
    const payload = JSON.stringify({
      type: 'event', channel, data, timestamp: Date.now(),
    });

    for (const [socket, client] of this._wsClients) {
      if (client.subscriptions.has(channel) || client.subscriptions.has('*')) {
        try { this._wsSend(socket, payload); } catch { /* ignore */ }
      }
    }
  }

  getStatus() {
    return {
      running: !!this._server,
      port: this._port,
      host: this._host,
      apiVersion: this._apiVersion,
      sseClients: this._sseClients.size,
      wsClients: this._wsClients.size,
      allowLan: this._allowLan,
      version: '1.0.0',
      endpoints: Object.keys(this._routes),
    };
  }
}

module.exports = { ApiServer };
