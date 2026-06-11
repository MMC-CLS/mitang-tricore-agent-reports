/**
 * 语音和浏览器路由 — POST /voice/asr, POST /voice/tts, POST /browser/navigate
 *
 * v2.0: ASR/TTS 端点现在调用真实引擎（AsrEngine / TtsEngine）
 *       不再返回 501。无 API Key 时返回明确提示。
 */
'use strict';

const { AsrEngine } = require('../../voice/asr-engine');
const { TtsEngine } = require('../../voice/tts-engine');

function registerRoutes(server) {
  // ── ASR: 语音识别 ──
  server._addRoute('POST /voice/asr', async function(req, res) {
    try {
      // 获取 agent 上的 ASR 引擎（如果已初始化）
      let engine = this._agent?._asrEngine || null;

      // 延迟初始化：如果还没有引擎，创建一个
      if (!engine) {
        const apiKey = process.env.OPENAI_API_KEY || this._agent?._config?.apiKey || null;
        engine = new AsrEngine({
          apiKey,
          logger: this._agent?._logger || null,
        });

        // 缓存到 agent 上
        if (this._agent) {
          this._agent._asrEngine = engine;
        }
      }

      // 检查可用性
      const availability = engine.isAvailable();
      if (!availability.available) {
        this._sendJson(res, 503, {
          error: 'ASR service is not available',
          detail: availability.reason,
          instructions: availability.instructions,
          code: 'ASR_UNAVAILABLE',
        });
        return;
      }

      // 读取音频数据
      const contentType = req.headers['content-type'] || '';
      let audioBuffer;
      let format = 'wav';

      if (contentType.includes('application/json')) {
        // JSON body: { audio: "base64...", format: "wav" }
        const body = await this._readBody(req);
        if (!body.audio) {
          this._sendJson(res, 400, { error: 'Missing "audio" field (base64-encoded)' });
          return;
        }
        audioBuffer = Buffer.from(body.audio, 'base64');
        format = body.format || 'wav';
      } else if (contentType.includes('multipart/form-data')) {
        // Multipart: parse the file upload manually
        const body = await this._readRawBody(req);
        const boundary = contentType.split('boundary=')[1];
        if (boundary) {
          const parsed = _parseMultipart(body, boundary);
          if (parsed.file) {
            audioBuffer = parsed.file.data;
            format = parsed.file.filename?.split('.').pop() || 'wav';
          } else {
            this._sendJson(res, 400, { error: 'No audio file found in multipart upload' });
            return;
          }
        } else {
          this._sendJson(res, 400, { error: 'Invalid multipart request' });
          return;
        }
      } else {
        // Raw binary body
        audioBuffer = await this._readRawBody(req);
        format = (req.headers['x-audio-format'] || 'wav').toLowerCase();
      }

      // 语言参数
      const url = new URL(req.url, `http://${req.headers.host}`);
      const language = url.searchParams.get('language') || null;

      // 执行识别
      const result = await engine.transcribe(audioBuffer, { format, language });

      this._sendJson(res, 200, {
        text: result.text,
        language: result.language,
        confidence: result.confidence,
        duration: result.duration,
        provider: availability.provider,
      });
    } catch (err) {
      const statusCode = err.message.includes('not found') ? 404
        : err.message.includes('too large') || err.message.includes('empty') ? 400
        : err.message.includes('not available') || err.message.includes('No API key') ? 503
        : 500;

      this._sendJson(res, statusCode, {
        error: 'ASR failed',
        detail: err.message,
        code: statusCode === 503 ? 'ASR_UNAVAILABLE'
          : statusCode === 400 ? 'ASR_INVALID_INPUT'
          : 'ASR_ERROR',
      });
    }
  });

  // ── TTS: 语音合成 ──
  server._addRoute('POST /voice/tts', async function(req, res) {
    try {
      const body = await this._readBody(req);
      const { text, voice, speed, format } = body;

      if (!text) {
        this._sendJson(res, 400, { error: 'text is required' });
        return;
      }

      // 获取或创建 TTS 引擎
      let engine = this._agent?._ttsEngine || null;

      if (!engine) {
        const apiKey = process.env.OPENAI_API_KEY || this._agent?._config?.apiKey || null;
        engine = new TtsEngine({
          apiKey,
          logger: this._agent?._logger || null,
          outputDir: this._agent?._dataDir
            ? require('path').join(this._agent._dataDir, 'audio')
            : null,
        });

        if (this._agent) {
          this._agent._ttsEngine = engine;
        }
      }

      // 检查可用性
      const availability = engine.isAvailable();
      if (!availability.available) {
        this._sendJson(res, 503, {
          error: 'TTS service is not available',
          detail: availability.reason,
          instructions: availability.instructions,
          code: 'TTS_UNAVAILABLE',
        });
        return;
      }

      // 执行合成
      const result = await engine.synthesize(text, { voice, speed, format });

      // 决定响应格式
      const returnFormat = format || 'mp3';
      const returnBinary = body.returnBinary === true || body.raw === true;

      if (returnBinary) {
        // 返回原始音频
        const mimeMap = { mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' };
        const contentType = mimeMap[returnFormat] || 'audio/mpeg';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': result.audioBuffer.length,
          'X-TTS-Provider': result.provider,
          'X-TTS-Text-Length': String(result.textLength),
        });
        res.end(result.audioBuffer);
      } else {
        // 返回 JSON + base64 音频
        this._sendJson(res, 200, {
          audio: result.audioBuffer.toString('base64'),
          format: result.format,
          textLength: result.textLength,
          provider: result.provider,
          elapsed: result.elapsed,
          outputPath: result.outputPath,
        });
      }
    } catch (err) {
      const statusCode = err.message.includes('required') ? 400
        : err.message.includes('too long') ? 400
        : err.message.includes('not available') || err.message.includes('No API key') ? 503
        : err.message.includes('Unsupported') ? 400
        : 500;

      this._sendJson(res, statusCode, {
        error: 'TTS failed',
        detail: err.message,
        code: statusCode === 503 ? 'TTS_UNAVAILABLE'
          : statusCode === 400 ? 'TTS_INVALID_INPUT'
          : 'TTS_ERROR',
      });
    }
  });

  // ── Browser ──
  server._addRoute('POST /browser/navigate', async function(req, res) {
    const body = await this._readBody(req);
    const { action, params } = body || {};

    if (!action) {
      this._sendJson(res, 400, { error: 'action is required', supported: ['navigate', 'screenshot', 'click', 'type', 'extract'] });
      return;
    }

    const browser = this._agent?._browserAutomation || this._agent?._browser;
    if (!browser) {
      this._sendJson(res, 503, { error: 'Browser automation engine not available', code: 'BROWSER_UNAVAILABLE' });
      return;
    }

    try {
      const actionMap = {
        navigate: 'navigate',
        screenshot: 'screenshot',
        click: 'click',
        type: 'type',
        extract: 'extract_text',
      };

      const mappedAction = actionMap[action];
      if (!mappedAction) {
        this._sendJson(res, 400, {
          error: `Unsupported action: ${action}`,
          supported: Object.keys(actionMap),
        });
        return;
      }

      const result = await browser.execute(mappedAction, params || {});
      this._sendJson(res, 200, { success: true, action, result });
    } catch (err) {
      this._sendJson(res, 500, { success: false, action, error: err.message });
    }
  });
}

// ── 工具函数：读取原始请求体 ──

/**
 * 读取原始请求体（不做 JSON 解析）
 */
async function _readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 简单 multipart 解析
 */
function _parseMultipart(buffer, boundary) {
  const result = { fields: {}, file: null };
  const str = buffer.toString('binary');
  const parts = str.split('--' + boundary);

  for (const part of parts) {
    if (part.includes('Content-Disposition')) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;

      const header = part.substring(0, headerEnd);
      const body = part.substring(headerEnd + 4);
      // 去除末尾的 \r\n
      const cleanBody = body.replace(/\r\n$/, '');

      const nameMatch = header.match(/name="([^"]+)"/);
      const filenameMatch = header.match(/filename="([^"]+)"/);

      if (nameMatch) {
        const name = nameMatch[1];
        if (filenameMatch) {
          result.file = {
            fieldName: name,
            filename: filenameMatch[1],
            data: Buffer.from(cleanBody, 'binary'),
          };
        } else {
          result.fields[name] = cleanBody;
        }
      }
    }
  }

  return result;
}

module.exports = { registerRoutes };
