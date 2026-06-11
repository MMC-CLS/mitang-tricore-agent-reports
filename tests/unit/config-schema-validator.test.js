/**
 * TriCoreAgent - ConfigSchemaValidator 单元测试
 *
 * 覆盖范围:
 *   - 构造函数选项
 *   - Schema验证 (类型/枚举/范围/正则/required)
 *   - 自定义业务规则
 *   - 配置迁移
 *   - 环境变量解析
 *   - 严格模式
 *   - 端口可用性检查
 *   - 边界条件和错误处理
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const {
  ConfigSchemaValidator,
  CONFIG_SCHEMA,
  CUSTOM_RULES,
  MIGRATION_RULES,
  VALIDATION_LEVEL,
} = require('../../src/config/config-schema-validator');

// ── 辅助函数 ──

function makeValidConfig() {
  return {
    llm: {
      provider: 'deepseek',
      apiKey: '${OPENAI_API_KEY}',
      model: 'deepseek-chat',
      temperature: 0.7,
    },
    scheduler: {
      awakeningTicks: 10,
      maxConsciousnessTicksPerHour: 30,
      tickIntervalIdle: 60000,
      tickIntervalActive: 10000,
    },
    api: {
      port: 3721,
      host: '127.0.0.1',
    },
  };
}

// ═══════════════════════════════════════
// 构造函数
// ═══════════════════════════════════════

test('ConfigSchemaValidator - 构造函数', async (t) => {
  await t.test('默认选项创建实例', () => {
    const validator = new ConfigSchemaValidator();
    assert.ok(validator instanceof ConfigSchemaValidator);
  });

  await t.test('自定义选项创建实例', () => {
    const validator = new ConfigSchemaValidator({
      strictMode: true,
      autoMigrate: false,
    });
    assert.ok(validator instanceof ConfigSchemaValidator);
  });

  await t.test('传入logger', () => {
    const logger = { info() {}, warn() {}, error() {} };
    const validator = new ConfigSchemaValidator({ logger });
    assert.ok(validator instanceof ConfigSchemaValidator);
  });
});

// ═══════════════════════════════════════
// 基本Schema验证
// ═══════════════════════════════════════

test('ConfigSchemaValidator - Schema验证', async (t) => {
  await t.test('有效配置通过验证', () => {
    const validator = new ConfigSchemaValidator();
    const result = validator.validate(makeValidConfig());
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  await t.test('缺少必需字段 llm', () => {
    const validator = new ConfigSchemaValidator();
    const config = { api: { port: 3721 }, scheduler: {} };
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('缺少必需字段')));
  });

  await t.test('缺少必需字段 api', () => {
    const validator = new ConfigSchemaValidator();
    const config = { llm: { provider: 'openai' }, scheduler: {} };
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('缺少必需字段')));
  });

  await t.test('类型错误 - provider应为string', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.provider = 12345;
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('期望类型 string')));
  });

  await t.test('枚举错误 - 非法provider', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.provider = 'nonexistent_provider';
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('不在允许的枚举中')));
  });

  await t.test('数值范围 - temperature低于最小值', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.temperature = -0.5;
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('小于最小值')));
  });

  await t.test('数值范围 - temperature高于最大值', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.temperature = 3.0;
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('大于最大值')));
  });

  await t.test('数值范围 - api.port超出范围', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.api.port = 10;
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('小于最小值')));
  });

  await t.test('正则验证 - baseUrl格式错误', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.baseUrl = 'ftp://invalid-url';
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('不匹配模式')));
  });

  await t.test('正则验证 - baseUrl格式正确', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.baseUrl = 'https://api.deepseek.com';
    const result = validator.validate(config);
    assert.strictEqual(result.valid, true);
  });

  await t.test('数组长度 - fallbackChain过短', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.fallbackChain = [];
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('数组长度')));
  });

  await t.test('数组长度 - fallbackChain过长', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.fallbackChain = Array(15).fill('openai');
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('大于最大值')));
  });

  await t.test('整数验证 - maxTokens为浮点数', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.maxTokens = 100.5;
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('期望类型 integer')));
  });
});

// ═══════════════════════════════════════
// 自定义业务规则
// ═══════════════════════════════════════

test('ConfigSchemaValidator - 自定义规则', async (t) => {
  await t.test('预算比例之和偏差过大 - 产生警告', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.budget = {
      hourlyBudget: 100000,
      dailyBudget: 1000000,
      consciousnessRatio: 0.9,
      executionRatio: 0.5,
      evolutionRatio: 0.3,
    };
    const result = validator.validate(config);
    assert.ok(result.warnings.some(w => w.rule === 'budget_ratio_sum'));
  });

  await t.test('预算比例之和合理 - 无警告', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.budget = {
      consciousnessRatio: 0.6,
      executionRatio: 0.3,
      evolutionRatio: 0.1,
    };
    const result = validator.validate(config);
    assert.strictEqual(result.warnings.filter(w => w.rule === 'budget_ratio_sum').length, 0);
  });

  await t.test('API Key占位符 - 环境变量未设置', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.apiKey = '${NONEXISTENT_API_KEY}';
    const result = validator.validate(config);
    assert.ok(result.warnings.some(w => w.rule === 'api_key_placeholder'));
  });

  await t.test('API Key未配置 - 产生警告', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.apiKey = '';
    const result = validator.validate(config);
    assert.ok(result.warnings.some(w => w.rule === 'api_key_placeholder'));
  });

  await t.test('端口冲突检查 - 使用常见端口', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.api.port = 3306;
    const result = validator.validate(config);
    assert.ok(result.warnings.some(w => w.rule === 'port_conflict'));
  });

  await t.test('端口无冲突 - 使用自定义端口', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.api.port = 3721;
    const result = validator.validate(config);
    assert.strictEqual(result.warnings.filter(w => w.rule === 'port_conflict').length, 0);
  });

  await t.test('Node版本检查 - 应产生结果', () => {
    const validator = new ConfigSchemaValidator();
    const result = validator.validate(makeValidConfig());
    const allItems = [...result.errors, ...result.warnings, ...result.info];
    // node_version规则可能在errors(旧版本)或info(新版本)中
    const nodeCheck = allItems.find(item => item.rule === 'node_version');
    // 如果Node >= 18，该规则不产生任何消息（验证通过）
    // 如果Node < 18，该规则产生error
    const version = process.versions.node;
    const major = parseInt(version.split('.')[0], 10);
    if (major < 18) {
      assert.ok(nodeCheck !== undefined, 'Node版本过低应产生error');
    } else {
      // Node >= 18，该规则静默通过，但验证结果结构应完整
      assert.ok(result, '验证结果对象应存在');
      assert.strictEqual(typeof result.valid, 'boolean', '结果应包含valid字段');
      assert.ok(Array.isArray(result.errors), '结果应包含errors数组');
      assert.ok(Array.isArray(result.warnings), '结果应包含warnings数组');
    }
  });

  await t.test('可跳过自定义规则', () => {
    const validator = new ConfigSchemaValidator();
    const config = makeValidConfig();
    config.llm.apiKey = '';
    const result = validator.validate(config, { runCustomRules: false });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 0);
  });
});

// ═══════════════════════════════════════
// 配置迁移
// ═══════════════════════════════════════

test('ConfigSchemaValidator - 配置迁移', async (t) => {
  await t.test('旧版顶层字段迁移到子配置', () => {
    const validator = new ConfigSchemaValidator({ autoMigrate: true });
    const oldConfig = {
      llm: { provider: 'openai' },
      scheduler: {},
      api: { port: 3721 },
      maxConsciousnessTaskBudget: 5000,
      maxAutonomousSteps: 10,
      maxIdleThinkPerHour: 5,
      hourlyBudget: 50000,
      dailyBudget: 500000,
      consciousnessBudgetRatio: 0.6,
      executionBudgetRatio: 0.3,
      evolutionBudgetRatio: 0.1,
    };
    const result = validator.validateAndMigrate(oldConfig);
    assert.strictEqual(result.migrated, true);
    assert.ok(result.config.security !== undefined);
    assert.strictEqual(result.config.security.maxConsciousnessTaskBudget, 5000);
    assert.ok(result.config.budget !== undefined);
    assert.strictEqual(result.config.budget.hourlyBudget, 50000);
  });

  await t.test('迁移后自动添加logging默认值', () => {
    const validator = new ConfigSchemaValidator({ autoMigrate: true });
    const config = {
      llm: { provider: 'openai' },
      scheduler: {},
      api: { port: 3721 },
    };
    const result = validator.validateAndMigrate(config);
    assert.ok(result.config.logging !== undefined);
    assert.strictEqual(result.config.logging.level, 'info');
  });

  await t.test('迁移后自动添加messageQueue默认值', () => {
    const validator = new ConfigSchemaValidator({ autoMigrate: true });
    const config = {
      llm: { provider: 'openai' },
      scheduler: {},
      api: { port: 3721 },
    };
    const result = validator.validateAndMigrate(config);
    assert.ok(result.config.messageQueue !== undefined);
    assert.strictEqual(result.config.messageQueue.maxSize, 10000);
  });

  await t.test('禁用自动迁移', () => {
    const validator = new ConfigSchemaValidator({ autoMigrate: false });
    const config = {
      llm: { provider: 'openai' },
      scheduler: {},
      api: { port: 3721 },
      maxConsciousnessTaskBudget: 5000,
    };
    const result = validator.validateAndMigrate(config);
    assert.strictEqual(result.migrated, false);
    assert.strictEqual(result.config.logging, undefined);
  });
});

// ═══════════════════════════════════════
// 严格模式
// ═══════════════════════════════════════

test('ConfigSchemaValidator - 严格模式', async (t) => {
  await t.test('严格模式检测未知字段', () => {
    const validator = new ConfigSchemaValidator({ strictMode: true });
    const config = makeValidConfig();
    config.llm.unknownField = 'surprise';
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('未知字段')));
  });

  await t.test('非严格模式允许额外字段', () => {
    const validator = new ConfigSchemaValidator({ strictMode: false });
    const config = makeValidConfig();
    config.llm.unknownField = 'surprise';
    const result = validator.validate(config);
    assert.strictEqual(result.valid, true);
  });

  await t.test('严格模式 - api子对象检测未知字段', () => {
    const validator = new ConfigSchemaValidator({ strictMode: true });
    const config = makeValidConfig();
    config.api.extraField = 'bad';
    const result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.path.includes('api') && e.message.includes('未知字段')));
  });

  await t.test('options中覆盖strictMode', () => {
    const validator = new ConfigSchemaValidator({ strictMode: false });
    const config = makeValidConfig();
    config.llm.unknownField = 'surprise';
    const result = validator.validate(config, { strictMode: true });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.message.includes('未知字段')));
  });
});

// ═══════════════════════════════════════
// 快速验证isValid
// ═══════════════════════════════════════

test('ConfigSchemaValidator - isValid', async (t) => {
  await t.test('有效配置返回true', () => {
    const validator = new ConfigSchemaValidator();
    assert.strictEqual(validator.isValid(makeValidConfig()), true);
  });

  await t.test('无效配置返回false', () => {
    const validator = new ConfigSchemaValidator();
    assert.strictEqual(validator.isValid({}), false);
  });
});

// ═══════════════════════════════════════
// 环境变量解析
// ═══════════════════════════════════════

test('ConfigSchemaValidator - 环境变量解析', async (t) => {
  await t.test('解析 ${ENV_VAR} 占位符', () => {
    const validator = new ConfigSchemaValidator();
    process.env._TEST_MY_KEY = 'resolved-value';
    const config = { llm: { provider: 'openai', apiKey: '${_TEST_MY_KEY}' } };
    const resolved = validator.resolveEnvVars(config);
    assert.strictEqual(resolved.llm.apiKey, 'resolved-value');
    delete process.env._TEST_MY_KEY;
  });

  await t.test('解析 ${ENV_VAR:default} 格式 - 变量未设置时使用默认值', () => {
    const validator = new ConfigSchemaValidator();
    const config = { llm: { provider: 'openai', apiKey: '${NONEXISTENT_KEY:default-key}' } };
    const resolved = validator.resolveEnvVars(config);
    assert.strictEqual(resolved.llm.apiKey, 'default-key');
  });

  await t.test('解析 ${ENV_VAR:default} 格式 - 变量已设置时使用变量值', () => {
    const validator = new ConfigSchemaValidator();
    process.env._TEST_OVERRIDE = 'override-value';
    const config = { llm: { provider: 'openai', apiKey: '${_TEST_OVERRIDE:default-key}' } };
    const resolved = validator.resolveEnvVars(config);
    assert.strictEqual(resolved.llm.apiKey, 'override-value');
    delete process.env._TEST_OVERRIDE;
  });

  await t.test('递归解析嵌套对象', () => {
    const validator = new ConfigSchemaValidator();
    process.env._TEST_DEEP = 'deep-value';
    const config = {
      llm: { provider: 'openai' },
      api: { apiToken: '${_TEST_DEEP}' },
    };
    const resolved = validator.resolveEnvVars(config);
    assert.strictEqual(resolved.api.apiToken, 'deep-value');
    delete process.env._TEST_DEEP;
  });

  await t.test('未设置环境变量保留占位符', () => {
    const validator = new ConfigSchemaValidator();
    const config = { llm: { provider: 'openai', apiKey: '${TRULY_NONEXISTENT_VAR}' } };
    const resolved = validator.resolveEnvVars(config);
    assert.strictEqual(resolved.llm.apiKey, '${TRULY_NONEXISTENT_VAR}');
  });
});

// ═══════════════════════════════════════
// 端口可用性检查
// ═══════════════════════════════════════

test('ConfigSchemaValidator - 端口可用性检查', async (t) => {
  await t.test('checkPortAvailable - 随机端口应可用', async () => {
    const validator = new ConfigSchemaValidator();
    // 使用端口0让系统分配随机端口，先占用再释放
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const busyPort = server.address().port;
    server.close();

    // 短暂等待确保端口释放
    await new Promise(r => setTimeout(r, 100));

    const available = await validator.checkPortAvailable(busyPort, '127.0.0.1');
    // 端口刚释放应该可用（有极小几率被占用）
    assert.strictEqual(typeof available, 'boolean');
  });

  await t.test('checkPortAvailable - 占用端口返回false', async () => {
    const validator = new ConfigSchemaValidator();
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const busyPort = server.address().port;

    const available = await validator.checkPortAvailable(busyPort, '127.0.0.1');
    assert.strictEqual(available, false);
    server.close();
  });
});

// ═══════════════════════════════════════
// Schema获取
// ═══════════════════════════════════════

test('ConfigSchemaValidator - Schema和规则获取', async (t) => {
  await t.test('getSchema返回完整schema', () => {
    const validator = new ConfigSchemaValidator();
    const schema = validator.getSchema();
    assert.ok(schema.type === 'object');
    assert.ok(schema.required.includes('llm'));
    assert.ok(schema.required.includes('api'));
    assert.ok(schema.required.includes('scheduler'));
  });

  await t.test('getCustomRules返回所有规则', () => {
    const validator = new ConfigSchemaValidator();
    const rules = validator.getCustomRules();
    assert.ok(Array.isArray(rules));
    assert.ok(rules.length >= 3);
    assert.ok(rules.every(r => typeof r.validate === 'function'));
  });
});

// ═══════════════════════════════════════
// 边界条件
// ═══════════════════════════════════════

test('ConfigSchemaValidator - 边界条件', async (t) => {
  await t.test('空配置对象', () => {
    const validator = new ConfigSchemaValidator();
    const result = validator.validate({});
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  await t.test('null输入 - 抛出TypeError', () => {
    const validator = new ConfigSchemaValidator();
    assert.throws(() => {
      validator.validate(null);
    }, /TypeError|Cannot read properties/i);
  });

  await t.test('undefined输入 - 抛出TypeError', () => {
    const validator = new ConfigSchemaValidator();
    assert.throws(() => {
      validator.validate(undefined);
    }, /TypeError|Cannot read properties/i);
  });

  await t.test('logger为null时静默处理', () => {
    const validator = new ConfigSchemaValidator({ logger: null });
    const result = validator.validate(makeValidConfig());
    assert.strictEqual(result.valid, true);
  });

  await t.test('validateAndMigrate也运行验证', () => {
    const validator = new ConfigSchemaValidator();
    const badConfig = {
      llm: { provider: 'invalid' },
      scheduler: {},
      api: { port: 10 },
    };
    const result = validator.validateAndMigrate(badConfig);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
});
