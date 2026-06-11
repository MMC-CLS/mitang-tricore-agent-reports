/**
 * TriCore Agent - Prometheus 指标导出器 (Phase 26)
 *
 * 提供完整的 Prometheus 格式指标导出：
 *   1. Counter - 只增不减的计数器
 *   2. Gauge - 可增可减的仪表盘
 *   3. Histogram - 分布统计
 *   4. Summary - 摘要统计
 *
 * 内置指标：
 *   - HTTP请求数/延迟/错误率
 *   - TICK处理速率/延迟
 *   - Token预算使用率
 *   - 内存/CPU使用率
 *   - 事件总线吞吐量
 *   - 消息队列深度
 *   - 三核状态指标
 */

'use strict';

class PrometheusMetrics {
  constructor(options = {}) {
    this._prefix = options.prefix || 'tricore_';
    this._labels = options.defaultLabels || {};
    this._collectors = [];

    // Counter注册表
    this._counters = new Map();

    // Gauge注册表
    this._gauges = new Map();

    // Histogram注册表
    this._histograms = new Map();

    // Summary注册表
    this._summaries = new Map();

    // 注册默认指标
    this._registerDefaults();
  }

  /**
   * 创建Counter
   */
  createCounter(name, help, labelNames = []) {
    const fullName = this._prefix + name;
    if (this._counters.has(fullName)) return this._counters.get(fullName);

    const counter = new Counter(fullName, help, labelNames);
    this._counters.set(fullName, counter);
    return counter;
  }

  /**
   * 创建Gauge
   */
  createGauge(name, help, labelNames = []) {
    const fullName = this._prefix + name;
    if (this._gauges.has(fullName)) return this._gauges.get(fullName);

    const gauge = new Gauge(fullName, help, labelNames);
    this._gauges.set(fullName, gauge);
    return gauge;
  }

  /**
   * 创建Histogram
   */
  createHistogram(name, help, labelNames = [], buckets) {
    const fullName = this._prefix + name;
    if (this._histograms.has(fullName)) return this._histograms.get(fullName);

    const histogram = new Histogram(fullName, help, labelNames, buckets);
    this._histograms.set(fullName, histogram);
    return histogram;
  }

  /**
   * 创建Summary
   */
  createSummary(name, help, labelNames = [], quantiles) {
    const fullName = this._prefix + name;
    if (this._summaries.has(fullName)) return this._summaries.get(fullName);

    const summary = new Summary(fullName, help, labelNames, quantiles);
    this._summaries.set(fullName, summary);
    return summary;
  }

  /**
   * 注册内置默认指标
   */
  _registerDefaults() {
    // HTTP指标
    this.httpRequestsTotal = this.createCounter('http_requests_total', 'Total HTTP requests', ['method', 'path', 'status']);
    this.httpRequestDuration = this.createHistogram('http_request_duration_seconds', 'HTTP request duration', ['method', 'path'], [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]);
    this.httpRequestsInFlight = this.createGauge('http_requests_in_flight', 'HTTP requests currently in flight');

    // TICK指标
    this.ticksTotal = this.createCounter('ticks_total', 'Total TICKs processed', ['type']);
    this.tickDuration = this.createHistogram('tick_duration_seconds', 'TICK processing duration', ['type'], [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30]);
    this.ticksActive = this.createGauge('ticks_active', 'Active TICKs being processed');

    // Token预算指标
    this.tokenBudgetUsage = this.createGauge('token_budget_usage_ratio', 'Token budget usage ratio', ['core', 'period']);
    this.tokenBudgetLimit = this.createGauge('token_budget_limit', 'Token budget limit', ['core', 'period']);
    this.tokenThrottleLevel = this.createGauge('token_throttle_level', 'Token throttle level (0=none, 1=light, 2=moderate, 3=heavy, 4=emergency)');

    // 事件总线指标
    this.busEventsTotal = this.createCounter('bus_events_total', 'Total events on core bus', ['type', 'source']);
    this.busEventsLatency = this.createHistogram('bus_event_latency_seconds', 'Core bus event latency', ['type'], [0.001, 0.005, 0.01, 0.05, 0.1, 0.5]);

    // 消息队列指标
    this.mqDepth = this.createGauge('message_queue_depth', 'Message queue depth');
    this.mqDeadLetters = this.createGauge('message_queue_dead_letters', 'Dead letter queue depth');
    this.mqEnqueuedTotal = this.createCounter('message_queue_enqueued_total', 'Total messages enqueued');
    this.mqProcessedTotal = this.createCounter('message_queue_processed_total', 'Total messages processed');

    // 内存指标
    this.heapUsed = this.createGauge('heap_used_bytes', 'Heap memory used');
    this.heapTotal = this.createGauge('heap_total_bytes', 'Heap memory total');
    this.rss = this.createGauge('rss_bytes', 'RSS memory');
    this.externalMemory = this.createGauge('external_memory_bytes', 'External memory');

    // CPU指标
    this.cpuUsage = this.createGauge('cpu_usage_percent', 'CPU usage percentage');
    this.eventLoopDelay = this.createGauge('event_loop_delay_ms', 'Event loop delay in ms');

    // 三核状态指标
    this.coreStatus = this.createGauge('core_status', 'Core running status (1=running, 0=stopped)', ['core']);
    this.coreTasksTotal = this.createCounter('core_tasks_total', 'Total tasks per core', ['core', 'status']);

    // LLM指标
    this.llmRequestsTotal = this.createCounter('llm_requests_total', 'Total LLM API requests', ['provider', 'purpose', 'status']);
    this.llmTokensUsed = this.createCounter('llm_tokens_used_total', 'Total LLM tokens used', ['provider', 'type']);
    this.llmRequestDuration = this.createHistogram('llm_request_duration_seconds', 'LLM request duration', ['provider', 'purpose'], [0.1, 0.5, 1, 2, 5, 10, 30, 60]);

    // 系统信息
    this.nodeInfo = this.createGauge('nodejs_info', 'Node.js version info', ['version']);
    this.nodeInfo.set({ version: process.version }, 1);
    this.uptime = this.createGauge('uptime_seconds', 'Process uptime in seconds');
  }

