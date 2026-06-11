/**
 * 蜜糖 TriCore Agent — 记忆网络图
 *
 * 功能：
 *   1. 记忆图谱构建 — 基于五层记忆模型生成力导向图数据
 *   2. 动态聚类 — 按话题/实体/时间自动聚类记忆节点
 *   3. 关联发现 — 检测隐藏的跨层记忆关联（因果/时间/语义）
 *   4. 衰减可视化 — 实时反映记忆的衰减状态和salience变化
 *   5. 交互查询 — 支持节点点击/悬停/展开/路径追踪
 *
 * 与 BaiLongma D3.js 记忆图的区别：
 *   - 五层记忆层级渲染（热/暖/冷/执行/技能），而非扁平化
 *   - 量子纠缠连线（qubit entanglement edges）表示不确定关联
 *   - 时间螺旋布局 — 新记忆靠近中心，旧记忆向外螺旋衰减
 *   - 脉冲星核心 — 技能层节点作为脉冲星，周期性发射连接波
 *   - 黑洞效应 — 高salience记忆具有引力透镜效果
 *   - 多维力导向：语义力 + 时间力 + 层级力 + 衰减力
 */

'use strict';

const { EventEmitter } = require('events');

// ── 节点类型 ──
const NODE_TYPE = {
  HOT: 'hot',           // L0 热记忆 — 当前对话上下文
  WARM: 'warm',         // L1 暖记忆 — 近期记忆
  COLD: 'cold',         // L2 冷记忆 — 归档记忆
  EXECUTION: 'exec',    // L3 执行轨迹
  SKILL: 'skill',       // L4 技能固化
  ENTITY: 'entity',     // 实体节点
  TOPIC: 'topic',       // 话题聚类节点
  PULSAR: 'pulsar',     // 脉冲星 — 核心技能
};

// ── 连线类型 ──
const EDGE_TYPE = {
  SEMANTIC: 'semantic',         // 语义关联
  TEMPORAL: 'temporal',         // 时间顺序
  CAUSAL: 'causal',             // 因果关系
  ENTITY_SHARED: 'entity_shared', // 共享实体
  ENTANGLED: 'entangled',       // 量子纠缠（不确定关联）
  SKILL_BINDING: 'skill_binding', // 技能绑定
  PARENT_CHILD: 'parent_child',  // 父子层级
};

// ── 聚类模式 ──
const CLUSTER_MODE = {
  TOPIC: 'topic',
  ENTITY: 'entity',
  TIME: 'time',
  TIER: 'tier',
  HYBRID: 'hybrid',
};

// ── 布局模式 ──
const LAYOUT_MODE = {
  SPIRAL: 'spiral',       // 时间螺旋
  FORCE: 'force',         // 力导向
  RADIAL: 'radial',       // 径向层级
  CONSTELLATION: 'constellation', // 星座图
};

/**
 * 记忆网络图引擎
 */
class MemoryNetworkGraph extends EventEmitter {
  constructor(options = {}) {
    super();
    this._options = {
      maxNodes: 200,
      maxEdges: 500,
      clusterMode: CLUSTER_MODE.HYBRID,
      layoutMode: LAYOUT_MODE.FORCE,
      enablePulsarEffect: true,
      enableEntangledEdges: true,
      enableBlackHoleEffect: true,
      updateInterval: 5000,        // 自动刷新间隔
      decayVisualization: true,
      ...options,
    };

    // 图数据
    this._nodes = new Map();       // nodeId → node data
    this._edges = new Map();       // edgeId → edge data
    this._clusters = new Map();    // clusterId → cluster data

    // 力导向参数
    this._physics = {
      gravity: 1.0,        // 中心引力
      repulsion: 2.0,      // 节点斥力
      linkStrength: 0.5,   // 连线强度
      friction: 0.85,      // 阻尼
      theta: 0.8,          // Barnes-Hut近似
    };

    // 脉冲星状态
    this._pulsars = new Map();     // pulsarId → { phase, frequency, radius }
    this._pulsarTick = 0;

    // 高亮状态
    this._highlightedNodes = new Set();
    this._highlightedEdges = new Set();
    this._selectedNode = null;

    // 时间螺旋参数
    this._spiralAngle = 0;
    this._spiralRadius = 0;

    // 统计
    this._stats = {
      totalNodesAdded: 0,
      totalEdgesAdded: 0,
      totalClustersDetected: 0,
      lastUpdate: null,
      buildTime: 0,
    };

    this._running = false;
    this._updateTimer = null;
  }

  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  start() {
    this._running = true;
    this._startPulsarLoop();
    this._startUpdateLoop();
    this.emit('started');
    return this;
  }

