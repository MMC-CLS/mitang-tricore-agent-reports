/**
 * TriCore Agent - 多模型协同路由 (Multi-Model Collaborative Router)
 *
 * 核心问题：三层能力对模型要求不同，可能需要多模型协同。
 *
 * 增强能力：
 *   1. 多Provider同时注册 - 不同用途用不同Provider
 *   2. 能力分池路由 - consciousness池/execution池/evolution池独立配置
 *   3. 模型集成(Ensemble) - 多模型投票/交叉验证
 *   4. 质量/成本/速度自动优化 - 按策略动态选择
 *   5. 能力探测 - 自动测试Provider支持的能力（tool_call/thinking/streaming）
 *   6. 智能降级 - 主Provider失败时自动切换，且保持用途匹配
 *   7. 成本感知路由 - 结合TokenBudgetManager做经济路由
 *   8. 本地模型支持 - vLLM/Ollama零成本运行
 *
 * 使用方式：
 *   router.registerProvider('deepseek', { apiKey, ... });
 *   router.registerProvider('qwen', { apiKey, ... });
 *   router.assignProvider('deepseek', 'consciousness');  // deepseek负责意识层
 *   router.assignProvider('qwen', 'execution');          // qwen负责执行层
 *   router.call({ purpose: 'consciousness', messages });
 */

'use strict';

const EventEmitter = require('events');

// ── 模型用途 ──
const MODEL_PURPOSE = Object.freeze({
  CONSCIOUSNESS: 'consciousness',  // 意识层：需要创造力和长上下文
  EXECUTION: 'execution',          // 执行层：需要工具调用和结构化输出
  EVOLUTION: 'evolution',          // 进化层：需要摘要和分类
  EMBEDDING: 'embedding',          // 向量嵌入
  REASONING: 'reasoning',          // 深度推理（集成模式）
});

