/**
 * Unit Tests: EncryptionService
 * Phase 16: 测试体系 - 加密服务
 */
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EncryptionService, KEY_STATE } = require('../../src/enterprise/encryption-service');

describe('EncryptionService', () => {
  let service;

  beforeEach(() => {
    service = new EncryptionService({
      keyDir: require('path').join(require('os').tmpdir(), 'tricore_test_keys_' + Date.now()),
    });
  });

  describe('初始化', () => {
    it('应从密码初始化', () => {
      const result = service.initialize('masterPassword123!');
      assert.equal(result, true);
      assert.ok(service.isInitialized());
    });

    it('未初始化时应抛出错误', () => {
      assert.equal(service.isInitialized(), false);
      assert.throws(() => {
        service.encrypt('test');
      }, /not initialized/);
    });
  });

  describe('加密解密', () => {
    beforeEach(() => {
      service.initialize('masterPass!');
    });

    it('应正确加密和解密字符串', () => {
      const plaintext = 'Hello, TriCore!';
      const encrypted = service.encrypt(plaintext);
      assert.ok(encrypted.ciphertext);
      assert.ok(encrypted.iv);
      assert.ok(encrypted.authTag);
      assert.equal(encrypted.algorithm, 'aes-256-gcm');

      const decrypted = service.decrypt(encrypted);
      assert.equal(decrypted, plaintext);
    });

    it('每次加密应产生不同的密文', () => {
      const e1 = service.encrypt('same text');
      const e2 = service.encrypt('same text');
      assert.notEqual(e1.ciphertext, e2.ciphertext);
      assert.notEqual(e1.iv, e2.iv);
    });

    it('应支持Buffer输入', () => {
      const input = Buffer.from('binary data');
      const encrypted = service.encrypt(input);
      const decrypted = service.decrypt(encrypted, null);
      assert.ok(Buffer.isBuffer(decrypted));
      assert.equal(decrypted.toString(), input.toString());
    });
  });

  describe('JSON加密', () => {
    beforeEach(() => {
      service.initialize('jsonPass!');
    });

    it('应加密和解密JSON对象', () => {
      const obj = { name: 'TriCore', version: '2.2', features: ['rag', 'rbac'] };
      const encrypted = service.encryptJSON(obj);
      const decrypted = service.decryptJSON(encrypted);
      assert.deepEqual(decrypted, obj);
    });
  });

  describe('签名验证', () => {
    beforeEach(() => {
      service.initialize('signPass!');
    });

    it('应生成和验证HMAC签名', () => {
      const data = 'important data';
      const signature = service.sign(data);
      assert.ok(signature);

      const valid = service.verify(data, signature);
      assert.equal(valid, true);
    });

    it('篡改数据应验证失败', () => {
      const signature = service.sign('original');
      const valid = service.verify('tampered', signature);
      assert.equal(valid, false);
    });
  });

  describe('密钥轮转', () => {
    beforeEach(() => {
      service.initialize('rotatePass!');
    });

    it('应创建新版本密钥', () => {
      const initialVersions = service._keyVersions.size;
      const result = service.rotateKey();
      assert.equal(service._keyVersions.size, initialVersions + 1);
      assert.equal(result.state, KEY_STATE.ACTIVE);
    });

    it('旧密钥应标记为deprecated', () => {
      const result = service.rotateKey();
      let deprecatedCount = 0;
      for (const [, data] of service._keyVersions) {
        if (data.state === KEY_STATE.DEPRECATED) deprecatedCount++;
      }
      assert.ok(deprecatedCount > 0);
    });
  });

  describe('数据脱敏', () => {
    it('应脱敏手机号', () => {
      assert.equal(service.maskPhone('13812345678'), '138****5678');
    });

    it('应脱敏邮箱', () => {
      const masked = service.maskEmail('user@example.com');
      assert.ok(masked.includes('***'));
      assert.ok(masked.includes('@'));
    });

    it('应脱敏身份证号', () => {
      const masked = service.maskIdCard('110101199001011234');
      assert.equal(masked, '110101********1234');
    });

    it('应脱敏银行卡号', () => {
      const masked = service.maskBankCard('6222021234567890');
      assert.equal(masked, '****7890');
    });

    it('通用掩码应保留首尾', () => {
      const masked = service.maskValue('sensitive_data_here', 3, 3);
      assert.ok(masked.startsWith('sen'));
      assert.ok(masked.endsWith('ere'));
    });
  });

  describe('随机令牌', () => {
    it('应生成hex格式令牌', () => {
      const token = service.generateToken(16, 'hex');
      assert.equal(token.length, 32); // 16 bytes = 32 hex chars
    });

    it('应生成base64格式令牌', () => {
      const token = service.generateToken(16, 'base64');
      assert.ok(token.length > 0);
    });

    it('应生成UUID v4', () => {
      const uuid = service.generateUUID();
      assert.ok(uuid.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
    });
  });

  describe('安全哈希', () => {
    beforeEach(() => {
      service.initialize('hashPass!');
    });

    it('应生成SHA-256哈希', () => {
      const hash = service.hash('test data');
      assert.equal(hash.length, 64); // 256 bits = 64 hex chars
    });

    it('应验证带盐哈希', () => {
      const { hash, salt } = service.hashWithSalt('password123');
      const valid = service.verifyHash('password123', hash, salt);
      assert.equal(valid, true);

      const invalid = service.verifyHash('wrongpassword', hash, salt);
      assert.equal(invalid, false);
    });
  });
});
