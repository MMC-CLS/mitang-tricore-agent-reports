/**
 * 蜜糖 TriCore Agent - 数据库 Schema 版本化迁移系统
 *
 * 设计原则：
 *   1. 每个迁移版本包含 up() 和 down() 方法
 *   2. 迁移状态存储在 _schema_version 表中
 *   3. 自动检测当前版本并执行增量迁移
 *   4. 支持回滚到指定版本
 *
 * 使用方式：
 *   const { runMigrations, getCurrentVersion } = require('./schema-migrations');
 *   runMigrations(db);            // 自动迁移到最新版本
 *   runMigrations(db, 2);         // 迁移到指定版本
 *   runMigrations(db, 1, true);   // 回滚到版本1
 */

'use strict';

// ── 迁移版本定义 ──
const migrations = [
  {
    version: 1,
    description: '初始 Schema — 记忆表、配置表、审计表（v1.0-v3.x 基线）',
    up(db) {
      db.exec(`
        -- 记忆表（MemoryEngine 核心存储）
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          summary TEXT DEFAULT '',
          embedding BLOB,
          mem_type TEXT DEFAULT 'fact',
          tier TEXT DEFAULT 'warm',
          salience REAL DEFAULT 1.0,
          decay_rate REAL DEFAULT 0.01,
          access_count INTEGER DEFAULT 0,
          last_accessed_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 全文搜索索引
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content, summary, content=memories, content_rowid=id
        );

        -- 配置表
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 审计日志表
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          level TEXT DEFAULT 'info',
          action TEXT NOT NULL,
          actor TEXT DEFAULT 'system',
          details TEXT DEFAULT '{}',
          ip_address TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 任务表（ExecutionCore 持久化）
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          priority TEXT DEFAULT 'normal',
          result TEXT,
          error TEXT,
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          completed_at INTEGER
        );

        -- 技能表（EvolutionCore 持久化）
        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT DEFAULT 'general',
          status TEXT DEFAULT 'pending',
          description TEXT,
          skill_md TEXT,
          author TEXT DEFAULT 'system',
          version TEXT DEFAULT '1.0.0',
          rating REAL DEFAULT 0,
          downloads INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- RBAC 用户表
        CREATE TABLE IF NOT EXISTS rbac_users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT DEFAULT 'viewer',
          permissions TEXT DEFAULT '[]',
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          last_login_at INTEGER
        );

        -- RBAC 会话表
        CREATE TABLE IF NOT EXISTS rbac_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          token TEXT UNIQUE NOT NULL,
          ip_address TEXT,
          expires_at INTEGER NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          FOREIGN KEY (user_id) REFERENCES rbac_users(id)
        );

        -- 加密密钥表
        CREATE TABLE IF NOT EXISTS encryption_keys (
          id TEXT PRIMARY KEY,
          key_data TEXT NOT NULL,
          algorithm TEXT DEFAULT 'aes-256-gcm',
          state TEXT DEFAULT 'active',
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          rotated_at INTEGER
        );

        -- 事件总线日志表
        CREATE TABLE IF NOT EXISTS event_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          event TEXT NOT NULL,
          trace_id TEXT,
          data TEXT DEFAULT '{}',
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 消息队列表（MessageQueueManager 持久化）
        CREATE TABLE IF NOT EXISTS message_queue (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          priority INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending',
          payload TEXT NOT NULL,
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          expires_at INTEGER
        );

        -- 子智能体表
        CREATE TABLE IF NOT EXISTS sub_agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT DEFAULT 'general',
          status TEXT DEFAULT 'inactive',
          config TEXT DEFAULT '{}',
          safety_level TEXT DEFAULT 'standard',
          quota_level TEXT DEFAULT 'standard',
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          last_heartbeat_at INTEGER
        );

        -- 团队表
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT DEFAULT 'collaborative',
          status TEXT DEFAULT 'active',
          config TEXT DEFAULT '{}',
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 团队-成员关联表
        CREATE TABLE IF NOT EXISTS team_members (
          team_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          role TEXT DEFAULT 'member',
          joined_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          PRIMARY KEY (team_id, agent_id),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );

        -- 记忆网络图快照表（v3.0）
        CREATE TABLE IF NOT EXISTS memory_graph_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          graph_data TEXT NOT NULL,
          node_count INTEGER DEFAULT 0,
          edge_count INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 消息管道状态表（v3.0）
        CREATE TABLE IF NOT EXISTS message_pipelines (
          msg_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          channel TEXT DEFAULT 'api',
          state TEXT DEFAULT 'received',
          quantum_state TEXT DEFAULT 'superposition',
          affect_vector TEXT DEFAULT '[0,0,0,0,0,0]',
          intent TEXT,
          entities TEXT DEFAULT '[]',
          complexity REAL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          completed_at INTEGER
        );

        -- 启动自检状态表（v3.1）
        CREATE TABLE IF NOT EXISTS self_check_status (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phase TEXT NOT NULL,
          status TEXT NOT NULL,
          duration_ms INTEGER,
          errors TEXT DEFAULT '[]',
          warnings TEXT DEFAULT '[]',
          completed_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- Schema 版本追踪表
        CREATE TABLE IF NOT EXISTS _schema_version (
          version INTEGER PRIMARY KEY,
          description TEXT,
          applied_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );
      `);

      // 插入初始版本记录
      const insertVersion = db.prepare(
        'INSERT OR IGNORE INTO _schema_version (version, description) VALUES (?, ?)'
      );
      insertVersion.run(1, '初始 Schema — v1.0-v3.x 基线');
    },

    down(db) {
      // v1 是初始版本，回滚即删除所有表
      const tables = [
        'memories', 'memories_fts', 'config', 'audit_logs', 'tasks',
        'skills', 'rbac_users', 'rbac_sessions', 'encryption_keys',
        'event_log', 'message_queue', 'sub_agents', 'teams',
        'team_members', 'memory_graph_snapshots', 'message_pipelines',
        'self_check_status', '_schema_version',
      ];
      for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    },
  },

  // ── v2: v4.0/v4.1 新增表 ──
  {
    version: 2,
    description: 'v4.0/v4.1 新增 — 安全过滤日志表、国际化缓存表、性能指标表、ANN索引元数据表',
    up(db) {
      db.exec(`
        -- 内容安全过滤日志表（v4.0 ContentSafetyFilter）
        CREATE TABLE IF NOT EXISTS safety_filter_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          direction TEXT NOT NULL DEFAULT 'input',
          category TEXT NOT NULL,
          level TEXT NOT NULL DEFAULT 'safe',
          original_content_hash TEXT,
          matched_pattern TEXT,
          action_taken TEXT DEFAULT 'pass',
          user_id TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 国际化缓存表（v4.0 I18n）
        CREATE TABLE IF NOT EXISTS i18n_cache (
          key TEXT NOT NULL,
          locale TEXT NOT NULL,
          value TEXT NOT NULL,
          ttl INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          PRIMARY KEY (key, locale)
        );

        -- 性能指标表（v4.0 性能基准数据持久化）
        CREATE TABLE IF NOT EXISTS performance_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL,
          metric_value REAL NOT NULL,
          unit TEXT DEFAULT 'ms',
          tags TEXT DEFAULT '{}',
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 性能指标汇总表（按小时聚合）
        CREATE TABLE IF NOT EXISTS performance_metrics_hourly (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL,
          hour_bucket INTEGER NOT NULL,
          count INTEGER DEFAULT 0,
          sum_value REAL DEFAULT 0,
          min_value REAL,
          max_value REAL,
          avg_value REAL,
          p50_value REAL,
          p95_value REAL,
          p99_value REAL,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          UNIQUE(metric_name, hour_bucket)
        );

        -- ANN索引元数据表（v4.0 ANNIndex）
        CREATE TABLE IF NOT EXISTS ann_index_metadata (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          index_name TEXT UNIQUE NOT NULL,
          dimensions INTEGER NOT NULL,
          num_tables INTEGER DEFAULT 10,
          num_vectors INTEGER DEFAULT 0,
          distance_metric TEXT DEFAULT 'cosine',
          index_state TEXT DEFAULT 'building',
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 版权标识审计表（v4.0 版权保护层）
        CREATE TABLE IF NOT EXISTS copyright_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          details TEXT DEFAULT '{}',
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 性能SLA定义表（v4.1）
        CREATE TABLE IF NOT EXISTS performance_sla (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL UNIQUE,
          sla_target REAL NOT NULL,
          sla_unit TEXT DEFAULT 'ms',
          severity TEXT DEFAULT 'warning',
          description TEXT,
          enabled INTEGER DEFAULT 1,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        );

        -- 插入默认SLA定义
        INSERT OR IGNORE INTO performance_sla (metric_name, sla_target, sla_unit, severity, description) VALUES
          ('agent_startup_time', 5000, 'ms', 'critical', 'Agent冷启动总时间'),
          ('tick_processing_time', 2000, 'ms', 'warning', '单个TICK处理时间'),
          ('message_processing_time', 1000, 'ms', 'warning', '消息管道处理时间'),
          ('memory_search_time', 500, 'ms', 'warning', '记忆检索时间'),
          ('api_response_time', 200, 'ms', 'warning', 'API响应时间'),
          ('event_dispatch_time', 50, 'ms', 'info', '事件总线派发延迟');
      `);

      const insertVersion = db.prepare(
        'INSERT OR IGNORE INTO _schema_version (version, description) VALUES (?, ?)'
      );
      insertVersion.run(2, 'v4.0/v4.1 新增 — 安全过滤/国际化缓存/性能指标/ANN元数据/SLA定义');
    },

    down(db) {
      const tables = [
        'safety_filter_logs', 'i18n_cache', 'performance_metrics',
        'performance_metrics_hourly', 'ann_index_metadata',
        'copyright_audit', 'performance_sla',
      ];
      for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      db.exec(`DELETE FROM _schema_version WHERE version = 2`);
    },
  },
];