// ── Provider配置 ──
const PROVIDER_PRESETS = Object.freeze({
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: {
      consciousness: 'deepseek-chat',
      execution: 'deepseek-chat',
      evolution: 'deepseek-chat',
      reasoning: 'deepseek-reasoner',
    },
    envKey: 'DEEPSEEK_API_KEY',
    supportsThinking: true,
    capabilities: { tool_call: true, thinking: true, streaming: true, embedding: false },
    costPer1k: { input: 0.001, output: 0.002 },  // DeepSeek V3 超低成本
  },
  minimax: {
    name: 'MiniMax',
    baseURL: 'https://api.minimax.chat/v1',
    models: {
      consciousness: 'MiniMax-M2.7',
      execution: 'MiniMax-M2.7',
      evolution: 'MiniMax-M2.7',
    },
    envKey: 'MINIMAX_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.001, output: 0.002 },
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: {
      consciousness: 'gpt-4o',
      execution: 'gpt-4o-mini',
      evolution: 'gpt-4o-mini',
      reasoning: 'o3-mini',
    },
    envKey: 'OPENAI_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.005, output: 0.015 },  // gpt-4o
  },
  qwen: {
    name: 'Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: {
      consciousness: 'qwen-max',
      execution: 'qwen-turbo',
      evolution: 'qwen-turbo',
      reasoning: 'qwq-32b',
    },
    envKey: 'QWEN_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.002, output: 0.006 },
  },
  moonshot: {
    name: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    models: {
      consciousness: 'moonshot-v1-32k',
      execution: 'moonshot-v1-8k',
      evolution: 'moonshot-v1-8k',
    },
    envKey: 'MOONSHOT_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: false, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.002, output: 0.002 },
  },
  zhipu: {
    name: 'Zhipu',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: {
      consciousness: 'glm-4-plus',
      execution: 'glm-4-flash',
      evolution: 'glm-4-flash',
    },
    envKey: 'ZHIPU_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.003, output: 0.008 },
  },
  ollama: {
    name: 'Ollama (Local)',
    baseURL: 'http://localhost:11434/v1',
    models: {
      consciousness: 'qwen3:14b',
      execution: 'qwen3:8b',
      evolution: 'qwen3:4b',
    },
    envKey: 'OLLAMA_HOST',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0, output: 0 },  // 本地零成本
  },
  anthropic: {
    name: 'Anthropic Claude',
    baseURL: 'https://api.anthropic.com/v1',
    models: {
      consciousness: 'claude-sonnet-4-20250514',
      execution: 'claude-sonnet-4-20250514',
      evolution: 'claude-haiku-3-5-20241022',
      reasoning: 'claude-opus-4-20250514',
    },
    envKey: 'ANTHROPIC_API_KEY',
    supportsThinking: true,
    capabilities: { tool_call: true, thinking: true, streaming: true, embedding: false },
    costPer1k: { input: 0.003, output: 0.015 },
  },
  google: {
    name: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    models: {
      consciousness: 'gemini-2.5-pro',
      execution: 'gemini-2.5-flash',
      evolution: 'gemini-2.5-flash',
      reasoning: 'gemini-2.5-pro',
    },
    envKey: 'GOOGLE_API_KEY',
    supportsThinking: true,
    capabilities: { tool_call: true, thinking: true, streaming: true, embedding: true },
    costPer1k: { input: 0.00125, output: 0.005 },
  },
  xai: {
    name: 'xAI Grok',
    baseURL: 'https://api.x.ai/v1',
    models: {
      consciousness: 'grok-3-beta',
      execution: 'grok-3-beta',
      evolution: 'grok-3-beta',
    },
    envKey: 'XAI_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.003, output: 0.015 },
  },
  mistral: {
    name: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    models: {
      consciousness: 'mistral-large-latest',
      execution: 'mistral-small-latest',
      evolution: 'mistral-small-latest',
    },
    envKey: 'MISTRAL_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.002, output: 0.006 },
  },
  meta: {
    name: 'Meta Llama',
    baseURL: 'https://api.llama-api.com/v1',
    models: {
      consciousness: 'llama4-maverick',
      execution: 'llama4-scout',
      evolution: 'llama4-scout',
    },
    envKey: 'LLAMA_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.0005, output: 0.001 },
  },
  cohere: {
    name: 'Cohere',
    baseURL: 'https://api.cohere.ai/v1',
    models: {
      consciousness: 'command-r-plus',
      execution: 'command-r',
      evolution: 'command-r',
    },
    envKey: 'COHERE_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.003, output: 0.015 },
  },
  baichuan: {
    name: 'Baichuan',
    baseURL: 'https://api.baichuan-ai.com/v1',
    models: {
      consciousness: 'Baichuan4-Turbo',
      execution: 'Baichuan4-Air',
      evolution: 'Baichuan4-Air',
    },
    envKey: 'BAICHUAN_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.002, output: 0.004 },
  },
  stepfun: {
    name: 'StepFun',
    baseURL: 'https://api.stepfun.com/v1',
    models: {
      consciousness: 'step-2-16k',
      execution: 'step-1-8k',
      evolution: 'step-1-8k',
    },
    envKey: 'STEPFUN_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.001, output: 0.002 },
  },
  bytedance: {
    name: 'ByteDance Doubao',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: {
      consciousness: 'doubao-pro-32k',
      execution: 'doubao-lite-32k',
      evolution: 'doubao-lite-32k',
    },
    envKey: 'BYTEDANCE_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.0008, output: 0.002 },
  },
  baidu: {
    name: 'Baidu ERNIE',
    baseURL: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat',
    models: {
      consciousness: 'ernie-4.5-8k',
      execution: 'ernie-speed-8k',
      evolution: 'ernie-speed-8k',
    },
    envKey: 'BAIDU_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.002, output: 0.004 },
  },
  tencent: {
    name: 'Tencent HunYuan',
    baseURL: 'https://hunyuan.tencentcloudapi.com',
    models: {
      consciousness: 'hunyuan-turbos-latest',
      execution: 'hunyuan-lite',
      evolution: 'hunyuan-lite',
    },
    envKey: 'TENCENT_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.002, output: 0.006 },
  },
  iflytek: {
    name: 'iFlytek Spark',
    baseURL: 'https://spark-api-open.xf-yun.com/v1',
    models: {
      consciousness: 'generalv4.0',
      execution: 'generalv3.5',
      evolution: 'generalv3.5',
    },
    envKey: 'IFLYTEK_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.0015, output: 0.003 },
  },
  groq: {
    name: 'Groq (LPU)',
    baseURL: 'https://api.groq.com/openai/v1',
    models: {
      consciousness: 'llama-3.3-70b-versatile',
      execution: 'llama-3.1-8b-instant',
      evolution: 'llama-3.1-8b-instant',
    },
    envKey: 'GROQ_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.00059, output: 0.00079 },
  },
  together: {
    name: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    models: {
      consciousness: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      execution: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      evolution: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    },
    envKey: 'TOGETHER_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.0006, output: 0.001 },
  },
  fireworks: {
    name: 'Fireworks AI',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    models: {
      consciousness: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      execution: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      evolution: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    },
    envKey: 'FIREWORKS_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.0009, output: 0.0009 },
  },
  perplexity: {
    name: 'Perplexity AI',
    baseURL: 'https://api.perplexity.ai',
    models: {
      consciousness: 'sonar-pro',
      execution: 'sonar',
      evolution: 'sonar',
    },
    envKey: 'PERPLEXITY_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: false, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.002, output: 0.002 },
  },
  ai21: {
    name: 'AI21 Labs',
    baseURL: 'https://api.ai21.com/studio/v1',
    models: {
      consciousness: 'jamba-1.5-large',
      execution: 'jamba-1.5-mini',
      evolution: 'jamba-1.5-mini',
    },
    envKey: 'AI21_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.002, output: 0.008 },
  },
  reka: {
    name: 'Reka AI',
    baseURL: 'https://api.reka.ai',
    models: {
      consciousness: 'reka-flash-3',
      execution: 'reka-flash-3',
      evolution: 'reka-flash-3',
    },
    envKey: 'REKA_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.001, output: 0.003 },
  },
  nvidia: {
    name: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    models: {
      consciousness: 'nvidia/llama-3.1-nemotron-70b-instruct',
      execution: 'nvidia/llama-3.1-nemotron-8b-instruct',
      evolution: 'nvidia/llama-3.1-nemotron-8b-instruct',
    },
    envKey: 'NVIDIA_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.001, output: 0.002 },
  },
  siliconflow: {
    name: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: {
      consciousness: 'deepseek-ai/DeepSeek-V3',
      execution: 'Qwen/Qwen2.5-7B-Instruct',
      evolution: 'Qwen/Qwen2.5-7B-Instruct',
    },
    envKey: 'SILICONFLOW_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0.001, output: 0.002 },
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    models: {
      consciousness: 'openai/gpt-4o',
      execution: 'anthropic/claude-sonnet-4',
      evolution: 'google/gemini-flash-2.5',
    },
    envKey: 'OPENROUTER_API_KEY',
    supportsThinking: true,
    capabilities: { tool_call: true, thinking: true, streaming: true, embedding: false },
    costPer1k: { input: 0.003, output: 0.015 },
  },
  vllm: {
    name: 'vLLM (Local)',
    baseURL: 'http://localhost:8000/v1',
    models: {
      consciousness: 'qwen3-14b',
      execution: 'qwen3-8b',
      evolution: 'qwen3-4b',
    },
    envKey: 'VLLM_HOST',
    supportsThinking: false,
    capabilities: { tool_call: true, thinking: false, streaming: true, embedding: true },
    costPer1k: { input: 0, output: 0 },
  },
  custom: {
    name: 'Custom',
    baseURL: '',
    models: {
      consciousness: '',
      execution: '',
      evolution: '',
    },
    envKey: 'CUSTOM_API_KEY',
    supportsThinking: false,
    capabilities: { tool_call: false, thinking: false, streaming: true, embedding: false },
    costPer1k: { input: 0.001, output: 0.002 },
  },
});

