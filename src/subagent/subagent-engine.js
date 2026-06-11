/**
 * 蜜糖 TriCore Agent - 子智能体独立引擎 (Sub-Agent Engine)
 *
 * 核心职责：
 *   1. 独立对话能力 - 子智能体拥有独立的对话循环与上下文管理
 *   2. 独立推理能力 - 基于类型和能力的不同推理策略
 *   3. 工具调用 - 受限的工具集调用（受安全边界约束）
 *   4. 会话管理 - 多会话支持，会话隔离，历史持久化
 *   5. 记忆系统 - 独立的工作记忆与长期记忆
 *   6. 消息路由 - 接收/处理/回复消息的完整管道
 *   7. 任务自主执行 - 接收任务后自主规划与执行
 *
 * 架构设计：
 *   母Agent (TriCoreAgent) ──监管──▶ SubAgentEngine
 *                                     │
 *                            ┌────────┼────────┐
 *                            │        │        │
 *                       对话管道   推理管道   执行管道
 *                            │        │        │
 *                     ┌──────┴──┐ ┌──┴────┐ ┌─┴──────┐
 *                     │会话管理器│ │推理引擎│ │工具调度器│
 *                     └─────────┘ └───────┘ └────────┘
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ── 常量 ──

const ENGINE_STATE = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  EXECUTING: 'executing',
  RESPONDING: 'responding',
  ERROR: 'error',
});

const SESSION_STATUS = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  CLOSED: 'closed',
});

const MESSAGE_ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
  ERROR: 'error',
});

const REASONING_MODE = Object.freeze({
  DIRECT: 'direct',           // 直接回答
  ANALYTICAL: 'analytical',   // 分析推理
  PLANNING: 'planning',       // 任务规划
  REFLECTIVE: 'reflective',   // 反思推理
});

const DEFAULT_CONFIG = {
  maxSessions: 20,
  maxMessagesPerSession: 500,
  maxContextTokens: 8000,
  maxToolsPerRequest: 10,
  thinkingTimeout: 120000,
  responseTimeout: 60000,
  sessionTTL: 86400000,       // 24小时
  persistEnabled: true,
  dataDir: null,
};

// ── 能力模板 ──

const CAPABILITY_TEMPLATES = {
  assistant: {
    reasoning: REASONING_MODE.DIRECT,
    systemPrompt: '你是一个通用助手子智能体，负责回答用户问题、提供信息咨询和日常对话。请保持友好、专业和乐于助人的态度。',
    allowedActions: ['read', 'search', 'query', 'summarize', 'translate', 'explain'],
    tools: ['knowledge_search', 'text_summarize', 'language_translate', 'web_fetch'],
  },
  analyst: {
    reasoning: REASONING_MODE.ANALYTICAL,
    systemPrompt: '你是一个数据分析子智能体，擅长数据挖掘、统计分析、报告生成和数据可视化建议。请用数据驱动的方式思考和回答问题。',
    allowedActions: ['read', 'search', 'query', 'analyze', 'compute', 'visualize'],
    tools: ['data_query', 'statistical_analysis', 'report_generate', 'chart_suggest'],
  },
  executor: {
    reasoning: REASONING_MODE.PLANNING,
    systemPrompt: '你是一个任务执行子智能体，负责将复杂任务分解为可执行步骤，并逐步完成。请以结构化、高效的方式规划并执行任务。',
    allowedActions: ['read', 'write', 'execute', 'schedule', 'automate'],
    tools: ['task_decompose', 'file_operation', 'schedule_task', 'automation_script'],
  },
  monitor: {
    reasoning: REASONING_MODE.REFLECTIVE,
    systemPrompt: '你是一个监控守护子智能体，负责系统健康检查、异常告警、日志分析和安全监控。请保持警惕并及时报告异常。',
    allowedActions: ['read', 'check', 'monitor', 'alert', 'log'],
    tools: ['health_check', 'log_analyze', 'alert_trigger', 'metrics_query'],
  },
  custom: {
    reasoning: REASONING_MODE.DIRECT,
    systemPrompt: '你是一个自定义子智能体，根据用户需求灵活响应。',
    allowedActions: ['read', 'search', 'query'],
    tools: ['general_query'],
  },
};

// ── 子智能体引擎类 ──

class SubAgentEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._config = { ...DEFAULT_CONFIG, ...options };

    // 子智能体元数据
    this._agentId = options.agentId || `sa_engine_${crypto.randomUUID().slice(0, 8)}`;
    this._agentName = options.agentName || '未命名子智能体';
    this._agentType = options.agentType || 'assistant';
    this._agentDescription = options.agentDescription || '';
    this._safetyLevel = options.safetyLevel || 'medium';
    this._quota = options.quota || 'medium';

    // 能力配置
    this._capabilities = CAPABILITY_TEMPLATES[this._agentType] || CAPABILITY_TEMPLATES.assistant;
    this._customCapabilities = options.capabilities || [];
    this._customSystemPrompt = options.systemPrompt || null;

    // 母体引用（用于安全检查和资源访问）
    this._parentAgent = options.parentAgent || null;
    this._guardian = options.guardian || null;
    this._manager = options.manager || null;

    // 状态
    this._state = ENGINE_STATE.IDLE;
    this._startedAt = null;
    this._lastActive = null;

    // 会话管理
    this._sessions = new Map();           // sessionId → session
    this._activeSessionId = null;

    // 消息处理队列
    this._messageQueue = [];
    this._processing = false;

    // 工具调度器
    this._toolHandlers = new Map();       // toolName → handler function
    this._registerBuiltinTools();

    // 性能统计
    this._stats = {
      messagesProcessed: 0,
      messagesResponded: 0,
      tasksExecuted: 0,
      totalThinkingTime: 0,
      totalResponseTime: 0,
      errors: 0,
    };

    // 持久化
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data', 'subagents', this._agentId);
    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir, { recursive: true });
    }

    // LLM接口（由母体注入或直接配置）
    this._llmProvider = options.llmProvider || null;
    this._llmModel = options.llmModel || null;

    // v2.9: 技能安装器与记忆绑定器引用
    this._skillInstaller = options.skillInstaller || null;
    this._memoryBinder = options.memoryBinder || null;

    // v2.9: 已安装技能缓存
    this._installedSkills = [];     // 技能摘要列表
    this._mergedSkillPrompt = null; // 合并后的技能提示词

    this._logger.info(`[SubAgentEngine] 引擎初始化: "${this._agentName}" (${this._agentId}) 类型=${this._agentType}`);
  }

  // ═══════════════════════════════════════
  // 生命周期管理
  // ═══════════════════════════════════════

  /**
   * 启动引擎
   */
  async start() {
    if (this._startedAt) {
      return { success: false, error: '引擎已启动' };
    }

    this._startedAt = Date.now();
    this._lastActive = Date.now();
    this._state = ENGINE_STATE.IDLE;

    // 恢复持久化会话
    if (this._config.persistEnabled) {
      this._restoreSessions();
    }

    // v2.9: 恢复已安装的技能
    if (this._skillInstaller) {
      const restored = this._skillInstaller.restoreAgentSkills(this._agentId);
      if (restored > 0) {
        this._installedSkills = this._skillInstaller.getAgentSkills(this._agentId);
        this._mergedSkillPrompt = this._skillInstaller.getMergedSystemPrompt(this._agentId);
        this._logger.info(`[SubAgentEngine] 恢复 ${restored} 个已安装技能`);
      }
    }

    // 创建默认会话
    if (this._sessions.size === 0) {
      this.createSession({ name: '默认会话' });
    }

    this._logger.info(`[SubAgentEngine] 引擎启动: "${this._agentName}"`);
    this.emit('started', { agentId: this._agentId, agentName: this._agentName });

    return { success: true };
  }

  /**
   * 停止引擎
   */
  async stop() {
    this._state = ENGINE_STATE.IDLE;
    this._processing = false;
    this._messageQueue = [];

    // 持久化所有会话
    if (this._config.persistEnabled) {
      this._persistSessions();
    }

    this._startedAt = null;
    this._logger.info(`[SubAgentEngine] 引擎停止: "${this._agentName}"`);
    this.emit('stopped', { agentId: this._agentId });

    return { success: true };
  }

  // ═══════════════════════════════════════
  // 会话管理
  // ═══════════════════════════════════════

  /**
   * 创建新会话
   */
  createSession(options = {}) {
    const sessionId = `sess_${crypto.randomUUID().slice(0, 8)}`;
    const session = {
      id: sessionId,
      name: options.name || `会话 ${this._sessions.size + 1}`,
      status: SESSION_STATUS.ACTIVE,
      messages: [],
      context: options.context || {},
      metadata: options.metadata || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      summary: null,
    };

    // 容量检查
    if (this._sessions.size >= this._config.maxSessions) {
      // 归档最旧的会话
      const oldest = this._getOldestSession();
      if (oldest) {
        oldest.status = SESSION_STATUS.ARCHIVED;
        this._sessions.delete(oldest.id);
      }
    }

    this._sessions.set(sessionId, session);

    // 添加系统消息
    let systemPrompt = this._customSystemPrompt || this._capabilities.systemPrompt;

    // v2.9: 注入已安装技能的系统提示词
    if (this._mergedSkillPrompt) {
      systemPrompt += '\n\n' + this._mergedSkillPrompt;
    }

    session.messages.push({
      role: MESSAGE_ROLE.SYSTEM,
      content: systemPrompt,
      timestamp: Date.now(),
    });

    // 设为活跃会话
    if (!this._activeSessionId) {
      this._activeSessionId = sessionId;
    }

    this._logger.info(`[SubAgentEngine] 会话创建: ${sessionId} - "${session.name}"`);
    this.emit('session_created', { agentId: this._agentId, sessionId, name: session.name });

    return { success: true, sessionId, session: this._getSessionSummary(session) };
  }

  /**
   * 获取会话列表
   */
  listSessions() {
    return Array.from(this._sessions.values()).map(s => this._getSessionSummary(s));
  }

  /**
   * 获取会话详情
   */
  getSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;

    return {
      ...this._getSessionSummary(session),
      messages: session.messages.slice(-50), // 最近50条
      context: session.context,
      metadata: session.metadata,
      summary: session.summary,
    };
  }

  /**
   * 切换活跃会话
   */
  switchSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return { success: false, error: '会话不存在' };
    }
    this._activeSessionId = sessionId;
    return { success: true, sessionId };
  }

  /**
   * 关闭会话
   */
  closeSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return { success: false, error: '会话不存在' };
    }

    session.status = SESSION_STATUS.CLOSED;
    session.updatedAt = Date.now();

    // 如果关闭的是活跃会话，切换到其他会话
    if (this._activeSessionId === sessionId) {
      this._activeSessionId = null;
      for (const [id, s] of this._sessions) {
        if (s.status === SESSION_STATUS.ACTIVE) {
          this._activeSessionId = id;
          break;
        }
      }
    }

    this.emit('session_closed', { agentId: this._agentId, sessionId });
    return { success: true };
  }

  /**
   * 清空会话消息
   */
  clearSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return { success: false, error: '会话不存在' };
    }

    const systemPrompt = this._customSystemPrompt || this._capabilities.systemPrompt;
    session.messages = [{
      role: MESSAGE_ROLE.SYSTEM,
      content: systemPrompt,
      timestamp: Date.now(),
    }];
    session.messageCount = 0;
    session.summary = null;
    session.updatedAt = Date.now();

    return { success: true };
  }

  // ═══════════════════════════════════════
  // 对话处理
  // ═══════════════════════════════════════

  /**
   * 发送消息到子智能体（主入口）
   * @param {string|object} message - 消息内容或消息对象
   * @param {string} [sessionId] - 指定会话ID（默认使用活跃会话）
   * @param {object} [options] - 附加选项
   */
  async sendMessage(message, sessionId = null, options = {}) {
    const targetSessionId = sessionId || this._activeSessionId;

    if (!targetSessionId) {
      // 自动创建会话
      const result = this.createSession({ name: '自动会话' });
      if (!result.success) return result;
      return this.sendMessage(message, result.sessionId, options);
    }

    const session = this._sessions.get(targetSessionId);
    if (!session) {
      return { success: false, error: '会话不存在' };
    }

    // 安全检查
    if (this._guardian) {
      const auth = this._guardian.authorize(this._agentId, 'process_message', {
        content: typeof message === 'string' ? message.substring(0, 200) : (message.content || '').substring(0, 200),
        sessionId: targetSessionId,
      });
      if (!auth.allowed) {
        return { success: false, error: `安全限制: ${auth.reason}` };
      }
    }

    // 构建消息对象
    const msgObj = typeof message === 'string'
      ? { role: MESSAGE_ROLE.USER, content: message }
      : { role: message.role || MESSAGE_ROLE.USER, content: message.content, ...message };

    msgObj.id = msgObj.id || `msg_${crypto.randomUUID().slice(0, 8)}`;
    msgObj.timestamp = Date.now();
    msgObj.sessionId = targetSessionId;

    // 容量检查
    if (session.messages.length >= this._config.maxMessagesPerSession) {
      // 自动摘要压缩
      this._compressSession(session);
    }

    // 添加到会话
    session.messages.push(msgObj);
    session.messageCount++;
    session.updatedAt = Date.now();
    this._lastActive = Date.now();

    // 入队处理
    this._messageQueue.push({ message: msgObj, sessionId: targetSessionId, options });
    this._stats.messagesProcessed++;

    this.emit('message_received', {
      agentId: this._agentId,
      sessionId: targetSessionId,
      messageId: msgObj.id,
      role: msgObj.role,
    });

    // 触发处理
    if (!this._processing) {
      this._processQueue();
    }

    return { success: true, messageId: msgObj.id, sessionId: targetSessionId };
  }

  /**
   * 处理消息队列
   */
  async _processQueue() {
    if (this._processing || this._messageQueue.length === 0) return;

    this._processing = true;

    while (this._messageQueue.length > 0) {
      const item = this._messageQueue.shift();
      try {
        await this._processMessage(item.message, item.sessionId, item.options);
      } catch (error) {
        this._logger.error(`[SubAgentEngine] 消息处理错误: ${error.message}`);
        this._stats.errors++;
        this.emit('error', { agentId: this._agentId, error: error.message });
      }
    }

    this._processing = false;
  }

  /**
   * 处理单条消息
   */
  async _processMessage(message, sessionId, options = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    const startTime = Date.now();
    this._state = ENGINE_STATE.THINKING;

    try {
      // 1. 推理阶段
      this.emit('thinking_started', { agentId: this._agentId, sessionId, messageId: message.id });

      const reasoningResult = await this._reason(message, session, options);
      const thinkingTime = Date.now() - startTime;
      this._stats.totalThinkingTime += thinkingTime;

      // 2. 如果需要工具调用
      if (reasoningResult.toolCalls && reasoningResult.toolCalls.length > 0) {
        this._state = ENGINE_STATE.EXECUTING;
        this.emit('executing_started', {
          agentId: this._agentId,
          sessionId,
          toolCalls: reasoningResult.toolCalls.map(t => t.name),
        });

        const toolResults = await this._executeTools(reasoningResult.toolCalls, session);
        reasoningResult.toolResults = toolResults;

        // 基于工具结果二次推理
        reasoningResult.finalResponse = await this._reasonWithToolResults(
          message, session, reasoningResult, options
        );
      }

      // 3. 生成回复
      this._state = ENGINE_STATE.RESPONDING;
      const responseContent = reasoningResult.finalResponse || reasoningResult.content || '我已收到您的消息。';

      const response = {
        id: `resp_${crypto.randomUUID().slice(0, 8)}`,
        role: MESSAGE_ROLE.ASSISTANT,
        content: responseContent,
        timestamp: Date.now(),
        sessionId,
        metadata: {
          thinkingTime,
          responseTime: Date.now() - startTime,
          reasoningMode: reasoningResult.mode,
          toolCallsUsed: reasoningResult.toolCalls?.map(t => t.name) || [],
          toolResults: reasoningResult.toolResults || [],
          // v2.9: 技能匹配信息
          skillMatch: reasoningResult.skillMatch || null,
        },
      };

      // 添加到会话
      session.messages.push(response);
      session.updatedAt = Date.now();
      this._stats.messagesResponded++;
      this._stats.totalResponseTime += response.metadata.responseTime;

      this._state = ENGINE_STATE.IDLE;
      this._lastActive = Date.now();

      this.emit('response_generated', {
        agentId: this._agentId,
        sessionId,
        messageId: response.id,
        content: responseContent,
        metadata: response.metadata,
      });

      // 持久化
      if (this._config.persistEnabled) {
        this._persistSession(session);
      }

      return response;

    } catch (error) {
      this._state = ENGINE_STATE.ERROR;
      this._stats.errors++;

      const errorResponse = {
        id: `err_${crypto.randomUUID().slice(0, 8)}`,
        role: MESSAGE_ROLE.ERROR,
        content: `处理消息时出错: ${error.message}`,
        timestamp: Date.now(),
        sessionId,
      };

      session.messages.push(errorResponse);
      this.emit('error', { agentId: this._agentId, sessionId, error: error.message });

      throw error;
    }
  }

  // ═══════════════════════════════════════
  // 推理引擎
  // ═══════════════════════════════════════

  /**
   * 核心推理方法
   */
  async _reason(message, session, options = {}) {
    const mode = options.reasoningMode || this._capabilities.reasoning;

    // 构建上下文
    const context = this._buildContext(session, message);

    // 如果配置了LLM Provider，使用LLM推理
    if (this._llmProvider) {
      return this._llmReason(context, mode, options);
    }

    // 否则使用内置推理
    return this._builtinReason(context, mode, options);
  }

  /**
   * 基于LLM的推理
   */
  async _llmReason(context, mode, options = {}) {
    try {
      const messages = this._formatContextForLLM(context);

      const llmOptions = {
        model: this._llmModel,
        temperature: mode === REASONING_MODE.ANALYTICAL ? 0.3 : 0.7,
        maxTokens: 2000,
        ...options.llmOptions,
      };

      const result = await this._llmProvider.chat(messages, llmOptions);

      // 解析可能的工具调用
      const toolCalls = this._parseToolCalls(result.content);

      return {
        mode,
        content: result.content,
        toolCalls,
        rawResponse: result,
      };
    } catch (error) {
      this._logger.warn(`[SubAgentEngine] LLM推理失败，回退到内置推理: ${error.message}`);
      return this._builtinReason(context, mode, options);
    }
  }

  /**
   * 内置推理（无需LLM）
   */
  _builtinReason(context, mode, options = {}) {
    const lastMessage = context.messages[context.messages.length - 1];
    const userContent = lastMessage?.content || '';

    switch (mode) {
      case REASONING_MODE.ANALYTICAL:
        return this._analyticalReason(userContent, context);
      case REASONING_MODE.PLANNING:
        return this._planningReason(userContent, context);
      case REASONING_MODE.REFLECTIVE:
        return this._reflectiveReason(userContent, context);
      case REASONING_MODE.DIRECT:
      default:
        return this._directReason(userContent, context);
    }
  }

  /**
   * v2.9: 检测消息是否匹配已安装技能
   */
  _detectSkillMatch(content) {
    if (!this._installedSkills || this._installedSkills.length === 0) return [];

    const lowerContent = content.toLowerCase();
    const matched = [];

    for (const skill of this._installedSkills) {
      if (!skill.enabled) continue;

      // 检查触发关键词
      const keywords = skill.triggerKeywords || [];
      const nameLower = skill.name.toLowerCase();
      const descLower = (skill.description || '').toLowerCase();

      // 名称匹配
      if (lowerContent.includes(nameLower)) {
        matched.push({ skill, score: 3, reason: 'name_match' });
        continue;
      }

      // 触发词匹配
      for (const kw of keywords) {
        if (lowerContent.includes(kw.toLowerCase())) {
          matched.push({ skill, score: 2, reason: `keyword:${kw}` });
          break;
        }
      }

      // 描述匹配
      if (descLower && lowerContent.includes(descLower.substring(0, 20))) {
        matched.push({ skill, score: 1, reason: 'description_match' });
      }
    }

    matched.sort((a, b) => b.score - a.score);
    return matched;
  }

  /**
   * 直接推理模式
   */
  _directReason(content, context) {
    // v2.9: 技能匹配检测
    const skillMatches = this._detectSkillMatch(content);
    if (skillMatches.length > 0) {
      const topSkill = skillMatches[0].skill;
      // 记录技能使用
      if (this._memoryBinder) {
        this._memoryBinder.recordSkillUseMemory(this._agentId, topSkill.name, {
          action: 'auto_invoke',
          params: { userQuery: content.substring(0, 100) },
        });
      }

      return {
        mode: REASONING_MODE.DIRECT,
        content: `我正在使用已安装的技能「${topSkill.name}」来回答您的问题。\n\n根据我的技能知识，以下是相关分析和建议...`,
        toolCalls: [],
        skillMatch: topSkill.name,
      };
    }

    const responses = [
      `好的，我来回答您的问题。关于"${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"，以下是相关信息：\n\n根据我的理解，这是一个很好的问题。让我为您梳理一下关键点。\n\n您可以从以下几个方面来考虑这个问题。如果您需要更详细的分析，请告诉我具体关注的方向。`,
      `收到您的消息。让我为您分析一下"${content.substring(0, 40)}${content.length > 40 ? '...' : ''}"。\n\n这是一个值得探讨的话题。基于我目前的知识和工具，我可以提供以下见解。\n\n请告诉我您是否还有其他疑问，我很乐意继续为您解答。`,
    ];

    return {
      mode: REASONING_MODE.DIRECT,
      content: responses[Math.floor(Math.random() * responses.length)],
      toolCalls: [],
    };
  }

  /**
   * 分析推理模式
   */
  _analyticalReason(content, context) {
    const toolCalls = [];
    // 检测是否需要数据分析工具
    if (/数据|分析|统计|图表|报表|趋势|指标/i.test(content)) {
      toolCalls.push({ name: 'data_query', params: { query: content }, priority: 1 });
    }
    if (/计算|求和|平均值|百分比|比率/i.test(content)) {
      toolCalls.push({ name: 'statistical_analysis', params: { data: content }, priority: 2 });
    }

    return {
      mode: REASONING_MODE.ANALYTICAL,
      content: `让我从数据分析的角度来审视您的问题。\n\n📊 **分析框架**：\n1. 数据收集与清洗\n2. 关键指标识别\n3. 趋势与模式分析\n4. 结论与建议\n\n${toolCalls.length > 0 ? '我需要进行一些数据查询来为您提供更精确的分析。' : '基于现有信息，以下是我的分析结果...'}`,
      toolCalls,
    };
  }

  /**
   * 规划推理模式
   */
  _planningReason(content, context) {
    // 检测可分解的任务
    const steps = [];
    const taskPatterns = [
      { pattern: /创建|新建|生成|制作|构建/, step: '初始化与资源准备' },
      { pattern: /部署|发布|上线|启动/, step: '环境配置与部署' },
      { pattern: /测试|验证|检查|审查/, step: '测试与验证' },
      { pattern: /优化|改进|提升|加速/, step: '性能分析与优化' },
      { pattern: /迁移|转换|导出|导入/, step: '数据迁移与转换' },
    ];

    for (const { pattern, step } of taskPatterns) {
      if (pattern.test(content) && !steps.includes(step)) {
        steps.push(step);
      }
    }

    if (steps.length === 0) {
      steps.push('任务理解与分析', '执行计划制定', '逐步执行与监控', '结果验证与总结');
    }

    const plan = steps.map((s, i) => `${i + 1}. **${s}**`).join('\n');

    const toolCalls = [{ name: 'task_decompose', params: { task: content, steps }, priority: 1 }];

    return {
      mode: REASONING_MODE.PLANNING,
      content: `我已经为您规划了任务执行方案：\n\n📋 **执行计划**：\n${plan}\n\n我将按照这个计划逐步执行。如果某个步骤需要调整，请随时告诉我。`,
      toolCalls,
    };
  }

  /**
   * 反思推理模式
   */
  _reflectiveReason(content, context) {
    const toolCalls = [];
    if (/检查|监控|状态|健康|异常|告警|日志/i.test(content)) {
      toolCalls.push({ name: 'health_check', params: { target: content }, priority: 1 });
    }

    return {
      mode: REASONING_MODE.REFLECTIVE,
      content: `让我对当前情况进行评估。\n\n🔍 **状态检查**：\n- 系统运行状态：需要进一步确认\n- 关键指标：正在收集中\n- 风险等级：待评估\n\n${toolCalls.length > 0 ? '我将执行系统检查以获取最新状态。' : '基于目前掌握的信息，以下是评估结果...'}`,
      toolCalls,
    };
  }

  /**
   * 基于工具结果的二次推理
   */
  async _reasonWithToolResults(message, session, reasoningResult, options = {}) {
    const toolResults = reasoningResult.toolResults || [];

    if (this._llmProvider) {
      try {
        const toolContext = toolResults.map(tr =>
          `[工具: ${tr.name}] 结果: ${JSON.stringify(tr.result)}`
        ).join('\n');

        const messages = [
          { role: 'system', content: `基于以下工具执行结果，为用户生成最终回复。` },
          { role: 'user', content: `原始问题: ${message.content}\n\n工具执行结果:\n${toolContext}\n\n请基于以上结果生成完整回复。` },
        ];

        const result = await this._llmProvider.chat(messages, {
          model: this._llmModel,
          temperature: 0.5,
          maxTokens: 2000,
        });

        return result.content;
      } catch (error) {
        this._logger.warn(`[SubAgentEngine] LLM二次推理失败: ${error.message}`);
      }
    }

    // 内置二次推理
    const successCount = toolResults.filter(t => !t.error).length;
    const failCount = toolResults.filter(t => t.error).length;

    let response = `✅ 已完成 ${successCount} 项工具调用`;
    if (failCount > 0) response += `，${failCount} 项遇到问题`;

    response += '\n\n';
    for (const tr of toolResults) {
      if (tr.error) {
        response += `⚠️ **${tr.name}**: ${tr.error}\n`;
      } else {
        response += `✅ **${tr.name}**: ${JSON.stringify(tr.result).substring(0, 200)}\n`;
      }
    }

    return response;
  }

  // ═══════════════════════════════════════
  // 工具调用系统
  // ═══════════════════════════════════════

  /**
   * 注册内置工具
   */
  _registerBuiltinTools() {
    // 知识搜索
    this._toolHandlers.set('knowledge_search', async (params) => {
      return { result: `搜索结果: 关于 "${params.query}" 的相关信息...`, source: 'builtin_knowledge' };
    });

    // 文本摘要
    this._toolHandlers.set('text_summarize', async (params) => {
      return { summary: `这是 "${(params.text || '').substring(0, 50)}..." 的摘要。`, length: 'brief' };
    });

    // 数据分析查询
    this._toolHandlers.set('data_query', async (params) => {
      return {
        query: params.query,
        result: { rows: 0, message: '数据查询功能已就绪，等待实际数据源连接。' },
        timestamp: Date.now(),
      };
    });

    // 统计分析
    this._toolHandlers.set('statistical_analysis', async (params) => {
      return {
        analysis: '统计分析完成',
        metrics: { count: 0, mean: 0, median: 0 },
        message: '统计分析引擎已就绪。',
      };
    });

    // 任务分解
    this._toolHandlers.set('task_decompose', async (params) => {
      return {
        task: params.task,
        steps: params.steps || [],
        estimatedTime: '待评估',
        status: 'decomposed',
      };
    });

    // 健康检查
    this._toolHandlers.set('health_check', async (params) => {
      return {
        status: 'healthy',
        checks: {
          memory: 'ok',
          cpu: 'normal',
          disk: 'sufficient',
          network: 'connected',
        },
        timestamp: Date.now(),
      };
    });

    // 通用查询
    this._toolHandlers.set('general_query', async (params) => {
      return { result: `处理查询: ${params.query || '无具体查询'}`, status: 'ok' };
    });

    // 文件操作（受限）
    this._toolHandlers.set('file_operation', async (params) => {
      if (params.action === 'read') {
        return { action: 'read', path: params.path, content: '(文件读取占位)', status: 'ok' };
      }
      return { action: params.action, status: 'restricted', message: '写操作需要更高权限' };
    });

    // 报告生成
    this._toolHandlers.set('report_generate', async (params) => {
      return {
        reportId: `rpt_${crypto.randomUUID().slice(0, 8)}`,
        title: params.title || '分析报告',
        format: params.format || 'markdown',
        status: 'generated',
        timestamp: Date.now(),
      };
    });

    // 告警触发
    this._toolHandlers.set('alert_trigger', async (params) => {
      return {
        alertId: `alt_${crypto.randomUUID().slice(0, 8)}`,
        level: params.level || 'info',
        message: params.message || '系统告警',
        timestamp: Date.now(),
      };
    });
  }

  /**
   * 注册自定义工具
   */
  registerTool(name, handler) {
    this._toolHandlers.set(name, handler);
    this._logger.info(`[SubAgentEngine] 工具注册: ${name}`);
  }

  /**
   * 执行工具调用
   */
  async _executeTools(toolCalls, session) {
    const results = [];
    const maxTools = Math.min(toolCalls.length, this._config.maxToolsPerRequest);

    for (let i = 0; i < maxTools; i++) {
      const call = toolCalls[i];
      const handler = this._toolHandlers.get(call.name);

      if (!handler) {
        results.push({ name: call.name, error: `未知工具: ${call.name}` });
        continue;
      }

      // 安全检查
      if (this._guardian) {
        const auth = this._guardian.authorize(this._agentId, `tool:${call.name}`, call.params || {});
        if (!auth.allowed) {
          results.push({ name: call.name, error: `安全限制: ${auth.reason}` });
          continue;
        }
      }

      try {
        const startTime = Date.now();
        const result = await handler(call.params || {});
        results.push({
          name: call.name,
          result,
          executionTime: Date.now() - startTime,
          timestamp: Date.now(),
        });
      } catch (error) {
        results.push({ name: call.name, error: error.message });
        this._logger.error(`[SubAgentEngine] 工具执行失败: ${call.name} - ${error.message}`);
      }
    }

    return results;
  }

  /**
   * 直接调用工具（供外部使用）
   */
  async executeTool(toolName, params = {}) {
    const handler = this._toolHandlers.get(toolName);
    if (!handler) {
      return { success: false, error: `未知工具: ${toolName}` };
    }

    try {
      const result = await handler(params);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 解析LLM响应中的工具调用
   */
  _parseToolCalls(content) {
    const toolCalls = [];
    // 尝试解析JSON格式的工具调用
    const jsonMatch = content.match(/```json\s*tool_calls?\s*\n([\s\S]*?)\n```/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          return parsed.filter(t => this._toolHandlers.has(t.name));
        }
      } catch {}
    }

    // 尝试解析函数调用格式
    const funcMatch = content.match(/<function_calls>([\s\S]*?)<\/function_calls>/i);
    if (funcMatch) {
      try {
        const parsed = JSON.parse(funcMatch[1]);
        if (Array.isArray(parsed)) {
          return parsed.filter(t => this._toolHandlers.has(t.name));
        }
      } catch {}
    }

    return toolCalls;
  }

  // ═══════════════════════════════════════
  // 上下文构建
  // ═══════════════════════════════════════

  /**
   * 构建推理上下文
   */
  _buildContext(session, currentMessage) {
    // 获取最近的消息（限制上下文窗口）
    const recentMessages = session.messages.slice(-20);

    return {
      agentId: this._agentId,
      agentName: this._agentName,
      agentType: this._agentType,
      sessionId: session.id,
      sessionName: session.name,
      messages: recentMessages,
      currentMessage,
      summary: session.summary,
      context: session.context,
      capabilities: this._getAllCapabilities(),
    };
  }

  /**
   * 格式化上下文为LLM消息格式
   */
  _formatContextForLLM(context) {
    const messages = [];
    for (const msg of context.messages) {
      messages.push({
        role: msg.role === MESSAGE_ROLE.ASSISTANT ? 'assistant' :
              msg.role === MESSAGE_ROLE.SYSTEM ? 'system' : 'user',
        content: msg.content,
      });
    }
    return messages;
  }

  /**
   * 压缩会话（消息摘要）
   */
  _compressSession(session) {
    if (session.messages.length <= 10) return;

    // 保留系统消息和最近10条
    const systemMsg = session.messages.find(m => m.role === MESSAGE_ROLE.SYSTEM);
    const recent = session.messages.slice(-10);

    // 生成摘要
    const oldMessages = session.messages.slice(
      systemMsg ? 1 : 0,
      -10
    );

    const summary = `[对话摘要] 共${oldMessages.length}条历史消息。主题涉及：${this._agentType}相关讨论。`;
    session.summary = summary;

    // 重构消息列表
    session.messages = [
      ...(systemMsg ? [systemMsg] : []),
      { role: MESSAGE_ROLE.SYSTEM, content: summary, timestamp: Date.now(), isSummary: true },
      ...recent,
    ];

    this._logger.debug(`[SubAgentEngine] 会话压缩: ${session.id} (${oldMessages.length} → 摘要)`);
  }

  // ═══════════════════════════════════════
  // 任务自主执行
  // ═══════════════════════════════════════

  /**
   * 执行独立任务
   */
  async executeTask(task) {
    this._stats.tasksExecuted++;

    const taskMessage = {
      role: MESSAGE_ROLE.SYSTEM,
      content: `[任务] ${task.content || task}`,
      taskId: task.id || `task_${crypto.randomUUID().slice(0, 8)}`,
      taskPriority: task.priority || 1,
      timestamp: Date.now(),
    };

    return this.sendMessage(taskMessage, task.sessionId, {
      reasoningMode: REASONING_MODE.PLANNING,
      isTask: true,
      taskContext: task.context || {},
    });
  }

  // ═══════════════════════════════════════
  // 查询与统计
  // ═══════════════════════════════════════

  /**
   * 获取引擎状态
   */
  getStatus() {
    return {
      agentId: this._agentId,
      agentName: this._agentName,
      agentType: this._agentType,
      state: this._state,
      startedAt: this._startedAt,
      lastActive: this._lastActive,
      activeSessionId: this._activeSessionId,
      sessions: this._sessions.size,
      activeSessions: Array.from(this._sessions.values()).filter(s => s.status === SESSION_STATUS.ACTIVE).length,
      queueDepth: this._messageQueue.length,
      capabilities: this._getAllCapabilities(),
      safetyLevel: this._safetyLevel,
      stats: { ...this._stats },
      // v2.9: 技能统计
      skills: {
        installed: this._installedSkills.length,
        enabled: this._installedSkills.filter(s => s.enabled).length,
        list: this._installedSkills.map(s => ({
          name: s.name,
          category: s.category,
          version: s.version,
          enabled: s.enabled,
          useCount: s.useCount,
        })),
      },
    };
  }

  /**
   * 获取所有工具列表
   */
  listTools() {
    return Array.from(this._toolHandlers.keys()).map(name => ({
      name,
      allowed: this._capabilities.tools.includes(name),
      available: true,
    }));
  }

  // ═══════════════════════════════════════
  // LLM Provider 设置
  // ═══════════════════════════════════════

  /**
   * 设置LLM Provider
   */
  setLLMProvider(provider, model = null) {
    this._llmProvider = provider;
    if (model) this._llmModel = model;
    this._logger.info(`[SubAgentEngine] LLM Provider已设置: ${model || 'default'}`);
  }

  /**
   * 更新系统提示词
   */
  setSystemPrompt(prompt) {
    this._customSystemPrompt = prompt;

    // 更新所有活跃会话的系统消息
    for (const session of this._sessions.values()) {
      const sysIdx = session.messages.findIndex(m => m.role === MESSAGE_ROLE.SYSTEM && !m.isSummary);
      if (sysIdx >= 0) {
        session.messages[sysIdx].content = prompt;
      }
    }
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _getAllCapabilities() {
    return [...new Set([...this._capabilities.tools, ...this._customCapabilities])];
  }

  _getSessionSummary(session) {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      messageCount: session.messageCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      summary: session.summary,
      isActive: session.id === this._activeSessionId,
    };
  }

  _getOldestSession() {
    let oldest = null;
    for (const session of this._sessions.values()) {
      if (!oldest || session.updatedAt < oldest.updatedAt) {
        oldest = session;
      }
    }
    return oldest;
  }

  // ═══════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════

  _persistSession(session) {
    try {
      const filePath = path.join(this._dataDir, `session_${session.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
    } catch (e) {
      this._logger.warn(`[SubAgentEngine] 会话持久化失败: ${e.message}`);
    }
  }

  _persistSessions() {
    for (const session of this._sessions.values()) {
      this._persistSession(session);
    }
  }

  _restoreSessions() {
    try {
      const files = fs.readdirSync(this._dataDir).filter(f => f.startsWith('session_') && f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this._dataDir, file), 'utf8'));
          if (data.status === SESSION_STATUS.ACTIVE) {
            this._sessions.set(data.id, data);
            if (!this._activeSessionId) {
              this._activeSessionId = data.id;
            }
          }
        } catch (e) {
          // 跳过损坏的文件
        }
      }
      this._logger.info(`[SubAgentEngine] 恢复 ${this._sessions.size} 个会话`);
    } catch (e) {
      // 目录不存在或无法读取
    }
  }

  // ═══════════════════════════════════════
  // v2.9: 技能管理接口
  // ═══════════════════════════════════════

  /**
   * 安装技能到当前子智能体
   */
  async installSkillFromFile(filePath, options = {}) {
    if (!this._skillInstaller) {
      return { success: false, error: '技能安装器未初始化' };
    }

    const result = await this._skillInstaller.installFromFile(this._agentId, filePath, options);
    if (result.success) {
      this._refreshSkills();
    }
    return result;
  }

  /**
   * 从内容安装技能
   */
  installSkillFromContent(content, options = {}) {
    if (!this._skillInstaller) {
      return { success: false, error: '技能安装器未初始化' };
    }

    const result = this._skillInstaller.installFromContent(this._agentId, content, options);
    if (result.success) {
      this._refreshSkills();
    }
    return result;
  }

  /**
   * 从市场安装技能
   */
  installSkillFromMarket(marketSkill, options = {}) {
    if (!this._skillInstaller) {
      return { success: false, error: '技能安装器未初始化' };
    }

    const result = this._skillInstaller.installFromMarket(this._agentId, marketSkill, options);
    if (result.success) {
      this._refreshSkills();
    }
    return result;
  }

  /**
   * 卸载技能
   */
  uninstallSkill(skillId) {
    if (!this._skillInstaller) {
      return { success: false, error: '技能安装器未初始化' };
    }

    const result = this._skillInstaller.uninstallSkill(this._agentId, skillId);
    if (result.success) {
      this._refreshSkills();
    }
    return result;
  }

  /**
   * 获取已安装技能列表
   */
  getInstalledSkills() {
    if (this._skillInstaller) {
      return this._skillInstaller.getAgentSkills(this._agentId);
    }
    return this._installedSkills;
  }

  /**
   * 获取技能详情
   */
  getSkillDetail(skillId) {
    if (this._skillInstaller) {
      return this._skillInstaller.getAgentSkillDetail(this._agentId, skillId);
    }
    return null;
  }

  /**
   * 搜索子智能体技能
   */
  searchSkills(keyword) {
    if (this._skillInstaller) {
      return this._skillInstaller.searchAgentSkills(this._agentId, keyword);
    }
    return [];
  }

  /**
   * 获取技能统计
   */
  getSkillStats() {
    if (this._skillInstaller) {
      return this._skillInstaller.getAgentSkillStats(this._agentId);
    }
    return { total: 0, enabled: 0 };
  }

  /**
   * 固化技能到记忆系统
   */
  bindSkillToMemory(skillId) {
    if (!this._memoryBinder) {
      return { success: false, error: '记忆绑定器未初始化' };
    }

    const skill = this.getSkillDetail(skillId);
    if (!skill) {
      return { success: false, error: `技能不存在: ${skillId}` };
    }

    return this._memoryBinder.bindSkill(this._agentId, skill);
  }

  /**
   * 锁定技能为核心记忆（永不衰减）
   */
  lockSkillAsCore(skillId) {
    if (!this._memoryBinder) {
      return { success: false, error: '记忆绑定器未初始化' };
    }
    return this._memoryBinder.lockSkillAsCore(this._agentId, skillId);
  }

  /**
   * 获取固化技能列表
   */
  getBoundSkills() {
    if (!this._memoryBinder) return [];
    return this._memoryBinder.getBoundSkills(this._agentId);
  }

  /**
   * 获取记忆统计
   */
  getMemoryStats() {
    if (!this._memoryBinder) return null;
    return this._memoryBinder.getMemoryStats(this._agentId);
  }

  /**
   * 写入记忆
   */
  writeMemory(content, salience = 3.0) {
    if (!this._memoryBinder) return null;
    return this._memoryBinder.writeConversationMemory(this._agentId, content, salience);
  }

  /**
   * 刷新技能缓存
   */
  _refreshSkills() {
    if (this._skillInstaller) {
      this._installedSkills = this._skillInstaller.getAgentSkills(this._agentId);
      this._mergedSkillPrompt = this._skillInstaller.getMergedSystemPrompt(this._agentId);

      // 更新所有活跃会话的系统消息
      for (const session of this._sessions.values()) {
        const sysIdx = session.messages.findIndex(m =>
          m.role === MESSAGE_ROLE.SYSTEM && !m.isSummary
        );
        if (sysIdx >= 0) {
          let systemPrompt = this._customSystemPrompt || this._capabilities.systemPrompt;
          if (this._mergedSkillPrompt) {
            systemPrompt += '\n\n' + this._mergedSkillPrompt;
          }
          session.messages[sysIdx].content = systemPrompt;
        }
      }
    }
  }

  /**
   * 设置技能安装器引用
   */
  setSkillInstaller(skillInstaller) {
    this._skillInstaller = skillInstaller;
  }

  /**
   * 设置记忆绑定器引用
   */
  setMemoryBinder(memoryBinder) {
    this._memoryBinder = memoryBinder;
  }

  /**
   * 清理资源
   */
  async close() {
    await this.stop();
    this._sessions.clear();
    this._toolHandlers.clear();
    this.removeAllListeners();
  }
}

module.exports = {
  SubAgentEngine,
  ENGINE_STATE,
  SESSION_STATUS,
  MESSAGE_ROLE,
  REASONING_MODE,
  CAPABILITY_TEMPLATES,
};
