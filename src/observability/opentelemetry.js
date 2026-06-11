/**
 * 蜜糖 TriCore Agent — OpenTelemetry 可观测性集成
 *
 * 提供分布式链路追踪 (Tracing) 和指标导出 (Metrics)：
 *   - Tracing: OTLP gRPC/HTTP 导出器 → Jaeger / Tempo / Grafana Cloud
 *   - Metrics: Prometheus 导出器（兼容现有 tricore_ 前缀指标）
 *   - 自动插桩: HTTP (http模块) / gRPC (可选)
 *   - 自定义 Span: 意识核 TICK / 任务执行 / 记忆整合 / API 请求
 *   - 优雅关闭: SIGTERM/SIGINT 时刷新未发送的数据
 *
 * 环境变量配置:
 *   OTEL_SERVICE_NAME          — 服务名称 (默认: mitang-tricore-agent)
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP Collector 端点 (默认: http://localhost:4318)
 *   OTEL_TRACES_EXPORTER       — 追踪导出器: otlp | console | none (默认: otlp)
 *   OTEL_METRICS_EXPORTER      — 指标导出器: prometheus | otlp | console | none (默认: prometheus)
 *   OTEL_LOG_LEVEL             — SDK 日志级别: info | warn | error | debug | verbose (默认: info)
 *   OTEL_PROPAGATORS           — 传播器: tracecontext,baggage (默认: tracecontext,baggage)
 *   OTEL_RESOURCE_ATTRIBUTES   — 额外资源属性 (key=value,key=value)
 *
 * 使用方式:
 *   // 在应用入口尽早引入（在所有其他 require 之前）
 *   const { initOpenTelemetry } = require('./src/observability/opentelemetry');
 *   const otel = initOpenTelemetry();
 *
 *   // 创建自定义 Span
 *   const { trace } = require('@opentelemetry/api');
 *   const tracer = trace.getTracer('tricore-agent');
 *   await tracer.startActiveSpan('consciousness.tick', async (span) => {
 *     // ... TICK 逻辑 ...
 *     span.end();
 *   });
 *
 *   // 优雅关闭
 *   process.on('SIGTERM', async () => {
 *     await otel.shutdown();
 *     process.exit(0);
 *   });
 */

'use strict';

// ── 模块状态 ──
let _initialized = false;
let _sdkProvider = null;
let _meterProvider = null;
let _tracerProvider = null;
let _config = null;

/**
 * 从环境变量读取 OpenTelemetry 配置
 */
function _loadConfig() {
  if (_config) return _config;

  _config = {
    serviceName: process.env.OTEL_SERVICE_NAME || 'mitang-tricore-agent',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
    tracesExporter: process.env.OTEL_TRACES_EXPORTER || 'otlp',
    metricsExporter: process.env.OTEL_METRICS_EXPORTER || 'prometheus',
    logLevel: process.env.OTEL_LOG_LEVEL || 'info',
    propagators: process.env.OTEL_PROPAGATORS || 'tracecontext,baggage',
    resourceAttributes: process.env.OTEL_RESOURCE_ATTRIBUTES || '',
    // 采样率 (0.0 ~ 1.0, 默认全部采样)
    samplingRatio: parseFloat(process.env.OTEL_SAMPLING_RATIO || '1.0'),
    // 指标导出端口 (Prometheus exporter)
    metricsPort: parseInt(process.env.OTEL_METRICS_PORT || '9464', 10),
    // 是否启用控制台调试导出
    debugEnabled: process.env.OTEL_DEBUG_ENABLED === 'true',
  };

  return _config;
}

/**
 * 安全加载可选依赖，如果未安装则返回 null
 */
