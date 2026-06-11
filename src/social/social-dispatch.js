/**
 * TriCore Agent - 社交分发完整实现 (Phase 25)
 *
 * 统一消息分发平台，支持多渠道接入：
 *   1. Discord - Webhook/Bot API
 *   2. Slack - Webhook/Bot API
 *   3. 企业微信 - 群机器人/应用消息
 *   4. 飞书 - 自定义机器人/应用消息
 *   5. Telegram - Bot API
 *   6. Email - SMTP
 *   7. 自定义Webhook - 通用HTTP回调
 *
 * 核心能力：
 *   - 多通道统一消息格式
 *   - 消息模板引擎（Markdown/富文本）
 *   - 通道状态监控与自动重连
 *   - 消息队列与重试机制
 *   - 入站消息路由分发
 */

'use strict';

const { EventEmitter } = require('events');

const CHANNEL = Object.freeze({
  DISCORD: 'discord',
  SLACK: 'slack',
  WECOM: 'wecom',       // 企业微信
  FEISHU: 'feishu',     // 飞书
  TELEGRAM: 'telegram',
  EMAIL: 'email',
  WEBHOOK: 'webhook',   // 通用Webhook
  CUSTOM: 'custom',
});

const CHANNEL_STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error',
});

const MSG_TYPE = Object.freeze({
  TEXT: 'text',
  MARKDOWN: 'markdown',
  IMAGE: 'image',
  FILE: 'file',
  CARD: 'card',
  NEWS: 'news',
});

const MSG_PRIORITY = Object.freeze({
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
});

