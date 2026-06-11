/**
 * TriCore Agent - 数据加密服务 (Enterprise Encryption Service)
 *
 * Phase 14: 企业级特性 - 数据加密与密钥管理
 *
 * 核心能力:
 *   1. AES-256-GCM 对称加密 - 数据加密/解密
 *   2. 密钥派生 - PBKDF2 从密码派生加密密钥
 *   3. 密钥轮转 - 多版本密钥管理
 *   4. 数据签名 - HMAC-SHA256 完整性校验
 *   5. 安全哈希 - SHA-256/SHA-512
 *   6. 随机令牌 - 加密安全的随机数生成
 *   7. 密钥存储 - 主密钥加密存储子密钥
 *   8. 数据脱敏 - 结构化数据的部分掩码
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ── 加密算法 ──
const CIPHER_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;      // 256 bits
const IV_LENGTH = 16;       // 128 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;     // 256 bits
const PBKDF2_ITERATIONS = 600000; // OWASP 2025 推荐 ≥600,000
const KEY_VERSION = 1;

// ── 加密密钥版本 ──
const KEY_STATE = Object.freeze({
  ACTIVE: 'active',
  DEPRECATED: 'deprecated',
  REVOKED: 'revoked',
});

class EncryptionService {
  constructor(options = {}) {
    this._keyDir = options.keyDir || path.join(process.cwd(), 'data', 'keys');
    this._masterKey = null;              // 主密钥 (Buffer)
    this._keyVersions = new Map();       // version → { key, state, createdAt }

    // 密钥配置
    this._rotationInterval = options.rotationInterval ?? 90 * 24 * 3600 * 1000; // 90天
    this._maxKeyVersions = options.maxKeyVersions ?? 5;

    // 统计
    this._stats = {
      encryptCount: 0,
      decryptCount: 0,
      signCount: 0,
      verifyCount: 0,
      keyRotations: 0,
    };

    this._ensureKeyDir();
  }

  // ═══════════════════════════════════════
  // 密钥管理
  // ═══════════════════════════════════════

  /**
   * 初始化主密钥（从密码或环境变量派生）
   * @param {string} masterPassword - 主密码
   */
  initialize(masterPassword) {
    const salt = this._loadOrCreateSalt();
    this._masterKey = crypto.pbkdf2Sync(
      masterPassword,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      'sha512'
    );

    // 生成当前版本的加密密钥
    const currentKey = crypto.randomBytes(KEY_LENGTH);
    const encryptedKey = this._encryptKey(currentKey, this._masterKey);

    this._keyVersions.set(KEY_VERSION, {
      key: currentKey,
      encryptedKey,
      state: KEY_STATE.ACTIVE,
      createdAt: Date.now(),
    });

    this._persistKeyVersion(KEY_VERSION, encryptedKey, KEY_STATE.ACTIVE);

    // 加载历史密钥版本
    this._loadKeyVersions();

    return true;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized() {
    return this._masterKey !== null && this._keyVersions.size > 0;
  }

  /**
   * 获取活跃密钥
   */
  _getActiveKey() {
    for (const [version, keyData] of this._keyVersions) {
      if (keyData.state === KEY_STATE.ACTIVE) {
        return { version, key: keyData.key };
      }
    }
    // 如果没有活跃密钥，使用最新版本
    if (this._keyVersions.size > 0) {
      const latest = [...this._keyVersions.entries()].pop();
      return { version: latest[0], key: latest[1].key };
    }
    throw new Error('No encryption keys available. Call initialize() first.');
  }

  /**
   * 获取指定版本的密钥
   */
  _getKey(version) {
    const keyData = this._keyVersions.get(version);
    if (!keyData) throw new Error(`Key version ${version} not found`);
    if (keyData.state === KEY_STATE.REVOKED) {
      throw new Error(`Key version ${version} has been revoked`);
    }
    return keyData.key;
  }

  /**
   * 密钥轮转
   */
  rotateKey() {
    if (!this._masterKey) throw new Error('Encryption service not initialized');

    const newVersion = KEY_VERSION + this._keyVersions.size;

    // 标记旧密钥为废弃
    for (const [version, keyData] of this._keyVersions) {
      if (keyData.state === KEY_STATE.ACTIVE) {
        keyData.state = KEY_STATE.DEPRECATED;
        this._persistKeyVersion(version, keyData.encryptedKey, KEY_STATE.DEPRECATED);
      }
    }

    // 生成新密钥
    const newKey = crypto.randomBytes(KEY_LENGTH);
    const encryptedKey = this._encryptKey(newKey, this._masterKey);

    this._keyVersions.set(newVersion, {
      key: newKey,
      encryptedKey,
      state: KEY_STATE.ACTIVE,
      createdAt: Date.now(),
    });

    this._persistKeyVersion(newVersion, encryptedKey, KEY_STATE.ACTIVE);

    // 清理过期版本
    this._cleanupOldVersions();

    this._stats.keyRotations++;
    return { version: newVersion, state: KEY_STATE.ACTIVE };
  }

  // ═══════════════════════════════════════
  // 加密 / 解密
  // ═══════════════════════════════════════

  /**
   * 加密数据
   * @param {string|Buffer} plaintext - 明文数据
   * @param {Object} options - { version?, associatedData? }
   * @returns {Object} { ciphertext, iv, authTag, version, algorithm }
   */
  encrypt(plaintext, options = {}) {
    if (!this.isInitialized()) throw new Error('Encryption service not initialized');

    const { version: targetVersion, key } = this._getActiveKey();
    const version = options.version || targetVersion;
    const actualKey = options.version ? this._getKey(options.version) : key;

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, actualKey, iv);

    if (options.associatedData) {
      cipher.setAAD(Buffer.from(options.associatedData));
    }

    const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf-8') : plaintext;
    const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
    const authTag = cipher.getAuthTag();

    this._stats.encryptCount++;

    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      version: version,
      algorithm: CIPHER_ALGORITHM,
    };
  }

  /**
   * 解密数据
   * @param {Object} encryptedData - { ciphertext, iv, authTag, version, associatedData? }
   * @returns {string|Buffer} 解密后的明文
   */
  decrypt(encryptedData, outputEncoding = 'utf-8') {
    if (!this.isInitialized()) throw new Error('Encryption service not initialized');

    const { ciphertext, iv, authTag, version, associatedData } = encryptedData;
    if (!ciphertext || !iv || !authTag) {
      throw new Error('Invalid encrypted data: missing required fields');
    }

    const key = this._getKey(version || 1);

    const decipher = crypto.createDecipheriv(
      CIPHER_ALGORITHM,
      key,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));

    if (associatedData) {
      decipher.setAAD(Buffer.from(associatedData));
    }

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);

    this._stats.decryptCount++;

    return outputEncoding ? decrypted.toString(outputEncoding) : decrypted;
  }

  /**
   * 加密字符串（便捷方法）
   */
  encryptString(plaintext, options = {}) {
    return this.encrypt(plaintext, options);
  }

  /**
   * 解密字符串（便捷方法）
   */
  decryptString(encryptedData) {
    return this.decrypt(encryptedData, 'utf-8');
  }

  /**
   * 加密JSON对象
   */
  encryptJSON(obj, options = {}) {
    const json = JSON.stringify(obj);
    return this.encrypt(json, options);
  }

  /**
   * 解密JSON对象
   */
  decryptJSON(encryptedData) {
    const json = this.decrypt(encryptedData, 'utf-8');
    return JSON.parse(json);
  }

  // ═══════════════════════════════════════
  // 数据签名 / 完整性校验
  // ═══════════════════════════════════════

  /**
   * 生成HMAC签名
   * @param {string|Buffer} data - 待签名数据
   * @param {string} algorithm - sha256 | sha512
   * @returns {string} base64编码的签名
   */
  sign(data, algorithm = 'sha256') {
    if (!this._masterKey) throw new Error('Encryption service not initialized');

    const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const hmac = crypto.createHmac(algorithm, this._masterKey);
    hmac.update(input);

    this._stats.signCount++;
    return hmac.digest('base64');
  }

  /**
   * 验证HMAC签名
   * @param {string|Buffer} data - 原始数据
   * @param {string} signature - base64编码的签名
   * @param {string} algorithm - sha256 | sha512
   * @returns {boolean}
   */
  verify(data, signature, algorithm = 'sha256') {
    const expected = this.sign(data, algorithm);
    this._stats.verifyCount++;

    // 常量时间比较防止时序攻击
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature)
      );
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════
  // 安全哈希
  // ═══════════════════════════════════════

  /**
   * 生成安全哈希
   * @param {string|Buffer} data
   * @param {string} algorithm - sha256 | sha512
   * @returns {string} hex编码的哈希值
   */
  hash(data, algorithm = 'sha256') {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    return crypto.createHash(algorithm).update(input).digest('hex');
  }

  /**
   * 带盐哈希（用于密码存储）
   */
  hashWithSalt(data, salt) {
    const effectiveSalt = salt || crypto.randomBytes(SALT_LENGTH);
    const hash = crypto.pbkdf2Sync(
      data,
      effectiveSalt,
      PBKDF2_ITERATIONS,
      64,
      'sha512'
    );
    return {
      hash: hash.toString('hex'),
      salt: effectiveSalt.toString('hex'),
    };
  }

  /**
   * 验证带盐哈希
   */
  verifyHash(data, hash, salt) {
    const result = this.hashWithSalt(data, Buffer.from(salt, 'hex'));
    try {
      return crypto.timingSafeEqual(
        Buffer.from(result.hash, 'hex'),
        Buffer.from(hash, 'hex')
      );
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════
  // 随机令牌生成
  // ═══════════════════════════════════════

  /**
   * 生成加密安全的随机令牌
   * @param {number} length - 字节长度
   * @param {string} encoding - hex | base64 | base64url
   * @returns {string}
   */
  generateToken(length = 32, encoding = 'hex') {
    const bytes = crypto.randomBytes(length);
    switch (encoding) {
      case 'base64':
        return bytes.toString('base64');
      case 'base64url':
        return bytes.toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
      case 'hex':
      default:
        return bytes.toString('hex');
    }
  }

  /**
   * 生成UUID v4
   */
  generateUUID() {
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = bytes.toString('hex');
    return [
      hex.substring(0, 8),
      hex.substring(8, 12),
      hex.substring(12, 16),
      hex.substring(16, 20),
      hex.substring(20, 32),
    ].join('-');
  }

  // ═══════════════════════════════════════
  // 数据脱敏
  // ═══════════════════════════════════════

  /**
   * 部分掩码（保留首尾字符）
   * @param {string} value - 原始值
   * @param {number} keepStart - 保留开头字符数
   * @param {number} keepEnd - 保留结尾字符数
   * @param {string} maskChar - 掩码字符
   * @returns {string}
   */
  maskValue(value, keepStart = 3, keepEnd = 3, maskChar = '*') {
    if (!value || value.length <= keepStart + keepEnd) {
      return maskChar.repeat(value?.length || 0);
    }
    const start = value.substring(0, keepStart);
    const end = value.substring(value.length - keepEnd);
    const maskLength = value.length - keepStart - keepEnd;
    return start + maskChar.repeat(maskLength) + end;
  }

  /**
   * 脱敏手机号
   */
  maskPhone(phone) {
    if (!phone || phone.length < 11) return '***';
    return phone.substring(0, 3) + '****' + phone.substring(7);
  }

  /**
   * 脱敏邮箱
   */
  maskEmail(email) {
    if (!email || !email.includes('@')) return '***@***';
    const [local, domain] = email.split('@');
    const maskedLocal = local.length > 2
      ? local[0] + '***' + local[local.length - 1]
      : '***';
    return maskedLocal + '@' + domain;
  }

  /**
   * 脱敏身份证号
   */
  maskIdCard(idCard) {
    if (!idCard || idCard.length < 8) return '***';
    return idCard.substring(0, 6) + '********' + idCard.substring(14);
  }

  /**
   * 脱敏银行卡号
   */
  maskBankCard(cardNo) {
    if (!cardNo || cardNo.length < 8) return '***';
    return '****' + cardNo.substring(cardNo.length - 4);
  }

  /**
   * 脱敏API Key
   */
  maskApiKey(apiKey) {
    if (!apiKey || apiKey.length < 16) return '***';
    return apiKey.substring(0, 8) + '...' + apiKey.substring(apiKey.length - 4);
  }

  // ═══════════════════════════════════════
  // 内部辅助
  // ═══════════════════════════════════════

  _encryptKey(key, masterKey) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return JSON.stringify({
      iv: iv.toString('base64'),
      key: encrypted.toString('base64'),
      tag: authTag.toString('base64'),
    });
  }

  _decryptKey(encryptedKeyJson, masterKey) {
    const { iv, key, tag } = JSON.parse(encryptedKeyJson);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      masterKey,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(key, 'base64')),
      decipher.final(),
    ]);
  }

  _loadOrCreateSalt() {
    const saltPath = path.join(this._keyDir, 'master.salt');
    if (fs.existsSync(saltPath)) {
      return Buffer.from(fs.readFileSync(saltPath));
    }
    const salt = crypto.randomBytes(SALT_LENGTH);
    fs.writeFileSync(saltPath, salt);
    return salt;
  }

  _persistKeyVersion(version, encryptedKey, state) {
    const filePath = path.join(this._keyDir, `key_v${version}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      version,
      encryptedKey,
      state,
      createdAt: Date.now(),
    }));
  }

  _loadKeyVersions() {
    if (!this._masterKey) return;

    try {
      const files = fs.readdirSync(this._keyDir)
        .filter(f => f.startsWith('key_v') && f.endsWith('.json'))
        .sort();

      for (const file of files) {
        const data = JSON.parse(
          fs.readFileSync(path.join(this._keyDir, file), 'utf-8')
        );
        if (data.state === KEY_STATE.REVOKED) continue;

        try {
          const key = this._decryptKey(data.encryptedKey, this._masterKey);
          this._keyVersions.set(data.version, {
            key,
            encryptedKey: data.encryptedKey,
            state: data.state,
            createdAt: data.createdAt,
          });
        } catch {
          // 密钥解密失败，跳过
        }
      }
    } catch {
      // 文件读取失败
    }
  }

  _cleanupOldVersions() {
    const versions = [...this._keyVersions.entries()]
      .sort((a, b) => b[0] - a[0]); // 按版本号降序

    if (versions.length <= this._maxKeyVersions) return;

    // 保留最新的maxKeyVersions个版本
    for (let i = this._maxKeyVersions; i < versions.length; i++) {
      const [version, keyData] = versions[i];
      this._keyVersions.delete(version);
      // 删除文件
      const filePath = path.join(this._keyDir, `key_v${version}.json`);
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  _ensureKeyDir() {
    if (!fs.existsSync(this._keyDir)) {
      fs.mkdirSync(this._keyDir, { recursive: true });
      // 设置目录权限（仅owner可访问）
      try { fs.chmodSync(this._keyDir, 0o700); } catch {}
    }
  }

  // ═══════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════

  getStats() {
    return {
      ...this._stats,
      initialized: this.isInitialized(),
      keyVersions: this._keyVersions.size,
      activeVersion: [...this._keyVersions.entries()]
        .find(([, v]) => v.state === KEY_STATE.ACTIVE)?.[0] || null,
      keyDir: this._keyDir,
    };
  }

  getKeyVersions() {
    return [...this._keyVersions.entries()].map(([version, data]) => ({
      version,
      state: data.state,
      createdAt: data.createdAt,
    }));
  }
}

module.exports = {
  EncryptionService,
  KEY_STATE,
  CIPHER_ALGORITHM,
};
