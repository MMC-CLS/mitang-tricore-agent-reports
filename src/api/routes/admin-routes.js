/**
 * 管理路由 — POST /admin/stop, POST /admin/start, POST /admin/restart, POST /activate
 */
'use strict';

// v1.0安全修复: 管理操作参数限制
const MAX_DRAIN_TIMEOUT = 300000;    // 最大5分钟
const MAX_SHUTDOWN_TIMEOUT = 60000;  // 最大1分钟
const MAX_API_KEY_LENGTH = 256;      // API Key最大长度

function registerRoutes(server) {
  server._addRoute('POST /admin/stop', async function(req, res) {
    if (this._agent?._scheduler) this._agent._scheduler.pause();
    this._sendJson(res, 200, { status: 'paused' });
  });

  server._addRoute('POST /admin/start', async function(req, res) {
    if (this._agent?._scheduler) this._agent._scheduler.resume();
    this._sendJson(res, 200, { status: 'running' });
  });

  server._addRoute('POST /admin/restart', async function(req, res) {
    const body = await this._readBody(req);
    // v1.0安全修复: 验证超时参数，防止注入异常值
    let drainTimeout = Number(body?.drainTimeout) || 30000;
    let shutdownTimeout = Number(body?.shutdownTimeout) || 10000;
    drainTimeout = Math.max(1000, Math.min(drainTimeout, MAX_DRAIN_TIMEOUT));
    shutdownTimeout = Math.max(1000, Math.min(shutdownTimeout, MAX_SHUTDOWN_TIMEOUT));

    if (this._agent?._gracefulRestart) {
      this._sendJson(res, 200, {
        status: 'restart_initiated',
        message: '零停机重启已触发，旧进程将在新进程就绪后退出',
        drainTimeout,
        shutdownTimeout,
      });
      setImmediate(() => {
        this._agent._gracefulRestart.triggerRestart({
          drainTimeout,
          shutdownTimeout,
        }).catch(err => {
          if (this._agent?._logger) {
            this._agent._logger.error(`Admin restart failed: ${err.message}`);
          }
        });
      });
    } else {
      this._sendJson(res, 200, {
        status: 'restart_scheduled',
        message: 'Agent 将在 3 秒后重启（降级模式，非零停机）',
      });
      setTimeout(() => {
        if (this._agent) {
          this._agent.stop().then(() => {
            this._agent.start().catch(err => {
              console.error(`[API] Agent重启失败: ${err.message}`);
            });
          }).catch(() => {
            process.exit(0);
          });
        }
      }, 3000);
    }
  });

  server._addRoute('POST /activate', async function(req, res) {
    const body = await this._readBody(req);
    const { provider, apiKey, model } = body;
    if (!apiKey || typeof apiKey !== 'string') {
      this._sendJson(res, 400, { error: 'apiKey is required and must be a string' });
      return;
    }
    // v1.0安全修复: 限制API Key长度，防止超长字符串攻击
    if (apiKey.length > MAX_API_KEY_LENGTH) {
      this._sendJson(res, 400, { error: `apiKey too long (max ${MAX_API_KEY_LENGTH} characters)` });
      return;
    }
    // v1.0安全修复: 验证provider名称格式（仅允许字母数字和连字符）
    if (provider && !/^[a-zA-Z0-9_-]+$/.test(provider)) {
      this._sendJson(res, 400, { error: 'invalid provider name format' });
      return;
    }
    if (this._agent?._router) {
      this._agent._router.registerProvider(provider || 'deepseek', { apiKey, model });
    }
    this._sendJson(res, 200, { activated: true, provider: provider || 'deepseek' });
  });
}

module.exports = { registerRoutes };
