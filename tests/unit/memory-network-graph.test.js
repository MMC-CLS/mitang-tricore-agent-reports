/**
 * 记忆网络图模块测试
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

describe('MemoryNetworkGraph', () => {
  let graph;

  beforeEach(() => {
    const { MemoryNetworkGraph } = require('../../src/subagent/memory-network-graph');
    graph = new MemoryNetworkGraph({
      maxNodes: 50,
      maxEdges: 100,
      clusterMode: 'hybrid',
      layoutMode: 'force',
      enablePulsarEffect: true,
      enableEntangledEdges: true,
      enableBlackHoleEffect: true,
    });
    graph.start();
  });

  afterEach(() => {
    graph.stop();
  });

  // ── 图构建 ──
  describe('图构建', () => {
    it('应从分层记忆数据构建图', () => {
      const memoryData = {
        layers: {
          hot: [
            { id: 'm1', title: '对话记忆1', content: '用户询问数据分析', salience: 4.5, entities: ['data'] },
            { id: 'm2', title: '对话记忆2', content: 'AI回复数据清洗方法', salience: 3.8, entities: ['data', '清洗'] },
          ],
          warm: [
            { id: 'm3', title: '近期记忆', content: '上周完成了报表', salience: 2.5, entities: ['报表'] },
          ],
          cold: [],
          exec: [
            { id: 'm4', title: '执行记录', content: '运行了sales_analysis.py', salience: 1.5, entities: ['script'] },
          ],
          skill: [
            { id: 'm5', title: '数据分析技能', content: '数据分析SOP', salience: 4.8, entities: ['data', 'analysis'] },
          ],
        },
      };

      const data = graph.buildFromMemory(memoryData);
      assert.ok(Array.isArray(data.nodes));
      assert.ok(Array.isArray(data.edges));
      assert.ok(data.nodes.length >= 5);
    });

    it('应从扁平记忆列表构建图', () => {
      const memories = [
        { id: 'm1', title: '记忆A', content: '内容A', salience: 4.0, tier: 0, entities: ['topic_a'] },
        { id: 'm2', title: '记忆B', content: '内容B', salience: 2.0, tier: 1, entities: ['topic_a'] },
        { id: 'm3', title: '记忆C', content: '内容C', salience: 1.0, tier: 2, entities: ['topic_b'] },
      ];

      const data = graph.buildFromMemory({ memories });
      assert.strictEqual(data.nodes.length, 3);
      assert.ok(data.edges.length > 0); // 共享实体产生连线
    });

    it('应过滤低salience记忆', () => {
      const memories = [
        { id: 'm1', title: '重要', salience: 4.0, tier: 0 },
        { id: 'm2', title: '不重要', salience: 0.05, tier: 2 },
      ];

      const data = graph.buildFromMemory({ memories }, { minSalience: 0.1 });
      assert.strictEqual(data.nodes.length, 1);
    });
  });

  // ── 节点操作 ──
  describe('节点操作', () => {
    it('应正确添加节点', () => {
      const node = graph.addNode(
        { id: 'new1', title: '新记忆', content: '测试内容', salience: 3.0 },
        'hot', 0
      );
      assert.ok(node);
      assert.strictEqual(node.type, 'hot');
      assert.strictEqual(node.tier, 0);
      assert.ok(node.radius > 0);
    });

    it('应更新salience', () => {
      graph.buildFromMemory({
        layers: {
          hot: [{ id: 'm1', title: '测试', content: '内容', salience: 3.0 }],
          warm: [], cold: [], exec: [], skill: [],
        },
      });

      graph.updateSalience('m1', 4.5);
      const detail = graph.getNodeDetail('m1');
      assert.ok(detail);
      assert.strictEqual(detail.salience, 4.5);
      assert.ok(detail.blackHoleRadius > 0); // 高salience触发黑洞效应
    });
  });

  // ── 查询接口 ──
  describe('查询接口', () => {
    beforeEach(() => {
      graph.buildFromMemory({
        layers: {
          hot: [
            { id: 'm1', title: '数据分析入门', content: 'Pandas基础教程', salience: 4.0, entities: ['data', 'pandas'] },
            { id: 'm2', title: '机器学习指南', content: 'Scikit-learn使用', salience: 3.5, entities: ['ml', 'scikit'] },
          ],
          warm: [
            { id: 'm3', title: '数据可视化', content: 'Matplotlib图表', salience: 2.5, entities: ['data', 'viz'] },
          ],
          cold: [], exec: [], skill: [],
        },
      });
    });

    it('应返回节点详情', () => {
      const detail = graph.getNodeDetail('m1');
      assert.ok(detail);
      assert.strictEqual(detail.title, '数据分析入门');
      assert.ok(detail.connections);
    });

    it('应搜索节点', () => {
      const results = graph.searchNodes('数据分析');
      assert.ok(results.length >= 1);
      assert.ok(results.some(r => r.title === '数据分析入门'));
    });

    it('应搜索内容', () => {
      const results = graph.searchNodes('Pandas');
      assert.ok(results.length >= 1);
    });

    it('应查找路径', () => {
      const path = graph.findPath('m1', 'm3');
      assert.ok(Array.isArray(path));
      assert.ok(path.length >= 2); // m1和m3通过共享实体'data'关联
    });

    it('不存在的节点路径应返回null', () => {
      const path = graph.findPath('m1', 'nonexistent');
      assert.strictEqual(path, null);
    });
  });

  // ── 聚类 ──
  describe('聚类', () => {
    beforeEach(() => {
      graph.buildFromMemory({
        layers: {
          hot: [
            { id: 'h1', title: 'Python 数据分析', content: '数据分析', salience: 4.0, entities: ['python', 'data'] },
            { id: 'h2', title: 'Python 机器学习', content: '机器学习', salience: 3.5, entities: ['python', 'ml'] },
            { id: 'h3', title: '前端开发', content: 'React 教程', salience: 3.0, entities: ['react', 'frontend'] },
          ],
          warm: [
            { id: 'w1', title: '后端架构', content: 'Node.js 设计', salience: 2.5, entities: ['node', 'backend'] },
          ],
          cold: [], exec: [], skill: [],
        },
      });
    });

    it('应执行混合聚类', () => {
      const data = graph.getGraphData();
      assert.ok(data.clusters.length > 0);
    });

    it('应包含层级聚类', () => {
      graph.setClusterMode('tier');
      const data = graph.getGraphData();
      assert.ok(data.clusters.length > 0);
      const tierCluster = data.clusters.find(c => c.mode === 'tier');
      assert.ok(tierCluster);
    });

    it('应包含话题聚类', () => {
      graph.setClusterMode('topic');
      const data = graph.getGraphData();
      // 话题聚类至少存在一个集群（python会匹配两个节点）
      assert.ok(data.clusters.length > 0, '话题聚类应有至少一个集群');
    });

    it('应能切换聚类模式', () => {
      graph.setClusterMode('topic');
      graph.setClusterMode('tier');
      graph.setClusterMode('hybrid');
      const stats = graph.getStats();
      assert.ok(stats, 'getStats应返回统计信息');
    });
  });

  // ── 脉冲星 ──
  describe('脉冲星效果', () => {
    it('高salience技能节点应被标记为脉冲星', () => {
      graph.buildFromMemory({
        layers: {
          hot: [], warm: [], cold: [], exec: [],
          skill: [
            { id: 's1', title: '核心技能', content: '重要SOP', salience: 4.5, entities: [] },
          ],
        },
      });

      const data = graph.getGraphData();
      assert.ok(data.pulsars.length >= 1);
    });
  });

  // ── 物理参数 ──
  describe('物理参数控制', () => {
    it('应正确设置物理参数', () => {
      graph.setPhysics({ gravity: 2.0, repulsion: 3.0, linkStrength: 0.8 });
      const stats = graph.getStats();
      assert.strictEqual(stats.physics.gravity, 2.0);
      assert.strictEqual(stats.physics.repulsion, 3.0);
      assert.strictEqual(stats.physics.linkStrength, 0.8);
    });

    it('应限制参数范围', () => {
      graph.setPhysics({ gravity: 10, repulsion: -1 });
      const stats = graph.getStats();
      assert.ok(stats.physics.gravity <= 5);
      assert.ok(stats.physics.repulsion >= 0);
    });
  });

  // ── 布局模式 ──
  describe('布局模式', () => {
    it('应支持切换布局模式', () => {
      const layouts = ['force', 'spiral', 'radial', 'constellation'];
      for (const layout of layouts) {
        graph.setLayoutMode(layout);
        // 不应抛异常
      }
    });

    it('无效布局模式应被忽略', () => {
      graph.setLayoutMode('invalid');
      const stats = graph.getStats();
      assert.ok(stats, '设置无效布局模式后getStats仍应返回');
      assert.ok(stats.layoutMode !== 'invalid', 'layoutMode不应变为invalid');
    });
  });

  // ── 选择与高亮 ──
  describe('选择与高亮', () => {
    beforeEach(() => {
      graph.buildFromMemory({
        layers: {
          hot: [
            { id: 's1', title: '节点A', content: '内容A', salience: 4.0, entities: ['shared'] },
            { id: 's2', title: '节点B', content: '内容B', salience: 3.0, entities: ['shared'] },
            { id: 's3', title: '节点C', content: '内容C', salience: 2.0, entities: ['other'] },
          ],
          warm: [], cold: [], exec: [], skill: [],
        },
      });
    });

    it('选择节点应高亮关联节点和边', (t, done) => {
      graph.on('selection:changed', (data) => {
        assert.ok(data.selectedNode);
        assert.ok(data.highlightedNodes.length > 1); // 包含关联节点
        done();
      });
      graph.selectNode('s1');
    });

    it('清除选择应清空高亮', () => {
      graph.selectNode('s1');
      graph.clearSelection();
      // 验证事件监听器已注册
      let cleared = false;
      graph.on('selection:cleared', () => { cleared = true; });
      graph.clearSelection();
      assert.ok(cleared, 'selection:cleared事件应被触发');
    });
  });

  // ── 统计 ──
  describe('统计', () => {
    it('应返回正确的统计信息', () => {
      graph.buildFromMemory({
        layers: {
          hot: [{ id: 'm1', title: 't', content: 'c', salience: 3.0 }],
          warm: [], cold: [], exec: [], skill: [],
        },
      });

      const stats = graph.getStats();
      assert.ok(stats.currentNodeCount > 0);
      assert.ok(stats.buildTime > 0);
      assert.ok(stats.lastUpdate);
    });
  });

  // ── 事件 ──
  describe('事件系统', () => {
    it('应在构建图后触发事件', (t, done) => {
      graph.on('graph:built', (data) => {
        assert.ok(data.nodeCount > 0);
        done();
      });
      graph.buildFromMemory({
        layers: {
          hot: [{ id: 'e1', title: 'test', content: 'test', salience: 3.0 }],
          warm: [], cold: [], exec: [], skill: [],
        },
      });
    });

    it('应触发物理参数变更事件', (t, done) => {
      graph.on('physics:changed', (data) => {
        assert.ok(data.gravity !== undefined);
        done();
      });
      graph.setPhysics({ gravity: 1.5 });
    });
  });
});