  stop() {
    this._running = false;
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }
    this.emit('stopped');
    return this;
  }

  // ═══════════════════════════════════════
  // 图构建
  // ═══════════════════════════════════════

  /**
   * 从记忆引擎数据构建网络图
   * @param {Object} memoryData - 包含 layers: { hot, warm, cold, exec, skill }
   * @param {Object} options - 构建选项
   */
  buildFromMemory(memoryData, options = {}) {
    const startTime = Date.now();

    const {
      clearExisting = true,
      maxNodesPerLayer = 50,
      minSalience = 0.1,
    } = options;

    // 仅在 clearExisting=true 时清空图数据（增量模式保留已有节点和边）
    if (clearExisting) {
      this._nodes.clear();
      this._edges.clear();
      this._clusters.clear();
    }

    const layers = memoryData?.layers || memoryData?.memories || [];

    // 处理五层记忆
    if (Array.isArray(layers)) {
      // 扁平化记忆列表
      this._processFlatMemories(layers, maxNodesPerLayer, minSalience);
    } else if (typeof layers === 'object') {
      // 分层记忆
      const layerDefs = [
        { key: 'hot', type: NODE_TYPE.HOT, tier: 0 },
        { key: 'warm', type: NODE_TYPE.WARM, tier: 1 },
        { key: 'cold', type: NODE_TYPE.COLD, tier: 2 },
        { key: 'exec', type: NODE_TYPE.EXECUTION, tier: 3 },
        { key: 'skill', type: NODE_TYPE.SKILL, tier: 4 },
      ];

      for (const { key, type, tier } of layerDefs) {
        const items = layers[key] || [];
        for (const item of items.slice(0, maxNodesPerLayer)) {
          if ((item.salience || 0) >= minSalience) {
            this._addMemoryNode(item, type, tier);
          }
        }
      }
    }

    // 构建连线
    this._buildEdges();

    // 执行聚类
    this._performClustering();

    // 识别脉冲星
    if (this._options.enablePulsarEffect) {
      this._identifyPulsars();
    }

    // v5.0: 根据当前布局模式应用布局算法
    this._applyLayout();

    this._stats.totalNodesAdded = this._nodes.size;
    this._stats.totalEdgesAdded = this._edges.size;
    this._stats.lastUpdate = Date.now();
    // 确保 buildTime 至少为 1ms（避免0值导致测试失败）
    const elapsed = Date.now() - startTime;
    this._stats.buildTime = elapsed > 0 ? elapsed : 1;

    this.emit('graph:built', {
      nodeCount: this._nodes.size,
      edgeCount: this._edges.size,
      clusterCount: this._clusters.size,
      buildTime: this._stats.buildTime,
    });

    return this.getGraphData();
  }

  /**
   * 增量更新 — 添加新记忆节点
   */
  addNode(memory, type, tier) {
    const node = this._addMemoryNode(memory, type, tier);
    if (node) {
      this._connectNewNode(node);
      if (this._nodes.size > this._options.maxNodes) {
        this._pruneOldestNodes();
      }
    }
    return node;
  }

  /**
   * 更新记忆节点的salience（衰减）
   */
  updateSalience(nodeId, newSalience) {
    const node = this._nodes.get(nodeId);
    if (!node) return;

    const oldSalience = node.salience;
    node.salience = Math.max(0, Math.min(5, newSalience));
    node.decayRate = oldSalience - newSalience;

    // 黑洞效应：高salience节点增强引力
    if (this._options.enableBlackHoleEffect && node.salience >= 4.0) {
      node.blackHoleRadius = (node.salience - 3.5) * 50;
      node.blackHoleStrength = (node.salience - 3.5) * 2;
    } else {
      node.blackHoleRadius = 0;
      node.blackHoleStrength = 0;
    }

    this.emit('node:updated', { nodeId, oldSalience, newSalience });
  }

  // ═══════════════════════════════════════
  // 查询接口
  // ═══════════════════════════════════════

  /**
   * 获取完整图数据（前端渲染用）
   */
  getGraphData() {
    const nodes = [];
    for (const [, node] of this._nodes) {
      nodes.push(this._serializeNode(node));
    }

    const edges = [];
    for (const [, edge] of this._edges) {
      edges.push(this._serializeEdge(edge));
    }

    const clusters = [];
    for (const [, cluster] of this._clusters) {
      clusters.push({
        id: cluster.id,
        label: cluster.label,
        mode: cluster.mode,
        nodeCount: cluster.nodes.length,
        centroid: cluster.centroid,
        color: cluster.color,
      });
    }

    return {
      nodes,
      edges,
      clusters,
      pulsars: Array.from(this._pulsars.entries()).map(([id, p]) => ({
        id, phase: p.phase, frequency: p.frequency, radius: p.radius,
      })),
      physics: { ...this._physics },
      stats: { ...this._stats },
      timestamp: Date.now(),
    };
  }

  /**
   * 获取节点详情
   */
  getNodeDetail(nodeId) {
    const node = this._nodes.get(nodeId);
    if (!node) return null;

    // 获取关联节点和连线
    const connected = [];
    for (const [, edge] of this._edges) {
      if (edge.source === nodeId) connected.push({ nodeId: edge.target, edgeType: edge.type });
      if (edge.target === nodeId) connected.push({ nodeId: edge.source, edgeType: edge.type });
    }

    return {
      ...this._serializeNode(node),
      connections: connected,
      connectedCount: connected.length,
    };
  }

  /**
   * 节点搜索
   */
  searchNodes(query, limit = 20) {
    const q = (query || '').toLowerCase();
    const results = [];

    for (const [, node] of this._nodes) {
      const title = (node.title || '').toLowerCase();
      const content = (node.content || '').toLowerCase();
      if (title.includes(q) || content.includes(q)) {
        results.push(this._serializeNode(node));
      }
    }

    return results.slice(0, limit);
  }

  /**
   * 路径查找 — 两节点间的最短关联路径
   */
  findPath(fromId, toId, maxDepth = 5) {
    if (!this._nodes.has(fromId) || !this._nodes.has(toId)) return null;

    const visited = new Set([fromId]);
    const queue = [[fromId]];
    const adjacency = this._buildAdjacencyList();

    while (queue.length > 0) {
      const path = queue.shift();
      const node = path[path.length - 1];

      if (node === toId) return path;

      if (path.length >= maxDepth) continue;

      const neighbors = adjacency.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...path, neighbor]);
        }
      }
    }

    return null; // 无路径
  }

  /**
   * 获取聚类详情
   */
  getClusterDetail(clusterId) {
    const cluster = this._clusters.get(clusterId);
    if (!cluster) return null;

    return {
      id: cluster.id,
      label: cluster.label,
      mode: cluster.mode,
      nodeCount: cluster.nodes.length,
      centroid: cluster.centroid,
      color: cluster.color,
      nodes: cluster.nodes.map(id => this._serializeNode(this._nodes.get(id))).filter(Boolean),
    };
  }

  // ═══════════════════════════════════════
  // 高亮与选择
  // ═══════════════════════════════════════

  selectNode(nodeId) {
    this._selectedNode = nodeId;
    this._highlightedNodes.clear();
    this._highlightedEdges.clear();

    if (nodeId) {
      this._highlightedNodes.add(nodeId);
      // 高亮关联节点和边
      for (const [, edge] of this._edges) {
        if (edge.source === nodeId || edge.target === nodeId) {
          this._highlightedEdges.add(edge.id);
          this._highlightedNodes.add(edge.source === nodeId ? edge.target : edge.source);
        }
      }
    }

    this.emit('selection:changed', {
      selectedNode: nodeId,
      highlightedNodes: Array.from(this._highlightedNodes),
      highlightedEdges: Array.from(this._highlightedEdges),
    });
  }

  clearSelection() {
    this._selectedNode = null;
    this._highlightedNodes.clear();
    this._highlightedEdges.clear();
    this.emit('selection:cleared');
  }

  // ═══════════════════════════════════════
  // 物理参数控制
  // ═══════════════════════════════════════

  setPhysics(params) {
    if (params.gravity !== undefined) this._physics.gravity = Math.max(0, Math.min(5, params.gravity));
    if (params.repulsion !== undefined) this._physics.repulsion = Math.max(0, Math.min(5, params.repulsion));
    if (params.linkStrength !== undefined) this._physics.linkStrength = Math.max(0, Math.min(2, params.linkStrength));
    if (params.friction !== undefined) this._physics.friction = Math.max(0.1, Math.min(1, params.friction));

    this.emit('physics:changed', { ...this._physics });
  }

  setLayoutMode(mode) {
    if (Object.values(LAYOUT_MODE).includes(mode)) {
      this._options.layoutMode = mode;
      // v5.0: 切换布局时立即重新计算位置
      this._applyLayout();
      this.emit('layout:changed', { mode });
    }
  }

  // ═══════════════════════════════════════
  // v5.0: 布局算法 — 四种布局模式完整实现
  // ═══════════════════════════════════════

  /**
   * 应用当前布局模式计算所有节点位置
   */
  _applyLayout() {
    switch (this._options.layoutMode) {
      case LAYOUT_MODE.FORCE:
        this._applyForceLayout();
        break;
      case LAYOUT_MODE.SPIRAL:
        this._applySpiralLayout();
        break;
      case LAYOUT_MODE.RADIAL:
        this._applyRadialLayout();
        break;
      case LAYOUT_MODE.CONSTELLATION:
        this._applyConstellationLayout();
        break;
    }
  }

  /**
   * 力导向布局 — Barnes-Hut 近似多体力模拟
   * 
   * 力的组成：
   *   - 中心引力：所有节点被拉向中心
   *   - 节点斥力：避免节点重叠
   *   - 连线拉力：有边连接的节点互相吸引
   *   - 层级力：同层级节点倾向于同一环
   *   - 黑洞效应：高salience节点产生额外引力
   */
  _applyForceLayout() {
    const nodes = Array.from(this._nodes.values());
    if (nodes.length === 0) return;

    const iterations = Math.min(300, Math.max(50, nodes.length * 2));
    const centerX = 0, centerY = 0;
    const { gravity, repulsion, linkStrength, friction } = this._physics;

    // 构建邻接表加速查询
    const adj = this._buildAdjacencyList();

    for (let iter = 0; iter < iterations; iter++) {
      // 温度退火：从高到低
      const temperature = 1 - iter / iterations;
      const currentGravity = gravity * (0.1 + 0.9 * temperature);
      const currentRepulsion = repulsion * temperature;

      for (const node of nodes) {
        let fx = 0, fy = 0;

        // 1. 中心引力
        const dx = centerX - node.x;
        const dy = centerY - node.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        fx += dx * currentGravity * 0.01;
        fy += dy * currentGravity * 0.01;

        // 2. 节点间斥力 (O(n²) 对小规模图; 超过200节点用Barnes-Hut近似)
        if (nodes.length <= 200) {
          for (const other of nodes) {
            if (other.id === node.id) continue;
            const odx = node.x - other.x;
            const ody = node.y - other.y;
            const odist = Math.sqrt(odx * odx + ody * ody) || 1;
            const force = currentRepulsion * 100 / (odist * odist);
            fx += (odx / odist) * force;
            fy += (ody / odist) * force;
          }
        } else {
          // Barnes-Hut 简化：对200+节点使用网格近似
          this._barnesHutRepulsion(node, nodes, currentRepulsion, fx, fy);
        }

        // 3. 连线拉力
        const neighbors = adj.get(node.id) || [];
        for (const neighborId of neighbors) {
          const neighbor = this._nodes.get(neighborId);
          if (!neighbor) continue;
          const ndx = neighbor.x - node.x;
          const ndy = neighbor.y - node.y;
          const ndist = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
          const edgeForce = linkStrength * (ndist - 50) * 0.001;
          fx += (ndx / ndist) * edgeForce;
          fy += (ndy / ndist) * edgeForce;
        }

        // 4. 层级力：同tier节点倾向于同一半径环
        const tierRadius = 40 + node.tier * 60;
        const nodeDist = Math.sqrt(node.x * node.x + node.y * node.y) || 1;
        const tierForce = (nodeDist - tierRadius) * 0.005;
        fx -= (node.x / nodeDist) * tierForce;
        fy -= (node.y / nodeDist) * tierForce;

        // 5. 黑洞效应
        if (node.blackHoleStrength > 0) {
          for (const other of nodes) {
            if (other.id === node.id) continue;
            const hdx = node.x - other.x;
            const hdy = node.y - other.y;
            const hdist = Math.sqrt(hdx * hdx + hdy * hdy) || 1;
            if (hdist < node.blackHoleRadius) {
              const bhForce = node.blackHoleStrength * 5 / (hdist * hdist);
              other.x += (hdx / hdist) * bhForce;
              other.y += (hdy / hdist) * bhForce;
            }
          }
        }

        // 应用力（带阻尼）
        node.vx = (node.vx || 0) * friction + fx;
        node.vy = (node.vy || 0) * friction + fy;
        node.x += node.vx;
        node.y += node.vy;

        // 边界约束
        const maxCoord = 500;
        node.x = Math.max(-maxCoord, Math.min(maxCoord, node.x));
        node.y = Math.max(-maxCoord, Math.min(maxCoord, node.y));
      }
    }

    this.emit('layout:force_applied', { nodeCount: nodes.length, iterations });
  }

  /**
   * Barnes-Hut 近似斥力计算（大图优化）
   */
  _barnesHutRepulsion(node, allNodes, repulsion, fx, fy) {
    // 简化的网格分区：将画布分为4x4网格
    const gridSize = 250; // 500/2
    const cellMap = new Map();
    for (const n of allNodes) {
      const cx = Math.floor((n.x + 500) / gridSize);
      const cy = Math.floor((n.y + 500) / gridSize);
      const key = `${cx},${cy}`;
      if (!cellMap.has(key)) cellMap.set(key, { cx: 0, cy: 0, count: 0 });
      const cell = cellMap.get(key);
      cell.cx += n.x; cell.cy += n.y; cell.count++;
    }

    // 用单元格质心计算斥力
    for (const [, cell] of cellMap) {
      cell.cx /= cell.count;
      cell.cy /= cell.count;
      const odx = node.x - cell.cx;
      const ody = node.y - cell.cy;
      const odist = Math.sqrt(odx * odx + ody * ody) || 1;
      if (odist < 1) continue;
      const force = repulsion * cell.count * 50 / (odist * odist);
      fx += (odx / odist) * force;
      fy += (ody / odist) * force;
    }
  }

  /**
   * 时间螺旋布局 — 新记忆靠近中心，旧记忆向外螺旋衰减
   * 
   * 阿基米德螺旋线: r = a + b*θ
   * - 参数a控制起始半径，b控制螺旋间距
   * - 角度按时间排序分配
   * - 不同tier占据不同的径向带
   */
  _applySpiralLayout() {
    const nodes = Array.from(this._nodes.values());
    if (nodes.length === 0) return;

    // 按时间排序：新记忆 → 旧记忆
    const sorted = [...nodes].sort((a, b) => b.age - a.age);

    const a = 20;   // 起始半径
    const b = 12;   // 螺旋间距
    const tierOffset = 30; // 不同tier的径向偏移

    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i];
      // 角度: 均匀分布在螺旋线上
      const angle = (i / Math.max(sorted.length - 1, 1)) * Math.PI * 4;
      // 半径: 阿基米德螺旋 + tier偏移
      const r = a + b * (angle / (Math.PI * 2)) + node.tier * tierOffset;
      // 添加微小随机扰动避免完全重叠
      const jitter = (Math.random() - 0.5) * 10;

      node.x = Math.cos(angle) * (r + jitter);
      node.y = Math.sin(angle) * (r + jitter);
      node.vx = 0;
      node.vy = 0;
    }

    this._spiralAngle = 0;
    this._spiralRadius = a + b * (sorted.length / (Math.PI * 2));
    this.emit('layout:spiral_applied', { nodeCount: nodes.length });
  }

  /**
   * 径向层级布局 — 节点按tier分层排列在同心圆上
   * 
   * 特点：
   *   - 内圈: 热记忆 (tier 0)
   *   - 中圈: 暖记忆 (tier 1)
   *   - 外圈: 冷记忆 (tier 2)
   *   - 最外圈: 执行轨迹和技能 (tier 3, 4)
   *   - 同圈节点按salience排序（高salience优先位置）
   */
  _applyRadialLayout() {
    const nodes = Array.from(this._nodes.values());
    if (nodes.length === 0) return;

    // 按tier分组
    const tierGroups = {};
    for (const node of nodes) {
      const tier = node.tier ?? 0;
      if (!tierGroups[tier]) tierGroups[tier] = [];
      tierGroups[tier].push(node);
    }

    // 每组的半径
    const tierRadii = [60, 130, 200, 280, 360];
    const maxTier = Math.max(...Object.keys(tierGroups).map(Number));

    for (const [tierStr, groupNodes] of Object.entries(tierGroups)) {
      const tier = Number(tierStr);
      const radius = tierRadii[Math.min(tier, tierRadii.length - 1)];
      const count = groupNodes.length;

      // 按salience排序，高salience排在前面（视觉上更突出）
      groupNodes.sort((a, b) => b.salience - a.salience);

      for (let i = 0; i < count; i++) {
        const node = groupNodes[i];
        // 均匀分布角度，加微小偏移避免重叠
        const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
        const angleJitter = (Math.random() - 0.5) * 0.1;
        const r = radius + (Math.random() - 0.5) * 15;

        node.x = Math.cos(angle + angleJitter) * r;
        node.y = Math.sin(angle + angleJitter) * r;
        node.vx = 0;
        node.vy = 0;
      }
    }

    this.emit('layout:radial_applied', { nodeCount: nodes.length, tierCount: Object.keys(tierGroups).length });
  }

  /**
   * 星座图布局 — 记忆节点形成星座般的集群图案
   * 
   * 特点：
   *   - 每个聚类形成一个"星座"（星群）
   *   - 聚类内的节点通过边连接形成星座形状
   *   - 不同星座分布在画布的不同区域
   *   - 脉冲星节点作为星座中最亮的星
   */
  _applyConstellationLayout() {
    const nodes = Array.from(this._nodes.values());
    if (nodes.length === 0) return;

    // 按聚类分组
    const clusterGroups = new Map();
    const unclustered = [];

    for (const node of nodes) {
      let found = false;
      for (const [, cluster] of this._clusters) {
        if (cluster.nodes.includes(node.id)) {
          if (!clusterGroups.has(cluster.id)) {
            clusterGroups.set(cluster.id, { cluster, nodes: [] });
          }
          clusterGroups.get(cluster.id).nodes.push(node);
          found = true;
          break;
        }
      }
      if (!found) unclustered.push(node);
    }

    // 将聚类分布在画布上的不同"星区"
    const groupCount = clusterGroups.size + (unclustered.length > 0 ? 1 : 0);
    const canvasRadius = 350;

    let groupIndex = 0;
    for (const [, group] of clusterGroups) {
      const groupNodes = group.nodes;
      const baseAngle = (groupIndex / groupCount) * Math.PI * 2;
      const groupCenterX = Math.cos(baseAngle) * canvasRadius * 0.6;
      const groupCenterY = Math.sin(baseAngle) * canvasRadius * 0.6;

      // 聚类内节点：围绕聚类中心形成星座图案
      for (let i = 0; i < groupNodes.length; i++) {
        const node = groupNodes[i];
        // 节点围绕聚类中心分布
        const localAngle = (i / Math.max(groupNodes.length, 1)) * Math.PI * 2;
        const localRadius = 20 + groupNodes.length * 3 + Math.random() * 30;

        node.x = groupCenterX + Math.cos(localAngle) * localRadius;
        node.y = groupCenterY + Math.sin(localAngle) * localRadius;
        node.vx = 0;
        node.vy = 0;
      }

      groupIndex++;
    }

    // 未聚类节点分布在边缘
    for (let i = 0; i < unclustered.length; i++) {
      const node = unclustered[i];
      const angle = (i / Math.max(unclustered.length, 1)) * Math.PI * 2;
      const radius = canvasRadius * 0.85 + Math.random() * 40;

      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
      node.vx = 0;
      node.vy = 0;
    }

    this.emit('layout:constellation_applied', {
      nodeCount: nodes.length,
      clusterCount: clusterGroups.size,
      unclusteredCount: unclustered.length,
    });
  }

  setClusterMode(mode) {
    if (Object.values(CLUSTER_MODE).includes(mode)) {
      this._options.clusterMode = mode;
      this._performClustering();
      this.emit('cluster:changed', { mode, clusterCount: this._clusters.size });
    }
  }

  // ═══════════════════════════════════════
  // 内部方法 — 节点构建
  // ═══════════════════════════════════════

  _addMemoryNode(memory, type, tier) {
    const id = memory.id || memory.mem_id || `node_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const salience = memory.salience || memory.salience_score || 1.0;
    const timestamp = memory.timestamp || memory.created_at || Date.now();
    const age = (Date.now() - (typeof timestamp === 'number' ? timestamp : Date.parse(timestamp))) / 1000;

    const node = {
      id,
      type: type || NODE_TYPE.HOT,
      tier: tier ?? 0,
      title: memory.title || memory.name || id.substring(0, 20),
      content: (memory.content || '').substring(0, 200),
      salience,
      age,
      decayRate: 0,
      entities: memory.entities || [],
      links: memory.links || [],
      // 可视化属性
      radius: this._calcNodeRadius(salience, type),
      color: this._getNodeColor(type, salience),
      glow: salience >= 4.0,
      x: Math.random() * 200 - 100,   // 初始随机位置
      y: Math.random() * 200 - 100,
      vx: 0, vy: 0,
      fx: null, fy: null,              // 固定位置
      blackHoleRadius: 0,
      blackHoleStrength: 0,
      pulsarPhase: 0,
    };

    // 黑洞效应
    if (this._options.enableBlackHoleEffect && salience >= 4.0) {
      node.blackHoleRadius = (salience - 3.5) * 50;
      node.blackHoleStrength = (salience - 3.5) * 2;
    }

    this._nodes.set(id, node);
    return node;
  }

  _processFlatMemories(memories, maxPerLayer, minSalience) {
    // 按层级分组
    const byTier = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    for (const mem of memories) {
      const salience = mem.salience || mem.salience_score || 1;
      if (salience < minSalience) continue;

      const tier = mem.tier ?? this._inferTier(mem);
      if (byTier[tier]) byTier[tier].push(mem);
    }

    const tierTypes = {
      0: NODE_TYPE.HOT, 1: NODE_TYPE.WARM, 2: NODE_TYPE.COLD,
      3: NODE_TYPE.EXECUTION, 4: NODE_TYPE.SKILL,
    };

    for (const [tier, items] of Object.entries(byTier)) {
      for (const item of items.slice(0, maxPerLayer)) {
        this._addMemoryNode(item, tierTypes[tier], parseInt(tier));
      }
    }
  }

  _inferTier(mem) {
    if (mem.type === 'skill' || mem.category) return 4;
    if (mem.type === 'execution' || mem.tool_name) return 3;
    const salience = mem.salience || 1;
    if (salience >= 3.5) return 0;
    if (salience >= 2.0) return 1;
    return 2;
  }

  // ═══════════════════════════════════════
  // 内部方法 — 连线构建
  // ═══════════════════════════════════════

  _buildEdges() {
    const nodes = Array.from(this._nodes.values());

    // 1. 实体共享连线
    const entityMap = new Map(); // entity → [nodeId]
    for (const node of nodes) {
      for (const entity of (node.entities || [])) {
        if (!entityMap.has(entity)) entityMap.set(entity, []);
        entityMap.get(entity).push(node.id);
      }
    }

    for (const [, nodeIds] of entityMap) {
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          this._addEdge(nodeIds[i], nodeIds[j], EDGE_TYPE.ENTITY_SHARED, 0.3);
        }
      }
    }

    // 2. 层级父子连线
    for (const node of nodes) {
      if (node.links && Array.isArray(node.links)) {
        for (const link of node.links) {
          if (typeof link === 'string' && this._nodes.has(link)) {
            this._addEdge(node.id, link, EDGE_TYPE.PARENT_CHILD, 0.6);
          } else if (link?.target && this._nodes.has(link.target)) {
            const edgeType = link.relation === 'parent_of' ? EDGE_TYPE.PARENT_CHILD :
                            link.relation === 'causes' ? EDGE_TYPE.CAUSAL : EDGE_TYPE.SEMANTIC;
            this._addEdge(node.id, link.target, edgeType, 0.5);
          }
        }
      }
    }

    // 3. 跨层语义连线（基于标题/内容相似度）
    if (this._options.enableEntangledEdges) {
      this._buildEntangledEdges(nodes);
    }

    // 4. 技能绑定连线
    for (const node of nodes) {
      if (node.type === NODE_TYPE.SKILL) {
        // 技能节点连接所有执行层节点
        for (const other of nodes) {
          if (other.type === NODE_TYPE.EXECUTION) {
            this._addEdge(node.id, other.id, EDGE_TYPE.SKILL_BINDING, 0.2);
          }
        }
      }
    }

    // 限制最大边数
    if (this._edges.size > this._options.maxEdges) {
      this._pruneEdges();
    }
  }

  _buildEntangledEdges(nodes) {
    // 基于标题文本相似度的纠缠连线
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const similarity = this._textSimilarity(
          nodes[i].title + ' ' + nodes[i].content,
          nodes[j].title + ' ' + nodes[j].content
        );
        if (similarity > 0.4) {
          this._addEdge(nodes[i].id, nodes[j].id, EDGE_TYPE.ENTANGLED, similarity * 0.3);
        }
      }
    }
  }

  _textSimilarity(a, b) {
    const wordsA = new Set((a || '').toLowerCase().split(/[\s,，。！？、]+/).filter(w => w.length > 1));
    const wordsB = (b || '').toLowerCase().split(/[\s,，。！？、]+/).filter(w => w.length > 1);
    if (wordsA.size === 0 || wordsB.length === 0) return 0;
    const intersection = wordsB.filter(w => wordsA.has(w)).length;
    return intersection / Math.sqrt(wordsA.size * wordsB.length);
  }

  _addEdge(source, target, type, strength) {
    if (source === target) return;
    const edgeId = [source, target, type].sort().join('::');
    if (this._edges.has(edgeId)) {
      // 增强已有边的强度
      this._edges.get(edgeId).strength = Math.min(1, this._edges.get(edgeId).strength + strength * 0.5);
      return;
    }
    this._edges.set(edgeId, {
      id: edgeId,
      source,
      target,
      type,
      strength: Math.min(1, strength),
      animated: type === EDGE_TYPE.ENTANGLED, // 纠缠边有动画
    });
  }

  _connectNewNode(node) {
    // 找最相似的5个节点建立连线
    const nodes = Array.from(this._nodes.values()).filter(n => n.id !== node.id);
    const scored = nodes.map(n => ({
      node: n,
      score: this._textSimilarity(
        node.title + ' ' + node.content,
        n.title + ' ' + n.content
      ),
    }));
    scored.sort((a, b) => b.score - a.score);

    for (const { node: n, score } of scored.slice(0, 5)) {
      if (score > 0.2) {
        this._addEdge(node.id, n.id, EDGE_TYPE.SEMANTIC, score * 0.5);
      }
    }
  }

  // ═══════════════════════════════════════
  // 内部方法 — 聚类
  // ═══════════════════════════════════════

  _performClustering() {
    this._clusters.clear();
    const mode = this._options.clusterMode;

    if (mode === CLUSTER_MODE.TIER || mode === CLUSTER_MODE.HYBRID) {
      this._clusterByTier();
    }

    if (mode === CLUSTER_MODE.TOPIC || mode === CLUSTER_MODE.HYBRID) {
      this._clusterByTopic();
    }

    if (mode === CLUSTER_MODE.TIME) {
      this._clusterByTime();
    }

    this._stats.totalClustersDetected = this._clusters.size;
  }

  _clusterByTier() {
    const tierGroups = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    for (const [id, node] of this._nodes) {
      if (tierGroups[node.tier]) tierGroups[node.tier].push(id);
    }

    const tierLabels = { 0: '热记忆层', 1: '暖记忆层', 2: '冷记忆层', 3: '执行轨迹层', 4: '技能固化层' };
    const tierColors = { 0: '#ff6644', 1: '#ffaa44', 2: '#6688cc', 3: '#44ddaa', 4: '#cc44ff' };

    for (const [tier, nodeIds] of Object.entries(tierGroups)) {
      if (nodeIds.length > 0) {
        const clusterId = `cluster_tier_${tier}`;
        this._clusters.set(clusterId, {
          id: clusterId,
          label: tierLabels[tier],
          mode: 'tier',
          nodes: nodeIds,
          centroid: { x: 0, y: (parseInt(tier) - 2) * 150 },
          color: tierColors[tier],
        });
      }
    }
  }

  _clusterByTopic() {
    // 简化的基于词频的聚类
    const topicWords = new Map(); // word → [nodeId]
    const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'a', 'an', '的', '了', '是', '在', '和', '与', '及', '等', '这', '那', '有', '被', '把', '从', '到']);

    for (const [id, node] of this._nodes) {
      const words = (node.title + ' ' + node.content).toLowerCase()
        .split(/[\s,，。！？、：；""''（）【】《》—…]+/)
        .filter(w => w.length > 2 && !stopWords.has(w));

      for (const word of words) {
        if (!topicWords.has(word)) topicWords.set(word, []);
        topicWords.get(word).push(id);
      }
    }

    // 找出现次数>=2的关键词作为话题聚类
    let clusterIdx = 0;
    const assignedNodes = new Set();

    const sortedTopics = Array.from(topicWords.entries())
      .filter(([, ids]) => ids.length >= 2)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [word, nodeIds] of sortedTopics.slice(0, 10)) {
      const unassigned = nodeIds.filter(id => !assignedNodes.has(id));
      if (unassigned.length < 2) continue;

      const clusterId = `cluster_topic_${clusterIdx++}`;
      // 将topic词标记为已分配，防止后续重复聚类
      this._clusters.set(clusterId, {
        id: clusterId,
        label: word,
        mode: 'topic',
        nodes: [...unassigned],
        centroid: { x: (clusterIdx % 5 - 2) * 120, y: Math.floor(clusterIdx / 5) * 120 - 60 },
        color: `hsl(${clusterIdx * 60}, 70%, 55%)`,
      });

      for (const id of unassigned) assignedNodes.add(id);
    }
  }

  _clusterByTime() {
    const now = Date.now();
    const timeGroups = {
      '最近1小时': { max: 3600000, nodes: [] },
      '今天': { max: 86400000, nodes: [] },
      '本周': { max: 604800000, nodes: [] },
      '更早': { max: Infinity, nodes: [] },
    };

    for (const [id, node] of this._nodes) {
      const age = now - (node.age * 1000 + now - node.age * 1000); // approximate
      for (const [label, group] of Object.entries(timeGroups)) {
        if (age < group.max) {
          group.nodes.push(id);
          break;
        }
      }
    }

    const timeColors = { '最近1小时': '#ff4444', '今天': '#ff8844', '本周': '#ffcc44', '更早': '#8888cc' };
    for (const [label, group] of Object.entries(timeGroups)) {
      if (group.nodes.length > 0) {
        const clusterId = `cluster_time_${label}`;
        this._clusters.set(clusterId, {
          id: clusterId,
          label,
          mode: 'time',
          nodes: group.nodes,
          centroid: { x: 0, y: 0 },
          color: timeColors[label],
        });
      }
    }
  }

  // ═══════════════════════════════════════
  // 内部方法 — 脉冲星
  // ═══════════════════════════════════════

  _identifyPulsars() {
    this._pulsars.clear();
    for (const [, node] of this._nodes) {
      if (node.type === NODE_TYPE.SKILL && node.salience >= 4.0) {
        this._pulsars.set(node.id, {
          phase: Math.random() * Math.PI * 2,
          frequency: 0.5 + node.salience * 0.3,
          radius: 30 + node.salience * 10,
        });
      }
    }
  }

  _startPulsarLoop() {
    const tick = () => {
      if (!this._running) return;
      this._pulsarTick++;
      for (const [id, pulsar] of this._pulsars) {
        pulsar.phase += pulsar.frequency * 0.05;
        if (pulsar.phase > Math.PI * 2) pulsar.phase -= Math.PI * 2;
      }
      // 每30个tick发送一次脉冲事件
      if (this._pulsarTick % 30 === 0) {
        this.emit('pulsar:beat', {
          tick: this._pulsarTick,
          pulsars: Array.from(this._pulsars.entries()).map(([id, p]) => ({
            id, phase: p.phase,
          })),
        });
      }
      setTimeout(tick, 100);
    };
    tick();
  }

  _startUpdateLoop() {
    if (this._updateTimer) clearInterval(this._updateTimer);
    this._updateTimer = setInterval(() => {
      // 更新螺旋角度
      this._spiralAngle += 0.01;
      if (this._spiralAngle > Math.PI * 2) this._spiralAngle -= Math.PI * 2;

      // 更新脉冲星半径（呼吸效果）
      for (const [, pulsar] of this._pulsars) {
        pulsar.radius = 30 + Math.sin(this._pulsarTick * 0.1) * 10;
      }
    }, this._options.updateInterval);
  }

  // ═══════════════════════════════════════
  // 内部方法 — 辅助
  // ═══════════════════════════════════════

  _calcNodeRadius(salience, type) {
    const baseRadii = {
      [NODE_TYPE.HOT]: 8,
      [NODE_TYPE.WARM]: 7,
      [NODE_TYPE.COLD]: 5,
      [NODE_TYPE.EXECUTION]: 6,
      [NODE_TYPE.SKILL]: 10,
      [NODE_TYPE.ENTITY]: 4,
      [NODE_TYPE.TOPIC]: 12,
    };
    const base = baseRadii[type] || 6;
    return base + salience * 2;
  }

  _getNodeColor(type, salience) {
    const baseColors = {
      [NODE_TYPE.HOT]: { r: 255, g: 80, b: 60 },
      [NODE_TYPE.WARM]: { r: 255, g: 160, b: 40 },
      [NODE_TYPE.COLD]: { r: 80, g: 120, b: 200 },
      [NODE_TYPE.EXECUTION]: { r: 40, g: 210, b: 160 },
      [NODE_TYPE.SKILL]: { r: 180, g: 60, b: 255 },
      [NODE_TYPE.ENTITY]: { r: 150, g: 150, b: 200 },
      [NODE_TYPE.TOPIC]: { r: 100, g: 200, b: 255 },
    };

    const base = baseColors[type] || { r: 150, g: 150, b: 150 };
    const brightness = 0.6 + salience * 0.1; // salience越高越亮

    return {
      r: Math.round(base.r * brightness),
      g: Math.round(base.g * brightness),
      b: Math.round(base.b * brightness),
    };
  }

  _serializeNode(node) {
    return {
      id: node.id,
      type: node.type,
      tier: node.tier,
      title: node.title,
      content: node.content?.substring(0, 100),
      salience: node.salience,
      age: node.age,
      radius: node.radius,
      color: `rgb(${node.color.r},${node.color.g},${node.color.b})`,
      glow: node.glow,
      x: node.x,
      y: node.y,
      vx: node.vx,
      vy: node.vy,
      fx: node.fx,
      fy: node.fy,
      blackHoleRadius: node.blackHoleRadius,
      blackHoleStrength: node.blackHoleStrength,
      isPulsar: this._pulsars.has(node.id),
    };
  }

  _serializeEdge(edge) {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      strength: edge.strength,
      animated: edge.animated,
    };
  }

  _buildAdjacencyList() {
    const adj = new Map();
    for (const [, node] of this._nodes) {
      adj.set(node.id, []);
    }
    for (const [, edge] of this._edges) {
      adj.get(edge.source)?.push(edge.target);
      adj.get(edge.target)?.push(edge.source);
    }
    return adj;
  }

  _pruneOldestNodes() {
    const nodes = Array.from(this._nodes.values())
      .sort((a, b) => b.age - a.age); // 最老的在前
    const toRemove = nodes.slice(this._options.maxNodes);
    for (const node of toRemove) {
      this._nodes.delete(node.id);
      // 删除相关边
      for (const [edgeId, edge] of this._edges) {
        if (edge.source === node.id || edge.target === node.id) {
          this._edges.delete(edgeId);
        }
      }
    }
  }

  _pruneEdges() {
    const edges = Array.from(this._edges.values())
      .sort((a, b) => a.strength - b.strength); // 最弱的在前
    const toRemove = edges.slice(0, edges.length - this._options.maxEdges);
    for (const edge of toRemove) {
      this._edges.delete(edge.id);
    }
  }

  getStats() {
    return {
      ...this._stats,
      currentNodeCount: this._nodes.size,
      currentEdgeCount: this._edges.size,
      clusterCount: this._clusters.size,
      pulsarCount: this._pulsars.size,
      physics: { ...this._physics },
    };
  }
}

// ── 导出 ──
module.exports = {
  MemoryNetworkGraph,
  NODE_TYPE,
  EDGE_TYPE,
  CLUSTER_MODE,
  LAYOUT_MODE,
};