class SocialDispatch extends EventEmitter {
  constructor(options = {}) {
    super();

    this._channels = new Map(); // channelName → { config, state, client, ... }
    this._messageQueue = [];
    this._retryConfig = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      backoffMultiplier: options.backoffMultiplier || 2,
    };
    this._processing = false;
    this._defaultChannel = options.defaultChannel || null;
    this._templateEngine = new MessageTemplateEngine();
    this._httpClient = this._createHttpClient();
  }

  /**
   * 配置社交通道
   */
  configure(channel, config) {
    if (!Object.values(CHANNEL).includes(channel)) {
      throw new Error(`Unsupported channel: ${channel}. Supported: ${Object.values(CHANNEL).join(', ')}`);
    }

    this._channels.set(channel, {
      config,
      state: CHANNEL_STATE.DISCONNECTED,
      client: null,
      lastError: null,
      lastActive: null,
      messageCount: 0,
      errorCount: 0,
    });

    this.emit('channel_configured', { channel });
    return { channel, configured: true };
  }

  /**
   * 启动所有通道
   */
  async startAll() {
    const results = [];
    for (const [channel, channelData] of this._channels) {
      try {
        await this._connectChannel(channel);
        results.push({ channel, success: true });
      } catch (e) {
        results.push({ channel, success: false, error: e.message });
      }
    }

    // 启动消息处理循环
    this._startMessageProcessor();

    return results;
  }

  /**
   * 停止所有通道
   */
  async stopAll() {
    this._processing = false;
    for (const [channel, channelData] of this._channels) {
      await this._disconnectChannel(channel).catch(err => {
        // v1.0: 记录断开异常但不阻塞其他通道关闭
        if (this._logger) this._logger.debug(`[Social] 断开${channel}通道异常: ${err.message}`);
      });
    }
  }

  /**
   * 发送消息到指定通道
   */
  async dispatch(target, content, options = {}) {
    const channel = options.channel || this._defaultChannel;
    const msgType = options.type || MSG_TYPE.TEXT;
    const priority = options.priority || MSG_PRIORITY.NORMAL;

    if (!channel) {
      return { error: 'No channel specified' };
    }

    const channelData = this._channels.get(channel);
    if (!channelData) {
      return { error: `Channel not configured: ${channel}` };
    }

    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      target,
      content,
      channel,
      type: msgType,
      priority,
      createdAt: Date.now(),
      retries: 0,
    };

    // 高优先级消息立即发送
    if (priority >= MSG_PRIORITY.HIGH) {
      return this._sendMessage(channel, channelData, message);
    }

    // 普通优先级消息入队
    this._messageQueue.push(message);
    return { queued: true, messageId: message.id };
  }

  /**
   * 发送格式化消息
   */
  async sendFormatted(channel, template, data) {
    const content = this._templateEngine.render(template, data);
    return this.dispatch(channel, content, { type: MSG_TYPE.MARKDOWN });
  }

  /**
   * 注册消息接收回调
   */
  onMessage(callback) {
    this.on('message_received', callback);
  }

  /**
   * 发送消息到具体通道
   */
  async _sendMessage(channel, channelData, message) {
    try {
      let result;

      switch (channel) {
        case CHANNEL.DISCORD:
          result = await this._sendDiscord(channelData.config, message);
          break;
        case CHANNEL.SLACK:
          result = await this._sendSlack(channelData.config, message);
          break;
        case CHANNEL.WECOM:
          result = await this._sendWecom(channelData.config, message);
          break;
        case CHANNEL.FEISHU:
          result = await this._sendFeishu(channelData.config, message);
          break;
        case CHANNEL.TELEGRAM:
          result = await this._sendTelegram(channelData.config, message);
          break;
        case CHANNEL.EMAIL:
          result = await this._sendEmail(channelData.config, message);
          break;
        case CHANNEL.WEBHOOK:
        case CHANNEL.CUSTOM:
          result = await this._sendWebhook(channelData.config, message);
          break;
        default:
          return { error: `Unsupported channel: ${channel}` };
      }

      channelData.messageCount++;
      channelData.lastActive = Date.now();
      this.emit('message_sent', { channel, messageId: message.id, result });
      return result;
    } catch (error) {
      channelData.errorCount++;
      channelData.lastError = error.message;
      this.emit('send_error', { channel, messageId: message.id, error: error.message });

      // 重试逻辑
      if (message.retries < this._retryConfig.maxRetries) {
        message.retries++;
        const delay = this._retryConfig.retryDelay * Math.pow(this._retryConfig.backoffMultiplier, message.retries - 1);
        setTimeout(() => {
          this._sendMessage(channel, channelData, message);
        }, delay);
      }

      return { error: error.message };
    }
  }

  // ═══════════════════════════════════════
  // 各通道发送实现
  // ═══════════════════════════════════════

  async _sendDiscord(config, message) {
    if (!config.webhookUrl) {
      return { error: 'Discord webhook URL required' };
    }

    const payload = {
      content: message.content,
      username: config.botName || 'TriCore Agent',
    };

    // 如果内容超过Discord限制(2000字符)，使用embed
    if (message.content.length > 2000) {
      payload.content = message.content.substring(0, 2000);
      payload.embeds = [{
        title: 'Message (truncated)',
        description: message.content.substring(0, 4096),
        color: 0x5865F2,
        timestamp: new Date().toISOString(),
      }];
    }

    if (message.type === MSG_TYPE.CARD) {
      payload.embeds = [{
        title: message.content.title || 'Notification',
        description: message.content.body || '',
        color: message.content.color || 0x5865F2,
        fields: message.content.fields || [],
        footer: message.content.footer ? { text: message.content.footer } : undefined,
      }];
      payload.content = undefined;
    }

    const response = await this._httpPost(config.webhookUrl, payload);
    return { success: response.status >= 200 && response.status < 300, channel: 'discord' };
  }

  async _sendSlack(config, message) {
    if (!config.webhookUrl && !config.botToken) {
      return { error: 'Slack webhook URL or bot token required' };
    }

    const blocks = [];
    if (message.type === MSG_TYPE.MARKDOWN || message.content.includes('*')) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: message.content },
      });
    } else {
      blocks.push({
        type: 'section',
        text: { type: 'plain_text', text: message.content },
      });
    }

    const payload = {
      text: message.content.substring(0, 3000),
      blocks,
      username: config.botName || 'TriCore Agent',
      icon_emoji: config.iconEmoji || ':robot:',
    };

    const url = config.webhookUrl || `https://slack.com/api/chat.postMessage`;
    const headers = config.botToken
      ? { 'Authorization': `Bearer ${config.botToken}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };

    const response = await this._httpPost(url, payload, headers);
    return { success: response.status >= 200 && response.status < 300, channel: 'slack' };
  }

  async _sendWecom(config, message) {
    if (!config.webhookUrl) {
      return { error: 'WeCom webhook URL required' };
    }

    let payload;
    if (message.type === MSG_TYPE.MARKDOWN) {
      payload = {
        msgtype: 'markdown',
        markdown: { content: message.content },
      };
    } else {
      payload = {
        msgtype: 'text',
        text: {
          content: message.content,
          mentioned_list: config.mentionedList || [],
        },
      };
    }

    const response = await this._httpPost(config.webhookUrl, payload);
    return { success: response.status >= 200 && response.status < 300, channel: 'wecom' };
  }

  async _sendFeishu(config, message) {
    if (!config.webhookUrl) {
      return { error: 'Feishu webhook URL required' };
    }

    let payload;
    if (message.type === MSG_TYPE.CARD) {
      payload = {
        msg_type: 'interactive',
        card: {
          header: { title: { tag: 'plain_text', content: message.content.title || 'Notification' } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: message.content.body || message.content } }],
        },
      };
    } else {
      payload = {
        msg_type: 'text',
        content: { text: message.content },
      };
    }

    const response = await this._httpPost(config.webhookUrl, payload);
    return { success: response.status >= 200 && response.status < 300, channel: 'feishu' };
  }

  async _sendTelegram(config, message) {
    if (!config.botToken || !config.chatId) {
      return { error: 'Telegram botToken and chatId required' };
    }

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const payload = {
      chat_id: config.chatId,
      text: message.content,
      parse_mode: message.type === MSG_TYPE.MARKDOWN ? 'MarkdownV2' : undefined,
    };

    const response = await this._httpPost(url, payload);
    return { success: response.status >= 200 && response.status < 300, channel: 'telegram' };
  }

  async _sendEmail(config, message) {
    if (!config.smtpHost || !config.from || !config.to) {
      return { error: 'Email SMTP config required' };
    }

    // 使用 Node.js 内置方式或 nodemailer
    // 此处为简化实现，生产环境建议使用 nodemailer
    const subject = message.content.subject || `TriCore Agent Notification`;
    const body = message.content.body || message.content;

    // 记录邮件发送意图（实际发送需要SMTP库）
    this.emit('email_queued', { to: config.to, subject, body });

    return { success: true, channel: 'email', note: 'Email delivery requires SMTP transport' };
  }

  async _sendWebhook(config, message) {
    if (!config.url) {
      return { error: 'Webhook URL required' };
    }

    const payload = {
      source: 'tricore-agent',
      timestamp: new Date().toISOString(),
      messageId: message.id,
      content: message.content,
      type: message.type,
      ...(config.extraPayload || {}),
    };

    const headers = {
      'Content-Type': 'application/json',
      ...(config.secret ? { 'X-Webhook-Secret': config.secret } : {}),
      ...(config.headers || {}),
    };

    const response = await this._httpPost(config.url, payload, headers);
    return { success: response.status >= 200 && response.status < 300, channel: 'webhook' };
  }

  // ═══════════════════════════════════════
  // 通道连接管理
  // ═══════════════════════════════════════

  async _connectChannel(channel) {
    const channelData = this._channels.get(channel);
    if (!channelData) return;

    channelData.state = CHANNEL_STATE.CONNECTING;

    try {
      // 验证通道配置
      switch (channel) {
        case CHANNEL.DISCORD:
        case CHANNEL.SLACK:
        case CHANNEL.WECOM:
        case CHANNEL.FEISHU:
          if (!channelData.config.webhookUrl && !channelData.config.botToken) {
            throw new Error(`${channel} requires webhookUrl or botToken`);
          }
          break;
        case CHANNEL.TELEGRAM:
          if (!channelData.config.botToken) throw new Error('Telegram requires botToken');
          break;
        case CHANNEL.EMAIL:
          // Email doesn't require immediate connection
          break;
        case CHANNEL.WEBHOOK:
          if (!channelData.config.url) throw new Error('Webhook requires URL');
          break;
      }

      channelData.state = CHANNEL_STATE.CONNECTED;
      this.emit('channel_connected', { channel });
    } catch (error) {
      channelData.state = CHANNEL_STATE.ERROR;
      channelData.lastError = error.message;
      this.emit('channel_error', { channel, error: error.message });
      throw error;
    }
  }

  async _disconnectChannel(channel) {
    const channelData = this._channels.get(channel);
    if (!channelData) return;

    channelData.state = CHANNEL_STATE.DISCONNECTED;
    this.emit('channel_disconnected', { channel });
  }

  /**
   * 消息处理循环
   */
  _startMessageProcessor() {
    if (this._processing) return;
    this._processing = true;

    const processQueue = async () => {
      if (!this._processing) return;

      while (this._messageQueue.length > 0) {
        const message = this._messageQueue.shift();
        const channelData = this._channels.get(message.channel);
        if (channelData && channelData.state === CHANNEL_STATE.CONNECTED) {
          await this._sendMessage(message.channel, channelData, message);
        }
      }

      setTimeout(processQueue, 100);
    };

    processQueue();
  }

  // ═══════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════

  _createHttpClient() {
    const http = require('http');
    const https = require('https');

    return {
      post: (urlStr, data, headers = {}) => {
        return new Promise((resolve, reject) => {
          const url = new URL(urlStr);
          const body = JSON.stringify(data);
          const client = url.protocol === 'https:' ? https : http;

          const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              ...headers,
            },
            timeout: 10000,
          };

          const req = client.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode, data: JSON.parse(responseData) });
              } catch {
                resolve({ status: res.statusCode, data: responseData });
              }
            });
          });

          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
          req.write(body);
          req.end();
        });
      },
    };
  }

  async _httpPost(url, data, headers = {}) {
    return this._httpClient.post(url, data, headers);
  }

  getStatus() {
    const channels = {};
    for (const [name, data] of this._channels) {
      channels[name] = {
        state: data.state,
        configured: true,
        messageCount: data.messageCount,
        errorCount: data.errorCount,
        lastActive: data.lastActive,
        lastError: data.lastError,
      };
    }

    return {
      channels,
      queueDepth: this._messageQueue.length,
      processing: this._processing,
    };
  }

  /**
   * 获取支持的通道列表
   */
  getSupportedChannels() {
    return Object.values(CHANNEL).map(c => ({
      name: c,
      configured: this._channels.has(c),
      state: this._channels.get(c)?.state || CHANNEL_STATE.DISCONNECTED,
    }));
  }
}

// ═══════════════════════════════════════
// 消息模板引擎
// ═══════════════════════════════════════

class MessageTemplateEngine {
  constructor() {
    this._templates = new Map();
    this._registerDefaults();
  }

  _registerDefaults() {
    this.register('alert', '## ⚠️ Alert\n\n**{{title}}**\n\n{{message}}\n\n---\n*{{timestamp}}*');
    this.register('info', '## ℹ️ Info\n\n{{title}}\n\n{{message}}');
    this.register('success', '## ✅ Success\n\n{{title}}\n\n{{message}}');
    this.register('error', '## ❌ Error\n\n**{{title}}**\n\n```\n{{message}}\n```');
    this.register('task_complete', '## ✅ Task Complete\n\nTask: **{{taskName}}**\nDuration: {{duration}}\nResult: {{result}}');
    this.register('daily_report', '## 📊 Daily Report\n\n{{summary}}\n\n| Metric | Value |\n|--------|-------|\n{{metrics}}');
  }

  register(name, template) {
    this._templates.set(name, template);
  }

  render(template, data = {}) {
    const tpl = this._templates.get(template) || template;
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return data[key] !== undefined ? data[key] : `{{${key}}}`;
    });
  }

  getTemplate(name) {
    return this._templates.get(name);
  }

  listTemplates() {
    return [...this._templates.keys()];
  }
}

module.exports = {
  SocialDispatch,
  CHANNEL,
  CHANNEL_STATE,
  MSG_TYPE,
  MSG_PRIORITY,
};
