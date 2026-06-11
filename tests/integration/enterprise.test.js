/**
 * Integration Tests: Enterprise Features
 * Phase 16: 测试体系 - 企业级特性集成测试
 */
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { RBACManager, ROLE, PERMISSION } = require('../../src/enterprise/rbac-manager');
const { AuditLogger, AUDIT_CATEGORY, AUDIT_LEVEL } = require('../../src/enterprise/audit-logger');
const { EncryptionService } = require('../../src/enterprise/encryption-service');

describe('Enterprise Integration', () => {
  describe('RBAC + Audit 联动', () => {
    let rbac, audit;

    beforeEach(() => {
      audit = new AuditLogger({
        logDir: require('path').join(require('os').tmpdir(), 'tricore_int_test_' + Date.now()),
        bufferSize: 5,
        flushInterval: 100,
      });
      rbac = new RBACManager({ adminPassword: 'admin123!' });
    });

    it('创建用户时应记录审计日志', () => {
      rbac.createUser('integ_user', 'pass');
      const log = rbac.getAuditLog({ action: 'user_created' }, 1);
      assert.ok(log.length > 0);
      assert.equal(log[0].action, 'user_created');
    });

    it('认证失败应记录审计日志', () => {
      rbac.createUser('integ_user', 'pass');
      rbac.authenticate('integ_user', 'wrongpass');
      const log = rbac.getAuditLog({ action: 'login_failed' }, 1);
      assert.ok(log.length > 0);
    });

    it('权限变更应记录审计日志', () => {
      const user = rbac.createUser('integ_user', 'pass');
      rbac.assignRole(user.id, ROLE.OPERATOR);
      const log = rbac.getAuditLog({ action: 'role_assigned' }, 1);
      assert.ok(log.length > 0);
    });
  });

  describe('Encryption + RBAC 安全链', () => {
    let rbac, encryption;

    beforeEach(() => {
      encryption = new EncryptionService({
        keyDir: require('path').join(require('os').tmpdir(), 'tricore_enc_int_' + Date.now()),
      });
      encryption.initialize('masterKey123!');
      rbac = new RBACManager({ adminPassword: 'admin123!' });
    });

    it('API Key应可加密存储', () => {
      const admin = rbac._users.get('user_admin_default');
      const { apiKey } = rbac.generateApiKey(admin.id);

      const encrypted = encryption.encrypt(apiKey);
      assert.ok(encrypted.ciphertext);

      const decrypted = encryption.decrypt(encrypted);
      assert.equal(decrypted, apiKey);
    });

    it('加密数据签名后应可验证完整性', () => {
      const admin = rbac._users.get('user_admin_default');
      const { apiKey } = rbac.generateApiKey(admin.id);

      const signature = encryption.sign(apiKey);
      const valid = encryption.verify(apiKey, signature);
      assert.equal(valid, true);

      // 篡改验证
      const tampered = encryption.verify(apiKey + 'tampered', signature);
      assert.equal(tampered, false);
    });
  });
});
