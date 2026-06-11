/**
 * Example Greeter Plugin
 *
 * 演示 TriCore 插件系统的标准用法：
 *   - onInit: 初始化钩子
 *   - onStart: 启动钩子
 *   - onMessage: 消息拦截钩子
 *   - onStop: 停止钩子
 *
 * 这是一个 middleware 类型插件，展示如何在消息管道中注入自定义逻辑。
 */

'use strict';

class ExampleGreeterPlugin {
  constructor(config, context) {
    this._config = config || {};
    this._core = context.core || {};
    this._logger = context.logger || null;
    this._hooks = context.hooks || null;
    this._pluginDir = context.pluginDir || '';

    this._messageCount = 0;
    this._startedAt = null;
  }

  /**
   * 系统初始化完成时调用
   */
  async onInit() {
    this._log('info', 'Example Greeter plugin initializing...');
    this._log('info', `Plugin directory: ${this._pluginDir}`);
    this._log('info', `Config greeting: "${this._config.greeting}"`);
  }

  /**
   * 系统启动完成时调用
   */
  async onStart() {
    this._startedAt = new Date();
    this._log('info', `🎉 ${this._config.greeting}`);
    this._log('info', `Started at: ${this._startedAt.toISOString()}`);

    // 如果 CoreBus 可用，发布一条消息
    if (this._core.bus && this._core.bus.dispatch) {
      try {
        this._core.bus.dispatch('plugin:greeter:started', {
          pluginId: 'example-greeter',
          startedAt: this._startedAt.toISOString(),
        });
      } catch (e) {
        // 非关键路径
      }
    }
  }

  /**
   * 收到用户消息时调用
   */
  async onMessage(context) {
    this._messageCount++;

    if (this._config.logMessages) {
      const preview = context?.content
        ? context.content.substring(0, 80) + (context.content.length > 80 ? '...' : '')
        : '<no content>';

      this._log('debug', `[Msg #${this._messageCount}] ${preview}`);
    }

    // 返回增强后的上下文（可选：添加问候前缀）
    return {
      ...context,
      _greeterPlugin: {
        messageNumber: this._messageCount,
        processedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * 系统停止时调用
   */
  async onStop() {
    const uptime = this._startedAt
      ? Math.round((Date.now() - this._startedAt.getTime()) / 1000)
      : 0;

    this._log('info', `👋 ${this._config.farewell}`);
    this._log('info', `Processed ${this._messageCount} message(s) in ${uptime}s`);

    if (this._core.bus && this._core.bus.dispatch) {
      try {
        this._core.bus.dispatch('plugin:greeter:stopped', {
          pluginId: 'example-greeter',
          messageCount: this._messageCount,
          uptime,
        });
      } catch (e) {
        // 非关键路径
      }
    }
  }

  // ── 内部 ──

  _log(level, message) {
    if (this._logger) {
      this._logger[level](`[ExampleGreeter] ${message}`, { module: 'plugin:example-greeter' });
    }
  }
}

module.exports = ExampleGreeterPlugin;
