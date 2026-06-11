/**
 * TriCore Agent - 技能市场 (Skill Market)
 *
 * 能力：
 *   1. 技能发布 - Agent将已审批技能发布到市场
 *   2. 技能搜索 - 按关键词/分类/评分搜索
 *   3. 技能下载 - 下载技能SKILL.md并注册到本地
 *   4. 技能评分 - 使用后评分，驱动质量排序
 *   5. 技能验证 - 发布前自动校验格式+安全扫描
 *   6. 本地缓存 - 已下载技能缓存，离线可用
 *
 * 存储：
 *   - 本地市场：SQLite + skills_market表
 *   - 远程市场：HTTP API（可对接中心化市场）
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 常量 ──
const SKILL_MARKET_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  DEPRECATED: 'deprecated',
  REMOVED: 'removed',
});

const SKILL_VALIDATION = Object.freeze({
  VALID: 'valid',
  WARNING: 'warning',
  INVALID: 'invalid',
});

// ── 安全扫描关键词 ──
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/i,
  /del\s+\/[sq]/i,
  /format\s+[c-z]:/i,
  /shutdown/i,
  /exec\s*\(/i,
  /child_process/i,
  /fs\.unlink/i,
  /process\.exit/i,
  /eval\s*\(/i,
];

class SkillMarket extends EventEmitter {
  constructor(options = {}) {
    super();

    // ── 存储 ──
    this._db = options.db || null;  // better-sqlite3 实例，由外部注入
    this._skills = new Map();       // skillId → skill对象（内存缓存）

    // ── 远程市场端点 ──
    this._remoteEndpoint = options.remoteEndpoint || null;

    // ── 本地下载目录 ──
    this._downloadDir = options.downloadDir || './data/skill_market';

    // ── 已初始化 ──
    this._initialized = false;
  }

  /**
   * 初始化（创建表）
   */
  init() {
    if (!this._db) return;

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS skill_market (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT,
        content TEXT,
        author_id TEXT,
        version TEXT DEFAULT '1.0.0',
        status TEXT DEFAULT 'draft',
        downloads INTEGER DEFAULT 0,
        rating_avg REAL DEFAULT 0,
        rating_count INTEGER DEFAULT 0,
        tags TEXT,
        validated_at INTEGER,
        published_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_market_category ON skill_market(category);
      CREATE INDEX IF NOT EXISTS idx_market_status ON skill_market(status);
      CREATE INDEX IF NOT EXISTS idx_market_author ON skill_market(author_id);
    `);

    // 加载已发布技能到内存
    const rows = this._db.prepare(
      "SELECT * FROM skill_market WHERE status = 'published'"
    ).all();

    for (const row of rows) {
      this._skills.set(row.skill_id, row);
    }

    this._initialized = true;
    this.emit('initialized', { skillCount: rows.length });
  }

  // ═══════════════════════════════════════
  // 技能发布
  // ═══════════════════════════════════════

  /**
   * 发布技能到市场
   * @param {Object} skill - { name, description, category, content, authorId, tags? }
   */
  async publishSkill(skill) {
    // 1. 格式校验
    const validation = this._validateSkill(skill);
    if (validation.status === SKILL_VALIDATION.INVALID) {
      return { error: `Skill validation failed: ${validation.issues.join(', ')}` };
    }

    // 2. 安全扫描
    const securityScan = this._securityScan(skill.content);
    if (securityScan.threats.length > 0) {
      return { error: `Security threats detected: ${securityScan.threats.join(', ')}` };
    }

    // 3. 生成技能ID
    const skillId = skill.skillId || `skill_${crypto.createHash('sha256')
      .update(skill.name + skill.authorId + Date.now())
      .digest('hex').substring(0, 16)}`;

    // 4. 存入数据库
    const record = {
      skill_id: skillId,
      name: skill.name,
      description: skill.description || '',
      category: skill.category || 'general',
      content: skill.content,
      author_id: skill.authorId || 'anonymous',
      version: skill.version || '1.0.0',
      status: SKILL_MARKET_STATUS.PUBLISHED,
      downloads: 0,
      rating_avg: 0,
      rating_count: 0,
      tags: JSON.stringify(skill.tags || []),
      validated_at: Date.now(),
      published_at: Date.now(),
    };

    if (this._db) {
      this._db.prepare(`
        INSERT OR REPLACE INTO skill_market
          (skill_id, name, description, category, content, author_id, version, status, tags, validated_at, published_at)
        VALUES
          (@skill_id, @name, @description, @category, @content, @author_id, @version, @status, @tags, @validated_at, @published_at)
      `).run(record);
    }

    // 5. 更新内存缓存
    this._skills.set(skillId, record);

    // 6. 尝试同步到远程市场
    if (this._remoteEndpoint) {
      try {
        await fetch(`${this._remoteEndpoint}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        });
      } catch (error) {
        this.emit('remote_sync_failed', { skillId, error: error.message });
      }
    }

    this.emit('skill_published', { skillId, name: skill.name });
    return { skillId, status: 'published', validation };
  }

  // ═══════════════════════════════════════
  // 技能搜索
  // ═══════════════════════════════════════

  /**
   * 搜索技能
   * @param {Object} query - { keyword?, category?, authorId?, sortBy? }
   */
  searchSkills(query = {}) {
    let results = [...this._skills.values()];

    // 关键词过滤
    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      results = results.filter(s =>
        s.name.toLowerCase().includes(kw) ||
        s.description.toLowerCase().includes(kw) ||
        (s.tags && s.tags.toLowerCase().includes(kw))
      );
    }

    // 分类过滤
    if (query.category) {
      results = results.filter(s => s.category === query.category);
    }

    // 作者过滤
    if (query.authorId) {
      results = results.filter(s => s.author_id === query.authorId);
    }

    // 排序
    const sortBy = query.sortBy || 'rating';
    switch (sortBy) {
      case 'rating':
        results.sort((a, b) => b.rating_avg - a.rating_avg);
        break;
      case 'downloads':
        results.sort((a, b) => b.downloads - a.downloads);
        break;
      case 'newest':
        results.sort((a, b) => b.published_at - a.published_at);
        break;
    }

    return results.map(s => ({
      skillId: s.skill_id,
      name: s.name,
      description: s.description,
      category: s.category,
      authorId: s.author_id,
      version: s.version,
      downloads: s.downloads,
      rating: { avg: s.rating_avg, count: s.rating_count },
      tags: JSON.parse(s.tags || '[]'),
    }));
  }

  // ═══════════════════════════════════════
  // 技能下载
  // ═══════════════════════════════════════

  /**
   * 下载技能
   */
  async downloadSkill(skillId) {
    const skill = this._skills.get(skillId);
    if (!skill) {
      // 尝试从远程市场获取
      if (this._remoteEndpoint) {
        try {
          const res = await fetch(`${this._remoteEndpoint}/skills/${skillId}`);
          const data = await res.json();
          if (data.skill_id) {
            // 安全扫描：远程技能必须通过安全检查才能缓存
            const securityScan = this._securityScan(data.content);
            if (securityScan.threats.length > 0) {
              return { error: `Remote skill blocked by security scan: ${securityScan.threats.join(', ')}` };
            }
            this._skills.set(skillId, data);
            return data;
          }
        } catch {}
      }
      return { error: `Skill not found: ${skillId}` };
    }

    // 更新下载计数
    if (this._db) {
      this._db.prepare(
        "UPDATE skill_market SET downloads = downloads + 1 WHERE skill_id = ?"
      ).run(skillId);
    }

    this.emit('skill_downloaded', { skillId });
    return {
      skillId: skill.skill_id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      content: skill.content,
      version: skill.version,
    };
  }

  // ═══════════════════════════════════════
  // 技能评分
  // ═══════════════════════════════════════

  /**
   * 评分（1-5星）
   */
  rateSkill(skillId, rating, userId = 'anonymous') {
    if (rating < 1 || rating > 5) {
      return { error: 'Rating must be between 1 and 5' };
    }

    const skill = this._skills.get(skillId);
    if (!skill) return { error: `Skill not found: ${skillId}` };

    // 简单移动平均
    const oldAvg = skill.rating_avg;
    const oldCount = skill.rating_count;
    const newCount = oldCount + 1;
    const newAvg = (oldAvg * oldCount + rating) / newCount;

    skill.rating_avg = Math.round(newAvg * 100) / 100;
    skill.rating_count = newCount;

    if (this._db) {
      this._db.prepare(
        "UPDATE skill_market SET rating_avg = ?, rating_count = ? WHERE skill_id = ?"
      ).run(skill.rating_avg, skill.rating_count, skillId);
    }

    this.emit('skill_rated', { skillId, rating, newAvg: skill.rating_avg });
    return { skillId, newAvg: skill.rating_avg, totalRatings: skill.rating_count };
  }

  // ═══════════════════════════════════════
  // 技能验证
  // ═══════════════════════════════════════

  _validateSkill(skill) {
    const issues = [];
    const warnings = [];

    if (!skill.name || skill.name.trim().length === 0) {
      issues.push('Name is required');
    }

    if (!skill.content || skill.content.trim().length === 0) {
      issues.push('Content is required');
    }

    if (skill.name && skill.name.length > 100) {
      warnings.push('Name too long (>100 chars)');
    }

    if (skill.content && !skill.content.includes('# ')) {
      warnings.push('Content should follow SKILL.md format (missing heading)');
    }

    if (skill.content && skill.content.length < 50) {
      warnings.push('Content seems too short for a useful skill');
    }

    const status = issues.length > 0
      ? SKILL_VALIDATION.INVALID
      : warnings.length > 0
        ? SKILL_VALIDATION.WARNING
        : SKILL_VALIDATION.VALID;

    return { status, issues, warnings };
  }

  _securityScan(content) {
    const threats = [];

    if (!content) return { threats };

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(content)) {
        threats.push(`Potential dangerous pattern: ${pattern.source}`);
      }
    }

    return { threats };
  }

  // ═══════════════════════════════════════
  // 技能废弃
  // ═══════════════════════════════════════

  deprecateSkill(skillId, reason = '') {
    const skill = this._skills.get(skillId);
    if (!skill) return { error: `Skill not found: ${skillId}` };

    skill.status = SKILL_MARKET_STATUS.DEPRECATED;

    if (this._db) {
      this._db.prepare(
        "UPDATE skill_market SET status = ? WHERE skill_id = ?"
      ).run(SKILL_MARKET_STATUS.DEPRECATED, skillId);
    }

    this._skills.delete(skillId);
    this.emit('skill_deprecated', { skillId, reason });
    return { deprecated: true };
  }

  // ═══════════════════════════════════════
  // v4.0: 批量导入/导出
  // ═══════════════════════════════════════

  /**
   * 批量导入技能（从 JSON 数组）
   * @param {Array} skills - 技能对象数组
   * @returns {{imported: number, skipped: number, errors: Array}}
   */
  async importSkillsBatch(skills) {
    const result = { imported: 0, skipped: 0, errors: [] };
    for (const skill of skills) {
      try {
        const res = await this.publishSkill(skill);
        if (res.error) {
          result.skipped++;
          result.errors.push({ name: skill.name, error: res.error });
        } else {
          result.imported++;
        }
      } catch (e) {
        result.skipped++;
        result.errors.push({ name: skill.name, error: e.message });
      }
    }
    return result;
  }

  /**
   * 批量导出技能（返回 JSON 数组）
   * @param {Object} filter - { category?, authorId?, status? }
   * @returns {Array}
   */
  exportSkillsBatch(filter = {}) {
    let skills = [...this._skills.values()];

    if (filter.category) {
      skills = skills.filter(s => s.category === filter.category);
    }
    if (filter.authorId) {
      skills = skills.filter(s => s.author_id === filter.authorId);
    }
    if (filter.status) {
      skills = skills.filter(s => s.status === filter.status);
    }

    return skills.map(s => ({
      name: s.name,
      description: s.description,
      category: s.category,
      content: s.content,
      authorId: s.author_id,
      version: s.version,
      tags: typeof s.tags === 'string' ? JSON.parse(s.tags) : (s.tags || []),
      ratingAvg: s.rating_avg,
      downloads: s.downloads,
    }));
  }

  /**
   * 技能版本升级
   * @param {string} skillId
   * @param {Object} update - { content, description?, version? }
   */
  async upgradeSkill(skillId, update) {
    const skill = this._skills.get(skillId);
    if (!skill) return { error: `Skill not found: ${skillId}` };

    // 安全扫描新内容
    if (update.content) {
      const scan = this._securityScan(update.content);
      if (scan.threats.length > 0) {
        return { error: `Security threats in updated content: ${scan.threats.join(', ')}` };
      }
    }

    const newVersion = update.version || this._bumpVersion(skill.version || '1.0.0');

    if (this._db) {
      this._db.prepare(`
        UPDATE skill_market SET
          content = COALESCE(?, content),
          description = COALESCE(?, description),
          version = ?,
          updated_at = ?
        WHERE skill_id = ?
      `).run(
        update.content || null,
        update.description || null,
        newVersion,
        Date.now(),
        skillId
      );
    }

    // 更新内存
    if (update.content) skill.content = update.content;
    if (update.description) skill.description = update.description;
    skill.version = newVersion;

    this.emit('skill_upgraded', { skillId, newVersion });
    return { skillId, version: newVersion };
  }

  /**
   * 语义化版本号递增（补丁版本+1）
   */
  _bumpVersion(version) {
    const parts = version.split('.').map(Number);
    if (parts.length === 3) {
      parts[2] = (parts[2] || 0) + 1;
    }
    return parts.join('.');
  }

  /**
   * 远程市场同步队列
   * 缓存待同步技能，在网络恢复后批量同步
   */
  _syncQueue = [];

  /**
   * 加入同步队列
   */
  _enqueueSync(skillId) {
    if (!this._syncQueue.includes(skillId)) {
      this._syncQueue.push(skillId);
    }
  }

  /**
   * 执行队列同步
   */
  async flushSyncQueue() {
    if (this._syncQueue.length === 0 || !this._remoteEndpoint) return;

    const toSync = [...this._syncQueue];
    this._syncQueue = [];

    for (const skillId of toSync) {
      const skill = this._skills.get(skillId);
      if (!skill) continue;
      try {
        await fetch(`${this._remoteEndpoint}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(skill),
        });
      } catch {
        // 重新入队
        this._syncQueue.push(skillId);
      }
    }
  }

  // ═══════════════════════════════════════
  // 统计
  // ═══════════════════════════════════════

  getStats() {
    const skills = [...this._skills.values()];
    return {
      totalSkills: skills.length,
      categories: [...new Set(skills.map(s => s.category))],
      totalDownloads: skills.reduce((s, sk) => s + (sk.downloads || 0), 0),
      avgRating: skills.length > 0
        ? Math.round(skills.reduce((s, sk) => s + sk.rating_avg, 0) / skills.length * 100) / 100
        : 0,
    };
  }
}

module.exports = {
  SkillMarket,
  SKILL_MARKET_STATUS,
  SKILL_VALIDATION,
};
