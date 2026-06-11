'use strict';

const path = require('path');

const { BrowserAutomation } = require('../execution/browser-automation');
const { SocialDispatch } = require('../social/social-dispatch');
const { VoiceSystem } = require('../voice/voice-system');
const { ApiServer } = require('../api/api-server');
const { ConfigManager } = require('../config/config-manager');

/**
 * Bootstrap: 扩展层
 *
 * 职责：
 *   1. BrowserAutomation - Playwright网页控制
 *   2. SocialDispatch - 微信/飞书/Discord统一接入
 *   3. VoiceSystem - ASR+TTS
 *   4. ApiServer - HTTP+SSE接口
 *   5. ConfigManager - 持久化配置管理
 */

/**
 * 初始化扩展层模块
 * @param {TriCoreAgent} agent - Agent 实例
 * @param {object} options - 构造函数 options
 */
function init(agent, options) {
  // ── BrowserAutomation ──
  agent._browser = new BrowserAutomation({
    headless: options.headless ?? true,
  });

  // ── SocialDispatch ──
  agent._social = new SocialDispatch();

  // ── VoiceSystem ──
  agent._voice = new VoiceSystem({
    audioDir: path.join(agent._dataDir, 'audio'),
    ...options.voice,
  });

  // ── ApiServer ──
  agent._apiServer = new ApiServer({
    port: options.port ?? 3721,
    host: options.host ?? '127.0.0.1',
    agent: agent,
    allowLan: options.allowLan ?? false,
  });

  // ── ConfigManager ──
  agent._config = new ConfigManager({
    configDir: path.join(agent._dataDir, 'config'),
  });

  // v3.1: 将 ConfigManager 注入自检模块（用于持久化自检状态）
  agent._startupSelfCheck._configManager = agent._config;
}

/**
 * 绑定事件
 */
function bindEvents(agent) {
  // 社交事件绑定在 index.js 的 _bindSocialEvents() 中处理
}

/**
 * 启动逻辑
 */
function startup(agent, config) {
  // 扩展层启动逻辑由 index.js start() 直接处理
}

module.exports = { init, bindEvents, startup };
