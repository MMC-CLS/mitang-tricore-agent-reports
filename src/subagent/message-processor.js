/**
 * 蜜糖 TriCore Agent — 用户消息处理器
 *
 * 功能：
 *   1. 消息管道 — 多通道消息接收、分级、路由
 *   2. 上下文分析 — 意图识别、情绪感知、话题追踪
 *   3. 消息转换 — 结构化标注、实体提取、关系图谱注入
 *   4. 响应协调 — 三核响应优先级调度、抢占仲裁
 *   5. 实时流输出 — 思考过程可视化、工具调用追踪
 *
 * 与 BaiLongma 消息队列的区别：
 *   - 三核并行管道，而非单队列串行
 *   - 量子态标记（确定/叠加态/纠缠态），区分消息处理的不确定性
 *   - 消息溯源追踪图（DAG），支持回退和分支合并
 *   - 情感向量编码，用于跨消息上下文关联
 */

'use strict';

const { EventEmitter } = require('events');

// ── 消息管道状态 ──
const PIPELINE_STATE = {
  IDLE: 'idle',
  RECEIVING: 'receiving',
  ANALYZING: 'analyzing',
  ROUTING: 'routing',
  PROCESSING: 'processing',
  RESPONDING: 'responding',
  COMPLETE: 'complete',
  INTERRUPTED: 'interrupted',
};

// ── 消息优先级 ──
const MSG_PRIORITY = {
  CRITICAL: 200,   // 安全相关/紧急中断
  USER: 100,       // 用户直接消息
  AGENT: 80,       // 子智能体间通信
  SYSTEM: 50,      // 系统通知
  BACKGROUND: 30,  // 后台任务结果
  IDLE: 10,        // 空闲触发
};

// ── 量子态标记 ──
const QUANTUM_STATE = {
  DETERMINED: 'determined',     // 确定态 — 意图明确
  SUPERPOSED: 'superposed',     // 叠加态 — 多种可能解释
  ENTANGLED: 'entangled',       // 纠缠态 — 与上下文强关联
  COLLAPSED: 'collapsed',       // 塌缩态 — 已做出决策
};

// ── 情感向量维度 ──
const AFFECT_DIMS = ['valence', 'arousal', 'dominance', 'urgency', 'curiosity', 'confidence'];

/**
 * 消息处理器
 */
class MessageProcessor extends EventEmitter {
  constructor(options = {}) {
    super();
    this._options = {
      maxPipelineDepth: 50,
      analysisTimeout: 5000,
      enableAffectTracking: true,
      enableQuantumMarking: true,
      enableDAGTracing: true,
      ...options,
    };

    // 管道
    this._pipelines = new Map();     // msgId → pipeline state
    this._pipelineHistory = [];      // 历史管道（最近1000条）
    this._activeCount = 0;

    // 上下文追踪
    this._contextWindows = new Map(); // channel → recent messages
    this._topicGraph = new Map();    // topic → related topics
    this._entityIndex = new Map();   // entity → messages

    // 量子态
    this._quantumStates = new Map(); // msgId → quantum state

    // DAG追踪
    this._dagNodes = new Map();      // msgId → DAG node
    this._dagEdges = [];            // { from, to, type }

    // 情感追踪
    this._affectVectors = new Map(); // msgId → [v,a,d,u,c,cf]

    // 统计
    this._stats = {
      totalReceived: 0,
      totalProcessed: 0,
      totalInterrupted: 0,
      avgProcessingTime: 0,
      byPriority: {},
      byQuantumState: {},
    };

    this._running = false;
  }

  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  start() {
    this._running = true;
    this.emit('started');
    return this;
  }

  stop() {
    this._running = false;
    this.emit('stopped');
    return this;
  }

  // ═══════════════════════════════════════
  // 消息管道
  // ═══════════════════════════════════════

