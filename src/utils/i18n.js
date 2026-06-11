/**
 * TriCore Agent v4.0 - 国际化框架 (Internationalization)
 *
 * 多语言支持框架：
 *   1. 分层键值查找 (system.name → "蜜糖 TriCore Agent")
 *   2. 中英文双语默认支持
 *   3. 运行时动态切换
 *   4. 自定义语言包注册
 */

'use strict';

// ── 语言代码 ──
const LOCALE = Object.freeze({
  ZH_CN: 'zh-CN',
  EN_US: 'en-US',
  ZH_TW: 'zh-TW',
  JA_JP: 'ja-JP',
});

// ── 内置字符串资源 ──
const STRINGS = {
  [LOCALE.ZH_CN]: {
    system: {
      name: '蜜糖 TriCore Agent',
      startup: '系统启动中...',
      shutdown: '系统关闭中...',
      ready: '系统就绪',
      version: '版本',
      uptime: '运行时间',
    },
    consciousness: {
      thinking: '思考中...',
      awakening: '觉醒期',
      focus: '焦点',
      idle: '空闲',
      tick: 'TICK',
    },
    execution: {
      running: '执行中',
      completed: '已完成',
      failed: '失败',
      paused: '已暂停',
      pending: '等待中',
      task: '任务',
    },
    evolution: {
      learning: '学习中',
      consolidating: '记忆整合中',
      auditing: '审计中',
      skill: '技能',
      approved: '已批准',
      pending: '待审核',
    },
    errors: {
      unknown: '未知错误',
      timeout: '操作超时',
      permission: '权限不足',
      notFound: '未找到',
      rateLimit: '请求频率过高',
      authFailed: '认证失败',
    },
    selfcheck: {
      running: '自检运行中',
      passed: '自检通过',
      failed: '自检失败',
      skipped: '自检跳过',
      phase0: '前置飞航检查',
      phase1: '能力探测',
      phase2: '集成冒烟',
      phase3: '端到端验证',
      degraded: '降级通过',
    },
    safety: {
      blocked: '内容已阻止',
      warned: '内容已标记',
      safe: '安全',
      filtered: '已过滤',
    },
    dashboard: {
      title: '管理仪表盘',
      overview: '概览',
      cores: '三核状态',
      memory: '记忆统计',
      performance: '性能指标',
      logs: '操作日志',
    },
    time: {
      seconds: '秒',
      minutes: '分钟',
      hours: '小时',
      days: '天',
      ago: '前',
    },
  },

  [LOCALE.EN_US]: {
    system: {
      name: 'Mitang TriCore Agent',
      startup: 'Starting up...',
      shutdown: 'Shutting down...',
      ready: 'System ready',
      version: 'Version',
      uptime: 'Uptime',
    },
    consciousness: {
      thinking: 'Thinking...',
      awakening: 'Awakening',
      focus: 'Focus',
      idle: 'Idle',
      tick: 'TICK',
    },
    execution: {
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      paused: 'Paused',
      pending: 'Pending',
      task: 'Task',
    },
    evolution: {
      learning: 'Learning',
      consolidating: 'Consolidating memory',
      auditing: 'Auditing',
      skill: 'Skill',
      approved: 'Approved',
      pending: 'Pending',
    },
    errors: {
      unknown: 'Unknown error',
      timeout: 'Operation timed out',
      permission: 'Permission denied',
      notFound: 'Not found',
      rateLimit: 'Rate limit exceeded',
      authFailed: 'Authentication failed',
    },
    selfcheck: {
      running: 'Self-check running',
      passed: 'Self-check passed',
      failed: 'Self-check failed',
      skipped: 'Self-check skipped',
      phase0: 'Pre-flight check',
      phase1: 'Capability probe',
      phase2: 'Integration smoke',
      phase3: 'E2E verification',
      degraded: 'Degraded pass',
    },
    safety: {
      blocked: 'Content blocked',
      warned: 'Content flagged',
      safe: 'Safe',
      filtered: 'Filtered',
    },
    dashboard: {
      title: 'Admin Dashboard',
      overview: 'Overview',
      cores: 'TriCore Status',
      memory: 'Memory Stats',
      performance: 'Performance Metrics',
      logs: 'Operation Logs',
    },
    time: {
      seconds: 's',
      minutes: 'min',
      hours: 'h',
      days: 'd',
      ago: 'ago',
    },
  },
};

class I18n {
  constructor(locale = LOCALE.ZH_CN) {
    this._locale = locale;
    this._fallbackLocale = LOCALE.EN_US;
    this._customStrings = {};
  }

  /**
   * 获取当前语言
   * @returns {string}
   */
  get locale() {
    return this._locale;
  }

  /**
   * 设置当前语言
   * @param {string} locale - 语言代码
   */
  setLocale(locale) {
    if (this._getStringsFor(locale)) {
      this._locale = locale;
      return true;
    }
    return false;
  }

  /**
   * 翻译键值
   * @param {string} key - 点号分隔的键路径 (如 'system.name')
   * @param {Object} params - 模板参数 (可选)
   * @returns {string} 翻译结果
   */
  t(key, params = {}) {
    const keys = key.split('.');
    let val = this._resolveKey(keys, this._locale);

    // 回退到英文
    if (val === undefined && this._locale !== this._fallbackLocale) {
      val = this._resolveKey(keys, this._fallbackLocale);
    }

    // 最终回退到键值本身
    if (val === undefined || val === null) {
      return key;
    }

    // 模板替换 {param}
    if (typeof val === 'string' && Object.keys(params).length > 0) {
      return val.replace(/\{(\w+)\}/g, (_, name) => {
        return params[name] !== undefined ? String(params[name]) : `{${name}}`;
      });
    }

    return val;
  }

  /**
   * 注册自定义语言包
   * @param {string} locale - 语言代码
   * @param {Object} strings - 键值对
   */
  registerLocale(locale, strings) {
    this._customStrings[locale] = strings;
  }

  /**
   * 获取所有支持的语言
   * @returns {string[]}
   */
  getSupportedLocales() {
    const builtin = Object.keys(STRINGS);
    const custom = Object.keys(this._customStrings);
    return [...new Set([...builtin, ...custom])];
  }

  /**
   * 获取指定语言的完整字符串映射
   * @param {string} locale
   * @returns {Object|null}
   */
  _getStringsFor(locale) {
    return STRINGS[locale] || this._customStrings[locale] || null;
  }

  /**
   * 解析点号分隔的键路径
   * @param {string[]} keys
   * @param {string} locale
   * @returns {*}
   */
  _resolveKey(keys, locale) {
    const strings = this._getStringsFor(locale);
    if (!strings) return undefined;

    let current = strings;
    for (const key of keys) {
      if (current === undefined || current === null) return undefined;
      current = current[key];
    }
    return current;
  }
}

// ── 导出 ──
module.exports = {
  I18n,
  LOCALE,
  STRINGS,
};
