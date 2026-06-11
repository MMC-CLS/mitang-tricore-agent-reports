/**
 * CoreBus 单元测试
 * Phase 20: 核心事件总线测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CoreBus, BUS_CHANNEL, BUS_EVENT, EVENT_PRIORITY } = require('../../src/bus/core-bus');

test('CoreBus - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const bus = new CoreBus();
    assert.ok(bus);
  });

  await t.test('调试模式', () => {
    const bus = new CoreBus({ debugMode: true, maxLogSize: 5000 });
    assert.ok(bus);
  });
});

test('CoreBus - 事件分发', async (t) => {
  const bus = new CoreBus();

  await t.test('分发事件', () => {
    return new Promise((resolve) => {
      bus.on(BUS_EVENT.SYSTEM_INFO, (data) => {
        assert.strictEqual(data.message, 'test');
        resolve();
      });
      bus.dispatch(BUS_EVENT.SYSTEM_INFO, { message: 'test' }, { source: 'test' });
    });
  });

  await t.test('分发带优先级事件', () => {
    return new Promise((resolve) => {
      bus.on(BUS_EVENT.SYSTEM_ERROR, (data) => {
        assert.strictEqual(data.type, 'critical');
        resolve();
      });
      bus.dispatch(BUS_EVENT.SYSTEM_ERROR, { type: 'critical' }, { source: 'test', priority: EVENT_PRIORITY.CRITICAL });
    });
  });

  await t.test('多个监听器', () => {
    return new Promise((resolve) => {
      let count = 0;
      const checkDone = () => { count++; if (count >= 2) resolve(); };
      bus.on(BUS_EVENT.CONSCIOUSNESS_TASK_REQUEST, checkDone);
      bus.on(BUS_EVENT.CONSCIOUSNESS_TASK_REQUEST, checkDone);
      bus.dispatch(BUS_EVENT.CONSCIOUSNESS_TASK_REQUEST, { task: 'test' }, { source: 'test' });
    });
  });
});

test('CoreBus - 追踪链', async (t) => {
  const bus = new CoreBus();

  await t.test('开始追踪', () => {
    const traceId = bus.startTrace('external', { userId: 'user1' });
    assert.ok(traceId);
    assert.ok(traceId.startsWith('trace_'));
  });

  await t.test('完成追踪', () => {
    const traceId = bus.startTrace('consciousness');
    const result = bus.completeTrace(traceId);
    assert.ok(result);
    assert.strictEqual(result.traceId, traceId);
  });

  await t.test('获取追踪', () => {
    const traceId = bus.startTrace('execution', { taskId: 'task-1' });
    const trace = bus.getTrace(traceId);
    assert.ok(trace);
    assert.strictEqual(trace.source, 'execution');
  });

  await t.test('不存在的追踪', () => {
    const trace = bus.getTrace('nonexistent');
    assert.strictEqual(trace, null);
  });
});

test('CoreBus - 诊断', async (t) => {
  const bus = new CoreBus();

  await t.test('获取诊断信息', () => {
    bus.dispatch(BUS_EVENT.SYSTEM_INFO, { test: true }, { source: 'test' });
    const diagnostics = bus.getDiagnostics();
    assert.ok(diagnostics);
    assert.ok(diagnostics.eventCount >= 1);
  });
});

test('CoreBus - 频道订阅', async (t) => {
  const bus = new CoreBus();

  await t.test('订阅频道', () => {
    return new Promise((resolve) => {
      bus.subscribe(BUS_CHANNEL.SYSTEM, (event, data) => {
        assert.strictEqual(data.msg, 'hello');
        resolve();
      });
      bus.publish(BUS_CHANNEL.SYSTEM, { msg: 'hello' });
    });
  });

  await t.test('取消订阅', () => {
    let called = false;
    const handler = () => { called = true; };
    const subId = bus.subscribe(BUS_CHANNEL.SYSTEM, handler);
    bus.unsubscribe(subId);
    bus.publish(BUS_CHANNEL.SYSTEM, { test: true });
    assert.strictEqual(called, false);
  });
});
