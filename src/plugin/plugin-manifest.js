/**
 * TriCore Agent — 插件 Manifest 解析器
 *
 * 解析 plugin.json 并验证其合法性。
 *
 * Manifest 字段：
 *   name (required)         - 插件名称，唯一标识
 *   version (required)      - 语义化版本号 (semver)
 *   description             - 插件描述
 *   author                  - 作者
 *   license                 - 许可证
 *   main                    - 入口文件
 *   type                    - 插件类型: tool | provider | middleware | ui | skill_pack
 *   dependencies            - 依赖的其他插件名称列表
 *   permissions             - 需要的权限列表
 *   hooks                   - 钩子声明 { hookName: { handler, priority } }
 *   config                  - 默认配置
 *   engines                 - 运行环境要求 { node, tricore }
 */

'use strict';

// ── 有效的插件类型 ──
const PLUGIN_TYPE = Object.freeze({
  TOOL: 'tool',
  PROVIDER: 'provider',
  MIDDLEWARE: 'middleware',
  UI: 'ui',
  SKILL_PACK: 'skill_pack',
});

// ── 有效的权限 ──
const PLUGIN_PERMISSION = Object.freeze({
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  NETWORK: 'network',
  SHELL: 'shell',
  MEMORY_READ: 'memory:read',
  MEMORY_WRITE: 'memory:write',
  LLM_CALL: 'llm:call',
  BUS_PUBLISH: 'bus:publish',
  BUS_SUBSCRIBE: 'bus:subscribe',
});

// ── 有效的钩子名称 ──
const VALID_HOOKS = Object.freeze([
  'onInit',
  'onStart',
  'onStop',
  'onMessage',
  'onTick',
  'onToolExecute',
]);

// ── Manifest Schema ──
const REQUIRED_FIELDS = ['name', 'version'];
const OPTIONAL_FIELDS = [
  'description', 'author', 'license', 'main',
  'type', 'dependencies', 'permissions', 'hooks',
  'config', 'engines',
];

/**
 * Manifest 解析器
 */
class PluginManifest {
  /**
   * 解析并验证 plugin.json
   * @param {Object|string} raw - 原始 manifest 对象或 JSON 字符串
   * @returns {{ valid: boolean, manifest: Object|null, errors: string[], warnings: string[] }}
   */
  static parse(raw) {
    const errors = [];
    const warnings = [];

    // ── 解析 ──
    let manifest;
    if (typeof raw === 'string') {
      try {
        manifest = JSON.parse(raw);
      } catch (e) {
        return {
          valid: false,
          manifest: null,
          errors: [`Failed to parse JSON: ${e.message}`],
          warnings: [],
        };
      }
    } else if (typeof raw === 'object' && raw !== null) {
      manifest = raw;
    } else {
      return {
        valid: false,
        manifest: null,
        errors: ['Manifest must be a JSON object or string'],
        warnings: [],
      };
    }

    // ── 验证必填字段 ──
    for (const field of REQUIRED_FIELDS) {
      if (!manifest[field]) {
        errors.push(`Missing required field: "${field}"`);
      }
    }

    // ── 验证 name ──
    if (manifest.name) {
      if (!/^[a-z][a-z0-9_-]*$/i.test(manifest.name)) {
        errors.push(`Invalid plugin name "${manifest.name}": must start with a letter and contain only alphanumeric characters, hyphens, or underscores`);
      }
    }

    // ── 验证 version (semver) ──
    if (manifest.version) {
      if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(manifest.version)) {
        errors.push(`Invalid version "${manifest.version}": must follow semver (e.g., 1.0.0)`);
      }
    }

    // ── 验证 type ──
    if (manifest.type) {
      const validTypes = Object.values(PLUGIN_TYPE);
      if (!validTypes.includes(manifest.type)) {
        errors.push(`Invalid type "${manifest.type}": must be one of [${validTypes.join(', ')}]`);
      }
    }

    // ── 验证 dependencies ──
    if (manifest.dependencies) {
      if (!Array.isArray(manifest.dependencies)) {
        errors.push('"dependencies" must be an array of plugin names');
      } else {
        for (const dep of manifest.dependencies) {
          if (typeof dep !== 'string' || dep.length === 0) {
            errors.push(`Invalid dependency: "${dep}" — must be a non-empty string`);
          }
        }
      }
    }

