/**
 * 蜜糖 TriCore Agent - 子智能体 WebSocket 实时通信通道
 *
 * 核心职责：
 *   1. 子智能体与前端之间的双向实时通信
 *   2. 消息推送 - 子智能体回复实时推送到前端
 *   3. 状态同步 - 子智能体状态变化实时通知
 *   4. 流式响应 - 支持流式输出（SSE over WebSocket）
 *   5. 会话事件 - 会话创建/切换/关闭等事件推送
 *   6. 心跳保活 - 连接状态维护与断线重连
 *
 * 协议设计：
 *   客户端 → 服务端:
 *     { type: "message", agentId: "...", sessionId: "...", content: "..." }
 *     { type: "subscribe", agentId: "..." }
 *     { type: "unsubscribe", agentId: "..." }
 *     { type: "create_session", agentId: "...", name: "..." }
 *     { type: "switch_session", agentId: "...", sessionId: "..." }
 *     { type: "execute_tool", agentId: "...", tool: "...", params: {} }
 *     { type: "ping" }
 *
 *   服务端 → 客户端:
 *     { type: "response", agentId: "...", sessionId: "...", messageId: "...", content: "...", metadata: {} }
 *     { type: "stream_chunk", agentId: "...", sessionId: "...", chunk: "...", index: 0 }
 *     { type: "stream_end", agentId: "...", sessionId: "...", messageId: "..." }
 *     { type: "state_change", agentId: "...", state: "thinking|executing|responding|idle" }
 *     { type: "session_event", agentId: "...", event: "created|closed", session: {} }
 *     { type: "error", agentId: "...", error: "..." }
 *     { type: "pong" }
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const WS_CLIENT_STATE = Object.freeze({
  CONNECTED: 'connected',
  SUBSCRIBED: 'subscribed',
  DISCONNECTED: 'disconnected',
});

const DEFAULT_CONFIG = {
  heartbeatInterval: 30000,
  heartbeatTimeout: 60000,
  maxConnectionsPerAgent: 10,
  maxMessageSize: 1024 * 1024,  // 1MB
};

class SubAgentWebSocket extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._config = { ...DEFAULT_CONFIG, ...options };
    this._subAgentManager = options.subAgentManager || null;
    this._guardian = options.guardian || null;

    // 客户端连接管理
    this._clients = new Map();          // clientId → clientInfo
    this._agentSubscriptions = new Map(); // agentId → Set<clientId>

    // 活跃流式响应
    this._activeStreams = new Map();    // streamId → streamInfo

    this._logger.info('[SubAgentWebSocket] WebSocket通道已初始化');
  }

  // ═══════════════════════════════════════
  // 连接管理
  // ═══════════════════════════════════════

  /**
   * 处理新连接
   */
  handleConnection(ws, req) {
    const clientId = `ws_${crypto.randomUUID().slice(0, 8)}`;
    const clientInfo = {
      id: clientId,
      ws,
      state: WS_CLIENT_STATE.CONNECTED,
      subscriptions: new Set(),
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      ip: req?.socket?.remoteAddress || 'unknown',
      messageCount: 0,
    };

    this._clients.set(clientId, clientInfo);

    // 心跳检测
    clientInfo._heartbeatTimer = setInterval(() => {
      if (Date.now() - clientInfo.lastHeartbeat > this._config.heartbeatTimeout) {
        this._logger.warn(`[SubAgentWebSocket] 客户端心跳超时: ${clientId}`);
        this._disconnectClient(clientId, 'heartbeat_timeout');
      }
    }, this._config.heartbeatInterval);

    // 消息处理
    ws.on('message', (data) => {
      clientInfo.lastHeartbeat = Date.now();
      clientInfo.messageCount++;
      this._handleMessage(clientId, data);
    });

    // 关闭处理
    ws.on('close', () => {
      this._disconnectClient(clientId, 'client_closed');
    });

    // 错误处理
    ws.on('error', (error) => {
      this._logger.error(`[SubAgentWebSocket] 客户端错误: ${clientId} - ${error.message}`);
    });

    // 发送欢迎消息
    this._sendToClient(ws, {
      type: 'connected',
      clientId,
      timestamp: Date.now(),
      serverInfo: {
        name: '蜜糖 TriCore Agent - 子智能体通信通道',
        version: '1.0.0',
        protocol: 'subagent-ws-v1',
      },
    });

    this._logger.info(`[SubAgentWebSocket] 客户端连接: ${clientId}`);
    this.emit('client_connected', { clientId });

    return clientId;
  }

  /**
   * 断开客户端连接
   */
  _disconnectClient(clientId, reason) {
    const client = this._clients.get(clientId);
    if (!client) return;

    // 清除心跳定时器
    if (client._heartbeatTimer) {
      clearInterval(client._heartbeatTimer);
    }

    // 取消所有订阅
    for (const agentId of client.subscriptions) {
      const subscribers = this._agentSubscriptions.get(agentId);
      if (subscribers) {
        subscribers.delete(clientId);
        if (subscribers.size === 0) {
          this._agentSubscriptions.delete(agentId);
        }
      }
    }

    // 关闭连接
    try { client.ws.close(); } catch {}

    this._clients.delete(clientId);
    this.emit('client_disconnected', { clientId, reason });
    this._logger.info(`[SubAgentWebSocket] 客户端断开: ${clientId} (${reason})`);
  }

  // ═══════════════════════════════════════
  // 消息处理
  // ═══════════════════════════════════════

  /**
   * 处理客户端消息
   */
  async _handleMessage(clientId, rawData) {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      this._sendError(clientId, '无效的JSON格式');
      return;
    }

    // 大小检查
    if (rawData.length > this._config.maxMessageSize) {
      this._sendError(clientId, '消息大小超过限制');
      return;
    }

    const client = this._clients.get(clientId);
    if (!client) return;

    try {
      switch (data.type) {
        case 'ping':
          this._handlePing(clientId);
          break;

        case 'subscribe':
          await this._handleSubscribe(clientId, data);
          break;

        case 'unsubscribe':
          await this._handleUnsubscribe(clientId, data);
          break;

        case 'message':
          await this._handleAgentMessage(clientId, data);
          break;

        case 'create_session':
          await this._handleCreateSession(clientId, data);
          break;

        case 'switch_session':
          await this._handleSwitchSession(clientId, data);
          break;

        case 'list_sessions':
          await this._handleListSessions(clientId, data);
          break;

        case 'get_session':
          await this._handleGetSession(clientId, data);
          break;

        case 'close_session':
          await this._handleCloseSession(clientId, data);
          break;

        case 'clear_session':
          await this._handleClearSession(clientId, data);
          break;

        case 'execute_tool':
          await this._handleExecuteTool(clientId, data);
          break;

        case 'get_status':
          await this._handleGetStatus(clientId, data);
          break;

        case 'list_tools':
          await this._handleListTools(clientId, data);
          break;

        default:
          this._sendError(clientId, `未知消息类型: ${data.type}`);
      }
    } catch (error) {
      this._logger.error(`[SubAgentWebSocket] 消息处理错误: ${error.message}`);
      this._sendError(clientId, `处理错误: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════
  // 消息处理器
  // ═══════════════════════════════════════

  _handlePing(clientId) {
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, { type: 'pong', timestamp: Date.now() });
    }
  }

  async _handleSubscribe(clientId, data) {
    const { agentId } = data;
    if (!agentId) {
      this._sendError(clientId, '缺少 agentId');
      return;
    }

    const client = this._clients.get(clientId);
    if (!client) return;

    // 验证子智能体存在
    const agent = this._subAgentManager?._agents?.get(agentId);
    if (!agent) {
      this._sendError(clientId, `子智能体不存在: ${agentId}`);
      return;
    }

    // 检查订阅限制
    const subscribers = this._agentSubscriptions.get(agentId) || new Set();
    if (subscribers.size >= this._config.maxConnectionsPerAgent) {
      this._sendError(clientId, '该子智能体连接数已达上限');
      return;
    }

    client.subscriptions.add(agentId);
    subscribers.add(clientId);
    this._agentSubscriptions.set(agentId, subscribers);
    client.state = WS_CLIENT_STATE.SUBSCRIBED;

    this._sendToClient(client.ws, {
      type: 'subscribed',
      agentId,
      agentName: agent.name,
      agentType: agent.type,
      timestamp: Date.now(),
    });

    // 推送当前状态
    const engine = this._getEngine(agentId);
    if (engine) {
      this._sendToClient(client.ws, {
        type: 'agent_status',
        agentId,
        status: engine.getStatus(),
      });
    }

    this._logger.info(`[SubAgentWebSocket] 客户端 ${clientId} 订阅子智能体: ${agentId}`);
  }

  async _handleUnsubscribe(clientId, data) {
    const { agentId } = data;
    const client = this._clients.get(clientId);
    if (!client) return;

    client.subscriptions.delete(agentId);
    const subscribers = this._agentSubscriptions.get(agentId);
    if (subscribers) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this._agentSubscriptions.delete(agentId);
      }
    }

    this._sendToClient(client.ws, {
      type: 'unsubscribed',
      agentId,
      timestamp: Date.now(),
    });
  }

  async _handleAgentMessage(clientId, data) {
    const { agentId, sessionId, content, options } = data;
    if (!agentId || !content) {
      this._sendError(clientId, '缺少 agentId 或 content');
      return;
    }

    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    // 安全检查
    if (this._guardian) {
      const auth = this._guardian.authorize(agentId, 'ws_message', {
        content: content.substring(0, 100),
        clientId,
      });
      if (!auth.allowed) {
        this._sendError(clientId, `安全限制: ${auth.reason}`);
        return;
      }
    }

    const client = this._clients.get(clientId);

    // 发送处理中状态
    if (client) {
      this._sendToClient(client.ws, {
        type: 'state_change',
        agentId,
        state: 'thinking',
        timestamp: Date.now(),
      });
    }

    // 监听引擎事件以进行流式推送
    const streamId = `stream_${crypto.randomUUID().slice(0, 8)}`;
    const streamInfo = { agentId, clientId, sessionId, chunks: [], startedAt: Date.now() };
    this._activeStreams.set(streamId, streamInfo);

    // 发送消息
    const result = await engine.sendMessage(content, sessionId, options || {});

    // 推送响应
    if (client) {
      if (result.success) {
        // 获取完整响应（最后一条assistant消息）
        const session = engine.getSession(sessionId || engine._activeSessionId);
        const lastResponse = session?.messages?.filter(m => m.role === 'assistant').pop();

        if (lastResponse) {
          this._sendToClient(client.ws, {
            type: 'response',
            agentId,
            sessionId: sessionId || engine._activeSessionId,
            messageId: lastResponse.id,
            content: lastResponse.content,
            metadata: lastResponse.metadata,
            timestamp: Date.now(),
          });
        }

        // 流式完成
        this._sendToClient(client.ws, {
          type: 'stream_end',
          agentId,
          streamId,
          sessionId: sessionId || engine._activeSessionId,
          messageId: lastResponse?.id,
          timestamp: Date.now(),
        });

        // 更新状态
        this._sendToClient(client.ws, {
          type: 'state_change',
          agentId,
          state: 'idle',
          timestamp: Date.now(),
        });
      } else {
        this._sendError(clientId, result.error || '消息处理失败');
      }
    }

    this._activeStreams.delete(streamId);
  }

  async _handleCreateSession(clientId, data) {
    const { agentId, name } = data;
    if (!agentId) {
      this._sendError(clientId, '缺少 agentId');
      return;
    }

    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    const result = engine.createSession({ name });
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'session_event',
        agentId,
        event: 'created',
        session: result.session,
        timestamp: Date.now(),
      });
    }
  }

  async _handleSwitchSession(clientId, data) {
    const { agentId, sessionId } = data;
    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    const result = engine.switchSession(sessionId);
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'session_switched',
        agentId,
        sessionId,
        success: result.success,
        error: result.error,
        timestamp: Date.now(),
      });
    }
  }

  async _handleListSessions(clientId, data) {
    const { agentId } = data;
    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    const sessions = engine.listSessions();
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'session_list',
        agentId,
        sessions,
        timestamp: Date.now(),
      });
    }
  }

  async _handleGetSession(clientId, data) {
    const { agentId, sessionId } = data;
    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    const session = engine.getSession(sessionId);
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'session_detail',
        agentId,
        session: session,
        timestamp: Date.now(),
      });
    }
  }

  async _handleCloseSession(clientId, data) {
    const { agentId, sessionId } = data;
    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    const result = engine.closeSession(sessionId);
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'session_event',
        agentId,
        event: 'closed',
        sessionId,
        success: result.success,
        timestamp: Date.now(),
      });
    }
  }

  async _handleClearSession(clientId, data) {
    const { agentId, sessionId } = data;
    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    const result = engine.clearSession(sessionId);
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'session_cleared',
        agentId,
        sessionId,
        success: result.success,
        timestamp: Date.now(),
      });
    }
  }

  async _handleExecuteTool(clientId, data) {
    const { agentId, tool, params } = data;
    if (!agentId || !tool) {
      this._sendError(clientId, '缺少 agentId 或 tool');
      return;
    }

    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    // 安全检查
    if (this._guardian) {
      const auth = this._guardian.authorize(agentId, `tool:${tool}`, params || {});
      if (!auth.allowed) {
        this._sendError(clientId, `安全限制: ${auth.reason}`);
        return;
      }
    }

    const result = await engine.executeTool(tool, params || {});
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'tool_result',
        agentId,
        tool,
        result,
        timestamp: Date.now(),
      });
    }
  }

  async _handleGetStatus(clientId, data) {
    const { agentId } = data;
    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    const status = engine.getStatus();
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'agent_status',
        agentId,
        status,
        timestamp: Date.now(),
      });
    }
  }

  async _handleListTools(clientId, data) {
    const { agentId } = data;
    const engine = this._getEngine(agentId);
    if (!engine) {
      this._sendError(clientId, `子智能体引擎未启动: ${agentId}`);
      return;
    }

    const tools = engine.listTools();
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'tool_list',
        agentId,
        tools,
        timestamp: Date.now(),
      });
    }
  }

  // ═══════════════════════════════════════
  // 广播推送
  // ═══════════════════════════════════════

  /**
   * 向订阅了指定子智能体的所有客户端广播消息
   */
  broadcastToAgent(agentId, message) {
    const subscribers = this._agentSubscriptions.get(agentId);
    if (!subscribers || subscribers.size === 0) return 0;

    let sent = 0;
    for (const clientId of subscribers) {
      const client = this._clients.get(clientId);
      if (client && client.ws.readyState === 1) { // WebSocket.OPEN
        this._sendToClient(client.ws, message);
        sent++;
      }
    }
    return sent;
  }

  /**
   * 广播引擎状态变化
   */
  broadcastStateChange(agentId, state) {
    return this.broadcastToAgent(agentId, {
      type: 'state_change',
      agentId,
      state,
      timestamp: Date.now(),
    });
  }

  /**
   * 广播引擎事件
   */
  broadcastEngineEvent(agentId, eventType, data) {
    return this.broadcastToAgent(agentId, {
      type: 'engine_event',
      agentId,
      event: eventType,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * 向所有已连接客户端广播
   */
  broadcastAll(message) {
    let sent = 0;
    for (const [clientId, client] of this._clients) {
      if (client.ws.readyState === 1) {
        this._sendToClient(client.ws, message);
        sent++;
      }
    }
    return sent;
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _sendToClient(ws, message) {
    try {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify(message));
      }
    } catch (error) {
      this._logger.error(`[SubAgentWebSocket] 发送失败: ${error.message}`);
    }
  }

  _sendError(clientId, error) {
    const client = this._clients.get(clientId);
    if (client) {
      this._sendToClient(client.ws, {
        type: 'error',
        error,
        timestamp: Date.now(),
      });
    }
  }

  _getEngine(agentId) {
    return this._subAgentManager?._engines?.get(agentId) || null;
  }

  /**
   * 获取连接统计
   */
  getStats() {
    return {
      totalClients: this._clients.size,
      subscribedClients: Array.from(this._clients.values()).filter(c => c.state === WS_CLIENT_STATE.SUBSCRIBED).length,
      agentSubscriptions: Array.from(this._agentSubscriptions.entries()).map(([agentId, clients]) => ({
        agentId,
        subscriberCount: clients.size,
      })),
      activeStreams: this._activeStreams.size,
      totalMessages: Array.from(this._clients.values()).reduce((s, c) => s + c.messageCount, 0),
    };
  }

  /**
   * 关闭所有连接
   */
  close() {
    for (const [clientId, client] of this._clients) {
      this._disconnectClient(clientId, 'server_shutdown');
    }
    this._clients.clear();
    this._agentSubscriptions.clear();
    this._activeStreams.clear();
    this.removeAllListeners();
    this._logger.info('[SubAgentWebSocket] 所有连接已关闭');
  }
}

module.exports = {
  SubAgentWebSocket,
  WS_CLIENT_STATE,
};
