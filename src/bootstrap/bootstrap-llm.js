'use strict';

const { ToolCallingEngine } = require('../llm/tool-calling-engine');
const { RAGEngine, CHUNK_STRATEGY, RETRIEVAL_MODE } = require('../llm/rag-engine');
const { MultiModalEngine } = require('../multimodal/multimodal-engine');

/**
 * Bootstrap: LLM深度集成 + 多模态感知
 *
 * 职责：
 *   1. ToolCallingEngine - 工具调用编排/并行执行/重试/缓存
 *   2. RAGEngine - 检索增强生成/多源文档/混合检索/重排序
 *   3. MultiModalEngine - 图像理解/OCR/文档解析/视觉问答
 *
 * 依赖：
 *   - router (ModelRouter)
 *   - security (SecurityBoundary)
 *   - budget (TokenBudgetManager)
 *   - memory (MemoryEngine)
 *   - browser (BrowserAutomation)
 */

/**
 * 初始化 LLM 集成与多模态模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── ToolCallingEngine ──
  agent._toolCalling = new ToolCallingEngine({
    router: agent._router,
    security: agent._security,
    budget: agent._budget,
    memory: agent._memory,
    maxRetries: options.toolMaxRetries ?? 3,
    defaultTimeout: options.toolTimeout ?? 30000,
    cacheTTL: options.toolCacheTTL ?? 300000,
  });

  // ── RAGEngine ──
  agent._rag = new RAGEngine({
    memory: agent._memory,
    router: agent._router,
    db: agent._memory?._db || null,
    chunkSize: options.ragChunkSize ?? 1000,
    chunkOverlap: options.ragChunkOverlap ?? 200,
    chunkStrategy: options.ragChunkStrategy || CHUNK_STRATEGY.SEMANTIC,
    retrievalMode: options.ragRetrievalMode || RETRIEVAL_MODE.HYBRID,
    topK: options.ragTopK ?? 5,
    rerankEnabled: options.ragRerankEnabled ?? true,
  });

  // ── MultiModalEngine ──
  agent._multimodal = new MultiModalEngine({
    router: agent._router,
    browser: agent._browser,
    memory: agent._memory,
    security: agent._security,
    visionEnabled: options.visionEnabled ?? true,
    visionProvider: options.visionProvider || null,
    visionModel: options.visionModel || null,
    ocrLanguage: options.ocrLanguage || 'chi_sim+eng',
  });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // LLM 模块没有需要从外部绑定的事件
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // LLM 模块没有额外的启动逻辑
}

module.exports = { init, bindEvents, startup };
