/**
 * 蜜糖 TriCore Agent - 性能 SLA 定义与监控
 *
 * 定义系统的关键性能指标（KPI）及其服务等级协议（SLA）阈值。
 * 这些 SLA 用于：
 *   1. 性能基准测试的通过/失败判定
 *   2. 运行时性能监控告警
 *   3. CI/CD 流水线中的性能回归检测
 *
 * 指标分类：
 *   CRITICAL: 超出阈值将导致系统不可用
 *   WARNING:  超出阈值表示性能退化，需要关注
 *   INFO:     超出阈值仅作为信息记录
 */

'use strict';

// ── SLA 严重级别 ──
const SLA_SEVERITY = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

// ── SLA 定义 ──
const SLA_DEFINITIONS = {
  // ── 启动性能 ──
  'agent.startup.total': {
    description: 'Agent 冷启动总时间（含自检）',
    unit: 'ms',
    target: 5000,
    critical: 15000,
    warning: 8000,
    severity: SLA_SEVERITY.CRITICAL,
  },
  'agent.constructor.total': {
    description: 'Agent 构造函数总时间（不含LLM调用）',
    unit: 'ms',
    target: 500,
    critical: 2000,
    warning: 1000,
    severity: SLA_SEVERITY.WARNING,
  },
  'agent.selfcheck.total': {
    description: '启动自检总时间（Phase 0-2）',
    unit: 'ms',
    target: 3000,
    critical: 10000,
    warning: 5000,
    severity: SLA_SEVERITY.CRITICAL,
  },

  // ── 消息处理 ──
  'message.process.total': {
    description: '消息管道处理总时间（receive → analyze → dispatch）',
    unit: 'ms',
    target: 100,
    critical: 2000,
    warning: 500,
    severity: SLA_SEVERITY.WARNING,
  },
  'message.receive.throughput': {
    description: '消息接收吞吐量',
    unit: 'ops/sec',
    target: 1000,
    critical: 100,
    warning: 500,
    severity: SLA_SEVERITY.WARNING,
  },
  'message.analyze.latency': {
    description: '消息分析延迟（意图识别+实体提取+情感分析）',
    unit: 'ms',
    target: 50,
    critical: 500,
    warning: 200,
    severity: SLA_SEVERITY.INFO,
  },

  // ── TICK 处理 ──
  'tick.process.latency': {
    description: '单个 TICK 处理时间',
    unit: 'ms',
    target: 500,
    critical: 5000,
    warning: 2000,
    severity: SLA_SEVERITY.WARNING,
  },
  'tick.process.throughput': {
    description: 'TICK 处理吞吐量',
    unit: 'ticks/min',
    target: 60,
    critical: 10,
    warning: 30,
    severity: SLA_SEVERITY.WARNING,
  },

  // ── 记忆操作 ──
  'memory.upsert.latency': {
    description: '记忆写入延迟',
    unit: 'ms',
    target: 10,
    critical: 100,
    warning: 50,
    severity: SLA_SEVERITY.WARNING,
  },
  'memory.upsert.throughput': {
    description: '记忆写入吞吐量',
    unit: 'ops/sec',
    target: 500,
    critical: 50,
    warning: 200,
    severity: SLA_SEVERITY.WARNING,
  },
  'memory.search.latency': {
    description: '记忆搜索延迟',
    unit: 'ms',
    target: 20,
    critical: 200,
    warning: 100,
    severity: SLA_SEVERITY.WARNING,
  },
  'memory.search.throughput': {
    description: '记忆搜索吞吐量',
    unit: 'ops/sec',
    target: 200,
    critical: 20,
    warning: 100,
    severity: SLA_SEVERITY.INFO,
  },

  // ── 事件总线 ──
  'eventbus.dispatch.latency': {
    description: '事件派发延迟',
    unit: 'ms',
    target: 1,
    critical: 50,
    warning: 10,
    severity: SLA_SEVERITY.WARNING,
  },
  'eventbus.dispatch.throughput': {
    description: '事件派发吞吐量',
    unit: 'ops/sec',
    target: 10000,
    critical: 1000,
    warning: 5000,
    severity: SLA_SEVERITY.INFO,
  },
  'eventbus.trace.latency': {
    description: '事件追踪链延迟（startTrace → completeTrace）',
    unit: 'ms',
    target: 0.5,
    critical: 10,
    warning: 5,
    severity: SLA_SEVERITY.INFO,
  },

  // ── Token 预算 ──
  'budget.request.latency': {
    description: 'Token 预算请求延迟',
    unit: 'ms',
    target: 0.1,
    critical: 10,
    warning: 1,
    severity: SLA_SEVERITY.INFO,
  },
  'budget.request.throughput': {
    description: 'Token 预算请求吞吐量',
    unit: 'ops/sec',
    target: 50000,
    critical: 5000,
    warning: 20000,
    severity: SLA_SEVERITY.INFO,
  },

  // ── API 服务 ──
  'api.response.latency': {
    description: 'API 响应时间（p95）',
    unit: 'ms',
    target: 100,
    critical: 1000,
    warning: 500,
    severity: SLA_SEVERITY.WARNING,
  },
  'api.status.endpoint': {
    description: 'GET /status 端点响应时间',
    unit: 'ms',
    target: 50,
    critical: 500,
    warning: 200,
    severity: SLA_SEVERITY.WARNING,
  },
  'api.version.endpoint': {
    description: 'GET /api/version 端点响应时间',
    unit: 'ms',
    target: 20,
    critical: 200,
    warning: 100,
    severity: SLA_SEVERITY.INFO,
  },

  // ── 资源使用 ──
  'resource.memory.rss': {
    description: '常驻内存集（RSS）大小',
    unit: 'MB',
    target: 100,
    critical: 512,
    warning: 256,
    severity: SLA_SEVERITY.WARNING,
  },
  'resource.memory.heap': {
    description: '堆内存使用量',
    unit: 'MB',
    target: 50,
    critical: 256,
    warning: 128,
    severity: SLA_SEVERITY.WARNING,
  },
  'resource.cpu.usage': {
    description: 'CPU 使用率（百分比）',
    unit: '%',
    target: 30,
    critical: 90,
    warning: 70,
    severity: SLA_SEVERITY.INFO,
  },
  'resource.eventloop.lag': {
    description: '事件循环延迟（p99）',
    unit: 'ms',
    target: 5,
    critical: 100,
    warning: 30,
    severity: SLA_SEVERITY.CRITICAL,
  },
};

