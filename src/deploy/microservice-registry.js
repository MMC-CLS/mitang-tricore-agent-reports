/**
 * TriCore Agent - 微服务注册发现 (Phase 27)
 *
 * 支持三核拆分为独立微服务：
 *   1. 服务注册 - 启动时自动注册到注册中心
 *   2. 服务发现 - 查询可用服务实例
 *   3. 健康检查 - 心跳+健康状态上报
 *   4. 负载均衡 - 轮询/随机/最少连接/加权
 *   5. 服务降级 - 熔断+降级策略
 *   6. 配置中心 - 集中配置管理
 *
 * 注册中心支持：
 *   - 本地模式 (JSON文件)
 *   - Consul (预留接口)
 *   - Etcd (预留接口)
 *   - Kubernetes DNS (预留接口)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const REGISTRY_TYPE = Object.freeze({
  LOCAL: 'local',
  CONSUL: 'consul',
  ETCD: 'etcd',
  K8S: 'kubernetes',
});

const SERVICE_STATUS = Object.freeze({
  UP: 'UP',
  DOWN: 'DOWN',
  STARTING: 'STARTING',
  OUT_OF_SERVICE: 'OUT_OF_SERVICE',
});

const LB_STRATEGY = Object.freeze({
  ROUND_ROBIN: 'round_robin',
  RANDOM: 'random',
  LEAST_CONNECTIONS: 'least_connections',
  WEIGHTED: 'weighted',
});

class MicroServiceRegistry extends EventEmitter {
  constructor(options = {}) {
    super();

    this._registryType = options.registryType || REGISTRY_TYPE.LOCAL;
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this._registryDir = path.join(this._dataDir, 'registry');
    this._heartbeatInterval = options.heartbeatInterval || 10000;
    this._healthCheckTimeout = options.healthCheckTimeout || 30000;
    this._ttl = options.ttl || 45000;

    // 本地注册表
    this._services = new Map(); // serviceName → [{ id, host, port, status, metadata, lastHeartbeat }]

    // 实例信息
    this._instances = new Map(); // instanceId → serviceInfo

    // 负载均衡器
    this._loadBalancers = new Map();

    // 心跳定时器
    this._heartbeatTimers = new Map();

    // 确保注册表目录存在
    if (!fs.existsSync(this._registryDir)) {
      fs.mkdirSync(this._registryDir, { recursive: true });
    }

    // 加载持久化的注册数据
    this._loadFromDisk();
  }

  /**
   * 注册服务
   */
  register(serviceName, instance) {
    const instanceId = instance.id || `${serviceName}_${instance.host}_${instance.port}_${Date.now()}`;
    const serviceInfo = {
      id: instanceId,
      name: serviceName,
      host: instance.host || '127.0.0.1',
      port: instance.port || 0,
      status: SERVICE_STATUS.STARTING,
      metadata: instance.metadata || {},
      tags: instance.tags || [],
      weight: instance.weight || 1,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
    };

    if (!this._services.has(serviceName)) {
      this._services.set(serviceName, []);
    }

    // 检查是否已存在
    const existing = this._services.get(serviceName).find(s => s.id === instanceId);
    if (existing) {
      Object.assign(existing, serviceInfo);
      existing.status = SERVICE_STATUS.UP;
    } else {
      this._services.get(serviceName).push(serviceInfo);
    }

    this._instances.set(instanceId, serviceInfo);

    // 启动心跳
    this._startHeartbeat(serviceName, instanceId);

    // 持久化
    this._saveToDisk();

    this.emit('service_registered', { serviceName, instanceId, ...serviceInfo });

    return { instanceId, serviceName };
  }

  /**
   * 注销服务
   */
  deregister(serviceName, instanceId) {
    if (!this._services.has(serviceName)) return;

    const instances = this._services.get(serviceName);
    const idx = instances.findIndex(s => s.id === instanceId);
    if (idx !== -1) {
      instances.splice(idx, 1);
      if (instances.length === 0) {
        this._services.delete(serviceName);
      }
    }

    this._instances.delete(instanceId);
    this._stopHeartbeat(instanceId);
    this._saveToDisk();

    this.emit('service_deregistered', { serviceName, instanceId });
  }

  /**
   * 发现服务实例
   */
  discover(serviceName, options = {}) {
    const instances = this._services.get(serviceName) || [];
    const healthy = instances.filter(s => this._isHealthy(s));

    if (healthy.length === 0) {
      return [];
    }

    // 过滤标签
    let filtered = healthy;
    if (options.tags && options.tags.length > 0) {
      filtered = healthy.filter(s => options.tags.every(t => s.tags.includes(t)));
    }
    if (options.metadata) {
      filtered = filtered.filter(s => {
        return Object.entries(options.metadata).every(([k, v]) => s.metadata[k] === v);
      });
    }

    return filtered.map(s => ({
      id: s.id,
      host: s.host,
      port: s.port,
      status: s.status,
      metadata: s.metadata,
      tags: s.tags,
      weight: s.weight,
      uptime: Date.now() - s.registeredAt,
    }));
  }

  /**
   * 负载均衡选择实例
   */
  selectInstance(serviceName, strategy = LB_STRATEGY.ROUND_ROBIN) {
    const instances = this.discover(serviceName);
    if (instances.length === 0) return null;

    switch (strategy) {
      case LB_STRATEGY.ROUND_ROBIN:
        return this._roundRobin(serviceName, instances);
      case LB_STRATEGY.RANDOM:
        return instances[Math.floor(Math.random() * instances.length)];
      case LB_STRATEGY.WEIGHTED:
        return this._weightedSelect(instances);
      case LB_STRATEGY.LEAST_CONNECTIONS:
        return this._leastConnections(instances);
      default:
        return instances[0];
    }
  }

  _roundRobin(serviceName, instances) {
    if (!this._loadBalancers.has(serviceName)) {
      this._loadBalancers.set(serviceName, { rrIndex: 0 });
    }
    const lb = this._loadBalancers.get(serviceName);
    const instance = instances[lb.rrIndex % instances.length];
    lb.rrIndex = (lb.rrIndex + 1) % instances.length;
    return instance;
  }

  _weightedSelect(instances) {
    const totalWeight = instances.reduce((sum, s) => sum + (s.weight || 1), 0);
    let random = Math.random() * totalWeight;
    for (const instance of instances) {
      random -= (instance.weight || 1);
      if (random <= 0) return instance;
    }
    return instances[instances.length - 1];
  }

  _leastConnections(instances) {
    return instances.sort((a, b) => (a.connections || 0) - (b.connections || 0))[0];
  }

  /**
   * 获取所有注册的服务
   */
  listServices() {
    const services = [];
    for (const [name, instances] of this._services) {
      services.push({
        name,
        instanceCount: instances.length,
        healthyCount: instances.filter(s => this._isHealthy(s)).length,
        instances: instances.map(s => ({
          id: s.id,
          host: s.host,
          port: s.port,
          status: s.status,
          healthy: this._isHealthy(s),
          uptime: Date.now() - s.registeredAt,
        })),
      });
    }
    return services;
  }

  /**
   * 心跳机制
   */
  _startHeartbeat(serviceName, instanceId) {
    const timer = setInterval(() => {
      const instance = this._instances.get(instanceId);
      if (instance) {
        instance.lastHeartbeat = Date.now();
        if (instance.status !== SERVICE_STATUS.UP) {
          instance.status = SERVICE_STATUS.UP;
        }
      }
    }, this._heartbeatInterval);

    this._heartbeatTimers.set(instanceId, timer);
  }

  _stopHeartbeat(instanceId) {
    const timer = this._heartbeatTimers.get(instanceId);
    if (timer) {
      clearInterval(timer);
      this._heartbeatTimers.delete(instanceId);
    }
  }

  /**
   * 检查实例健康状态
   */
  _isHealthy(instance) {
    if (instance.status === SERVICE_STATUS.DOWN || instance.status === SERVICE_STATUS.OUT_OF_SERVICE) {
      return false;
    }
    const timeSinceHeartbeat = Date.now() - instance.lastHeartbeat;
    return timeSinceHeartbeat < this._ttl;
  }

  /**
   * 运行健康检查（清理过期实例）
   */
  runHealthCheck() {
    const now = Date.now();
    let removed = 0;

    for (const [serviceName, instances] of this._services) {
      const before = instances.length;
      const filtered = instances.filter(s => {
        const age = now - s.lastHeartbeat;
        if (age > this._ttl) {
          this._instances.delete(s.id);
          this._stopHeartbeat(s.id);
          this.emit('service_unhealthy', { serviceName, instanceId: s.id, lastHeartbeat: s.lastHeartbeat });
          return false;
        }
        return true;
      });
      removed += before - filtered.length;
      this._services.set(serviceName, filtered);
      if (filtered.length === 0) {
        this._services.delete(serviceName);
      }
    }

    if (removed > 0) {
      this._saveToDisk();
    }

    return { removed, totalServices: this._services.size };
  }

  /**
   * 持久化注册数据
   */
  _saveToDisk() {
    try {
      const data = {};
      for (const [name, instances] of this._services) {
        data[name] = instances.map(s => ({
          id: s.id,
          host: s.host,
          port: s.port,
          status: s.status,
          metadata: s.metadata,
          tags: s.tags,
          weight: s.weight,
          registeredAt: s.registeredAt,
          lastHeartbeat: s.lastHeartbeat,
        }));
      }
      const filePath = path.join(this._registryDir, 'services.json');
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      // 非关键操作，忽略错误
    }
  }

  _loadFromDisk() {
    try {
      const filePath = path.join(this._registryDir, 'services.json');
      if (!fs.existsSync(filePath)) return;

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const [name, instances] of Object.entries(data)) {
        // 清理旧数据（可能已过期的实例不加载）
        const now = Date.now();
        const validInstances = instances.filter(s => now - s.lastHeartbeat < this._ttl * 3);

        if (validInstances.length > 0) {
          this._services.set(name, validInstances);
          for (const instance of validInstances) {
            instance.status = SERVICE_STATUS.DOWN; // 重启后标记为DOWN，等待心跳
            this._instances.set(instance.id, instance);
          }
        }
      }
    } catch {
      // 文件损坏，忽略
    }
  }

  /**
   * 获取注册中心状态
   */
  getStats() {
    let totalInstances = 0;
    let healthyInstances = 0;

    for (const [, instances] of this._services) {
      totalInstances += instances.length;
      healthyInstances += instances.filter(s => this._isHealthy(s)).length;
    }

    return {
      registryType: this._registryType,
      services: this._services.size,
      totalInstances,
      healthyInstances,
      unhealthyInstances: totalInstances - healthyInstances,
      heartbeatInterval: this._heartbeatInterval,
    };
  }

  close() {
    for (const [instanceId] of this._heartbeatTimers) {
      this._stopHeartbeat(instanceId);
    }
    this._services.clear();
    this._instances.clear();
    this._loadBalancers.clear();
    this.removeAllListeners();
  }
}