  /**
   * 更新系统指标（定期调用）
   */
  updateSystemMetrics() {
    const mem = process.memoryUsage();
    this.heapUsed.set(mem.heapUsed);
    this.heapTotal.set(mem.heapTotal);
    this.rss.set(mem.rss);
    this.externalMemory.set(mem.external);

    this.uptime.set(process.uptime());

    // 事件循环延迟
    try {
      const { monitorEventLoopDelay } = require('perf_hooks');
      if (typeof monitorEventLoopDelay === 'function') {
        const hist = monitorEventLoopDelay({ resolution: 20 });
        hist.enable();
        setTimeout(() => {
          this.eventLoopDelay.set(hist.mean / 1e6);
          hist.disable();
        }, 100);
      }
    } catch {}
  }

  /**
   * 导出所有指标为 Prometheus 文本格式
   */
  export() {
    const lines = [];

    // 导出Counters
    for (const [name, counter] of this._counters) {
      lines.push(`# HELP ${name} ${counter._help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const entry of counter._values) {
        const labels = this._formatLabels(entry.labels);
        lines.push(`${name}${labels} ${entry.value}`);
      }
    }

    // 导出Gauges
    for (const [name, gauge] of this._gauges) {
      lines.push(`# HELP ${name} ${gauge._help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const entry of gauge._values) {
        const labels = this._formatLabels(entry.labels);
        lines.push(`${name}${labels} ${entry.value}`);
      }
    }

    // 导出Histograms
    for (const [name, histogram] of this._histograms) {
      lines.push(`# HELP ${name} ${histogram._help}`);
      lines.push(`# TYPE ${name} histogram`);

      for (const [labelsKey, bucketMap] of histogram._bucketData.entries()) {
        // 解析 labelsKey 为 labels 对象
        const labelParts = labelsKey.split('|');
        const labels = {};
        histogram._labelNames.forEach((n, i) => { labels[n] = labelParts[i] || ''; });
        const lblStr = this._formatLabels(labels);

        let cumCount = 0;
        const sortedBounds = [...bucketMap.keys()].filter(k => k !== Infinity).sort((a, b) => a - b);
        for (const bound of sortedBounds) {
          cumCount += bucketMap.get(bound);
          lines.push(`${name}_bucket${lblStr}{le="${bound}"} ${cumCount}`);
        }
        cumCount += (bucketMap.get(Infinity) || 0);
        lines.push(`${name}_bucket${lblStr}{le="+Inf"} ${cumCount}`);

        const totalCount = cumCount;
        const s = histogram._summaries?.get(labelsKey) || { sum: 0 };
        lines.push(`${name}_count${lblStr} ${totalCount}`);
        lines.push(`${name}_sum${lblStr} ${s.sum}`);
      }
    }

    // 导出Summaries
    for (const [name, summary] of this._summaries) {
      lines.push(`# HELP ${name} ${summary._help}`);
      lines.push(`# TYPE ${name} summary`);
      for (const entry of summary._values) {
        const lblStr = this._formatLabels(entry.labels);
        lines.push(`${name}_count${lblStr} ${entry.count}`);
        lines.push(`${name}_sum${lblStr} ${entry.sum}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  _formatLabels(labels = {}) {
    const parts = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
    return parts.length > 0 ? `{${parts.join(',')}}` : '';
  }

  /**
   * 重置所有指标
   */
  reset() {
    for (const counter of this._counters.values()) counter.reset();
    for (const gauge of this._gauges.values()) gauge.reset();
    for (const histogram of this._histograms.values()) histogram.reset();
    for (const summary of this._summaries.values()) summary.reset();
  }
}

// ═══════════════════════════════════════
// Counter 实现
// ═══════════════════════════════════════

class Counter {
  constructor(name, help, labelNames = []) {
    this._name = name;
    this._help = help;
    this._labelNames = labelNames;
    this._values = []; // [{ labels, value }]
  }

  inc(labels = {}, value = 1) {
    // 处理无标签Counter: inc(value) 或 inc({}, value)
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._labelsKey(labels);
    const existing = this._values.find(v => v._key === key);
    if (existing) {
      existing.value += value;
    } else {
      this._values.push({ labels, value, _key: key });
    }
  }

  get(labels = {}) {
    if (typeof labels === 'number') labels = {};
    const key = this._labelsKey(labels);
    const existing = this._values.find(v => v._key === key);
    return existing ? existing.value : 0;
  }

  _labelsKey(labels) {
    return this._labelNames.map(n => labels[n] || '').join('|');
  }

  reset() {
    this._values = [];
  }
}

// ═══════════════════════════════════════
// Gauge 实现
// ═══════════════════════════════════════

class Gauge {
  constructor(name, help, labelNames = []) {
    this._name = name;
    this._help = help;
    this._labelNames = labelNames;
    this._values = [];
  }

  set(labels = {}, value) {
    // 处理无标签Gauge: set(value) 或 set({label: val}, value)
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._labelsKey(labels);
    const existing = this._values.find(v => v._key === key);
    if (existing) {
      existing.value = value;
    } else {
      this._values.push({ labels, value, _key: key });
    }
  }

  inc(labels = {}, value = 1) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._labelsKey(labels);
    const existing = this._values.find(v => v._key === key);
    if (existing) {
      existing.value += value;
    } else {
      this._values.push({ labels, value, _key: key });
    }
  }

  dec(labels = {}, value = 1) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    this.inc(labels, -value);
  }

  get(labels = {}) {
    if (typeof labels === 'number') labels = {};
    const key = this._labelsKey(labels);
    const existing = this._values.find(v => v._key === key);
    return existing ? existing.value : 0;
  }

  _labelsKey(labels) {
    return this._labelNames.map(n => labels[n] || '').join('|');
  }

  reset() {
    this._values = [];
  }
}

// ═══════════════════════════════════════
// Histogram 实现
// ═══════════════════════════════════════

class Histogram {
  constructor(name, help, labelNames = [], buckets) {
    this._name = name;
    this._help = help;
    this._labelNames = labelNames;
    this._buckets = buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

    // 每个标签组合一个Map: labelsKey → [bucket, count][]
    this._bucketData = new Map();
  }

  observe(labels = {}, value) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._labelsKey(labels);

    if (!this._bucketData.has(key)) {
      const bucketMap = new Map();
      for (const bound of this._buckets) {
        bucketMap.set(bound, 0);
      }
      bucketMap.set(Infinity, 0);
      this._bucketData.set(key, bucketMap);
    }

    const bucketMap = this._bucketData.get(key);

    // 增加对应bucket计数
    for (const bound of [...this._buckets, Infinity]) {
      if (value <= bound) {
        bucketMap.set(bound, bucketMap.get(bound) + 1);
      }
    }

    // 保存count和sum
    if (!this._summaries) this._summaries = new Map();
    if (!this._summaries.has(key)) {
      this._summaries.set(key, { count: 0, sum: 0 });
    }
    const s = this._summaries.get(key);
    s.count++;
    s.sum += value;
  }

  _allLabels() {
    return this._bucketData;
  }

  _labelsKey(labels) {
    return this._labelNames.map(n => labels[n] || '').join('|');
  }

  reset() {
    this._bucketData.clear();
    this._summaries?.clear();
  }
}

// ═══════════════════════════════════════
// Summary 实现
// ═══════════════════════════════════════

class Summary {
  constructor(name, help, labelNames = [], quantiles) {
    this._name = name;
    this._help = help;
    this._labelNames = labelNames;
    this._quantiles = quantiles || [0.5, 0.9, 0.99];
    this._values = []; // [{ labels, count, sum, values[] }]
  }

  observe(labels = {}, value) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._labelsKey(labels);
    let existing = this._values.find(v => v._key === key);
    if (!existing) {
      existing = { labels, count: 0, sum: 0, values: [], _key: key };
      this._values.push(existing);
    }
    existing.count++;
    existing.sum += value;
    existing.values.push(value);

    // 限制样本数
    if (existing.values.length > 1000) {
      existing.values.shift();
    }
  }

  _labelsKey(labels) {
    return this._labelNames.map(n => labels[n] || '').join('|');
  }

  reset() {
    this._values = [];
  }
}

module.exports = {
  PrometheusMetrics,
  Counter,
  Gauge,
  Histogram,
  Summary,
};
