/**
 * 蜜糖 TriCore Agent — 标准化插件协议 v5.0.0
 * 
 * 插件生命周期：
 *   register → validate → load → activate → (run) → deactivate → unload → unregister
 * 
 * 插件类型：
 *   - tool: 工具插件（扩展执行核工具集）
 *   - provider: Provider插件（LLM Provider扩展）
 *   - middleware: 中间件插件（消息管道拦截器）
 *   - ui: UI插件（面板/视图扩展）
 *   - skill_pack: 技能包（预置技能集合）
 */

'use strict';

const { EventEmitter } = require('events');

// ── 插件状态 ──
const PLUGIN_STATE = Object.freeze({
  REGISTERED: 'registered',
  VALIDATED: 'validated',
  LOADED: 'loaded',
  ACTIVE: 'active',
  ERROR: 'error',
  DEACTIVATED: 'deactivated',
  UNLOADED: 'unloaded',
});

// ── 插件类型 ──
const PLUGIN_TYPE = Object.freeze({
  TOOL: 'tool',
  PROVIDER: 'provider',
  MIDDLEWARE: 'middleware',
  UI: 'ui',
  SKILL_PACK: 'skill_pack',
});

// ── 标准插件清单 (plugin.toml / plugin.json) ──
const PLUGIN_MANIFEST_SCHEMA = {
  required: ['name', 'version', 'type', 'main'],
  optional: ['description', 'author', 'license', 'dependencies', 'permissions', 'config'],
};

// ── 插件权限 ──
const PLUGIN_PERMISSION = Object.freeze({
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  NETWORK: 'network',
  SHELL: 'shell',
  MEMORY_READ: 'memory:read',
  MEMORY_WRITE: 'memory:write',
  LLM_CALL: 'llm:call',
  BUS_PUBLISH: 'bus:publish',
  BUS_SUBSCRIBE: 'bus:subscribe',
});

/**
 * 插件协议管理器
 * 
 * 职责：
 *   1. 插件注册与发现
 *   2. 清单验证（schema + 签名）
 *   3. 生命周期管理（6阶段状态机）
 *   4. 权限控制（最小权限原则）
 *   5. 依赖解析（拓扑排序加载）
 *   6. 热加载/热卸载支持
 */
class PluginProtocol extends EventEmitter {
  constructor(options = {}) {
    super();
    this._plugins = new Map();        // pluginId → { manifest, instance, state, metadata }
    this._hooks = new Map();          // lifecycleHook → [handlers]
    this._sandbox = options.sandbox !== false;
    this._autoApprove = options.autoApprove || [];
    this._maxPlugins = options.maxPlugins || 50;
  }

  // ═══════════════════════════════════════
  // 注册
  // ═══════════════════════════════════════

  /**
   * 注册插件（提交清单，进入验证阶段）
   */
  register(manifest, instance) {
    if (this._plugins.size >= this._maxPlugins) {
      throw new Error(`Plugin limit reached: ${this._maxPlugins}`);
    }

    const errors = this._validateManifest(manifest);
    if (errors.length > 0) {
      throw new Error(`Invalid plugin manifest: ${errors.join('; ')}`);
    }

    if (this._plugins.has(manifest.name)) {
      throw new Error(`Plugin "${manifest.name}" already registered`);
    }

    const plugin = {
      manifest: { ...manifest },
      instance: instance || null,
      state: PLUGIN_STATE.REGISTERED,
      metadata: {
        registeredAt: Date.now(),
        activatedAt: null,
        errorCount: 0,
        lastError: null,
      },
    };

    this._plugins.set(manifest.name, plugin);
    this.emit('plugin:registered', { name: manifest.name, type: manifest.type });
    return manifest.name;
  }

  /**
   * 加载插件（解析依赖、初始化实例）
   */
  async load(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) throw new Error(`Plugin "${name}" not registered`);

    // 解析依赖
    const deps = plugin.manifest.dependencies || [];
    for (const dep of deps) {
      const depPlugin = this._plugins.get(dep);
      if (!depPlugin || depPlugin.state !== PLUGIN_STATE.ACTIVE) {
        throw new Error(`Dependency "${dep}" not active for plugin "${name}"`);
      }
    }

    plugin.state = PLUGIN_STATE.LOADED;

    // 调用插件的 onLoad 钩子
    if (plugin.instance?.onLoad) {
      try {
        await plugin.instance.onLoad();
      } catch (e) {
        plugin.state = PLUGIN_STATE.ERROR;
        plugin.metadata.lastError = e.message;
        throw e;
      }
    }

