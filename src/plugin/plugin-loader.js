/**
 * TriCore Agent — 插件加载器
 *
 * 从 plugins/ 目录动态加载插件。
 * 每个插件是一个本地目录（或 npm 包），包含 plugin.json manifest 和入口文件。
 *
 * 核心特性：
 *   1. 从 plugins/ 目录扫描并发现所有插件
 *   2. 解析 plugin.json manifest（委托 PluginManifest）
 *   3. 依赖解析与拓扑排序加载（自动按序加载）
 *   4. 钩子注册（委托 PluginHooks）
 *   5. 热插拔支持（enable/disable 不需要重启）
 *   6. 错误隔离（单个插件加载失败不影响其他插件）
 *   7. 文件监听（开发模式下自动检测插件变更）
 *
 * 生命周期：
 *   discover → validate → resolveDeps → load → activate
 *   deactivate → unload
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { PluginManifest } = require('./plugin-manifest');
const { PluginHooks, STANDARD_HOOKS } = require('./plugin-hooks');

// ── 插件状态 ──
const PLUGIN_STATE = Object.freeze({
  DISCOVERED: 'discovered',
  VALIDATED: 'validated',
  RESOLVED: 'resolved',
  LOADED: 'loaded',
  ACTIVE: 'active',
  DISABLED: 'disabled',
  ERROR: 'error',
});

/**
 * 插件加载器
 *
 * 用法:
 *   const loader = new PluginLoader({ pluginsDir: './plugins', logger, hooksManager });
 *   await loader.discover();
 *   await loader.loadAll();
 *   await loader.activateAll();
 */
class PluginLoader extends EventEmitter {
  constructor(options = {}) {
    super();

    this._pluginsDir = path.resolve(options.pluginsDir || path.join(process.cwd(), 'plugins'));
    this._logger = options.logger || null;
    this._hooks = options.hooks || new PluginHooks({ logger: this._logger });
    this._autoActivate = options.autoActivate !== false;
    this._watchEnabled = options.watch !== false;

    // 核心依赖注入（供插件使用）
    this._core = options.core || {};

    // pluginId → { manifest, instance, state, dirPath, error, metadata }
    this._plugins = new Map();

    // 加载顺序（拓扑排序结果）
    this._loadOrder = [];

    // 文件监听器
    this._watcher = null;

    this._log('info', `PluginLoader initialized. Plugins directory: ${this._pluginsDir}`);
  }

  // ═══════════════════════════════════════
  // 发现
  // ═══════════════════════════════════════

  /**
   * 扫描 plugins/ 目录，发现所有插件
   * @returns {Promise<string[]>} 发现的插件 ID 列表
   */
  async discover() {
    this._log('info', 'Discovering plugins...');

    if (!fs.existsSync(this._pluginsDir)) {
      this._log('warn', `Plugins directory does not exist: ${this._pluginsDir}. Creating...`);
      fs.mkdirSync(this._pluginsDir, { recursive: true });
      return [];
    }

    const entries = fs.readdirSync(this._pluginsDir, { withFileTypes: true });
    const discovered = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(this._pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, 'plugin.json');

      if (!fs.existsSync(manifestPath)) {
        this._log('debug', `Skipping "${entry.name}": no plugin.json found`);
        continue;
      }

      try {
        const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
        const result = PluginManifest.parse(manifestRaw);

        if (!result.valid) {
          this._log('error', `Invalid manifest for "${entry.name}": ${result.errors.join('; ')}`);
          this._plugins.set(result.manifest?.name || entry.name, {
            manifest: result.manifest,
            instance: null,
            state: PLUGIN_STATE.ERROR,
            dirPath: pluginDir,
            error: result.errors.join('; '),
            metadata: { discoveredAt: Date.now() },
          });
          continue;
        }

        const pluginId = result.manifest.name;

        if (this._plugins.has(pluginId)) {
          this._log('warn', `Duplicate plugin ID "${pluginId}". Skipping "${entry.name}".`);
          continue;
        }

        this._plugins.set(pluginId, {
          manifest: result.manifest,
          instance: null,
          state: PLUGIN_STATE.DISCOVERED,
          dirPath: pluginDir,
          error: null,
          metadata: {
            discoveredAt: Date.now(),
            manifestPath,
            warnings: result.warnings,
          },
        });

        discovered.push(pluginId);
        this._log('debug', `Discovered plugin: ${pluginId} v${result.manifest.version} (${result.manifest.type})`);

        if (result.warnings.length > 0) {
          for (const warning of result.warnings) {
            this._log('warn', `Plugin "${pluginId}": ${warning}`);
          }
        }
      } catch (err) {
        this._log('error', `Failed to read manifest for "${entry.name}": ${err.message}`);
      }
    }

