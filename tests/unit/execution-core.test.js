/**
 * 执行核 (ExecutionCore) 单元测试 — v5.0.0 新增
 * 覆盖：任务生命周期、工具执行、插件管理、安全沙箱、错误处理
 */
'use strict';

const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { ExecutionCore, TASK_STATUS, TOOL_PERMISSION, BUILTIN_TOOLS } = require('../../src/core/execution-core');

describe('ExecutionCore', () => {
  let exec;
  let sandboxDir;

  beforeEach(() => {
    sandboxDir = path.join(os.tmpdir(), `tricore_exec_test_${Date.now()}`);
    exec = new ExecutionCore({ sandboxDir, maxRetries: 2 });
  });

  afterEach(() => {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
  });

  // ═══ 任务创建 ═══
  describe('createTask', () => {
    it('should create a task with unique ID', async () => {
      const taskId = await exec.createTask({ goal: 'test task' });
      assert.ok(taskId);
      assert.ok(taskId.startsWith('task_'));
      const task = exec.getTask(taskId);
      assert.ok(task);
      assert.equal(task.goal, 'test task');
      assert.equal(task.status, TASK_STATUS.PENDING);
    });

    it('should assign normal priority by default', async () => {
      const taskId = await exec.createTask({ goal: 'low prio task' });
      const task = exec.getTask(taskId);
      assert.equal(task.priority, 'normal');
    });

    it('should accept custom priority', async () => {
      const taskId = await exec.createTask({ goal: 'urgent task', priority: 'high' });
      const task = exec.getTask(taskId);
      assert.equal(task.priority, 'high');
    });

    it('should emit task_created event', async () => {
      const events = [];
      exec.on('task_created', (data) => events.push(data));
      await exec.createTask({ goal: 'event test' });
      assert.equal(events.length, 1);
      assert.equal(events[0].goal, 'event test');
    });

    it('should plan steps even without LLM router', async () => {
      const taskId = await exec.createTask({ goal: 'no llm task' });
      const task = exec.getTask(taskId);
      assert.ok(task.steps.length > 0);
      assert.equal(task.steps[0].action, 'execute_goal');
    });
  });

  // ═══ 任务执行 ═══
  describe('executeStep', () => {
    it('should throw for non-existent task', async () => {
      await assert.rejects(() => exec.executeStep('nonexistent'), /not found/);
    });

    it('should complete task when all steps done', async () => {
      const taskId = await exec.createTask({ goal: 'simple task' });
      const task = exec.getTask(taskId);
      task.steps = [{ action: 'send_message', params: { content: 'done' } }];
      task.status = TASK_STATUS.PENDING;

      const result = await exec.executeStep(taskId);
      assert.equal(result.taskStatus, TASK_STATUS.COMPLETED);
      assert.ok(result.stepResult.sent);
    });

    it('should block unknown actions', async () => {
      const taskId = await exec.createTask({ goal: 'unknown action' });
      const task = exec.getTask(taskId);
      task.steps = [{ action: 'unknown_action', params: {} }];
      task.status = TASK_STATUS.PENDING;

      const result = await exec.executeStep(taskId);
      assert.equal(result.taskStatus, TASK_STATUS.FAILED);
      assert.ok(result.stepResult.error);
    });
  });

  // ═══ 工具执行 ═══
  describe('tool execution', () => {
    it('read_file should read existing file', async () => {
      const filePath = path.join(sandboxDir, 'test.txt');
      fs.mkdirSync(sandboxDir, { recursive: true });
      fs.writeFileSync(filePath, 'hello world');

      const result = await exec._executeBuiltinAction('read_file', { path: 'test.txt' }, {});
      assert.equal(result.content, 'hello world');
    });

    it('read_file should throw for missing file', async () => {
      await assert.rejects(
        () => exec._executeBuiltinAction('read_file', { path: 'nonexistent.txt' }, {}),
        /not found/i
      );
    });

    it('write_file should create file', async () => {
      const result = await exec._executeBuiltinAction('write_file', {
        path: 'output.txt',
        content: 'test output',
      }, {});
      assert.ok(result.success);
      const content = fs.readFileSync(path.join(sandboxDir, 'output.txt'), 'utf-8');
      assert.equal(content, 'test output');
    });

    it('list_dir should list directory contents', async () => {
      fs.mkdirSync(sandboxDir, { recursive: true });
      fs.writeFileSync(path.join(sandboxDir, 'a.txt'), 'a');
      fs.mkdirSync(path.join(sandboxDir, 'subdir'));

      const result = await exec._executeBuiltinAction('list_dir', { path: '.' }, {});
      assert.ok(result.entries.length >= 2);
      const names = result.entries.map(e => e.name);
      assert.ok(names.includes('a.txt'));
      assert.ok(names.includes('subdir'));
    });

    it('web_search should return results or graceful fallback', async () => {
      const result = await exec._executeBuiltinAction('web_search', { query: 'test' }, {});
      assert.ok(result.query === 'test');
      assert.ok(Array.isArray(result.results));
      // DuckDuckGo may fail in CI; just verify structure
    });

    it('fetch_url should validate URL', async () => {
      await assert.rejects(
        () => exec._executeBuiltinAction('fetch_url', { url: 'not-a-url' }, {}),
        /Invalid URL/
      );
    });

    it('shell_exec should block dangerous commands', async () => {
      await assert.rejects(
        () => exec._executeBuiltinAction('shell_exec', { command: 'rm -rf /' }, {}),
        /not allowed/
      );
    });

    it('shell_exec should allow safe commands', async () => {
      // Use whoami which is a standalone executable on all platforms (unlike echo on Windows)
      const result = await exec._executeBuiltinAction('shell_exec', { command: 'whoami' }, {});
      assert.ok(result.output.length > 0);
    });

    it('shell_exec should block shell metacharacters', async () => {
      await assert.rejects(
        () => exec._executeBuiltinAction('shell_exec', { command: 'echo hello; rm /' }, {}),
        /metacharacters/
      );
    });

    it('send_message should return sent confirmation', async () => {
      const result = await exec._executeBuiltinAction('send_message', { content: 'hi' }, {});
      assert.ok(result.sent);
      assert.equal(result.content, 'hi');
    });
  });

  // ═══ 插件管理 ═══
  describe('plugin management', () => {
    it('should register custom tools', () => {
      exec.registerTool('custom_test', {
        description: 'A test tool',
        permission: TOOL_PERMISSION.SAFE,
        params: {},
      }, async (params) => ({ result: params }));
      assert.ok(exec._tools.has('custom_test'));
    });

    it('should install plugins with multiple tools', () => {
      const plugin = {
        name: 'test-plugin',
        version: '1.0.0',
        tools: [
          { name: 'tool_a', definition: { description: 'A', permission: TOOL_PERMISSION.SAFE, params: {} }, handler: null },
          { name: 'tool_b', definition: { description: 'B', permission: TOOL_PERMISSION.SAFE, params: {} }, handler: null },
        ],
      };
      exec.installPlugin(plugin);
      assert.ok(exec._tools.has('tool_a'));
      assert.ok(exec._tools.has('tool_b'));
      assert.equal(exec.listPlugins().length, 1);
    });

    it('should uninstall plugins and remove tools', () => {
      exec.installPlugin({
        name: 'removable',
        tools: [{ name: 'rm_tool', definition: { description: 'R', permission: TOOL_PERMISSION.SAFE, params: {} }, handler: null }],
      });
      exec.uninstallPlugin('removable');
      assert.equal(exec.listPlugins().length, 0);
      assert.ok(!exec._tools.has('rm_tool'));
    });

    it('should list all builtin tools', () => {
      const tools = exec.listTools();
      assert.ok(tools.length >= 8); // at least builtin tools
      assert.ok(tools.some(t => t.name === 'read_file'));
      assert.ok(tools.some(t => t.name === 'write_file'));
    });
  });

  // ═══ 安全沙箱 ═══
  describe('sandbox security', () => {
    it('should prevent path traversal with ../', () => {
      assert.throws(() => {
        exec._resolveSandboxPath('../../../etc/passwd');
      }, /traversal/);
    });

    it('should allow paths within sandbox', () => {
      const resolved = exec._resolveSandboxPath('subdir/file.txt');
      assert.ok(resolved.startsWith(sandboxDir));
    });

    it('should strip .. patterns', () => {
      const resolved = exec._resolveSandboxPath('a/b/../c');
      // After .. stripping: a/b/c within sandbox
      assert.ok(resolved.includes('c'));
    });
  });

  // ═══ 危险操作确认 ═══
  describe('dangerous action confirmation', () => {
    it('should pause on dangerous action', async () => {
      const taskId = await exec.createTask({ goal: 'dangerous' });
      const task = exec.getTask(taskId);
      task.steps = [{ action: 'shell_exec', params: { command: 'echo test' } }];
      task.status = TASK_STATUS.PENDING;

      const result = await exec.executeStep(taskId);
      assert.equal(result.taskStatus, TASK_STATUS.PAUSED);
      assert.ok(result.stepResult.waiting);
    });

    it('should resume on confirmation', async () => {
      const taskId = await exec.createTask({ goal: 'confirmable' });
      const task = exec.getTask(taskId);
      task.steps = [{ action: 'shell_exec', params: { command: 'echo test' } }];
      task.status = TASK_STATUS.PENDING;

      // First step: pause
      await exec.executeStep(taskId);
      assert.equal(task.status, TASK_STATUS.PAUSED);

      // Confirm and resume
      exec.confirmDangerousAction(taskId, true);
      assert.equal(task.status, TASK_STATUS.PENDING);
    });

    it('should fail on denial', async () => {
      const taskId = await exec.createTask({ goal: 'denied' });
      const task = exec.getTask(taskId);
      task.steps = [{ action: 'shell_exec', params: { command: 'echo test' } }];
      task.status = TASK_STATUS.PENDING;

      await exec.executeStep(taskId);
      exec.confirmDangerousAction(taskId, false);
      assert.equal(task.status, TASK_STATUS.FAILED);
    });
  });

  // ═══ 重试机制 ═══
  describe('retry mechanism', () => {
    it('should retry failed steps up to maxRetries', async () => {
      exec.registerTool('flaky_tool', {
        description: 'Always fails first time',
        permission: TOOL_PERMISSION.SAFE,
        params: {},
      }, async () => { throw new Error('simulated failure'); });

      const taskId = await exec.createTask({ goal: 'flaky' });
      const task = exec.getTask(taskId);
      task.steps = [{ action: 'flaky_tool', params: {} }];
      task.status = TASK_STATUS.PENDING;

      const result = await exec.executeStep(taskId);
      // After maxRetries (2), should have error
      const lastResult = task.results[task.results.length - 1];
      assert.equal(lastResult.retryCount, 2);
      assert.ok(lastResult.result.error);
    });
  });

  // ═══ 审计日志 ═══
  describe('audit logging', () => {
    it('should record execution in audit log', async () => {
      const taskId = await exec.createTask({ goal: 'audited' });
      const task = exec.getTask(taskId);
      task.steps = [{ action: 'send_message', params: { content: 'hi' } }];
      task.status = TASK_STATUS.PENDING;

      await exec.executeStep(taskId);
      const log = exec.getAuditLog();
      assert.ok(log.length > 0);
      assert.equal(log[0].action, 'send_message');
      assert.ok(log[0].success);
    });
  });

  // ═══ 状态查询 ═══
  describe('getStatus', () => {
    it('should return status summary', async () => {
      await exec.createTask({ goal: 'status test' });
      const status = exec.getStatus();
      assert.equal(status.totalTasks, 1);
      assert.ok(status.toolsCount >= 8);
      assert.ok(typeof status.activeTasks === 'number');
      assert.ok(typeof status.completedTasks === 'number');
      assert.ok(typeof status.failedTasks === 'number');
      assert.ok(typeof status.pluginsCount === 'number');
    });
  });

  // ═══ executeAll ═══
  describe('executeAll', () => {
    it('should execute all remaining steps', async () => {
      const taskId = await exec.createTask({ goal: 'batch' });
      const task = exec.getTask(taskId);
      task.steps = [
        { action: 'send_message', params: { content: 'step1' } },
        { action: 'send_message', params: { content: 'step2' } },
      ];
      task.status = TASK_STATUS.PENDING;

      const results = await exec.executeAll(taskId);
      assert.ok(results.length >= 2);
      assert.equal(task.status, TASK_STATUS.COMPLETED);
    });
  });
});
