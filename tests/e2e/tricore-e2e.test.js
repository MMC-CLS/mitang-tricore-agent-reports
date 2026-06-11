/**
 * 端到端集成测试
 * Phase 20: TriCoreAgent 全链路E2E测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { TriCoreAgent, VERSION } = require('../../src/index');

test('TriCoreAgent - 完整生命周期', async (t) => {
  const agent = new TriCoreAgent({
    dataDir: path.join(__dirname, '..', '..', 'data', 'e2e_test'),
    debugMode: false,
    logConsole: false,
    logFile: false,
  });

  await t.test('构造函数', () => {
    assert.ok(agent);
    assert.ok(agent._logger);
    assert.ok(agent._errorHandler);
    assert.ok(agent._bus);
    assert.ok(agent._security);
    assert.ok(agent._budget);
    assert.ok(agent._scheduler);
    assert.ok(agent._memory);
    assert.ok(agent._router);
    assert.ok(agent._consciousness);
    assert.ok(agent._execution);
    assert.ok(agent._evolution);
    // v2.1 modules
    assert.ok(agent._toolCalling);
    assert.ok(agent._rag);
    assert.ok(agent._multimodal);
    assert.ok(agent._rbac);
    assert.ok(agent._audit);
    assert.ok(agent._encryption);
  });

  await t.test('属性访问器', () => {
    assert.strictEqual(agent.execution, agent._execution);
    assert.strictEqual(agent.bus, agent._bus);
    assert.strictEqual(agent.security, agent._security);
    assert.strictEqual(agent.budget, agent._budget);
    assert.strictEqual(agent.logger, agent._logger);
    assert.strictEqual(agent.errorHandler, agent._errorHandler);
    assert.strictEqual(agent.rbac, agent._rbac);
    assert.strictEqual(agent.audit, agent._audit);
    assert.strictEqual(agent.encryption, agent._encryption);
    assert.strictEqual(agent.toolCalling, agent._toolCalling);
    assert.strictEqual(agent.rag, agent._rag);
    assert.strictEqual(agent.multimodal, agent._multimodal);
  });

  await t.test('版本', () => {
    assert.ok(VERSION);
  });

  await t.test('sendMessage', () => {
    const msgId = agent.sendMessage('user1', '你好，测试消息');
    assert.ok(msgId);
    assert.ok(msgId.startsWith('msg_'));
  });

  await t.test('getStatus', () => {
    const status = agent.getStatus();
    assert.ok(status);
    assert.strictEqual(status.version, VERSION);
    assert.ok(status.scheduler);
    assert.ok(status.memory);
    assert.ok(status.router);
    assert.ok(status.budget);
    assert.ok(status.security);
    // Phase 19新增
    assert.ok(status.logger);
    assert.ok(status.errorHandler);
  });

  await t.test('getDiagnostics', () => {
    const diag = agent.getDiagnostics();
    assert.ok(diag);
  });

  await t.test('getBudgetStatus', () => {
    const budgetStatus = agent.getBudgetStatus();
    assert.ok(budgetStatus);
  });

  await t.test('getSecurityLog', () => {
    const log = agent.getSecurityLog();
    assert.ok(Array.isArray(log));
  });

  await t.test('Logger集成验证', () => {
    const stats = agent._logger.getStats();
    assert.ok(stats);
    assert.ok(stats.total >= 0);
  });

  await t.test('ErrorHandler集成验证', () => {
    const errStats = agent._errorHandler.getErrorStats();
    assert.ok(errStats);
    assert.ok(errStats.hasOwnProperty('total'));
  });

  await t.test('cleanup', () => {
    agent._memory.close();
    // 清理RBAC资源
    if (agent._rbac) agent._rbac.close();
    if (agent._audit) agent._audit.close();
  });
});

test('TriCoreAgent - 企业模块集成', async (t) => {
  const agent = new TriCoreAgent({
    dataDir: path.join(__dirname, '..', '..', 'data', 'e2e_enterprise'),
    logConsole: false,
    logFile: false,
  });

  await t.test('RBAC基本操作', () => {
    // 默认admin已创建
    const users = agent._rbac.getUsers();
    assert.ok(users.length >= 1);
    assert.strictEqual(users[0].username, 'admin');
  });

  await t.test('RBAC权限检查', () => {
    const hasPermission = agent._rbac.hasPermission('user_admin_default', 'system:manage');
    assert.strictEqual(hasPermission, true);
  });

  await t.test('审计日志', () => {
    const eventId = agent._audit.log('system', 'test_event', { userId: 'system' });
    assert.ok(eventId);
    assert.ok(eventId.startsWith('audit_'));
  });

  await t.test('加密服务初始化', () => {
    const result = agent._encryption.initialize('test-master-password');
    assert.ok(result);
  });

  await t.test('cleanup', () => {
    agent._memory.close();
    if (agent._rbac) agent._rbac.close();
    if (agent._audit) agent._audit.close();
  });
});

test('TriCoreAgent - 配置管理', async (t) => {
  const agent = new TriCoreAgent({
    dataDir: path.join(__dirname, '..', '..', 'data', 'e2e_config'),
    logConsole: false,
    logFile: false,
  });

  await t.test('设置和获取配置', () => {
    agent.setConfig('test_key', 'test_value');
    const value = agent.getConfig('test_key');
    assert.strictEqual(value, 'test_value');
  });

  await t.test('cleanup', () => {
    agent._memory.close();
    if (agent._rbac) agent._rbac.close();
    if (agent._audit) agent._audit.close();
  });
});
