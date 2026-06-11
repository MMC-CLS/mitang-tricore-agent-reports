/**
 * 蜜糖 TriCore Agent — 向量嵌入集成模块 v5.0.0
 * 
 * 提供记忆向量的计算、缓存、相似度搜索和聚类功能
 * 集成LLM Provider的embedding能力到记忆网络图
 */

'use strict';

// ── 相似度方法 ──
const SIMILARITY_METHOD = Object.freeze({
  COSINE: 'cosine',
  EUCLIDEAN: 'euclidean',
  DOT_PRODUCT: 'dot_product',
  JACCARD: 'jaccard',
});

/**
 * 向量嵌入管理器
 * 
 * 职责：
 *   1. 向量计算 — 调用LLM Provider的embedding API
 *   2. 向量缓存 — LRU缓存避免重复计算
 *   3. 相似度搜索 — 余弦相似度 / 欧氏距离
 *   4. 聚类 — K-means简易聚类
 *   5. 降维 — PCA简化（用于可视化）
 */
class VectorEmbeddingManager {
  constructor(options = {}) {
    this._router = options.router || null;
    this._cache = new Map();               // textHash → vector
    this._maxCacheSize = options.maxCacheSize || 1000;
    this._cacheHits = 0;
    this._cacheMisses = 0;
    this._defaultDimensions = options.dimensions || 1536; // OpenAI ada-002
  }

  // ═══════════════════════════════════════
  // 向量计算
  // ═══════════════════════════════════════

  /**
   * 计算文本的嵌入向量
   * @param {string} text - 输入文本
   * @returns {Promise<number[]|null>} 嵌入向量
   */
  async embed(text) {
    if (!text) return null;

    const hash = this._hashText(text);
    const cached = this._cache.get(hash);
    if (cached) {
      this._cacheHits++;
      return cached;
    }

    this._cacheMisses++;

    if (!this._router?.embed) {
      // 降级：使用简单哈希向量
      return this._fallbackEmbed(text);
    }

    try {
      const vector = await this._router.embed(text);
      if (vector) {
        this._setCache(hash, vector);
        return vector;
      }
    } catch {
      // LLM调用失败，降级
    }

    return this._fallbackEmbed(text);
  }

  /**
   * 批量计算嵌入向量
   */
  async embedBatch(texts) {
    const results = [];
    for (const text of texts) {
      const vec = await this.embed(text);
      results.push(vec);
    }
    return results;
  }

  // ═══════════════════════════════════════
  // 相似度计算
  // ═══════════════════════════════════════

