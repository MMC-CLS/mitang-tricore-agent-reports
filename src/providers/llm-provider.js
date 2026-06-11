/**
 * TriCore Agent - LLM Provider 集成层
 *
 * Phase 21: 实际LLM Provider集成 - 提供统一的OpenAI兼容API调用接口
 *
 * 核心能力:
 *   1. 统一请求/响应格式 - 所有Provider统一为OpenAI兼容格式
 *   2. 自动重试与退避 - 指数退避 + Jitter
 *   3. 速率限制处理 - 429自动等待重试
 *   4. 流式支持 - 标准SSE流
 *   5. 请求日志 - 完整的请求/响应日志
 *   6. Token计数 - 自动统计Token使用
 */
'use strict';

const { EventEmitter } = require('events');

// ── 请求配置 ──
const DEFAULT_TIMEOUT = 60000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 1000;

class LLMProvider extends EventEmitter {
  constructor(config = {}) {
    super();

    this._apiKey = config.apiKey || '';
    this._baseURL = config.baseURL || '';
    this._model = config.model || '';
    this._timeout = config.timeout || DEFAULT_TIMEOUT;
    this._maxRetries = config.maxRetries || DEFAULT_MAX_RETRIES;
    this._baseDelay = config.baseDelay || DEFAULT_BASE_DELAY;

    // 统计
    this._stats = {
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      totalLatency: 0,
    };
  }

  /**
   * 非流式调用
   * @param {Object} params - { messages, tools?, temperature?, max_tokens?, response_format? }
   * @returns {Object} { content, toolCalls, usage, model, finishReason }
   */
  async chat(params) {
    const startTime = Date.now();
    this._stats.totalCalls++;

    const requestBody = {
      model: params.model || this._model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 4096,
    };

    if (params.tools && params.tools.length > 0) {
      requestBody.tools = params.tools;
    }

    if (params.response_format) {
      requestBody.response_format = params.response_format;
    }

    let lastError = null;

    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this._timeout);

        const response = await fetch(`${this._baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this._apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          const error = new Error(`HTTP ${response.status}: ${errorBody}`);

          // 429 Too Many Requests - 等待后重试
          if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '5');
            const delay = Math.max(retryAfter * 1000, this._baseDelay * Math.pow(2, attempt));
            this.emit('rate_limited', { delay, attempt });
            await this._sleep(delay);
            continue;
          }

          // 5xx 服务器错误 - 可重试
          if (response.status >= 500) {
            lastError = error;
            if (attempt < this._maxRetries) {
              const delay = this._baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
              await this._sleep(delay);
              continue;
            }
          }

          throw error;
        }

        const data = await response.json();

        if (!data.choices || data.choices.length === 0) {
          throw new Error('Empty response from LLM');
        }

        const choice = data.choices[0];
        const latency = Date.now() - startTime;

        // 更新统计
        this._stats.successCalls++;
        this._stats.totalLatency += latency;
        if (data.usage) {
          this._stats.totalTokens += data.usage.total_tokens || 0;
        }

        this.emit('call_complete', { latency, tokens: data.usage });

        return {
          content: choice.message?.content || '',
          toolCalls: choice.message?.tool_calls || [],
          usage: data.usage || {},
          model: data.model || requestBody.model,
          finishReason: choice.finish_reason || '',
          latency,
        };

      } catch (error) {
        lastError = error;

        // AbortError (timeout) - 可重试
        if (error.name === 'AbortError') {
          if (attempt < this._maxRetries) {
            const delay = this._baseDelay * Math.pow(2, attempt);
            await this._sleep(delay);
            continue;
          }
          throw new Error(`LLM request timed out after ${this._timeout}ms`);
        }

        // 网络错误 - 可重试
        if (error.cause?.code === 'ECONNREFUSED' || error.cause?.code === 'ENOTFOUND') {
          if (attempt < this._maxRetries) {
            const delay = this._baseDelay * Math.pow(2, attempt);
            await this._sleep(delay);
            continue;
          }
        }

        if (attempt >= this._maxRetries) {
          this._stats.failedCalls++;
          this.emit('call_error', { error: error.message, attempts: attempt + 1 });
          throw error;
        }
      }
    }

    this._stats.failedCalls++;
    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * 流式调用
   * @returns {AsyncGenerator}
   */
  async *streamChat(params) {
    const requestBody = {
      model: params.model || this._model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 4096,
      stream: true,
    };

    if (params.tools && params.tools.length > 0) {
      requestBody.tools = params.tools;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._timeout);

    try {
      const response = await fetch(`${this._baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield { type: 'done', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              yield { type: 'content', text: delta.content, done: false };
            }

            if (delta.tool_calls) {
              yield { type: 'tool_call', toolCalls: delta.tool_calls, done: false };
            }
          } catch {
            // 跳过无法解析的行
          }
        }
      }

      yield { type: 'done', done: true };
    } catch (error) {
      clearTimeout(timeoutId);
      yield { type: 'error', error: error.message, done: true };
    }
  }

  /**
   * 嵌入向量
   */
  async embed(text, model = 'text-embedding-3-small') {
    try {
      const response = await fetch(`${this._baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      });

      if (!response.ok) {
        throw new Error(`Embedding failed: HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.data?.[0]?.embedding || [];
    } catch (error) {
      this.emit('embed_error', { error: error.message });
      throw error;
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this._stats,
      avgLatency: this._stats.successCalls > 0
        ? Math.round(this._stats.totalLatency / this._stats.successCalls)
        : 0,
      successRate: this._stats.totalCalls > 0
        ? ((this._stats.successCalls / this._stats.totalCalls) * 100).toFixed(1) + '%'
        : '0%',
    };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { LLMProvider };
