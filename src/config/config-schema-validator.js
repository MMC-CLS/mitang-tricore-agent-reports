/**
 * TriCore Agent - 配置Schema验证器 (Config Schema Validator)
 *
 * Phase 23: JSON Schema驱动的配置验证
 *
 * 核心能力:
 *   1. JSON Schema 验证 - 类型/枚举/范围/正则/required校验
 *   2. 自定义验证规则 - 业务逻辑级验证（如 port 范围、url 格式）
 *   3. 配置迁移 - 自动将旧版配置格式升级到最新版
 *   4. 错误聚合 - 一次返回所有验证错误
 *   5. 严格模式 - 严格模式下额外检查（禁止未知字段）
 *   6. 环境变量合并 - 支持 ${ENV_VAR} 占位符解析
 */

'use strict';

const os = require('os');
const net = require('net');

// ── 验证结果级别 ──
const VALIDATION_LEVEL = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});

// ── 配置JSON Schema ──
const CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  required: ['llm', 'scheduler', 'api'],
  properties: {
    llm: {
      type: 'object',
      required: ['provider'],
      properties: {
        provider: {
          type: 'string',
          enum: ['deepseek', 'qwen', 'openai', 'anthropic', 'google', 'custom'],
          description: 'LLM Provider名称',
        },
        apiKey: {
          type: 'string',
          description: 'API Key（支持 ${ENV_VAR} 占位符）',
        },
        model: {
          type: 'string',
          description: '模型名称',
        },
        fallbackChain: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 10,
          description: 'Provider降级链',
        },
        baseUrl: {
          type: 'string',
          pattern: '^https?://',
          description: '自定义API Base URL',
        },
        temperature: {
          type: 'number',
          minimum: 0,
          maximum: 2,
          description: 'LLM temperature (0-2)',
        },
        maxTokens: {
          type: 'integer',
          minimum: 1,
          maximum: 131072,
          description: '最大输出Token数',
        },
      },
      additionalProperties: false,
    },

    scheduler: {
      type: 'object',
      properties: {
        awakeningTicks: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: '觉醒期TICK数量',
        },
        maxConsciousnessTicksPerHour: {
          type: 'integer',
          minimum: 1,
          maximum: 60,
          description: '每小时意识TICK上限',
        },
        tickIntervalIdle: {
          type: 'integer',
          minimum: 30000,
          maximum: 3600000,
          description: '空闲TICK间隔(ms)',
        },
        tickIntervalActive: {
          type: 'integer',
          minimum: 5000,
          maximum: 300000,
          description: '活跃TICK间隔(ms)',
        },
      },
    },

    social: {
      type: 'object',
      properties: {
        discord: {
          type: 'object',
          properties: {
            botToken: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        wechat_clawbot: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            botToken: { type: 'string' },
            baseUrl: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        wechat_official: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            appSecret: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        feishu: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            appSecret: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        wecom: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
      },
    },

    voice: {
      type: 'object',
      properties: {
        asrProvider: {
          type: 'string',
          enum: ['local_whisper', 'openai_whisper', 'azure', 'google'],
        },
        ttsProvider: {
          type: 'string',
          enum: ['doubao', 'openai', 'azure', 'elevenlabs', 'edge'],
        },
        whisperModel: {
          type: 'string',
          enum: ['tiny', 'base', 'small', 'medium', 'large', 'turbo'],
        },
        voiceSpeed: {
          type: 'number',
          minimum: 0.5,
          maximum: 4.0,
        },
        voicePitch: {
          type: 'number',
          minimum: -20,
          maximum: 20,
        },
      },
    },

    browser: {
      type: 'object',
      properties: {
        headless: { type: 'boolean' },
        defaultSearchEngine: {
          type: 'string',
          enum: ['bing', 'google', 'duckduckgo', 'baidu'],
        },
        viewportWidth: {
          type: 'integer',
          minimum: 320,
          maximum: 3840,
        },
        viewportHeight: {
          type: 'integer',
          minimum: 240,
          maximum: 2160,
        },
        timeout: {
          type: 'integer',
          minimum: 5000,
          maximum: 120000,
          description: '浏览器操作超时(ms)',
        },
      },
    },

    ui: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          enum: ['dark', 'light', 'system'],
        },
        fontSize: {
          type: 'integer',
          minimum: 8,
          maximum: 30,
        },
        autoStart: { type: 'boolean' },
        minimizeToTray: { type: 'boolean' },
        showOnStartup: { type: 'boolean' },
        language: {
          type: 'string',
          enum: ['zh-CN', 'en-US', 'ja-JP'],
        },
      },
    },

    api: {
      type: 'object',
      required: ['port'],
      properties: {
        port: {
          type: 'integer',
          minimum: 1024,
          maximum: 65535,
          description: 'API监听端口',
        },
        host: {
          type: 'string',
          description: '监听地址',
        },
        allowLan: { type: 'boolean' },
        apiToken: { type: 'string' },
        corsOrigins: {
          type: 'array',
          items: { type: 'string' },
          description: 'CORS允许来源',
        },
        rateLimitRPM: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          description: '每分钟API速率限制',
        },
      },
      additionalProperties: false,
    },

    // v2.4 新增配置项
    security: {
      type: 'object',
      properties: {
        maxConsciousnessTaskBudget: {
          type: 'integer',
          minimum: 1000,
          maximum: 100000,
        },
        maxAutonomousSteps: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
        },
        maxIdleThinkPerHour: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
        },
        enableSafeMode: { type: 'boolean' },
      },
    },

    budget: {
      type: 'object',
      properties: {
        hourlyBudget: {
          type: 'integer',
          minimum: 1000,
          maximum: 10000000,
        },
        dailyBudget: {
          type: 'integer',
          minimum: 10000,
          maximum: 100000000,
        },
        consciousnessRatio: {
          type: 'number',
          minimum: 0.1,
          maximum: 0.9,
        },
        executionRatio: {
          type: 'number',
          minimum: 0.1,
          maximum: 0.9,
        },
        evolutionRatio: {
          type: 'number',
          minimum: 0.01,
          maximum: 0.5,
        },
      },
    },

    logging: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
        },
        console: { type: 'boolean' },
        file: { type: 'boolean' },
        json: { type: 'boolean' },
        maxFileSize: {
          type: 'integer',
          minimum: 1048576,  // 1MB
          maximum: 1073741824, // 1GB
        },
        maxFiles: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
        },
        asyncWrite: { type: 'boolean' },
        bufferSize: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
        },
        flushInterval: {
          type: 'integer',
          minimum: 100,
          maximum: 60000,
        },
      },
    },

    messageQueue: {
      type: 'object',
      properties: {
        maxSize: {
          type: 'integer',
          minimum: 100,
          maximum: 100000,
          description: '消息队列最大容量',
        },
        persistEnabled: {
          type: 'boolean',
          description: '是否持久化消息队列',
        },
        persistPath: {
          type: 'string',
          description: '持久化文件路径',
        },
        maxRetries: {
          type: 'integer',
          minimum: 0,
          maximum: 10,
          description: '消息处理最大重试次数',
        },
        retryDelay: {
          type: 'integer',
          minimum: 100,
          maximum: 60000,
          description: '重试延迟(ms)',
        },
        deadLetterEnabled: {
          type: 'boolean',
          description: '是否启用死信队列',
        },
        ttl: {
          type: 'integer',
          minimum: 1000,
          maximum: 86400000,
          description: '消息过期时间(ms)',
        },
      },
    },
  },
  // 允许未知顶级字段（向后兼容）
  additionalProperties: true,
});