function _safeRequire(moduleName) {
  try {
    return require(moduleName);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

/**
 * 构建 Resource 属性
 */
function _buildResourceAttributes(cfg) {
  const attributes = {
    'service.name': cfg.serviceName,
    'service.version': '1.0.0',
    'service.namespace': 'mitang-tricore',
    'deployment.environment': process.env.NODE_ENV || 'production',
  };

  // 解析额外属性
  if (cfg.resourceAttributes) {
    cfg.resourceAttributes.split(',').forEach(pair => {
      const eqIndex = pair.indexOf('=');
      if (eqIndex > 0) {
        attributes[pair.slice(0, eqIndex).trim()] = pair.slice(eqIndex + 1).trim();
      }
    });
  }

  return attributes;
}

/**
 * 创建 SpanProcessor 列表
 */
function _createSpanProcessors(cfg) {
  const processors = [];

  // BatchSpanProcessor — 所有导出器的基础处理器
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');

  if (cfg.tracesExporter === 'otlp') {
    const otlpExporter = _createOtlpTraceExporter(cfg);
    if (otlpExporter) {
      processors.push(new BatchSpanProcessor(otlpExporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 30000,
      }));
    }
  }

  if (cfg.tracesExporter === 'console' || cfg.debugEnabled) {
    const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
    processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  return processors;
}

/**
 * 创建 OTLP Trace 导出器
 */
function _createOtlpTraceExporter(cfg) {
  const OTLPTraceExporter = _safeRequire('@opentelemetry/exporter-trace-otlp-http');
  if (!OTLPTraceExporter) {
    console.warn('[OpenTelemetry] @opentelemetry/exporter-trace-otlp-http 未安装，追踪导出已禁用');
    return null;
  }

  const OTLPTraceExporterClass = OTLPTraceExporter.OTLPTraceExporter || OTLPTraceExporter;
  return new OTLPTraceExporterClass({
    url: `${cfg.otlpEndpoint}/v1/traces`,
    headers: {},
    timeoutMillis: 15000,
  });
}

/**
 * 创建 OTLP Metric 导出器
 */
function _createOtlpMetricExporter(cfg) {
  const OTLPMetricExporter = _safeRequire('@opentelemetry/exporter-metrics-otlp-http');
  if (!OTLPMetricExporter) {
    console.warn('[OpenTelemetry] @opentelemetry/exporter-metrics-otlp-http 未安装，OTLP 指标导出已禁用');
    return null;
  }

  const OTLPMetricExporterClass = OTLPMetricExporter.OTLPMetricExporter || OTLPMetricExporter;
  return new OTLPMetricExporterClass({
    url: `${cfg.otlpEndpoint}/v1/metrics`,
    headers: {},
    timeoutMillis: 15000,
  });
}

/**
 * 初始化 Tracing (TracerProvider + SpanProcessors)
 */
function _initTracing(cfg) {
  const sdk = require('@opentelemetry/sdk-trace-base');
  const resources = require('@opentelemetry/resources');
  const semconv = require('@opentelemetry/semantic-conventions');

  const resource = new resources.Resource(_buildResourceAttributes(cfg));
  const spanProcessors = _createSpanProcessors(cfg);

  if (spanProcessors.length === 0) {
    console.warn('[OpenTelemetry] 无可用 SpanProcessor，追踪已禁用');
    return null;
  }

  // 采样器
  let sampler;
  if (cfg.samplingRatio >= 1.0) {
    sampler = new sdk.AlwaysOnSampler();
  } else if (cfg.samplingRatio <= 0) {
    sampler = new sdk.AlwaysOffSampler();
  } else {
    sampler = new sdk.TraceIdRatioBasedSampler(cfg.samplingRatio);
  }

  const tracerProvider = new sdk.BasicTracerProvider({
    resource,
    sampler,
    spanProcessors,
  });

  // 注册全局 TracerProvider
  const api = require('@opentelemetry/api');
  api.trace.setGlobalTracerProvider(tracerProvider);

  return tracerProvider;
}

/**
 * 初始化 Metrics (MeterProvider + 导出器)
 */
function _initMetrics(cfg) {
  const MeterProvider = _safeRequire('@opentelemetry/sdk-metrics');
  if (!MeterProvider) {
    console.warn('[OpenTelemetry] @opentelemetry/sdk-metrics 未安装，指标已禁用');
    return null;
  }

  const resources = require('@opentelemetry/resources');
  const resource = new resources.Resource(_buildResourceAttributes(cfg));

  const meterProvider = new MeterProvider.MeterProvider({
    resource,
  });

  // Prometheus 导出器
  if (cfg.metricsExporter === 'prometheus') {
    const PrometheusExporter = _safeRequire('@opentelemetry/exporter-prometheus');
    if (PrometheusExporter) {
      const PrometheusClass = PrometheusExporter.PrometheusExporter || PrometheusExporter;
      meterProvider.addMetricReader(new PrometheusClass({
        port: cfg.metricsPort,
        endpoint: '/metrics',
      }));
    } else {
      console.warn('[OpenTelemetry] @opentelemetry/exporter-prometheus 未安装，Prometheus 导出已禁用');
    }
  }

  // OTLP 指标导出器
  if (cfg.metricsExporter === 'otlp') {
    const otlpMetricExporter = _createOtlpMetricExporter(cfg);
    if (otlpMetricExporter) {
      const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
      meterProvider.addMetricReader(new PeriodicExportingMetricReader({
        exporter: otlpMetricExporter,
        exportIntervalMillis: 60000,
      }));
    }
  }

  // 控制台调试导出
  if (cfg.metricsExporter === 'console' || cfg.debugEnabled) {
    const { PeriodicExportingMetricReader, ConsoleMetricExporter } = require('@opentelemetry/sdk-metrics');
    meterProvider.addMetricReader(new PeriodicExportingMetricReader({
      exporter: new ConsoleMetricExporter(),
      exportIntervalMillis: 30000,
    }));
  }

  const api = require('@opentelemetry/api');
  api.metrics.setGlobalMeterProvider(meterProvider);

  return meterProvider;
}

/**
 * 设置上下文传播器
 */
function _initPropagation(cfg) {
  const api = require('@opentelemetry/api');

  const propagatorMap = {
    tracecontext: () => {
      const mod = _safeRequire('@opentelemetry/propagator-tracecontext');
      return mod ? new mod.W3CTraceContextPropagator() : null;
    },
    baggage: () => {
      const mod = _safeRequire('@opentelemetry/propagator-baggage');
      return mod ? new mod.W3CBaggagePropagator() : null;
    },
    b3: () => {
      const mod = _safeRequire('@opentelemetry/propagator-b3');
      return mod ? new mod.B3Propagator() : null;
    },
    jaeger: () => {
      const mod = _safeRequire('@opentelemetry/propagator-jaeger');
      return mod ? new mod.JaegerPropagator() : null;
    },
  };

  const propagators = cfg.propagators
    .split(',')
    .map(name => name.trim())
    .filter(name => propagatorMap[name])
    .map(name => propagatorMap[name]())
    .filter(Boolean);

  if (propagators.length > 0) {
    api.propagation.setGlobalPropagator(new api.CompositePropagator({ propagators }));
  }
}

/**
 * 注册自动插桩（HTTP/gRPC 等）
 */
function _initAutoInstrumentation(cfg) {
  const autoInstrumentations = _safeRequire('@opentelemetry/auto-instrumentations-node');
  if (!autoInstrumentations) {
    return;
  }

  const { getNodeAutoInstrumentations } = autoInstrumentations;
  const sdkNode = _safeRequire('@opentelemetry/sdk-node');

  if (!sdkNode) return;

  // 使用 sdk-node 注册自动插桩
  const autoInstrumentConfig = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-http': {
      enabled: true,
      ignoreIncomingRequestHook: (request) => {
        // 忽略健康检查和指标端点的追踪
        const ignoredPaths = ['/health', '/ready', '/live', '/metrics'];
        return ignoredPaths.some(p => request.url && request.url.startsWith(p));
      },
      requireParentforOutgoingSpans: true,
    },
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
  });

  try {
    // 直接注册自动插桩库
    const httpInstrumentation = _safeRequire('@opentelemetry/instrumentation-http');
    if (httpInstrumentation) {
      const HttpInstrumentation = httpInstrumentation.HttpInstrumentation || httpInstrumentation;
      const inst = new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => {
          const ignoredPaths = ['/health', '/ready', '/live', '/metrics'];
          return ignoredPaths.some(p => request.url && request.url.startsWith(p));
        },
      });
      inst.enable();
    }
  } catch (err) {
    // 自动插桩失败不影响主流程
  }
}

