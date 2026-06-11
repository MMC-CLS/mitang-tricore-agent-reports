/**
 * ANN Index - Lightweight In-Memory Approximate Nearest Neighbor Index
 *
 * HNSW-like simple index using cosine similarity.
 * Provides sub-linear search over high-dimensional vectors without external dependencies.
 *
 * Design:
 *   - Multi-layer graph structure inspired by HNSW
 *   - Each layer is a navigable small-world graph
 *   - Search starts at the top layer and descends
 *   - Insertion randomly assigns a maximum layer for each vector
 */

'use strict';

// ── Distance metric constants ──
const DISTANCE_METRIC = Object.freeze({
  COSINE: 'cosine',
  EUCLIDEAN: 'euclidean',
});

// ── Internal constants ──
const DEFAULT_M = 16;           // Max connections per node per layer
const DEFAULT_EF_CONSTRUCTION = 200; // Search width during insertion
const DEFAULT_EF_SEARCH = 50;   // Search width during query
const DEFAULT_ML = 1 / Math.log2(DEFAULT_M); // Level generation normalizer

class ANNIndex {
  /**
   * @param {Object} options
   * @param {number} [options.dimensions=1536] - Vector dimensions
   * @param {number} [options.M=16] - Max connections per node per layer
   * @param {number} [options.efConstruction=200] - Search width during construction
   * @param {number} [options.efSearch=50] - Search width during query
   * @param {string} [options.metric='cosine'] - Distance metric
   */
  constructor(options = {}) {
    this._dimensions = options.dimensions || 1536;
    this._M = options.M || DEFAULT_M;
    this._M_max0 = this._M * 2; // Max connections on layer 0
    this._efConstruction = options.efConstruction || DEFAULT_EF_CONSTRUCTION;
    this._efSearch = options.efSearch || DEFAULT_EF_SEARCH;
    this._metric = options.metric || DISTANCE_METRIC.COSINE;
    this._ml = options.ml || DEFAULT_ML;

    // Storage
    this._nodes = new Map();          // id -> { vector, layers: Map<level, Set<neighborId>>, maxLevel, data }
    this._entryPoint = null;          // Entry point ID for the top layer
    this._maxLevel = 0;               // Current maximum level in the graph

    // Stats
    this._totalVectors = 0;
  }

  // ── Public API ──

  /**
   * Add a vector to the index.
   * @param {string} id - Unique identifier
   * @param {Float32Array|number[]} vector - The embedding vector
   * @param {Object} [data] - Optional metadata to store with the vector
   */
  add(id, vector, data) {
    this._addInternal(id, vector, data);
  }

  /**
   * Alias for add() — maintained for backward compatibility with existing callers.
   */
  insert(id, vector, data) {
    this._addInternal(id, vector, data);
  }

  /**
   * Internal add implementation.
   */
  _addInternal(id, vector, data) {
    const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);