// ── 自定义业务验证规则 ──
const CUSTOM_RULES = [
  {
    name: 'budget_ratio_sum',
    description: '三核预算比例之和应接近1.0',
    level: VALIDATION_LEVEL.WARNING,
    validate: (config) => {
      if (!config.budget) return null;
      const { consciousnessRatio = 0.6, executionRatio = 0.3, evolutionRatio = 0.1 } = config.budget;
      const sum = consciousnessRatio + executionRatio + evolutionRatio;
      if (Math.abs(sum - 1.0) > 0.05) {
        return `预算比例之和为 ${sum.toFixed(2)}，建议调整为1.0`;
      }
      return null;
    },
  },
  {
    name: 'port_conflict',
    description: '检测API端口是否与常见服务冲突',
    level: VALIDATION_LEVEL.WARNING,
    validate: (config) => {
      if (!config.api?.port) return null;
      const conflictingPorts = [80, 443, 3306, 5432, 6379, 27017, 8080, 8443];
      if (conflictingPorts.includes(config.api.port)) {
        return `端口 ${config.api.port} 可能与常见服务冲突`;
      }
      return null;
    },
  },
  {
    name: 'api_key_placeholder',
    description: '检测API Key是否使用了环境变量占位符但变量未设置',
    level: VALIDATION_LEVEL.WARNING,
    validate: (config) => {
      const apiKey = config.llm?.apiKey;
      if (!apiKey) return 'LLM API Key未配置（将无法调用LLM）';
      if (typeof apiKey === 'string' && apiKey.startsWith('${') && apiKey.endsWith('}')) {
        const envVar = apiKey.slice(2, -1);
        if (!process.env[envVar]) {
          return `环境变量 ${envVar} 未设置，API Key占位符无法解析`;
        }
      }
      return null;
    },
  },
  {
    name: 'memory_threshold',
    description: '检测系统内存是否足够（生产环境）',
    level: VALIDATION_LEVEL.INFO,
    validate: () => {
      const totalMemGB = os.totalmem() / (1024 ** 3);
      if (totalMemGB < 1) {
        return `系统总内存仅 ${totalMemGB.toFixed(1)}GB，建议至少2GB`;
      }
      return null;
    },
  },
  {
    name: 'node_version',
    description: '检查Node.js版本是否满足要求',
    level: VALIDATION_LEVEL.ERROR,
    validate: () => {
      const version = process.versions.node;
      const major = parseInt(version.split('.')[0], 10);
      if (major < 18) {
        return `Node.js版本 ${version} 不满足最低要求(>=18.0.0)`;
      }
      return null;
    },
  },
];

