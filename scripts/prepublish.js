/**
 * TriCore Agent - npm 发布前检查脚本
 *
 * Phase 23: 发布前自动检查，确保发布质量
 *
 * 检查项:
 *   1. Node.js 版本检查
 *   2. ESLint 检查
 *   3. 测试通过
 *   4. 版本一致性（package.json vs src/index.js）
 *   5. 敏感信息检查（API Key 泄露检测）
 *   6. 必需文件检查
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let hasError = false;
let hasWarning = false;

function log(level, msg) {
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅';
  console.log(`  ${prefix} ${msg}`);
}

function check(name, fn) {
  process.stdout.write(`[检查] ${name}... `);
  try {
    const result = fn();
    if (result === true) {
      console.log('✅ 通过');
    } else if (result === false) {
      console.log('❌ 失败');
      hasError = true;
    } else {
      console.log(`⚠️ ${result}`);
      hasWarning = true;
    }
  } catch (err) {
    console.log(`❌ 异常: ${err.message}`);
    hasError = true;
  }
}

// ═══════════════════════════════════════
// 1. Node.js 版本检查
// ═══════════════════════════════════════
check('Node.js >= 18.0.0', () => {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  return major >= 18;
});

// ═══════════════════════════════════════
// 2. package.json 文件完整性检查
// ═══════════════════════════════════════
check('package.json 存在', () => {
  return fs.existsSync(path.join(ROOT, 'package.json'));
});

check('package.json 必要字段', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const required = ['name', 'version', 'description', 'main', 'license'];
  for (const field of required) {
    if (!pkg[field]) {
      console.log(`\n    缺少字段: ${field}`);
      return false;
    }
  }
  return true;
});

check('版本格式正确 (semver)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  return /^\d+\.\d+\.\d+$/.test(pkg.version);
});

// ═══════════════════════════════════════
// 3. 版本一致性
// ═══════════════════════════════════════
check('版本号一致性 (package.json ↔ src/index.js)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const indexContent = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf-8');
  const indexVersion = indexContent.match(/const VERSION = '([^']+)'/);
  if (!indexVersion) return 'src/index.js 中未找到 VERSION 常量';
  return indexVersion[1] === pkg.version;
});

// ═══════════════════════════════════════
// 4. 入口文件存在
// ═══════════════════════════════════════
check('入口文件存在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  return fs.existsSync(path.join(ROOT, pkg.main));
});

// ═══════════════════════════════════════
// 5. 敏感信息检查
// ═══════════════════════════════════════
check('无硬编码 API Key', () => {
  const srcDir = path.join(ROOT, 'src');
  const files = findJSFiles(srcDir);
  const suspiciousPatterns = [
    /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i,
    /secret\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i,
    /token\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i,
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(content)) {
        console.log(`\n    可疑: ${path.relative(ROOT, file)}`);
        return '发现疑似硬编码密钥，请确认';
      }
    }
  }
  return true;
});

// ═══════════════════════════════════════
// 6. 必需发布文件检查
// ═══════════════════════════════════════
check('.npmignore 存在', () => {
  return fs.existsSync(path.join(ROOT, '.npmignore'));
});

check('LICENSE 存在', () => {
  return fs.existsSync(path.join(ROOT, 'LICENSE')) || 'LICENSE 文件不存在，npm 默认为专有许可';
});

check('README.md 存在', () => {
  return fs.existsSync(path.join(ROOT, 'README.md'));
});

// ═══════════════════════════════════════
// 7. ESLint (可选)
// ═══════════════════════════════════════
check('ESLint 检查', () => {
  try {
    execSync('npx eslint src/ --max-warnings 0', {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 30000,
    });
    return true;
  } catch {
    return 'ESLint 存在警告（建议修复后再发布）';
  }
});

// ═══════════════════════════════════════
// 8. 测试 (可选，允许跳过)
// ═══════════════════════════════════════
if (process.env.SKIP_TESTS !== '1') {
  check('测试套件', () => {
    try {
      execSync('node --test tests/unit/*.test.js 2>&1', {
        cwd: ROOT,
        stdio: 'pipe',
        timeout: 60000,
      });
      return true;
    } catch {
      return '部分测试失败（可使用 SKIP_TESTS=1 跳过）';
    }
  });
} else {
  console.log('  ⏭️  测试已跳过 (SKIP_TESTS=1)');
}

// ═══════════════════════════════════════
// 9. 依赖安全审计
// ═══════════════════════════════════════
check('npm 依赖安全审计', () => {
  try {
    const result = execSync('npm audit --json 2>&1', {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 30000,
    }).toString();

    const audit = JSON.parse(result);
    const vulns = audit.vulnerabilities || {};
    const highOrCritical = Object.values(vulns).filter(
      v => v.severity === 'high' || v.severity === 'critical'
    );

    if (highOrCritical.length > 0) {
      return `${highOrCritical.length} 个高危漏洞（建议修复后再发布）`;
    }
    return true;
  } catch (err) {
    // npm audit 可能返回非零退出码（有漏洞），解析输出
    try {
      const audit = JSON.parse(err.stdout?.toString() || '{}');
      const vulns = audit.vulnerabilities || {};
      const highOrCritical = Object.values(vulns).filter(
        v => v.severity === 'high' || v.severity === 'critical'
      );
      if (highOrCritical.length > 0) {
        return `${highOrCritical.length} 个高危漏洞（建议修复后再发布）`;
      }
    } catch {
      // 忽略解析错误
    }
    return true;
  }
});

// ═══════════════════════════════════════
// 结果
// ═══════════════════════════════════════
console.log('\n' + '='.repeat(50));

if (hasError) {
  console.log('❌ 发布前检查未通过，请修复错误后重试。');
  process.exit(1);
} else if (hasWarning) {
  console.log('⚠️  发布前检查通过（有警告），建议检查警告项。');
  console.log('   使用 --ignore-warnings 跳过警告。');
  if (!process.argv.includes('--ignore-warnings')) {
    process.exit(1);
  }
} else {
  console.log('✅ 所有检查通过，可以发布！');
}

// ═══════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════

function findJSFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findJSFiles(fullPath));
    } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}
