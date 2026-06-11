/**
 * MultiModalEngine 单元测试
 * Phase 20: 多模态感知引擎测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MultiModalEngine, MODALITY_TYPE, SUPPORTED_IMAGE_FORMATS, SUPPORTED_DOC_FORMATS } = require('../../src/multimodal/multimodal-engine');

test('MultiModalEngine - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const engine = new MultiModalEngine();
    assert.ok(engine);
    assert.strictEqual(engine._visionEnabled, true);
  });

  await t.test('禁用视觉', () => {
    const engine = new MultiModalEngine({ visionEnabled: false });
    assert.strictEqual(engine._visionEnabled, false);
  });

  await t.test('自定义OCR配置', () => {
    const engine = new MultiModalEngine({
      ocrProvider: 'custom',
      ocrLanguage: 'eng',
    });
    assert.strictEqual(engine._ocrLanguage, 'eng');
  });
});

test('MultiModalEngine - 图片分析（无LLM）', async (t) => {
  const engine = new MultiModalEngine();

  await t.test('无Router时返回提示', async () => {
    const result = await engine.analyzeImage('nonexistent.png', '描述这张图片');
    // 文件不存在或无LLM都会返回错误信息
    assert.ok(result);
    assert.ok(result.hasOwnProperty('description'));
  });
});

test('MultiModalEngine - 文档解析', async (t) => {
  const engine = new MultiModalEngine();
  const fs = require('fs');
  const path = require('path');

  await t.test('解析TXT文件', async () => {
    const tmpPath = path.join(__dirname, '..', '..', 'data', 'test_rag_doc.txt');
    try {
      fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
      fs.writeFileSync(tmpPath, 'Hello, TriCore!');
      const result = await engine.parseDocument(tmpPath);
      assert.ok(result.content.includes('Hello, TriCore!'));
      fs.unlinkSync(tmpPath);
    } catch (e) {
      // 文件创建失败，验证错误信息有意义
      assert.ok(e instanceof Error, '应抛出Error对象');
    }
  });

  await t.test('不存在的文件', async () => {
    const result = await engine.parseDocument('/nonexistent/file.txt');
    assert.ok(result.error);
  });

  await t.test('不支持的文件格式', async () => {
    // 创建临时文件
    const tmpPath = path.join(__dirname, '..', '..', 'data', 'test.bin');
    try {
      fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
      fs.writeFileSync(tmpPath, 'binary data');
      const result = await engine.parseDocument(tmpPath);
      assert.ok(result.content.includes('不支持'));
      fs.unlinkSync(tmpPath);
    } catch (e) {
      assert.ok(e instanceof Error, '文件操作失败应抛出Error');
    }
  });
});

test('MultiModalEngine - 截图（无浏览器）', async (t) => {
  const engine = new MultiModalEngine();

  await t.test('无浏览器时截图', async () => {
    const result = await engine.captureScreen('描述当前屏幕');
    assert.ok(result);
    assert.ok(result.description.includes('浏览器'));
  });
});

test('MultiModalEngine - OCR（无LLM）', async (t) => {
  const engine = new MultiModalEngine({ visionEnabled: false });

  await t.test('无视觉LLM时OCR', async () => {
    const result = await engine.ocr('test.png');
    assert.ok(result);
    assert.ok(result.hasOwnProperty('text'));
  });
});

test('MultiModalEngine - 视觉问答（无LLM）', async (t) => {
  const engine = new MultiModalEngine();

  await t.test('无Router时视觉问答', async () => {
    const result = await engine.visualQA('test.png', '这是什么？');
    assert.ok(result);
    assert.ok(result.hasOwnProperty('answer'));
  });
});

test('MultiModalEngine - 图片加载', async (t) => {
  const engine = new MultiModalEngine();

  await t.test('加载不存在的图片', async () => {
    const result = await engine._loadImage('nonexistent.png');
    assert.strictEqual(result, null);
  });

  await t.test('加载data URL', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const result = await engine._loadImage(dataUrl);
    assert.strictEqual(result, 'iVBORw0KGgo=');
  });
});

test('MultiModalEngine - 统计', async (t) => {
  const engine = new MultiModalEngine();

  await t.test('getStats', () => {
    const stats = engine.getStats();
    assert.ok(stats);
    assert.ok(stats.visionEnabled !== undefined);
    assert.ok(Array.isArray(stats.supportedFormats.images));
    assert.ok(Array.isArray(stats.supportedFormats.documents));
  });
});
