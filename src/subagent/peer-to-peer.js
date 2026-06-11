/**
 * 蜜糖 TriCore Agent — P2P子智能体通信 v5.0.0
 * 
 * 允许子智能体之间直接通信（点对点），而非总是通过主Agent中转
 * 
 * 功能：
 *   1. 发现 — 子智能体互相发现
 *   2. 直连 — 建立P2P通信通道
 *   3. 消息 — 加密点对点消息
 *   4. 同步 — 状态/记忆同步
 *   5. 心跳 — 连接保活
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 连接状态 ──
const PEER_STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error',
});

// ── 消息类型 ──
const PEER_MESSAGE_TYPE = Object.freeze({
  DISCOVERY: 'discovery',       // 发现广播
  HANDSHAKE: 'handshake',       // 握手
  DATA: 'data',                 // 数据消息
  SYNC: 'sync',                 // 状态同步
  HEARTBEAT: 'heartbeat',       // 心跳
  GOODBYE: 'goodbye',           // 断开
});

/**
 * P2P通信管理器
 */
class PeerToPeerNetwork extends EventEmitter {
  constructor(options = {}) {
    super();
    this._peers = new Map();           // peerId → { state, channel, metadata }
    this._pendingConnections = new Map(); // peerId → Promise
    this._maxPeers = options.maxPeers || 10;
    this._heartbeatInterval = options.heartbeatInterval || 15000;
    this._heartbeatTimeout = options.heartbeatTimeout || 45000;
    this._nodeId = options.nodeId || `node_${crypto.randomBytes(4).toString('hex')}`;
    this._encryptionKey = options.encryptionKey || null;
    this._heartbeatTimer = null;
  }

  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  start() {
    this._heartbeatTimer = setInterval(() => {
      this._checkHeartbeats();
      this._broadcastHeartbeat();
    }, this._heartbeatInterval);
    this.emit('p2p:started', { nodeId: this._nodeId });
  }

  stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    // 通知所有对等节点断开
    this._broadcastGoodbye();
    this._peers.clear();
    this.emit('p2p:stopped', { nodeId: this._nodeId });
  }

  // ═══════════════════════════════════════
  // 发现
  // ═══════════════════════════════════════

  /**
   * 注册一个可发现的对等节点
   */
  discoverPeer(peerInfo) {
    const { id, capabilities = [], address } = peerInfo;
    if (!id) throw new Error('Peer ID is required');

    if (this._peers.size >= this._maxPeers && !this._peers.has(id)) {
      throw new Error(`Max peers reached: ${this._maxPeers}`);
    }

    if (!this._peers.has(id)) {
      this._peers.set(id, {
        id,
        state: PEER_STATE.DISCONNECTED,
        capabilities,
        address,
        metadata: {
          discoveredAt: Date.now(),
          lastSeen: Date.now(),
          messageCount: 0,
        },
      });
      this.emit('peer:discovered', { peerId: id, capabilities });
    }
  }

  /**
   * 广播发现消息
   */
  broadcastDiscovery(capabilities) {
    this.emit('p2p:discovery_broadcast', {
      nodeId: this._nodeId,
      capabilities,
      timestamp: Date.now(),
    });
  }

  // ═══════════════════════════════════════
  // 连接
  // ═══════════════════════════════════════

  /**
   * 连接到对等节点
   */
  async connect(peerId) {
    const peer = this._peers.get(peerId);
    if (!peer) throw new Error(`Peer "${peerId}" not discovered`);

    if (peer.state === PEER_STATE.CONNECTED) return true;
    if (this._pendingConnections.has(peerId)) {
      return this._pendingConnections.get(peerId);
    }

    const connectPromise = this._doConnect(peer);
    this._pendingConnections.set(peerId, connectPromise);

    try {
      await connectPromise;
      this._pendingConnections.delete(peerId);
      return true;
    } catch (e) {
      this._pendingConnections.delete(peerId);
      peer.state = PEER_STATE.ERROR;
      throw e;
    }
  }

  async _doConnect(peer) {
    peer.state = PEER_STATE.CONNECTING;

    // 握手：交换节点信息
    const handshake = {
      type: PEER_MESSAGE_TYPE.HANDSHAKE,
      from: this._nodeId,
      capabilities: this._getLocalCapabilities(),
      timestamp: Date.now(),
    };

    // 模拟握手（实际环境中通过WebSocket/TCP进行）
    await new Promise(resolve => setTimeout(resolve, 10));

    peer.state = PEER_STATE.CONNECTED;
    peer.metadata.lastSeen = Date.now();
    this.emit('peer:connected', { peerId: peer.id, capabilities: peer.capabilities });
  }

  /**
   * 断开连接
   */
  disconnect(peerId) {
    const peer = this._peers.get(peerId);
    if (!peer) return;

    this._sendMessage(peerId, { type: PEER_MESSAGE_TYPE.GOODBYE, from: this._nodeId });
    peer.state = PEER_STATE.DISCONNECTED;
    this.emit('peer:disconnected', { peerId });
  }

  // ═══════════════════════════════════════
  // 消息
  // ═══════════════════════════════════════

  /**
   * 发送消息到对等节点
   */
  send(peerId, data, options = {}) {
    const peer = this._peers.get(peerId);
    if (!peer) throw new Error(`Peer "${peerId}" not found`);
    if (peer.state !== PEER_STATE.CONNECTED) {
      throw new Error(`Peer "${peerId}" not connected`);
    }

    const message = {
      id: `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      type: options.type || PEER_MESSAGE_TYPE.DATA,
      from: this._nodeId,
      to: peerId,
      data: this._encrypt(data),
      timestamp: Date.now(),
      ttl: options.ttl || 30000,
    };

    this._sendMessage(peerId, message);
    peer.metadata.messageCount++;
    peer.metadata.lastSeen = Date.now();

    this.emit('message:sent', { peerId, messageId: message.id, type: message.type });
    return message.id;
  }

  /**
   * 广播消息到所有已连接的对等节点
   */
  broadcast(data, options = {}) {
    const messageIds = [];
    for (const [peerId, peer] of this._peers) {
      if (peer.state === PEER_STATE.CONNECTED) {
        try {
          const msgId = this.send(peerId, data, options);
          messageIds.push(msgId);
        } catch {}
      }
    }
    return messageIds;
  }

  // ═══════════════════════════════════════
  // 同步
  // ═══════════════════════════════════════

  /**
   * 同步状态到对等节点
   */
  syncState(peerId, state) {
    return this.send(peerId, state, { type: PEER_MESSAGE_TYPE.SYNC });
  }

  /**
   * 广播状态同步到所有已连接节点
   */
  broadcastState(state) {
    return this.broadcast(state, { type: PEER_MESSAGE_TYPE.SYNC });
  }

  // ═══════════════════════════════════════
  // 查询
  // ═══════════════════════════════════════

  getPeers(filter = {}) {
    const result = [];
    for (const [, peer] of this._peers) {
      if (filter.state && peer.state !== filter.state) continue;
      result.push({
        id: peer.id,
        state: peer.state,
        capabilities: [...peer.capabilities],
        address: peer.address,
        metadata: { ...peer.metadata },
      });
    }
    return result;
  }

  getConnectedPeers() {
    return this.getPeers({ state: PEER_STATE.CONNECTED });
  }

  getStats() {
    const peers = Array.from(this._peers.values());
    return {
      nodeId: this._nodeId,
      totalPeers: peers.length,
      connectedPeers: peers.filter(p => p.state === PEER_STATE.CONNECTED).length,
      connectingPeers: peers.filter(p => p.state === PEER_STATE.CONNECTING).length,
      totalMessages: peers.reduce((s, p) => s + p.metadata.messageCount, 0),
    };
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  _sendMessage(peerId, message) {
    // 实际实现通过WebSocket/TCP发送
    // 当前通过EventEmitter模拟
    this.emit('message:received', { peerId, message });
  }

  _checkHeartbeats() {
    const now = Date.now();
    for (const [peerId, peer] of this._peers) {
      if (peer.state === PEER_STATE.CONNECTED &&
          now - peer.metadata.lastSeen > this._heartbeatTimeout) {
        this.disconnect(peerId);
        this.emit('peer:timeout', { peerId, lastSeen: peer.metadata.lastSeen });
      }
    }
  }

  _broadcastHeartbeat() {
    for (const [peerId, peer] of this._peers) {
      if (peer.state === PEER_STATE.CONNECTED) {
        this._sendMessage(peerId, {
          type: PEER_MESSAGE_TYPE.HEARTBEAT,
          from: this._nodeId,
          timestamp: Date.now(),
        });
      }
    }
  }

  _broadcastGoodbye() {
    for (const [peerId, peer] of this._peers) {
      if (peer.state === PEER_STATE.CONNECTED) {
        this._sendMessage(peerId, {
          type: PEER_MESSAGE_TYPE.GOODBYE,
          from: this._nodeId,
          timestamp: Date.now(),
        });
      }
    }
  }

  _getLocalCapabilities() {
    return ['tricore', 'memory', 'execution', 'evolution', 'p2p'];
  }

  _encrypt(data) {
    if (!this._encryptionKey || !data) return data;
    try {
      // 简单的对称加密（生产环境使用AES-GCM）
      const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        Buffer.from(this._encryptionKey.padEnd(32).slice(0, 32)),
        crypto.randomBytes(12)
      );
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(data), 'utf-8'),
        cipher.final(),
      ]);
      return encrypted.toString('base64');
    } catch {
      return data;
    }
  }
}

// ── 导出 ──
module.exports = {
  PeerToPeerNetwork,
  PEER_STATE,
  PEER_MESSAGE_TYPE,
};