// ── 路由策略 ──
const ROUTE_STRATEGY = Object.freeze({
  CHEAPEST: 'cheapest',             // 最便宜
  FASTEST: 'fastest',               // 最快响应
  BEST_QUALITY: 'best_quality',     // 最高质量
  LAYER_OPTIMAL: 'layer_optimal',   // 按层最优（默认）
  ENSEMBLE: 'ensemble',             // 多模型投票
  COST_AWARE: 'cost_aware',         // 成本感知（结合BudgetManager）
});

// ── 能力标志 ──
const MODEL_CAPABILITY = Object.freeze({
  TOOL_CALL: 'tool_call',
  THINKING: 'thinking',
  STREAMING: 'streaming',
  EMBEDDING: 'embedding',
  LONG_CONTEXT: 'long_context',   // >32K context
});

class ModelRouter extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── 当前配置 ──
    this._providers = new Map();  // providerName → { client, config, status }
    this._activeProvider = null;
    this._fallbackChain = [];     // fallback Provider列表
    this._strategy = options.strategy || ROUTE_STRATEGY.LAYER_OPTIMAL;

    // ── 多模型协同：按用途分配Provider ──
    this._purposeProviders = new Map(); // purpose → [providerName, ...]
    // 默认：所有用途使用activeProvider

    // ── 能力池 ──
    this._capabilityPools = new Map(); // capability → Set<providerName>

    // ── OpenAI客户端缓存 ──
    this._clients = new Map();

    // ── 配额与限流 ──
    this._quotaStatus = new Map();  // provider → { rpm, tpm, lastRequestAt }
    this._failureCounts = new Map(); // provider → 连续失败次数

    // ── 嵌入Provider ──
    this._embeddingProvider = options.embeddingProvider || null;

    // ── 性能追踪 ──
    this._performanceLog = [];   // { provider, purpose, latency, tokens, success, timestamp }
    this._maxPerformanceLog = 2000;

    // ── 集成配置 ──
    this._ensembleConfig = {
      minProviders: options.ensembleMinProviders ?? 2,  // 最少参与投票的Provider数
      strategy: options.ensembleStrategy ?? 'majority',  // majority | weighted | cascaded
    };

    // ── Token预算管理器引用（由外部注入） ──
    this._budgetManager = options.budgetManager || null;
  }

  // ═══════════════════════════════════════
  // Provider管理
  // ═══════════════════════════════════════

  /**
   * 注册Provider
   * @param {string} name - Provider名称
   * @param {Object} config - { apiKey, baseURL?, models?, capabilities? }
   */
  registerProvider(name, config) {
    const preset = PROVIDER_PRESETS[name] || PROVIDER_PRESETS.custom;
    const providerConfig = {
      name: preset.name,
      apiKey: config.apiKey,
      baseURL: config.baseURL || preset.baseURL,
      models: { ...preset.models, ...(config.models || {}) },
      supportsThinking: config.supportsThinking ?? preset.supportsThinking,
      capabilities: { ...preset.capabilities, ...(config.capabilities || {}) },
      costPer1k: { ...preset.costPer1k, ...(config.costPer1k || {}) },
      enabled: true,
    };

    this._providers.set(name, {
      config: providerConfig,
      status: 'available',   // available | rate_limited | failed | disabled
      lastError: null,
      latencyHistory: [],     // 最近N次调用延迟
    });

    // 更新能力池
    for (const [cap, supported] of Object.entries(providerConfig.capabilities)) {
      if (supported) {
        if (!this._capabilityPools.has(cap)) {
          this._capabilityPools.set(cap, new Set());
        }
        this._capabilityPools.get(cap).add(name);
      }
    }

    // 设置默认活跃Provider
    if (!this._activeProvider) {
      this._activeProvider = name;
    }

    this.emit('provider_registered', { name });
  }

  /**
   * 设置活跃Provider
   */
  setActiveProvider(name) {
    if (!this._providers.has(name)) {
      throw new Error(`Provider "${name}" not registered`);
    }
    this._activeProvider = name;
    this.emit('provider_changed', { name });
  }

  /**
   * 为特定用途指定Provider
   * @param {string} providerName - Provider名称
   * @param {string} purpose - MODEL_PURPOSE
   */
  assignProvider(providerName, purpose) {
    if (!this._providers.has(providerName)) {
      throw new Error(`Provider "${providerName}" not registered`);
    }

    if (!this._purposeProviders.has(purpose)) {
      this._purposeProviders.set(purpose, []);
    }

    const list = this._purposeProviders.get(purpose);
    if (!list.includes(providerName)) {
      list.push(providerName);
    }

    this.emit('provider_assigned', { provider: providerName, purpose });
  }

  /**
   * 批量分配用途→Provider映射
   * @param {Object} mapping - { consciousness: 'deepseek', execution: 'qwen', evolution: 'qwen' }
   */
  assignProviders(mapping) {
    for (const [purpose, providerName] of Object.entries(mapping)) {
      this.assignProvider(providerName, purpose);
    }
  }

  /**
   * 设置fallback链
   * @param {Array<string>} chain - Provider名称列表（按优先级排序）
   */
  setFallbackChain(chain) {
    this._fallbackChain = chain.filter(name => this._providers.has(name));
  }

  /**
   * 自动探测API Key所属Provider（安全策略）
   */
  async autoDetect(apiKey, hintProvider = null) {
    let candidates = [];

    if (hintProvider && PROVIDER_PRESETS[hintProvider] && hintProvider !== 'custom') {
      candidates = [[hintProvider, PROVIDER_PRESETS[hintProvider]]];
    } else {
      for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
        if (name === 'custom') continue;
        if (process.env[preset.envKey]) {
          candidates.push([name, preset]);
        }
      }
    }

    if (candidates.length === 0) {
      if (apiKey.startsWith('sk-')) {
        candidates = [['openai', PROVIDER_PRESETS.openai]];
      } else if (apiKey.startsWith('dz-') || apiKey.length === 32) {
        candidates = [['deepseek', PROVIDER_PRESETS.deepseek]];
      } else {
        this.registerProvider('custom', { apiKey, baseURL: '' });
        return 'custom';
      }
    }

    for (const [name, preset] of candidates) {
      try {
        const response = await fetch(`${preset.baseURL}/models`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          this.registerProvider(name, { apiKey });
          return name;
        }
      } catch (e) { /* 探测失败，继续 */ }
    }

    this.registerProvider('custom', { apiKey, baseURL: '' });
    return 'custom';
  }

  // ═══════════════════════════════════════
  // 能力探测
  // ═══════════════════════════════════════

  /**
   * 探测Provider支持的能力
   * @param {string} providerName
   * @returns {Object} { tool_call, thinking, streaming, embedding }
   */
  async probeCapabilities(providerName) {
    const provider = this._providers.get(providerName);
    if (!provider) return null;

    const capabilities = { ...provider.config.capabilities };

    // 尝试实际调用来验证能力
    try {
      const client = this._getClient(providerName, provider.config);

      // 测试基本调用
      const testResult = await client.chat.completions.create({
        model: this._selectModel(provider.config, MODEL_PURPOSE.EXECUTION),
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 5,
      }, { timeout: 10000 });

      capabilities.streaming = true;

      // 检查是否支持tool_call（通过实际测试）
      try {
        await client.chat.completions.create({
          model: this._selectModel(provider.config, MODEL_PURPOSE.EXECUTION),
          messages: [{ role: 'user', content: 'test' }],
          tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
          max_tokens: 5,
        }, { timeout: 10000 });
        capabilities.tool_call = true;
      } catch {
        capabilities.tool_call = false;
      }

      // 更新能力池
      for (const [cap, supported] of Object.entries(capabilities)) {
        if (supported) {
          if (!this._capabilityPools.has(cap)) {
            this._capabilityPools.set(cap, new Set());
          }
          this._capabilityPools.get(cap).add(providerName);
        }
      }

      provider.config.capabilities = capabilities;
      this.emit('capabilities_probed', { provider: providerName, capabilities });

    } catch (e) {
      // 探测失败，使用默认值
    }

    return capabilities;
  }

  /**
   * 查询支持特定能力的Provider列表
   */
  getProvidersByCapability(capability) {
    const pool = this._capabilityPools.get(capability);
    return pool ? [...pool] : [];
  }

  // ═══════════════════════════════════════
  // 核心调用接口
  // ═══════════════════════════════════════

  /**
   * 调用LLM（自动路由+fallback+用途分配）
   * @param {Object} params - { purpose, messages, tools?, stream?, temperature?, max_tokens? }
   * @returns {Object} { content, toolCalls, usage, provider, model }
   */
  async call(params) {
    const { purpose = MODEL_PURPOSE.EXECUTION } = params;

    // 集成模式：多Provider投票
    if (this._strategy === ROUTE_STRATEGY.ENSEMBLE && this._providers.size >= this._ensembleConfig.minProviders) {
      return this._ensembleCall(params);
    }

    // 成本感知路由：结合BudgetManager
    if (this._strategy === ROUTE_STRATEGY.COST_AWARE && this._budgetManager) {
      return this._costAwareCall(params);
    }

    // 标准路由：按策略选择Provider
    const providerChain = this._resolveProviderChain(purpose);

    let lastError = null;
    for (const providerName of providerChain) {
      const provider = this._providers.get(providerName);
      if (!provider || provider.status === 'disabled') continue;

      // 能力检查：如果需要tool_call但Provider不支持，跳过
      if (params.tools && params.tools.length > 0 && provider.config.capabilities?.tool_call === false) {
        continue;
      }

      try {
        const startTime = Date.now();
        const result = await this._callProvider(providerName, provider, params);
        const latency = Date.now() - startTime;

        // 成功，重置失败计数
        this._failureCounts.set(providerName, 0);
        provider.status = 'available';

        // 记录性能
        this._recordPerformance(providerName, purpose, latency, result.usage, true);

        return { ...result, provider: providerName, latency };
      } catch (error) {
        lastError = error;
        this._handleProviderError(providerName, error);
        this._recordPerformance(providerName, purpose, 0, null, false, error.message);
      }
    }

    throw new Error(`All providers failed. Last error: ${lastError?.message}`);
  }

  /**
   * 流式调用LLM
   */
  async *stream(params) {
    const { purpose = MODEL_PURPOSE.EXECUTION } = params;
    const providerChain = this._resolveProviderChain(purpose);

    let lastError = null;
    for (const providerName of providerChain) {
      const provider = this._providers.get(providerName);
      if (!provider || provider.status === 'disabled') continue;

      // 能力检查
      if (!provider.config.capabilities?.streaming) continue;

      try {
        const generator = this._streamProvider(providerName, provider, params);

        for await (const chunk of generator) {
          yield { ...chunk, provider: providerName };
        }

        this._failureCounts.set(providerName, 0);
        provider.status = 'available';
        return;
      } catch (error) {
        lastError = error;
        this._handleProviderError(providerName, error);
      }
    }

    throw new Error(`All providers failed in stream mode. Last error: ${lastError?.message}`);
  }

  /**
   * 计算向量嵌入
   */
  async embed(text) {
    if (!this._embeddingProvider) {
      // 优先使用支持embedding的Provider
      const embeddingProviders = this.getProvidersByCapability(MODEL_CAPABILITY.EMBEDDING);
      const providerName = embeddingProviders[0] || this._activeProvider;
      const provider = this._providers.get(providerName);
      if (!provider) throw new Error('No provider available for embedding');

      const embeddingModel = provider.config.embeddingModel || 'text-embedding-3-small';
      const client = this._getClient(providerName, provider.config);
      const response = await client.embeddings.create({
        model: embeddingModel,
        input: text,
      });
      return response.data[0].embedding;
    }

    return this._embeddingProvider(text);
  }

  // ═══════════════════════════════════════
  // 高级路由策略
  // ═══════════════════════════════════════

  /**
   * 集成调用（多Provider投票/交叉验证）
   */
  async _ensembleCall(params) {
    const { purpose = MODEL_PURPOSE.EXECUTION } = params;
    const strategy = this._ensembleConfig.strategy;

    // 选择参与投票的Provider
    const candidates = this._selectEnsembleProviders(purpose);

    if (candidates.length < this._ensembleConfig.minProviders) {
      // 不足最低数量，退回单Provider
      return this.call({ ...params, _skipEnsemble: true });
    }

    if (strategy === 'cascaded') {
      return this._cascadedCall(candidates, params);
    }

    // majority/weighted: 并行调用，收集结果
    const results = await Promise.allSettled(
      candidates.map(async (providerName) => {
        const provider = this._providers.get(providerName);
        return this._callProvider(providerName, provider, params);
      })
    );

    const successfulResults = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (successfulResults.length === 0) {
      throw new Error('Ensemble call: all providers failed');
    }

    if (strategy === 'majority') {
      // 简单多数：返回最长的结果（通常最详细）
      successfulResults.sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0));
      return successfulResults[0];
    }

    if (strategy === 'weighted') {
      // 加权：按Provider历史成功率加权
      return this._weightedSelect(successfulResults, candidates, results);
    }

    return successfulResults[0];
  }

  /**
   * 级联调用（先快后准）
   */
  async _cascadedCall(candidates, params) {
    // 按延迟排序：快的先调用
    const sorted = candidates.sort((a, b) => {
      const aAvg = this._getAverageLatency(a);
      const bAvg = this._getAverageLatency(b);
      return aAvg - bAvg;
    });

    for (const providerName of sorted) {
      const provider = this._providers.get(providerName);
      if (!provider) continue;

      try {
        const result = await this._callProvider(providerName, provider, params);
        return { ...result, provider: providerName };
      } catch (e) {
        // 级联：失败继续下一个
        continue;
      }
    }

    throw new Error('Cascaded call: all providers failed');
  }

  /**
   * 成本感知路由
   */
  async _costAwareCall(params) {
    const { purpose = MODEL_PURPOSE.EXECUTION } = params;

    // 请求Token预算
    const estimatedTokens = (params.max_tokens || 2048) + 500;
    const budgetDecision = this._budgetManager.requestTokens(purpose, estimatedTokens, {
      priority: purpose === MODEL_PURPOSE.CONSCIOUSNESS ? 80 : purpose === MODEL_PURPOSE.EXECUTION ? 100 : 20,
    });

    if (!budgetDecision.allowed) {
      if (budgetDecision.fromCache && budgetDecision.cacheResult) {
        return budgetDecision.cacheResult;
      }
      throw new Error(`Token budget exhausted for ${purpose}: ${budgetDecision.reason}`);
    }

    // 根据节流级别调整purpose
    const effectivePurpose = budgetDecision.suggestedPurpose || purpose;
    const adjustedMaxTokens = budgetDecision.adjustedMaxTokens || params.max_tokens;

    // 选择最经济的Provider
    const providerChain = this._resolveCheapestChain(effectivePurpose);

    for (const providerName of providerChain) {
      const provider = this._providers.get(providerName);
      if (!provider || provider.status === 'disabled') continue;

      try {
        const result = await this._callProvider(providerName, provider, {
          ...params,
          purpose: effectivePurpose,
          max_tokens: adjustedMaxTokens,
        });

        // 报告Token使用量
        if (this._budgetManager && result.usage) {
          const cacheKey = this._budgetManager.generateCacheKey(params.messages, purpose);
          this._budgetManager.reportUsage(purpose, result.usage, result, cacheKey);
        }

        return { ...result, provider: providerName, budgetThrottle: budgetDecision.throttleLevel };
      } catch (error) {
        this._handleProviderError(providerName, error);
      }
    }

    throw new Error('Cost-aware call: all providers failed');
  }

  // ═══════════════════════════════════════
  // 路由策略实现
  // ═══════════════════════════════════════

  /**
   * 解析Provider调用链（按用途优先）
   */
  _resolveProviderChain(purpose) {
    const chain = [];

    // 1. 优先使用该用途专用的Provider
    const purposeList = this._purposeProviders.get(purpose);
    if (purposeList) {
      for (const name of purposeList) {
        if (!chain.includes(name)) chain.push(name);
      }
    }

    // 2. 活跃Provider
    if (!chain.includes(this._activeProvider)) {
      chain.push(this._activeProvider);
    }

    // 3. Fallback链
    for (const name of this._fallbackChain) {
      if (!chain.includes(name)) chain.push(name);
    }

    // 4. 所有可用的其他Provider
    for (const [name] of this._providers) {
      if (!chain.includes(name)) chain.push(name);
    }

    // 按策略排序
    return this._sortChainByStrategy(chain, purpose);
  }

  /**
   * 解析最经济的Provider链
   */
  _resolveCheapestChain(purpose) {
    const chain = this._resolveProviderChain(purpose);

    // 按成本排序
    return chain.sort((a, b) => {
      const aCost = this._providers.get(a)?.config?.costPer1k?.output || 999;
      const bCost = this._providers.get(b)?.config?.costPer1k?.output || 999;
      return aCost - bCost;
    });
  }

  /**
   * 按策略排序Provider链
   */
  _sortChainByStrategy(chain, purpose) {
    switch (this._strategy) {
      case ROUTE_STRATEGY.CHEAPEST:
      case ROUTE_STRATEGY.COST_AWARE:
        return chain.sort((a, b) => {
          const aCost = this._providers.get(a)?.config?.costPer1k?.output || 999;
          const bCost = this._providers.get(b)?.config?.costPer1k?.output || 999;
          return aCost - bCost;
        });

      case ROUTE_STRATEGY.FASTEST:
        return chain.sort((a, b) => {
          const aLatency = this._getAverageLatency(a);
          const bLatency = this._getAverageLatency(b);
          return aLatency - bLatency;
        });

      case ROUTE_STRATEGY.BEST_QUALITY:
        // 质量优先：意识层模型通常最强，排前面
        return chain;

      case ROUTE_STRATEGY.LAYER_OPTIMAL:
      default:
        // 已通过用途分配实现，保持原序
        return chain;
    }
  }

  /**
   * 选择参与集成调用的Provider
   */
  _selectEnsembleProviders(purpose) {
    const purposeList = this._purposeProviders.get(purpose) || [];
    const available = purposeList.filter(name => {
      const p = this._providers.get(name);
      return p && p.status !== 'disabled' && p.status !== 'failed';
    });

    if (available.length >= this._ensembleConfig.minProviders) {
      return available;
    }

    // 不足时从所有Provider中补
    for (const [name, provider] of this._providers) {
      if (!available.includes(name) && provider.status === 'available') {
        available.push(name);
        if (available.length >= this._ensembleConfig.minProviders) break;
      }
    }

    return available;
  }

  /**
   * 选择模型（按用途+策略）
   */
  _selectModel(providerConfig, purpose) {
    switch (this._strategy) {
      case ROUTE_STRATEGY.CHEAPEST:
      case ROUTE_STRATEGY.COST_AWARE:
        return providerConfig.models.execution || providerConfig.models.evolution;
      case ROUTE_STRATEGY.BEST_QUALITY:
        return providerConfig.models.consciousness;
      case ROUTE_STRATEGY.LAYER_OPTIMAL:
      default:
        return providerConfig.models[purpose] || providerConfig.models.execution;
    }
  }

  // ═══════════════════════════════════════
  // Provider调用实现
  // ═══════════════════════════════════════

  async _callProvider(providerName, provider, params) {
    const { purpose, messages, tools, temperature, max_tokens } = params;
    const model = this._selectModel(provider.config, purpose);
    const client = this._getClient(providerName, provider.config);

    const requestParams = {
      model,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 4096,
    };

    if (tools && tools.length > 0 && provider.config.capabilities?.tool_call) {
      requestParams.tools = tools;
    }

    const response = await client.chat.completions.create(requestParams);

    if (!response.choices || response.choices.length === 0) {
      throw new Error(`Empty choices from ${providerName} (possible content filter)`);
    }

    const choice = response.choices[0];
    return {
      content: choice.message.content || '',
      toolCalls: choice.message.tool_calls || [],
      usage: response.usage,
      model,
      finishReason: choice.finish_reason,
    };
  }

  async *_streamProvider(providerName, provider, params) {
    const { purpose, messages, tools, temperature, max_tokens } = params;
    const model = this._selectModel(provider.config, purpose);
    const client = this._getClient(providerName, provider.config);

    const requestParams = {
      model,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 4096,
      stream: true,
    };

    if (tools && tools.length > 0 && provider.config.capabilities?.tool_call) {
      requestParams.tools = tools;
    }

    const stream = await client.chat.completions.create(requestParams);

    let content = '';
    let reasoningContent = '';
    const toolCallsMap = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        yield { type: 'content', text: delta.content, content, done: false };
      }

      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        yield { type: 'reasoning', text: delta.reasoning_content, reasoningContent, done: false };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, { id: '', function: { name: '', arguments: '' }, type: 'function' });
          }
          const existing = toolCallsMap.get(idx);
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        }
      }
    }

    const toolCalls = toolCallsMap.size > 0 ? [...toolCallsMap.values()] : [];
    yield {
      type: 'done',
      content,
      reasoningContent,
      toolCalls,
      done: true,
    };
  }

  // ═══════════════════════════════════════
  // 客户端管理
  // ═══════════════════════════════════════

  _getClient(providerName, config) {
    const signature = `${config.baseURL}:${config.apiKey}`;
    if (this._clients.has(signature)) {
      return this._clients.get(signature);
    }

    const OpenAI = require('openai');
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });

    this._clients.set(signature, client);
    return client;
  }

  // ═══════════════════════════════════════
  // 错误处理
  // ═══════════════════════════════════════

  _handleProviderError(providerName, error) {
    const provider = this._providers.get(providerName);
    if (!provider) return;

    const failures = (this._failureCounts.get(providerName) || 0) + 1;
    this._failureCounts.set(providerName, failures);

    if (error.status === 429) {
      provider.status = 'rate_limited';
      this.emit('rate_limited', { provider: providerName });
    } else if (failures >= 3) {
      provider.status = 'failed';
      provider.lastError = error.message;
      this.emit('provider_failed', { provider: providerName, error: error.message });
    }

    this.emit('call_error', { provider: providerName, error: error.message });
  }

  // ═══════════════════════════════════════
  // 性能追踪
  // ═══════════════════════════════════════

  _recordPerformance(providerName, purpose, latency, usage, success, error = null) {
    // 更新Provider延迟历史
    const provider = this._providers.get(providerName);
    if (provider) {
      provider.latencyHistory.push(latency);
      if (provider.latencyHistory.length > 20) {
        provider.latencyHistory.shift();
      }
    }

    this._performanceLog.push({
      provider: providerName,
      purpose,
      latency,
      tokens: usage?.total_tokens || 0,
      success,
      error,
      timestamp: Date.now(),
    });

    if (this._performanceLog.length > this._maxPerformanceLog) {
      this._performanceLog = this._performanceLog.slice(-this._maxPerformanceLog);
    }
  }

  _getAverageLatency(providerName) {
    const provider = this._providers.get(providerName);
    if (!provider || provider.latencyHistory.length === 0) return 9999;
    return provider.latencyHistory.reduce((a, b) => a + b, 0) / provider.latencyHistory.length;
  }

  _weightedSelect(results, candidates, settledResults) {
    // 按Provider成功率加权选择
    let bestIdx = 0;
    let bestScore = -1;

    let resultIdx = 0;
    for (let i = 0; i < settledResults.length; i++) {
      if (settledResults[i].status === 'fulfilled') {
        const providerName = candidates[i];
        const provider = this._providers.get(providerName);
        const successRate = provider ? (1 - (this._failureCounts.get(providerName) || 0) / 10) : 0.5;
        const contentScore = (results[resultIdx]?.content?.length || 0) / 1000;
        const score = successRate * 0.7 + contentScore * 0.3;

        if (score > bestScore) {
          bestScore = score;
          bestIdx = resultIdx;
        }
        resultIdx++;
      }
    }

    return results[bestIdx];
  }

  // ═══════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════

  getStatus() {
    const providers = {};
    for (const [name, provider] of this._providers) {
      providers[name] = {
        status: provider.status,
        models: provider.config.models,
        capabilities: provider.config.capabilities,
        costPer1k: provider.config.costPer1k,
        avgLatency: Math.round(this._getAverageLatency(name)),
        lastError: provider.lastError,
      };
    }

    const purposeAssignments = {};
    for (const [purpose, list] of this._purposeProviders) {
      purposeAssignments[purpose] = list;
    }

    return {
      activeProvider: this._activeProvider,
      strategy: this._strategy,
      fallbackChain: this._fallbackChain,
      purposeAssignments,
      capabilityPools: Object.fromEntries(
        [...this._capabilityPools].map(([k, v]) => [k, [...v]])
      ),
      providers,
    };
  }

  /**
   * 获取性能报告
   */
  getPerformanceReport() {
    const byProvider = {};
    const byPurpose = {};

    for (const entry of this._performanceLog) {
      // 按Provider聚合
      if (!byProvider[entry.provider]) {
        byProvider[entry.provider] = { calls: 0, successes: 0, avgLatency: 0, totalTokens: 0, latencySum: 0 };
      }
      byProvider[entry.provider].calls++;
      if (entry.success) byProvider[entry.provider].successes++;
      byProvider[entry.provider].latencySum += entry.latency;
      byProvider[entry.provider].totalTokens += entry.tokens;

      // 按用途聚合
      if (!byPurpose[entry.purpose]) {
        byPurpose[entry.purpose] = { calls: 0, successes: 0, avgLatency: 0, totalTokens: 0, latencySum: 0 };
      }
      byPurpose[entry.purpose].calls++;
      if (entry.success) byPurpose[entry.purpose].successes++;
      byPurpose[entry.purpose].latencySum += entry.latency;
      byPurpose[entry.purpose].totalTokens += entry.tokens;
    }

    // 计算平均值
    for (const stats of Object.values(byProvider)) {
      stats.avgLatency = stats.calls > 0 ? Math.round(stats.latencySum / stats.calls) : 0;
      stats.successRate = stats.calls > 0 ? (stats.successes / stats.calls * 100).toFixed(1) + '%' : '0%';
    }
    for (const stats of Object.values(byPurpose)) {
      stats.avgLatency = stats.calls > 0 ? Math.round(stats.latencySum / stats.calls) : 0;
      stats.successRate = stats.calls > 0 ? (stats.successes / stats.calls * 100).toFixed(1) + '%' : '0%';
    }

    return { byProvider, byPurpose };
  }
}

// ── 导出 ──
module.exports = {
  ModelRouter,
  MODEL_PURPOSE,
  PROVIDER_PRESETS,
  ROUTE_STRATEGY,
  MODEL_CAPABILITY,
};
