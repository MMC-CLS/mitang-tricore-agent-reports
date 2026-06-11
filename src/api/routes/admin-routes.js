/**
 * 管理路由 — POST /admin/stop, POST /admin/start, POST /admin/restart, POST /activate
 */
'use strict';

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
    const { drainTimeout, shutdownTimeout } = body || {};

    if (this._agent?._gracefulRestart) {
      this._sendJson(res, 200, {
        status: 'restart_initiated',
        message: '零停机重启已触发，旧进程将在新进程就绪后退出',
        drainTimeout: drainTimeout || this._agent._gracefulRestart._drainTimeout || 30000,
        shutdownTimeout: shutdownTimeout || this._agent._gracefulRestart._shutdownTimeout || 10000,
      });
      setImmediate(() => {
        this._agent._gracefulRestart.triggerRestart({
          drainTimeout: drainTimeout || this._agent._gracefulRestart._drainTimeout,
          shutdownTimeout: shutdownTimeout || this._agent._gracefulRestart._shutdownTimeout,
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
    if (!apiKey) {
      this._sendJson(res, 400, { error: 'apiKey is required' });
      return;
    }
    if (this._agent?._router) {
      this._agent._router.registerProvider(provider || 'deepseek', { apiKey, model });
    }
    this._sendJson(res, 200, { activated: true, provider: provider || 'deepseek' });
  });
}

module.exports = { registerRoutes };
