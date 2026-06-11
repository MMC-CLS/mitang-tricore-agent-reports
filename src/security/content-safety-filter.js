/**
 * TriCore Agent v4.0 - 内容安全过滤器 (Content Safety Filter)
 *
 * LLM输出安全检测系统：
 *   1. PII检测 - 身份证号/银行卡号/邮箱/手机号
 *   2. 代码注入检测 - script/eval/child_process
 *   3. 敏感内容检测 - 暴力/仇恨/成人/自残
 *   4. 输出脱敏处理
 *   5. 安全级别分类: SAFE/WARN/BLOCK
 *
 * 设计原则：
 *   - 默认安全：未明确安全的内容标记为WARN
 *   - 可配置：strictMode启用后所有WARN升级为BLOCK
 *   - 可观测：emit事件供审计日志记录
 */

'use strict';

const { EventEmitter } = require('events');

// ── 安全分类 ──
const SAFETY_CATEGORY = Object.freeze({
  PII: 'pii',
  VIOLENCE: 'violence',
  HATE: 'hate',
  ADULT: 'adult',
  SELF_HARM: 'self_harm',
  POLITICAL: 'political',
  PROMPT_INJECTION: 'prompt_injection',
  CODE_INJECTION: 'code_injection',
});

// ── 安全级别 ──
const SAFETY_LEVEL = Object.freeze({
  SAFE: 'safe',
  WARN: 'warn',
  BLOCK: 'block',
});

// ── 默认检测模式 ──
const FILTER_MODE = Object.freeze({
  STANDARD: 'standard',
  STRICT: 'strict',
  PERMISSIVE: 'permissive',
});