    if (vec.length !== this._dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this._dimensions}, got ${vec.length}`
      );
    }

    // Randomly assign max level for this node (HNSW insertion level)
    const nodeLevel = this._randomLevel();
    const layers = new Map();

    // Initialize layers from 0 to nodeLevel
    for (let lc = 0; lc <= nodeLevel; lc++) {
      layers.set(lc, new Set());
    }

    const node = {
      id,
      vector: vec,
      layers,
      maxLevel: nodeLevel,
      data: data || null,
    };

    this._nodes.set(id, node);
    this._totalVectors++;

    // If this is the first node, set as entry point
    if (this._entryPoint === null) {
      this._entryPoint = id;
      this._maxLevel = nodeLevel;
      return;
    }

    // Insert into the graph
    this._insertNode(node);

    // Update max level if needed
    if (nodeLevel > this._maxLevel) {
      this._maxLevel = nodeLevel;
      this._entryPoint = id;
    }
  }

  /**
   * Search for k nearest neighbors.
   * @param {Float32Array|number[]} queryVector - The query embedding
   * @param {number} k - Number of results to return
   * @returns {Array<{id: string, score: number, data?: Object}>}
   */
  search(queryVector, k = 10) {
    const vec = queryVector instanceof Float32Array
      ? queryVector
      : new Float32Array(queryVector);

    if (this._totalVectors === 0) return [];

    // Start from entry point at top level
    let ep = this._entryPoint;
    let currentLevel = this._maxLevel;

    // Descend through layers
    while (currentLevel > 0) {
      const result = this._searchLayer(vec, [ep], 1, currentLevel);
      ep = result[0].id;
      currentLevel--;
    }

    // Search layer 0 with efSearch
    const results = this._searchLayer(vec, [ep], Math.max(this._efSearch, k), 0);
    return results.slice(0, k).map(r => {
      const node = this._nodes.get(r.id);
      return {
        id: node.data?.dbId || r.id,
        score: r.score,
        data: node.data,
      };
    });
  }

  /**
   * Remove a vector from the index.
   * @param {string} id - The vector's identifier
   */
  remove(id) {
    const node = this._nodes.get(id);
    if (!node) return;

    // Remove connections from neighbors
    for (const [level, neighbors] of node.layers) {
      for (const neighborId of neighbors) {
        const neighbor = this._nodes.get(neighborId);
        if (neighbor && neighbor.layers.has(level)) {
          neighbor.layers.get(level).delete(id);
        }
      }
    }

    this._nodes.delete(id);
    this._totalVectors--;

    // Reset entry point if it was removed
    if (this._entryPoint === id) {
      this._entryPoint = this._nodes.size > 0
        ? this._nodes.keys().next().value
        : null;
      if (this._entryPoint === null) {
        this._maxLevel = 0;
      } else {
        // Recalculate max level
        this._maxLevel = 0;
        for (const n of this._nodes.values()) {
          if (n.maxLevel > this._maxLevel) {
            this._maxLevel = n.maxLevel;
            this._entryPoint = n.id;
          }
        }
      }
    }
  }

  /**
   * Get index statistics.
   * @returns {{ totalVectors: number, dimension: number }}
   */
  getStats() {
    return {
      totalVectors: this._totalVectors,
      dimension: this._dimensions,
    };
  }

  // ── Private methods ──

  /**
   * Generate a random level for a new node (HNSW insertion level).
   */
  _randomLevel() {
    const r = -Math.log(Math.random()) * this._ml;
    return Math.floor(r);
  }

  /**
   * Insert a node into the HNSW graph.
   */
  _insertNode(node) {
    let ep = this._entryPoint;
    let currentLevel = this._maxLevel;

    // Find entry point for node's top layer
    while (currentLevel > node.maxLevel) {
      const result = this._searchLayer(node.vector, [ep], 1, currentLevel);
      ep = result[0].id;
      currentLevel--;
    }

    // Insert into each layer from node.maxLevel down to 0
    for (let lc = Math.min(node.maxLevel, this._maxLevel); lc >= 0; lc--) {
      const ef = lc === 0 ? this._efConstruction : this._M;
      const candidates = this._searchLayer(node.vector, [ep], ef, lc);

      // Select M (or M_max0 for layer 0) nearest neighbors
      const M = lc === 0 ? this._M_max0 : this._M;
      const selected = this._selectNeighborsSimple(candidates, M);

      // Add bidirectional connections
      for (const candidate of selected) {
        node.layers.get(lc).add(candidate.id);
        const neighborNode = this._nodes.get(candidate.id);
        if (neighborNode && neighborNode.layers.has(lc)) {
          neighborNode.layers.get(lc).add(node.id);

          // Prune if too many connections
          const neighborConns = neighborNode.layers.get(lc);
          if (neighborConns.size > M) {
            this._pruneConnections(neighborNode, lc, M);
          }
        }
      }

      // Update entry point for next layer
      if (candidates.length > 0) {
        ep = candidates[0].id;
      }
    }
  }

  /**
   * Search within a single layer for nearest neighbors.
   */
  _searchLayer(queryVec, entryPoints, ef, level) {
    const visited = new Set();
    const candidates = []; // Min-heap would be ideal, but we use sorted array for simplicity
    const results = [];

    for (const ep of entryPoints) {
      const node = this._nodes.get(ep);
      if (!node) continue;

      const score = this._computeSimilarity(queryVec, node.vector);
      visited.add(ep);
      candidates.push({ id: ep, score });
      results.push({ id: ep, score });
    }

    // Sort by score descending (higher is better for cosine similarity)
    candidates.sort((a, b) => b.score - a.score);
    results.sort((a, b) => b.score - a.score);

    while (candidates.length > 0) {
      const current = candidates.shift();

      // Stop if the best candidate is worse than the worst result
      if (results.length >= ef && current.score < results[results.length - 1].score) {
        break;
      }

      const node = this._nodes.get(current.id);
      if (!node) continue;

      const neighbors = node.layers.get(level);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = this._nodes.get(neighborId);
        if (!neighbor) continue;

        const score = this._computeSimilarity(queryVec, neighbor.vector);

        // Insert into candidates sorted
        if (results.length < ef || score > results[results.length - 1].score) {
          this._sortedInsert(candidates, { id: neighborId, score }, false);
          this._sortedInsert(results, { id: neighborId, score }, false);

          // Trim to ef
          if (results.length > ef) {
            results.pop();
          }
          if (candidates.length > ef * 2) {
            candidates.length = ef;
          }
        }
      }
    }

    return results;
  }

  /**
   * Select M nearest neighbors from candidates (simple greedy approach).
   */
  _selectNeighborsSimple(candidates, M) {
    if (candidates.length <= M) return candidates;
    // Heuristic: pick the closest, then iteratively pick candidates that
    // are closer to the query than to any already-selected neighbor
    const selected = [candidates[0]];
    for (let i = 1; i < candidates.length && selected.length < M; i++) {
      selected.push(candidates[i]);
    }
    return selected;
  }

  /**
   * Prune connections to maintain max M per layer.
   */
  _pruneConnections(node, level, maxConn) {
    const neighbors = node.layers.get(level);
    if (!neighbors || neighbors.size <= maxConn) return;

    // Keep the closest neighbors by similarity to node's vector
    const scored = [];
    for (const neighborId of neighbors) {
      const neighbor = this._nodes.get(neighborId);
      if (neighbor) {
        const score = this._computeSimilarity(node.vector, neighbor.vector);
        scored.push({ id: neighborId, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    node.layers.set(level, new Set(scored.slice(0, maxConn).map(s => s.id)));
  }

  /**
   * Compute similarity between two vectors.
   * For cosine: returns value in [0, 1] where 1 = identical.
   */
  _computeSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? (dot / denom + 1) / 2 : 0; // Normalize to [0, 1]
  }

  /**
   * Insert into sorted array (descending order by default).
   */
  _sortedInsert(arr, item, ascending = true) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = ascending
        ? arr[mid].score - item.score
        : item.score - arr[mid].score;
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, item);
  }
}

// ── Exports ──
module.exports = {
  ANNIndex,
  DISTANCE_METRIC,
};