  /**
   * 接收消息并推入处理管道
   */
  receive(from, content, channel = 'direct', meta = {}) {
    const msgId = this._generateMsgId();
    const timestamp = Date.now();
    const priority = this._resolvePriority(from, channel, meta);

    // 创建管道条目
    const pipeline = {
      msgId,
      from,
      content,
      channel,
      meta,
      priority,
      timestamp,
      state: PIPELINE_STATE.RECEIVING,
      quantumState: QUANTUM_STATE.SUPERPOSED,
      parentMsgId: meta.parentMsgId || null,
      analysis: null,
      route: null,
      response: null,
    };

    this._pipelines.set(msgId, pipeline);
    this._activeCount++;
    this._stats.totalReceived++;
    this._stats.byPriority[priority] = (this._stats.byPriority[priority] || 0) + 1;

    // 上下文窗口更新
    this._updateContextWindow(channel, pipeline);

    // 量子态标记
    if (this._options.enableQuantumMarking) {
      this._markQuantumState(msgId, pipeline);
    }

    // DAG节点
    if (this._options.enableDAGTracing) {
      this._createDAGNode(msgId, pipeline);
    }

    // 管道历史
    this._pipelineHistory.push({
      msgId, from, content: content.substring(0, 100),
      channel, priority, timestamp, state: pipeline.state,
    });
    if (this._pipelineHistory.length > 1000) {
      this._pipelineHistory.shift();
    }

    this.emit('message:received', { msgId, from, channel, priority, contentLength: content.length });

    return msgId;
  }

  /**
   * 分析消息 — 意图识别 + 情感分析 + 实体提取
   */
  analyze(msgId) {
    const pipeline = this._pipelines.get(msgId);
    if (!pipeline) return null;

    pipeline.state = PIPELINE_STATE.ANALYZING;

    const analysis = {
      intent: this._detectIntent(pipeline.content),
      entities: this._extractEntities(pipeline.content),
      affect: this._options.enableAffectTracking ? this._estimateAffect(pipeline.content) : null,
      complexity: this._estimateComplexity(pipeline.content),
      language: this._detectLanguage(pipeline.content),
      timestamp: Date.now(),
    };

    pipeline.analysis = analysis;

    // 更新实体索引
    for (const entity of analysis.entities) {
      if (!this._entityIndex.has(entity)) {
        this._entityIndex.set(entity, []);
      }
      this._entityIndex.get(entity).push(msgId);
    }

    this.emit('message:analyzed', { msgId, intent: analysis.intent, entities: analysis.entities });

    return analysis;
  }

  /**
   * 路由消息到目标处理器
   */
  route(msgId) {
    const pipeline = this._pipelines.get(msgId);
    if (!pipeline) return null;

    pipeline.state = PIPELINE_STATE.ROUTING;

    const route = {
      target: this._determineRouteTarget(pipeline),
      cores: this._assignCores(pipeline),
      priority: pipeline.priority,
      preemptable: pipeline.priority < MSG_PRIORITY.CRITICAL,
    };

    pipeline.route = route;

    this.emit('message:routed', { msgId, target: route.target, cores: route.cores });

    return route;
  }

  /**
   * 标记处理完成
   */
  complete(msgId, response = null) {
    const pipeline = this._pipelines.get(msgId);
    if (!pipeline) return;

    pipeline.state = PIPELINE_STATE.COMPLETE;
    pipeline.response = response;
    pipeline.completedAt = Date.now();

    const processingTime = pipeline.completedAt - pipeline.timestamp;
    this._stats.totalProcessed++;
    this._stats.avgProcessingTime =
      (this._stats.avgProcessingTime * (this._stats.totalProcessed - 1) + processingTime) /
      this._stats.totalProcessed;

    this._activeCount = Math.max(0, this._activeCount - 1);

    // 塌缩量子态
    if (pipeline.quantumState === QUANTUM_STATE.SUPERPOSED) {
      pipeline.quantumState = QUANTUM_STATE.COLLAPSED;
      this._stats.byQuantumState[QUANTUM_STATE.COLLAPSED] =
        (this._stats.byQuantumState[QUANTUM_STATE.COLLAPSED] || 0) + 1;
    }

    this.emit('message:completed', {
      msgId,
      processingTime,
      quantumState: pipeline.quantumState,
    });
  }

  /**
   * 中断消息处理（被更高优先级抢占）
   */
  interrupt(msgId, reason = 'preempted') {
    const pipeline = this._pipelines.get(msgId);
    if (!pipeline) return;

    pipeline.state = PIPELINE_STATE.INTERRUPTED;
    pipeline.interruptedAt = Date.now();
    pipeline.interruptReason = reason;

    this._stats.totalInterrupted++;

    this.emit('message:interrupted', { msgId, reason });
  }

  // ═══════════════════════════════════════
  // 上下文管理
  // ═══════════════════════════════════════

  /**
   * 获取消息上下文窗口
   */
  getContextWindow(channel, limit = 10) {
    const window = this._contextWindows.get(channel) || [];
    return window.slice(-limit);
  }