/**
 * 注册自定义 Tracer（为 TriCore 核心流程创建预配置的 Tracer）
 */
function _createCustomTracers() {
  const api = require('@opentelemetry/api');

  const tracers = {
    consciousness: api.trace.getTracer('tricore-consciousness', '1.0.0'),
    execution: api.trace.getTracer('tricore-execution', '1.0.0'),
    evolution: api.trace.getTracer('tricore-evolution', '1.0.0'),
    api: api.trace.getTracer('tricore-api', '1.0.0'),
    memory: api.trace.getTracer('tricore-memory', '1.0.0'),
    llm: api.trace.getTracer('tricore-llm', '1.0.0'),
  };

  return tracers;
}

/**
 * 创建自定义 Meter（为 TriCore 核心指标创建预配置的 Meter）
 */
function _createCustomMeters() {
  const api = require('@opentelemetry/api');

  const meter = api.metrics.getMeter('tricore-agent', '1.0.0');

  // ── TICK 处理指标 ──
  const tickCounter = meter.createCounter('tricore_ticks_total', {
    description: 'Total number of consciousness TICKs processed',
    unit: '{tick}',
  });

  const tickDuration = meter.createHistogram('tricore_tick_duration_ms', {
    description: 'TICK processing duration in milliseconds',
    unit: 'ms',
  });

  // ── 任务执行指标 ──
  const taskCounter = meter.createCounter('tricore_tasks_total', {
    description: 'Total number of tasks executed',
    unit: '{task}',
  });

  const taskStatusCounter = meter.createCounter('tricore_tasks_by_status', {
    description: 'Tasks grouped by final status',
    unit: '{task}',
  });

  // ── 记忆操作指标 ──
  const memoryOpsCounter = meter.createCounter('tricore_memory_ops_total', {
    description: 'Total memory operations (store/recall/consolidate)',
    unit: '{operation}',
  });

  const memoryConsolidationDuration = meter.createHistogram('tricore_memory_consolidation_duration_ms', {
    description: 'Memory consolidation duration in milliseconds',
    unit: 'ms',
  });

  // ── LLM 调用指标 ──
  const llmCallCounter = meter.createCounter('tricore_llm_calls_total', {
    description: 'Total LLM API calls',
    unit: '{call}',
  });

  const llmCallDuration = meter.createHistogram('tricore_llm_call_duration_ms', {
    description: 'LLM API call duration in milliseconds',
    unit: 'ms',
  });

  const llmTokenCounter = meter.createCounter('tricore_llm_tokens_total', {
    description: 'Total tokens consumed by LLM calls',
    unit: '{token}',
  });

  // ── API 请求指标 ──
  const apiRequestCounter = meter.createCounter('tricore_api_requests_total', {
    description: 'Total HTTP API requests',
    unit: '{request}',
  });

  const apiRequestDuration = meter.createHistogram('tricore_api_request_duration_ms', {
    description: 'HTTP API request duration in milliseconds',
    unit: 'ms',
  });

  // ── 总线事件指标 ──
  const busEventCounter = meter.createCounter('tricore_bus_events_total', {
    description: 'Total events processed on the Core Bus',
    unit: '{event}',
  });

  return {
    tickCounter,
    tickDuration,
    taskCounter,
    taskStatusCounter,
    memoryOpsCounter,
    memoryConsolidationDuration,
    llmCallCounter,
    llmCallDuration,
    llmTokenCounter,
    apiRequestCounter,
    apiRequestDuration,
    busEventCounter,
  };
}