    // ── 验证 permissions ──
    if (manifest.permissions) {
      if (!Array.isArray(manifest.permissions)) {
        errors.push('"permissions" must be an array');
      } else {
        const validPerms = Object.values(PLUGIN_PERMISSION);
        for (const perm of manifest.permissions) {
          if (!validPerms.includes(perm)) {
            errors.push(`Invalid permission "${perm}": must be one of [${validPerms.join(', ')}]`);
          }
        }
      }
    }

    // ── 验证 hooks ──
    if (manifest.hooks) {
      if (typeof manifest.hooks !== 'object' || Array.isArray(manifest.hooks)) {
        errors.push('"hooks" must be an object mapping hook names to handler configs');
      } else {
        for (const [hookName, hookConfig] of Object.entries(manifest.hooks)) {
          if (!VALID_HOOKS.includes(hookName)) {
            warnings.push(`Unknown hook "${hookName}": will be ignored. Valid hooks: [${VALID_HOOKS.join(', ')}]`);
          }
          if (hookConfig && typeof hookConfig === 'object') {
            if (hookConfig.priority !== undefined && typeof hookConfig.priority !== 'number') {
              errors.push(`Hook "${hookName}" priority must be a number`);
            }
            if (!hookConfig.handler || typeof hookConfig.handler !== 'string') {
              errors.push(`Hook "${hookName}" must specify a handler function name`);
            }
          } else {
            errors.push(`Hook "${hookName}" config must be an object with "handler" property`);
          }
        }
      }
    }

    // ── 验证 engines ──
    if (manifest.engines) {
      if (typeof manifest.engines !== 'object') {
        errors.push('"engines" must be an object');
      } else {
        if (manifest.engines.node) {
          const nodeReq = String(manifest.engines.node);
          if (!/^>=?\s*\d+/.test(nodeReq)) {
            warnings.push(`Unusual engines.node format: "${nodeReq}"`);
          }
        }
        if (manifest.engines.tricore) {
          const tcReq = String(manifest.engines.tricore);
          if (!/^>=?\s*\d+/.test(tcReq)) {
            warnings.push(`Unusual engines.tricore format: "${tcReq}"`);
          }
        }
      }
    }

    // ── 警告：未知字段 ──
    const allKnownFields = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
    for (const key of Object.keys(manifest)) {
      if (!allKnownFields.includes(key)) {
        warnings.push(`Unknown field "${key}" in manifest`);
      }
    }

    // ── 清理：只保留已知字段 ──
    const cleaned = {};
    for (const field of allKnownFields) {
      if (manifest[field] !== undefined) {
        cleaned[field] = manifest[field];
      }
    }

    // ── 设置默认值 ──
    cleaned.dependencies = cleaned.dependencies || [];
    cleaned.permissions = cleaned.permissions || [];
    cleaned.hooks = cleaned.hooks || {};
    cleaned.config = cleaned.config || {};
    cleaned.type = cleaned.type || PLUGIN_TYPE.TOOL;

    return {
      valid: errors.length === 0,
      manifest: cleaned,
      errors,
      warnings,
    };
  }

  /**
   * 快速验证 — 只返回 boolean
   */
  static isValid(manifest) {
    return PluginManifest.parse(manifest).valid;
  }

  /**
   * 批量解析目录下的 plugin.json 文件
   * @param {string[]} paths - plugin.json 文件路径列表
   * @returns {{ manifests: Object[], errors: Object[] }}
   */
  static parseBatch(paths) {
    const results = { manifests: [], errors: [] };
    for (const filePath of paths) {
      const result = PluginManifest.parse(filePath);
      if (result.valid) {
        results.manifests.push({ path: filePath, ...result.manifest });
      } else {
        results.errors.push({ path: filePath, errors: result.errors, warnings: result.warnings });
      }
    }
    return results;
  }
}

module.exports = {
  PluginManifest,
  PLUGIN_TYPE,
  PLUGIN_PERMISSION,
  VALID_HOOKS,
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
};