class ContentSafetyFilter extends EventEmitter {
  constructor(options = {}) {
    super();
    this._logger = options.logger || console;
    this._enabled = options.enabled !== false;
    this._mode = options.mode || FILTER_MODE.STANDARD;
    this._maxTextLength = options.maxTextLength ?? 50000;

    // ── 正则模式库 ──
    this._patterns = {
      [SAFETY_CATEGORY.PII]: [
        // 身份证号 (18位)
        { pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, severity: 'high', label: 'ChineseID' },
        // 银行卡号 (16-19位)
        { pattern: /\b\d{16,19}\b/g, severity: 'high', label: 'BankCard' },
        // 邮箱
        { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, severity: 'medium', label: 'Email' },
        // 手机号 (中国大陆)
        { pattern: /\b1[3-9]\d{9}\b/g, severity: 'medium', label: 'PhoneNumber' },
        // SSN-like (3-2-4)
        { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, severity: 'high', label: 'SSN' },
        // API Key模式
        { pattern: /\b(sk-[A-Za-z0-9]{20,})\b/g, severity: 'critical', label: 'APIKey' },
      ],
      [SAFETY_CATEGORY.CODE_INJECTION]: [
        { pattern: /<script[\s>]/gi, severity: 'critical', label: 'ScriptTag' },
        { pattern: /\beval\s*\(/gi, severity: 'high', label: 'Eval' },
        { pattern: /document\.cookie/gi, severity: 'high', label: 'CookieAccess' },
        { pattern: /require\s*\(\s*['"]child_process['"]/gi, severity: 'critical', label: 'ChildProcess' },
        { pattern: /\bexec\s*\(/gi, severity: 'high', label: 'Exec' },
        { pattern: /Function\s*\(/gi, severity: 'high', label: 'FunctionConstructor' },
        { pattern: /process\.env/gi, severity: 'medium', label: 'EnvAccess' },
      ],
      [SAFETY_CATEGORY.VIOLENCE]: [
        { pattern: /\b(?:kill|murder|assassinate|slaughter|massacre)\b/gi, severity: 'high', label: 'ViolentWords' },
      ],
      [SAFETY_CATEGORY.HATE]: [
        { pattern: /\b(?:racist|nazi|supremacist|lynch)\b/gi, severity: 'critical', label: 'HateSpeech' },
      ],
      [SAFETY_CATEGORY.SELF_HARM]: [
        { pattern: /\b(?:suicide|self-harm|cut myself|end my life)\b/gi, severity: 'critical', label: 'SelfHarm' },
      ],
      [SAFETY_CATEGORY.PROMPT_INJECTION]: [
        { pattern: /ignore (?:all )?(?:previous|above) (?:instructions|prompts|rules)/gi, severity: 'high', label: 'PromptInjection' },
        { pattern: /you are now (?:DAN|jailbroken|unfiltered)/gi, severity: 'critical', label: 'Jailbreak' },
        { pattern: /\[system\]\s*\(override\)/gi, severity: 'critical', label: 'SystemOverride' },
      ],
    };

    // ── 统计 ──
    this._stats = { total: 0, blocked: 0, warned: 0, safe: 0 };
  }

  /**
   * 检查LLM输出内容安全性
   * @param {string} text - 待检查文本
   * @param {Object} context - 上下文（可选：source, modelId, userId等）
   * @returns {Object} { safe, level, issues }
   */
  checkOutput(text, context = {}) {
    if (!this._enabled || !text || typeof text !== 'string') {
      return { safe: true, level: SAFETY_LEVEL.SAFE, issues: [] };
    }

    this._stats.total++;

    // 截断过长文本
    const checkText = text.length > this._maxTextLength
      ? text.substring(0, this._maxTextLength)
      : text;

    const issues = [];

    for (const [category, patterns] of Object.entries(this._patterns)) {
      for (const { pattern, severity, label } of patterns) {
        // Reset regex lastIndex
        pattern.lastIndex = 0;
        const matches = checkText.match(pattern);
        if (matches) {
          issues.push({
            category,
            label,
            severity,
            matches: matches.length,
            samples: matches.slice(0, 3), // 最多3个样本
          });
        }
      }
    }

    // 判定级别
    let level = SAFETY_LEVEL.SAFE;
    if (issues.length > 0) {
      const hasCritical = issues.some(i => i.severity === 'critical');
      const hasHigh = issues.some(i => i.severity === 'high');

      if (this._mode === FILTER_MODE.STRICT) {
        // 严格模式：有任何问题都阻止
        level = SAFETY_LEVEL.BLOCK;
      } else if (this._mode === FILTER_MODE.PERMISSIVE) {
        // 宽松模式：仅关键问题阻止
        level = hasCritical ? SAFETY_LEVEL.BLOCK : SAFETY_LEVEL.WARN;
      } else {
        // 标准模式：关键/高危问题阻止，其他警告
        level = (hasCritical || hasHigh) ? SAFETY_LEVEL.BLOCK : SAFETY_LEVEL.WARN;
      }

      if (level === SAFETY_LEVEL.BLOCK) {
        this._stats.blocked++;
        this.emit('content_blocked', { issues, context, timestamp: Date.now() });
      } else {
        this._stats.warned++;
        this.emit('content_flagged', { issues, context, timestamp: Date.now() });
      }
    } else {
      this._stats.safe++;
    }

    return {
      safe: level === SAFETY_LEVEL.SAFE,
      level,
      issues,
      timestamp: Date.now(),
    };
  }

  /**
   * 输出脱敏处理
   * @param {string} text - 待脱敏文本
   * @returns {string} 脱敏后文本
   */
  sanitizeOutput(text) {
    if (!text || typeof text !== 'string') return text;

    let sanitized = text;

    // 替换script标签
    sanitized = sanitized.replace(/<script[\s>]/gi, '&lt;script ');
    sanitized = sanitized.replace(/<\/script>/gi, '&lt;/script&gt;');

    // 替换eval
    sanitized = sanitized.replace(/\beval\s*\(/gi, 'eval&#40;');

    // 替换危险函数调用
    sanitized = sanitized.replace(/document\.cookie/gi, 'document.cookie&#91;filtered&#93;');
    sanitized = sanitized.replace(/process\.env/gi, 'process.env&#91;filtered&#93;');

    // 脱敏API Key
    sanitized = sanitized.replace(/\b(sk-[A-Za-z0-9]{20,})\b/g, 'sk-***REDACTED***');

    // 脱敏身份证号
    sanitized = sanitized.replace(
      /\b([1-9]\d{5})(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(\d{3})[\dXx]\b/g,
      '$1****$2*'
    );

    // 脱敏手机号
    sanitized = sanitized.replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2');

    return sanitized;
  }

  /**
   * 获取过滤统计
   * @returns {Object} 统计数据
   */
  getStats() {
    return {
      ...this._stats,
      enabled: this._enabled,
      mode: this._mode,
      timestamp: Date.now(),
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this._stats = { total: 0, blocked: 0, warned: 0, safe: 0 };
  }

  /**
   * 设置过滤模式
   * @param {string} mode - FILTER_MODE枚举值
   */
  setMode(mode) {
    if (Object.values(FILTER_MODE).includes(mode)) {
      this._mode = mode;
      this.emit('mode_changed', { mode });
    }
  }

  /**
   * 启用/禁用过滤
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = !!enabled;
    this.emit('enabled_changed', { enabled: this._enabled });
  }

  /**
   * 添加自定义检测模式
   * @param {string} category - SAFETY_CATEGORY值
   * @param {RegExp} pattern - 检测正则
   * @param {string} severity - 严重程度
   * @param {string} label - 标签
   */
  addPattern(category, pattern, severity = 'medium', label = 'custom') {
    if (!this._patterns[category]) {
      this._patterns[category] = [];
    }
    this._patterns[category].push({ pattern, severity, label });
  }
}

// ── 导出 ──
module.exports = {
  ContentSafetyFilter,
  SAFETY_CATEGORY,
  SAFETY_LEVEL,
  FILTER_MODE,
};
