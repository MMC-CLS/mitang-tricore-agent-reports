/**
 * 蜜糖 TriCore Agent — 共享设置管理器 v6.0
 *
 * 职责：
 *   1. 跨页面统一的设置读写接口
 *   2. 设置变更事件广播
 *   3. localStorage 缓存 + Electron IPC 双重持久化
 *   4. 浏览器环境回退支持
 *   5. 配置验证、迁移、快照管理
 *   6. 新增分类：通知、日志、存储、代理、实验性功能、关于系统
 *
 * 使用方式：
 *   const settings = window.TriCoreSettings;
 *   await settings.load();
 *   settings.get('ui.theme');        // 读取
 *   await settings.set('ui.theme', 'light'); // 写入
 */

'use strict';

(function () {
  // 检查是否在 Electron 环境
  const isElectron = !!(window.triCoreAPI && window.triCoreAPI.getConfig);
  const API = window.triCoreAPI;

  // ── 默认设置值（与后端 ConfigManager DEFAULT_CONFIG 保持同步） ──
  const DEFAULTS = {
    llm: {
      provider: 'deepseek',
      apiKey: '',
      model: '',
      fallbackChain: ['deepseek', 'qwen', 'zhipu', 'moonshot', 'openai', 'anthropic', 'google'],
      baseUrl: '',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 0.95,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxRetries: 3,
      requestTimeout: 120000,
      enableStreaming: true,
    },
    scheduler: {
      awakeningTicks: 10,
      maxConsciousnessTicksPerHour: 12,
      tickIntervalIdle: 300000,
      tickIntervalActive: 30000,
      schedulerMode: 'adaptive',
      quietHoursStart: '23:00',
      quietHoursEnd: '07:00',
      enableQuietHours: true,
    },
    social: {
      discord: { botToken: '', enabled: false, channels: [], autoReply: false },
      wechat: { accountId: '', botToken: '', enabled: false },
      feishu: { appId: '', appSecret: '', enabled: false },
      wecom: { key: '', enabled: false },
    },
    voice: {
      asrProvider: 'local_whisper',
      ttsProvider: 'doubao',
      whisperModel: 'base',
      ttsVoice: 'zh-CN-XiaoxiaoNeural',
      ttsSpeed: 1.0,
      ttsVolume: 1.0,
      autoDetectLanguage: true,
    },
    browser: {
      headless: true,
      defaultSearchEngine: 'bing',
      userAgent: '',
      viewportWidth: 1280,
      viewportHeight: 720,
      timeout: 30000,
      maxConcurrentTabs: 5,
      enableStealth: true,
      proxyServer: '',
    },
    ui: {
      theme: 'dark',
      fontSize: 13,
      language: 'zh-CN',
      autoStart: false,
      minimizeToTray: true,
      showOnStartup: true,
      sidebarCollapsed: false,
      enableAnimations: true,
      compactMode: false,
      showAgentStatusBar: true,
      showTokenUsage: true,
    },
    api: {
      port: 3721,
      host: '127.0.0.1',
      allowLan: false,
      apiToken: '',
      corsOrigins: [],
      rateLimitRPM: 60,
      enableWebSocket: true,
      enableSSE: true,
      maxRequestBodySize: 10485760,
    },
    security: {
      maxConsciousnessTaskBudget: 5000,
      maxAutonomousSteps: 5,
      maxIdleThinkPerHour: 10,
      enableSafeMode: false,
      autoApproveReadOnly: true,
      requireConfirmationForWrite: true,
      requireConfirmationForNetwork: true,
      requireConfirmationForShell: true,
      allowedDomains: [],
      blockedDomains: [],
    },
    budget: {
      hourlyBudget: 100000,
      dailyBudget: 1000000,
      consciousnessRatio: 0.4,
      executionRatio: 0.4,
      evolutionRatio: 0.1,
      warningThreshold: 0.8,
      autoPauseOnExceed: true,
      showBudgetAlerts: true,
    },
    // ═══ 新增分类 v6.0 ═══
    notifications: {
      enabled: true,
      soundEnabled: true,
      desktopNotifications: true,
      showInTray: true,
      notifyOnTaskComplete: true,
      notifyOnError: true,
      notifyOnMessage: true,
      notifyOnEvolution: false,
      notifyOnBudgetWarning: true,
      quietHoursMatchScheduler: true,
      soundFile: 'default',
      soundVolume: 0.7,
    },
    logging: {
      level: 'info',
      consoleOutput: true,
      fileOutput: true,
      logDir: './logs',
      maxFileSize: 10485760,
      maxFiles: 10,
      includeTimestamp: true,
      includeSourceLocation: false,
      structuredFormat: true,
      sensitiveDataMasking: true,
      auditLog: true,
      performanceLog: false,
    },
    storage: {
      memoryPath: './data/memory',
      configPath: './data/config',
      maxMemorySize: 524288000,
      autoCompact: true,
      compactThreshold: 0.8,
      backupEnabled: true,
      backupInterval: 86400000,
      maxBackups: 5,
      backupDir: './data/backups',
      compressionEnabled: true,
    },
    proxy: {
      enabled: false,
      httpProxy: '',
      httpsProxy: '',
      noProxy: 'localhost,127.0.0.1',
      proxyAuth: '',
      proxyBypassForLLM: false,
      proxyBypassForBrowser: false,
    },
    experimental: {
      enablePlugins: false,
      enableCustomTools: false,
      enableVision: true,
      enableRAG: true,
      enableMultiModal: false,
      enableCodeExecution: true,
      enableSubAgents: true,
      enableAutoEvolution: false,
      developerMode: false,
      showAdvancedOptions: false,
      enableBetaFeatures: false,
    },
    about: {
      version: '1.0.0',
      buildDate: '',
      codename: 'TriCore',
      brandName: '蜜糖 TriCore Agent',
      lastUpdated: '',
      configVersion: 6,
    },
  };

  // ── 设置项定义（用于渲染设置面板） ──
  const SCHEMA = [
    {
      id: 'llm',
      title: '🤖 LLM 模型配置',
      icon: '🤖',
      description: '配置AI模型提供商、API密钥和模型参数',
      groups: [
        {
          id: 'llm-provider',
          fields: [
            {
              key: 'llm.provider', label: '模型提供商', type: 'select',
              options: [
                { value: 'deepseek', label: '🔥 DeepSeek (深度求索)' },
                { value: 'qwen', label: '通义千问 Qwen (阿里云)' },
                { value: 'zhipu', label: '智谱AI ChatGLM (Zhipu)' },
                { value: 'moonshot', label: '月之暗面 Kimi (Moonshot)' },
                { value: 'minimax', label: 'MiniMax / 海螺AI' },
                { value: 'baichuan', label: '百川智能 (Baichuan)' },
                { value: 'stepfun', label: '阶跃星辰 (StepFun)' },
                { value: '01ai', label: '零一万物 Yi (01.AI)' },
                { value: 'bytedance', label: '字节跳动 豆包 (ByteDance)' },
                { value: 'baidu', label: '百度 文心一言 (ERNIE)' },
                { value: 'tencent', label: '腾讯 混元 (HunYuan)' },
                { value: 'iflytek', label: '科大讯飞 星火 (Spark)' },
                { value: 'senseTime', label: '商汤 日日新 (SenseNova)' },
                { value: 'huawei', label: '华为 盘古 (Pangu)' },
                { value: 'kunlun', label: '昆仑万维 天工 (Skywork)' },
                { value: 'shusheng', label: '书生·浦语 (InternLM)' },
                { value: 'vivo', label: 'vivo 蓝心 (BlueLM)' },
                { value: 'xiaomi', label: '小米 MiLM' },
                { value: 'lingyi', label: '灵汐AI / 序列猴子' },
                { value: 'teleAI', label: '中国电信 星辰 (TeleAI)' },
                { value: 'cmcc', label: '中国移动 九天 (CMCC)' },
                { value: 'inspur', label: '浪潮 源 (Yuan)' },
                { value: 'speechocean', label: '海天瑞声' },
                { value: 'openai', label: 'OpenAI (GPT / o-series)' },
                { value: 'anthropic', label: 'Anthropic Claude' },
                { value: 'google', label: 'Google Gemini' },
                { value: 'meta', label: 'Meta Llama' },
                { value: 'mistral', label: 'Mistral AI' },
                { value: 'xai', label: 'xAI Grok (马斯克)' },
                { value: 'cohere', label: 'Cohere' },
                { value: 'ai21', label: 'AI21 Labs (Jurassic)' },
                { value: 'reka', label: 'Reka AI' },
                { value: 'perplexity', label: 'Perplexity AI' },
                { value: 'nvidia', label: 'NVIDIA NIM / Nemotron' },
                { value: 'amazon', label: 'Amazon Bedrock / Titan' },
                { value: 'ibm', label: 'IBM watsonx / Granite' },
                { value: 'snowflake', label: 'Snowflake Arctic' },
                { value: 'databricks', label: 'Databricks DBRX' },
                { value: 'microsoft', label: 'Microsoft Azure AI / Phi' },
                { value: 'oracle', label: 'Oracle Cloud AI' },
                { value: 'samsung', label: 'Samsung Gauss' },
                { value: 'naver', label: 'NAVER HyperCLOVA' },
                { value: 'kakao', label: 'Kakao KoGPT' },
                { value: 'lg', label: 'LG EXAONE' },
                { value: 'upstage', label: 'Upstage Solar' },
                { value: 'stability', label: 'Stability AI (StableLM)' },
                { value: 'writer', label: 'Writer Palmyra' },
                { value: 'adept', label: 'Adept ACT-1' },
                { value: 'inflection', label: 'Inflection AI' },
                { value: 'character', label: 'Character.AI' },
                { value: 'alephAlpha', label: 'Aleph Alpha (Luminous)' },
                { value: 'huggingface', label: 'HuggingFace TGI / Inference' },
                { value: 'groq', label: 'Groq (LPU高速推理)' },
                { value: 'together', label: 'Together AI' },
                { value: 'fireworks', label: 'Fireworks AI' },
                { value: 'anyscale', label: 'Anyscale / Ray Serve' },
                { value: 'deepinfra', label: 'DeepInfra' },
                { value: 'replicate', label: 'Replicate' },
                { value: 'lepton', label: 'Lepton AI' },
                { value: 'octoai', label: 'OctoAI' },
                { value: 'siliconflow', label: '硅基流动 (SiliconFlow)' },
                { value: 'openrouter', label: 'OpenRouter (聚合路由)' },
                { value: 'venus', label: 'Venus AI (聚合)' },
                { value: 'ollama', label: 'Ollama (本地部署)' },
                { value: 'vllm', label: 'vLLM (本地推理)' },
                { value: 'localai', label: 'LocalAI' },
                { value: 'textGenWebUI', label: 'Text Generation WebUI' },
                { value: 'lmstudio', label: 'LM Studio' },
                { value: 'jan', label: 'Jan AI' },
                { value: 'gpt4all', label: 'GPT4All (本地)' },
                { value: 'llamaCpp', label: 'llama.cpp (本地推理)' },
                { value: 'exo', label: 'Exo (分布式集群)' },
                { value: 'custom', label: '⚙️ 自定义 / OpenAI兼容' },
              ],
              default: 'deepseek',
            },
            { key: 'llm.apiKey', label: 'API 密钥', type: 'password', placeholder: '输入API密钥...', default: '' },
            { key: 'llm.model', label: '模型名称', type: 'text', placeholder: '例如: deepseek-chat, gpt-4o', default: '' },
            { key: 'llm.baseUrl', label: '自定义 API 地址', type: 'text', placeholder: '留空使用默认地址', default: '' },
            { key: 'llm.temperature', label: 'Temperature (温度)', type: 'range', min: 0, max: 2, step: 0.1, default: 0.7 },
            { key: 'llm.maxTokens', label: '最大 Token 数', type: 'number', min: 256, max: 131072, default: 4096 },
            { key: 'llm.topP', label: 'Top-P (核采样)', type: 'range', min: 0, max: 1, step: 0.05, default: 0.95 },
            { key: 'llm.fallbackChain', label: 'Provider 降级链', type: 'tags', default: 'deepseek,qwen,zhipu,moonshot,openai,anthropic,google', placeholder: '逗号分隔' },
          ],
        },
        {
          id: 'llm-advanced',
          title: '高级参数',
          fields: [
            { key: 'llm.frequencyPenalty', label: '频率惩罚', type: 'range', min: -2, max: 2, step: 0.1, default: 0 },
            { key: 'llm.presencePenalty', label: '存在惩罚', type: 'range', min: -2, max: 2, step: 0.1, default: 0 },
            { key: 'llm.maxRetries', label: '最大重试次数', type: 'number', min: 0, max: 10, default: 3 },
            { key: 'llm.requestTimeout', label: '请求超时 (ms)', type: 'number', min: 5000, max: 600000, step: 5000, default: 120000, unit: 'ms' },
            { key: 'llm.enableStreaming', label: '启用流式输出', type: 'toggle', default: true },
          ],
        },
      ],
    },
    {
      id: 'ui',
      title: '🎨 界面与外观',
      icon: '🎨',
      description: '自定义界面主题、字体大小和显示行为',
      groups: [
        {
          id: 'ui-appearance',
          fields: [
            { key: 'ui.theme', label: '界面主题', type: 'select', options: [
              { value: 'dark', label: '🌙 暗色 (Dark)' },
              { value: 'light', label: '☀️ 亮色 (Light)' },
              { value: 'system', label: '💻 跟随系统' },
            ], default: 'dark' },
            { key: 'ui.fontSize', label: '字体大小', type: 'range', min: 10, max: 22, step: 1, default: 13, unit: 'px' },
            { key: 'ui.language', label: '界面语言', type: 'select', options: [
              { value: 'zh-CN', label: '简体中文' },
              { value: 'zh-TW', label: '繁體中文' },
              { value: 'en-US', label: 'English' },
              { value: 'ja-JP', label: '日本語' },
            ], default: 'zh-CN' },
            { key: 'ui.compactMode', label: '紧凑模式', type: 'toggle', default: false, description: '减小间距，显示更多内容' },
            { key: 'ui.enableAnimations', label: '启用动画效果', type: 'toggle', default: true },
          ],
        },
        {
          id: 'ui-behavior',
          title: '窗口行为',
          fields: [
            { key: 'ui.autoStart', label: '开机自启动', type: 'toggle', default: false },
            { key: 'ui.minimizeToTray', label: '关闭时最小化到托盘', type: 'toggle', default: true },
            { key: 'ui.showOnStartup', label: '启动时显示窗口', type: 'toggle', default: true },
            { key: 'ui.sidebarCollapsed', label: '默认折叠侧边栏', type: 'toggle', default: false },
          ],
        },
        {
          id: 'ui-display',
          title: '显示选项',
          fields: [
            { key: 'ui.showAgentStatusBar', label: '显示Agent状态栏', type: 'toggle', default: true },
            { key: 'ui.showTokenUsage', label: '显示Token用量', type: 'toggle', default: true, description: '在界面上实时显示Token消耗' },
          ],
        },
      ],
    },
    {
      id: 'scheduler',
      title: '⏱ 调度器配置',
      icon: '⏱',
      description: '调整Agent调度节奏、静默时段和意识配额',
      groups: [
        {
          id: 'scheduler-ticks',
          fields: [
            { key: 'scheduler.awakeningTicks', label: '觉醒 TICK 数', type: 'range', min: 1, max: 50, step: 1, default: 10 },
            { key: 'scheduler.maxConsciousnessTicksPerHour', label: '每小时最大意识 TICK', type: 'range', min: 1, max: 60, step: 1, default: 12 },
            { key: 'scheduler.tickIntervalIdle', label: '空闲 TICK 间隔 (ms)', type: 'number', min: 10000, max: 3600000, step: 10000, default: 300000, unit: 'ms' },
            { key: 'scheduler.tickIntervalActive', label: '活跃 TICK 间隔 (ms)', type: 'number', min: 1000, max: 300000, step: 5000, default: 30000, unit: 'ms' },
            { key: 'scheduler.schedulerMode', label: '调度模式', type: 'select', options: [
              { value: 'adaptive', label: '自适应 (推荐)' },
              { value: 'fixed', label: '固定间隔' },
              { value: 'event-driven', label: '事件驱动' },
              { value: 'idle', label: '仅在空闲时' },
            ], default: 'adaptive' },
          ],
        },
        {
          id: 'scheduler-quiet',
          title: '静默时段',
          fields: [
            { key: 'scheduler.enableQuietHours', label: '启用静默时段', type: 'toggle', default: true, description: '在指定时间段内降低活动频率' },
            { key: 'scheduler.quietHoursStart', label: '静默开始时间', type: 'text', default: '23:00', placeholder: 'HH:MM' },
            { key: 'scheduler.quietHoursEnd', label: '静默结束时间', type: 'text', default: '07:00', placeholder: 'HH:MM' },
          ],
        },
      ],
    },
    {
      id: 'api',
      title: '🔌 API 服务配置',
      icon: '🔌',
      description: '配置HTTP API服务器、WebSocket和访问控制',
      groups: [
        {
          id: 'api-server',
          fields: [
            { key: 'api.port', label: '监听端口', type: 'number', min: 1024, max: 65535, default: 3721 },
            { key: 'api.host', label: '监听地址', type: 'text', default: '127.0.0.1' },
            { key: 'api.allowLan', label: '允许局域网访问', type: 'toggle', default: false },
            { key: 'api.apiToken', label: 'API 访问令牌', type: 'password', placeholder: '留空则不启用令牌验证', default: '' },
            { key: 'api.rateLimitRPM', label: '每分钟速率限制', type: 'number', min: 1, max: 10000, default: 60 },
            { key: 'api.enableWebSocket', label: '启用 WebSocket', type: 'toggle', default: true },
            { key: 'api.enableSSE', label: '启用 SSE 事件流', type: 'toggle', default: true },
            { key: 'api.maxRequestBodySize', label: '最大请求体 (bytes)', type: 'number', min: 1024, max: 104857600, step: 1024, default: 10485760, unit: 'B' },
          ],
        },
      ],
    },
    {
      id: 'security',
      title: '🛡 安全设置',
      icon: '🛡',
      description: '自主行为边界和安全策略配置',
      groups: [
        {
          id: 'security-boundaries',
          title: '行为边界',
          fields: [
            { key: 'security.maxConsciousnessTaskBudget', label: '意识任务最大预算 (tokens)', type: 'number', min: 1000, max: 100000, step: 1000, default: 5000 },
            { key: 'security.maxAutonomousSteps', label: '最大自主步骤数', type: 'range', min: 1, max: 20, step: 1, default: 5 },
            { key: 'security.maxIdleThinkPerHour', label: '每小时最大空闲思考次数', type: 'range', min: 1, max: 30, step: 1, default: 10 },
            { key: 'security.enableSafeMode', label: '启用安全模式', type: 'toggle', default: false, description: '启用后所有危险操作需人工确认' },
          ],
        },
        {
          id: 'security-confirmations',
          title: '确认策略',
          fields: [
            { key: 'security.autoApproveReadOnly', label: '自动批准只读操作', type: 'toggle', default: true },
            { key: 'security.requireConfirmationForWrite', label: '写入操作需确认', type: 'toggle', default: true },
            { key: 'security.requireConfirmationForNetwork', label: '网络请求需确认', type: 'toggle', default: true },
            { key: 'security.requireConfirmationForShell', label: 'Shell命令需确认', type: 'toggle', default: true },
          ],
        },
        {
          id: 'security-domains',
          title: '域名过滤',
          fields: [
            { key: 'security.allowedDomains', label: '允许域名列表', type: 'tags', default: '', placeholder: '允许访问的域名' },
            { key: 'security.blockedDomains', label: '禁止域名列表', type: 'tags', default: '', placeholder: '禁止访问的域名' },
          ],
        },
      ],
    },
    {
      id: 'budget',
      title: '💰 Token 预算',
      icon: '💰',
      description: '管理三核之间的Token预算分配与告警',
      groups: [
        {
          id: 'budget-limits',
          title: '预算限制',
          fields: [
            { key: 'budget.hourlyBudget', label: '每小时 Token 预算', type: 'number', min: 1000, max: 10000000, step: 1000, default: 100000 },
            { key: 'budget.dailyBudget', label: '每日 Token 预算', type: 'number', min: 10000, max: 100000000, step: 10000, default: 1000000 },
          ],
        },
        {
          id: 'budget-ratio',
          title: '三核预算比例',
          fields: [
            { key: 'budget.consciousnessRatio', label: '意识核比例', type: 'range', min: 0.1, max: 0.9, step: 0.05, default: 0.4 },
            { key: 'budget.executionRatio', label: '执行核比例', type: 'range', min: 0.1, max: 0.9, step: 0.05, default: 0.4 },
            { key: 'budget.evolutionRatio', label: '进化核比例', type: 'range', min: 0.01, max: 0.5, step: 0.01, default: 0.1 },
          ],
        },
        {
          id: 'budget-alerts',
          title: '预算告警',
          fields: [
            { key: 'budget.warningThreshold', label: '告警阈值', type: 'range', min: 0.5, max: 1, step: 0.05, default: 0.8, description: '使用率达到此阈值时触发告警' },
            { key: 'budget.autoPauseOnExceed', label: '超出预算自动暂停', type: 'toggle', default: true },
            { key: 'budget.showBudgetAlerts', label: '显示预算告警', type: 'toggle', default: true },
          ],
        },
      ],
    },
    {
      id: 'voice',
      title: '🎤 语音配置',
      icon: '🎤',
      description: '语音识别和合成引擎配置',
      groups: [
        {
          id: 'voice-engine',
          fields: [
            { key: 'voice.asrProvider', label: '语音识别 (ASR)', type: 'select', options: [
              { value: 'local_whisper', label: '本地 Whisper' },
              { value: 'openai_whisper', label: 'OpenAI Whisper API' },
              { value: 'doubao', label: '豆包语音' },
            ], default: 'local_whisper' },
            { key: 'voice.ttsProvider', label: '语音合成 (TTS)', type: 'select', options: [
              { value: 'doubao', label: '豆包语音' },
              { value: 'openai', label: 'OpenAI TTS' },
              { value: 'edge', label: 'Microsoft Edge TTS' },
            ], default: 'doubao' },
            { key: 'voice.whisperModel', label: 'Whisper 模型', type: 'select', options: [
              { value: 'tiny', label: 'Tiny (最快)' },
              { value: 'base', label: 'Base (推荐)' },
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large (最准确)' },
            ], default: 'base' },
            { key: 'voice.ttsVoice', label: 'TTS 语音', type: 'text', default: 'zh-CN-XiaoxiaoNeural' },
            { key: 'voice.ttsSpeed', label: '语速', type: 'range', min: 0.5, max: 2, step: 0.1, default: 1.0 },
            { key: 'voice.ttsVolume', label: '音量', type: 'range', min: 0, max: 1, step: 0.1, default: 1.0 },
            { key: 'voice.autoDetectLanguage', label: '自动检测语言', type: 'toggle', default: true },
          ],
        },
      ],
    },
    {
      id: 'browser',
      title: '🌐 浏览器设置',
      icon: '🌐',
      description: '内置浏览器自动化配置',
      groups: [
        {
          id: 'browser-config',
          fields: [
            { key: 'browser.headless', label: '无头模式', type: 'toggle', default: true, description: '后台运行浏览器，不显示窗口' },
            { key: 'browser.defaultSearchEngine', label: '默认搜索引擎', type: 'select', options: [
              { value: 'bing', label: 'Bing' }, { value: 'google', label: 'Google' },
              { value: 'baidu', label: '百度' }, { value: 'duckduckgo', label: 'DuckDuckGo' },
            ], default: 'bing' },
            { key: 'browser.viewportWidth', label: '视口宽度', type: 'number', min: 320, max: 3840, step: 10, default: 1280, unit: 'px' },
            { key: 'browser.viewportHeight', label: '视口高度', type: 'number', min: 240, max: 2160, step: 10, default: 720, unit: 'px' },
            { key: 'browser.timeout', label: '页面超时 (ms)', type: 'number', min: 5000, max: 120000, step: 5000, default: 30000, unit: 'ms' },
            { key: 'browser.maxConcurrentTabs', label: '最大并发标签页', type: 'number', min: 1, max: 20, default: 5 },
            { key: 'browser.enableStealth', label: '启用反检测模式', type: 'toggle', default: true },
            { key: 'browser.proxyServer', label: '代理服务器', type: 'text', placeholder: '例如: http://127.0.0.1:7890', default: '' },
            { key: 'browser.userAgent', label: '自定义 User-Agent', type: 'text', placeholder: '留空使用默认', default: '' },
          ],
        },
      ],
    },
    {
      id: 'social',
      title: '📡 社交渠道',
      icon: '📡',
      description: '配置Discord、微信、飞书、企业微信等社交平台集成',
      groups: [
        {
          id: 'social-discord',
          title: 'Discord',
          fields: [
            { key: 'social.discord.enabled', label: '启用 Discord', type: 'toggle', default: false },
            { key: 'social.discord.botToken', label: 'Bot Token', type: 'password', placeholder: 'Discord Bot Token', default: '' },
          ],
        },
        {
          id: 'social-wechat',
          title: '微信',
          fields: [
            { key: 'social.wechat.enabled', label: '启用微信', type: 'toggle', default: false },
            { key: 'social.wechat.botToken', label: 'Bot Token', type: 'password', placeholder: '微信 Bot Token', default: '' },
            { key: 'social.wechat.accountId', label: '账号 ID', type: 'text', placeholder: '微信账号标识', default: '' },
          ],
        },
        {
          id: 'social-feishu',
          title: '飞书',
          fields: [
            { key: 'social.feishu.enabled', label: '启用飞书', type: 'toggle', default: false },
            { key: 'social.feishu.appId', label: 'App ID', type: 'text', default: '' },
            { key: 'social.feishu.appSecret', label: 'App Secret', type: 'password', default: '' },
          ],
        },
        {
          id: 'social-wecom',
          title: '企业微信',
          fields: [
            { key: 'social.wecom.enabled', label: '启用企业微信', type: 'toggle', default: false },
            { key: 'social.wecom.key', label: 'Webhook Key', type: 'text', placeholder: '企业微信机器人 Key', default: '' },
          ],
        },
      ],
    },
    // ═══ v6.0 新增分类 ═══
    {
      id: 'notifications',
      title: '🔔 通知设置',
      icon: '🔔',
      description: '管理系统通知、桌面提醒和声音提示',
      groups: [
        {
          id: 'notifications-general',
          title: '通用设置',
          fields: [
            { key: 'notifications.enabled', label: '启用通知', type: 'toggle', default: true },
            { key: 'notifications.soundEnabled', label: '启用声音', type: 'toggle', default: true },
            { key: 'notifications.desktopNotifications', label: '桌面通知', type: 'toggle', default: true },
            { key: 'notifications.showInTray', label: '托盘图标提示', type: 'toggle', default: true },
            { key: 'notifications.soundVolume', label: '音量', type: 'range', min: 0, max: 1, step: 0.1, default: 0.7 },
          ],
        },
        {
          id: 'notifications-events',
          title: '通知事件',
          fields: [
            { key: 'notifications.notifyOnTaskComplete', label: '任务完成时通知', type: 'toggle', default: true },
            { key: 'notifications.notifyOnError', label: '发生错误时通知', type: 'toggle', default: true },
            { key: 'notifications.notifyOnMessage', label: '收到新消息时通知', type: 'toggle', default: true },
            { key: 'notifications.notifyOnEvolution', label: '进化事件通知', type: 'toggle', default: false },
            { key: 'notifications.notifyOnBudgetWarning', label: '预算告警通知', type: 'toggle', default: true },
            { key: 'notifications.quietHoursMatchScheduler', label: '静默时段跟随调度器', type: 'toggle', default: true, description: '在调度器静默时段内暂停非紧急通知' },
          ],
        },
      ],
    },
    {
      id: 'logging',
      title: '📋 日志配置',
      icon: '📋',
      description: '配置日志级别、输出格式和文件管理',
      groups: [
        {
          id: 'logging-general',
          title: '日志级别与输出',
          fields: [
            { key: 'logging.level', label: '日志级别', type: 'select', options: [
              { value: 'debug', label: '🐛 Debug (最详细)' },
              { value: 'info', label: 'ℹ️ Info (推荐)' },
              { value: 'warn', label: '⚠️ Warn' },
              { value: 'error', label: '❌ Error (仅错误)' },
              { value: 'silent', label: '🔇 Silent (静默)' },
            ], default: 'info' },
            { key: 'logging.consoleOutput', label: '控制台输出', type: 'toggle', default: true },
            { key: 'logging.fileOutput', label: '文件输出', type: 'toggle', default: true },
            { key: 'logging.logDir', label: '日志目录', type: 'text', default: './logs' },
          ],
        },
        {
          id: 'logging-rotation',
          title: '日志轮转',
          fields: [
            { key: 'logging.maxFileSize', label: '单文件最大大小', type: 'number', min: 1048576, max: 104857600, step: 1048576, default: 10485760, unit: 'B' },
            { key: 'logging.maxFiles', label: '最大文件数', type: 'number', min: 1, max: 100, default: 10 },
          ],
        },
        {
          id: 'logging-format',
          title: '日志格式',
          fields: [
            { key: 'logging.includeTimestamp', label: '包含时间戳', type: 'toggle', default: true },
            { key: 'logging.includeSourceLocation', label: '包含源代码位置', type: 'toggle', default: false },
            { key: 'logging.structuredFormat', label: '结构化格式 (JSON)', type: 'toggle', default: true },
            { key: 'logging.sensitiveDataMasking', label: '敏感数据脱敏', type: 'toggle', default: true },
          ],
        },
        {
          id: 'logging-audit',
          title: '审计与性能',
          fields: [
            { key: 'logging.auditLog', label: '启用审计日志', type: 'toggle', default: true, description: '记录所有关键操作用于审计' },
            { key: 'logging.performanceLog', label: '启用性能日志', type: 'toggle', default: false, description: '记录API调用耗时等性能数据' },
          ],
        },
      ],
    },
    {
      id: 'storage',
      title: '💾 存储管理',
      icon: '💾',
      description: '配置数据存储路径、备份策略和内存限制',
      groups: [
        {
          id: 'storage-paths',
          title: '存储路径',
          fields: [
            { key: 'storage.memoryPath', label: '记忆存储路径', type: 'text', default: './data/memory' },
            { key: 'storage.configPath', label: '配置存储路径', type: 'text', default: './data/config' },
            { key: 'storage.maxMemorySize', label: '最大记忆容量', type: 'number', min: 10485760, max: 10737418240, step: 10485760, default: 524288000, unit: 'B' },
          ],
        },
        {
          id: 'storage-compact',
          title: '自动整理',
          fields: [
            { key: 'storage.autoCompact', label: '启用自动整理', type: 'toggle', default: true, description: '自动清理过期和低价值记忆' },
            { key: 'storage.compactThreshold', label: '整理触发阈值', type: 'range', min: 0.5, max: 0.95, step: 0.05, default: 0.8, description: '存储使用率达到此阈值时触发整理' },
          ],
        },
        {
          id: 'storage-backup',
          title: '备份策略',
          fields: [
            { key: 'storage.backupEnabled', label: '启用自动备份', type: 'toggle', default: true },
            { key: 'storage.backupInterval', label: '备份间隔 (ms)', type: 'number', min: 3600000, max: 604800000, step: 3600000, default: 86400000, unit: 'ms' },
            { key: 'storage.maxBackups', label: '最大备份数', type: 'number', min: 1, max: 50, default: 5 },
            { key: 'storage.backupDir', label: '备份目录', type: 'text', default: './data/backups' },
            { key: 'storage.compressionEnabled', label: '启用压缩', type: 'toggle', default: true },
          ],
        },
      ],
    },
    {
      id: 'proxy',
      title: '🌍 代理设置',
      icon: '🌍',
      description: '配置网络代理服务器',
      groups: [
        {
          id: 'proxy-config',
          fields: [
            { key: 'proxy.enabled', label: '启用代理', type: 'toggle', default: false },
            { key: 'proxy.httpProxy', label: 'HTTP 代理', type: 'text', placeholder: 'http://host:port', default: '' },
            { key: 'proxy.httpsProxy', label: 'HTTPS 代理', type: 'text', placeholder: 'http://host:port', default: '' },
            { key: 'proxy.noProxy', label: '不使用代理的地址', type: 'text', placeholder: 'localhost,127.0.0.1', default: 'localhost,127.0.0.1' },
            { key: 'proxy.proxyAuth', label: '代理认证', type: 'password', placeholder: 'username:password', default: '' },
            { key: 'proxy.proxyBypassForLLM', label: 'LLM不走代理', type: 'toggle', default: false, description: 'LLM API调用直接连接' },
            { key: 'proxy.proxyBypassForBrowser', label: '浏览器不走代理', type: 'toggle', default: false },
          ],
        },
      ],
    },
    {
      id: 'experimental',
      title: '🧪 实验性功能',
      icon: '🧪',
      description: '开启实验性功能和开发者选项',
      groups: [
        {
          id: 'experimental-features',
          title: '功能开关',
          fields: [
            { key: 'experimental.enablePlugins', label: '启用插件系统', type: 'toggle', default: false, description: '允许加载第三方插件' },
            { key: 'experimental.enableCustomTools', label: '启用自定义工具', type: 'toggle', default: false },
            { key: 'experimental.enableVision', label: '启用视觉能力', type: 'toggle', default: true },
            { key: 'experimental.enableRAG', label: '启用RAG检索增强', type: 'toggle', default: true },
            { key: 'experimental.enableMultiModal', label: '启用多模态', type: 'toggle', default: false, description: '图片、音频等多种输入模式' },
            { key: 'experimental.enableCodeExecution', label: '启用代码执行', type: 'toggle', default: true },
            { key: 'experimental.enableSubAgents', label: '启用子智能体', type: 'toggle', default: true },
            { key: 'experimental.enableAutoEvolution', label: '启用自动进化', type: 'toggle', default: false, description: '允许Agent自动优化自身行为' },
          ],
        },
        {
          id: 'experimental-dev',
          title: '开发者选项',
          fields: [
            { key: 'experimental.developerMode', label: '开发者模式', type: 'toggle', default: false, description: '显示调试信息和开发工具' },
            { key: 'experimental.showAdvancedOptions', label: '显示高级选项', type: 'toggle', default: false, description: '在所有分类中显示更多高级配置项' },
            { key: 'experimental.enableBetaFeatures', label: '启用Beta功能', type: 'toggle', default: false, description: '体验最新的测试功能' },
          ],
        },
      ],
    },
    {
      id: 'about',
      title: 'ℹ️ 关于系统',
      icon: 'ℹ️',
      description: '查看系统版本信息和配置摘要',
      groups: [
        {
          id: 'about-info',
          title: '系统信息',
          fields: [
            { key: 'about.brandName', label: '系统名称', type: 'text', default: '蜜糖 TriCore Agent', description: '只读' },
            { key: 'about.codename', label: '代号', type: 'text', default: 'TriCore', description: '只读' },
            { key: 'about.version', label: '版本号', type: 'text', default: '6.0.0', description: '只读' },
            { key: 'about.buildDate', label: '构建日期', type: 'text', default: '', description: '只读' },
            { key: 'about.configVersion', label: '配置版本', type: 'number', default: 6, description: '只读' },
          ],
        },
      ],
    },
  ];

  // ── 配置验证规则 ──
  const VALIDATION_RULES = {
    'llm.temperature': (v) => v >= 0 && v <= 2,
    'llm.maxTokens': (v) => v >= 256 && v <= 131072,
    'api.port': (v) => v >= 1024 && v <= 65535,
    'budget.hourlyBudget': (v) => v >= 1000,
    'budget.dailyBudget': (v) => v >= 10000,
    'scheduler.tickIntervalIdle': (v) => v >= 10000,
    'scheduler.tickIntervalActive': (v) => v >= 1000,
    'storage.maxMemorySize': (v) => v >= 10485760,
    'logging.maxFileSize': (v) => v >= 1048576,
    'proxy.httpProxy': (v) => !v || /^https?:\/\/.+/.test(v),
    'proxy.httpsProxy': (v) => !v || /^https?:\/\/.+/.test(v),
  };

  // ── SettingsManager 类 ──
  class SettingsManager {
    constructor() {
      this._config = JSON.parse(JSON.stringify(DEFAULTS));
      this._listeners = {};
      this._loaded = false;
      this._cacheKey = 'tricore_settings_cache_v6';
      this._migrationKey = 'tricore_settings_migration_version';
      this._currentMigrationVersion = 6;
    }

    /**
     * 加载设置
     */
    async load() {
      if (isElectron) {
        try {
          const config = await API.getAllConfig();
          if (config && Object.keys(config).length > 0) {
            this._config = this._deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), config);
          }
        } catch (e) {
          console.warn('[Settings] IPC加载失败，使用localStorage缓存', e.message);
          this._loadFromCache();
        }
      } else {
        this._loadFromCache();
      }

      // 执行配置迁移
      this._migrateIfNeeded();

      this._loaded = true;
      this._emit('loaded', this._config);
      return this._config;
    }

    _loadFromCache() {
      try {
        const cached = localStorage.getItem(this._cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          this._config = this._deepMerge(this._config, parsed);
        }
      } catch (e) { /* ignore */ }
    }

    _saveToCache() {
      try {
        localStorage.setItem(this._cacheKey, JSON.stringify(this._config));
      } catch (e) { /* ignore */ }
    }

    /**
     * 配置迁移：从旧版本迁移到新版本
     */
    _migrateIfNeeded() {
      const lastVersion = parseInt(localStorage.getItem(this._migrationKey) || '0', 10);
      if (lastVersion >= this._currentMigrationVersion) return;

      console.log(`[Settings] 执行配置迁移: v${lastVersion} → v${this._currentMigrationVersion}`);

      // v5 → v6 迁移
      if (lastVersion < 6) {
        // 确保新增分类存在
        if (!this._config.notifications) {
          this._config.notifications = JSON.parse(JSON.stringify(DEFAULTS.notifications));
        }
        if (!this._config.logging) {
          this._config.logging = JSON.parse(JSON.stringify(DEFAULTS.logging));
        }
        if (!this._config.storage) {
          this._config.storage = JSON.parse(JSON.stringify(DEFAULTS.storage));
        }
        if (!this._config.proxy) {
          this._config.proxy = JSON.parse(JSON.stringify(DEFAULTS.proxy));
        }
        if (!this._config.experimental) {
          this._config.experimental = JSON.parse(JSON.stringify(DEFAULTS.experimental));
        }
        if (!this._config.about) {
          this._config.about = JSON.parse(JSON.stringify(DEFAULTS.about));
        }

        // 迁移旧 ui.language 值
        if (this._config.ui && this._config.ui.language) {
          const langMap = { 'zh': 'zh-CN', 'en': 'en-US', 'ja': 'ja-JP' };
          if (langMap[this._config.ui.language]) {
            this._config.ui.language = langMap[this._config.ui.language];
          }
        }

        // 确保新增字段有默认值
        this._config = this._deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), this._config);
        this._config.about.configVersion = 6;
        this._config.about.lastUpdated = new Date().toISOString();
      }

      localStorage.setItem(this._migrationKey, String(this._currentMigrationVersion));
      this._saveToCache();
    }

    /**
     * 获取设置值
     */
    get(key) {
      if (!key) return this._config;
      const parts = key.split('.');
      let current = this._config;
      for (const part of parts) {
        if (current == null) return undefined;
        current = current[part];
      }
      return current;
    }

    /**
     * 验证设置值
     */
    validate(key, value) {
      const rule = VALIDATION_RULES[key];
      if (rule && !rule(value)) {
        const messages = {
          'llm.temperature': 'Temperature必须在0-2之间',
          'llm.maxTokens': '最大Token数必须在256-131072之间',
          'api.port': '端口号必须在1024-65535之间',
          'budget.hourlyBudget': '每小时预算必须大于1000',
          'budget.dailyBudget': '每日预算必须大于10000',
          'scheduler.tickIntervalIdle': '空闲间隔必须大于10000ms',
          'scheduler.tickIntervalActive': '活跃间隔必须大于1000ms',
          'storage.maxMemorySize': '最大记忆容量必须大于10MB',
          'logging.maxFileSize': '日志文件大小必须大于1MB',
          'proxy.httpProxy': '代理地址格式不正确',
          'proxy.httpsProxy': '代理地址格式不正确',
        };
        return { valid: false, message: messages[key] || '验证失败' };
      }
      return { valid: true };
    }

    /**
     * 设置配置值
     */
    async set(key, value) {
      // 验证
      const validation = this.validate(key, value);
      if (!validation.valid) {
        throw new Error(validation.message);
      }

      // 更新本地缓存
      const parts = key.split('.');
      let current = this._config;
      for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null) current[parts[i]] = {};
        current = current[parts[i]];
      }
      const oldValue = current[parts[parts.length - 1]];
      current[parts[parts.length - 1]] = value;
      this._saveToCache();

      // 通过 IPC 持久化
      if (isElectron) {
        try {
          const result = await API.setConfig(key, value);
          if (result && result.success) {
            this._emit('changed', { key, value, oldValue });
            this._applyImmediate(key, value);
          }
          return result;
        } catch (e) {
          console.warn('[Settings] IPC设置失败', e.message);
          return { success: false, error: e.message };
        }
      } else {
        this._emit('changed', { key, value, oldValue });
        this._applyImmediate(key, value);
        return { success: true };
      }
    }

    /**
     * 批量设置
     */
    async setMultiple(pairs) {
      const results = [];
      for (const [key, value] of pairs) {
        try {
          results.push(await this.set(key, value));
        } catch (e) {
          results.push({ success: false, key, error: e.message });
        }
      }
      return results;
    }

    /**
     * 获取所有设置分类
     */
    getSchema() {
      return SCHEMA;
    }

    /**
     * 获取默认值
     */
    getDefaults() {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }

    /**
     * 获取特定分类的默认值
     */
    getDefaultsFor(category) {
      if (DEFAULTS[category]) {
        return JSON.parse(JSON.stringify(DEFAULTS[category]));
      }
      return null;
    }

    /**
     * 重置所有设置
     */
    async resetAll() {
      this._config = JSON.parse(JSON.stringify(DEFAULTS));
      this._saveToCache();

      if (isElectron) {
        try {
          await API.resetConfig();
        } catch (e) {
          console.warn('[Settings] IPC重置失败', e.message);
        }
      }
      this._emit('reset', this._config);
      this._applyTheme('dark');
    }

    /**
     * 重置特定分类
     */
    async resetCategory(category) {
      if (DEFAULTS[category]) {
        const defaults = JSON.parse(JSON.stringify(DEFAULTS[category]));
        this._config[category] = defaults;
        this._saveToCache();

        // 通过IPC逐个重置
        if (isElectron) {
          try {
            await API.setConfig(category, defaults);
          } catch (e) {
            console.warn('[Settings] IPC分类重置失败', e.message);
          }
        }
        this._emit('changed', { key: category, value: defaults });
        return true;
      }
      return false;
    }

    /**
     * 导出设置（支持脱敏）
     */
    async exportConfig(sanitize = false) {
      if (isElectron) {
        try {
          const config = await API.exportConfig();
          return sanitize ? this._sanitize(config) : config;
        } catch (e) {
          const config = JSON.parse(JSON.stringify(this._config));
          return sanitize ? this._sanitize(config) : config;
        }
      }
      const config = JSON.parse(JSON.stringify(this._config));
      return sanitize ? this._sanitize(config) : config;
    }

    /**
     * 导入设置
     */
    async importConfig(config) {
      if (isElectron) {
        try {
          const result = await API.importConfig(config);
          if (result.success) {
            await this.load();
          }
          return result;
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      this._config = this._deepMerge(this._config, config);
      this._saveToCache();
      this._emit('changed', { key: '__import__', value: config });
      return { success: true };
    }

    /**
     * 获取配置摘要（用于统计面板）
     */
    getSummary() {
      return {
        version: this._config.about?.configVersion || this._currentMigrationVersion,
        totalCategories: SCHEMA.length,
        llmProvider: this._config.llm?.provider || 'deepseek',
        theme: this._config.ui?.theme || 'dark',
        apiPort: this._config.api?.port || 3721,
        hasApiToken: !!this._config.api?.apiToken,
        socialEnabled: this._getEnabledSocialChannels(),
        notificationsEnabled: this._config.notifications?.enabled || false,
        safeMode: this._config.security?.enableSafeMode || false,
        developerMode: this._config.experimental?.developerMode || false,
        lastUpdated: this._config.about?.lastUpdated || '',
      };
    }

    _getEnabledSocialChannels() {
      const social = this._config.social || {};
      const channels = [];
      if (social.discord?.enabled) channels.push('Discord');
      if (social.wechat?.enabled) channels.push('微信');
      if (social.feishu?.enabled) channels.push('飞书');
      if (social.wecom?.enabled) channels.push('企业微信');
      return channels;
    }

    /**
     * 应用即时生效的设置
     */
    _applyImmediate(key, value) {
      switch (key) {
        case 'ui.theme':
          this._applyTheme(value);
          break;
        case 'ui.fontSize':
          document.documentElement.style.setProperty('--font-size-base', value + 'px');
          document.documentElement.style.fontSize = value + 'px';
          break;
        case 'ui.compactMode':
          document.documentElement.classList.toggle('compact-mode', value);
          break;
        case 'ui.enableAnimations':
          document.documentElement.classList.toggle('no-animations', !value);
          break;
        case 'experimental.developerMode':
          document.documentElement.classList.toggle('dev-mode', value);
          break;
      }
    }

    _applyTheme(theme) {
      const root = document.documentElement;
      root.setAttribute('data-theme', theme);

      if (theme === 'light') {
        root.style.setProperty('--bg-primary', '#f5f5f5');
        root.style.setProperty('--bg-secondary', '#ffffff');
        root.style.setProperty('--bg-tertiary', '#e8e8e8');
        root.style.setProperty('--bg-card', '#ffffff');
        root.style.setProperty('--bg-hover', '#e8e8f0');
        root.style.setProperty('--text-primary', '#1a1a2e');
        root.style.setProperty('--text-secondary', '#555577');
        root.style.setProperty('--text-muted', '#8888aa');
        root.style.setProperty('--border-color', '#d0d0e0');
        root.style.setProperty('--shadow', '0 2px 12px rgba(0,0,0,0.1)');
      } else if (theme === 'system') {
        if (window.matchMedia('(prefers-color-scheme: light)').matches) {
          this._applyTheme('light');
        } else {
          this._applyTheme('dark');
        }
      } else {
        root.style.setProperty('--bg-primary', '#0a0a1a');
        root.style.setProperty('--bg-secondary', '#111128');
        root.style.setProperty('--bg-tertiary', '#1a1a3e');
        root.style.setProperty('--bg-card', '#16163a');
        root.style.setProperty('--bg-hover', '#222260');
        root.style.setProperty('--text-primary', '#e0e0ff');
        root.style.setProperty('--text-secondary', '#8888bb');
        root.style.setProperty('--text-muted', '#555580');
        root.style.setProperty('--border-color', '#2a2a5a');
        root.style.setProperty('--shadow', '0 2px 12px rgba(0,0,0,0.4)');
      }
    }

    _sanitize(config) {
      const sanitized = JSON.parse(JSON.stringify(config));
      const sensitiveKeys = ['apiKey', 'apiToken', 'botToken', 'appSecret', 'password', 'secret', 'token', 'proxyAuth'];
      const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
          if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
            if (typeof obj[key] === 'string' && obj[key]) {
              obj[key] = '***SANITIZED***';
            }
          } else if (typeof obj[key] === 'object') {
            walk(obj[key]);
          }
        }
      };
      walk(sanitized);
      return sanitized;
    }

    /**
     * 事件监听
     */
    on(event, callback) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(callback);
      return () => {
        this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
      };
    }

    _emit(event, data) {
      if (this._listeners[event]) {
        this._listeners[event].forEach(cb => {
          try { cb(data); } catch (e) { console.error(e); }
        });
      }
    }

    _deepMerge(target, source) {
      const result = { ...target };
      for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          result[key] = this._deepMerge(target[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
      return result;
    }
  }

  // ── 暴露全局单例 ──
  const instance = new SettingsManager();
  window.TriCoreSettings = instance;

  // 监听来自主进程的配置变更事件
  if (API && API.on) {
    API.on('agent:config_changed', (data) => {
      if (data && data.key) {
        const parts = data.key.split('.');
        let current = instance._config;
        for (let i = 0; i < parts.length - 1; i++) {
          if (current[parts[i]] == null) current[parts[i]] = {};
          current = current[parts[i]];
        }
        current[parts[parts.length - 1]] = data.value;
        instance._saveToCache();
        instance._emit('changed', data);
        instance._applyImmediate(data.key, data.value);
      }
    });

    API.on('agent:config_reset', () => {
      instance._config = JSON.parse(JSON.stringify(DEFAULTS));
      instance._saveToCache();
      instance._emit('reset', instance._config);
      instance._applyTheme('dark');
    });

    API.on('agent:config_imported', async () => {
      await instance.load();
    });
  }

  console.log('[蜜糖 TriCore Settings v6.0] 共享设置管理器已初始化 (Electron: ' + isElectron + ', 分类: ' + SCHEMA.length + ')');
})();
