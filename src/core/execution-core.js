/**
 * TriCore Agent - 执行核 (Execution Core)
 *
 * 继承龙虾的核心设计：
 *   1. 任务闭环引擎 - 目标→拆解→执行→校验→错误修正
 *   2. 工具执行器 - 安全沙箱隔离的工具运行环境
 *   3. 浏览器自动化接口 - Playwright控制（接口定义，实现待Phase 3集成）
 *   4. 插件市场 - 可安装/卸载的扩展工具
 *   5. 执行安全约束 - 权限分级、操作审计、回滚能力
 *
 * 设计原则："执行不经脑"
 *   - 执行层按确定流程闭环运行，不经过意识层的模糊推理
 *   - 每个步骤有明确的输入/输出/校验条件
 *   - 失败自动重试（最多3次），超过则上报意识层
 */

'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { MODEL_PURPOSE } = require('../providers/model-router');

// ── 任务状态 ──
const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  PLANNING: 'planning',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PAUSED: 'paused',
});

// ── 工具权限等级 ──
const TOOL_PERMISSION = Object.freeze({
  SAFE: 'safe',           // 只读操作，无风险
  MODERATE: 'moderate',   // 有限写入，可回滚
  DANGEROUS: 'dangerous', // 不可逆操作，需确认
});

// ── 内置工具定义 ──
const BUILTIN_TOOLS = {
  read_file: {
    description: '读取文件内容',
    permission: TOOL_PERMISSION.SAFE,
    params: { path: { type: 'string', required: true } },
  },
  write_file: {
    description: '写入文件',
    permission: TOOL_PERMISSION.MODERATE,
    params: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
  },
  list_dir: {
    description: '列出目录内容',
    permission: TOOL_PERMISSION.SAFE,
    params: { path: { type: 'string', required: true } },
  },
  web_search: {
    description: '搜索网页',
    permission: TOOL_PERMISSION.SAFE,
    params: { query: { type: 'string', required: true } },
  },
  fetch_url: {
    description: '获取网页内容',
    permission: TOOL_PERMISSION.SAFE,
    params: { url: { type: 'string', required: true } },
  },
  shell_exec: {
    description: '执行Shell命令',
    permission: TOOL_PERMISSION.DANGEROUS,
    params: { command: { type: 'string', required: true } },
  },
  send_message: {
    description: '发送消息给用户',
    permission: TOOL_PERMISSION.SAFE,
    params: { content: { type: 'string', required: true }, target: { type: 'string' } },
  },
  submit_task: {
    description: '提交新的执行任务',
    permission: TOOL_PERMISSION.MODERATE,
    params: { goal: { type: 'string', required: true }, priority: { type: 'string' } },
  },
};

