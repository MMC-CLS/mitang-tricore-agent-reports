/**
 * 蜜糖 TriCore Agent — 模块注册表 (Module Registry)
 *
 * 管理所有模块的注册、获取、依赖解析和按序初始化。
 * 解决 index.js 中上帝对象的问题，提供统一的模块生命周期管理。
 *
 * 设计原则：
 *   - 显式依赖声明：每个模块声明其依赖，注册表自动解析顺序
 *   - 拓扑排序初始化：按依赖顺序初始化，防止循环依赖
 *   - 延迟绑定：模块可以在初始化后动态注册
 *   - 单例模式：同一名称的模块只允许注册一次
 */

'use strict';

class ModuleRegistry {
  constructor(options = {}) {
    this._modules = new Map();       // name → { instance, dependencies, initialized }
    this._initOrder = [];            // 初始化顺序（拓扑排序结果）
    this._initializing = false;
    this._logger = options.logger || null;
  }

  /**
   * 注册模块
   * @param {string} name - 模块名称
   * @param {Object} instance - 模块实例
   * @param {string[]} dependencies - 依赖的模块名称列表
   * @returns {ModuleRegistry} this（链式调用）
   */
  register(name, instance, dependencies = []) {
    if (this._modules.has(name)) {
      throw new Error(`Module "${name}" is already registered`);
    }

    if (!instance) {
      throw new Error(`Cannot register null/undefined module: "${name}"`);
    }

    this._modules.set(name, {
      instance,
      dependencies: [...dependencies],
      initialized: false,
    });

    if (this._logger) {
      this._logger.debug(`[ModuleRegistry] 注册模块: ${name} (依赖: ${dependencies.join(', ') || '无'})`);
    }

    // 使初始化顺序缓存失效
    this._initOrder = [];

    return this;
  }

  /**
   * 获取模块实例
   * @param {string} name - 模块名称
   * @returns {Object|null} 模块实例，未找到返回 null
   */
  get(name) {
    const entry = this._modules.get(name);
    return entry ? entry.instance : null;
  }

  /**
   * 检查模块是否已注册
   * @param {string} name - 模块名称
   * @returns {boolean}
   */
  has(name) {
    return this._modules.has(name);
  }

  /**
   * 列出所有已注册的模块名称
   * @returns {string[]}
   */
  list() {
    return [...this._modules.keys()];
  }

  /**
   * 获取模块的依赖列表
   * @param {string} name - 模块名称
   * @returns {string[]}
   */
  getDependencies(name) {
    const entry = this._modules.get(name);
    return entry ? [...entry.dependencies] : [];
  }

  /**
   * 按依赖顺序初始化所有未初始化的模块
   * 使用拓扑排序确定初始化顺序
   * @param {Object} options - 传递给模块 init() 方法的选项
   * @returns {Promise<string[]>} 初始化顺序列表
   */
  async initializeAll(options = {}) {
    if (this._initializing) {
      throw new Error('ModuleRegistry is already initializing');
    }

    this._initializing = true;
    const order = this._topologicalSort();

    try {
      for (const name of order) {
        const entry = this._modules.get(name);
        if (!entry || entry.initialized) continue;

        if (typeof entry.instance.init === 'function') {
          if (this._logger) {
            this._logger.debug(`[ModuleRegistry] 初始化模块: ${name}`);
          }
          const result = entry.instance.init(options);
          if (result && typeof result.then === 'function') {
            await result;
          }
        }
        entry.initialized = true;
      }
    } finally {
      this._initializing = false;
    }

    this._initOrder = order;
    return order;
  }

  /**
   * 拓扑排序 — 按依赖顺序排列模块名称
   * 使用 Kahn 算法检测循环依赖
   * @returns {string[]}
   */
  _topologicalSort() {
    if (this._initOrder.length > 0) {
      return this._initOrder;
    }

    const inDegree = new Map();
    const adjacency = new Map();

    // 初始化
    for (const [name] of this._modules) {
      inDegree.set(name, 0);
      adjacency.set(name, []);
    }

    // 构建图
    for (const [name, entry] of this._modules) {
      for (const dep of entry.dependencies) {
        if (!this._modules.has(dep)) {
          throw new Error(
            `Module "${name}" depends on "${dep}" which is not registered`
          );
        }
        adjacency.get(dep).push(name);
        inDegree.set(name, (inDegree.get(name) || 0) + 1);
      }
    }

    // Kahn 算法
    const queue = [];
    for (const [name, degree] of inDegree) {
      if (degree === 0) queue.push(name);
    }

    const sorted = [];
    while (queue.length > 0) {
      const current = queue.shift();
      sorted.push(current);

      for (const neighbor of adjacency.get(current)) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (sorted.length !== this._modules.size) {
      const remaining = [...this._modules.keys()].filter(n => !sorted.includes(n));
      throw new Error(
        `Circular dependency detected among modules: ${remaining.join(', ')}`
      );
    }

    return sorted;
  }

  /**
   * 注销模块
   * @param {string} name - 模块名称
   * @returns {boolean} 是否成功注销
   */
  unregister(name) {
    // 检查是否有其他模块依赖此模块
    for (const [otherName, entry] of this._modules) {
      if (entry.dependencies.includes(name)) {
        throw new Error(
          `Cannot unregister "${name}": module "${otherName}" depends on it`
        );
      }
    }

    const result = this._modules.delete(name);
    this._initOrder = [];
    return result;
  }

  /**
   * 获取注册表统计信息
   * @returns {Object}
   */
  getStats() {
    const total = this._modules.size;
    const initialized = [...this._modules.values()].filter(e => e.initialized).length;
    return {
      totalModules: total,
      initializedModules: initialized,
      pendingModules: total - initialized,
      moduleNames: this.list(),
    };
  }

  /**
   * 清空注册表（主要用于测试）
   */
  clear() {
    this._modules.clear();
    this._initOrder = [];
    this._initializing = false;
  }
}

module.exports = { ModuleRegistry };