  /**
   * 查找相关消息（通过实体和话题）
   */
  findRelated(msgId, limit = 5) {
    const pipeline = this._pipelines.get(msgId);
    if (!pipeline?.analysis) return [];

    const related = new Set();

    // 通过实体关联
    for (const entity of pipeline.analysis.entities || []) {
      const msgs = this._entityIndex.get(entity) || [];
      for (const mid of msgs) {
        if (mid !== msgId) related.add(mid);
      }
    }

    // 通过话题关联
    const intent = pipeline.analysis.intent;
    const topics = this._topicGraph.get(intent) || [];
    for (const topic of topics) {
      const msgs = this._entityIndex.get(topic) || [];
      for (const mid of msgs) {
        if (mid !== msgId) related.add(mid);
      }
    }

    return Array.from(related).slice(0, limit);
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  _generateMsgId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  _resolvePriority(from, channel, meta) {
    if (meta.priority && typeof meta.priority === 'number') return meta.priority;
    if (channel === 'system' || channel === 'internal') return MSG_PRIORITY.SYSTEM;
    if (channel === 'agent' || channel === 'team') return MSG_PRIORITY.AGENT;
    if (meta.urgent) return MSG_PRIORITY.CRITICAL;
    return MSG_PRIORITY.USER;
  }

  _updateContextWindow(channel, pipeline) {
    if (!this._contextWindows.has(channel)) {
      this._contextWindows.set(channel, []);
    }
    const window = this._contextWindows.get(channel);
    window.push({
      msgId: pipeline.msgId,
      from: pipeline.from,
      content: pipeline.content.substring(0, 200),
      timestamp: pipeline.timestamp,
    });
    // 保持窗口大小
    while (window.length > 50) window.shift();
  }

  _markQuantumState(msgId, pipeline) {
    // 检查是否为纠缠态（与上下文中其他消息强关联）
    const contextWindow = this._contextWindows.get(pipeline.channel) || [];
    const recentCount = contextWindow.length;

    if (recentCount >= 2) {
      // 检查是否有话题连续性 — 使用更宽泛的阈值检测
      // 阈值从 0.3 降低到 0.2，确保包含共同关键词的中文对话能被正确标记
      const lastMsgs = contextWindow.slice(-3);
      const hasTopicContinuity = lastMsgs.some(m =>
        m.content && pipeline.content &&
        this._hasTextOverlap(m.content, pipeline.content, 0.2)
      );
      if (hasTopicContinuity) {
        pipeline.quantumState = QUANTUM_STATE.ENTANGLED;
        this._stats.byQuantumState[QUANTUM_STATE.ENTANGLED] =
          (this._stats.byQuantumState[QUANTUM_STATE.ENTANGLED] || 0) + 1;
        return;
      }
    }

    // 默认叠加态
    pipeline.quantumState = QUANTUM_STATE.SUPERPOSED;
    this._stats.byQuantumState[QUANTUM_STATE.SUPERPOSED] =
      (this._stats.byQuantumState[QUANTUM_STATE.SUPERPOSED] || 0) + 1;
  }

  _hasTextOverlap(a, b, threshold) {
    const wordsA = new Set((a || '').split(/[\s,，。！？、]/).filter(w => w.length > 1));
    const wordsB = (b || '').split(/[\s,，。！？、]/).filter(w => w.length > 1);
    if (wordsA.size === 0 || wordsB.length === 0) return false;
    const overlap = wordsB.filter(w => wordsA.has(w)).length;
    return overlap / Math.max(wordsB.length, 1) > threshold;
  }

  _createDAGNode(msgId, pipeline) {
    this._dagNodes.set(msgId, {
      msgId,
      from: pipeline.from,
      content: pipeline.content.substring(0, 100),
      channel: pipeline.channel,
      priority: pipeline.priority,
      timestamp: pipeline.timestamp,
      parentMsgId: pipeline.parentMsgId,
    });

    if (pipeline.parentMsgId && this._dagNodes.has(pipeline.parentMsgId)) {
      this._dagEdges.push({
        from: pipeline.parentMsgId,
        to: msgId,
        type: 'reply',
      });
    }
  }

  _detectIntent(content) {
    const lower = (content || '').toLowerCase();
    // 简单的关键词意图检测
    const patterns = [
      { intent: 'question', keywords: ['?', '？', '什么', '怎么', '如何', '为什么', 'what', 'how', 'why'] },
      { intent: 'command', keywords: ['执行', '运行', '启动', '创建', '删除', '安装', 'run', 'create', 'delete'] },
      { intent: 'analysis', keywords: ['分析', '总结', '报告', '评估', '对比', 'analyze', 'summary', 'report'] },
      { intent: 'search', keywords: ['搜索', '查找', '查询', '找一下', 'search', 'find', 'lookup'] },
      { intent: 'conversation', keywords: ['你好', '谢谢', '再见', 'hello', 'thanks', 'bye'] },
      { intent: 'coding', keywords: ['代码', '编程', '写一个', '实现', 'code', 'implement', 'function'] },
    ];

    for (const { intent, keywords } of patterns) {
      if (keywords.some(k => lower.includes(k))) return intent;
    }

    return 'general';
  }

  _extractEntities(content) {
    const entities = [];
    const text = content || '';

    // URL
    const urls = text.match(/https?:\/\/[^\s]+/g);
    if (urls) entities.push(...urls);

    // 文件路径
    const paths = text.match(/(?:[A-Za-z]:\\[\w\\.-]+|(?:\/[\w.-]+)+\.\w+)/g);
    if (paths) entities.push(...paths);

    // 中文引号内容（可能是名称/标题）
    const quoted = text.match(/[「『"《]([^」』"》]+)[」』"》]/g);
    if (quoted) entities.push(...quoted.map(q => q.replace(/[「『"《」』"》]/g, '')));

    // 邮箱
    const emails = text.match(/[\w.-]+@[\w.-]+\.\w+/g);
    if (emails) entities.push(...emails);

    return [...new Set(entities)];
  }

  _estimateAffect(content) {
    // 简化的情感向量估计
    const text = (content || '').toLowerCase();
    const vector = new Array(AFFECT_DIMS.length).fill(0.5);

    // valence (愉悦度)
    const positiveWords = ['好', '棒', '喜欢', '开心', 'great', 'good', 'love', 'excellent', 'awesome'];
    const negativeWords = ['不好', '差', '讨厌', '烦', 'bad', 'hate', 'terrible', 'awful'];
    vector[0] = this._affectScore(text, positiveWords, negativeWords);

    // arousal (唤醒度)
    const highArousal = ['!', '！', '紧急', '快', '立刻', '马上', 'urgent', 'now', 'asap'];
    vector[1] = this._affectScore(text, highArousal, []);

    // dominance (支配度)
    const dominantWords = ['命令', '要求', '必须', '一定', 'must', 'require', 'need'];
    vector[2] = this._affectScore(text, dominantWords, []);

    // urgency (紧急度)
    const urgentWords = ['紧急', 'urgent', '立刻', '马上', 'immediately', 'asap', '🔥', '⚠'];
    vector[3] = this._affectScore(text, urgentWords, []);

    // curiosity (好奇心)
    const curiousWords = ['?', '？', '为什么', '怎么', '如何', '好奇', 'why', 'how', 'what', 'curious'];
    vector[4] = this._affectScore(text, curiousWords, []);

    // confidence (置信度 — 基于消息长度和结构化程度)
    vector[5] = Math.min(1, text.length / 500);

    return vector;
  }

  _affectScore(text, positive, negative) {
    let score = 0.5;
    for (const word of positive) {
      if (text.includes(word)) score += 0.15;
    }
    for (const word of negative) {
      if (text.includes(word)) score -= 0.15;
    }
    return Math.max(0, Math.min(1, score));
  }

  _estimateComplexity(content) {
    const text = content || '';
    const words = text.split(/[\s,，。！？、]+/).filter(Boolean);
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));

    // 复杂度因素：长度、词汇多样性、标点复杂度
    const lengthFactor = Math.min(1, words.length / 50);
    const diversityFactor = Math.min(1, uniqueWords.size / Math.max(words.length, 1));
    const punctFactor = Math.min(1, (text.match(/[，。！？、；：""''（）【】《》—…]/g) || []).length / 10);

    const complexity = (lengthFactor * 0.4 + diversityFactor * 0.3 + punctFactor * 0.3);
    return {
      score: Math.round(complexity * 100) / 100,
      level: complexity > 0.7 ? 'high' : complexity > 0.4 ? 'medium' : 'low',
      wordCount: words.length,
      uniqueWordCount: uniqueWords.size,
    };
  }

