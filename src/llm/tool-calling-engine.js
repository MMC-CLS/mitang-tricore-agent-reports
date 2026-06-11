/**
 * TriCore Agent - Tool Calling 引擎 (Tool Calling Engine)
 *
 * Phase 12: LLM深度集成 - 完整的工具调用编排引擎
 *
 * 核心能力:
 *   1. OpenAI/Anthropic/国产模型统一Tool Calling接口
 *   2. 智能工具选择 - 基于语义自动筛选相关工具
 *   3. 并行工具调用 - 独立工具并行执行
 *   4. 工具调用链编排 - 多步骤工具调用自动串联
 *   5. 工具结果验证 - 输出格式校验 + Schema验证
 *   6. 工具调用缓存 - 幂等工具调用结果缓存
 *   7. 流式工具调用 - 支持streaming + tool_use
 *   8. 重试与降级 - 工具调用失败自动重试+降级策略
 */

'use strict';

const { EventEmitter } = require('events');

// ── 工具调用状态 ──
const TOOL_CALL_STATUS = Object.freeze({
  PENDING: 'pending',
  EXECUTING: 'executing',
  SUCCESS: 'success',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
});

// ── 工具调用模式 ──
const TOOL_CALL_MODE = Object.freeze({
  SINGLE: 'single',       // 单次调用
  PARALLEL: 'parallel',   // 并行调用多个工具
  SEQUENTIAL: 'sequential', // 顺序链式调用
  CONDITIONAL: 'conditional', // 条件分支调用
});

// ── 工具参数Schema ──
const PARAM_TYPE = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
});

class ToolCallingEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this._tools = new Map();            // toolName → { definition, handler, schema }
    this._router = options.router || null;
    this._security = options.security || null;
    this._budget = options.budget || null;
    this._memory = options.memory || null;

    // 缓存
    this._resultCache = new Map();      // cacheKey → { result, timestamp }
    this._cacheTTL = options.cacheTTL ?? 300000;  // 5分钟
    this._maxCacheSize = options.maxCacheSize ?? 500;

    // 重试配置
    this._maxRetries = options.maxRetries ?? 3;
    this._retryDelay = options.retryDelay ?? 1000;

    // 超时
    this._defaultTimeout = options.defaultTimeout ?? 30000;

    // 统计
    this._stats = {
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      cachedHits: 0,
      totalLatency: 0,
    };
  }

  // ═══════════════════════════════════════
  // 工具注册
  // ═══════════════════════════════════════

  /**
   * 注册工具（OpenAI Function Calling格式）
   * @param {Object} tool - { name, description, parameters, handler, schema? }
   */
  registerTool(tool) {
    const { name, description, parameters, handler, schema } = tool;
    if (!name || !handler) throw new Error('Tool requires name and handler');

    const openaiFormat = {
      type: 'function',
      function: {
        name,
        description: description || '',
        parameters: parameters || {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    };

    this._tools.set(name, {
      definition: openaiFormat,
      handler,
      schema: schema || null,  // 可选的结果验证schema
      stats: { calls: 0, successes: 0, failures: 0, avgLatency: 0 },
    });

    this.emit('tool_registered', { name });
  }

  /**
   * 批量注册工具
   */
  registerTools(tools) {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * 获取OpenAI格式的工具列表
   */
  getToolDefinitions(filterNames = null) {
    const tools = [];
    for (const [name, tool] of this._tools) {
      if (!filterNames || filterNames.includes(name)) {
        tools.push(tool.definition);
      }
    }
    return tools;
  }

  // ═══════════════════════════════════════
  // 核心调用接口
  // ═══════════════════════════════════════

  /**
   * 执行工具调用
   * @param {Object} toolCall - { function: { name, arguments } }
   * @param {Object} context - { taskId?, traceId?, timeout? }
   * @returns {Object} { status, result, error?, duration }
   */
  async execute(toolCall, context = {}) {
    const startTime = Date.now();
    const toolName = toolCall.function?.name;
    let args = {};

    try {
      args = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments || {};
    } catch {
      return this._failResult('Invalid arguments JSON', toolName, startTime);
    }

    const tool = this._tools.get(toolName);
    if (!tool) {
      return this._failResult(`Unknown tool: ${toolName}`, toolName, startTime);
    }

    // 安全检查
    if (this._security) {
      const { CORE_IDENTITY, CAPABILITY } = require('../security/security-boundary');
      const auth = this._security.authorize(
        CORE_IDENTITY.EXECUTION,
        CAPABILITY.CALL_TOOL,
        { params: { toolName, args } }
      );
      if (!auth.allowed) {
        return this._failResult(`Security denied: ${auth.reason}`, toolName, startTime);
      }
    }

    // 缓存检查（幂等工具）
    const cacheKey = this._generateCacheKey(toolName, args);
    if (tool.schema?.idempotent) {
      const cached = this._checkCache(cacheKey);
      if (cached) {
        this._stats.cachedHits++;
        return { status: TOOL_CALL_STATUS.SUCCESS, result: cached, fromCache: true, duration: Date.now() - startTime };
      }
    }

    // 执行（含重试）
    const timeout = context.timeout || this._defaultTimeout;
    let lastError = null;

    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      try {
        const result = await this._executeWithTimeout(tool.handler, args, context, timeout);

        // Schema验证
        if (tool.schema?.validate && !tool.schema.validate(result)) {
          throw new Error(`Tool result validation failed for ${toolName}`);
        }

        // 缓存结果
        if (tool.schema?.idempotent) {
          this._storeCache(cacheKey, result);
        }

        // 更新统计
        this._updateToolStats(toolName, true, Date.now() - startTime);
        this._stats.successCalls++;

        return {
          status: TOOL_CALL_STATUS.SUCCESS,
          result,
          duration: Date.now() - startTime,
          attempt: attempt + 1,
        };
      } catch (error) {
        lastError = error;
        if (attempt < this._maxRetries) {
          await this._sleep(this._retryDelay * Math.pow(2, attempt)); // 指数退避
        }
      }
    }

    // 所有重试失败
    this._updateToolStats(toolName, false, Date.now() - startTime);
    this._stats.failedCalls++;

    return {
      status: TOOL_CALL_STATUS.FAILED,
      error: lastError?.message || 'Unknown error',
      duration: Date.now() - startTime,
      attempts: this._maxRetries + 1,
    };
  }

  /**
   * 批量执行工具调用（并行模式）
   */
  async executeParallel(toolCalls, context = {}) {
    const results = await Promise.allSettled(
      toolCalls.map(tc => this.execute(tc, context))
    );

    return results.map((r, i) => ({
      toolCallId: toolCalls[i]?.id,
      ...(r.status === 'fulfilled' ? r.value : { status: TOOL_CALL_STATUS.FAILED, error: r.reason?.message }),
    }));
  }

  /**
   * 顺序执行工具调用链
   */
  async executeSequential(toolCalls, context = {}) {
    const results = [];
    let previousResult = null;

    for (const tc of toolCalls) {
      // 前一个结果可以注入到当前工具的参数中
      const enrichedContext = { ...context, previousResult };
      const result = await this.execute(tc, enrichedContext);
      results.push({ toolCallId: tc.id, ...result });
      previousResult = result.status === TOOL_CALL_STATUS.SUCCESS ? result.result : null;

      // 如果某个步骤失败，根据策略决定是否继续
      if (result.status === TOOL_CALL_STATUS.FAILED && context.stopOnError !== false) {
        break;
      }
    }

    return results;
  }

  // ═══════════════════════════════════════
  // LLM驱动的工具选择与编排
  // ═══════════════════════════════════════

  /**
   * 智能工具选择 - 基于用户意图自动选择最合适的工具
   * @param {string} userIntent - 用户意图描述
   * @param {number} maxTools - 最多选择几个工具
   * @returns {Array} 选中的工具名列表
   */
  async selectTools(userIntent, maxTools = 5) {
    if (!this._router) {
      // 无LLM时基于关键词简单匹配
      return this._keywordToolMatch(userIntent, maxTools);
    }

    const toolList = [...this._tools.entries()].map(([name, t]) =>
      `- ${name}: ${t.definition.function.description}`
    ).join('\n');

    try {
      const { MODEL_PURPOSE } = require('../providers/model-router');
      const result = await this._router.call({
        purpose: MODEL_PURPOSE.EXECUTION,
        messages: [
          {
            role: 'system',
            content: `你是一个工具选择器。根据用户意图，从可用工具中选择最合适的工具。
可用工具:
${toolList}

输出JSON格式的工具名列表: ["tool_name1", "tool_name2"]
只输出JSON数组，不要其他内容。选择${maxTools}个以内最相关的工具。`,
          },
          { role: 'user', content: userIntent },
        ],
        temperature: 0.1,
        max_tokens: 500,
      });

      const jsonMatch = result.content?.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const selected = JSON.parse(jsonMatch[0]);
        return selected.filter(name => this._tools.has(name)).slice(0, maxTools);
      }
    } catch {
      // LLM选择失败，降级为关键词匹配
    }

    return this._keywordToolMatch(userIntent, maxTools);
  }

  /**
   * 关键词工具匹配（无LLM降级）
   */
  _keywordToolMatch(intent, maxTools) {
    const lowerIntent = intent.toLowerCase();
    const scored = [];

    for (const [name, tool] of this._tools) {
      const desc = tool.definition.function.description.toLowerCase();
      const keywords = this._extractKeywords(lowerIntent);
      let score = 0;

      // 名称匹配
      if (lowerIntent.includes(name.toLowerCase())) score += 10;
      // 描述关键词匹配
      for (const kw of keywords) {
        if (desc.includes(kw)) score += 2;
        if (name.toLowerCase().includes(kw)) score += 3;
      }

      if (score > 0) scored.push({ name, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTools)
      .map(s => s.name);
  }

  // ═══════════════════════════════════════
  // 流式工具调用
  // ═══════════════════════════════════════

  /**
   * 流式执行工具调用（逐步返回进度）
   */
  async *executeStreaming(toolCall, context = {}) {
    const toolName = toolCall.function?.name;
    yield { type: 'tool_start', toolName, timestamp: Date.now() };

    const result = await this.execute(toolCall, context);

    if (result.status === TOOL_CALL_STATUS.SUCCESS) {
      yield { type: 'tool_result', toolName, result: result.result, duration: result.duration };
    } else {
      yield { type: 'tool_error', toolName, error: result.error, duration: result.duration };
    }

    yield { type: 'tool_end', toolName, status: result.status, timestamp: Date.now() };
  }

  // ═══════════════════════════════════════
  // 缓存管理
  // ═══════════════════════════════════════

  _generateCacheKey(toolName, args) {
    const sorted = JSON.stringify(args, Object.keys(args).sort());
    let hash = 0;
    const key = `${toolName}:${sorted}`;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return `tool_${Math.abs(hash).toString(36)}`;
  }

  _checkCache(cacheKey) {
    const entry = this._resultCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this._cacheTTL) {
      this._resultCache.delete(cacheKey);
      return null;
    }
    return entry.result;
  }

  _storeCache(cacheKey, result) {
    if (this._resultCache.size >= this._maxCacheSize) {
      const firstKey = this._resultCache.keys().next().value;
      this._resultCache.delete(firstKey);
    }
    this._resultCache.set(cacheKey, { result, timestamp: Date.now() });
  }

  clearCache() {
    this._resultCache.clear();
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  async _executeWithTimeout(handler, args, context, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool execution timeout (${timeout}ms)`));
      }, timeout);

      Promise.resolve(handler(args, context))
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  _failResult(error, toolName, startTime) {
    this._stats.failedCalls++;
    if (toolName) this._updateToolStats(toolName, false, Date.now() - startTime);
    return {
      status: TOOL_CALL_STATUS.FAILED,
      error,
      duration: Date.now() - startTime,
    };
  }

  _updateToolStats(toolName, success, duration) {
    const tool = this._tools.get(toolName);
    if (!tool) return;
    tool.stats.calls++;
    if (success) tool.stats.successes++;
    else tool.stats.failures++;
    tool.stats.avgLatency = (tool.stats.avgLatency * (tool.stats.calls - 1) + duration) / tool.stats.calls;
    this._stats.totalCalls++;
    this._stats.totalLatency += duration;
  }

  _extractKeywords(text) {
    return text
      .split(/[\s,，。；;、！!？?]+/)
      .filter(w => w.length >= 2)
      .slice(0, 10);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════

  getStats() {
    const toolStats = {};
    for (const [name, tool] of this._tools) {
      toolStats[name] = {
        calls: tool.stats.calls,
        successes: tool.stats.successes,
        failures: tool.stats.failures,
        successRate: tool.stats.calls > 0
          ? (tool.stats.successes / tool.stats.calls * 100).toFixed(1) + '%'
          : '0%',
        avgLatency: tool.stats.avgLatency.toFixed(0) + 'ms',
      };
    }

    return {
      totalCalls: this._stats.totalCalls,
      successCalls: this._stats.successCalls,
      failedCalls: this._stats.failedCalls,
      cachedHits: this._stats.cachedHits,
      avgLatency: this._stats.totalCalls > 0
        ? (this._stats.totalLatency / this._stats.totalCalls).toFixed(0) + 'ms'
        : '0ms',
      toolsRegistered: this._tools.size,
      cacheSize: this._resultCache.size,
      toolStats,
    };
  }

  listTools() {
    return [...this._tools.entries()].map(([name, tool]) => ({
      name,
      description: tool.definition.function.description,
      parameters: tool.definition.function.parameters,
      idempotent: tool.schema?.idempotent || false,
    }));
  }
}

module.exports = {
  ToolCallingEngine,
  TOOL_CALL_STATUS,
  TOOL_CALL_MODE,
  PARAM_TYPE,
};
