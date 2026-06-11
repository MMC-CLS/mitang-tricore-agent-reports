/**
 * TriCore Agent — Bootstrap: Plugin System
 *
 * 初始化插件加载器并注册到 agent 实例。
 * 在 TriCore 和 extensions 之后运行，在 API Server 启动之前。
 */

'use strict';

const { PluginLoader } = require('../plugin/plugin-loader');
const { PluginHooks } = require('../plugin/plugin-hooks');

/**
 * 初始化插件系统
 */
function init(agent, options) {
  // 创建钩子管理器
  const hooks = new PluginHooks({ logger: agent._logger });

  // 创建插件加载器
  const pluginLoader = new PluginLoader({
    pluginsDir: options.pluginsDir || require('path').join(process.cwd(), 'plugins'),
    logger: agent._logger,
    hooks,
    autoActivate: options.autoActivatePlugins !== false,
    watch: options.pluginWatch !== false && process.env.NODE_ENV !== 'production',
    core: {
      bus: agent._bus,
      memory: agent._memory,
      security: agent._security,
      budget: agent._budget,
      router: agent._router,
      logger: agent._logger,
    },
  });

  agent._pluginHooks = hooks;
  agent._pluginLoader = pluginLoader;
}

/**
 * 插件系统启动：发现、验证、加载、激活所有插件
 */
async function startup(agent, config) {
  const loader = agent._pluginLoader;
  if (!loader) return;

  try {
    await loader.bootstrap();
    agent._logger.info(`插件系统就绪: ${loader.listPlugins({ state: 'active' }).length} 个活跃插件`);
  } catch (err) {
    agent._logger.warn(`插件系统启动失败: ${err.message}`);
  }
}

/**
 * 插件系统关闭
 */
async function shutdown(agent) {
  const loader = agent._pluginLoader;
  if (!loader) return;

  try {
    await loader.shutdown();
  } catch (err) {
    agent._logger?.debug?.(`插件系统关闭异常: ${err.message}`);
  }
}

module.exports = { init, startup, shutdown };
