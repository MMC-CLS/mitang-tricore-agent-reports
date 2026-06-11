/**
 * TriCore Agent — TTS 引擎 (Text-to-Speech)
 *
 * 语音合成引擎：将文字转换为语音。
 *
 * Provider 策略（按优先级）：
 *   1. OpenAI TTS API（主要方案，需 OPENAI_API_KEY）
 *   2. Edge TTS（免费降级方案，无需 API Key）
 *   3. 无 Provider（返回明确错误提示，非 501）
 *
 * 支持的声音：
 *   OpenAI: alloy, echo, fable, nova, onyx, shimmer
 *   Edge: zh-CN-XiaoxiaoNeural, zh-CN-YunxiNeural, en-US-JennyNeural, etc.
 *
 * 支持的输出格式：mp3, opus, aac, flac, wav, pcm
 *
 * 用法：
 *   const engine = new TtsEngine({ apiKey: 'sk-...' });
 *   const result = await engine.synthesize('你好世界', { voice: 'alloy' });
 *   // result.audioBuffer → Buffer
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// ── 声音定义 ──
const VOICES = Object.freeze({
  // OpenAI 声音
  ALLOY: 'alloy',
  ECHO: 'echo',
  FABLE: 'fable',
  NOVA: 'nova',
  ONYX: 'onyx',
  SHIMMER: 'shimmer',
  // Edge TTS 中文声音
  ZH_CN_XIAOXIAO: 'zh-CN-XiaoxiaoNeural',
  ZH_CN_YUNXI: 'zh-CN-YunxiNeural',
  ZH_CN_YUNJIAN: 'zh-CN-YunjianNeural',
  ZH_CN_XIAOYI: 'zh-CN-XiaoyiNeural',
  ZH_CN_YUNYANG: 'zh-CN-YunyangNeural',
  // Edge TTS 英文声音
  EN_US_JENNY: 'en-US-JennyNeural',
  EN_US_GUY: 'en-US-GuyNeural',
  EN_US_ARIA: 'en-US-AriaNeural',
});

// ── TTS 模型 ──
const MODELS = Object.freeze({
  TTS_1: 'tts-1',       // 标准质量，低延迟
  TTS_1_HD: 'tts-1-hd', // 高清质量
});

// ── 输出格式 ──
const OUTPUT_FORMATS = Object.freeze({
  MP3: 'mp3',
  OPUS: 'opus',
  AAC: 'aac',
  FLAC: 'flac',
  WAV: 'wav',
  PCM: 'pcm',
});

// ── 最大文本长度 ──
const MAX_TEXT_LENGTH = 4096;

class TtsEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this._apiKey = options.apiKey || process.env.OPENAI_API_KEY || null;
    this._model = options.model || MODELS.TTS_1;
    this._defaultVoice = options.voice || VOICES.ALLOY;
    this._defaultSpeed = options.speed || 1.0;
    this._defaultFormat = options.format || OUTPUT_FORMATS.MP3;
    this._logger = options.logger || null;
    this._timeout = options.timeout || 60000;
    this._outputDir = options.outputDir || null;

    this._stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalChars: 0,
    };
  }

  /**
   * 文字转语音
   * @param {string} text - 要合成的文本
   * @param {Object} options
   * @param {string} options.voice - 声音名称
   * @param {string} options.model - TTS 模型 (tts-1 | tts-1-hd)
   * @param {number} options.speed - 语速 (0.25 ~ 4.0)
   * @param {string} options.format - 输出格式 (mp3 | opus | aac | flac | wav | pcm)
   * @param {string} options.outputPath - 输出文件路径（可选，默认返回 Buffer）
   * @returns {Promise<{ audioBuffer: Buffer, format: string, outputPath: string|null, textLength: number }>}
   */
  async synthesize(text, options = {}) {
    this._stats.totalRequests++;

    // ── 输入验证 ──
    if (!text || String(text).trim().length === 0) {
      const err = new Error('Text is required for TTS');
      this._stats.failedRequests++;
      throw err;
    }

    text = String(text).trim();

    if (text.length > MAX_TEXT_LENGTH) {
      const err = new Error(`Text too long: ${text.length} chars (max ${MAX_TEXT_LENGTH})`);
      this._stats.failedRequests++;
      throw err;
    }

    const voice = options.voice || this._defaultVoice;
    const model = options.model || this._model;
    const speed = Math.max(0.25, Math.min(4.0, options.speed || this._defaultSpeed));
    const format = options.format || this._defaultFormat;

    // 格式验证
    if (!Object.values(OUTPUT_FORMATS).includes(format)) {
      const err = new Error(`Unsupported output format: "${format}". Supported: ${Object.values(OUTPUT_FORMATS).join(', ')}`);
      this._stats.failedRequests++;
      throw err;
    }

    const startTime = Date.now();

    // ── 判断使用哪个 Provider ──
    const isOpenAIVoice = Object.values(VOICES).slice(0, 6).includes(voice);
    const useOpenAI = this._apiKey && isOpenAIVoice;

    let result;
    let providerUsed;

    // ── 策略 1: OpenAI TTS ──
    if (useOpenAI) {
      try {
        result = await this._synthesizeViaOpenAI(text, { model, voice, speed, format });
        providerUsed = 'openai_tts';
      } catch (err) {
        this._log('warn', `OpenAI TTS failed: ${err.message}. Trying Edge TTS fallback...`);
        // 降级到 Edge TTS
        try {
          result = await this._synthesizeViaEdge(text, { voice: VOICES.ZH_CN_XIAOXIAO, speed, format });
          providerUsed = 'edge_tts';
        } catch (edgeErr) {
          this._stats.failedRequests++;
          throw new Error(`TTS failed: OpenAI error (${err.message}), Edge TTS also failed (${edgeErr.message})`);
        }
      }
    } else {
      // ── 策略 2: Edge TTS（免费降级） ──
      try {
        result = await this._synthesizeViaEdge(text, {
          voice: isOpenAIVoice ? VOICES.ZH_CN_XIAOXIAO : voice,
          speed,
          format,
        });
        providerUsed = 'edge_tts';
      } catch (edgeErr) {
        this._stats.failedRequests++;

        if (!this._apiKey) {
          throw new Error(
            'TTS is not available: No API key configured and Edge TTS is unreachable. ' +
            'Set the OPENAI_API_KEY environment variable to enable OpenAI TTS, ' +
            'or ensure network access to Microsoft Edge TTS service.'
          );
        }

        throw new Error(`TTS failed with all available providers: ${edgeErr.message}`);
      }
    }

    // ── 保存到文件（可选） ──
    let outputPath = options.outputPath || null;
    if (this._outputDir && !outputPath) {
      const filename = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${format}`;
      outputPath = path.join(this._outputDir, filename);
    }
    if (outputPath) {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, result.audioBuffer);
    }

    this._stats.successfulRequests++;
    this._stats.totalChars += text.length;

    const elapsed = Date.now() - startTime;
    this._log('info', `TTS via ${providerUsed}: "${text.substring(0, 50)}..." → ${format} (${elapsed}ms)`);
    this.emit('synthesis:complete', { text: text.substring(0, 100), provider: providerUsed, elapsed });

    return {
      audioBuffer: result.audioBuffer,
      format,
      outputPath,
      textLength: text.length,
      provider: providerUsed,
      elapsed,
    };
  }

  /**
   * 检查 TTS 是否可用
   */
  isAvailable() {
    if (this._apiKey) return { available: true, provider: 'openai_tts' };
    return {
      available: true,
      provider: 'edge_tts',
      note: 'Using free Edge TTS (no API key required). For higher quality, set OPENAI_API_KEY.',
    };
  }

  /**
   * 获取所有可用声音
   */
  getVoices() {
    return Object.entries(VOICES).map(([key, value]) => ({
      id: value,
      name: key.toLowerCase().replace(/_/g, ' '),
      provider: Object.values(VOICES).slice(0, 6).includes(value) ? 'openai' : 'edge',
    }));
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this._stats };
  }

  // ═══════════════════════════════════════
  // Provider 实现
  // ═══════════════════════════════════════

  async _synthesizeViaOpenAI(text, { model, voice, speed, format }) {
    if (!this._apiKey) {
      throw new Error('OpenAI API key required for TTS');
    }

    const response = await this._httpRequest(
      'https://api.openai.com/v1/audio/speech',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          speed,
          response_format: format,
        }),
      },
      true // binary response
    );

    if (response.status !== 200) {
      const errorText = Buffer.isBuffer(response.data)
        ? response.data.toString('utf-8')
        : String(response.data || 'Unknown error');
      throw new Error(`OpenAI TTS API error (${response.status}): ${errorText}`);
    }

    return { audioBuffer: Buffer.from(response.data) };
  }

  async _synthesizeViaEdge(text, { voice, speed, format }) {
    // Edge TTS 使用 SSML 格式
    // Microsoft Edge TTS 免费端点
    const ssml = this._buildSSML(text, voice, speed);

    // Edge TTS 输出格式映射
    const formatMap = {
      mp3: 'audio-24khz-96kbitrate-mono-mp3',
      opus: 'audio-24khz-48kbitrate-mono-opus',
      aac: 'audio-24khz-96kbitrate-mono-aac',
      flac: 'audio-24khz-96kbitrate-mono-flac',
      wav: 'riff-24khz-16bit-mono-pcm',
      pcm: 'raw-24khz-16bit-mono-pcm',
    };

    const outputFormat = formatMap[format] || formatMap.mp3;

    const response = await this._httpRequest(
      'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': outputFormat,
          'User-Agent': 'TriCoreAgent/2.0.0',
        },
        body: ssml,
      },
      true
    );

    if (response.status !== 200) {
      const errorText = Buffer.isBuffer(response.data)
        ? response.data.toString('utf-8').substring(0, 200)
        : `HTTP ${response.status}`;
      throw new Error(`Edge TTS error: ${errorText}`);
    }

    return { audioBuffer: Buffer.from(response.data) };
  }

  _buildSSML(text, voice, speed) {
    // 转义 XML 特殊字符
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    // 计算 prosody rate
    let rate;
    if (speed === 1.0) {
      rate = '+0%';
    } else if (speed > 1.0) {
      rate = `+${Math.round((speed - 1) * 100)}%`;
    } else {
      rate = `-${Math.round((1 - speed) * 100)}%`;
    }

    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="zh-CN">
  <voice name="${voice}">
    <prosody rate="${rate}">
      ${escaped}
    </prosody>
  </voice>
</speak>`;
  }

  // ═══════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════

  _httpRequest(url, options, binaryResponse = false) {
    const http = require('http');
    const https = require('https');

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;

      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'POST',
        headers: options.headers || {},
        timeout: this._timeout,
      };

      const req = client.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          if (binaryResponse) {
            resolve({ status: res.statusCode, data });
          } else {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(data.toString()) });
            } catch {
              resolve({ status: res.statusCode, data: { raw: data.toString() } });
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      if (options.body) req.write(options.body);
      req.end();
    });
  }

  _log(level, message) {
    if (this._logger) {
      this._logger[level](`[TtsEngine] ${message}`, { module: 'tts-engine' });
    }
  }
}

module.exports = { TtsEngine, VOICES, MODELS, OUTPUT_FORMATS };
