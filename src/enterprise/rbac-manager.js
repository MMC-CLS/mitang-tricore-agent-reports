/**
 * TriCore Agent - RBAC 权限管理器 (Role-Based Access Control)
 *
 * Phase 14: 企业级特性 - 基于角色的访问控制
 *
 * 核心能力:
 *   1. 角色定义 - 超级管理员/管理员/操作员/审计员/只读用户
 *   2. 权限粒度 - 模块级/功能级/数据级三级权限
 *   3. 动态角色 - 运行时角色创建与权限分配
 *   4. 权限继承 - 角色层级继承
 *   5. API鉴权 - JWT Token + API Key双模式
 *   6. 会话管理 - 会话超时/并发限制/IP绑定
 *   7. 权限审计 - 所有权限变更记录
 *   8. 临时授权 - 限时提升权限
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');

// ── 安全常量 ──
const PBKDF2_ITERATIONS = 600000; // OWASP 2025 推荐 ≥600,000
const PBKDF2_KEY_LENGTH = 64;
const PBKDF2_DIGEST = 'sha512';
const JWT_EXPIRES_IN = '1h';

// ── 预定义角色 ──
const ROLE = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  OPERATOR: 'operator',
  AUDITOR: 'auditor',
  DEVELOPER: 'developer',
  VIEWER: 'viewer',
});

// ── 权限定义 ──
const PERMISSION = Object.freeze({
  // 系统级
  SYSTEM_MANAGE: 'system:manage',
  SYSTEM_CONFIG: 'system:config',
  SYSTEM_SHUTDOWN: 'system:shutdown',

  // 用户管理
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  USER_VIEW: 'user:view',

  // 角色管理
  ROLE_CREATE: 'role:create',
  ROLE_UPDATE: 'role:update',
  ROLE_DELETE: 'role:delete',
  ROLE_VIEW: 'role:view',

  // Agent操作
  AGENT_START: 'agent:start',
  AGENT_STOP: 'agent:stop',
  AGENT_SEND_MESSAGE: 'agent:send_message',
  AGENT_VIEW_STATUS: 'agent:view_status',

  // 任务管理
  TASK_CREATE: 'task:create',
  TASK_EXECUTE: 'task:execute',
  TASK_CANCEL: 'task:cancel',
  TASK_VIEW: 'task:view',

  // 技能管理
  SKILL_CREATE: 'skill:create',
  SKILL_AUDIT: 'skill:audit',
  SKILL_PUBLISH: 'skill:publish',
  SKILL_VIEW: 'skill:view',

  // 记忆管理
  MEMORY_READ: 'memory:read',
  MEMORY_WRITE: 'memory:write',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_EXPORT: 'memory:export',

  // 安全审计
  AUDIT_VIEW: 'audit:view',
  AUDIT_EXPORT: 'audit:export',
  AUDIT_MANAGE: 'audit:manage',

  // 数据管理
  DATA_IMPORT: 'data:import',
  DATA_EXPORT: 'data:export',
  DATA_DELETE: 'data:delete',

  // API访问
  API_ACCESS: 'api:access',
  API_ADMIN: 'api:admin',
});

// ── 默认角色权限映射 ──
const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  [ROLE.SUPER_ADMIN]: Object.values(PERMISSION),  // 所有权限

  [ROLE.ADMIN]: [
    PERMISSION.SYSTEM_MANAGE, PERMISSION.SYSTEM_CONFIG,
    PERMISSION.USER_CREATE, PERMISSION.USER_UPDATE, PERMISSION.USER_VIEW,
    PERMISSION.ROLE_CREATE, PERMISSION.ROLE_UPDATE, PERMISSION.ROLE_VIEW,
    PERMISSION.AGENT_START, PERMISSION.AGENT_STOP, PERMISSION.AGENT_SEND_MESSAGE, PERMISSION.AGENT_VIEW_STATUS,
    PERMISSION.TASK_CREATE, PERMISSION.TASK_EXECUTE, PERMISSION.TASK_CANCEL, PERMISSION.TASK_VIEW,
    PERMISSION.SKILL_AUDIT, PERMISSION.SKILL_VIEW,
    PERMISSION.MEMORY_READ, PERMISSION.MEMORY_WRITE,
    PERMISSION.AUDIT_VIEW, PERMISSION.AUDIT_EXPORT,
    PERMISSION.DATA_IMPORT, PERMISSION.DATA_EXPORT,
    PERMISSION.API_ACCESS, PERMISSION.API_ADMIN,
  ],

  [ROLE.OPERATOR]: [
    PERMISSION.AGENT_START, PERMISSION.AGENT_SEND_MESSAGE, PERMISSION.AGENT_VIEW_STATUS,
    PERMISSION.TASK_CREATE, PERMISSION.TASK_EXECUTE, PERMISSION.TASK_VIEW,
    PERMISSION.SKILL_VIEW,
    PERMISSION.MEMORY_READ,
    PERMISSION.API_ACCESS,
  ],

  [ROLE.AUDITOR]: [
    PERMISSION.AGENT_VIEW_STATUS,
    PERMISSION.TASK_VIEW,
    PERMISSION.SKILL_VIEW, PERMISSION.SKILL_AUDIT,
    PERMISSION.MEMORY_READ,
    PERMISSION.AUDIT_VIEW, PERMISSION.AUDIT_EXPORT, PERMISSION.AUDIT_MANAGE,
    PERMISSION.USER_VIEW, PERMISSION.ROLE_VIEW,
    PERMISSION.DATA_EXPORT,
  ],

  [ROLE.DEVELOPER]: [
    PERMISSION.AGENT_VIEW_STATUS, PERMISSION.AGENT_SEND_MESSAGE,
    PERMISSION.TASK_CREATE, PERMISSION.TASK_EXECUTE, PERMISSION.TASK_VIEW,
    PERMISSION.SKILL_CREATE, PERMISSION.SKILL_VIEW,
    PERMISSION.MEMORY_READ, PERMISSION.MEMORY_WRITE,
    PERMISSION.DATA_IMPORT, PERMISSION.DATA_EXPORT,
    PERMISSION.API_ACCESS,
  ],

  [ROLE.VIEWER]: [
    PERMISSION.AGENT_VIEW_STATUS,
    PERMISSION.TASK_VIEW,
    PERMISSION.SKILL_VIEW,
    PERMISSION.MEMORY_READ,
    PERMISSION.AUDIT_VIEW,
    PERMISSION.USER_VIEW,
  ],
});

// ── 角色层级（继承关系） ──
const ROLE_HIERARCHY = Object.freeze({
  [ROLE.SUPER_ADMIN]: [ROLE.ADMIN],
  [ROLE.ADMIN]: [ROLE.OPERATOR, ROLE.AUDITOR, ROLE.DEVELOPER],
  [ROLE.OPERATOR]: [ROLE.VIEWER],
  [ROLE.AUDITOR]: [ROLE.VIEWER],
  [ROLE.DEVELOPER]: [ROLE.VIEWER],
});

class RBACManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this._db = options.db || null;
    this._memory = options.memory || null;
    this._logger = options.logger || null;
    this._dataDir = options.dataDir || null;

    // 用户存储
    this._users = new Map();     // userId → { username, passwordHash, roles, ... }
    this._sessions = new Map();  // token → { userId, expiresAt, ip, ... }

    // 自定义角色
    this._customRoles = new Map(); // roleName → Set<permission>

    // 临时授权
    this._temporaryGrants = new Map(); // grantId → { userId, permission, expiresAt }

    // 配置
    this._sessionTimeout = options.sessionTimeout ?? 3600000; // 1小时
    this._maxSessionsPerUser = options.maxSessionsPerUser ?? 5;
    // JWT Secret 持久化：优先从文件加载，其次从选项，最后随机生成
    this._jwtSecret = this._loadJwtSecret(options);
    this._apiKeys = new Map(); // apiKey → { userId, permissions, expiresAt }

    // 审计日志
    this._auditLog = [];
    this._maxAuditLog = options.maxAuditLog ?? 10000;

    // 初始化管理员（必须配置密码，否则使用随机密码并输出警告）
    const adminPassword = options.adminPassword || this._generateSecurePassword();
    if (!options.adminPassword) {
      if (this._logger) {
        this._logger.warn('未配置管理员密码，已生成随机密码', {
          module: 'rbac',
          data: { hint: '请通过adminPassword选项或TRICORE_ADMIN_PASSWORD环境变量设置密码' },
        });
      } else {
        // v1.0 安全修复：不再泄露密码到控制台，仅记录提示
        // logger可能为null（初始化阶段），安全降级到console（但不输出密码）
        console.warn('[RBAC] 未配置管理员密码，已生成随机密码。请通过adminPassword选项或TRICORE_ADMIN_PASSWORD环境变量设置密码');
      }
    }
    this._initDefaultAdmin(adminPassword);

    // 初始化数据库表
    this._initTables();

    // 从持久化存储恢复会话
    this._restoreSessions();

    // 定时清理过期会话并持久化
    this._sessionPersistTimer = setInterval(() => {
      this.cleanupSessions();
      this._persistSessions();
    }, 60000); // 每分钟

    // 进程退出时持久化
    this._setupShutdownHooks();
  }

  // ═══════════════════════════════════════
  // 用户管理
  // ═══════════════════════════════════════

  /**
   * 创建用户
   */
  createUser(username, password, roles = [ROLE.VIEWER], metadata = {}) {
    if (this._findUserByUsername(username)) {
      throw new Error(`User "${username}" already exists`);
    }

    const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = this._hashPassword(password, salt);

    const user = {
      id: userId,
      username,
      passwordHash,
      salt,
      roles: roles.length > 0 ? roles : [ROLE.VIEWER],
      metadata,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastLoginAt: null,
    };

    this._users.set(userId, user);
    this._persistUser(user);

    this._logAudit('user_created', null, { userId, username, roles });
    this.emit('user_created', { userId, username, roles });

    return { id: userId, username, roles };
  }

  /**
   * 用户认证
   */
  authenticate(username, password, options = {}) {
    const user = this._findUserByUsername(username);
    if (!user || !user.enabled) {
      return { success: false, error: 'Invalid credentials' };
    }

    const hash = this._hashPassword(password, user.salt);
    if (hash !== user.passwordHash) {
      this._logAudit('login_failed', user.id, { username, reason: 'wrong_password' });
      return { success: false, error: 'Invalid credentials' };
    }

    // 会话限制
    const activeSessions = [...this._sessions.values()]
      .filter(s => s.userId === user.id).length;
    if (activeSessions >= this._maxSessionsPerUser) {
      return { success: false, error: 'Too many active sessions' };
    }

    // 生成Token
    const token = this._generateToken(user, options.ip);
    const expiresAt = Date.now() + this._sessionTimeout;

    this._sessions.set(token, {
      userId: user.id,
      username: user.username,
      roles: user.roles,
      ip: options.ip || 'unknown',
      createdAt: Date.now(),
      expiresAt,
      metadata: {},
    });

    user.lastLoginAt = Date.now();

    this._logAudit('login_success', user.id, { username });
    this.emit('user_login', { userId: user.id, username });

    return {
      success: true,
      token,
      expiresAt,
      user: { id: user.id, username: user.username, roles: user.roles },
    };
  }

  /**
   * 登出
   */
  logout(token) {
    const session = this._sessions.get(token);
    if (session) {
      this._sessions.delete(token);
      this._logAudit('logout', session.userId, { username: session.username });
      this.emit('user_logout', { userId: session.userId });
    }
  }

  /**
   * 验证Token（JWT + IP绑定双重验证）
   */
  validateToken(token, clientIp = null) {
    // v1.0 安全修复：严格的JWT验证，不再降级到不安全的内存会话
    try {
      const decoded = jwt.verify(token, this._jwtSecret, { algorithms: ['HS256'] });

      // IP 绑定验证：如果 session 记录了 IP 且客户端 IP 不匹配则拒绝
      if (clientIp && decoded.ip && decoded.ip !== 'unknown' && decoded.ip !== clientIp) {
        this._logAudit('token_ip_mismatch', decoded.sub, {
          expectedIp: decoded.ip,
          clientIp,
        });
        return null;
      }

      return {
        userId: decoded.sub,
        username: decoded.username,
        roles: decoded.roles,
        ip: decoded.ip,
      };
    } catch (err) {
      // v1.0: JWT验证失败直接拒绝，不再降级到不安全的内存会话
      if (this._logger) {
        this._logger.warn(`[RBAC] JWT验证失败: ${err.message}`);
      }
      return null;
    }
  }

  // ═══════════════════════════════════════
  // 权限检查
  // ═══════════════════════════════════════

  /**
   * 检查用户是否有指定权限
   */
  hasPermission(userId, permission) {
    const user = this._users.get(userId);
    if (!user || !user.enabled) return false;

    // 检查临时授权
    for (const [grantId, grant] of this._temporaryGrants) {
      if (grant.userId === userId && grant.permission === permission) {
        if (Date.now() < grant.expiresAt) return true;
        this._temporaryGrants.delete(grantId); // 清理过期
      }
    }

    // 获取所有角色（含继承）
    const allRoles = this._getAllRoles(user.roles);

    // 检查每个角色是否有权限
    for (const role of allRoles) {
      // 先检查自定义角色
      if (this._customRoles.has(role)) {
        if (this._customRoles.get(role).has(permission)) return true;
      }
      // 检查预定义角色
      const defaultPerms = DEFAULT_ROLE_PERMISSIONS[role];
      if (defaultPerms && defaultPerms.includes(permission)) return true;
    }

    return false;
  }

  /**
   * 批量检查权限
   */
  hasAllPermissions(userId, permissions) {
    return permissions.every(p => this.hasPermission(userId, p));
  }

  hasAnyPermission(userId, permissions) {
    return permissions.some(p => this.hasPermission(userId, p));
  }

  /**
   * 获取用户的所有权限
   */
  getUserPermissions(userId) {
    const user = this._users.get(userId);
    if (!user) return [];

    const allRoles = this._getAllRoles(user.roles);
    const permissions = new Set();

    for (const role of allRoles) {
      if (this._customRoles.has(role)) {
        for (const p of this._customRoles.get(role)) permissions.add(p);
      }
      const defaultPerms = DEFAULT_ROLE_PERMISSIONS[role];
      if (defaultPerms) {
        for (const p of defaultPerms) permissions.add(p);
      }
    }

    return [...permissions];
  }

  // ═══════════════════════════════════════
  // 角色管理
  // ═══════════════════════════════════════

  /**
   * 创建自定义角色
   */
  createRole(roleName, permissions = [], inherits = []) {
    if (ROLE[roleName.toUpperCase()]) {
      throw new Error(`Cannot override system role: ${roleName}`);
    }

    this._customRoles.set(roleName, new Set(permissions));

    // 继承父角色权限
    for (const parentRole of inherits) {
      const parentPerms = this._getRolePermissions(parentRole);
      for (const p of parentPerms) {
        this._customRoles.get(roleName).add(p);
      }
    }

    this._logAudit('role_created', null, { roleName, permissionCount: permissions.length });
    this.emit('role_created', { roleName });

    return { roleName, permissions: [...this._customRoles.get(roleName)] };
  }

  /**
   * 更新角色权限
   */
  updateRole(roleName, permissions) {
    if (!this._customRoles.has(roleName)) {
      throw new Error(`Role "${roleName}" not found`);
    }

    this._customRoles.set(roleName, new Set(permissions));
    this._logAudit('role_updated', null, { roleName, permissionCount: permissions.length });
    this.emit('role_updated', { roleName });
  }

  /**
   * 删除自定义角色
   */
  deleteRole(roleName) {
    if (ROLE[roleName.toUpperCase()]) {
      throw new Error(`Cannot delete system role: ${roleName}`);
    }

    // 移除所有用户的该角色
    for (const user of this._users.values()) {
      user.roles = user.roles.filter(r => r !== roleName);
    }

    this._customRoles.delete(roleName);
    this._logAudit('role_deleted', null, { roleName });
    this.emit('role_deleted', { roleName });
  }

  /**
   * 给用户分配角色
   */
  assignRole(userId, role) {
    const user = this._users.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);

    if (!user.roles.includes(role)) {
      user.roles.push(role);
      user.updatedAt = Date.now();
      this._logAudit('role_assigned', userId, { role });
      this.emit('role_assigned', { userId, role });
    }
  }

  /**
   * 移除用户角色
   */
  revokeRole(userId, role) {
    const user = this._users.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);

    const index = user.roles.indexOf(role);
    if (index >= 0) {
      user.roles.splice(index, 1);
      user.updatedAt = Date.now();
      this._logAudit('role_revoked', userId, { role });
      this.emit('role_revoked', { userId, role });
    }
  }

  // ═══════════════════════════════════════
  // API Key管理
  // ═══════════════════════════════════════

  /**
   * 生成API Key
   */
  generateApiKey(userId, permissions = [], expiresInDays = 365) {
    const user = this._users.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);

    const apiKey = `tricore_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = Date.now() + expiresInDays * 86400000;

    this._apiKeys.set(apiKey, {
      userId,
      username: user.username,
      permissions: permissions.length > 0 ? permissions : this.getUserPermissions(userId),
      expiresAt,
      createdAt: Date.now(),
    });

    this._logAudit('apikey_created', userId, { permissions: permissions.length });
    this.emit('apikey_created', { userId });

    return { apiKey, expiresAt, permissions };
  }

  /**
   * 验证API Key
   */
  validateApiKey(apiKey) {
    const keyData = this._apiKeys.get(apiKey);
    if (!keyData) return null;

    if (Date.now() > keyData.expiresAt) {
      this._apiKeys.delete(apiKey);
      return null;
    }

    return {
      userId: keyData.userId,
      username: keyData.username,
      permissions: keyData.permissions,
    };
  }

  /**
   * 撤销API Key
   */
  revokeApiKey(apiKey) {
    const existed = this._apiKeys.delete(apiKey);
    if (existed) {
      this.emit('apikey_revoked', { apiKey: apiKey.substring(0, 16) + '...' });
    }
    return existed;
  }

  // ═══════════════════════════════════════
  // 临时授权
  // ═══════════════════════════════════════

  /**
   * 临时授权（限时提升权限）
   */
  grantTemporaryPermission(userId, permission, durationMs = 3600000) {
    const user = this._users.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);

    const grantId = `grant_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const expiresAt = Date.now() + durationMs;

    this._temporaryGrants.set(grantId, {
      userId,
      username: user.username,
      permission,
      expiresAt,
      createdAt: Date.now(),
    });

    // 自动过期清理
    setTimeout(() => {
      this._temporaryGrants.delete(grantId);
    }, durationMs);

    this._logAudit('temp_grant', userId, { permission, durationMs });
    this.emit('temp_permission_granted', { userId, permission, expiresAt });

    return { grantId, permission, expiresAt };
  }

  /**
   * 撤销临时授权
   */
  revokeTemporaryPermission(grantId) {
    const existed = this._temporaryGrants.delete(grantId);
    if (existed) {
      this.emit('temp_permission_revoked', { grantId });
    }
    return existed;
  }

  // ═══════════════════════════════════════
  // 会话管理
  // ═══════════════════════════════════════

  /**
   * 清理过期会话
   */
  cleanupSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, session] of this._sessions) {
      if (now > session.expiresAt) {
        this._sessions.delete(token);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * 踢出用户所有会话
   */
  kickUser(userId) {
    let kicked = 0;
    for (const [token, session] of this._sessions) {
      if (session.userId === userId) {
        this._sessions.delete(token);
        kicked++;
      }
    }
    this._logAudit('user_kicked', userId, { sessionCount: kicked });
    return kicked;
  }

  // ═══════════════════════════════════════
  // 内部辅助
  // ═══════════════════════════════════════

  _hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST).toString('hex');
  }

  _generateToken(user, ip) {
    // 使用标准 JWT 签名，包含 IP 绑定用于额外验证
    const payload = {
      sub: user.id,
      username: user.username,
      roles: user.roles,
      iat: Math.floor(Date.now() / 1000),
      ip: ip || 'unknown',
    };
    return jwt.sign(payload, this._jwtSecret, {
      algorithm: 'HS256',
      expiresIn: JWT_EXPIRES_IN,
    });
  }

  /**
   * 生成安全的随机密码（无硬编码默认值）
   */
  _generateSecurePassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
    const password = [];
    for (let i = 0; i < 20; i++) {
      password.push(chars[crypto.randomInt(chars.length)]);
    }
    return password.join('');
  }

  _findUserByUsername(username) {
    for (const user of this._users.values()) {
      if (user.username === username) return user;
    }
    return null;
  }

  _getAllRoles(roles) {
    const allRoles = new Set(roles);
    const queue = [...roles];

    while (queue.length > 0) {
      const role = queue.shift();
      const parents = ROLE_HIERARCHY[role];
      if (parents) {
        for (const parent of parents) {
          if (!allRoles.has(parent)) {
            allRoles.add(parent);
            queue.push(parent);
          }
        }
      }
    }

    return [...allRoles];
  }

  _getRolePermissions(role) {
    if (this._customRoles.has(role)) {
      return [...this._customRoles.get(role)];
    }
    return DEFAULT_ROLE_PERMISSIONS[role] || [];
  }

  _initDefaultAdmin(password) {
    const userId = 'user_admin_default';

    // 检查管理员是否已存在
    if (this._users.has(userId)) return;

    try {
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = this._hashPassword(password, salt);

      this._users.set(userId, {
        id: userId,
        username: 'admin',
        passwordHash,
        salt,
        roles: [ROLE.SUPER_ADMIN],
        metadata: { isDefault: true },
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastLoginAt: null,
      });
    } catch (e) {
      console.error(`[RBAC] Failed to initialize default admin: ${e.message}`);
      throw e;
    }
  }

  _logAudit(action, userId, data = {}) {
    const entry = {
      action,
      userId,
      data,
      timestamp: Date.now(),
    };
    this._auditLog.push(entry);
    if (this._auditLog.length > this._maxAuditLog) {
      this._auditLog = this._auditLog.slice(-this._maxAuditLog);
    }
  }

  _initTables() {
    if (!this._db) return;
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS rbac_users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          roles TEXT NOT NULL,
          metadata TEXT,
          enabled INTEGER DEFAULT 1,
          created_at INTEGER,
          updated_at INTEGER,
          last_login_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS rbac_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          user_id TEXT,
          data TEXT,
          timestamp INTEGER NOT NULL
        );
      `);
    } catch { /* tables may exist */ }
  }

  _persistUser(user) {
    if (!this._db) return;
    this._db.prepare(`
      INSERT OR REPLACE INTO rbac_users (id, username, password_hash, salt, roles, metadata, enabled, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.username, user.passwordHash, user.salt,
      JSON.stringify(user.roles), JSON.stringify(user.metadata),
      user.enabled ? 1 : 0, user.createdAt, user.updatedAt, user.lastLoginAt);
  }

  // ═══════════════════════════════════════
  // JWT Secret 持久化（Phase 19 - 防止重启后Token失效）
  // ═══════════════════════════════════════

  _getJwtSecretPath() {
    if (this._dataDir) {
      return require('path').join(this._dataDir, '.jwt_secret');
    }
    return null;
  }

  _loadJwtSecret(options) {
    // 1. 优先从选项获取
    if (options.jwtSecret) return options.jwtSecret;

    // 2. 尝试从环境变量获取
    if (process.env.TRICORE_JWT_SECRET) return process.env.TRICORE_JWT_SECRET;

    // 3. 尝试从文件加载
    const secretPath = this._getJwtSecretPath();
    if (secretPath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(secretPath)) {
          const stored = fs.readFileSync(secretPath, 'utf-8').trim();
          if (stored.length >= 32) {
            return stored;
          }
        }
      } catch { /* 文件读取失败，生成新的 */ }
    }

    // 4. 生成新的并持久化（v1.0安全修复: 原子写入 + 重试 + 回退警告）
    const newSecret = crypto.randomBytes(32).toString('hex');
    const saved = this._saveJwtSecret(newSecret);
    if (!saved) {
      // 持久化失败，记录警告但继续运行（重启后JWT会失效，需要重新登录）
      if (this._logger) {
        this._logger.error(
          'Failed to persist JWT secret — tokens will be invalid after restart',
          { module: 'rbac' }
        );
      }
    }
    return newSecret;
  }

  /**
   * v1.0安全修复: 原子写入JWT密钥 — 先写临时文件再rename，防止写入中断导致文件损坏
   * @param {string} secret
   * @returns {boolean} 是否成功持久化
   */
  _saveJwtSecret(secret) {
    const secretPath = this._getJwtSecretPath();
    if (!secretPath) return false;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(secretPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 原子写入: 先写临时文件，然后rename（POSIX保证rename是原子操作）
      const tmpPath = secretPath + '.tmp';
      fs.writeFileSync(tmpPath, secret, { mode: 0o600 });
      fs.renameSync(tmpPath, secretPath);
      // 确保目录权限正确
      try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
      return true;
    } catch (e) {
      if (this._logger) {
        this._logger.error('Failed to persist JWT secret', { module: 'rbac', error: e.message });
      }
      return false;
    }
  }

  // ═══════════════════════════════════════
  // 会话持久化（Phase 19 - 服务重启后恢复会话）
  // ═══════════════════════════════════════

  _getSessionsPath() {
    if (this._dataDir) {
      return require('path').join(this._dataDir, 'rbac_sessions.json');
    }
    return null;
  }

  _persistSessions() {
    const sessionsPath = this._getSessionsPath();
    if (!sessionsPath) return;

    try {
      const fs = require('fs');
      // 只持久化尚未过期的会话
      const now = Date.now();
      const activeSessions = [];
      for (const [token, session] of this._sessions) {
        if (now < session.expiresAt) {
          activeSessions.push({ token, ...session });
        }
      }
      fs.writeFileSync(sessionsPath, JSON.stringify(activeSessions), { mode: 0o600 });
    } catch (e) {
      if (this._logger) {
        this._logger.error('Failed to persist sessions', { module: 'rbac', error: e.message });
      }
    }
  }

  _restoreSessions() {
    const sessionsPath = this._getSessionsPath();
    if (!sessionsPath) return;

    try {
      const fs = require('fs');
      if (!fs.existsSync(sessionsPath)) return;

      const data = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
      const now = Date.now();
      let restored = 0;

      for (const entry of data) {
        if (now < entry.expiresAt && entry.token) {
          const { token, ...session } = entry;
          this._sessions.set(token, session);
          restored++;
        }
      }

      if (restored > 0 && this._logger) {
        this._logger.info(`Restored ${restored} active sessions from disk`, { module: 'rbac' });
      }
    } catch (e) {
      if (this._logger) {
        this._logger.warn('Failed to restore sessions from disk', { module: 'rbac', error: e.message });
      }
    }
  }

  _setupShutdownHooks() {
    const persistAndCleanup = () => {
      this.cleanupSessions();
      this._persistSessions();
      if (this._sessionPersistTimer) {
        clearInterval(this._sessionPersistTimer);
        this._sessionPersistTimer = null;
      }
    };

    // SIGINT / SIGTERM
    process.on('SIGINT', persistAndCleanup);
    process.on('SIGTERM', persistAndCleanup);
    // 进程退出前
    process.on('beforeExit', persistAndCleanup);
  }

  /**
   * 手动强制持久化（供外部调用）
   */
  flushSessions() {
    this.cleanupSessions();
    this._persistSessions();
  }

  /**
   * 清理资源（关闭定时器等）
   */
  close() {
    if (this._sessionPersistTimer) {
      clearInterval(this._sessionPersistTimer);
      this._sessionPersistTimer = null;
    }
    this.cleanupSessions();
    this._persistSessions();
  }

  // ═══════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════

  getUsers() {
    return [...this._users.values()].map(u => ({
      id: u.id,
      username: u.username,
      roles: u.roles,
      enabled: u.enabled,
      lastLoginAt: u.lastLoginAt,
    }));
  }

  getRoles() {
    const allRoles = {};
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      allRoles[role] = { permissions: perms, isSystem: true };
    }
    for (const [role, perms] of this._customRoles) {
      allRoles[role] = { permissions: [...perms], isSystem: false };
    }
    return allRoles;
  }

  getActiveSessions() {
    return [...this._sessions.entries()].map(([token, s]) => ({
      token: token.substring(0, 16) + '...',
      username: s.username,
      ip: s.ip,
      expiresAt: s.expiresAt,
      remaining: Math.max(0, s.expiresAt - Date.now()),
    }));
  }

  getAuditLog(filter = {}, limit = 100) {
    let results = this._auditLog;
    if (filter.userId) results = results.filter(e => e.userId === filter.userId);
    if (filter.action) results = results.filter(e => e.action === filter.action);
    if (filter.since) results = results.filter(e => e.timestamp >= filter.since);
    return results.slice(-limit);
  }

  getStats() {
    return {
      users: this._users.size,
      activeSessions: this._sessions.size,
      apiKeys: this._apiKeys.size,
      customRoles: this._customRoles.size,
      tempGrants: this._temporaryGrants.size,
      auditLogSize: this._auditLog.length,
    };
  }
}

module.exports = {
  RBACManager,
  ROLE,
  PERMISSION,
  DEFAULT_ROLE_PERMISSIONS,
};
