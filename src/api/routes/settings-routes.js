/**
 * 设置管理路由 — GET/POST/PATCH /settings, /settings/schema, /settings/defaults,
 *   /settings/reset, /settings/reset-category, /settings/history, /settings/summary,
 *   /settings/validate, /settings/export, /settings/import, /settings/migrate
 */
'use strict';

function registerRoutes(server) {
  server._addRoute('GET /settings', async function(req, res) {
    try {
      const config = this._agent?._configManager
        ? await this._agent._configManager.getAll()
        : {};
      this._sendJson(res, 200, {
        success: true,
        data: config,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('POST /settings', async function(req, res) {
    try {
      const body = await this._readBody(req);
      const { settings } = body || {};
      if (!settings || typeof settings !== 'object') {
        this._sendJson(res, 400, { success: false, error: 'settings object is required' });
        return;
      }
      const results = { success: true, updated: [], failed: [] };
      if (this._agent?._configManager) {
        for (const [key, value] of Object.entries(settings)) {
          try {
            const validation = this._agent._configManager.validate(key, value);
            if (!validation.valid) {
              results.failed.push({ key, error: validation.message });
              continue;
            }
            await this._agent._configManager.set(key, value);
            results.updated.push(key);
          } catch (e) {
            results.failed.push({ key, error: e.message });
          }
        }
      } else {
        results.success = false;
        results.error = 'ConfigManager not available';
      }
      if (results.failed.length > 0) {
        results.success = results.updated.length > 0;
      }
      this._sendJson(res, 200, results);
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('PATCH /settings', async function(req, res) {
    try {
      const body = await this._readBody(req);
      const { key, value } = body || {};
      if (!key) {
        this._sendJson(res, 400, { success: false, error: 'key is required' });
        return;
      }
      if (this._agent?._configManager) {
        const validation = this._agent._configManager.validate(key, value);
        if (!validation.valid) {
          this._sendJson(res, 400, { success: false, error: validation.message });
          return;
        }
        const oldValue = this._agent._configManager.get(key);
        await this._agent._configManager.set(key, value);
        server._recordSettingsHistory(key, oldValue, value);
        this._sendJson(res, 200, { success: true, key, oldValue, newValue: value });
      } else {
        this._sendJson(res, 500, { success: false, error: 'ConfigManager not available' });
      }
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('GET /settings/schema', async function(req, res) {
    try {
      const schema = this._agent?._configManager
        ? this._agent._configManager.getSchema()
        : [];
      this._sendJson(res, 200, { success: true, data: schema });
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('GET /settings/defaults', async function(req, res) {
    try {
      const defaults = this._agent?._configManager
        ? this._agent._configManager.getDefaults()
        : {};
      this._sendJson(res, 200, { success: true, data: defaults });
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('POST /settings/reset', async function(req, res) {
    try {
      if (this._agent?._configManager) {
        await this._agent._configManager.resetAll();
        this._sendJson(res, 200, { success: true, message: 'All settings reset to defaults' });
      } else {
        this._sendJson(res, 500, { success: false, error: 'ConfigManager not available' });
      }
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('POST /settings/reset-category', async function(req, res) {
    try {
      const body = await this._readBody(req);
      const { category } = body || {};
      if (!category) {
        this._sendJson(res, 400, { success: false, error: 'category is required' });
        return;
      }
      if (this._agent?._configManager) {
        const result = await this._agent._configManager.resetCategory(category);
        if (result) {
          this._sendJson(res, 200, { success: true, message: `Category "${category}" reset` });
        } else {
          this._sendJson(res, 404, { success: false, error: `Category "${category}" not found` });
        }
      } else {
        this._sendJson(res, 500, { success: false, error: 'ConfigManager not available' });
      }
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('GET /settings/history', async function(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const history = this._agent?._configManager
        ? await this._agent._configManager.getHistory(limit)
        : (server._settingsHistory || []);
      this._sendJson(res, 200, {
        success: true,
        data: history.slice(0, limit),
        total: history.length,
      });
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('GET /settings/summary', async function(req, res) {
    try {
      const summary = this._agent?._configManager
        ? this._agent._configManager.getSummary()
        : {};
      this._sendJson(res, 200, { success: true, data: summary });
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('POST /settings/validate', async function(req, res) {
    try {
      const body = await this._readBody(req);
      const { key, value } = body || {};
      if (!key) {
        this._sendJson(res, 400, { success: false, error: 'key is required' });
        return;
      }
      if (this._agent?._configManager) {
        const result = this._agent._configManager.validate(key, value);
        this._sendJson(res, 200, { success: true, ...result });
      } else {
        this._sendJson(res, 200, { success: true, valid: true });
      }
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('POST /settings/export', async function(req, res) {
    try {
      const body = await this._readBody(req);
      const sanitize = body?.sanitize === true;
      const config = this._agent?._configManager
        ? await this._agent._configManager.exportConfig(sanitize)
        : {};
      this._sendJson(res, 200, {
        success: true,
        data: config,
        exportedAt: new Date().toISOString(),
        sanitized: sanitize,
      });
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('POST /settings/import', async function(req, res) {
    try {
      const body = await this._readBody(req);
      const { config, merge } = body || {};
      if (!config || typeof config !== 'object') {
        this._sendJson(res, 400, { success: false, error: 'config object is required' });
        return;
      }
      if (this._agent?._configManager) {
        if (!merge) {
          await this._agent._configManager.resetAll();
        }
        await this._agent._configManager.importConfig(config);
        this._sendJson(res, 200, {
          success: true,
          message: 'Configuration imported successfully',
          mergeMode: merge !== false,
        });
      } else {
        this._sendJson(res, 500, { success: false, error: 'ConfigManager not available' });
      }
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });

  server._addRoute('POST /settings/migrate', async function(req, res) {
    try {
      if (this._agent?._configManager) {
        await this._agent._configManager.migrateIfNeeded();
        this._sendJson(res, 200, {
          success: true,
          message: 'Configuration migration completed',
          currentVersion: this._agent._configManager._currentMigrationVersion || 6,
        });
      } else {
        this._sendJson(res, 500, { success: false, error: 'ConfigManager not available' });
      }
    } catch (e) {
      this._sendJson(res, 500, { success: false, error: e.message });
    }
  });
}

module.exports = { registerRoutes };
