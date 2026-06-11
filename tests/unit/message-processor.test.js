/**
 * 消息处理器模块测试
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// 模拟依赖
const mockEventEmitter = function () {
  const events = {};
  return {
    on: (evt, cb) => { if (!events[evt]) events[evt] = []; events[evt].push(cb); },
    emit: (evt, data) => { (events[evt] || []).forEach(cb => cb(data)); },
    events,
  };
};

// 简化版MessageProcessor（测试用）
describe('MessageProcessor', () => {
  let processor;

  beforeEach(() => {
    // 直接require实际模块（依赖仅EventEmitter）
    const { MessageProcessor } = require('../../src/subagent/message-processor');
    processor = new MessageProcessor({
      enableAffectTracking: true,
      enableQuantumMarking: true,
      enableDAGTracing: true,
    });
    processor.start();
  });

  afterEach(() => {
    processor.stop();
  });

  // ── 基础功能 ──
  describe('消息接收', () => {
    it('应正确接收消息并返回msgId', () => {
      const msgId = processor.receive('user_1', '你好，帮我分析数据', 'direct');
      assert.ok(msgId);
      assert.match(msgId, /^msg_\d+_/);
    });

    it('应增加消息计数', () => {
      processor.receive('user_1', '测试消息1', 'direct');
      processor.receive('user_2', '测试消息2', 'direct');
      const stats = processor.getStats();
      assert.strictEqual(stats.totalReceived, 2);
    });

    it('应正确设置优先级', () => {
      const msgId = processor.receive('user_1', '紧急消息!!!', 'direct', { urgent: true });
      const pipeline = processor.getPipeline(msgId);
      assert.ok(pipeline);
      assert.strictEqual(pipeline.priority, 200); // CRITICAL
    });

    it('系统消息应有较低优先级', () => {
      const msgId = processor.receive('system', '定时提醒', 'system');
      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.priority, 50);
    });
  });

  // ── 消息分析 ──
  describe('消息分析', () => {
    it('应正确检测问题意图', () => {
      const msgId = processor.receive('user_1', '为什么天空是蓝色的？');
      processor.analyze(msgId);
      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.analysis.intent, 'question');
    });

    it('应正确检测命令意图', () => {
      const msgId = processor.receive('user_1', '请帮我创建一个数据分析报告');
      processor.analyze(msgId);
      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.analysis.intent, 'command');
    });

    it('应提取URL实体', () => {
      const msgId = processor.receive('user_1', '请查看 https://example.com/data.csv');
      processor.analyze(msgId);
      const pipeline = processor.getPipeline(msgId);
      assert.ok(pipeline.analysis.entities.includes('https://example.com/data.csv'));
    });

    it('应分析复杂度', () => {
      const msgId = processor.receive('user_1', '分析');
      processor.analyze(msgId);
      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.analysis.complexity.level, 'low');
    });

    it('应检测中文语言', () => {
      const msgId = processor.receive('user_1', '你好世界，这是中文测试');
      processor.analyze(msgId);
      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.analysis.language, 'zh');
    });

    it('应估计情感向量', () => {
      const msgId = processor.receive('user_1', '太棒了！这个功能非常好用！');
      processor.analyze(msgId);
      const pipeline = processor.getPipeline(msgId);
      assert.ok(Array.isArray(pipeline.analysis.affect));
      assert.strictEqual(pipeline.analysis.affect.length, 6);
      assert.ok(pipeline.analysis.affect[0] > 0.5); // valence > 0.5 (正面)
    });
  });

  // ── 消息路由 ──
  describe('消息路由', () => {
    it('问题应路由到意识核', () => {
      const msgId = processor.receive('user_1', '什么是机器学习？');
      processor.analyze(msgId);
      processor.route(msgId);
      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.route.target, 'consciousness');
    });

    it('命令应路由到执行核', () => {
      const msgId = processor.receive('user_1', '运行数据分析脚本');
      processor.analyze(msgId);
      processor.route(msgId);
      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.route.target, 'execution');
    });
  });

  // ── 消息完成 ──
  describe('消息完成', () => {
    it('应正确标记完成状态', () => {
      const msgId = processor.receive('user_1', 'hello');
      processor.analyze(msgId);
      processor.route(msgId);
      processor.complete(msgId, { reply: 'Hi!' });

      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.state, 'complete');
      assert.ok(pipeline.completedAt);
    });

    it('应塌缩量子态', () => {
      const msgId = processor.receive('user_1', 'hello');
      processor.analyze(msgId);
      processor.complete(msgId);

      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.quantumState, 'collapsed');
    });
  });

  // ── 中断处理 ──
  describe('消息中断', () => {
    it('应正确标记中断状态', () => {
      const msgId = processor.receive('user_1', '处理中...');
      processor.analyze(msgId);
      processor.interrupt(msgId, '更高优先级消息到达');

      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.state, 'interrupted');
      assert.strictEqual(pipeline.interruptReason, '更高优先级消息到达');
    });

    it('应统计中断次数', () => {
      const msgId = processor.receive('user_1', 'msg1');
      processor.analyze(msgId);
      processor.interrupt(msgId);

      const stats = processor.getStats();
      assert.strictEqual(stats.totalInterrupted, 1);
    });
  });

  // ── 量子态标记 ──
  describe('量子态标记', () => {
    it('单条消息应为叠加态', () => {
      const msgId = processor.receive('user_1', '独立消息');
      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.quantumState, 'superposed');
    });

    it('连续相关消息应标记为纠缠态', () => {
      processor.receive('user_1', '关于数据分析的问题', 'direct');
      processor.receive('user_1', '数据分析中如何进行数据清洗？', 'direct');
      const msgId = processor.receive('user_1', '数据分析的可视化怎么做？', 'direct');

      const pipeline = processor.getPipeline(msgId);
      assert.strictEqual(pipeline.quantumState, 'entangled');
    });
  });

  // ── 活跃管道查询 ──
  describe('活跃管道查询', () => {
    it('应返回未完成的管道', () => {
      processor.receive('user_1', 'msg1');
      processor.receive('user_2', 'msg2');

      const active = processor.getActivePipelines();
      assert.strictEqual(active.length, 2);
    });

    it('完成的管道不应在活跃列表中', () => {
      const msgId = processor.receive('user_1', 'done');
      processor.analyze(msgId);
      processor.route(msgId);
      processor.complete(msgId);

      const active = processor.getActivePipelines();
      assert.strictEqual(active.length, 0);
    });

    it('应按优先级排序', () => {
      processor.receive('user_1', '普通消息');
      processor.receive('user_2', '紧急消息', 'direct', { urgent: true });

      const active = processor.getActivePipelines();
      assert.ok(active.length >= 2);
      assert.ok(active[0].priority >= active[1].priority);
    });
  });

  // ── 实体图 ──
  describe('实体图', () => {
    it('应构建实体共现图', () => {
      const msgId1 = processor.receive('user_1', '分析 https://a.com 和 https://b.com');
      const msgId2 = processor.receive('user_1', '对比 https://a.com 和 https://c.com');
      processor.analyze(msgId1);
      processor.analyze(msgId2);

      const graph = processor.getEntityGraph();
      assert.ok(Array.isArray(graph.nodes));
      assert.ok(Array.isArray(graph.edges));
      assert.ok(graph.nodes.length >= 3); // 至少3个URL
    });
  });

  // ── DAG数据 ──
  describe('DAG追踪', () => {
    it('应返回DAG数据', () => {
      processor.receive('user_1', 'msg1');
      processor.receive('user_1', 'msg2');

      const dag = processor.getDAGData();
      assert.ok(Array.isArray(dag.nodes));
      assert.ok(Array.isArray(dag.edges));
      assert.ok(dag.nodes.length >= 2);
    });
  });

  // ── 历史摘要 ──
  describe('历史摘要', () => {
    it('应返回最近的消息摘要', () => {
      for (let i = 0; i < 5; i++) {
        processor.receive('user_1', `消息${i}`);
      }

      const summary = processor.getRecentSummary(3);
      assert.strictEqual(summary.length, 3);
    });
  });

  // ── 清理 ──
  describe('清理', () => {
    it('应清理过期的已完成管道', () => {
      const msgId = processor.receive('user_1', 'old');
      processor.analyze(msgId);
      processor.complete(msgId);

      // 模拟时间推移 — 直接操纵
      const pipeline = processor.getPipeline(msgId);
      pipeline.completedAt = Date.now() - 7200000; // 2小时前

      const cleaned = processor.cleanup(3600000); // 1小时过期
      assert.ok(cleaned >= 1);
    });
  });

  // ── 事件 ──
  describe('事件系统', () => {
    it('应触发消息接收事件', (t, done) => {
      processor.on('message:received', (data) => {
        assert.ok(data.msgId);
        assert.strictEqual(data.from, 'user_test');
        done();
      });
      processor.receive('user_test', 'test');
    });

    it('应触发消息分析事件', (t, done) => {
      processor.on('message:analyzed', (data) => {
        assert.ok(data.intent);
        done();
      });
      const msgId = processor.receive('user_test', '这是什么？');
      processor.analyze(msgId);
    });

    it('应触发消息完成事件', (t, done) => {
      processor.on('message:completed', (data) => {
        assert.ok(data.processingTime !== undefined);
        done();
      });
      const msgId = processor.receive('user_test', 'done');
      processor.analyze(msgId);
      processor.complete(msgId);
    });
  });
});