// ── SLA 检查函数 ──

/**
 * 检查单个指标是否符合 SLA
 * @param {string} metricName - 指标名称
 * @param {number} value - 测量值
 * @returns {{ pass: boolean, severity: string, target: number, threshold: number, description: string }}
 */
function checkSLA(metricName, value) {
  const sla = SLA_DEFINITIONS[metricName];
  if (!sla) {
    return {
      pass: true,
      severity: SLA_SEVERITY.INFO,
      target: null,
      threshold: null,
      description: `未知指标: ${metricName}`,
    };
  }

  let threshold = sla.target;
  let exceededLevel = null;

  if (value > sla.critical) {
    threshold = sla.critical;
    exceededLevel = SLA_SEVERITY.CRITICAL;
  } else if (value > sla.warning) {
    threshold = sla.warning;
    exceededLevel = SLA_SEVERITY.WARNING;
  } else if (value > sla.target) {
    threshold = sla.target;
    exceededLevel = SLA_SEVERITY.INFO;
  }

  return {
    pass: !exceededLevel || exceededLevel === SLA_SEVERITY.INFO,
    severity: exceededLevel || SLA_SEVERITY.INFO,
    value,
    target: sla.target,
    threshold,
    unit: sla.unit,
    description: sla.description,
  };
}

/**
 * 批量检查多个指标
 * @param {Array<{ name: string, value: number }>} metrics
 * @returns {{ allPass: boolean, results: object, failures: Array }}
 */
function checkSLABatch(metrics) {
  const results = {};
  const failures = [];

  for (const { name, value } of metrics) {
    const result = checkSLA(name, value);
    results[name] = result;
    if (!result.pass && result.severity !== SLA_SEVERITY.INFO) {
      failures.push(result);
    }
  }

  return {
    allPass: failures.length === 0,
    results,
    failures,
  };
}

/**
 * 获取所有 SLA 定义
 * @returns {object}
 */
function getAllSLADefinitions() {
  return { ...SLA_DEFINITIONS };
}

/**
 * 获取 SLA 报告（格式化输出）
 * @param {object} metrics - { metricName: value }
 * @returns {string} 格式化的报告文本
 */
function generateSLAReport(metrics) {
  const batch = Object.entries(metrics).map(([name, value]) => ({ name, value }));
  const { results, failures, allPass } = checkSLABatch(batch);

  let report = '══════ 性能 SLA 报告 ══════\n\n';

  // 按严重性排序
  const sorted = Object.entries(results).sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return (order[a[1].severity] || 3) - (order[b[1].severity] || 3);
  });

  for (const [name, result] of sorted) {
    const icon = result.pass ? '✅' : result.severity === SLA_SEVERITY.CRITICAL ? '🔴' : '⚠️';
    report += `${icon} ${name}\n`;
    report += `   描述: ${result.description}\n`;
    report += `   值: ${result.value?.toFixed?.(2) || result.value} ${result.unit}\n`;
    report += `   目标: ≤${result.target} ${result.unit}\n`;
    if (!result.pass) {
      report += `   阈值: ${result.threshold} ${result.unit} [${result.severity.toUpperCase()}]\n`;
    }
    report += '\n';
  }

  report += `──────────────────────────\n`;
  report += `总计: ${Object.keys(results).length} 项指标\n`;
  report += `通过: ${Object.values(results).filter(r => r.pass).length}\n`;
  report += `失败: ${failures.length}\n`;
  report += `结论: ${allPass ? '✅ 所有 SLA 指标达标' : '❌ 存在 SLA 违规'}\n`;

  return report;
}

module.exports = {
  SLA_SEVERITY,
  SLA_DEFINITIONS,
  checkSLA,
  checkSLABatch,
  getAllSLADefinitions,
  generateSLAReport,
};
