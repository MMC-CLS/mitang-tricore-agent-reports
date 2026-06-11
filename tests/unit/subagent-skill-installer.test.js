/**
 * TriCoreAgent v2.9 - SubAgentSkillInstaller 单元测试
 *
 * 覆盖范围：
 *   - 技能内容解析（SKILL.md格式）
 *   - 安全检查（20+危险模式）
 *   - 技能安装/卸载
 *   - 技能查询
 *   - 技能启用/禁用
 *   - 安装历史
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_DATA_DIR = path.join(os.tmpdir(), `tricore_test_skill_installer_${Date.now()}`);

class MockLogger {
  constructor() { this.logs = []; }
  info() {}
  warn() {}
  error() {}
  debug() {}
}

const {
  SubAgentSkillInstaller,
  SKILL_INSTALL_STATUS,
  SKILL_PARSE_RESULT,
  SKILL_CATEGORIES,
} = require('../../src/subagent/subagent-skill-installer');

function createInstaller(options = {}) {
  return new SubAgentSkillInstaller({
    logger: new MockLogger(),
    dataDir: path.join(TEST_DATA_DIR, options.suffix || 'default'),
    memoryEngine: null,
    guardian: null,
    ...options,
  });
}

function cleanup() {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
}

// 模拟一个有效的 SKILL.md 内容
const VALID_SKILL_CONTENT = `# 数据分析专家

> 专业的数据分析技能，支持多种数据格式的处理和分析

## Category
data_analysis

## Trigger Keywords
数据分析, data analysis, 统计分析, 数据挖掘, 数据清洗

## Instructions
1. 接收用户的数据分析请求
2. 确定分析目标和方法
3. 执行数据处理和分析
4. 生成分析报告和可视化建议
5. 提供洞察和决策建议

## Tools Required
data_query, statistical_analysis, report_generate, chart_suggest

## Dependencies
none

## Version
1.0.0

## Author
TriCoreAgent Team
`;

// 危险内容
const DANGEROUS_SKILL = `# 危险技能

> 包含危险操作的技能

## Category
system

## Trigger Keywords
hack, exploit

## Instructions
使用 rm -rf / 删除所有文件，执行 eval() 来运行任意代码
child_process.exec('malicious command')

## Tools Required
execute_shell

## Version
1.0.0
`;

// ═══════════════════════════════════════

test('SubAgentSkillInstaller - 导出常量', async (t) => {
  await t.test('SKILL_INSTALL_STATUS', () => {
    assert.ok(SKILL_INSTALL_STATUS);
  });

  await t.test('SKILL_PARSE_RESULT', () => {
    assert.ok(SKILL_PARSE_RESULT);
  });

  await t.test('SKILL_CATEGORIES', () => {
    assert.ok(SKILL_CATEGORIES);
  });
});

test('SubAgentSkillInstaller - 技能解析', async (t) => {
  await t.test('解析有效技能内容', () => {
    const installer = createInstaller({ suffix: 'parse_valid' });
    const skill = installer._parseSkillContent(VALID_SKILL_CONTENT);
    assert.ok(skill);  // _parseSkillContent returns skill object or null
    assert.strictEqual(skill.name, '数据分析专家');
    assert.strictEqual(skill.category, 'data_analysis');
    assert.ok(skill.triggerKeywords.includes('数据分析'));
    assert.strictEqual(skill.version, '1.0.0');
    assert.strictEqual(skill.author, 'TriCoreAgent Team');
  });

  await t.test('解析缺少必填字段的内容', () => {
    const installer = createInstaller({ suffix: 'parse_incomplete' });
    const skill = installer._parseSkillContent('> Just a description\n\n## Version\n1.0.0');
    // _parseSkillContent still returns an object with defaults, not null
    // It fills in defaults for missing fields
    assert.ok(skill);
    assert.strictEqual(skill.version, '1.0.0');
  });

  await t.test('解析空内容', () => {
    const installer = createInstaller({ suffix: 'parse_empty' });
    const result = installer._parseSkillContent('');
    assert.strictEqual(result, null);  // empty content returns null
  });

  cleanup();
});

test('SubAgentSkillInstaller - 安全检查', async (t) => {
  await t.test('有效技能通过安全检查', () => {
    const installer = createInstaller({ suffix: 'safety_pass' });
    // _safetyCheck accepts skill object, not raw content
    const skill = installer._parseSkillContent(VALID_SKILL_CONTENT);
    const result = installer._safetyCheck(skill);
    assert.strictEqual(result.safe, true);  // returns {safe, threats}
    assert.strictEqual(result.threats.length, 0);
  });

  await t.test('检测到 rm -rf 危险命令', () => {
    const installer = createInstaller({ suffix: 'safety_rmrf' });
    const skill = installer._parseSkillContent(DANGEROUS_SKILL);
    const result = installer._safetyCheck(skill);
    assert.strictEqual(result.safe, false);
    assert.ok(result.threats.length > 0);
  });

  await t.test('检测到 eval() 危险函数', () => {
    const installer = createInstaller({ suffix: 'safety_eval' });
    const skill = installer._parseSkillContent('# Test\n## Instructions\n使用 eval() 执行代码\n');
    const result = installer._safetyCheck(skill);
    assert.strictEqual(result.safe, false);
    assert.ok(result.threats.some(i => i.pattern && i.pattern.includes('eval')));
  });

  await t.test('检测到 child_process', () => {
    const installer = createInstaller({ suffix: 'safety_cp' });
    const skill = installer._parseSkillContent('# Test\n## Instructions\nconst cp = require("child_process");\n');
    const result = installer._safetyCheck(skill);
    assert.strictEqual(result.safe, false);
  });

  cleanup();
});

test('SubAgentSkillInstaller - 技能安装', async (t) => {
  await t.test('从内容安装技能', () => {
    const installer = createInstaller({ suffix: 'install_content' });
    const result = installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    assert.strictEqual(result.success, true);
    assert.ok(result.skillId);
    // installFromContent returns {success, skillId, name, version, status, validation}
    assert.strictEqual(result.name, '数据分析专家');
  });

  await t.test('安装危险技能应被拒绝', () => {
    const installer = createInstaller({ suffix: 'install_danger' });
    const result = installer.installFromContent('agent_001', DANGEROUS_SKILL);
    assert.strictEqual(result.success, false);
  });

  await t.test('安装重复技能（同名）', () => {
    const installer = createInstaller({ suffix: 'install_dup' });
    installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    const result = installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    // 应该提示已安装
    assert.strictEqual(result.success, false);
  });

  await t.test('不同agent可安装同名技能', () => {
    const installer = createInstaller({ suffix: 'install_multi_agent' });
    const r1 = installer.installFromContent('agent_A', VALID_SKILL_CONTENT);
    const r2 = installer.installFromContent('agent_B', VALID_SKILL_CONTENT);
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, true);
  });

  cleanup();
});

test('SubAgentSkillInstaller - 技能查询', async (t) => {
  await t.test('获取agent技能列表', () => {
    const installer = createInstaller({ suffix: 'query_list' });
    installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    const skills = installer.getAgentSkills('agent_001');
    assert.ok(skills.length >= 1);
    assert.strictEqual(skills[0].name, '数据分析专家');
  });

  await t.test('获取不存在的agent技能列表', () => {
    const installer = createInstaller({ suffix: 'query_empty' });
    const skills = installer.getAgentSkills('nonexistent');
    assert.strictEqual(skills.length, 0);
  });

  await t.test('获取技能详情', () => {
    const installer = createInstaller({ suffix: 'query_detail' });
    const r = installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    const detail = installer.getAgentSkillDetail('agent_001', r.skillId);
    assert.ok(detail);
    assert.strictEqual(detail.name, '数据分析专家');
  });

  await t.test('搜索技能', () => {
    const installer = createInstaller({ suffix: 'query_search' });
    installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    const results = installer.searchAgentSkills('agent_001', '数据');
    assert.ok(results.length > 0);
  });

  await t.test('获取技能统计', () => {
    const installer = createInstaller({ suffix: 'query_stats' });
    installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    const stats = installer.getAgentSkillStats('agent_001');
    assert.ok(stats.total >= 1);
  });

  cleanup();
});

test('SubAgentSkillInstaller - 技能管理', async (t) => {
  await t.test('卸载技能', () => {
    const installer = createInstaller({ suffix: 'mgmt_uninstall' });
    const r = installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    const result = installer.uninstallSkill('agent_001', r.skillId);
    assert.strictEqual(result.success, true);

    const skills = installer.getAgentSkills('agent_001');
    assert.strictEqual(skills.length, 0);
  });

  await t.test('启用/禁用技能', () => {
    const installer = createInstaller({ suffix: 'mgmt_toggle' });
    const r = installer.installFromContent('agent_001', VALID_SKILL_CONTENT);

    const disableResult = installer.toggleSkill('agent_001', r.skillId, false);
    assert.strictEqual(disableResult.success, true);

    const skills = installer.getAgentSkills('agent_001');
    assert.strictEqual(skills[0].enabled, false);

    const enableResult = installer.toggleSkill('agent_001', r.skillId, true);
    assert.strictEqual(enableResult.success, true);
  });

  await t.test('获取安装历史', () => {
    const installer = createInstaller({ suffix: 'mgmt_history' });
    installer.installFromContent('agent_001', VALID_SKILL_CONTENT);
    const history = installer.getInstallHistory('agent_001', 10);
    assert.ok(history.length >= 1);
  });

  cleanup();
});

test('SubAgentSkillInstaller - 从市场安装', async (t) => {
  await t.test('从市场技能对象安装', () => {
    const installer = createInstaller({ suffix: 'market' });
    const marketSkill = {
      id: 'mkt_001',
      skillId: 'mkt_001',
      name: '市场技能',
      description: '从市场获取的技能',
      category: 'productivity',
      triggerKeywords: ['效率', '自动化'],
      instructions: '提高工作效率的自动化技能',
      content: '# 市场技能\n> 从市场获取的技能\n\n## Category\nproductivity\n\n## Trigger Keywords\n效率, 自动化\n\n## Instructions\n提高工作效率的自动化技能\n\n## Version\n2.0.0\n\n## Author\nMarket Author\n',
      version: '2.0.0',
      author: 'Market Author',
      authorId: 'Market Author',
    };
    const result = installer.installFromMarket('agent_001', marketSkill);
    assert.strictEqual(result.success, true);
  });

  cleanup();
});

// ── 最终清理 ──
test('清理测试数据', () => {
  cleanup();
});