// ── 配置迁移规则 ──
// 将旧版配置字段映射到新版字段
const MIGRATION_RULES = [
  {
    version: '1.0.0',
    description: 'v2.3 → v2.4: 新增 logging/messageQueue/security/budget 子配置',
    migrate: (config) => {
      // 如果旧版使用的是顶层字段，迁移到子配置中
      if (!config.security && config.maxConsciousnessTaskBudget) {
        config.security = {
          maxConsciousnessTaskBudget: config.maxConsciousnessTaskBudget,
          maxAutonomousSteps: config.maxAutonomousSteps,
          maxIdleThinkPerHour: config.maxIdleThinkPerHour,
        };
      }
      if (!config.budget && config.hourlyBudget) {
        config.budget = {
          hourlyBudget: config.hourlyBudget,
          dailyBudget: config.dailyBudget,
          consciousnessRatio: config.consciousnessBudgetRatio,
          executionRatio: config.executionBudgetRatio,
          evolutionRatio: config.evolutionBudgetRatio,
        };
      }
      if (!config.logging) {
        config.logging = {
          level: 'info',
          console: true,
          file: true,
          json: true,
          asyncWrite: true,
          bufferSize: 100,
          flushInterval: 5000,
        };
      }
      if (!config.messageQueue) {
        config.messageQueue = {
          maxSize: 10000,
          persistEnabled: true,
          maxRetries: 3,
          retryDelay: 1000,
          deadLetterEnabled: true,
          ttl: 3600000,
        };
      }
      return config;
    },
  },
];

/**
 * 配置Schema验证器
 */
class ConfigSchemaValidator {
  constructor(options = {}) {
    this._logger = options.logger || null;
    this._strictMode = options.strictMode ?? false;
    this._autoMigrate = options.autoMigrate ?? true;
  }

  /**
   * 验证配置对象
   * @param {Object} config - 要验证的配置对象
   * @param {Object} options - { strictMode?, runCustomRules? }
   * @returns {{ valid: boolean, errors: Array, warnings: Array, info: Array }}
   */
  validate(config, options = {}) {
    const strictMode = options.strictMode ?? this._strictMode;
    const runCustomRules = options.runCustomRules ?? true;

    const errors = [];
    const warnings = [];
    const info = [];

    // 1. Schema验证
    this._validateSchema(config, CONFIG_SCHEMA, 'root', errors, strictMode);

    // 2. 自定义规则验证
    if (runCustomRules) {
      for (const rule of CUSTOM_RULES) {
        const result = rule.validate(config);
        if (result) {
          const item = { rule: rule.name, description: rule.description, message: result };
          if (rule.level === VALIDATION_LEVEL.ERROR) {
            errors.push(item);
          } else if (rule.level === VALIDATION_LEVEL.WARNING) {
            warnings.push(item);
          } else {
            info.push(item);
          }
        }
      }
    }

    const valid = errors.length === 0;

    if (this._logger) {
      if (!valid) {
        this._logger.warn(`配置验证失败: ${errors.length} 个错误, ${warnings.length} 个警告`, {
          module: 'config_validator',
          data: { errors, warnings },
        });
      } else if (warnings.length > 0) {
        this._logger.info(`配置验证通过但有 ${warnings.length} 个警告`, {
          module: 'config_validator',
          data: { warnings },
        });
      }
    }

    return { valid, errors, warnings, info };
  }

  /**
   * 验证并迁移配置
   * @returns {{ valid, errors, warnings, info, migrated: boolean, config }}
   */
  validateAndMigrate(config, options = {}) {
    const autoMigrate = options.autoMigrate ?? this._autoMigrate;

    // 先执行迁移
    let migratedConfig = config;
    let migrated = false;

    if (autoMigrate) {
      for (const rule of MIGRATION_RULES) {
        migratedConfig = rule.migrate(migratedConfig);
        migrated = true;
        if (this._logger) {
          this._logger.info(`配置迁移: ${rule.description}`, { module: 'config_validator' });
        }
      }
    }

    // 然后验证
    const result = this.validate(migratedConfig, options);
    result.migrated = migrated;
    result.config = migratedConfig;

    return result;
  }

