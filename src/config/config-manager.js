/**
 * TriCore Agent - 应用配置管理
 *
 * 持久化配置存储：
 *   - LLM Provider配置
 *   - 社交渠道Token
 *   - UI偏好
 *   - 自启动设置
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── 默认配置 ──
const DEFAULT_CONFIG = {
  // LLM
  llm: {
    provider: 'deepseek',
    apiKey: '',
    model: '',
    fallbackChain: ['deepseek', 'qwen', 'openai'],
  },

  // 调度器
  scheduler: {
    awakeningTicks: 10,
    maxConsciousnessTicksPerHour: 12,
    tickIntervalIdle: 300000,  // 5min
    tickIntervalActive: 30000, // 30s
  },

  // 社交渠道
  social: {
    discord: { botToken: '' },
    wechat_clawbot: { accountId: '', botToken: '', baseUrl: '' },
    wechat_official: { appId: '', appSecret: '' },
    feishu: { appId: '', appSecret: '' },
    wecom: { key: '' },
  },

  // 语音
  voice: {
    asrProvider: 'local_whisper',
    ttsProvider: 'doubao',
    whisperModel: 'base',
  },

  // 浏览器
  browser: {
    headless: true,
    defaultSearchEngine: 'bing',
  },

  // UI
  ui: {
    theme: 'dark',
    fontSize: 13,
    autoStart: false,
    minimizeToTray: true,
    showOnStartup: true,
  },

  // API
  api: {
    port: 3721,
    host: '127.0.0.1',
    allowLan: false,
    apiToken: '',
  },
};

class ConfigManager {
  constructor(options = {}) {
    this._configDir = options.configDir || path.join(process.cwd(), 'config');
    this._configPath = path.join(this._configDir, 'tricore.json');
    this._config = null;
  }

  /**
   * 加载配置（合并默认值 + 用户配置）
   */
  load() {
    this._config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    if (fs.existsSync(this._configPath)) {
      try {
        const userConfig = JSON.parse(fs.readFileSync(this._configPath, 'utf-8'));
        this._config = this._deepMerge(this._config, userConfig);
      } catch (error) {
        console.warn(`[Config] 配置文件读取失败，使用默认值: ${error.message}`);
      }
    }

    return this._config;
  }

  /**
   * 保存配置到磁盘
   */
  save() {
    if (!fs.existsSync(this._configDir)) {
      fs.mkdirSync(this._configDir, { recursive: true });
    }
    fs.writeFileSync(this._configPath, JSON.stringify(this._config, null, 2), 'utf-8');
  }

  /**
   * 获取配置项（支持点号路径）
   */
  get(key) {
    if (!this._config) this.load();
    if (!key) return this._config;

    const parts = key.split('.');
    let current = this._config;
    for (const part of parts) {
      if (current == null) return undefined;
      current = current[part];
    }
    return current;
  }

  /**
   * 设置配置项（支持点号路径）
   */
  set(key, value) {
    if (!this._config) this.load();

    const parts = key.split('.');
    let current = this._config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] == null) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  /**
   * 重置为默认配置
   */
  reset() {
    this._config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.save();
  }

  /**
   * 导出当前配置（去除敏感信息）
   */
  exportSafe() {
    const safe = JSON.parse(JSON.stringify(this._config));
    // 遮蔽API Key（显示末4位，避免泄露前缀信息）
    if (safe.llm?.apiKey) safe.llm.apiKey = '****' + safe.llm.apiKey.slice(-4);
    if (safe.social?.discord?.botToken) safe.social.discord.botToken = '****';
    if (safe.social?.wechat_clawbot?.botToken) safe.social.wechat_clawbot.botToken = '****';
    if (safe.social?.wechat_official?.appSecret) safe.social.wechat_official.appSecret = '****';
    if (safe.social?.feishu?.appSecret) safe.social.feishu.appSecret = '****';
    if (safe.api?.apiToken) safe.api.apiToken = '****';
    return safe;
  }

  // ── 深度合并 ──
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
}

module.exports = { ConfigManager, DEFAULT_CONFIG };