/**
 * 初始化 OpenTelemetry SDK
 *
 * @param {Object} [options] - 覆盖配置
 * @param {string} [options.serviceName] - 服务名称
 * @param {string} [options.otlpEndpoint] - OTLP Collector 端点
 * @param {string} [options.tracesExporter] - 追踪导出器类型
 * @param {string} [options.metricsExporter] - 指标导出器类型
 * @returns {Object} { shutdown, config, tracers, meters }
 */
function initOpenTelemetry(options = {}) {
  if (_initialized) {
    return {
      shutdown: _shutdown,
      config: _config,
      tracers: _tracers,
      meters: _meters,
    };
  }

  const cfg = _loadConfig();

  // 合并选项覆盖
  Object.assign(cfg, options);

  try {
    // 1. 传播器 (必须在 Tracing 之前设置)
    _initPropagation(cfg);

    // 2. 初始化 Tracing
    _tracerProvider = _initTracing(cfg);

    // 3. 初始化 Metrics
    _meterProvider = _initMetrics(cfg);

    // 4. 自动插桩
    _initAutoInstrumentation(cfg);

    // 5. 创建自定义 Tracers 和 Meters
    _tracers = _createCustomTracers();
    _meters = _createCustomMeters();

    _initialized = true;

    const diag = _safeRequire('@opentelemetry/api');
    if (diag && diag.diag) {
      const logLevels = { none: 0, error: 1, warn: 2, info: 3, debug: 4, verbose: 5 };
      const level = logLevels[cfg.logLevel] || 3;
      diag.diag.setLogger(new diag.DiagConsoleLogger(), level);
    }

    console.log(`[OpenTelemetry] 初始化完成 — 服务: ${cfg.serviceName}, ` +
      `追踪: ${cfg.tracesExporter}, 指标: ${cfg.metricsExporter}, ` +
      `OTLP端点: ${cfg.otlpEndpoint}`);

  } catch (err) {
    console.warn(`[OpenTelemetry] 初始化失败 (降级运行): ${err.message}`);
    console.warn(err.stack);

    // 降级: 返回空操作对象，不阻止应用启动
    _initialized = true;
    _tracers = _createNoopTracers();
    _meters = _createNoopMeters();
  }

  return {
    shutdown: _shutdown,
    config: cfg,
    tracers: _tracers,
    meters: _meters,
  };
}

