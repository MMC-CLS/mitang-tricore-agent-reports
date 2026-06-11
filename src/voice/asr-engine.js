/**
 * TriCore Agent — ASR 引擎 (Automatic Speech Recognition)
 *
 * 语音识别引擎：将音频转换为文字。
 *
 * Provider 策略（按优先级）：
 *   1. OpenAI Whisper API（主要方案，需 OPENAI_API_KEY）
 *   2. 本地 Whisper CLI（降级方案，需安装 whisper 命令）
 *   3. 无 Provider（返回明确错误提示，非 501）
 *
 * 支持的音频格式：wav, mp3, m4a, webm, ogg, flac
 *
 * 用法：
 *   const engine = new AsrEngine({ apiKey: 'sk-...' });
 *   const result = await engine.transcribe(audioBuffer, { format: 'mp3' });
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// ── 支持的音频 MIME 类型 ──
const SUPPORTED_FORMATS = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

// ── 最大音频大小（25MB，OpenAI API 限制） ──
const MAX_AUDIO_SIZE = 25 * 1024 * 1024;

class AsrEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this._apiKey = options.apiKey || process.env.OPENAI_API_KEY || null;
    this._model = options.model || 'whisper-1';
    this._language = options.language || null; // null = auto-detect
    this._logger = options.logger || null;
    this._timeout = options.timeout || 120000; // 2分钟超时

    this._stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalAudioDuration: 0,
    };
  }

  /**
   * 语音转文字
   * @param {Buffer|string} input - 音频 Buffer 或文件路径
   * @param {Object} options
   * @param {string} options.format - 音频格式 (wav, mp3, m4a, webm, ogg, flac)
   * @param {string} options.language - 语言代码 (zh, en, ja, etc.)，不传则自动检测
   * @param {string} options.prompt - 引导词（提升特定词汇识别准确率）
   * @returns {Promise<{ text: string, language: string, confidence: number, duration: number }>}
   */
  async transcribe(input, options = {}) {
    this._stats.totalRequests++;

    const format = options.format || this._detectFormat(input);
    const language = options.language || this._language;
    const prompt = options.prompt || '';

    // ── 输入验证 ──
    let audioBuffer;
    if (Buffer.isBuffer(input)) {
      audioBuffer = input;
    } else if (typeof input === 'string') {
      if (!fs.existsSync(input)) {
        const err = new Error(`Audio file not found: ${input}`);
        this._stats.failedRequests++;
        throw err;
      }
      audioBuffer = fs.readFileSync(input);
    } else {
      const err = new Error('Invalid input: must be Buffer or file path');
      this._stats.failedRequests++;
      throw err;
    }

    // 大小检查
    if (audioBuffer.length > MAX_AUDIO_SIZE) {
      const err = new Error(`Audio too large: ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB (max 25MB)`);
      this._stats.failedRequests++;
      throw err;
    }

    // 空音频检查
    if (audioBuffer.length === 0) {
      const err = new Error('Audio buffer is empty');
      this._stats.failedRequests++;
      throw err;
    }

    // 格式验证
    const mimeType = SUPPORTED_FORMATS[format];
    if (!mimeType) {
      const err = new Error(`Unsupported format: "${format}". Supported: ${Object.keys(SUPPORTED_FORMATS).join(', ')}`);
      this._stats.failedRequests++;
      throw err;
    }

    const startTime = Date.now();

    // ── 策略 1: OpenAI Whisper API ──
    if (this._apiKey) {
      try {
        const result = await this._transcribeViaOpenAI(audioBuffer, format, mimeType, language, prompt);
        this._stats.successfulRequests++;
        this._stats.totalAudioDuration += result.duration || 0;
        this._log('info', `ASR via OpenAI: "${result.text?.substring(0, 50)}..." (${result.language}, ${Date.now() - startTime}ms)`);
        this.emit('transcription:complete', { text: result.text, language: result.language });
        return result;
      } catch (err) {
        this._log('warn', `OpenAI ASR failed: ${err.message}. Trying local fallback...`);
      }
    }

    // ── 策略 2: 本地 Whisper CLI ──
    try {
      const result = await this._transcribeViaLocalWhisper(audioBuffer, format, language);
      this._stats.successfulRequests++;
      this._stats.totalAudioDuration += result.duration || 0;
      this._log('info', `ASR via local Whisper: "${result.text?.substring(0, 50)}..." (${Date.now() - startTime}ms)`);
      this.emit('transcription:complete', { text: result.text, language: result.language });
      return result;
    } catch (localErr) {
      this._stats.failedRequests++;
      this._log('error', `Local Whisper also failed: ${localErr.message}`);
    }

    // ── 无可用 Provider ──
    if (!this._apiKey) {
      throw new Error(
        'ASR is not available: No API key configured. ' +
        'Set the OPENAI_API_KEY environment variable to enable OpenAI Whisper, ' +
        'or install the "whisper" CLI for local recognition.'
      );
    }

    throw new Error(
      'ASR failed with all available providers. ' +
      'Check your network connection and API key, or install local whisper for offline use.'
    );
  }

  /**
   * 检查 ASR 是否可用
   */
  isAvailable() {
    if (this._apiKey) return { available: true, provider: 'openai_whisper' };
    if (this._isWhisperCliAvailable()) return { available: true, provider: 'local_whisper' };
    return {
      available: false,
      reason: 'No API key configured and local whisper not found. Set OPENAI_API_KEY or install whisper CLI.',
      instructions: this._apiKey
        ? null
        : 'export OPENAI_API_KEY="sk-..."  # 或安装: pip install openai-whisper',
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this._stats, provider: this._apiKey ? 'openai_whisper' : 'local_whisper' };
  }

  // ═══════════════════════════════════════
  // Provider 实现
  // ═══════════════════════════════════════

  async _transcribeViaOpenAI(audioBuffer, format, mimeType, language, prompt) {
    const FormData = this._buildFormData();
    const form = new FormData();
    form.append('file', audioBuffer, {
      filename: `audio.${format}`,
      contentType: mimeType,
    });
    form.append('model', this._model);
    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt);
    form.append('response_format', 'verbose_json');

    const response = await this._httpRequest(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          ...form.getHeaders(),
        },
        body: form.getBuffer(),
      }
    );

    if (response.status !== 200) {
      const errorMsg = response.data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`OpenAI Whisper API error: ${errorMsg}`);
    }

    const segments = response.data.segments || [];
    const avgConfidence = segments.length > 0
      ? segments.reduce((sum, s) => sum + (s.confidence || 0), 0) / segments.length
      : null;

    return {
      text: response.data.text || '',
      language: response.data.language || language || 'unknown',
      confidence: avgConfidence,
      segments,
      duration: response.data.duration || 0,
    };
  }

  async _transcribeViaLocalWhisper(audioBuffer, format, language) {
    const { execSync } = require('child_process');
    const tmpDir = require('os').tmpdir();
    const tempPath = path.join(tmpDir, `tricore_asr_${Date.now()}.${format}`);

    try {
      fs.writeFileSync(tempPath, audioBuffer);

      const cmd = [
        'whisper',
        `"${tempPath}"`,
        `--model ${this._model === 'whisper-1' ? 'base' : this._model.replace('whisper-', '')}`,
        '--output_format json',
        language ? `--language ${language}` : '',
      ].filter(Boolean).join(' ');

      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: this._timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      const result = JSON.parse(output);
      return {
        text: result.text || '',
        language: result.language || language || 'unknown',
        confidence: null,
        segments: result.segments || [],
        duration: result.segments
          ? result.segments.reduce((sum, s) => sum + ((s.end || 0) - (s.start || 0)), 0)
          : 0,
      };
    } catch (e) {
      throw new Error(`Local Whisper failed: ${e.message}. Ensure "whisper" CLI is installed (pip install openai-whisper).`);
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  _isWhisperCliAvailable() {
    try {
      require('child_process').execSync('which whisper || where whisper 2>/dev/null', {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════

  _detectFormat(input) {
    if (typeof input === 'string') {
      const ext = path.extname(input).replace('.', '').toLowerCase();
      if (SUPPORTED_FORMATS[ext]) return ext;
    }
    return 'wav'; // 默认
  }

  _buildFormData() {
    try {
      return require('form-data');
    } catch {
      // 内联简易 FormData
      const boundary = '----TricoreFormBoundary' + Math.random().toString(36).slice(2);
      return class SimpleFormData {
        constructor() {
          this._boundary = boundary;
          this._fields = [];
        }
        append(name, value, options = {}) {
          this._fields.push({ name, value, options });
        }
        getHeaders() {
          return { 'Content-Type': `multipart/form-data; boundary=${this._boundary}` };
        }
        getBuffer() {
          const parts = [];
          for (const f of this._fields) {
            parts.push(Buffer.from(`--${this._boundary}\r\n`));
            if (f.options.filename) {
              parts.push(Buffer.from(
                `Content-Disposition: form-data; name="${f.name}"; filename="${f.options.filename}"\r\n` +
                `Content-Type: ${f.options.contentType || 'application/octet-stream'}\r\n\r\n`
              ));
              parts.push(Buffer.isBuffer(f.value) ? f.value : Buffer.from(String(f.value)));
            } else {
              parts.push(Buffer.from(`Content-Disposition: form-data; name="${f.name}"\r\n\r\n`));
              parts.push(Buffer.from(String(f.value)));
            }
            parts.push(Buffer.from('\r\n'));
          }
          parts.push(Buffer.from(`--${this._boundary}--\r\n`));
          return Buffer.concat(parts);
        }
      };
    }
  }

  _httpRequest(url, options) {
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
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data.toString()) });
          } catch {
            resolve({ status: res.statusCode, data: { text: data.toString() } });
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
      this._logger[level](`[AsrEngine] ${message}`, { module: 'asr-engine' });
    }
  }
}

module.exports = { AsrEngine, SUPPORTED_FORMATS };
