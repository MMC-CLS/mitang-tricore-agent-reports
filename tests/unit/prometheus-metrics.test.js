/**
 * TriCore Agent - Prometheus指标导出器测试 (Phase 26)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PrometheusMetrics } = require('../../src/utils/prometheus-metrics');

test('PrometheusMetrics: Counter 基本操作', async (t) => {
  const metrics = new PrometheusMetrics({ prefix: 'test_' });

  const counter = metrics.createCounter('requests_total', 'Total requests', ['method']);
  counter.inc({ method: 'GET' });
  counter.inc({ method: 'GET' });
  counter.inc({ method: 'POST' });

  assert.strictEqual(counter.get({ method: 'GET' }), 2);
  assert.strictEqual(counter.get({ method: 'POST' }), 1);
});

test('PrometheusMetrics: Gauge 基本操作', async (t) => {
  const metrics = new PrometheusMetrics({ prefix: 'test_' });

  const gauge = metrics.createGauge('memory_bytes', 'Memory usage');
  gauge.set(1024 * 1024);
  assert.strictEqual(gauge.get(), 1024 * 1024);

  gauge.inc(512);
  assert.strictEqual(gauge.get(), 1024 * 1024 + 512);

  gauge.dec(256);
  assert.strictEqual(gauge.get(), 1024 * 1024 + 256);
});

test('PrometheusMetrics: Histogram 操作', async (t) => {
  const metrics = new PrometheusMetrics({ prefix: 'test_' });

  const histogram = metrics.createHistogram('duration_seconds', 'Duration', ['type'], [0.1, 0.5, 1]);
  histogram.observe({ type: 'api' }, 0.3);
  histogram.observe({ type: 'api' }, 0.8);
  histogram.observe({ type: 'api' }, 1.2);

  const bucketData = histogram._allLabels();
  assert.ok(bucketData.size > 0);
});

test('PrometheusMetrics: 导出Prometheus格式', async (t) => {
  const metrics = new PrometheusMetrics({ prefix: 'test_' });

  const counter = metrics.createCounter('test_counter', 'Test counter', ['label1']);
  counter.inc({ label1: 'value1' }, 5);

  const gauge = metrics.createGauge('test_gauge', 'Test gauge');
  gauge.set(42);

  const output = metrics.export();
  assert.ok(output.includes('# HELP test_test_counter Test counter'));
  assert.ok(output.includes('# TYPE test_test_counter counter'));
  assert.ok(output.includes('test_test_counter{label1="value1"} 5'));
  assert.ok(output.includes('test_test_gauge 42'));
});

test('PrometheusMetrics: 系统指标更新', async (t) => {
  const metrics = new PrometheusMetrics({ prefix: 'test_' });
  metrics.updateSystemMetrics();

  const heapUsed = metrics.heapUsed.get();
  assert.ok(heapUsed > 0, 'Heap used should be positive');

  const uptime = metrics.uptime.get();
  assert.ok(uptime > 0, 'Uptime should be positive');
});

test('PrometheusMetrics: 内置HTTP指标', async (t) => {
  const metrics = new PrometheusMetrics({ prefix: 'test_' });

  metrics.httpRequestsTotal.inc({ method: 'GET', path: '/api/test', status: '200' });
  metrics.httpRequestDuration.observe({ method: 'GET', path: '/api/test' }, 0.15);

  const output = metrics.export();
  assert.ok(output.includes('http_requests_total'));
  assert.ok(output.includes('http_request_duration_seconds'));
});

test('PrometheusMetrics: 内置LLM指标', async (t) => {
  const metrics = new PrometheusMetrics({ prefix: 'test_' });

  metrics.llmRequestsTotal.inc({ provider: 'openai', purpose: 'chat', status: 'success' });
  metrics.llmTokensUsed.inc({ provider: 'openai', type: 'total' }, 1500);
  metrics.llmRequestDuration.observe({ provider: 'openai', purpose: 'chat' }, 2.5);

  const output = metrics.export();
  assert.ok(output.includes('llm_requests_total'));
  assert.ok(output.includes('llm_tokens_used_total'));
});

test('PrometheusMetrics: 重置', async (t) => {
  const metrics = new PrometheusMetrics({ prefix: 'test_' });

  const counter = metrics.createCounter('reset_test', 'Test');
  counter.inc({}, 10);
  assert.strictEqual(counter.get({}), 10);

  metrics.reset();
  assert.strictEqual(counter.get({}), 0);
});
