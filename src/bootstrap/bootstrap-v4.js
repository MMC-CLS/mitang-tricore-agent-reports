'use strict';

const { ContentSafetyFilter } = require('../security/content-safety-filter');
const { I18n } = require('../utils/i18n');

/**
 * Bootstrap: v4.0 新增模块
 *
 * 职责：
 *   1. ContentSafetyFilter - PII/注入检测/输出清洗
 *   2. I18n - 国际化框架（zh-CN/en-US 内置）
 */

/**
 * 初始化 v4.0 新增模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── ContentSafetyFilter ──
  agent._contentSafety = new ContentSafetyFilter({
    logger: agent._logger,
    mode: options.safetyMode || 'standard',
    blockOnPII: options.safetyBlockOnPII ?? true,
    blockOnCodeInjection: options.safetyBlockOnCodeInjection ?? true,
    blockOnPromptInjection: options.safetyBlockOnPromptInjection ?? true,
    customBlockPatterns: options.safetyCustomPatterns || [],
    maxInputLength: options.safetyMaxInputLength ?? 50000,
  });

  // ── I18n ──
  agent._i18n = new I18n({
    locale: options.locale || process.env.TRICORE_LOCALE || 'zh-CN',
    fallbackLocale: 'zh-CN',
  });
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // v4.0 模块没有需要从外部绑定的事件
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // v4.0 模块没有额外的启动逻辑
}

module.exports = { init, bindEvents, startup };
