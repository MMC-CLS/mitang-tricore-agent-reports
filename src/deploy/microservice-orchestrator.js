/**
 * 蜜糖 TriCore Agent — 微服务拆分基础 v5.0.0
 * 
 * 将三核拆分为可独立部署的微服务
 * 
 * 服务定义：
 *   - consciousness-service: 意识核微服务
 *   - execution-service: 执行核微服务  
 *   - evolution-service: 进化核微服务
 *   - gateway-service: API网关（路由/限流/认证）
 */

'use strict';

const { EventEmitter } = require('events');

// ── 服务角色 ──
const SERVICE_ROLE = Object.freeze({
  CONSCIOUSNESS: 'consciousness',
  EXECUTION: 'execution',
  EVOLUTION: 'evolution',
  GATEWAY: 'gateway',
  MEMORY: 'memory',
  BUS: 'bus',
});

// ── 通信协议 ──
const TRANSPORT = Object.freeze({
  HTTP: 'http',
  WEBSOCKET: 'ws',
  GRPC: 'grpc',
  REDIS_PUBSUB: 'redis_pubsub',
});

/**
 * 微服务编排器
 * 
 * 职责：
 *   1. 服务注册/发现
 *   2. 健康检查
 *   3. 负载均衡（轮询）
 *   4. 服务间通信
 *   5. 断路保护
 */
class MicroServiceOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this._services = new Map();           // serviceName → { instances, config }
    this._instances = new Map();          // instanceId → instance
    this._routes = new Map();             // route → serviceName
    this._circuitBreakers = new Map();    // serviceName → { failures, state, lastFailure }
    this._failureThreshold = options.failureThreshold || 5;
    this._recoveryTimeout = options.recoveryTimeout || 30000;
  }

  // ═══════════════════════════════════════
  // 服务注册
  // ═══════════════════════════════════════

  registerService(name, config = {}) {
    if (!Object.values(SERVICE_ROLE).includes(name)) {
      throw new Error(`Invalid service role: ${name}`);
    }

    if (!this._services.has(name)) {
      this._services.set(name, { instances: [], config });
    }

    // 初始化断路器
    if (!this._circuitBreakers.has(name)) {
      this._circuitBreakers.set(name, {
        failures: 0,
        state: 'closed',
        lastFailure: null,
      });
    }

    this.emit('service:registered', { name });
  }

  registerInstance(serviceName, instance) {
    const service = this._services.get(serviceName);
    if (!service) throw new Error(`Service "${serviceName}" not registered`);

    const instanceId = instance.id || `${serviceName}_${Date.now()}`;
    const fullInstance = {
      id: instanceId,
      serviceName,
      host: instance.host || '127.0.0.1',
      port: instance.port,
      transport: instance.transport || TRANSPORT.HTTP,
      status: 'starting',
      weight: instance.weight || 1,
      metadata: instance.metadata || {},
      registeredAt: Date.now(),
      lastHealthCheck: Date.now(),
    };

    this._instances.set(instanceId, fullInstance);
    service.instances.push(instanceId);
    this.emit('instance:registered', { serviceName, instanceId });
    return instanceId;
  }

  deregisterInstance(instanceId) {
    const instance = this._instances.get(instanceId);
    if (!instance) return;

    const service = this._services.get(instance.serviceName);
    if (service) {
      service.instances = service.instances.filter(id => id !== instanceId);
    }
    this._instances.delete(instanceId);
    this.emit('instance:deregistered', { serviceName: instance.serviceName, instanceId });
  }

  // ═══════════════════════════════════════
  // 路由
  // ═══════════════════════════════════════

  registerRoute(route, serviceName) {
    this._routes.set(route, serviceName);
  }

  resolveRoute(route) {
    const serviceName = this._routes.get(route);
    if (!serviceName) return null;
    return this.getHealthyInstance(serviceName);
  }

  // ═══════════════════════════════════════
  // 负载均衡
  // ═══════════════════════════════════════

  getHealthyInstance(serviceName) {
    const service = this._services.get(serviceName);
    if (!service || service.instances.length === 0) return null;

    // 检查断路器
    const breaker = this._circuitBreakers.get(serviceName);
    if (breaker?.state === 'open') {
      if (Date.now() - breaker.lastFailure < this._recoveryTimeout) {
        return null; // 断路器打开中
      }
      // 半开状态
      breaker.state = 'half_open';
    }

    // 轮询选择健康实例
    const healthyInstances = service.instances
      .map(id => this._instances.get(id))
      .filter(inst => inst && inst.status === 'healthy');

    if (healthyInstances.length === 0) {
      this._recordFailure(serviceName);
      return null;
    }

    // 加权轮询
    const totalWeight = healthyInstances.reduce((s, i) => s + (i.weight || 1), 0);
    let rand = Math.random() * totalWeight;
    for (const inst of healthyInstances) {
      rand -= inst.weight || 1;
      if (rand <= 0) return inst;
    }

    return healthyInstances[healthyInstances.length - 1];
  }

  // ═══════════════════════════════════════
  // 健康检查
  // ═══════════════════════════════════════

  updateHealth(instanceId, status, metrics = {}) {
    const instance = this._instances.get(instanceId);
    if (!instance) return;

    instance.status = status;
    instance.lastHealthCheck = Date.now();
    if (metrics) {
      instance.metrics = { ...instance.metrics, ...metrics };
    }

    // 恢复断路器
    if (status === 'healthy') {
      const breaker = this._circuitBreakers.get(instance.serviceName);
      if (breaker && breaker.state !== 'closed') {
        breaker.failures = 0;
        breaker.state = 'closed';
      }
    }
  }

  runHealthChecks() {
    const now = Date.now();
    for (const [, instance] of this._instances) {
      if (now - instance.lastHealthCheck > 30000 && instance.status === 'healthy') {
        instance.status = 'suspect';
        this.emit('instance:suspect', { instanceId: instance.id, serviceName: instance.serviceName });
      }
    }
  }

  // ═══════════════════════════════════════
  // 断路保护
  // ═══════════════════════════════════════

  _recordFailure(serviceName) {
    const breaker = this._circuitBreakers.get(serviceName);
    if (!breaker) return;

    breaker.failures++;
    breaker.lastFailure = Date.now();

    if (breaker.failures >= this._failureThreshold) {
      breaker.state = 'open';
      this.emit('circuit:opened', { serviceName, failures: breaker.failures });
    }
  }

  // ═══════════════════════════════════════
  // 查询
  // ═══════════════════════════════════════

  getServiceInfo(serviceName) {
    const service = this._services.get(serviceName);
    if (!service) return null;

    const instances = service.instances
      .map(id => this._instances.get(id))
      .filter(Boolean)
      .map(i => ({
        id: i.id,
        host: i.host,
        port: i.port,
        status: i.status,
        transport: i.transport,
      }));

    const breaker = this._circuitBreakers.get(serviceName);

    return {
      name: serviceName,
      instanceCount: instances.length,
      healthyCount: instances.filter(i => i.status === 'healthy').length,
      circuitBreaker: breaker ? { state: breaker.state, failures: breaker.failures } : null,
      instances,
    };
  }

  listServices() {
    const result = [];
    for (const [name] of this._services) {
      result.push(this.getServiceInfo(name));
    }
    return result;
  }

  getStats() {
    const services = Array.from(this._services.keys());
    const instances = Array.from(this._instances.values());
    return {
      serviceCount: services.length,
      instanceCount: instances.length,
      healthyInstances: instances.filter(i => i.status === 'healthy').length,
      openCircuits: Array.from(this._circuitBreakers.values())
        .filter(b => b.state === 'open').length,
    };
  }
}

// ── 导出 ──
module.exports = {
  MicroServiceOrchestrator,
  SERVICE_ROLE,
  TRANSPORT,
};
