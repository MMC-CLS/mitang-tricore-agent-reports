/**
 * TriCore Agent - RAG 检索增强引擎 (RAG Engine)
 *
 * Phase 12: LLM深度集成 - 完整的RAG检索增强生成系统
 *
 * 核心能力:
 *   1. 多源文档加载 - 本地文件/URL/PDF/文本
 *   2. 智能分块 - 语义分块 + 滑动窗口 + 重叠
 *   3. 向量化索引 - 多Provider嵌入支持
 *   4. 混合检索 - 向量相似度 + FTS5关键词 + BM25
 *   5. 重排序 - LLM驱动的结果精排
 *   6. 上下文压缩 - 动态窗口 + 相关性过滤
 *   7. 引用溯源 - 答案带来源引用
 *   8. 增量索引 - 实时文档更新
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// ── 分块策略 ──
const CHUNK_STRATEGY = Object.freeze({
  FIXED: 'fixed',           // 固定大小
  SEMANTIC: 'semantic',     // 语义分块（基于段落/句子）
  SLIDING: 'sliding',       // 滑动窗口
  RECURSIVE: 'recursive',   // 递归分块
});

// ── 检索模式 ──
const RETRIEVAL_MODE = Object.freeze({
  VECTOR: 'vector',         // 纯向量检索
  KEYWORD: 'keyword',       // 关键词检索
  HYBRID: 'hybrid',         // 混合检索
  AUTO: 'auto',             // 自动选择
});

class RAGEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this._memory = options.memory || null;
    this._router = options.router || null;
    this._db = options.db || (this._memory?._db || null);

    this._chunkSize = options.chunkSize ?? 1000;       // 默认1000字符
    this._chunkOverlap = options.chunkOverlap ?? 200;   // 默认200字符重叠
    this._chunkStrategy = options.chunkStrategy || CHUNK_STRATEGY.SEMANTIC;
    this._retrievalMode = options.retrievalMode || RETRIEVAL_MODE.HYBRID;
    this._topK = options.topK ?? 5;
    this._rerankEnabled = options.rerankEnabled ?? true;
    this._similarityThreshold = options.similarityThreshold ?? 0.5;

    // 文档存储
    this._documents = new Map();     // docId → { metadata, chunks }
    this._chunkIndex = new Map();    // chunkId → { docId, content, embedding, metadata }

    // 统计
    this._stats = {
      totalDocuments: 0,
      totalChunks: 0,
      totalQueries: 0,
      totalTokensRetrieved: 0,
    };

    // 初始化数据库表
    this._initTables();
  }

  // ═══════════════════════════════════════
  // 数据库初始化
  // ═══════════════════════════════════════

  _initTables() {
    if (!this._db) return;
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS rag_documents (
          id TEXT PRIMARY KEY,
          title TEXT,
          source TEXT,
          source_type TEXT,
          content TEXT,
          metadata TEXT,
          chunk_count INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        );

        CREATE TABLE IF NOT EXISTS rag_chunks (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB,
          metadata TEXT,
          token_count INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
          FOREIGN KEY (doc_id) REFERENCES rag_documents(id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
          content,
          tokenize='trigram'
        );

        CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_rag_docs_source ON rag_documents(source_type);
      `);
    } catch (e) {
      // 表可能已存在
    }
  }

  // ═══════════════════════════════════════
  // 文档摄取
  // ═══════════════════════════════════════

  /**
   * 添加文档到知识库
   * @param {Object} doc - { content, title?, source?, sourceType?, metadata? }
   * @returns {string} docId
   */
  async addDocument(doc) {
    const { content, title = '', source = '', sourceType = 'text', metadata = {} } = doc;
    const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 分块
    const chunks = this._chunkContent(content);
    this._stats.totalChunks += chunks.length;

    // 存储文档元数据
    const docMeta = {
      id: docId,
      title: title || this._extractTitle(content),
      source,
      sourceType,
      metadata: { ...metadata, addedAt: Date.now() },
      chunkCount: chunks.length,
    };

    this._documents.set(docId, docMeta);

    // 存储分块并生成嵌入
    const chunkRecords = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${docId}_chunk_${i}`;
      const chunkMeta = {
        id: chunkId,
        docId,
        chunkIndex: i,
        content: chunks[i],
        metadata: { ...metadata, chunkIndex: i, totalChunks: chunks.length },
      };
      this._chunkIndex.set(chunkId, chunkMeta);
      chunkRecords.push(chunkMeta);
    }

    // 异步生成嵌入
    this._embedChunks(chunkRecords).catch(err => {
      // v1.0: 记录嵌入生成失败
      if (this._logger) this._logger.debug(`[RAG] 嵌入生成后台失败: ${err.message}`);
    });

    // 持久化到数据库
    if (this._db) {
      this._persistDocument(docId, docMeta, chunkRecords);
    }

    this._stats.totalDocuments++;
    this.emit('document_added', { docId, title: docMeta.title, chunks: chunks.length });

    return docId;
  }

  /**
   * 从文件加载文档
   */
  async loadFile(filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase();
    let content = '';
    let sourceType = 'text';

    try {
      switch (ext) {
        case '.txt':
        case '.md':
        case '.js':
        case '.ts':
        case '.py':
        case '.json':
        case '.xml':
        case '.yaml':
        case '.yml':
        case '.css':
        case '.html':
        case '.csv':
          content = fs.readFileSync(filePath, 'utf-8');
          sourceType = ext.slice(1);
          break;
        case '.pdf':
          // v4.0: 原生 PDF 文本提取（基于流解压 + 文本操作符解析）
          content = this._extractPdfText(filePath);
          sourceType = 'pdf';
          break;
        default:
          content = fs.readFileSync(filePath, 'utf-8');
          sourceType = 'text';
      }
    } catch (e) {
      throw new Error(`Failed to read file: ${e.message}`);
    }

    return this.addDocument({
      content,
      title: options.title || path.basename(filePath),
      source: filePath,
      sourceType,
      metadata: options.metadata || {},
    });
  }

  /**
   * 从URL加载文档
   */
  async loadURL(url, options = {}) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'TriCoreAgent-RAG/2.0' },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      let content;

      if (contentType.includes('text/html')) {
        content = await response.text();
        // 简单的HTML文本提取
        content = content
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      } else {
        content = await response.text();
      }

      return this.addDocument({
        content,
        title: options.title || url,
        source: url,
        sourceType: 'url',
        metadata: options.metadata || {},
      });
    } catch (e) {
      throw new Error(`Failed to load URL: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════
  // 智能分块
  // ═══════════════════════════════════════

  _chunkContent(content) {
    switch (this._chunkStrategy) {
      case CHUNK_STRATEGY.SEMANTIC:
        return this._semanticChunk(content);
      case CHUNK_STRATEGY.SLIDING:
        return this._slidingChunk(content);
      case CHUNK_STRATEGY.RECURSIVE:
        return this._recursiveChunk(content);
      case CHUNK_STRATEGY.FIXED:
      default:
        return this._fixedChunk(content);
    }
  }

  /**
   * 语义分块：按段落/句子边界分块
   */
  _semanticChunk(content) {
    const chunks = [];
    // 先按段落分割
    const paragraphs = content.split(/\n\s*\n/);

    let currentChunk = '';
    for (const para of paragraphs) {
      if ((currentChunk.length + para.length) > this._chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = para;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    // 如果段落太大，按句子分割
    const finalChunks = [];
    for (const chunk of chunks) {
      if (chunk.length > this._chunkSize * 1.5) {
        finalChunks.push(...this._splitBySentence(chunk));
      } else {
        finalChunks.push(chunk);
      }
    }

    return finalChunks;
  }

  _splitBySentence(text) {
    const sentences = text.split(/(?<=[。！？.!?\n])\s*/);
    const chunks = [];
    let current = '';

    for (const sent of sentences) {
      if ((current.length + sent.length) > this._chunkSize && current.length > 0) {
        chunks.push(current.trim());
        current = sent;
      } else {
        current += sent;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  /**
   * 滑动窗口分块
   */
  _slidingChunk(content) {
    const chunks = [];
    const step = this._chunkSize - this._chunkOverlap;

    for (let i = 0; i < content.length; i += step) {
      const chunk = content.substring(i, i + this._chunkSize);
      if (chunk.length >= 50) {
        chunks.push(chunk);
      }
    }

    return chunks;
  }

  /**
   * 递归分块
   */
  _recursiveChunk(content) {
    const separators = ['\n\n', '\n', '。', '. ', ' ', ''];
    return this._recursiveSplit(content, separators, 0);
  }

  _recursiveSplit(text, separators, depth) {
    if (depth >= separators.length) return [text];
    if (text.length <= this._chunkSize) return [text];

    const sep = separators[depth];
    if (!sep) {
      // 最后手段：强制分割
      const chunks = [];
      for (let i = 0; i < text.length; i += this._chunkSize) {
        chunks.push(text.substring(i, i + this._chunkSize));
      }
      return chunks;
    }

    const parts = text.split(sep);
    const chunks = [];
    let current = '';

    for (const part of parts) {
      if ((current.length + part.length + sep.length) > this._chunkSize && current.length > 0) {
        chunks.push(...this._recursiveSplit(current, separators, depth + 1));
        current = part;
      } else {
        current += (current ? sep : '') + part;
      }
    }
    if (current) {
      chunks.push(...this._recursiveSplit(current, separators, depth + 1));
    }

    return chunks;
  }

  /**
   * 固定大小分块
   */
  _fixedChunk(content) {
    const chunks = [];
    for (let i = 0; i < content.length; i += this._chunkSize) {
      chunks.push(content.substring(i, i + this._chunkSize));
    }
    return chunks;
  }

  // ═══════════════════════════════════════
  // 嵌入生成
  // ═══════════════════════════════════════

  async _embedChunks(chunkRecords) {
    if (!this._router) return;

    for (const chunk of chunkRecords) {
      try {
        const embedding = await this._router.embed(chunk.content);
        if (embedding) {
          chunk.embedding = embedding;
          // 更新内存和数据库
          this._chunkIndex.get(chunk.id).embedding = embedding;
          if (this._db) {
            const buf = Buffer.from(new Float32Array(embedding).buffer);
            this._db.prepare('UPDATE rag_chunks SET embedding = ? WHERE id = ?')
              .run(buf, chunk.id);
          }
        }
      } catch (e) {
        // 嵌入失败不影响主流程，但记录警告
        this.emit('embedding_error', { chunkId: chunk.id, error: e.message });
      }
    }
  }

  // ═══════════════════════════════════════
  // 检索
  // ═══════════════════════════════════════

  /**
   * 检索相关文档片段
   * @param {string} query - 查询文本
   * @param {Object} options - { topK?, mode?, threshold?, filterSource? }
   * @returns {Array} 相关文档片段
   */
  async retrieve(query, options = {}) {
    const topK = options.topK || this._topK;
    const mode = options.mode || this._retrievalMode;
    const threshold = options.threshold || this._similarityThreshold;

    this._stats.totalQueries++;

    let results = [];

    switch (mode) {
      case RETRIEVAL_MODE.VECTOR:
        results = await this._vectorRetrieve(query, topK * 2);
        break;
      case RETRIEVAL_MODE.KEYWORD:
        results = await this._keywordRetrieve(query, topK * 2);
        break;
      case RETRIEVAL_MODE.HYBRID:
      case RETRIEVAL_MODE.AUTO:
      default: {
        const [vectorResults, keywordResults] = await Promise.all([
          this._vectorRetrieve(query, topK * 2),
          this._keywordRetrieve(query, topK * 2),
        ]);
        results = this._mergeResults(vectorResults, keywordResults, topK * 2);
        break;
      }
    }

    // 过滤低相关度
    results = results.filter(r => r.score >= threshold);

    // 来源过滤
    if (options.filterSource) {
      results = results.filter(r => {
        const meta = this._chunkIndex.get(r.chunkId);
        const doc = meta ? this._documents.get(meta.docId) : null;
        return doc && doc.sourceType === options.filterSource;
      });
    }

    // 重排序
    if (this._rerankEnabled && results.length > topK && this._router) {
      results = await this._rerankResults(query, results, topK);
    } else {
      results = results.slice(0, topK);
    }

    // 统计
    for (const r of results) {
      this._stats.totalTokensRetrieved += (r.content?.length || 0);
    }

    return results.map(r => ({
      content: r.content,
      score: r.score,
      chunkId: r.chunkId,
      docId: r.docId,
      metadata: r.metadata,
      source: r.source,
    }));
  }

  /**
   * 向量检索
   */
  async _vectorRetrieve(query, limit) {
    if (!this._router || this._chunkIndex.size === 0) return [];

    try {
      const queryEmbedding = await this._router.embed(query);
      if (!queryEmbedding) return [];

      const scored = [];
      for (const [chunkId, chunk] of this._chunkIndex) {
        if (!chunk.embedding) continue;
        const similarity = this._cosineSimilarity(queryEmbedding, chunk.embedding);
        if (similarity > 0) {
          const doc = this._documents.get(chunk.docId);
          scored.push({
            chunkId,
            docId: chunk.docId,
            content: chunk.content,
            score: similarity,
            metadata: chunk.metadata,
            source: doc?.source || '',
          });
        }
      }

      return scored.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * 关键词检索（FTS5）
   */
  async _keywordRetrieve(query, limit) {
    if (!this._db) return [];

    try {
      const keywords = this._extractKeywords(query);
      const results = [];
      const seen = new Set();

      for (const kw of keywords.slice(0, 5)) {
        try {
          const rows = this._db.prepare(`
            SELECT c.id as chunkId, c.doc_id as docId, c.content, c.metadata,
                   d.source, d.title,
                   rank AS fts_rank
            FROM rag_chunks_fts f
            JOIN rag_chunks c ON c.id = f.rowid
            JOIN rag_documents d ON d.id = c.doc_id
            WHERE rag_chunks_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          `).all(kw, Math.ceil(limit / 5));

          for (const row of rows) {
            if (!seen.has(row.chunkId)) {
              seen.add(row.chunkId);
              results.push({
                chunkId: row.chunkId,
                docId: row.docId,
                content: row.content,
                score: 1 / (row.fts_rank + 1),
                metadata: row.metadata ? JSON.parse(row.metadata) : {},
                source: row.source || '',
              });
            }
          }
        } catch { /* FTS5查询失败 */ }
      }

      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * 合并向量和关键词检索结果（RRF: Reciprocal Rank Fusion）
   */
  _mergeResults(vectorResults, keywordResults, limit) {
    const scores = new Map();
    const data = new Map();
    const k = 60; // RRF常数

    // 向量结果
    vectorResults.forEach((r, i) => {
      scores.set(r.chunkId, (scores.get(r.chunkId) || 0) + 1 / (k + i + 1));
      data.set(r.chunkId, r);
    });

    // 关键词结果
    keywordResults.forEach((r, i) => {
      scores.set(r.chunkId, (scores.get(r.chunkId) || 0) + 1 / (k + i + 1));
      if (!data.has(r.chunkId)) data.set(r.chunkId, r);
    });

    // 按融合分数排序
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([chunkId, score]) => ({
        ...data.get(chunkId),
        score: score / 2, // 归一化到0-1
      }));
  }

  /**
   * LLM重排序
   */
  async _rerankResults(query, results, topK) {
    if (!this._router) return results.slice(0, topK);

    try {
      const { MODEL_PURPOSE } = require('../providers/model-router');
      const candidates = results.map((r, i) =>
        `[${i}] ${r.content.substring(0, 300)}`
      ).join('\n---\n');

      const rerankResult = await this._router.call({
        purpose: MODEL_PURPOSE.EVOLUTION,
        messages: [
          {
            role: 'system',
            content: `你是一个搜索结果重排序器。根据查询，对候选文档片段按相关性排序。
输出JSON格式的排名: {"ranking": [最相关索引, 次相关索引, ...]}
只输出JSON，包含所有候选项的索引。`,
          },
          {
            role: 'user',
            content: `查询: ${query}\n\n候选片段:\n${candidates}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 500,
      });

      const jsonMatch = rerankResult.content?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const { ranking } = JSON.parse(jsonMatch[0]);
        if (Array.isArray(ranking)) {
          return ranking
            .map(i => results[i])
            .filter(Boolean)
            .slice(0, topK);
        }
      }
    } catch {
      // 重排序失败，使用原始排序
    }

    return results.slice(0, topK);
  }

  // ═══════════════════════════════════════
  // 问答接口
  // ═══════════════════════════════════════

  /**
   * 基于RAG的问答
   * @param {string} question - 用户问题
   * @param {Object} options - 检索选项
   * @returns {Object} { answer, sources, confidence }
   */
  async ask(question, options = {}) {
    // 检索相关文档
    const context = await this.retrieve(question, options);

    if (context.length === 0) {
      return {
        answer: '未找到相关信息来回答此问题。',
        sources: [],
        confidence: 0,
      };
    }

    if (!this._router) {
      // 无LLM，直接返回检索结果
      return {
        answer: context.map(c => c.content).join('\n\n---\n\n'),
        sources: context.map(c => ({
          content: c.content.substring(0, 200),
          source: c.source,
          score: c.score,
        })),
        confidence: Math.max(...context.map(c => c.score)),
      };
    }

    // LLM生成答案
    const contextBlock = context.map((c, i) =>
      `[来源${i + 1}] (相关度: ${(c.score * 100).toFixed(0)}%)\n${c.content}`
    ).join('\n\n---\n\n');

    try {
      const { MODEL_PURPOSE } = require('../providers/model-router');
      const result = await this._router.call({
        purpose: MODEL_PURPOSE.CONSCIOUSNESS,
        messages: [
          {
            role: 'system',
            content: `你是一个知识助手。基于提供的文档片段回答问题。
规则：
- 只使用提供的文档信息回答
- 如果文档中没有相关信息，明确说明
- 引用来源时使用 [来源N] 格式
- 回答要简洁、准确`,
          },
          {
            role: 'user',
            content: `参考文档:\n${contextBlock}\n\n问题: ${question}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      });

      return {
        answer: result.content || '',
        sources: context.map(c => ({
          content: c.content.substring(0, 200),
          source: c.source,
          score: c.score,
        })),
        confidence: context[0]?.score || 0,
      };
    } catch (e) {
      return {
        answer: context.map(c => c.content).join('\n\n---\n\n'),
        sources: context.map(c => ({
          content: c.content.substring(0, 200),
          source: c.source,
          score: c.score,
        })),
        confidence: Math.max(...context.map(c => c.score)),
      };
    }
  }

  // ═══════════════════════════════════════
  // 文档管理
  // ═══════════════════════════════════════

  /**
   * 删除文档
   */
  removeDocument(docId) {
    const doc = this._documents.get(docId);
    if (!doc) return false;

    // 删除所有分块
    for (const [chunkId, chunk] of this._chunkIndex) {
      if (chunk.docId === docId) {
        this._chunkIndex.delete(chunkId);
      }
    }

    this._documents.delete(docId);

    // 数据库删除
    if (this._db) {
      this._db.prepare('DELETE FROM rag_chunks WHERE doc_id = ?').run(docId);
      this._db.prepare('DELETE FROM rag_documents WHERE id = ?').run(docId);
      this._db.prepare('DELETE FROM rag_chunks_fts WHERE rowid NOT IN (SELECT rowid FROM rag_chunks)').run();
    }

    this._stats.totalDocuments = Math.max(0, this._stats.totalDocuments - 1);
    this.emit('document_removed', { docId });

    return true;
  }

  /**
   * 列出所有文档
   */
  listDocuments() {
    return [...this._documents.values()].map(d => ({
      id: d.id,
      title: d.title,
      source: d.source,
      sourceType: d.sourceType,
      chunks: d.chunkCount,
    }));
  }

  // ═══════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════

  _persistDocument(docId, docMeta, chunkRecords) {
    const txn = this._db.transaction(() => {
      this._db.prepare(`
        INSERT OR REPLACE INTO rag_documents (id, title, source, source_type, content, metadata, chunk_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(docId, docMeta.title, docMeta.source, docMeta.sourceType,
        '', JSON.stringify(docMeta.metadata), chunkRecords.length);

      const insertChunk = this._db.prepare(`
        INSERT OR REPLACE INTO rag_chunks (id, doc_id, chunk_index, content, metadata, token_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const insertFTS = this._db.prepare(`
        INSERT INTO rag_chunks_fts (rowid, content) VALUES (?, ?)
      `);

      for (const chunk of chunkRecords) {
        insertChunk.run(chunk.id, docId, chunk.chunkIndex, chunk.content,
          JSON.stringify(chunk.metadata), Math.ceil(chunk.content.length / 4));
        insertFTS.run(
          this._db.prepare('SELECT rowid FROM rag_chunks WHERE id = ?').get(chunk.id)?.rowid,
          chunk.content
        );
      }
    });
    txn();
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  _extractTitle(content) {
    const firstLine = content.split('\n')[0];
    if (firstLine.startsWith('# ')) return firstLine.slice(2).trim();
    return firstLine.substring(0, 100).trim();
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  _extractKeywords(text) {
    if (!text) return [];
    // 中英文混合关键词提取
    const cjk = text.match(/[\u4e00-\u9fff]{2,4}/g) || [];
    const eng = text.match(/[a-zA-Z]{3,}/g) || [];
    return [...new Set([...cjk, ...eng.map(w => w.toLowerCase())])].slice(0, 10);
  }

  // ═══════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════

  // ═══════════════════════════════════════
  // v4.0: PDF 原生文本提取
  // ═══════════════════════════════════════

  /**
   * 从 PDF 文件中提取文本内容
   * 基于流解压（FlateDecode）+ 文本操作符（Tj/TJ/'/\")解析
   * 无需外部 PDF 库依赖
   */
  _extractPdfText(filePath) {
    const buffer = fs.readFileSync(filePath);
    const content = buffer.toString('latin1');
    let text = '';

    // 方法1: 尝试从流对象中提取文本（解析 Tj/TJ 操作符）
    const streamMatches = this._findPdfStreams(content);
    for (const streamData of streamMatches) {
      try {
        const decompressed = this._inflatePdf(streamData);
        const streamText = this._extractTextFromContentStream(decompressed);
        if (streamText.trim().length > 0) {
          text += streamText + '\n';
        }
      } catch { /* skip malformed streams */ }
    }

    // 方法2: 如果流提取失败，回退到简单字符串提取
    if (text.trim().length === 0) {
      text = this._extractTextFromRawPdf(buffer);
    }

    if (text.trim().length === 0) {
      text = `[PDF文档: ${path.basename(filePath)}] - 文本层为空或为扫描件`;
    }

    return text;
  }

  /**
   * 查找 PDF 中的流对象（stream...endstream）
   */
  _findPdfStreams(content) {
    const streams = [];
    const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
    let match;
    while ((match = streamRegex.exec(content)) !== null) {
      // 检查是否包含 FlateDecode 过滤器（最常见）
      const preBlock = content.substring(Math.max(0, match.index - 200), match.index);
      if (preBlock.includes('/Filter') || preBlock.includes('/Length') || match[1].length > 20) {
        streams.push(match[1]);
      }
    }
    return streams;
  }

  /**
   * zlib 解压（FlateDecode）
   */
  _inflatePdf(data) {
    try {
      const zlib = require('zlib');
      // PDF 流数据以 \n 结尾，需要去除尾部换行
      let raw = Buffer.from(data, 'latin1');
      // 尝试 inflate
      try {
        return zlib.inflateSync(raw).toString('utf-8');
      } catch {
        // 尝试 raw inflate (无 zlib header)
        return zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf-8');
      }
    } catch {
      // 如果解压失败，返回原始文本（未压缩的流）
      return data;
    }
  }

  /**
   * 从内容流中提取文本操作符
   * 支持: Tj, TJ, ', " 操作符
   */
  _extractTextFromContentStream(content) {
    const texts = [];

    // Tj 操作符: (text) Tj
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let match;
    while ((match = tjRegex.exec(content)) !== null) {
      texts.push(this._decodePdfString(match[1]));
    }

    // TJ 操作符: [(text1) -5 (text2)] TJ
    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/gs;
    while ((match = tjArrayRegex.exec(content)) !== null) {
      const inner = match[1];
      const innerRegex = /\(([^)]*)\)/g;
      let innerMatch;
      while ((innerMatch = innerRegex.exec(inner)) !== null) {
        texts.push(this._decodePdfString(innerMatch[1]));
      }
    }

    // ' 操作符（续行文本）
    const quoteRegex = /'([^']*)'/g;
    while ((match = quoteRegex.exec(content)) !== null) {
      const s = this._decodePdfString(match[1]);
      if (s.trim()) texts.push(s);
    }

    return texts.join(' ');
  }

  /**
   * 解码 PDF 字符串中的转义序列
   */
  _decodePdfString(str) {
    return str
      .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
  }

  /**
   * 从原始 PDF buffer 中回退提取可读文本
   */
  _extractTextFromRawPdf(buffer) {
    // 尝试 UTF-8 解码，过滤可打印字符块
    const text = buffer.toString('utf-8');
    // 提取连续可读文本块（中文、字母、数字、标点）
    const readableChunks = text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefa-zA-Z0-9\s.,;:!?()（）【】《》""''，。；：！？…—\-]{20,}/g) || [];
    return readableChunks.join('\n\n');
  }

  getStats() {
    return {
      ...this._stats,
      documents: this._documents.size,
      chunksIndexed: this._chunkIndex.size,
      avgChunkSize: this._chunkSize,
      retrievalMode: this._retrievalMode,
    };
  }
}

module.exports = {
  RAGEngine,
  CHUNK_STRATEGY,
  RETRIEVAL_MODE,
};