// ── 迁移执行函数 ──

/**
 * 获取当前数据库 Schema 版本
 * @param {import('better-sqlite3').Database} db
 * @returns {number} 当前版本号（0 表示无版本记录）
 */
function getCurrentVersion(db) {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_version'"
    ).get();
    if (!row) return 0;

    const versionRow = db.prepare(
      'SELECT MAX(version) as version FROM _schema_version'
    ).get();
    return versionRow?.version || 0;
  } catch {
    return 0;
  }
}

/**
 * 获取最新可用迁移版本
 * @returns {number}
 */
function getLatestVersion() {
  return migrations.length > 0 ? migrations[migrations.length - 1].version : 0;
}

/**
 * 执行数据库迁移
 * @param {import('better-sqlite3').Database} db
 * @param {number} [targetVersion] - 目标版本号（默认最新）
 * @param {boolean} [rollback=false] - 是否回滚模式
 * @returns {{ success: boolean, fromVersion: number, toVersion: number, applied: number[] }}
 */
function runMigrations(db, targetVersion, rollback = false) {
  const currentVersion = getCurrentVersion(db);
  const latestVersion = getLatestVersion();
  const target = targetVersion ?? (rollback ? Math.max(0, currentVersion - 1) : latestVersion);

  if (target === currentVersion) {
    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: currentVersion,
      applied: [],
      message: `Schema 已是最新版本 (v${currentVersion})`,
    };
  }

  const applied = [];

  if (rollback || target < currentVersion) {
    // 回滚模式：从高版本向低版本执行 down()
    for (let i = migrations.length - 1; i >= 0; i--) {
      const m = migrations[i];
      if (m.version > target && m.version <= currentVersion) {
        m.down(db);
        applied.push(-m.version); // 负数表示回滚
      }
    }
  } else {
    // 升级模式：从低版本向高版本执行 up()
    for (const m of migrations) {
      if (m.version > currentVersion && m.version <= target) {
        m.up(db);
        applied.push(m.version);
      }
    }
  }

  return {
    success: true,
    fromVersion: currentVersion,
    toVersion: target,
    applied,
    message: `Schema 迁移完成: v${currentVersion} → v${target} (应用了 ${applied.length} 个迁移)`,
  };
}