    this._log('info', `Discovered ${discovered.length} plugin(s)`);
    this.emit('plugins:discovered', { count: discovered.length, plugins: discovered });

    return discovered;
  }

  // ═══════════════════════════════════════
  // 验证
  // ═══════════════════════════════════════

  /**
   * 验证所有已发现插件的 manifest 和完整性
   * @returns {Promise<{ valid: string[], invalid: Object[] }>}
   */
  async validate() {
    const valid = [];
    const invalid = [];

    for (const [pluginId, plugin] of this._plugins) {
      if (plugin.state !== PLUGIN_STATE.DISCOVERED) continue;

      const errors = [];

      // 检查入口文件是否存在
      const mainFile = plugin.manifest.main || 'index.js';
      const mainPath = path.join(plugin.dirPath, mainFile);
      if (!fs.existsSync(mainPath)) {
        errors.push(`Entry file not found: ${mainFile}`);
      }

      // 检查 engines 兼容性
      if (plugin.manifest.engines) {
        if (plugin.manifest.engines.node) {
          const required = plugin.manifest.engines.node.replace(/^>=?\s*/, '');
          const current = process.version.replace(/^v/, '');
          if (!this._satisfiesVersion(current, required)) {
            errors.push(`Node.js version ${required} required, but running ${current}`);
          }
        }
      }

      if (errors.length > 0) {
        plugin.state = PLUGIN_STATE.ERROR;
        plugin.error = errors.join('; ');
        invalid.push({ pluginId, errors });
      } else {
        plugin.state = PLUGIN_STATE.VALIDATED;
        valid.push(pluginId);
      }
    }

    this._log('info', `Validation complete: ${valid.length} valid, ${invalid.length} invalid`);
    this.emit('plugins:validated', { valid, invalid });

    return { valid, invalid };
  }

  // ═══════════════════════════════════════
  // 依赖解析
  // ═══════════════════════════════════════

  /**
   * 解析依赖并生成拓扑排序的加载顺序
   * @returns {string[]} 按依赖顺序排列的插件 ID 列表
   */
  resolveDependencies() {
    const graph = new Map(); // pluginId → Set<dependencyId>
    const inDegree = new Map();

    for (const [pluginId, plugin] of this._plugins) {
      if (plugin.state !== PLUGIN_STATE.VALIDATED) continue;

      const deps = plugin.manifest.dependencies || [];
      graph.set(pluginId, new Set(deps));
      inDegree.set(pluginId, 0);
    }

    // 计算入度
    for (const [, deps] of graph) {
      for (const dep of deps) {
        if (inDegree.has(dep)) {
          inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
        }
        // 注意：依赖不存在的不在此处报错，会在加载时检查
      }
    }

    // Kahn 算法拓扑排序
    const queue = [];
    for (const [pluginId, degree] of inDegree) {
      if (degree === 0) queue.push(pluginId);
    }

    const sorted = [];
    while (queue.length > 0) {
      const current = queue.shift();
      sorted.push(current);

      for (const [pluginId, deps] of graph) {
        if (deps.has(current)) {
          deps.delete(current);
          const newDegree = inDegree.get(pluginId) - 1;
          inDegree.set(pluginId, newDegree);
          if (newDegree === 0) {
            queue.push(pluginId);
          }
        }
      }
    }

    // 检查循环依赖
    const unresolved = [...inDegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id);

    if (unresolved.length > 0) {
      this._log('error', `Circular dependency detected among: ${unresolved.join(', ')}`);
    }

    this._loadOrder = sorted;

    for (const pluginId of sorted) {
      const plugin = this._plugins.get(pluginId);
      if (plugin) plugin.state = PLUGIN_STATE.RESOLVED;
    }

    this._log('info', `Dependency resolution complete. Load order: [${sorted.join(' → ')}]`);
    this.emit('plugins:resolved', { order: sorted, unresolved });

    return sorted;
  }

  // ═══════════════════════════════════════
  // 加载
  // ═══════════════════════════════════════

  /**
   * 按依赖顺序加载所有插件
   * @returns {Promise<{ loaded: string[], failed: Object[] }>}
   */
  async loadAll() {
    if (this._loadOrder.length === 0) {
      this.resolveDependencies();
    }

    const loaded = [];
    const failed = [];

    for (const pluginId of this._loadOrder) {
      const plugin = this._plugins.get(pluginId);
      if (!plugin || plugin.state === PLUGIN_STATE.ERROR) continue;

      // 检查依赖是否已加载
      const deps = plugin.manifest.dependencies || [];
      const missingDeps = deps.filter(dep => {
        const depPlugin = this._plugins.get(dep);
        return !depPlugin || depPlugin.state !== PLUGIN_STATE.ACTIVE;
      });

      if (missingDeps.length > 0) {
        plugin.state = PLUGIN_STATE.ERROR;
        plugin.error = `Missing dependencies: ${missingDeps.join(', ')}`;
        failed.push({ pluginId, error: plugin.error });
        continue;
      }

      try {
        await this._loadOne(pluginId);
        loaded.push(pluginId);
      } catch (err) {
        plugin.state = PLUGIN_STATE.ERROR;
        plugin.error = err.message;
        failed.push({ pluginId, error: err.message });
        this._log('error', `Failed to load plugin "${pluginId}": ${err.message}`);
      }
    }

    this._log('info', `Load complete: ${loaded.length} loaded, ${failed.length} failed`);
    this.emit('plugins:loaded', { loaded, failed });

    return { loaded, failed };
  }

  /**
   * 加载单个插件
   */
  async _loadOne(pluginId) {
    const plugin = this._plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found`);

    const mainFile = plugin.manifest.main || 'index.js';
    const mainPath = path.join(plugin.dirPath, mainFile);

    // 清除 require 缓存以支持热重载
    delete require.cache[require.resolve(mainPath)];

    // 加载插件模块
    const pluginModule = require(mainPath);

    // 获取插件类或工厂函数
    const PluginClass = pluginModule.default || pluginModule[Object.keys(pluginModule)[0]] || pluginModule;

    // 实例化插件
    let instance;
    if (typeof PluginClass === 'function') {
      if (PluginClass.prototype && PluginClass.prototype.constructor === PluginClass) {
        // 类
        instance = new PluginClass(plugin.manifest.config || {}, {
          core: this._core,
          logger: this._logger,
          hooks: this._hooks,
          pluginDir: plugin.dirPath,
        });
      } else {
        // 工厂函数
        instance = PluginClass(plugin.manifest.config || {}, {
          core: this._core,
          logger: this._logger,
          hooks: this._hooks,
          pluginDir: plugin.dirPath,
        });
      }
    } else {
      // 普通对象
      instance = pluginModule;
    }

    plugin.instance = instance;

    // 调用 onInit（如果定义了的话）
    if (instance.onInit && typeof instance.onInit === 'function') {
      await instance.onInit();
    }

    // 从 manifest.hooks 注册钩子
    if (plugin.manifest.hooks && Object.keys(plugin.manifest.hooks).length > 0) {
      const registeredCount = this._hooks.registerFromManifest(
        pluginId,
        plugin.manifest.hooks,
        instance
      );
      this._log('debug', `Plugin "${pluginId}": registered ${registeredCount} hook(s)`);
    }

    plugin.state = PLUGIN_STATE.LOADED;
    plugin.metadata.loadedAt = Date.now();
    this.emit('plugin:loaded', { pluginId, name: plugin.manifest.name, version: plugin.manifest.version });
  }

  // ═══════════════════════════════════════
  // 激活
  // ═══════════════════════════════════════

  /**
   * 激活所有已加载的插件
   */
  async activateAll() {
    const activated = [];
    const failed = [];

    for (const [pluginId, plugin] of this._plugins) {
      if (plugin.state !== PLUGIN_STATE.LOADED) continue;

      try {
        await this._activateOne(pluginId);
        activated.push(pluginId);
      } catch (err) {
        plugin.state = PLUGIN_STATE.ERROR;
        plugin.error = err.message;
        failed.push({ pluginId, error: err.message });
        this._log('error', `Failed to activate plugin "${pluginId}": ${err.message}`);
      }
    }

    this._log('info', `Activation complete: ${activated.length} activated, ${failed.length} failed`);
    this.emit('plugins:activated', { activated, failed });

    return { activated, failed };
  }

  async _activateOne(pluginId) {
    const plugin = this._plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found`);

    if (plugin.instance?.onStart && typeof plugin.instance.onStart === 'function') {
      await plugin.instance.onStart();
    }

    plugin.state = PLUGIN_STATE.ACTIVE;
    plugin.metadata.activatedAt = Date.now();
    this.emit('plugin:activated', { pluginId, name: plugin.manifest.name });
  }

  // ═══════════════════════════════════════
  // 热插拔
  // ═══════════════════════════════════════

  /**
   * 热启用插件（加载 + 激活）
   */
  async enable(pluginId) {
    const plugin = this._plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found`);

    if (plugin.state === PLUGIN_STATE.ACTIVE) {
      this._log('warn', `Plugin "${pluginId}" is already active`);
      return;
    }

    // 从 DISABLED/ERROR 状态恢复
    if (plugin.state === PLUGIN_STATE.DISABLED || plugin.state === PLUGIN_STATE.ERROR) {
      plugin.state = PLUGIN_STATE.DISCOVERED;
      plugin.error = null;

      // 重新验证
      const { valid } = await this.validate();
      if (!valid.includes(pluginId)) {
        throw new Error(`Plugin "${pluginId}" validation failed: ${plugin.error}`);
      }

      // 重新解析依赖
      this.resolveDependencies();

      // 确保依赖已激活
      const deps = plugin.manifest.dependencies || [];
      for (const dep of deps) {
        const depPlugin = this._plugins.get(dep);
        if (!depPlugin || depPlugin.state !== PLUGIN_STATE.ACTIVE) {
          throw new Error(`Cannot enable "${pluginId}": dependency "${dep}" is not active`);
        }
      }
    }

    await this._loadOne(pluginId);
    await this._activateOne(pluginId);

    this._log('info', `Plugin "${pluginId}" enabled (hot-plug)`);
    this.emit('plugin:enabled', { pluginId });
  }

  /**
   * 热禁用插件（停用 + 卸载）
   */
  async disable(pluginId) {
    const plugin = this._plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found`);

    if (plugin.state === PLUGIN_STATE.DISABLED) {
      this._log('warn', `Plugin "${pluginId}" is already disabled`);
      return;
    }

    // 检查是否有其他插件依赖此插件
    for (const [otherId, other] of this._plugins) {
      if (otherId === pluginId) continue;
      const deps = other.manifest.dependencies || [];
      if (deps.includes(pluginId) && other.state === PLUGIN_STATE.ACTIVE) {
        throw new Error(`Cannot disable "${pluginId}": still depended by "${otherId}"`);
      }
    }

    // 调用 onStop
    if (plugin.instance?.onStop && typeof plugin.instance.onStop === 'function') {
      try {
        await plugin.instance.onStop();
      } catch (err) {
        this._log('warn', `Plugin "${pluginId}" onStop error: ${err.message}`);
      }
    }

    // 卸载钩子
    this._hooks.unregisterPlugin(pluginId);

    // 清理实例
    plugin.instance = null;
    plugin.state = PLUGIN_STATE.DISABLED;
    plugin.metadata.deactivatedAt = Date.now();

    this._log('info', `Plugin "${pluginId}" disabled (hot-unplug)`);
    this.emit('plugin:disabled', { pluginId });
  }

  // ═══════════════════════════════════════
  // 查询
  // ═══════════════════════════════════════

  getPlugin(pluginId) {
    const plugin = this._plugins.get(pluginId);
    if (!plugin) return null;

    return {
      id: pluginId,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      type: plugin.manifest.type,
      description: plugin.manifest.description || '',
      state: plugin.state,
      error: plugin.error,
      dependencies: plugin.manifest.dependencies || [],
      permissions: plugin.manifest.permissions || [],
      metadata: { ...plugin.metadata },
    };
  }

  listPlugins(filter = {}) {
    const result = [];
    for (const [pluginId, plugin] of this._plugins) {
      if (filter.type && plugin.manifest.type !== filter.type) continue;
      if (filter.state && plugin.state !== filter.state) continue;
      result.push(this.getPlugin(pluginId));
    }
    return result;
  }

  getStats() {
    const stats = { total: this._plugins.size, byState: {}, byType: {} };
    for (const [, plugin] of this._plugins) {
      stats.byState[plugin.state] = (stats.byState[plugin.state] || 0) + 1;
      stats.byType[plugin.manifest.type] = (stats.byType[plugin.manifest.type] || 0) + 1;
    }
    stats.hooks = this._hooks.getStats();
    return stats;
  }

  /**
   * 获取所有活跃插件的钩子结果（用于 TICK 注入）
   */
  getActiveHooks() {
    return this._hooks;
  }

  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  /**
   * 一键加载并激活所有插件
   */
  async bootstrap() {
    await this.discover();
    await this.validate();
    this.resolveDependencies();
    const loadResult = await this.loadAll();

    if (this._autoActivate) {
      await this.activateAll();
    }

    if (this._watchEnabled) {
      this._startWatching();
    }

    this._log('info', `Plugin bootstrap complete. ${this.listPlugins({ state: PLUGIN_STATE.ACTIVE }).length} active plugin(s)`);
    return loadResult;
  }

  /**
   * 关闭所有插件
   */
  async shutdown() {
    this._stopWatching();

    // 按加载顺序反向关闭
    const reverseOrder = [...this._loadOrder].reverse();
    for (const pluginId of reverseOrder) {
      const plugin = this._plugins.get(pluginId);
      if (plugin?.state === PLUGIN_STATE.ACTIVE) {
        try {
          await this.disable(pluginId);
        } catch (err) {
          this._log('error', `Error shutting down plugin "${pluginId}": ${err.message}`);
        }
      }
    }

    this._log('info', 'All plugins shut down');
  }

  // ═══════════════════════════════════════
  // 文件监听（开发模式热重载）
  // ═══════════════════════════════════════

  _startWatching() {
    if (!fs.existsSync(this._pluginsDir)) return;

    try {
      this._watcher = fs.watch(this._pluginsDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // 只关注 plugin.json 的变更
        if (filename.endsWith('plugin.json')) {
          const dirName = path.dirname(filename);
          const pluginDir = dirName === '.' ? this._pluginsDir : path.join(this._pluginsDir, dirName);

          this._log('debug', `Plugin change detected: ${filename} (${eventType})`);

          // 延迟 500ms 防抖
          clearTimeout(this._watchDebounce);
          this._watchDebounce = setTimeout(async () => {
            try {
              // 查找对应插件
              for (const [pluginId, plugin] of this._plugins) {
                if (plugin.dirPath === pluginDir && plugin.state === PLUGIN_STATE.ACTIVE) {
                  this._log('info', `Hot-reloading plugin: ${pluginId}`);
                  await this.disable(pluginId);
                  // 重新发现该插件
                  plugin.state = PLUGIN_STATE.DISCOVERED;
                  await this._loadOne(pluginId);
                  await this._activateOne(pluginId);
                  this._log('info', `Plugin "${pluginId}" hot-reloaded`);
                  break;
                }
              }
            } catch (err) {
              this._log('error', `Hot-reload error: ${err.message}`);
            }
          }, 500);
        }
      });

      this._log('debug', 'Plugin file watcher started');
    } catch (err) {
      this._log('warn', `Failed to start plugin watcher: ${err.message}`);
    }
  }

  _stopWatching() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  // ═══════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════

  _satisfiesVersion(current, required) {
    const curParts = current.split('.').map(Number);
    const reqParts = required.split('.').map(Number);
    for (let i = 0; i < Math.max(curParts.length, reqParts.length); i++) {
      const c = curParts[i] || 0;
      const r = reqParts[i] || 0;
      if (c > r) return true;
      if (c < r) return false;
    }
    return true;
  }

  _log(level, message) {
    if (this._logger) {
      this._logger[level](`[PluginLoader] ${message}`, { module: 'plugin-loader' });
    }
  }
}

module.exports = {
  PluginLoader,
  PLUGIN_STATE,
};