  /**
   * 余弦相似度
   */
  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }

  /**
   * 欧氏距离（归一化到[0,1]）
   */
  euclideanDistance(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 1;

    let sum = 0;
    for (let i = 0; i < vecA.length; i++) {
      sum += (vecA[i] - vecB[i]) ** 2;
    }

    const raw = Math.sqrt(sum);
    // 归一化: 最大可能距离 = sqrt(4 * dimensions) (每个维度差最大为2)
    const maxDist = Math.sqrt(4 * vecA.length);
    return Math.min(1, raw / maxDist);
  }

  /**
   * 点积相似度
   */
  dotProduct(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let sum = 0;
    for (let i = 0; i < vecA.length; i++) {
      sum += vecA[i] * vecB[i];
    }
    return sum;
  }

  // ═══════════════════════════════════════
  // 相似度搜索
  // ═══════════════════════════════════════

  /**
   * 在向量集合中搜索最相似的topK个
   */
  searchSimilar(queryVector, candidates, topK = 5, method = SIMILARITY_METHOD.COSINE) {
    if (!queryVector || !candidates || candidates.length === 0) return [];

    const scored = candidates.map(candidate => ({
      ...candidate,
      score: this._similarity(queryVector, candidate.vector, method),
    }));

    // 按相似度降序排列
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * 查找文本在记忆集中的最相似记忆
   */
  async findSimilarMemories(text, memories, topK = 5) {
    const queryVector = await this.embed(text);
    if (!queryVector) return [];

    const candidates = [];
    for (const mem of memories) {
      let vector = mem.vector;
      if (!vector && mem.content) {
        vector = await this.embed(mem.content);
        if (vector) mem.vector = vector;
      }
      if (vector) {
        candidates.push({ ...mem, vector });
      }
    }

    return this.searchSimilar(queryVector, candidates, topK);
  }

  // ═══════════════════════════════════════
  // 简易K-means聚类
  // ═══════════════════════════════════════

  /**
   * K-means聚类（用于记忆网络图的自动分组）
   * @param {Array<{vector: number[], ...}>} items
   * @param {number} k - 聚类数量
   * @param {number} maxIter - 最大迭代次数
   */
  kMeansClustering(items, k = 3, maxIter = 20) {
    if (items.length === 0) return { centroids: [], clusters: [] };
    if (k > items.length) k = items.length;

    // 随机初始化质心
    const centroids = [];
    const used = new Set();
    while (centroids.length < k) {
      const idx = Math.floor(Math.random() * items.length);
      if (!used.has(idx)) {
        used.add(idx);
        centroids.push([...items[idx].vector]);
      }
    }

    for (let iter = 0; iter < maxIter; iter++) {
      // 分配点到最近的质心
      const clusters = Array.from({ length: k }, () => []);
      for (const item of items) {
        let bestCluster = 0;
        let bestDist = Infinity;
        for (let c = 0; c < k; c++) {
          const dist = 1 - this.cosineSimilarity(item.vector, centroids[c]);
          if (dist < bestDist) {
            bestDist = dist;
            bestCluster = c;
          }
        }
        clusters[bestCluster].push(item);
      }

      // 更新质心
      let changed = false;
      for (let c = 0; c < k; c++) {
        if (clusters[c].length === 0) continue;
        const newCentroid = new Array(centroids[c].length).fill(0);
        for (const item of clusters[c]) {
          for (let d = 0; d < newCentroid.length; d++) {
            newCentroid[d] += item.vector[d];
          }
        }
        for (let d = 0; d < newCentroid.length; d++) {
          newCentroid[d] /= clusters[c].length;
        }

        if (this.euclideanDistance(centroids[c], newCentroid) > 0.001) {
          changed = true;
        }
        centroids[c] = newCentroid;
      }

      if (!changed) break;
    }

    // 最终分配
    const finalClusters = Array.from({ length: k }, () => []);
    for (const item of items) {
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dist = 1 - this.cosineSimilarity(item.vector, centroids[c]);
        if (dist < bestDist) {
          bestDist = dist;
          bestCluster = c;
        }
      }
      finalClusters[bestCluster].push(item);
    }

    return { centroids, clusters: finalClusters };
  }

  // ═══════════════════════════════════════
  // 缓存管理
  // ═══════════════════════════════════════

  getCacheStats() {
    return {
      size: this._cache.size,
      maxSize: this._maxCacheSize,
      hits: this._cacheHits,
      misses: this._cacheMisses,
      hitRate: this._cacheHits + this._cacheMisses > 0
        ? (this._cacheHits / (this._cacheHits + this._cacheMisses)).toFixed(3)
        : '0.000',
    };
  }

  clearCache() {
    this._cache.clear();
    this._cacheHits = 0;
    this._cacheMisses = 0;
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  _hashText(text) {
    // 简单哈希（用于缓存键）
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `emb_${Math.abs(hash)}_${text.length}`;
  }

  _fallbackEmbed(text) {
    // 降级方案：基于字符频率的伪向量
    const dims = Math.min(this._defaultDimensions, 256);
    const vector = new Array(dims).fill(0);
    const chars = text.split('');

    for (let i = 0; i < chars.length; i++) {
      const code = chars[i].charCodeAt(0);
      vector[i % dims] += (code / 65535) * 2 - 1;
    }

    // 归一化
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dims; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  _setCache(hash, vector) {
    if (this._cache.size >= this._maxCacheSize) {
      // LRU: 删除最旧的条目
      const firstKey = this._cache.keys().next().value;
      if (firstKey) this._cache.delete(firstKey);
    }
    this._cache.set(hash, vector);
  }

  _similarity(vecA, vecB, method) {
    switch (method) {
      case SIMILARITY_METHOD.COSINE:
        return this.cosineSimilarity(vecA, vecB);
      case SIMILARITY_METHOD.EUCLIDEAN:
        return 1 - this.euclideanDistance(vecA, vecB); // 转为相似度
      case SIMILARITY_METHOD.DOT_PRODUCT:
        return this.dotProduct(vecA, vecB);
      default:
        return this.cosineSimilarity(vecA, vecB);
    }
  }
}

// ── 导出 ──
module.exports = {
  VectorEmbeddingManager,
  SIMILARITY_METHOD,
};
