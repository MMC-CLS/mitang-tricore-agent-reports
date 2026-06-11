/**
 * 蜜糖 TriCore Agent — 统一持久化存储 (v3.0)
 *
 * 功能:
 *   1. MessageProcessor 管道数据持久化到 SQLite
 *   2. MemoryNetworkGraph 图数据持久化到 SQLite
 *   3. 原子写入、事务保护、WAL模式
 *   4. 崩溃恢复、数据校验、自动清理
 *
 * 设计原则:
 *   - 使用 MemoryEngine 已有的 better-sqlite3 实例
 *   - 自动建表、自动迁移
 *   - 批量写入以降低 I/O 压力
 */

'use strict';

class PersistenceStore {
  /**
   * @param {Object} options
   * @param {Object} options.db - better-sqlite3 数据库实例
   * @param {Object} options.logger - 日志记录器
   * @param {number} options.maxPipelineAge - 管道最大保留时间(ms)，默认24小时
   * @param {number} options.maxGraphSnapshots - 图快照最大保留数，默认50
   */
  constructor(options = {}) {
    this._db = options.db || null;
    this._logger = options.logger || null;
    this._maxPipelineAge = options.maxPipelineAge || 24 * 3600 * 1000; // 24小时
    this._maxGraphSnapshots = options.maxGraphSnapshots || 50;
    this._initialized = false;
    this._writeBuffer = { pipelines: [], graphNodes: [], graphEdges: [], graphClusters: [] };
    this._flushTimer = null;
    this._flushInterval = options.flushInterval || 5000; // 5秒批量写入
  }

  /**
   * 初始化数据库表
   */
  init() {
    if (!this._db) {
      if (this._logger) this._logger.warn('PersistenceStore: 无数据库实例，持久化已禁用');
      return false;
    }

    try {
      // 开启WAL模式以提高并发写入性能
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('synchronous = NORMAL');
      this._db.pragma('cache_size = -8000'); // 8MB缓存

      this._createTables();

      this._initialized = true;

      // 启动定时flush
      this._startFlushTimer();

      // 启动定时清理
      this._startCleanupTimer();

      if (this._logger) {
        this._logger.info('PersistenceStore: SQLite持久化已初始化 (WAL模式)');
      }

      return true;
    } catch (err) {
      if (this._logger) {
        this._logger.error(`PersistenceStore: 初始化失败 — ${err.message}`);
      }
      return false;
    }
  }

  /**
   * v4.2: 事务辅助方法 — 在单个事务中执行回调
   * @param {Function} fn - 在事务中执行的函数
   * @returns {any} fn 的返回值
   */
  _transaction(fn) {
    if (!this._initialized || !this._db) throw new Error('PersistenceStore not initialized');
    const txn = this._db.transaction(() => fn());
    return txn();
  }