  _detectLanguage(content) {
    const text = content || '';
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishChars = (text.match(/[a-zA-Z]/g) || []).length;

    if (chineseChars > englishChars * 2) return 'zh';
    if (englishChars > chineseChars * 2) return 'en';
    return chineseChars > 0 ? 'mixed-zh' : 'en';
  }

  _determineRouteTarget(pipeline) {
    const intent = pipeline.analysis?.intent || 'general';

    const routeMap = {
      question: 'consciousness',
      command: 'execution',
      analysis: 'consciousness',
      search: 'execution',
      conversation: 'consciousness',
      coding: 'execution',
      general: 'consciousness',
    };

    return routeMap[intent] || 'consciousness';
  }

  _assignCores(pipeline) {
    const intent = pipeline.analysis?.intent || 'general';
    const complexity = pipeline.analysis?.complexity?.level || 'medium';

    const baseCores = ['consciousness'];

    if (intent === 'command' || intent === 'search' || intent === 'coding') {
      baseCores.push('execution');
    }

    if (complexity === 'high') {
      baseCores.push('evolution');
    }

    return [...new Set(baseCores)];
  }

  // ═══════════════════════════════════════
  // 查询与统计
  // ═══════════════════════════════════════

  getPipeline(msgId) {
    return this._pipelines.get(msgId) || null;
  }

