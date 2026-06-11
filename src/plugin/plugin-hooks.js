/**
 * TriCore Agent — 插件钩子系统
 *
 * 定义标准生命周期钩子并管理插件的钩子注册与调用。
 *
 * 标准钩子：
 *   onInit           — 系统初始化完成时触发（一次性）
 *   onStart          — 系统启动完成时触发
 *   onStop           — 系统停止时触发
 *   onMessage        — 收到用户消息时触发
 *   onTick           — 每个 TICK 周期触发
 *   onToolExecute    — 工具执行前后触发
 *
 * 特性：
 *   - 按优先级排序调用（priority 值越小越先执行）
 *   - 支持异步钩子（串行等待）
 *   - 钩子执行错误不会中断其他钩子
 *   - 支持 before/after 环绕模式
 */

'use strict';

const { EventEmitter } = require('events');

// ── 标准钩子定义 ──
const STANDARD_HOOKS = Object.freeze({
  ON_INIT: 'onInit',
  ON_START: 'onStart',
  ON_STOP: 'onStop',
  ON_MESSAGE: 'onMessage',
  ON_TICK: 'onTick',
  ON_TOOL_EXECUTE: 'onToolExecute',
});

/**
 * 钩子管理器
 *
 * 每个钩子名称维护一个按优先级排序的处理器列表。
 * 插件通过 registerHook() 注册回调，通过 unregisterPluginHooks() 批量移除。
 */