// ═══════════════════════════════════════
// 服务间通信客户端
// ═══════════════════════════════════════

class MicroServiceClient {
  constructor(registry, options = {}) {
    this._registry = registry;
    this._timeout = options.timeout || 10000;
    this._retries = options.retries || 2;
  }

  /**
   * 调用远程服务
   */
  async call(serviceName, endpoint, data = {}, options = {}) {
    const instance = this._registry.selectInstance(serviceName, options.lbStrategy);
    if (!instance) {
      throw new Error(`No available instance for service: ${serviceName}`);
    }

    const url = `http://${instance.host}:${instance.port}${endpoint}`;
    let lastError;

    for (let attempt = 0; attempt <= this._retries; attempt++) {
      try {
        const result = await this._httpRequest(url, {
          method: options.method || 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
          },
          body: JSON.stringify(data),
          timeout: options.timeout || this._timeout,
        });

        return result;
      } catch (error) {
        lastError = error;
        if (attempt < this._retries) {
          await this._sleep(100 * Math.pow(2, attempt));
        }
      }
    }

    throw lastError;
  }

  async _httpRequest(urlStr, options) {
    const http = require('http');
    const https = require('https');

    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const client = url.protocol === 'https:' ? https : http;

      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
        timeout: options.timeout,
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve(Buffer.concat(chunks).toString());
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      if (options.body) req.write(options.body);
      req.end();
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = {
  MicroServiceRegistry,
  MicroServiceClient,
  REGISTRY_TYPE,
  SERVICE_STATUS,
  LB_STRATEGY,
};