  /**
   * 创建所有数据库表
   */
  _createTables() {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS msg_pipelines (
          msg_id TEXT PRIMARY KEY,
          from_user TEXT NOT NULL,
          content TEXT,
          channel TEXT DEFAULT 'direct',
          priority INTEGER DEFAULT 100,
          state TEXT DEFAULT 'receiving',
          quantum_state TEXT DEFAULT 'superposed',
          intent TEXT,
          complexity_level TEXT,
          language TEXT,
          affect_valence REAL,
          affect_arousal REAL,
          affect_dominance REAL,
          affect_urgency REAL,
          affect_curiosity REAL,
          affect_confidence REAL,
          entities TEXT,
          route_target TEXT,
          route_cores TEXT,
          response TEXT,
          parent_msg_id TEXT,
          processing_time_ms INTEGER,
          interrupted_reason TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_msg_pipelines_state ON msg_pipelines(state);
        CREATE INDEX IF NOT EXISTS idx_msg_pipelines_created ON msg_pipelines(created_at);
        CREATE INDEX IF NOT EXISTS idx_msg_pipelines_from ON msg_pipelines(from_user);
      `);

      this._db.exec(`
        CREATE TABLE IF NOT EXISTS msg_dag_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_msg_id TEXT NOT NULL,
          to_msg_id TEXT NOT NULL,
          edge_type TEXT DEFAULT 'reply',
          created_at INTEGER NOT NULL,
          UNIQUE(from_msg_id, to_msg_id, edge_type)
        );
        CREATE INDEX IF NOT EXISTS idx_dag_edges_from ON msg_dag_edges(from_msg_id);
        CREATE INDEX IF NOT EXISTS idx_dag_edges_to ON msg_dag_edges(to_msg_id);
      `);

      this._db.exec(`
        CREATE TABLE IF NOT EXISTS mem_graph_nodes (
          node_id TEXT PRIMARY KEY,
          type TEXT NOT NULL DEFAULT 'hot',
          tier INTEGER DEFAULT 0,
          title TEXT,
          content TEXT,
          salience REAL DEFAULT 1.0,
          age_seconds REAL DEFAULT 0,
          radius REAL DEFAULT 6,
          color_r INTEGER DEFAULT 150,
          color_g INTEGER DEFAULT 150,
          color_b INTEGER DEFAULT 150,
          glow INTEGER DEFAULT 0,
          black_hole_radius REAL DEFAULT 0,
          black_hole_strength REAL DEFAULT 0,
          is_pulsar INTEGER DEFAULT 0,
          entities TEXT,
          position_x REAL,
          position_y REAL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON mem_graph_nodes(type);
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_tier ON mem_graph_nodes(tier);
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_salience ON mem_graph_nodes(salience);
      `);

      this._db.exec(`
        CREATE TABLE IF NOT EXISTS mem_graph_edges (
          edge_id TEXT PRIMARY KEY,
          source_node TEXT NOT NULL,
          target_node TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'semantic',
          strength REAL DEFAULT 0.5,
          animated INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON mem_graph_edges(source_node);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON mem_graph_edges(target_node);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON mem_graph_edges(type);
      `);

      this._db.exec(`
        CREATE TABLE IF NOT EXISTS mem_graph_clusters (
          cluster_id TEXT PRIMARY KEY,
          label TEXT,
          mode TEXT DEFAULT 'hybrid',
          node_count INTEGER DEFAULT 0,
          node_ids TEXT,
          centroid_x REAL,
          centroid_y REAL,
          color TEXT,
          created_at INTEGER NOT NULL
        );
      `);

      this._db.exec(`
        CREATE TABLE IF NOT EXISTS mem_graph_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          snapshot_time INTEGER NOT NULL,
          node_count INTEGER DEFAULT 0,
          edge_count INTEGER DEFAULT 0,
          cluster_count INTEGER DEFAULT 0,
          graph_data TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_time ON mem_graph_snapshots(snapshot_time);
      `);
  }

  // ═══════════════════════════════════════
  // 消息管道持久化
  // ═══════════════════════════════════════

  /**
   * 保存消息管道（批量模式 — 先缓存，定时写入）
   * @param {Object} pipeline - 管道对象
   * @param {boolean} immediate - 是否立即写入（跳过缓冲区）
   */
  savePipeline(pipeline, immediate = false) {
    if (!this._initialized) return false;
    this._writeBuffer.pipelines.push(pipeline);
    if (immediate) {
      this._flushPipelines();
    }
    return true;
  }

  /**
   * 批量持久化消息管道
   */
  _flushPipelines() {
    if (!this._initialized || this._writeBuffer.pipelines.length === 0) return;

    const pipelines = this._writeBuffer.pipelines.splice(0);
    const now = Date.now();

    const insertStmt = this._db.prepare(`
      INSERT OR REPLACE INTO msg_pipelines (
        msg_id, from_user, content, channel, priority, state, quantum_state,
        intent, complexity_level, language,
        affect_valence, affect_arousal, affect_dominance, affect_urgency, affect_curiosity, affect_confidence,
        entities, route_target, route_cores, response, parent_msg_id,
        processing_time_ms, interrupted_reason,
        created_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this._db.transaction((items) => {
      for (const p of items) {
        const affect = p.analysis?.affect || [];
        insertStmt.run(
          p.msgId,
          p.from,
          p.content?.substring(0, 1000),
          p.channel,
          p.priority,
          p.state,
          p.quantumState,
          p.analysis?.intent || null,
          p.analysis?.complexity?.level || null,
          p.analysis?.language || null,
          affect[0] ?? null,
          affect[1] ?? null,
          affect[2] ?? null,
          affect[3] ?? null,
          affect[4] ?? null,
          affect[5] ?? null,
          p.analysis?.entities ? JSON.stringify(p.analysis.entities) : null,
          p.route?.target || null,
          p.route?.cores ? JSON.stringify(p.route.cores) : null,
          p.response ? JSON.stringify(p.response) : null,
          p.parentMsgId || null,
          p.completedAt ? (p.completedAt - p.timestamp) : null,
          p.interruptReason || null,
          p.timestamp,
          p.completedAt || null,
          now
        );
      }
    });

    try {
      transaction(pipelines);
    } catch (err) {
      if (this._logger) {
        this._logger.error(`PersistenceStore: 管道写入失败 — ${err.message}`);
      }
    }
  }

  /**
   * 保存DAG边
   */
  saveDAGEdge(fromMsgId, toMsgId, edgeType = 'reply') {
    if (!this._initialized) return;
    try {
      this._db.prepare(`
        INSERT OR IGNORE INTO msg_dag_edges (from_msg_id, to_msg_id, edge_type, created_at)
        VALUES (?, ?, ?, ?)
      `).run(fromMsgId, toMsgId, edgeType, Date.now());
    } catch (err) {
      // 静默失败（DAG边非关键数据）
    }
  }

  /**
   * 查询消息管道
   */
  queryPipelines(options = {}) {
    if (!this._initialized) return [];

    const { limit = 100, state, fromUser, since } = options;
    let sql = 'SELECT * FROM msg_pipelines WHERE 1=1';
    const params = [];

    if (state) { sql += ' AND state = ?'; params.push(state); }
    if (fromUser) { sql += ' AND from_user = ?'; params.push(fromUser); }
    if (since) { sql += ' AND created_at >= ?'; params.push(since); }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    return this._db.prepare(sql).all(...params).map(row => this._deserializePipeline(row));
  }

  /**
   * 获取单个管道
   */
  getPipeline(msgId) {
    if (!this._initialized) return null;
    const row = this._db.prepare('SELECT * FROM msg_pipelines WHERE msg_id = ?').get(msgId);
    return row ? this._deserializePipeline(row) : null;
  }

  // ═══════════════════════════════════════
  // 记忆网络图持久化
  // ═══════════════════════════════════════

  /**
   * 保存记忆网络图数据（全量替换）
   */
  saveGraphData(graphData) {
    if (!this._initialized || !graphData) return false;

    const now = Date.now();

    try {
      const transaction = this._db.transaction(() => {
        // 清空旧数据
        this._db.exec('DELETE FROM mem_graph_nodes');
        this._db.exec('DELETE FROM mem_graph_edges');
        this._db.exec('DELETE FROM mem_graph_clusters');

        // 写入节点
        const insertNode = this._db.prepare(`
          INSERT OR REPLACE INTO mem_graph_nodes (
            node_id, type, tier, title, content, salience, age_seconds,
            radius, color_r, color_g, color_b, glow,
            black_hole_radius, black_hole_strength, is_pulsar,
            entities, position_x, position_y,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const node of (graphData.nodes || [])) {
          // 解析RGB颜色
          const rgbMatch = (node.color || 'rgb(150,150,150)').match(/rgb\((\d+),(\d+),(\d+)\)/);
          insertNode.run(
            node.id, node.type, node.tier, node.title,
            node.content?.substring(0, 500), node.salience, node.age || 0,
            node.radius, rgbMatch ? parseInt(rgbMatch[1]) : 150,
            rgbMatch ? parseInt(rgbMatch[2]) : 150, rgbMatch ? parseInt(rgbMatch[3]) : 150,
            node.glow ? 1 : 0,
            node.blackHoleRadius || 0, node.blackHoleStrength || 0, node.isPulsar ? 1 : 0,
            JSON.stringify(node.entities || []),
            node.x, node.y,
            now, now
          );
        }

        // 写入边
        const insertEdge = this._db.prepare(`
          INSERT OR REPLACE INTO mem_graph_edges (
            edge_id, source_node, target_node, type, strength, animated, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const edge of (graphData.edges || [])) {
          insertEdge.run(
            edge.id, edge.source, edge.target, edge.type,
            edge.strength || 0.5, edge.animated ? 1 : 0, now
          );
        }

        // 写入聚类
        const insertCluster = this._db.prepare(`
          INSERT OR REPLACE INTO mem_graph_clusters (
            cluster_id, label, mode, node_count, node_ids, centroid_x, centroid_y, color, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const cluster of (graphData.clusters || [])) {
          insertCluster.run(
            cluster.id, cluster.label, cluster.mode,
            cluster.nodeCount, JSON.stringify(cluster.nodes || []),
            cluster.centroid?.x, cluster.centroid?.y,
            cluster.color, now
          );
        }

        // 保存快照（版本控制）
        this._db.prepare(`
          INSERT INTO mem_graph_snapshots (snapshot_time, node_count, edge_count, cluster_count, graph_data)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          now,
          (graphData.nodes || []).length,
          (graphData.edges || []).length,
          (graphData.clusters || []).length,
          JSON.stringify(graphData)
        );

        // 清理旧快照
        this._db.prepare(`
          DELETE FROM mem_graph_snapshots WHERE id NOT IN (
            SELECT id FROM mem_graph_snapshots ORDER BY snapshot_time DESC LIMIT ?
          )
        `).run(this._maxGraphSnapshots);
      });

      transaction();
      return true;
    } catch (err) {
      if (this._logger) {
        this._logger.error(`PersistenceStore: 图数据写入失败 — ${err.message}`);
      }
      return false;
    }
  }

  /**
   * 加载记忆网络图数据
   */
  loadGraphData() {
    if (!this._initialized) return { nodes: [], edges: [], clusters: [], pulsars: [] };

    try {
      const nodes = this._db.prepare('SELECT * FROM mem_graph_nodes').all().map(row => ({
        id: row.node_id,
        type: row.type,
        tier: row.tier,
        title: row.title,
        content: row.content,
        salience: row.salience,
        age: row.age_seconds,
        radius: row.radius,
        color: `rgb(${row.color_r},${row.color_g},${row.color_b})`,
        glow: !!row.glow,
        x: row.position_x,
        y: row.position_y,
        blackHoleRadius: row.black_hole_radius,
        blackHoleStrength: row.black_hole_strength,
        isPulsar: !!row.is_pulsar,
        entities: row.entities ? JSON.parse(row.entities) : [],
      }));

      const edges = this._db.prepare('SELECT * FROM mem_graph_edges').all().map(row => ({
        id: row.edge_id,
        source: row.source_node,
        target: row.target_node,
        type: row.type,
        strength: row.strength,
        animated: !!row.animated,
      }));

      const clusters = this._db.prepare('SELECT * FROM mem_graph_clusters').all().map(row => ({
        id: row.cluster_id,
        label: row.label,
        mode: row.mode,
        nodeCount: row.node_count,
        centroid: { x: row.centroid_x, y: row.centroid_y },
        color: row.color,
      }));

      return { nodes, edges, clusters, pulsars: [], timestamp: Date.now() };
    } catch (err) {
      if (this._logger) {
        this._logger.error(`PersistenceStore: 图数据加载失败 — ${err.message}`);
      }
      return { nodes: [], edges: [], clusters: [], pulsars: [] };
    }
  }

  /**
   * 获取图快照列表
   */
  getGraphSnapshots(limit = 20) {
    if (!this._initialized) return [];
    return this._db.prepare(
      'SELECT id, snapshot_time, node_count, edge_count, cluster_count FROM mem_graph_snapshots ORDER BY snapshot_time DESC LIMIT ?'
    ).all(limit);
  }

  /**
   * 恢复指定快照
   */
  restoreSnapshot(snapshotId) {
    if (!this._initialized) return null;
    const row = this._db.prepare('SELECT graph_data FROM mem_graph_snapshots WHERE id = ?').get(snapshotId);
    if (!row) return null;
    try {
      return JSON.parse(row.graph_data);
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════
  // 维护
  // ═══════════════════════════════════════

  /**
   * 清理过期管道数据（v4.2: 事务保护）
   */
  cleanupExpiredPipelines() {
    if (!this._initialized) return 0;
    const cutoff = Date.now() - this._maxPipelineAge;
    return this._transaction(() => {
      const result = this._db.prepare('DELETE FROM msg_pipelines WHERE created_at < ? AND state = ?')
        .run(cutoff, 'complete');
      return result.changes;
    });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    if (!this._initialized) return { initialized: false };

    const pipelineCount = this._db.prepare('SELECT COUNT(*) as cnt FROM msg_pipelines').get()?.cnt || 0;
    const dagEdgeCount = this._db.prepare('SELECT COUNT(*) as cnt FROM msg_dag_edges').get()?.cnt || 0;
    const graphNodeCount = this._db.prepare('SELECT COUNT(*) as cnt FROM mem_graph_nodes').get()?.cnt || 0;
    const graphEdgeCount = this._db.prepare('SELECT COUNT(*) as cnt FROM mem_graph_edges').get()?.cnt || 0;
    const snapshotCount = this._db.prepare('SELECT COUNT(*) as cnt FROM mem_graph_snapshots').get()?.cnt || 0;

    return {
      initialized: true,
      pipelineCount,
      dagEdgeCount,
      graphNodeCount,
      graphEdgeCount,
      snapshotCount,
    };
  }

  /**
   * 手动刷新缓冲区（确保数据立即持久化）
   */
  flush() {
    if (!this._initialized) return;
    this._flushPipelines();
  }

  /**
   * 关闭存储（flush缓冲区并清理定时器）
   */
  close() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    // 最终flush确保数据不丢失
    this._flushPipelines();
    this._initialized = false;
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  _startFlushTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => {
      this._flushPipelines();
    }, this._flushInterval);
  }

  _startCleanupTimer() {
    this._cleanupTimer = setInterval(() => {
      this.cleanupExpiredPipelines();
    }, 3600000); // 每小时清理一次
  }

  _deserializePipeline(row) {
    return {
      msgId: row.msg_id,
      from: row.from_user,
      content: row.content,
      channel: row.channel,
      priority: row.priority,
      state: row.state,
      quantumState: row.quantum_state,
      analysis: {
        intent: row.intent,
        complexity: { level: row.complexity_level },
        language: row.language,
        affect: [
          row.affect_valence, row.affect_arousal, row.affect_dominance,
          row.affect_urgency, row.affect_curiosity, row.affect_confidence,
        ],
        entities: row.entities ? JSON.parse(row.entities) : [],
      },
      route: {
        target: row.route_target,
        cores: row.route_cores ? JSON.parse(row.route_cores) : [],
      },
      response: row.response ? JSON.parse(row.response) : null,
      parentMsgId: row.parent_msg_id,
      timestamp: row.created_at,
      completedAt: row.completed_at,
      processingTime: row.processing_time_ms,
      interruptReason: row.interrupted_reason,
    };
  }
}

module.exports = { PersistenceStore };