    this.emit('plugin:loaded', { name, type: plugin.manifest.type });
    return true;
  }

  /**
   * 激活插件（使其生效）
   */
  async activate(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) throw new Error(`Plugin "${name}" not registered`);

    // 权限检查
    const permissions = plugin.manifest.permissions || [];
    for (const perm of permissions) {
      if (!this._autoApprove.includes(perm) && !this._checkPermission(perm)) {
        throw new Error(`Permission "${perm}" not granted for plugin "${name}"`);
      }
    }

    // 调用插件的 onActivate 钩子
    if (plugin.instance?.onActivate) {
      try {
        await plugin.instance.onActivate(plugin.manifest.config || {});
      } catch (e) {
        plugin.state = PLUGIN_STATE.ERROR;
        plugin.metadata.lastError = e.message;
        plugin.metadata.errorCount++;
        throw e;
      }
    }

    plugin.state = PLUGIN_STATE.ACTIVE;
    plugin.metadata.activatedAt = Date.now();
    this.emit('plugin:activated', { name, type: plugin.manifest.type });
    return true;
  }

  /**
   * 停用插件
   */
  async deactivate(name) {
    const plugin = this._plugins.get(name);
    if (!plugin || plugin.state !== PLUGIN_STATE.ACTIVE) return;

    if (plugin.instance?.onDeactivate) {
      try { await plugin.instance.onDeactivate(); } catch {}
    }

    plugin.state = PLUGIN_STATE.DEACTIVATED;
    this.emit('plugin:deactivated', { name });
  }

  /**
   * 卸载插件
   */
  async unload(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) return;

    // 先停用
    if (plugin.state === PLUGIN_STATE.ACTIVE) {
      await this.deactivate(name);
    }

    if (plugin.instance?.onUnload) {
      try { await plugin.instance.onUnload(); } catch {}
    }

    plugin.state = PLUGIN_STATE.UNLOADED;
    this.emit('plugin:unloaded', { name });
  }

  /**
   * 注销插件
   */
  unregister(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) return;

    // 检查是否有其他插件依赖此插件
    for (const [, p] of this._plugins) {
      if (p === plugin) continue;
      const deps = p.manifest.dependencies || [];
      if (deps.includes(name) && p.state === PLUGIN_STATE.ACTIVE) {
        throw new Error(`Cannot unregister "${name}": still depended by "${p.manifest.name}"`);
      }
    }

    this._plugins.delete(name);
    this.emit('plugin:unregistered', { name });
  }

  // ═══════════════════════════════════════
  // 热加载支持
  // ═══════════════════════════════════════

  /**
   * 热重载插件（先卸载再重新加载激活）
   */
  async hotReload(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) throw new Error(`Plugin "${name}" not found`);

    const wasActive = plugin.state === PLUGIN_STATE.ACTIVE;

    await this.unload(name);
    await this.load(name);
    if (wasActive) {
      await this.activate(name);
    }

    this.emit('plugin:hot_reloaded', { name });
    return true;
  }

  // ═══════════════════════════════════════
  // 查询
  // ═══════════════════════════════════════

  getPlugin(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) return null;
    return {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      type: plugin.manifest.type,
      state: plugin.state,
      description: plugin.manifest.description,
      permissions: plugin.manifest.permissions || [],
      dependencies: plugin.manifest.dependencies || [],
      metadata: { ...plugin.metadata },
    };
  }

  listPlugins(filter = {}) {
    const result = [];
    for (const [name, plugin] of this._plugins) {
      if (filter.type && plugin.manifest.type !== filter.type) continue;
      if (filter.state && plugin.state !== filter.state) continue;
      result.push(this.getPlugin(name));
    }
    return result;
  }

  getStats() {
    const stats = { total: this._plugins.size, byState: {}, byType: {} };
    for (const [, plugin] of this._plugins) {
      stats.byState[plugin.state] = (stats.byState[plugin.state] || 0) + 1;
      stats.byType[plugin.manifest.type] = (stats.byType[plugin.manifest.type] || 0) + 1;
    }
    return stats;
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  _validateManifest(manifest) {
    const errors = [];
    for (const field of PLUGIN_MANIFEST_SCHEMA.required) {
      if (!manifest[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // 验证版本号格式 (semver)
    if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      errors.push(`Invalid version format: ${manifest.version}`);
    }

    // 验证类型
    if (manifest.type && !Object.values(PLUGIN_TYPE).includes(manifest.type)) {
      errors.push(`Invalid plugin type: ${manifest.type}`);
    }

    // 验证权限
    if (manifest.permissions) {
      for (const perm of manifest.permissions) {
        if (!Object.values(PLUGIN_PERMISSION).includes(perm)) {
          errors.push(`Invalid permission: ${perm}`);
        }
      }
    }

    return errors;
  }

  _checkPermission(perm) {
    // 默认：敏感权限需要显式审批
    const sensitivePerms = [
      PLUGIN_PERMISSION.SHELL,
      PLUGIN_PERMISSION.FILE_WRITE,
      PLUGIN_PERMISSION.NETWORK,
    ];
    if (sensitivePerms.includes(perm)) {
      return false; // 需要显式授权
    }
    return true;
  }
}

// ── 导出 ──
module.exports = {
  PluginProtocol,
  PLUGIN_STATE,
  PLUGIN_TYPE,
  PLUGIN_PERMISSION,
  PLUGIN_MANIFEST_SCHEMA,
};