  getActivePipelines() {
    const active = [];
    for (const [msgId, pipeline] of this._pipelines) {
      if (pipeline.state !== PIPELINE_STATE.COMPLETE &&
          pipeline.state !== PIPELINE_STATE.INTERRUPTED) {
        active.push({
          msgId,
          from: pipeline.from,
          content: pipeline.content.substring(0, 80),
          state: pipeline.state,
          quantumState: pipeline.quantumState,
          priority: pipeline.priority,
          timestamp: pipeline.timestamp,
        });
      }
    }
    return active.sort((a, b) => b.priority - a.priority);
  }

  getDAGData(limit = 50) {
    const nodes = [];
    const recentPipelines = this._pipelineHistory.slice(-limit);

    for (const p of recentPipelines) {
      nodes.push({
        id: p.msgId,
        from: p.from,
        content: p.content,
        channel: p.channel,
        priority: p.priority,
        state: p.state,
      });
    }

    const edges = this._dagEdges
      .filter(e => nodes.some(n => n.id === e.from) && nodes.some(n => n.id === e.to));

    return { nodes, edges };
  }

  getEntityGraph() {
    const graph = { nodes: [], edges: [] };
    const seenEntities = new Set();

    for (const [entity, msgIds] of this._entityIndex) {
      if (seenEntities.has(entity)) continue;
      seenEntities.add(entity);
      graph.nodes.push({
        id: entity,
        label: entity.length > 30 ? entity.substring(0, 30) + '...' : entity,
        count: msgIds.length,
        type: entity.startsWith('http') ? 'url' :
              entity.includes('@') ? 'email' :
              entity.includes('\\') || entity.includes('/') ? 'path' : 'entity',
      });
    }

    // 共现边
    const msgToEntities = new Map();
    for (const [entity, msgIds] of this._entityIndex) {
      for (const msgId of msgIds) {
        if (!msgToEntities.has(msgId)) msgToEntities.set(msgId, []);
        msgToEntities.get(msgId).push(entity);
      }
    }

    const edgeSet = new Set();
    for (const [, entities] of msgToEntities) {
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const key = [entities[i], entities[j]].sort().join('|||');
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            graph.edges.push({ source: entities[i], target: entities[j] });
          }
        }
      }
    }

    return graph;
  }

  getStats() {
    return {
      ...this._stats,
      activePipelines: this._activeCount,
      totalPipelines: this._pipelines.size,
      contextWindows: this._contextWindows.size,
      entityCount: this._entityIndex.size,
      dagNodes: this._dagNodes.size,
      dagEdges: this._dagEdges.length,
    };
  }

  /**
   * 获取最近的消息处理摘要（供前端实时展示）
   */
  getRecentSummary(limit = 20) {
    return this._pipelineHistory.slice(-limit).map(p => ({
      ...p,
      pipeline: this._pipelines.get(p.msgId) ? {
        quantumState: this._pipelines.get(p.msgId).quantumState,
        analysis: this._pipelines.get(p.msgId).analysis ? {
          intent: this._pipelines.get(p.msgId).analysis.intent,
          complexity: this._pipelines.get(p.msgId).analysis.complexity?.level,
        } : null,
      } : null,
    }));
  }

  /**
   * 清理过期管道
   */
  cleanup(maxAge = 3600000) { // 默认1小时
    const now = Date.now();
    let cleaned = 0;

    for (const [msgId, pipeline] of this._pipelines) {
      if (pipeline.state === PIPELINE_STATE.COMPLETE && (now - pipeline.completedAt > maxAge)) {
        this._pipelines.delete(msgId);
        this._quantumStates.delete(msgId);
        cleaned++;
      }
    }

    return cleaned;
  }
}

// ── 导出 ──
module.exports = {
  MessageProcessor,
  PIPELINE_STATE,
  MSG_PRIORITY,
  QUANTUM_STATE,
  AFFECT_DIMS,
};
