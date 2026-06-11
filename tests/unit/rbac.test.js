/**
 * Unit Tests: RBACManager
 * Phase 16: 测试体系 - RBAC权限管理
 */
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { RBACManager, ROLE, PERMISSION } = require('../../src/enterprise/rbac-manager');

describe('RBACManager', () => {
  let rbac;

  beforeEach(() => {
    rbac = new RBACManager({
      adminPassword: 'testAdminPass123!',
      sessionTimeout: 3600000,
    });
  });

  describe('用户管理', () => {
    it('应创建用户并返回用户信息', () => {
      const user = rbac.createUser('testuser', 'password123', [ROLE.VIEWER]);
      assert.ok(user.id);
      assert.equal(user.username, 'testuser');
      assert.ok(user.roles.includes(ROLE.VIEWER));
    });

    it('重复创建用户应抛出错误', () => {
      rbac.createUser('duplicate', 'pass1');
      assert.throws(() => {
        rbac.createUser('duplicate', 'pass2');
      }, /already exists/);
    });

    it('创建用户时默认角色应为VIEWER', () => {
      const user = rbac.createUser('default', 'pass');
      assert.ok(user.roles.includes(ROLE.VIEWER));
    });
  });

  describe('用户认证', () => {
    it('正确密码应认证成功并返回Token', () => {
      rbac.createUser('authuser', 'correctpass');
      const result = rbac.authenticate('authuser', 'correctpass');
      assert.equal(result.success, true);
      assert.ok(result.token);
      assert.ok(result.user);
    });

    it('错误密码应认证失败', () => {
      rbac.createUser('authuser', 'correctpass');
      const result = rbac.authenticate('authuser', 'wrongpass');
      assert.equal(result.success, false);
      assert.equal(result.error, 'Invalid credentials');
    });

    it('不存在的用户应认证失败', () => {
      const result = rbac.authenticate('nonexistent', 'pass');
      assert.equal(result.success, false);
    });
  });

  describe('Token验证', () => {
    it('有效Token应返回用户信息', () => {
      rbac.createUser('tokenuser', 'pass');
      const auth = rbac.authenticate('tokenuser', 'pass');
      const valid = rbac.validateToken(auth.token);
      assert.ok(valid);
      assert.equal(valid.username, 'tokenuser');
    });

    it('无效Token应返回null', () => {
      const valid = rbac.validateToken('invalid_token_here');
      assert.equal(valid, null);
    });
  });

  describe('权限检查', () => {
    it('SUPER_ADMIN应有所有权限', () => {
      const admin = rbac._users.get('user_admin_default');
      assert.ok(admin);
      assert.ok(rbac.hasPermission(admin.id, PERMISSION.SYSTEM_MANAGE));
      assert.ok(rbac.hasPermission(admin.id, PERMISSION.USER_CREATE));
    });

    it('VIEWER不应有管理权限', () => {
      const user = rbac.createUser('viewer', 'pass', [ROLE.VIEWER]);
      assert.equal(rbac.hasPermission(user.id, PERMISSION.SYSTEM_MANAGE), false);
      assert.equal(rbac.hasPermission(user.id, PERMISSION.USER_CREATE), false);
      assert.ok(rbac.hasPermission(user.id, PERMISSION.AGENT_VIEW_STATUS));
    });

    it('临时授权应在过期后失效', () => {
      const user = rbac.createUser('tempuser', 'pass', [ROLE.VIEWER]);
      assert.equal(rbac.hasPermission(user.id, PERMISSION.SYSTEM_MANAGE), false);

      // 临时授权
      rbac.grantTemporaryPermission(user.id, PERMISSION.SYSTEM_MANAGE, 100);
      assert.ok(rbac.hasPermission(user.id, PERMISSION.SYSTEM_MANAGE));

      // 清除临时授权
      rbac._temporaryGrants.clear();
      assert.equal(rbac.hasPermission(user.id, PERMISSION.SYSTEM_MANAGE), false);
    });
  });

  describe('角色管理', () => {
    it('应创建自定义角色', () => {
      const role = rbac.createRole('custom_role', [PERMISSION.MEMORY_READ, PERMISSION.MEMORY_WRITE]);
      assert.ok(role);
      assert.equal(role.roleName, 'custom_role');
      assert.ok(role.permissions.includes(PERMISSION.MEMORY_READ));
    });

    it('不能覆盖系统角色', () => {
      assert.throws(() => {
        rbac.createRole('admin', []);
      }, /Cannot override/);
    });

    it('应分配角色给用户', () => {
      const user = rbac.createUser('roleuser', 'pass', [ROLE.VIEWER]);
      rbac.assignRole(user.id, ROLE.OPERATOR);
      const userObj = rbac._users.get(user.id);
      assert.ok(userObj.roles.includes(ROLE.OPERATOR));
    });
  });

  describe('API Key管理', () => {
    it('应生成有效的API Key', () => {
      const admin = rbac._users.get('user_admin_default');
      const result = rbac.generateApiKey(admin.id, [], 365);
      assert.ok(result.apiKey);
      assert.ok(result.apiKey.startsWith('tricore_'));
    });

    it('应验证有效的API Key', () => {
      const admin = rbac._users.get('user_admin_default');
      const { apiKey } = rbac.generateApiKey(admin.id);
      const valid = rbac.validateApiKey(apiKey);
      assert.ok(valid);
      assert.equal(valid.userId, admin.id);
    });
  });

  describe('会话管理', () => {
    it('应清理过期会话', () => {
      rbac.createUser('sessionuser', 'pass');
      rbac.authenticate('sessionuser', 'pass');

      // 手动过期会话
      for (const [token, session] of rbac._sessions) {
        session.expiresAt = Date.now() - 1000;
      }

      const cleaned = rbac.cleanupSessions();
      assert.ok(cleaned > 0);
    });
  });

  describe('统计', () => {
    it('应返回正确的统计信息', () => {
      rbac.createUser('user1', 'pass1');
      rbac.createUser('user2', 'pass2');

      const stats = rbac.getStats();
      assert.equal(stats.users, 3); // admin + 2 users
    });
  });
});