/**
 * 优雅关闭 — 刷新未发送的 Span 和 Metric 数据
 */
async function _shutdown() {
  const shutdowns = [];

  if (_tracerProvider) {
    shutdowns.push(
      _tracerProvider.shutdown().catch(err =>
        console.warn(`[OpenTelemetry] TracerProvider shutdown 失败: ${err.message}`)
      )
    );
  }

  if (_meterProvider) {
    shutdowns.push(
      _meterProvider.shutdown().catch(err =>
        console.warn(`[OpenTelemetry] MeterProvider shutdown 失败: ${err.message}`)
      )
    );
  }

  await Promise.allSettled(shutdowns);
  console.log('[OpenTelemetry] 已关闭，所有数据已刷新');
}

/**
 * 创建空操作 Tracers（降级模式）
 */
function _createNoopTracers() {
  const api = require('@opentelemetry/api');
  const noopTracer = api.trace.getTracer('noop');
  return {
    consciousness: noopTracer,
    execution: noopTracer,
    evolution: noopTracer,
    api: noopTracer,
    memory: noopTracer,
    llm: noopTracer,
  };
}

/**
 * 创建空操作 Meters（降级模式）
 */
function _createNoopMeters() {
  const api = require('@opentelemetry/api');
  const noopMeter = api.metrics.getMeter('noop');
  const noopCounter = noopMeter.createCounter('noop');
  const noopHistogram = noopMeter.createHistogram('noop');
  return {
    tickCounter: noopCounter,
    tickDuration: noopHistogram,
    taskCounter: noopCounter,
    taskStatusCounter: noopCounter,
    memoryOpsCounter: noopCounter,
    memoryConsolidationDuration: noopHistogram,
    llmCallCounter: noopCounter,
    llmCallDuration: noopHistogram,
    llmTokenCounter: noopCounter,
    apiRequestCounter: noopCounter,
    apiRequestDuration: noopHistogram,
    busEventCounter: noopCounter,
  };
}