class PluginHooks extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger = options.logger || null;

    // hookName → [{ pluginId, priority, handler, mode }]
    this._hooks = new Map();

    // 初始化所有标准钩子的存储
    for (const hookName of Object.values(STANDARD_HOOKS)) {
      this._hooks.set(hookName, []);
    }

    // 环绕模式支持 (before/after)
    this._wrappers = new Map(); // hookName → [{ before, after, pluginId }]
  }

  /**
   * 为插件注册钩子处理器
   * @param {string} pluginId - 插件 ID
   * @param {string} hookName - 钩子名称
   * @param {Function} handler - 处理函数
   * @param {Object} options - { priority: number, mode: 'normal'|'before'|'after' }
   */
  register(pluginId, hookName, handler, options = {}) {
    const priority = options.priority ?? 100;
    const mode = options.mode || 'normal';

    if (typeof handler !== 'function') {
      this._log('warn', `Plugin "${pluginId}" tried to register non-function handler for hook "${hookName}"`);
      return false;
    }

    // 如果钩子不存在，自动创建（支持自定义钩子）
    if (!this._hooks.has(hookName)) {
      this._hooks.set(hookName, []);
    }

    const entry = { pluginId, priority, handler, mode, registeredAt: Date.now() };

    // 环绕模式：存入专用列表
    if (mode === 'before' || mode === 'after') {
      if (!this._wrappers.has(hookName)) {
        this._wrappers.set(hookName, []);
      }
      this._wrappers.get(hookName).push(entry);
    } else {
      this._hooks.get(hookName).push(entry);
      // 按优先级排序（值越小越先执行）
      this._hooks.get(hookName).sort((a, b) => a.priority - b.priority);
    }

    this._log('debug', `Hook "${hookName}" registered for plugin "${pluginId}" (priority=${priority}, mode=${mode})`);
    this.emit('hook:registered', { pluginId, hookName, priority, mode });
    return true;
  }

  /**
   * 从 manifest.hooks 声明中批量注册
   * @param {string} pluginId - 插件 ID
   * @param {Object} hooksDecl - manifest.hooks 对象 { hookName: { handler, priority } }
   * @param {Object} instance - 插件实例（handler 从 instance 上查找）
   */
  registerFromManifest(pluginId, hooksDecl, instance) {
    if (!hooksDecl || typeof hooksDecl !== 'object') return 0;

    let registered = 0;
    for (const [hookName, config] of Object.entries(hooksDecl)) {
      if (!config || !config.handler) continue;

      const handler = instance[config.handler];
      if (typeof handler !== 'function') {
        this._log('warn', `Plugin "${pluginId}" declares hook "${hookName}" handler "${config.handler}" but no such function found on instance`);
        continue;
      }

      const boundHandler = handler.bind(instance);
      if (this.register(pluginId, hookName, boundHandler, {
        priority: config.priority,
        mode: config.mode,
      })) {
        registered++;
      }
    }
    return registered;
  }

  /**
   * 触发钩子：调用所有注册的处理器
   * @param {string} hookName - 钩子名称
   * @param {*} context - 传递给处理器的上下文数据
   * @returns {Promise<Array>} 所有处理器的返回值数组
   */
  async invoke(hookName, context = {}) {
    const results = [];
    const handlers = this._hooks.get(hookName) || [];

    // ── before 环绕 ──
    const wrappers = this._wrappers.get(hookName) || [];
    const beforeWrappers = wrappers
      .filter(w => w.mode === 'before')
      .sort((a, b) => a.priority - b.priority);

    let wrappedContext = context;
    for (const wrapper of beforeWrappers) {
      try {
        wrappedContext = await wrapper.handler(wrappedContext) || wrappedContext;
      } catch (err) {
        this._log('error', `Hook "${hookName}" before-wrapper [${wrapper.pluginId}] error: ${err.message}`);
      }
    }

    // ── 主处理器 ──
    for (const entry of handlers) {
      try {
        const result = await entry.handler(wrappedContext);
        results.push({ pluginId: entry.pluginId, result, success: true });
      } catch (err) {
        this._log('error', `Hook "${hookName}" handler [${entry.pluginId}] error: ${err.message}`);
        results.push({ pluginId: entry.pluginId, error: err.message, success: false });
      }
    }

    // ── after 环绕 ──
    const afterWrappers = wrappers
      .filter(w => w.mode === 'after')
      .sort((a, b) => a.priority - b.priority);

    for (const wrapper of afterWrappers) {
      try {
        await wrapper.handler(wrappedContext, results);
      } catch (err) {
        this._log('error', `Hook "${hookName}" after-wrapper [${wrapper.pluginId}] error: ${err.message}`);
      }
    }

    this.emit('hook:invoked', { hookName, handlerCount: handlers.length, resultCount: results.length });
    return results;
  }

  /**
   * 同步触发钩子（不等待异步结果）
   */
  invokeSync(hookName, context = {}) {
    const handlers = this._hooks.get(hookName) || [];
    for (const entry of handlers) {
      try {
        entry.handler(context);
      } catch (err) {
        this._log('error', `Hook "${hookName}" handler [${entry.pluginId}] error (sync): ${err.message}`);
      }
    }
  }

  /**
   * 移除指定插件的所有钩子
   * @param {string} pluginId - 插件 ID
   * @returns {number} 移除的钩子数量
   */
  unregisterPlugin(pluginId) {
    let removed = 0;

    for (const [, handlers] of this._hooks) {
      const before = handlers.length;
      const filtered = handlers.filter(h => h.pluginId !== pluginId);
      removed += before - filtered.length;

      // 原地替换以保持引用
      handlers.length = 0;
      handlers.push(...filtered);
    }

    for (const [, wrappers] of this._wrappers) {
      const before = wrappers.length;
      const filtered = wrappers.filter(w => w.pluginId !== pluginId);
      removed += before - filtered.length;

      wrappers.length = 0;
      wrappers.push(...filtered);
    }

    if (removed > 0) {
      this._log('debug', `Unregistered ${removed} hooks for plugin "${pluginId}"`);
      this.emit('hook:unregistered', { pluginId, count: removed });
    }

    return removed;
  }

  /**
   * 获取钩子统计信息
   */
  getStats() {
    const stats = {};
    for (const [hookName, handlers] of this._hooks) {
      stats[hookName] = handlers.length;
    }
    for (const [hookName, wrappers] of this._wrappers) {
      stats[hookName] = (stats[hookName] || 0) + wrappers.length;
    }
    return {
      totalHooks: [...this._hooks.values()].reduce((s, h) => s + h.length, 0),
      totalWrappers: [...this._wrappers.values()].reduce((s, w) => s + w.length, 0),
      byHook: stats,
    };
  }

  /**
   * 列出指定钩子的所有注册处理器
   */
  listHandlers(hookName) {
    const handlers = this._hooks.get(hookName) || [];
    const wrappers = this._wrappers.get(hookName) || [];
    return [...handlers, ...wrappers].map(h => ({
      pluginId: h.pluginId,
      priority: h.priority,
      mode: h.mode,
    }));
  }

  // ── 内部 ──

  _log(level, message) {
    if (this._logger) {
      this._logger[level](`[PluginHooks] ${message}`, { module: 'plugin-hooks' });
    }
  }
}

module.exports = {
  PluginHooks,
  STANDARD_HOOKS,
};
