/**
 * ConsciousnessCore 单元测试
 * Phase 20: 意识核测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ConsciousnessCore, THINK_LAYER, TICK_TYPE } = require('../../src/core/consciousness-core');

test('ConsciousnessCore - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const core = new ConsciousnessCore({
      awakeningTicks: 10,
    });
    assert.ok(core);
  });

  await t.test('注入治理层依赖', () => {
    const core = new ConsciousnessCore({
      awakeningTicks: 5,
      bus: { dispatch: () => {}, startTrace: () => 'trace-1', completeTrace: () => {} },
      security: { authorize: () => ({ allowed: true }) },
      budget: { requestTokens: () => ({ allowed: true, throttleLevel: 'none' }) },
    });
    assert.ok(core);
  });
});

test('ConsciousnessCore - TICK处理', async (t) => {
  const core = new ConsciousnessCore({ awakeningTicks: 3 });

  await t.test('用户消息TICK', async () => {
    const result = await core.processTick({
      type: TICK_TYPE.USER_MESSAGE,
      message: { id: 'msg-1', from: 'user1', content: '你好' },
      tickNumber: 1,
    });
    assert.ok(result !== undefined, 'TICK应返回结果');
    assert.ok(typeof result === 'object', 'TICK结果应为对象');
    const status = core.getStatus();
    assert.ok(status.tickCounter > 0, 'TICK计数应递增');
  });

  await t.test('觉醒TICK', async () => {
    const result = await core.processTick({
      type: TICK_TYPE.AWAKENING,
      tickNumber: 2,
    });
    assert.ok(result !== undefined, '觉醒TICK应返回结果');
    const status = core.getStatus();
    assert.ok(typeof status.tickCounter === 'number', '状态应包含tickCounter');
  });

  await t.test('空闲思考TICK', async () => {
    const result = await core.processTick({
      type: TICK_TYPE.IDLE_THINK,
      tickNumber: 3,
    });
    assert.ok(result !== undefined, '空闲思考TICK应返回结果');
    const activityState = core.getActivityState();
    assert.ok(typeof activityState === 'string', '应返回活动状态字符串');
  });
});

test('ConsciousnessCore - 状态', async (t) => {
  const core = new ConsciousnessCore({ awakeningTicks: 5 });

  await t.test('getStatus', () => {
    const status = core.getStatus();
    assert.ok(status);
  });
});