/**
 * 检查是否需要迁移
 * @param {import('better-sqlite3').Database} db
 * @returns {{ needsMigration: boolean, currentVersion: number, latestVersion: number }}
 */
function checkMigrationNeeded(db) {
  const currentVersion = getCurrentVersion(db);
  const latestVersion = getLatestVersion();
  return {
    needsMigration: currentVersion < latestVersion,
    currentVersion,
    latestVersion,
  };
}

/**
 * 获取所有迁移记录
 * @returns {Array<{ version: number, description: string }>}
 */
function getMigrationHistory() {
  return migrations.map(m => ({
    version: m.version,
    description: m.description,
  }));
}

// ── CLI 入口（用于 npm run db:migrate / npm run db:rollback） ──
if (require.main === module) {
  const path = require('path');
  const Database = require('better-sqlite3');

  const isRollback = process.argv.includes('--rollback');
  const dbPath = process.env.TRICORE_DB_PATH ||
    path.join(process.cwd(), 'data', 'memory.db');

  let db;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    console.log(`数据库路径: ${dbPath}`);
    console.log(`当前版本: v${getCurrentVersion(db)}`);
    console.log(`最新版本: v${getLatestVersion()}`);
    console.log(`模式: ${isRollback ? '回滚' : '升级'}`);

    const result = runMigrations(db, undefined, isRollback);
    console.log(`结果: ${result.message}`);
    console.log(`应用的迁移: [${result.applied.join(', ')}]`);

    db.close();
  } catch (err) {
    console.error('迁移失败:', err.message);
    if (db) db.close();
    process.exit(1);
  }
}

module.exports = {
  migrations,
  runMigrations,
  getCurrentVersion,
  getLatestVersion,
  checkMigrationNeeded,
  getMigrationHistory,
};