class ExecutionCore extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── 依赖注入 ──
    this._memory = options.memory || null;
    this._router = options.router || null;
    this._bus = options.bus || null;
    this._security = options.security || null;
    this._budget = options.budget || null;

    // ── 任务管理 ──
    this._tasks = new Map();         // taskId → task
    this._maxConcurrentTasks = options.maxConcurrentTasks ?? 1;
    this._activeTaskCount = 0;

    // ── 工具注册 ──
    this._tools = new Map();         // toolName → { definition, handler }
    this._installedPlugins = new Map(); // pluginName → { tools, metadata }

    // ── 安全 ──
    this._auditLog = [];             // 操作审计日志
    this._maxRetries = options.maxRetries ?? 3;
    this._sandboxDir = options.sandboxDir || path.join(process.cwd(), 'data', 'sandbox');

    // ── v2.0: 单步执行超时配置 ──
    this._actionTimeout = options.actionTimeout ?? 60000; // 默认60s超时

    // ── v2.0: 并发度自适应 — 信号量控制 ──
    this._maxConcurrentTasks = options.maxConcurrentTasks ?? 1;
    this._concurrencySemaphore = 0; // 当前并发计数

    // ── 注册内置工具 ──
    this._registerBuiltinTools();
  }

  // ═══════════════════════════════════════
  // 任务生命周期
  // ═══════════════════════════════════════

  /**
   * 创建并启动执行任务（v2.0: 增加并发度自适应检查）
   * @param {Object} taskDef - { goal, context?, priority? }
   * @returns {string} taskId
   */
  async createTask(taskDef) {
    // ── v2.0: 并发度自适应 — 检查当前负载是否允许新建任务 ──
    const maxConcurrent = this._getAdaptiveMaxConcurrency();
    if (this._activeTaskCount >= maxConcurrent) {
      // 超过自适应并发上限，将任务排入等待队列
      // 任务仍创建但标记为等待，由后续TICK触发执行
      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const task = {
        id: taskId,
        goal: taskDef.goal,
        context: taskDef.context || {},
        priority: taskDef.priority || 'normal',
        status: TASK_STATUS.PENDING,
        steps: [],
        currentStepIndex: 0,
        results: [],
        errors: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        _queuedDueToConcurrency: true, // 标记为因并发限制排队
      };
      this._tasks.set(taskId, task);
      this.emit('task_queued', { taskId, goal: task.goal, reason: 'concurrency_limit', maxConcurrent });
      this._dispatchBus('execution:task_queued', { taskId, goal: task.goal, maxConcurrent });
      return taskId;
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const task = {
      id: taskId,
      goal: taskDef.goal,
      context: taskDef.context || {},
      priority: taskDef.priority || 'normal',
      status: TASK_STATUS.PENDING,
      steps: [],
      currentStepIndex: 0,
      results: [],
      errors: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this._tasks.set(taskId, task);
    this.emit('task_created', { taskId, goal: task.goal });
    this._dispatchBus('execution:task_created', { taskId, goal: task.goal });
    // v1.0: 标准化 task:created 事件（供WebSocket等外部消费）
    this._dispatchBus('task:created', {
      taskId,
      goal: task.goal,
      priority: task.priority,
      timestamp: task.createdAt,
    });

    // 自动进入规划阶段
    await this._planTask(taskId);

    return taskId;
  }

  /**
   * 规划任务步骤（LLM驱动的步骤拆解）
   */
  async _planTask(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return;

    task.status = TASK_STATUS.PLANNING;
    task.updatedAt = Date.now();
    this.emit('task_planning', { taskId });
    this._dispatchBus('execution:task_planning', { taskId });

    if (!this._router) {
      // 无LLM，使用简单单步计划
      task.steps = [{ action: 'execute_goal', params: { goal: task.goal } }];
      task.status = TASK_STATUS.PENDING;
      return;
    }

    try {
      // ── Token预算检查 ──
      const estimatedTokens = 2048;
      const budgetDecision = this._budget
        ? this._budget.requestTokens('execution', estimatedTokens, { priority: 100, callType: 'task_plan' })
        : { allowed: true, adjustedMaxTokens: 2048 };

      if (!budgetDecision.allowed) {
        // 预算不足，使用单步兜底
        task.steps = [{ action: 'execute_goal', params: { goal: task.goal } }];
        task.status = TASK_STATUS.PENDING;
        return;
      }

      const result = await this._router.call({
        purpose: MODEL_PURPOSE.EXECUTION,
        messages: [
          {
            role: 'system',
            content: [
              '你是一个任务规划专家。将用户目标拆解为具体的执行步骤。',
              '每一步必须有明确的action和params。',
              '可用的action:',
              ...Object.entries(BUILTIN_TOOLS).map(([name, def]) =>
                `  - ${name}: ${def.description} (${def.permission})`
              ),
              '',
              '输出JSON格式的步骤列表：',
              '[{"action":"...", "params":{...}}, ...]',
              '',
              '规则：',
              '- 只输出JSON，不要其他内容',
              '- 每个步骤只做一件事',
              '- 有风险的操作单独成步并标注需要确认',
            ].join('\n'),
          },
          { role: 'user', content: `目标: ${task.goal}\n上下文: ${JSON.stringify(task.context)}` },
        ],
        temperature: 0.3,
        max_tokens: budgetDecision.adjustedMaxTokens || 2048,
      });

      // 报告Token使用量
      if (this._budget && result.usage) {
        this._budget.reportUsage('execution', result.usage);
      }

      // 解析步骤
      const steps = this._parseStepsFromLLM(result.content);
      task.steps = steps.length > 0 ? steps : [{ action: 'execute_goal', params: { goal: task.goal } }];
    } catch (error) {
      // 规划失败，使用单步兜底
      task.steps = [{ action: 'execute_goal', params: { goal: task.goal } }];
    }

    task.status = TASK_STATUS.PENDING;
    task.updatedAt = Date.now();
  }

  /**
   * 执行任务的下一步
   * @param {string} taskId
   * @returns {Object} { stepResult, taskStatus, nextStepIndex }
   */
  async executeStep(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.FAILED) {
      return { stepResult: null, taskStatus: task.status, nextStepIndex: task.currentStepIndex };
    }

    // 检查是否还有步骤
    if (task.currentStepIndex >= task.steps.length) {
      task.status = TASK_STATUS.COMPLETED;
      task.updatedAt = Date.now();
      this.emit('task_completed', { taskId, results: task.results });
      this._dispatchBus('execution:task_complete', { taskId });
      return { stepResult: null, taskStatus: TASK_STATUS.COMPLETED, nextStepIndex: task.currentStepIndex };
    }

    task.status = TASK_STATUS.EXECUTING;
    const step = task.steps[task.currentStepIndex];

    // 安全检查
    if (!this._isActionAllowed(step.action)) {
      const error = `Action "${step.action}" is not allowed`;
      task.errors.push({ step: task.currentStepIndex, error });
      task.status = TASK_STATUS.FAILED;
      this.emit('task_failed', { taskId, step: task.currentStepIndex, error });
      this._dispatchBus('execution:task_failed', { taskId, stepIndex: task.currentStepIndex, error });
      // v1.0: 标准化 task:failed 事件
      this._dispatchBus('task:failed', {
        taskId,
        reason: 'action_not_allowed',
        error,
        stepIndex: task.currentStepIndex,
        timestamp: Date.now(),
      });
      return { stepResult: { error }, taskStatus: TASK_STATUS.FAILED, nextStepIndex: task.currentStepIndex };
    }

    // 安全边界授权检查
    if (this._security) {
      const { CORE_IDENTITY, CAPABILITY, SECURITY_LEVEL } = require('../security/security-boundary');
      const capMap = {
        shell_exec: CAPABILITY.SHELL_EXEC,
        write_file: CAPABILITY.FILE_WRITE,
        read_file: CAPABILITY.FILE_READ,
        browser_control: CAPABILITY.BROWSER_CONTROL,
        send_message: CAPABILITY.SEND_MESSAGE,
      };
      const cap = capMap[step.action];
      if (cap) {
        const auth = this._security.authorize(CORE_IDENTITY.EXECUTION, cap, { params: step.params });
        if (!auth.allowed) {
          const error = `Security denied: ${auth.reason}`;
          task.errors.push({ step: task.currentStepIndex, error });
          task.status = TASK_STATUS.FAILED;
          this.emit('task_failed', { taskId, step: task.currentStepIndex, error });
          this._dispatchBus('execution:task_failed', { taskId, stepIndex: task.currentStepIndex, error });
          // v1.0: 标准化 task:failed 事件
          this._dispatchBus('task:failed', {
            taskId,
            reason: 'security_denied',
            error,
            stepIndex: task.currentStepIndex,
            timestamp: Date.now(),
          });
          return { stepResult: { error }, taskStatus: TASK_STATUS.FAILED, nextStepIndex: task.currentStepIndex };
        }
      }
    }

    // 危险操作需确认
    const toolDef = this._tools.get(step.action);
    if (toolDef && toolDef.definition.permission === TOOL_PERMISSION.DANGEROUS) {
      this.emit('dangerous_action', { taskId, step, stepIndex: task.currentStepIndex });
      this._dispatchBus('execution:dangerous_action', { taskId, stepIndex: task.currentStepIndex, action: step.action });
      // 暂停等待确认
      task.status = TASK_STATUS.PAUSED;
      return { stepResult: { waiting: true, reason: 'dangerous_action' }, taskStatus: TASK_STATUS.PAUSED };
    }

    // 执行
    const startTime = Date.now();
    let stepResult;
    let retryCount = 0;

    while (retryCount < this._maxRetries) {
      try {
        stepResult = await this._executeAction(step.action, step.params, task);
        break;
      } catch (error) {
        retryCount++;
        if (retryCount >= this._maxRetries) {
          stepResult = { error: error.message, retries: retryCount };
          task.errors.push({ step: task.currentStepIndex, error: error.message, retries: retryCount });
        }
      }
    }

    const duration = Date.now() - startTime;

    // 记录结果
    task.results.push({
      stepIndex: task.currentStepIndex,
      action: step.action,
      result: stepResult,
      duration,
      retryCount,
    });

    // 记录执行轨迹
    if (this._memory) {
      this._memory.recordExecutionTrace({
        task_id: taskId,
        step_index: task.currentStepIndex,
        action: step.action,
        params: step.params,
        result: typeof stepResult === 'object' ? JSON.stringify(stepResult) : String(stepResult),
        success: !stepResult?.error,
        duration_ms: duration,
      });
    }

    // 审计日志
    this._auditLog.push({
      taskId,
      stepIndex: task.currentStepIndex,
      action: step.action,
      success: !stepResult?.error,
      duration,
      timestamp: Date.now(),
    });

    // 前进一步
    task.currentStepIndex++;
    task.updatedAt = Date.now();

    // v1.0: 任务状态同步 — 发送 step_completed 事件
    this.emit('step_completed', {
      taskId,
      stepIndex: task.currentStepIndex - 1, // 刚完成的步骤索引
      totalSteps: task.steps.length,
      stepResult,
      duration,
      retryCount,
    });
    this._dispatchBus('task:step_completed', {
      taskId,
      stepIndex: task.currentStepIndex - 1,
      totalSteps: task.steps.length,
      success: !stepResult?.error,
      duration,
    });

    // 检查是否完成
    if (task.currentStepIndex >= task.steps.length) {
      task.status = TASK_STATUS.COMPLETED;
      this.emit('task_completed', { taskId, results: task.results });
      this._dispatchBus('execution:task_complete', { taskId });
      // v1.0: 补充标准化 task:completed 事件
      this._dispatchBus('task:completed', {
        taskId,
        totalSteps: task.steps.length,
        totalDuration: Date.now() - task.createdAt,
        errorCount: task.errors.length,
      });
    } else {
      task.status = TASK_STATUS.PENDING;
    }

    return {
      stepResult,
      taskStatus: task.status,
      nextStepIndex: task.currentStepIndex,
    };
  }

  /**
   * 执行完所有剩余步骤
   */
  async executeAll(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const results = [];
    while (task.status !== TASK_STATUS.COMPLETED && task.status !== TASK_STATUS.FAILED && task.status !== TASK_STATUS.PAUSED) {
      const stepResult = await this.executeStep(taskId);
      results.push(stepResult);
    }
    return results;
  }

  /**
   * 确认执行危险操作
   */
  confirmDangerousAction(taskId, approved) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== TASK_STATUS.PAUSED) return;

    if (approved) {
      task.status = TASK_STATUS.PENDING;
      this.emit('task_resumed', { taskId });
      this._dispatchBus('execution:task_resumed', { taskId });
    } else {
      task.status = TASK_STATUS.FAILED;
      task.errors.push({ step: task.currentStepIndex, error: 'User denied dangerous action' });
      this.emit('task_failed', { taskId, step: task.currentStepIndex, error: 'User denied' });
    }
  }

  // ═══════════════════════════════════════
  // 工具执行
  // ═══════════════════════════════════════

  /**
   * 执行单个action（v2.0: 增加超时保护）
   *
   * 超时保护策略：
   *   - 每个action默认60s超时，防止单个步骤卡死整个任务链
   *   - 使用 Promise.race 实现，超时时抛出明确的超时错误
   *   - 超时后不重试（超时通常意味着资源问题，重试无效）
   */
  async _executeAction(action, params, task) {
    const tool = this._tools.get(action);
    if (!tool) throw new Error(`Unknown action: ${action}`);

    // ── v2.0: 单步执行超时保护（默认60s） ──
    const actionTimeout = this._actionTimeout ?? 60000; // 默认60秒

    const executePromise = (async () => {
      if (tool.handler) {
        return await tool.handler(params, { task, memory: this._memory });
      }
      // 内置工具的默认实现
      return this._executeBuiltinAction(action, params, task);
    })();

    // Promise.race: 超时 vs 实际执行
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Action "${action}" timed out after ${actionTimeout / 1000}s`));
      }, actionTimeout);
    });

    return Promise.race([executePromise, timeoutPromise]);
  }

  // ═══════════════════════════════════════
  // v1.0: 公共工具执行接口（外部调用入口）
  // ═══════════════════════════════════════

  /**
   * 执行指定工具（公共API，供外部模块调用）
   * @param {string} name - 工具名称
   * @param {Object} params - 工具参数
   * @returns {Promise<any>} 工具执行结果
   */
  async executeTool(name, params) {
    // 安全检查：验证工具是否存在
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);

    // 安全检查：验证权限
    if (this._security && tool.permission === TOOL_PERMISSION.DANGEROUS) {
      const authorized = this._security.authorize('execution', name, params);
      if (!authorized) throw new Error(`Tool ${name} requires authorization`);
    }

    // 执行工具
    const taskContext = { goal: name, currentStepIndex: 0 };
    return this._executeBuiltinAction(name, params, taskContext);
  }

  async _executeBuiltinAction(action, params, task) {
    // 确保沙箱目录存在（异步）
    try {
      await fsPromises.mkdir(this._sandboxDir, { recursive: true });
    } catch { /* 目录已存在 */ }

    switch (action) {
      case 'read_file': {
        const filePath = this._resolveSandboxPath(params.path);
        try {
          const content = await fsPromises.readFile(filePath, 'utf-8');
          return { content };
        } catch (e) {
          if (e.code === 'ENOENT') throw new Error(`File not found: ${params.path}`);
          throw e;
        }
      }

      case 'write_file': {
        const filePath = this._resolveSandboxPath(params.path);
        const dir = path.dirname(filePath);
        await fsPromises.mkdir(dir, { recursive: true });
        await fsPromises.writeFile(filePath, params.content, 'utf-8');
        return { success: true, path: params.path };
      }

      case 'list_dir': {
        const dirPath = this._resolveSandboxPath(params.path);
        try {
          const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
          return {
            entries: entries.map(e => ({
              name: e.name,
              type: e.isDirectory() ? 'dir' : 'file',
            })),
          };
        } catch (e) {
          if (e.code === 'ENOENT') throw new Error(`Directory not found: ${params.path}`);
          throw e;
        }
      }

      case 'web_search': {
        const { query } = params;
        if (!query || query.length < 2) throw new Error('Search query too short');
        // v4.0: 真实DuckDuckGo搜索实现
        try {
          const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
          const response = await this._httpFetch(searchUrl, { timeout: 10000 });
          const data = JSON.parse(response);
          const results = [];
          if (data.AbstractText) results.push({ title: data.Abstract, snippet: data.AbstractText, url: data.AbstractURL });
          if (data.RelatedTopics) {
            for (const topic of data.RelatedTopics.slice(0, 8)) {
              if (topic.Text) results.push({ title: topic.FirstURL || '', snippet: topic.Text, url: topic.FirstURL || '' });
            }
          }
          return { query, results: results.slice(0, 10), source: 'duckduckgo' };
        } catch (e) {
          return { query, results: [], note: `Search failed: ${e.message}. Try fetch_url with a known URL.` };
        }
      }

      case 'fetch_url': {
        const { url } = params;
        if (!url) throw new Error('URL is required');
        // v4.0: 真实URL抓取实现
        const parsedUrl = new URL(url);
        // v1.0 安全修复：SSRF防护 — 禁止访问内网地址和云元数据端点
        if (this._isInternalIP(parsedUrl.hostname)) {
          throw new Error(`Access to internal network addresses is blocked: ${parsedUrl.hostname}`);
        }
        // 禁止非HTTP(S)协议
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error(`Protocol not allowed: ${parsedUrl.protocol}`);
        }
        try {
          const response = await this._httpFetch(url, { timeout: 15000, maxSize: 500000 });
          // Strip HTML tags for plain text
          const textContent = response.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          const truncated = textContent.length > 10000 ? textContent.substring(0, 10000) + '...' : textContent;
          return { url, content: truncated, length: textContent.length, truncated: textContent.length > 10000 };
        } catch (e) {
          return { url, content: '', note: `URL fetch failed: ${e.message}` };
        }
      }

      case 'shell_exec': {
        // 危险操作，仅允许基础命令
        const { execFile } = require('child_process');
        const allowedCommands = ['ls', 'pwd', 'echo', 'head', 'tail', 'wc', 'date', 'whoami'];
        // 拒绝任何shell元字符（防止命令注入）
        const shellMetachars = /[;|&$`\n\r\\!(){}[\]<>~#]/;
        if (shellMetachars.test(params.command)) {
          throw new Error(`Shell metacharacters not allowed in command`);
        }
        const parts = params.command.trim().split(/\s+/);
        const cmdBase = parts[0];
        if (!allowedCommands.includes(cmdBase)) {
          throw new Error(`Command "${cmdBase}" not allowed. Allowed: ${allowedCommands.join(', ')}`);
        }
        // 使用异步execFile参数化执行，避免shell解析注入和事件循环阻塞
        const args = parts.slice(1);
        const output = await new Promise((resolve, reject) => {
          execFile(cmdBase, args, {
            encoding: 'utf-8',
            timeout: 30000,
            cwd: this._sandboxDir,
            maxBuffer: 10 * 1024 * 1024, // 10MB上限
          }, (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`Command failed: ${error.message}. stderr: ${stderr}`));
            } else {
              resolve(stdout);
            }
          });
        });
        return { output: output.substring(0, 10000) };
      }

      case 'send_message': {
        return { sent: true, content: params.content };
      }

      case 'execute_goal': {
        // 兜底：用LLM直接执行目标
        if (!this._router) return { error: 'No LLM available' };

        // ── Token预算检查 ──
        const goalEstimatedTokens = 2048;
        const goalBudgetDecision = this._budget
          ? this._budget.requestTokens('execution', goalEstimatedTokens, { priority: 70, callType: 'execute_goal' })
          : { allowed: true, adjustedMaxTokens: 2048 };

        if (!goalBudgetDecision.allowed) {
          return { content: '[预算不足，无法执行LLM调用]', budgetDenied: true, reason: goalBudgetDecision.reason };
        }

        try {
          const result = await this._router.call({
            purpose: MODEL_PURPOSE.EXECUTION,
            messages: [
              { role: 'system', content: '直接执行以下目标，给出结果。' },
              { role: 'user', content: params.goal },
            ],
            temperature: 0.3,
            max_tokens: goalBudgetDecision.adjustedMaxTokens || 2048,
          });

          // 报告Token使用量
          if (this._budget && result.usage) {
            this._budget.reportUsage('execution', result.usage);
          }

          return { content: result.content };
        } catch (error) {
          this._dispatchBus('system:error', { type: 'execute_goal_error', taskId: params.goal, error: error.message });
          return { content: '', error: error.message };
        }
      }

      default:
        throw new Error(`No handler for action: ${action}`);
    }
  }

  // ═══════════════════════════════════════
  // v4.0: HTTP请求辅助方法
  // ═══════════════════════════════════════

  /**
   * 内部HTTP(S)请求辅助方法
   * 支持HTTP/HTTPS、自动跟随重定向、超时控制和响应大小限制
   * @param {string} url - 请求URL
   * @param {Object} options - { timeout, maxSize }
   * @returns {Promise<string>} 响应体字符串
   */
  _httpFetch(url, options = {}, redirectCount = 0) {
    // SSRF + 无限重定向防护
    if (redirectCount > 5) {
      return Promise.reject(new Error(`Too many redirects (max 5): ${url}`));
    }
    return new Promise((resolve, reject) => {
      const httpModule = url.startsWith('https') ? require('https') : require('http');
      const req = httpModule.get(url, { timeout: options.timeout || 10000 }, (res) => {
        // Handle redirects (301, 302, 307, 308)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(this._httpFetch(res.headers.location, options, redirectCount + 1));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        let totalSize = 0;
        res.on('data', (chunk) => {
          totalSize += chunk.length;
          if (options.maxSize && totalSize > options.maxSize) {
            req.destroy();
            resolve(Buffer.concat(chunks).toString('utf-8'));
          } else {
            chunks.push(chunk);
          }
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  // ═══════════════════════════════════════
  // 工具注册与插件
  // ═══════════════════════════════════════

  _registerBuiltinTools() {
    for (const [name, definition] of Object.entries(BUILTIN_TOOLS)) {
      this._tools.set(name, { definition, handler: null });
    }
  }

  /**
   * 注册自定义工具
   */
  registerTool(name, definition, handler) {
    this._tools.set(name, { definition, handler });
    this.emit('tool_registered', { name, permission: definition.permission });
    this._dispatchBus('execution:tool_registered', { name, permission: definition.permission });
  }

  /**
   * 安装插件
   * @param {Object} plugin - { name, version, tools: [{name, definition, handler}] }
   */
  installPlugin(plugin) {
    const { name, version = '1.0.0', tools = [] } = plugin;

    for (const tool of tools) {
      this.registerTool(tool.name, tool.definition, tool.handler);
    }

    this._installedPlugins.set(name, {
      name,
      version,
      toolNames: tools.map(t => t.name),
      installedAt: Date.now(),
    });

    this.emit('plugin_installed', { name, version, toolCount: tools.length });
  }

  /**
   * 卸载插件
   */
  uninstallPlugin(name) {
    const plugin = this._installedPlugins.get(name);
    if (!plugin) return;

    for (const toolName of plugin.toolNames) {
      this._tools.delete(toolName);
    }

    this._installedPlugins.delete(name);
    this.emit('plugin_uninstalled', { name });
    this._dispatchBus('execution:plugin_uninstalled', { name });
  }

  /**
   * 列出已安装插件
   */
  listPlugins() {
    return [...this._installedPlugins.values()];
  }

  /**
   * 列出所有可用工具
   */
  listTools() {
    return [...this._tools.entries()].map(([name, { definition }]) => ({
      name,
      ...definition,
    }));
  }

  // ═══════════════════════════════════════
  // 安全
  // ═══════════════════════════════════════

  _isActionAllowed(action) {
    return this._tools.has(action);
  }

  _resolveSandboxPath(inputPath) {
    // 将路径解析到沙箱目录内，防止路径遍历攻击
    const resolved = path.resolve(this._sandboxDir, inputPath.replace(/\.\./g, ''));
    // 必须以 sandboxDir + path.sep 开头，或完全等于 sandboxDir
    if (resolved !== this._sandboxDir && !resolved.startsWith(this._sandboxDir + path.sep)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  // ═══════════════════════════════════════
  // 总线派发辅助
  // ═══════════════════════════════════════

  /**
   * 统一总线派发辅助方法
   * @param {string} eventType - BUS_EVENT中的事件类型
   * @param {Object} data - 事件数据
   * @param {Object} meta - 附加元信息
   */
  _dispatchBus(eventType, data, meta = {}) {
    if (this._bus) {
      this._bus.dispatch(eventType, data, { source: 'execution', ...meta });
    }
  }

  // ═══════════════════════════════════════
  // 辅助
  // ═══════════════════════════════════════

  _parseStepsFromLLM(content) {
    if (!content) return [];

    try {
      // 尝试提取JSON
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(step =>
        step.action && typeof step.action === 'string'
      ).map(step => ({
        action: step.action,
        params: step.params || {},
      }));
    } catch {
      return [];
    }
  }

  getTask(taskId) {
    return this._tasks.get(taskId);
  }

  getTasks() {
    return [...this._tasks.values()];
  }

  getAuditLog(limit = 50) {
    return this._auditLog.slice(-limit);
  }

  // ═══════════════════════════════════════
  // v2.0: 并发度自适应（基于内存和CPU负载动态调整）
  // ═══════════════════════════════════════

  /**
   * 获取自适应最大并发任务数（v2.0新增）
   *
   * 决策因素：
   *   1. 可用系统内存 — 内存紧张时降低并发
   *   2. CPU负载 — 负载高时降低并发
   *   3. 基础配置上限 — 不超过配置的 maxConcurrentTasks
   *
   * 规则：
   *   - 内存可用 < 200MB → 并发=1
   *   - 内存可用 200-500MB → 并发=2
   *   - 内存可用 > 500MB → 使用配置上限
   *   - CPU loadavg > 核数*2 → 并发减半（最少1）
   *
   * @returns {number} 自适应最大并发数
   */
  _getAdaptiveMaxConcurrency() {
    const configuredMax = this._maxConcurrentTasks;
    let adaptiveMax = configuredMax;

    try {
      const os = require('os');

      // ── 内存感知 ──
      const freeMemMB = os.freemem() / (1024 * 1024);
      if (freeMemMB < 200) {
        adaptiveMax = Math.min(adaptiveMax, 1); // 内存紧张，最多1个并发
      } else if (freeMemMB < 500) {
        adaptiveMax = Math.min(adaptiveMax, 2); // 内存中等，最多2个并发
      }
      // freeMemMB >= 500: 使用配置上限

      // ── CPU负载感知 ──
      const cpuCount = os.cpus().length;
      const loadAvg = os.loadavg()[0]; // 1分钟平均负载
      if (loadAvg > cpuCount * 2) {
        // CPU严重过载，并发减半（最少1）
        adaptiveMax = Math.max(1, Math.floor(adaptiveMax / 2));
      } else if (loadAvg > cpuCount) {
        // CPU中等负载，并发减1（最少1）
        adaptiveMax = Math.max(1, adaptiveMax - 1);
      }
    } catch (e) {
      // 无法获取系统指标时使用配置值（降级策略）
      adaptiveMax = configuredMax;
    }

    return Math.max(1, adaptiveMax);
  }

  /**
   * 获取当前并发状态（v2.0新增，用于信号量控制）
   */
  getConcurrencyStatus() {
    return {
      active: this._activeTaskCount,
      maxConfigured: this._maxConcurrentTasks,
      maxAdaptive: this._getAdaptiveMaxConcurrency(),
      queuedTasks: [...this._tasks.values()].filter(t => t._queuedDueToConcurrency).length,
    };
  }

  getStatus() {
    return {
      totalTasks: this._tasks.size,
      activeTasks: [...this._tasks.values()].filter(t =>
        t.status === TASK_STATUS.EXECUTING || t.status === TASK_STATUS.PENDING
      ).length,
      completedTasks: [...this._tasks.values()].filter(t =>
        t.status === TASK_STATUS.COMPLETED
      ).length,
      failedTasks: [...this._tasks.values()].filter(t =>
        t.status === TASK_STATUS.FAILED
      ).length,
      toolsCount: this._tools.size,
      pluginsCount: this._installedPlugins.size,
      auditLogSize: this._auditLog.length,
    };
  }

  // ═══════════════════════════════════════
  // v1.0 安全修复：SSRF防护 — 内部IP检测
  // ═══════════════════════════════════════

  /**
   * 检测是否为内部/私有IP地址（防止SSRF攻击）
   * 阻止访问：localhost、私有网络、云元数据端点
   */
  _isInternalIP(hostname) {
    // 阻止localhost和常见内部域名
    const blockedHosts = [
      'localhost', '127.0.0.1', '0.0.0.0', '::1',
      '169.254.169.254', // AWS/云元数据
      'metadata.google.internal', // GCP元数据
      '100.100.100.200', // 阿里云元数据
    ];
    if (blockedHosts.includes(hostname.toLowerCase())) return true;

    // IPv4私有地址段检测
    const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Pattern);
    if (match) {
      const [, a, b] = match.map(Number);
      // 10.0.0.0/8
      if (a === 10) return true;
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return true;
      // 192.168.0.0/16
      if (a === 192 && b === 168) return true;
      // 127.0.0.0/8 (loopback)
      if (a === 127) return true;
      // 169.254.0.0/16 (link-local)
      if (a === 169 && b === 254) return true;
      // 0.0.0.0/8
      if (a === 0) return true;
    }
    return false;
  }

  // ═══════════════════════════════════════
  // v1.0 三核优化：并行工具调用执行
  // ═══════════════════════════════════════

  /**
   * 并行执行多个独立工具调用（v1.0新增）
   * 对于无依赖关系的工具调用，并行执行以提升响应速度
   */
  async _executeToolsParallel(toolCalls) {
    const results = [];
    // 分组：独立工具可并行，有依赖的串行执行
    const independentTools = toolCalls.filter(tc =>
      ['read_file', 'web_search', 'fetch_url', 'list_dir', 'search_memory'].includes(tc.function?.name)
    );
    const dependentTools = toolCalls.filter(tc =>
      !independentTools.includes(tc)
    );

    // 并行执行独立工具
    if (independentTools.length > 0) {
      const parallelResults = await Promise.allSettled(
        independentTools.map(tc => this._executeToolCall(tc))
      );
      results.push(...parallelResults.map(r =>
        r.status === 'fulfilled' ? r.value : { error: r.reason?.message || 'Tool execution failed' }
      ));
    }

    // 串行执行有依赖的工具
    for (const tc of dependentTools) {
      try {
        results.push(await this._executeToolCall(tc));
      } catch (e) {
        results.push({ error: e.message });
      }
    }

    return results;
  }

  /**
   * 执行单个工具调用
   */
  async _executeToolCall(toolCall) {
    const { name, arguments: args } = toolCall.function;
    const params = typeof args === 'string' ? JSON.parse(args) : args;
    return this.executeTool(name, params);
  }
}

// ── 导出 ──
module.exports = {
  ExecutionCore,
  TASK_STATUS,
  TOOL_PERMISSION,
  BUILTIN_TOOLS,
};