// ── 便捷工具函数 ──

/**
 * 在 Span 上下文中执行异步函数
 *
 * @param {object} tracer - OpenTelemetry Tracer
 * @param {string} spanName - Span 名称
 * @param {object} [attributes] - Span 属性
 * @param {Function} fn - 要在 Span 中执行的异步函数
 * @returns {Promise<any>} fn 的返回值
 */
async function withSpan(tracer, spanName, attributes, fn) {
  // 支持 attributes 参数可选
  if (typeof attributes === 'function') {
    fn = attributes;
    attributes = {};
  }

  return tracer.startActiveSpan(spanName, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      span.setStatus({ code: 2, message: err.message }); // ERROR
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * 记录 TICK 处理的自定义 Span
 *
 * @param {object} tracer - consciousness tracer
 * @param {object} tickInfo - TICK 信息
 * @param {string} tickInfo.layer - 思考层 (reflexive/deliberative/deep)
 * @param {string} tickInfo.type - TICK 类型
 * @param {number} tickInfo.sequenceNumber - TICK 序号
 * @returns {object} Span 对象
 */
function startTickSpan(tracer, tickInfo = {}) {
  const span = tracer.startSpan('consciousness.tick', {
    attributes: {
      'tricore.tick.layer': tickInfo.layer || 'unknown',
      'tricore.tick.type': tickInfo.type || 'unknown',
      'tricore.tick.sequence': tickInfo.sequenceNumber || 0,
    },
  });
  return span;
}

/**
 * 记录任务执行的自定义 Span
 *
 * @param {object} tracer - execution tracer
 * @param {object} taskInfo - 任务信息
 * @returns {object} Span 对象
 */
function startTaskSpan(tracer, taskInfo = {}) {
  const span = tracer.startSpan('execution.task', {
    attributes: {
      'tricore.task.id': taskInfo.id || 'unknown',
      'tricore.task.type': taskInfo.type || 'unknown',
      'tricore.task.priority': taskInfo.priority || 'normal',
    },
  });
  return span;
}

/**
 * 记录记忆整合的自定义 Span
 *
 * @param {object} tracer - memory tracer
 * @param {object} consolidationInfo - 整合信息
 * @returns {object} Span 对象
 */
function startConsolidationSpan(tracer, consolidationInfo = {}) {
  const span = tracer.startSpan('memory.consolidation', {
    attributes: {
      'tricore.memory.tier': consolidationInfo.tier || 'unknown',
      'tricore.memory.item_count': consolidationInfo.itemCount || 0,
    },
  });
  return span;
}

/**
 * 记录 API 请求的自定义 Span
 *
 * @param {object} tracer - api tracer
 * @param {object} reqInfo - 请求信息
 * @returns {object} Span 对象
 */
function startApiSpan(tracer, reqInfo = {}) {
  const span = tracer.startSpan('api.request', {
    attributes: {
      'tricore.api.method': reqInfo.method || 'GET',
      'tricore.api.route': reqInfo.route || 'unknown',
      'tricore.api.content_type': reqInfo.contentType || 'unknown',
    },
  });
  return span;
}

// ── 模块变量 ──
let _tracers = null;
let _meters = null;

// ── 导出 ──
module.exports = {
  initOpenTelemetry,
  withSpan,
  startTickSpan,
  startTaskSpan,
  startConsolidationSpan,
  startApiSpan,
};
