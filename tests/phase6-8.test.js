/**
 * TriCore Agent - Phase 6-8 测试套件
 *
 * 测试覆盖：
 *   Phase 6: 浏览器自动化 - 工具定义、URL验证、插件生成、状态
 *   Phase 7: 社交分发 + 语音系统 - 渠道配置、身份归一化、语音配置
 *   Phase 8: API服务器 - HTTP路由、SSE、访问控制
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');


// ═══════════════════════════════════════
// 测试：浏览器自动化（Phase 6）
// ═══════════════════════════════════════

async function testBrowserAutomation() {
  console.log('\n=== 测试浏览器自动化 (Phase 6) ===');

  const { BrowserAutomation, BROWSER_TOOLS, DEFAULT_CONFIG } = require('../src/execution/browser-automation');

  const browser = new BrowserAutomation({ headless: true });

  try {
    // Test 1: 工具定义完整性
    console.log('Test 1: 工具定义完整性...');
    const toolNames = Object.keys(BROWSER_TOOLS);
    assert.strictEqual(toolNames.length, 11, '应有11个浏览器工具');
    assert.ok(BROWSER_TOOLS.browser_navigate, '应有navigate工具');
    assert.ok(BROWSER_TOOLS.browser_screenshot, '应有screenshot工具');
    assert.ok(BROWSER_TOOLS.browser_click, '应有click工具');
    assert.ok(BROWSER_TOOLS.browser_fill, '应有fill工具');
    assert.ok(BROWSER_TOOLS.browser_select, '应有select工具');
    assert.ok(BROWSER_TOOLS.browser_extract, '应有extract工具');
    assert.ok(BROWSER_TOOLS.browser_search, '应有search工具');
    assert.ok(BROWSER_TOOLS.browser_download, '应有download工具');
    assert.ok(BROWSER_TOOLS.browser_go_back, '应有go_back工具');
    assert.ok(BROWSER_TOOLS.browser_get_url, '应有get_url工具');
    assert.ok(BROWSER_TOOLS.browser_wait, '应有wait工具');
    console.log(`  ✓ 11个浏览器工具定义完整`);

    // Test 2: 工具权限分级
    console.log('Test 2: 工具权限分级...');
    const safeTools = toolNames.filter(n => BROWSER_TOOLS[n].permission === 'safe');
    const moderateTools = toolNames.filter(n => BROWSER_TOOLS[n].permission === 'moderate');
    const dangerousTools = toolNames.filter(n => BROWSER_TOOLS[n].permission === 'dangerous');
    assert.ok(safeTools.length >= 5, `应有≥5个safe工具，实际: ${safeTools.length}`);
    assert.ok(moderateTools.length >= 3, `应有≥3个moderate工具，实际: ${moderateTools.length}`);
    assert.ok(dangerousTools.length >= 1, `应有≥1个dangerous工具，实际: ${dangerousTools.length}`);
    assert.strictEqual(BROWSER_TOOLS.browser_download.permission, 'dangerous', '下载应为dangerous');
    assert.strictEqual(BROWSER_TOOLS.browser_click.permission, 'moderate', '点击应为moderate');
    assert.strictEqual(BROWSER_TOOLS.browser_navigate.permission, 'safe', '导航应为safe');
    console.log(`  ✓ 权限分级: safe=${safeTools.length}, moderate=${moderateTools.length}, dangerous=${dangerousTools.length}`);

    // Test 3: URL安全验证 - 合法URL
    console.log('Test 3: URL安全验证 - 合法URL...');
    assert.doesNotThrow(() => browser._validateUrl('https://www.example.com'));
    assert.doesNotThrow(() => browser._validateUrl('http://example.org/path?q=test'));
    console.log('  ✓ 合法URL通过验证');

    // Test 4: URL安全验证 - 阻止内网地址
    console.log('Test 4: URL安全验证 - 阻止内网地址...');
    assert.throws(() => browser._validateUrl('http://127.0.0.1:3000'), /blocked/i);
    assert.throws(() => browser._validateUrl('http://localhost:8080'), /blocked/i);
    assert.throws(() => browser._validateUrl('http://192.168.1.1'), /blocked/i);
    assert.throws(() => browser._validateUrl('http://10.0.0.1'), /blocked/i);
    console.log('  ✓ 内网地址全部被阻止');

    // Test 5: URL安全验证 - 非法协议
    console.log('Test 5: URL安全验证 - 非法协议...');
    assert.throws(() => browser._validateUrl('ftp://example.com'), /not allowed/i);
    assert.throws(() => browser._validateUrl('file:///etc/passwd'), /not allowed/i);
    console.log('  ✓ 非HTTP协议被拒绝');

    // Test 6: URL安全验证 - 无效URL
    console.log('Test 6: URL安全验证 - 无效URL...');
    assert.throws(() => browser._validateUrl('not a url at all'), /Invalid URL/i);
    console.log('  ✓ 无效URL被拒绝');

    // Test 7: 插件生成
    console.log('Test 7: 插件生成...');
    const plugin = browser.toPlugin();
    assert.strictEqual(plugin.name, 'browser_automation');
    assert.strictEqual(plugin.version, '1.0.0');
    assert.strictEqual(plugin.tools.length, 11);
    assert.ok(plugin.tools.every(t => typeof t.handler === 'function'));
    console.log(`  ✓ 插件对象生成: ${plugin.name} v${plugin.version}, ${plugin.tools.length}个工具`);

    // Test 8: 默认配置
    console.log('Test 8: 默认配置...');
    assert.strictEqual(DEFAULT_CONFIG.headless, true);
    assert.strictEqual(DEFAULT_CONFIG.timeout, 30000);
    assert.strictEqual(DEFAULT_CONFIG.maxDownloadSize, 100 * 1024 * 1024);
    assert.ok(DEFAULT_CONFIG.blockedHosts.length > 0);
    console.log('  ✓ 默认配置验证通过');

    // Test 9: 初始状态
    console.log('Test 9: 初始状态...');
    const status = browser.getStatus();
    assert.strictEqual(status.initialized, false);
    assert.strictEqual(status.currentPage, null);
    assert.strictEqual(status.downloads, 0);
    assert.strictEqual(status.headless, true);
    console.log('  ✓ 浏览器初始状态正确');

    // Test 10: 未初始化时执行动作（Playwright未安装场景）
    console.log('Test 10: 未初始化时执行动作...');
    // 监听error事件防止Unhandled error
    const initErrors = [];
    browser.on('error', (err) => initErrors.push(err));
    const result = await browser.execute('browser_navigate', { url: 'https://example.com' });
    // Playwright可能未安装，应返回error而不是崩溃
    assert.ok(result.error !== undefined || result.url !== undefined, '应返回error或url');
    console.log(`  ✓ 未初始化执行结果: ${result.error ? 'error(预期)' : 'success'}`);
    if (initErrors.length > 0) {
      console.log(`  ✓ 捕获init错误事件: ${initErrors[0].phase}`);
    }

    // Test 11: 未知动作
    console.log('Test 11: 未知动作...');
    // 需要先模拟已初始化
    browser._initialized = true;
    browser._page = { goto: async () => {}, title: async () => '' };
    const unknownResult = await browser.execute('browser_unknown', {});
    assert.ok(unknownResult.error);
    assert.ok(unknownResult.error.includes('Unknown'));
    browser._initialized = false;
    browser._page = null;
    console.log('  ✓ 未知动作返回错误');

    console.log('\n✅ 浏览器自动化测试全部通过！');
  } finally {
    await browser.close();
  }
}


// ═══════════════════════════════════════
// 测试：社交分发（Phase 7前半）
// ═══════════════════════════════════════

async function testSocialDispatch() {
  console.log('\n=== 测试社交分发 (Phase 7) ===');

  const { SocialDispatch, CHANNEL, MSG_TYPE, BaseConnector } = require('../src/social/social-dispatch');

  const dispatch = new SocialDispatch();

  try {
    // Test 1: 渠道常量
    console.log('Test 1: 渠道常量...');
    assert.strictEqual(CHANNEL.API, 'api');
    assert.strictEqual(CHANNEL.DISCORD, 'discord');
    assert.strictEqual(CHANNEL.WECHAT_CLAWBOT, 'wechat_clawbot');
    assert.strictEqual(CHANNEL.WECHAT_OFFICIAL, 'wechat_official');
    assert.strictEqual(CHANNEL.FEISHU, 'feishu');
    assert.strictEqual(CHANNEL.WECOM, 'wecom');
    console.log('  ✓ 6个渠道常量定义正确');

    // Test 2: 消息类型
    console.log('Test 2: 消息类型...');
    assert.strictEqual(MSG_TYPE.TEXT, 'text');
    assert.strictEqual(MSG_TYPE.IMAGE, 'image');
    assert.strictEqual(MSG_TYPE.VOICE, 'voice');
    assert.strictEqual(MSG_TYPE.FILE, 'file');
    console.log('  ✓ 4个消息类型定义正确');

    // Test 3: 渠道配置
    console.log('Test 3: 渠道配置...');
    const configuredChannels = [];
    dispatch.on('channel_configured', ({ channel }) => configuredChannels.push(channel));

    dispatch.configure(CHANNEL.DISCORD, { botToken: 'test_token' });
    dispatch.configure(CHANNEL.FEISHU, { appId: 'test_app', appSecret: 'test_secret' });
    assert.strictEqual(configuredChannels.length, 2);
    assert.ok(configuredChannels.includes(CHANNEL.DISCORD));
    assert.ok(configuredChannels.includes(CHANNEL.FEISHU));
    console.log('  ✓ 渠道配置成功，事件触发正常');

    // Test 4: 目标地址解析
    console.log('Test 4: 目标地址解析...');
    const parsed1 = dispatch._parseTarget('discord:user123');
    assert.strictEqual(parsed1.channel, 'discord');
    assert.strictEqual(parsed1.recipientId, 'user123');

    const parsed2 = dispatch._parseTarget('wechat_clawbot:wx_id_456');
    assert.strictEqual(parsed2.channel, 'wechat_clawbot');
    assert.strictEqual(parsed2.recipientId, 'wx_id_456');

    const parsed3 = dispatch._parseTarget('invalid_no_colon');
    assert.strictEqual(parsed3, null);
    console.log('  ✓ 目标地址解析正确');

    // Test 5: 身份归一化
    console.log('Test 5: 身份归一化...');
    const id1 = dispatch._normalizeIdentity('discord', 'user123');
    assert.strictEqual(id1, 'discord:user123');
    // 第二次相同调用应返回相同规范ID
    const id2 = dispatch._normalizeIdentity('discord', 'user123');
    assert.strictEqual(id2, id1);
    console.log('  ✓ 身份归一化正常');

    // Test 6: 跨平台身份绑定
    console.log('Test 6: 跨平台身份绑定...');
    dispatch.bindIdentity('discord', 'user123', 'feishu', 'feishu_user_456');
    const crossId = dispatch._normalizeIdentity('feishu', 'feishu_user_456');
    assert.strictEqual(crossId, 'discord:user123', '绑定后飞书ID应映射到Discord规范ID');
    console.log('  ✓ 跨平台身份绑定正常');

    // Test 7: 消息回调
    console.log('Test 7: 消息回调...');
    let receivedMsg = null;
    dispatch.onMessage((msg) => { receivedMsg = msg; });
    // 模拟入站消息
    dispatch._handleIncomingMessage('discord', {
      id: 'msg_001',
      fromId: 'user789',
      content: '你好，TriCore！',
      type: MSG_TYPE.TEXT,
    });
    assert.ok(receivedMsg);
    assert.strictEqual(receivedMsg.content, '你好，TriCore！');
    assert.strictEqual(receivedMsg.channel, 'discord');
    assert.strictEqual(receivedMsg.from, 'discord:user789');
    console.log('  ✓ 入站消息处理正常');

    // Test 8: 消息接收事件
    console.log('Test 8: 消息接收事件...');
    let eventMsg = null;
    dispatch.on('message_received', (msg) => { eventMsg = msg; });
    dispatch._handleIncomingMessage('feishu', {
      fromId: 'feishu_user',
      content: '飞书消息测试',
    });
    assert.ok(eventMsg);
    assert.strictEqual(eventMsg.channel, 'feishu');
    console.log('  ✓ 消息接收事件正常');

    // Test 9: 分发到未配置渠道
    console.log('Test 9: 分发到未配置渠道...');
    const result = await dispatch.dispatch('wecom:user1', '测试消息');
    assert.ok(result.error);
    assert.ok(result.error.includes('No active connector'));
    console.log('  ✓ 未配置渠道正确返回错误');

    // Test 10: 无效目标格式
    console.log('Test 10: 无效目标格式...');
    const badResult = await dispatch.dispatch('invalidformat', '测试消息');
    assert.ok(badResult.error);
    assert.ok(badResult.error.includes('Invalid target'));
    console.log('  ✓ 无效目标格式正确返回错误');

    // Test 11: 广播到无活跃连接器
    console.log('Test 11: 广播到无活跃连接器...');
    const broadcastResults = await dispatch.broadcast('广播测试');
    assert.ok(Array.isArray(broadcastResults));
    console.log(`  ✓ 广播返回 ${broadcastResults.length} 个结果`);

    // Test 12: 状态查询
    console.log('Test 12: 状态查询...');
    const status = dispatch.getStatus();
    assert.ok(status.connectors);
    assert.ok(typeof status.identityMappings === 'number');
    console.log(`  ✓ 状态: ${Object.keys(status.connectors).length}个渠道, ${status.identityMappings}个身份映射`);

    // Test 13: 启动连接器 - 缺少必要配置
    console.log('Test 13: 连接器启动 - 缺少配置...');
    const dispatch2 = new SocialDispatch();
    dispatch2.configure(CHANNEL.DISCORD, {}); // 无botToken
    const startErrors = [];
    dispatch2.on('connector_error', ({ channel, error }) => startErrors.push({ channel, error }));
    await dispatch2.startAll();
    assert.ok(startErrors.length > 0, '缺少botToken应报错');
    assert.ok(startErrors[0].error.includes('botToken'));
    console.log('  ✓ 缺少配置正确报错');

    console.log('\n✅ 社交分发测试全部通过！');
  } finally {
    await dispatch.stopAll();
  }
}


// ═══════════════════════════════════════
// 测试：语音系统（Phase 7后半）
// ═══════════════════════════════════════

async function testVoiceSystem() {
  console.log('\n=== 测试语音系统 (Phase 7) ===');

  const { VoiceSystem, ASR_PROVIDER, TTS_PROVIDER } = require('../src/voice/voice-system');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-voice-'));
  const voice = new VoiceSystem({ audioDir: tmpDir });

  try {
    // Test 1: ASR Provider常量
    console.log('Test 1: ASR Provider常量...');
    assert.strictEqual(ASR_PROVIDER.LOCAL_WHISPER, 'local_whisper');
    assert.strictEqual(ASR_PROVIDER.ALIYUN, 'aliyun');
    console.log('  ✓ ASR Provider定义正确');

    // Test 2: TTS Provider常量
    console.log('Test 2: TTS Provider常量...');
    assert.strictEqual(TTS_PROVIDER.DOUBAO, 'doubao');
    assert.strictEqual(TTS_PROVIDER.MINIMAX, 'minimax');
    assert.strictEqual(TTS_PROVIDER.OPENAI, 'openai');
    assert.strictEqual(TTS_PROVIDER.ELEVENLABS, 'elevenlabs');
    console.log('  ✓ TTS Provider定义正确');

    // Test 3: 默认配置
    console.log('Test 3: 默认配置...');
    assert.strictEqual(voice._asrProvider, ASR_PROVIDER.LOCAL_WHISPER);
    assert.strictEqual(voice._ttsProvider, TTS_PROVIDER.DOUBAO);
    assert.strictEqual(voice._whisperModel, 'base');
    console.log('  ✓ 默认配置正确');

    // Test 4: ASR配置切换
    console.log('Test 4: ASR配置切换...');
    voice.configureASR(ASR_PROVIDER.ALIYUN, { aliyunApiKey: 'test_key' });
    assert.strictEqual(voice._asrProvider, ASR_PROVIDER.ALIYUN);
    assert.strictEqual(voice._aliyunApiKey, 'test_key');
    console.log('  ✓ ASR配置切换成功');

    // Test 5: TTS配置切换
    console.log('Test 5: TTS配置切换...');
    voice.configureTTS(TTS_PROVIDER.OPENAI, {
      voiceId: 'nova',
      openaiApiKey: 'sk-test-key',
    });
    assert.strictEqual(voice._ttsProvider, TTS_PROVIDER.OPENAI);
    assert.strictEqual(voice._ttsVoiceId, 'nova');
    assert.strictEqual(voice._openaiApiKey, 'sk-test-key');
    console.log('  ✓ TTS配置切换成功');

    // Test 6: ASR - 文件不存在
    console.log('Test 6: ASR - 文件不存在...');
    const asrResult = await voice.recognize('/nonexistent/audio.wav');
    assert.ok(asrResult.error);
    assert.ok(asrResult.error.includes('not found'));
    console.log('  ✓ 不存在的音频文件正确返回错误');

    // Test 7: TTS - 无API Key
    console.log('Test 7: TTS - 无API Key...');
    voice.configureTTS(TTS_PROVIDER.OPENAI, { openaiApiKey: null });
    const ttsResult = await voice.synthesize('测试文本');
    assert.ok(ttsResult.error);
    assert.ok(ttsResult.error.includes('not configured') || ttsResult.error.includes('key'));
    console.log('  ✓ 无API Key正确返回错误');

    // Test 8: TTS - 豆包无Key
    console.log('Test 8: TTS - 豆包无Key...');
    voice.configureTTS(TTS_PROVIDER.DOUBAO, {});
    const doubaoResult = await voice.synthesize('测试文本');
    assert.ok(doubaoResult.error);
    console.log('  ✓ 豆包无Key正确返回错误');

    // Test 9: 音频目录自动创建
    console.log('Test 9: 音频目录自动创建...');
    const newAudioDir = path.join(tmpDir, 'new_audio_dir');
    const voice2 = new VoiceSystem({ audioDir: newAudioDir });
    assert.strictEqual(voice2._audioDir, newAudioDir);
    console.log('  ✓ 音频目录配置正确');

    // Test 10: 状态查询
    console.log('Test 10: 状态查询...');
    const status = voice.getStatus();
    assert.ok(status.asrProvider);
    assert.ok(status.ttsProvider);
    assert.strictEqual(typeof status.asrReady, 'boolean');
    assert.strictEqual(typeof status.ttsReady, 'boolean');
    console.log(`  ✓ ASR: ${status.asrProvider} (ready: ${status.asrReady}), TTS: ${status.ttsProvider} (ready: ${status.ttsReady})`);

    // Test 11: 未实现的TTS Provider
    console.log('Test 11: 未实现的TTS Provider...');
    const miniMaxResult = await voice.synthesize('测试', { provider: TTS_PROVIDER.MINIMAX });
    assert.ok(miniMaxResult.error);
    assert.ok(miniMaxResult.error.includes('not yet implemented'));
    console.log('  ✓ 未实现的Provider正确返回错误');

    // Test 12: 未知的ASR Provider
    console.log('Test 12: ASR - 未知Provider...');
    voice._asrProvider = 'unknown_provider';
    // 创建一个临时音频文件
    const tmpAudio = path.join(tmpDir, 'test.wav');
    fs.writeFileSync(tmpAudio, 'fake audio');
    const unknownAsrResult = await voice.recognize(tmpAudio);
    assert.ok(unknownAsrResult.error);
    assert.ok(unknownAsrResult.error.includes('Unknown'));
    voice._asrProvider = ASR_PROVIDER.LOCAL_WHISPER; // 恢复
    console.log('  ✓ 未知ASR Provider正确返回错误');

    console.log('\n✅ 语音系统测试全部通过！');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 测试：API服务器（Phase 8）
// ═══════════════════════════════════════

async function testApiServer() {
  console.log('\n=== 测试API服务器 (Phase 8) ===');

  const { ApiServer } = require('../src/api/api-server');

  // 使用随机端口避免冲突
  const testPort = 13000 + Math.floor(Math.random() * 1000);
  const server = new ApiServer({ port: testPort, host: '127.0.0.1' });

  try {
    // Test 1: 启动服务器
    console.log('Test 1: 启动服务器...');
    await server.start();
    const status = server.getStatus();
    assert.strictEqual(status.running, true);
    assert.strictEqual(status.port, testPort);
    console.log(`  ✓ API服务器启动于端口 ${testPort}`);

    // 辅助函数：发起HTTP请求
    const request = (method, path, body = null) => {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: '127.0.0.1',
          port: testPort,
          path,
          method,
          headers: { 'Content-Type': 'application/json' },
        };
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode, body: JSON.parse(data), headers: res.headers });
            } catch {
              resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
            }
          });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    };

    // Test 2: GET /status
    console.log('Test 2: GET /status...');
    const statusRes = await request('GET', '/status');
    assert.strictEqual(statusRes.statusCode, 200);
    assert.ok(statusRes.body.running !== undefined);
    console.log('  ✓ /status 返回200');

    // Test 3: GET /quota
    console.log('Test 3: GET /quota...');
    const quotaRes = await request('GET', '/quota');
    assert.strictEqual(quotaRes.statusCode, 200);
    assert.ok(quotaRes.body.quota);
    console.log('  ✓ /quota 返回200');

    // Test 4: POST /message - 缺少content
    console.log('Test 4: POST /message - 缺少content...');
    const badMsgRes = await request('POST', '/message', {});
    assert.strictEqual(badMsgRes.statusCode, 400);
    assert.ok(badMsgRes.body.error);
    console.log('  ✓ 缺少content返回400');

    // Test 5: POST /message - 正常
    console.log('Test 5: POST /message - 正常...');
    const msgRes = await request('POST', '/message', {
      content: '你好TriCore',
      from: 'test_user',
    });
    assert.strictEqual(msgRes.statusCode, 200);
    // 无agent时messageId为null，但status应为queued
    assert.ok(msgRes.body.status === 'queued' || msgRes.body.messageId === null);
    console.log('  ✓ /message 正常返回200');

    // Test 6: POST /tasks - 缺少goal
    console.log('Test 6: POST /tasks - 缺少goal...');
    const badTaskRes = await request('POST', '/tasks', {});
    assert.strictEqual(badTaskRes.statusCode, 400);
    console.log('  ✓ 缺少goal返回400');

    // Test 7: POST /tasks - 正常（无agent）
    console.log('Test 7: POST /tasks - 正常（无agent）...');
    const taskRes = await request('POST', '/tasks', { goal: '测试任务' });
    assert.strictEqual(taskRes.statusCode, 200);
    console.log('  ✓ /tasks 正常返回200');

    // Test 8: GET /memories
    console.log('Test 8: GET /memories...');
    const memRes = await request('GET', '/memories');
    assert.strictEqual(memRes.statusCode, 200);
    console.log('  ✓ /memories 返回200');

    // Test 9: GET /memories?q=搜索
    console.log('Test 9: GET /memories?q=搜索...');
    const memSearchRes = await request('GET', '/memories?q=test');
    assert.strictEqual(memSearchRes.statusCode, 200);
    console.log('  ✓ /memories?q= 返回200');

    // Test 10: GET /skills
    console.log('Test 10: GET /skills...');
    const skillRes = await request('GET', '/skills');
    assert.strictEqual(skillRes.statusCode, 200);
    console.log('  ✓ /skills 返回200');

    // Test 11: GET /tasks
    console.log('Test 11: GET /tasks...');
    const tasksRes = await request('GET', '/tasks');
    assert.strictEqual(tasksRes.statusCode, 200);
    console.log('  ✓ /tasks 返回200');

    // Test 12: GET /conversations
    console.log('Test 12: GET /conversations...');
    const convRes = await request('GET', '/conversations');
    assert.strictEqual(convRes.statusCode, 200);
    console.log('  ✓ /conversations 返回200');

    // Test 13: POST /voice/tts - 缺少text
    console.log('Test 13: POST /voice/tts - 缺少text...');
    const badTtsRes = await request('POST', '/voice/tts', {});
    assert.strictEqual(badTtsRes.statusCode, 400);
    console.log('  ✓ 缺少text返回400');

    // Test 14: POST /voice/tts - 正常
    console.log('Test 14: POST /voice/tts - 正常...');
    const ttsRes = await request('POST', '/voice/tts', { text: '测试语音合成' });
    assert.strictEqual(ttsRes.statusCode, 200);
    console.log('  ✓ /voice/tts 正常返回200');

    // Test 15: POST /activate - 缺少apiKey
    console.log('Test 15: POST /activate - 缺少apiKey...');
    const badActRes = await request('POST', '/activate', {});
    assert.strictEqual(badActRes.statusCode, 400);
    console.log('  ✓ 缺少apiKey返回400');

    // Test 16: 404路由
    console.log('Test 16: 404路由...');
    const notFoundRes = await request('GET', '/nonexistent');
    assert.strictEqual(notFoundRes.statusCode, 404);
    console.log('  ✓ 未知路由返回404');

    // Test 17: OPTIONS CORS
    console.log('Test 17: OPTIONS CORS...');
    const corsRes = await request('OPTIONS', '/status');
    assert.strictEqual(corsRes.statusCode, 204);
    console.log('  ✓ CORS预检返回204');

    // Test 18: SSE事件流
    console.log('Test 18: SSE事件流...');
    const sseStatus = server.getStatus();
    assert.strictEqual(sseStatus.sseClients, 0);
    console.log('  ✓ SSE客户端初始为0');

    // Test 19: 管理接口
    console.log('Test 19: 管理接口...');
    const stopRes = await request('POST', '/admin/stop');
    assert.strictEqual(stopRes.statusCode, 200);
    const startRes = await request('POST', '/admin/start');
    assert.strictEqual(startRes.statusCode, 200);
    console.log('  ✓ 管理接口stop/start正常');

    // Test 20: GET /settings
    console.log('Test 20: GET /settings...');
    const settingsRes = await request('GET', '/settings');
    assert.strictEqual(settingsRes.statusCode, 200);
    console.log('  ✓ /settings 返回200');

    // Test 21: SSE广播
    console.log('Test 21: SSE广播...');
    server.broadcastEvent('test_event', { message: 'hello' });
    console.log('  ✓ broadcastEvent不抛异常');

    // Test 22: 停止服务器
    console.log('Test 22: 停止服务器...');
    server.stop();
    const stoppedStatus = server.getStatus();
    assert.strictEqual(stoppedStatus.running, false);
    console.log('  ✓ API服务器停止成功');

    console.log('\n✅ API服务器测试全部通过！');
  } catch (error) {
    server.stop();
    throw error;
  }
}


// ═══════════════════════════════════════
// 测试：API访问控制
// ═══════════════════════════════════════

async function testApiAccessControl() {
  console.log('\n=== 测试API访问控制 ===');

  const { ApiServer } = require('../src/api/api-server');

  const testPort = 14000 + Math.floor(Math.random() * 1000);
  const apiToken = 'test_secret_token_123';

  const server = new ApiServer({
    port: testPort,
    host: '0.0.0.0',  // 监听所有接口以便测试
    apiToken,
    allowLan: true,
  });

  try {
    // Test 1: 启动带Token的服务器
    console.log('Test 1: 启动带Token的服务器...');
    await server.start();
    console.log(`  ✓ 服务器启动于端口 ${testPort}, Token: ${apiToken.substring(0, 10)}...`);

    const request = (method, path, body = null, headers = {}) => {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: '127.0.0.1',
          port: testPort,
          path,
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
        };
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ statusCode: res.statusCode, body: data });
            }
          });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    };

    // Test 2: 回环地址自动允许
    console.log('Test 2: 回环地址自动允许...');
    const loopbackRes = await request('GET', '/status');
    assert.strictEqual(loopbackRes.statusCode, 200);
    console.log('  ✓ 127.0.0.1 回环地址允许访问');

    // Test 3: Token验证状态
    console.log('Test 3: 配置验证...');
    const status = server.getStatus();
    assert.strictEqual(status.allowLan, true);
    console.log('  ✓ LAN访问已开启');

    // Test 4: _isAllowed方法验证
    console.log('Test 4: _isAllowed逻辑...');
    // 模拟外部请求（非回环）
    const fakeReq = { socket: { remoteAddress: '203.0.113.1' }, headers: {} };
    assert.strictEqual(server._isAllowed(fakeReq), false, '外部IP无Token应拒绝');
    // 带Token
    const fakeReqWithToken = { socket: { remoteAddress: '203.0.113.1' }, headers: { authorization: `Bearer ${apiToken}` } };
    assert.strictEqual(server._isAllowed(fakeReqWithToken), true, '外部IP带Token应允许');
    // 错误Token
    const fakeReqBadToken = { socket: { remoteAddress: '203.0.113.1' }, headers: { authorization: 'Bearer wrong_token' } };
    assert.strictEqual(server._isAllowed(fakeReqBadToken), false, '错误Token应拒绝');
    console.log('  ✓ 访问控制逻辑正确');

    server.stop();
    console.log('\n✅ API访问控制测试全部通过！');
  } catch (error) {
    server.stop();
    throw error;
  }
}


// ═══════════════════════════════════════
// 测试：Phase 6-8 集成
// ═══════════════════════════════════════

async function testPhase6To8Integration() {
  console.log('\n=== 测试Phase 6-8集成 ===');

  const { TriCoreAgent, VERSION } = require('../src/index');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricore-p68-'));
  const agent = new TriCoreAgent({ dataDir: tmpDir, awakeningTicks: 2 });

  try {
    // Test 1: Agent包含新模块
    console.log('Test 1: Agent包含新模块...');
    assert.ok(agent._browser, '应有browser实例');
    assert.ok(agent._social, '应有social实例');
    assert.ok(agent._voice, '应有voice实例');
    assert.ok(agent._apiServer, '应有apiServer实例');
    console.log('  ✓ 四个新模块实例化成功');

    // Test 2: 版本号确认
    console.log('Test 2: 版本号确认...');
    assert.ok(VERSION.startsWith('0.3') || VERSION.startsWith('1.0'), `版本应为0.3.x或1.0.x，实际: ${VERSION}`);
    console.log(`  ✓ 当前版本: v${VERSION}`);

    // Test 3: 浏览器自动化集成
    console.log('Test 3: 浏览器自动化集成...');
    const browserStatus = agent._browser.getStatus();
    assert.strictEqual(browserStatus.initialized, false);
    console.log('  ✓ 浏览器模块集成，初始状态正确');

    // Test 4: 社交分发集成
    console.log('Test 4: 社交分发集成...');
    const socialStatus = agent._social.getStatus();
    assert.ok(socialStatus.connectors);
    console.log('  ✓ 社交分发模块集成');

    // Test 5: 语音系统集成
    console.log('Test 5: 语音系统集成...');
    const voiceStatus = agent._voice.getStatus();
    assert.ok(voiceStatus.asrProvider);
    assert.ok(voiceStatus.ttsProvider);
    console.log(`  ✓ 语音模块集成: ASR=${voiceStatus.asrProvider}, TTS=${voiceStatus.ttsProvider}`);

    // Test 6: API服务器集成
    console.log('Test 6: API服务器集成...');
    const apiStatus = agent._apiServer.getStatus();
    assert.ok(typeof apiStatus.port === 'number');
    console.log(`  ✓ API模块集成: 端口=${apiStatus.port}`);

    // Test 7: browserAction方法
    console.log('Test 7: browserAction方法...');
    agent._browser.on('error', () => {}); // 捕获init error事件
    const browserResult = await agent.browserAction('browser_navigate', { url: 'https://example.com' });
    assert.ok(browserResult.error || browserResult.url, '应返回error或url');
    console.log('  ✓ browserAction方法可用');

    // Test 8: 语音方法
    console.log('Test 8: 语音方法...');
    const asrResult = await agent.recognizeSpeech('/nonexistent.wav');
    assert.ok(asrResult.error, '不存在的文件应返回错误');
    console.log('  ✓ 语音识别方法可用');

    // Test 9: 社交分发方法
    console.log('Test 9: 社交分发方法...');
    const dispatchResult = await agent.dispatchMessage('api:user1', '测试');
    // 无连接器应返回错误
    assert.ok(dispatchResult.error);
    console.log('  ✓ 社交分发方法可用');

    // Test 10: 社交配置方法
    console.log('Test 10: 社交配置方法...');
    agent.configureSocial('discord', { botToken: 'test' });
    const updatedStatus = agent._social.getStatus();
    assert.ok(updatedStatus.connectors.discord);
    console.log('  ✓ 社交配置方法可用');

    // Test 11: 语音配置方法
    console.log('Test 11: 语音配置方法...');
    // synthesizeSpeech 应返回错误（无API Key）
    const ttsResult = await agent.synthesizeSpeech('测试');
    assert.ok(ttsResult.error, '无Key应返回错误');
    console.log('  ✓ 语音合成方法可用');

    // Test 12: 完整状态包含新模块
    console.log('Test 12: 完整状态包含新模块...');
    // 需要先初始化memory，否则getStatus()会报错
    agent._memory.init();
    agent._running = true;
    const fullStatus = agent.getStatus();
    assert.ok(fullStatus.browser, '状态应含browser');
    assert.ok(fullStatus.social, '状态应含social');
    assert.ok(fullStatus.voice, '状态应含voice');
    assert.ok(fullStatus.api, '状态应含api');
    console.log('  ✓ 完整状态包含所有新模块');

    // 清理
    agent._evolution.stopConsolidationLoop();
    agent._running = false;
    agent._memory.close();

    console.log('\n✅ Phase 6-8集成测试全部通过！');
  } finally {
    try {
      agent._evolution.stopConsolidationLoop();
      agent._memory.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


// ═══════════════════════════════════════
// 运行所有测试
// ═══════════════════════════════════════

async function runAllTests() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   TriCore Agent Phase 6-8 测试套件    ║');
  console.log('╚══════════════════════════════════════╝');

  try {
    await testBrowserAutomation();     // Phase 6: 11项
    await testSocialDispatch();        // Phase 7前半: 13项
    await testVoiceSystem();           // Phase 7后半: 12项
    await testApiServer();             // Phase 8: 22项
    await testApiAccessControl();      // Phase 8安全: 4项
    await testPhase6To8Integration();  // 集成: 12项

    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   ✅ 全部Phase 6-8测试通过！          ║');
    console.log('║   共计: 74项测试                      ║');
    console.log('╚══════════════════════════════════════╝');
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runAllTests();