  /**
   * 快速验证（仅返回布尔值）
   */
  isValid(config, options = {}) {
    return this.validate(config, options).valid;
  }

  // ═══════════════════════════════════════
  // Schema验证逻辑
  // ═══════════════════════════════════════

  _validateSchema(value, schema, path, errors, strictMode) {
    if (!schema) return;

    // type检查
    if (schema.type) {
      if (!this._checkType(value, schema.type)) {
        errors.push({
          path,
          message: `期望类型 ${schema.type}，实际类型 ${typeof value}`,
          expected: schema.type,
          actual: typeof value,
        });
        return;
      }
    }

    if (value == null) return;

    // enum检查
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({
        path,
        message: `值 "${value}" 不在允许的枚举中: [${schema.enum.join(', ')}]`,
        expected: schema.enum,
        actual: value,
      });
    }

    // 数值范围检查
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push({
          path,
          message: `值 ${value} 小于最小值 ${schema.minimum}`,
        });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push({
          path,
          message: `值 ${value} 大于最大值 ${schema.maximum}`,
        });
      }
    }

    // 字符串正则检查
    if (typeof value === 'string' && schema.pattern) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        errors.push({
          path,
          message: `值 "${value}" 不匹配模式 ${schema.pattern}`,
        });
      }
    }

    // 数组检查
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push({
          path,
          message: `数组长度 ${value.length} 小于最小值 ${schema.minItems}`,
        });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push({
          path,
          message: `数组长度 ${value.length} 大于最大值 ${schema.maxItems}`,
        });
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          this._validateSchema(value[i], schema.items, `${path}[${i}]`, errors, strictMode);
        }
      }
    }

    // 对象属性检查
    if (typeof value === 'object' && !Array.isArray(value)) {
      // required检查
      if (schema.required) {
        for (const requiredField of schema.required) {
          if (!(requiredField in value)) {
            errors.push({
              path: `${path}.${requiredField}`,
              message: `缺少必需字段 "${requiredField}"`,
            });
          }
        }
      }

      // 属性验证
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in value) {
            this._validateSchema(value[key], propSchema, `${path}.${key}`, errors, strictMode);
          }
        }
      }

      // 严格模式：检查未知字段
      if (strictMode && schema.additionalProperties === false && schema.properties) {
        for (const key of Object.keys(value)) {
          if (!(key in schema.properties)) {
            errors.push({
              path: `${path}.${key}`,
              message: `未知字段 "${key}"（严格模式下不允许）`,
            });
          }
        }
      }
    }
  }

  _checkType(value, expectedType) {
    if (value == null) return true; // null/undefined 总是允许的（除非 required）
    switch (expectedType) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number';
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'boolean': return typeof value === 'boolean';
      case 'array': return Array.isArray(value);
      case 'object': return typeof value === 'object' && !Array.isArray(value);
      default: return true;
    }
  }

  // ═══════════════════════════════════════
  // 环境变量占位符解析
  // ═══════════════════════════════════════

  /**
   * 解析配置中的 ${ENV_VAR} 占位符
   * 支持 ${ENV_VAR} 和 ${ENV_VAR:default_value} 格式
   */
  resolveEnvVars(config) {
    const resolved = JSON.parse(JSON.stringify(config));
    this._resolveEnvRecursive(resolved);
    return resolved;
  }

  _resolveEnvRecursive(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        obj[key] = this._resolveString(value);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this._resolveEnvRecursive(value);
      }
    }
  }

  _resolveString(str) {
    return str.replace(/\$\{(\w+)(?::([^}]*))?\}/g, (match, varName, defaultValue) => {
      const envValue = process.env[varName];
      if (envValue !== undefined) return envValue;
      if (defaultValue !== undefined) return defaultValue;
      if (this._logger) {
        this._logger.warn(`环境变量 ${varName} 未设置，占位符 "${match}" 保留原样`, {
          module: 'config_validator',
        });
      }
      return match;
    });
  }

  // ═══════════════════════════════════════
  // 端口可用性检查
  // ═══════════════════════════════════════

  /**
   * 检查端口是否可用
   */
  async checkPortAvailable(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, host);
    });
  }

  // ═══════════════════════════════════════
  // Schema 获取
  // ═══════════════════════════════════════

  /**
   * 获取配置Schema（用于文档生成）
   */
  getSchema() {
    return CONFIG_SCHEMA;
  }

  /**
   * 获取自定义验证规则
   */
  getCustomRules() {
    return CUSTOM_RULES;
  }
}

module.exports = {
  ConfigSchemaValidator,
  CONFIG_SCHEMA,
  CUSTOM_RULES,
  MIGRATION_RULES,
  VALIDATION_LEVEL,
};
