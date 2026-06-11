/**
 * RAGEngine 单元测试
 * Phase 20: 检索增强生成引擎测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RAGEngine, CHUNK_STRATEGY, RETRIEVAL_MODE } = require('../../src/llm/rag-engine');

test('RAGEngine - 初始化', async (t) => {
  await t.test('默认配置', () => {
    const rag = new RAGEngine();
    assert.ok(rag);
  });

  await t.test('自定义配置', () => {
    const rag = new RAGEngine({
      chunkSize: 500,
      chunkOverlap: 100,
      chunkStrategy: CHUNK_STRATEGY.FIXED,
      retrievalMode: RETRIEVAL_MODE.SEMANTIC,
      topK: 10,
      rerankEnabled: false,
    });
    assert.ok(rag);
  });
});

test('RAGEngine - 文档管理', async (t) => {
  const rag = new RAGEngine();

  await t.test('添加文档', async () => {
    const docId = await rag.addDocument({
      title: '测试文档',
      content: '这是一篇测试文档的内容，用于验证RAG引擎的文档管理功能。',
      metadata: { source: 'test' },
    });
    assert.ok(docId);
    assert.ok(typeof docId === 'string');
  });

  await t.test('列出文档', () => {
    const docs = rag.listDocuments();
    assert.ok(Array.isArray(docs));
  });

  await t.test('删除文档', async () => {
    const docId = await rag.addDocument({
      title: '待删除文档',
      content: '待删除的内容',
    });
    const removed = rag.removeDocument(docId);
    assert.ok(removed);
  });
});

test('RAGEngine - 检索', async (t) => {
  const rag = new RAGEngine({ topK: 3 });

  await t.test('添加文档后检索', async () => {
    rag.addDocument({ title: '天气', content: '今天北京的天气是晴天，气温25度。' });
    rag.addDocument({ title: '美食', content: '北京烤鸭是非常有名的传统美食。' });

    const results = await rag.retrieve('北京有什么好吃的', { topK: 2 });
    assert.ok(Array.isArray(results));
  });

  await t.test('无匹配时的检索', async () => {
    const results = await rag.retrieve('完全不相关的内容查询xyzabc123', { topK: 2 });
    assert.ok(Array.isArray(results));
  });
});

test('RAGEngine - 问答', async (t) => {
  const rag = new RAGEngine();

  await t.test('无LLM时的问答', async () => {
    rag.addDocument({ title: 'FAQ', content: 'TriCore Agent是一个三核融合智能体。' });
    const result = await rag.ask('什么是TriCore Agent？');
    assert.ok(result);
    // 无router时返回基于检索的结果
    assert.ok(result.answer !== undefined || result.error !== undefined);
  });
});

test('RAGEngine - 统计', async (t) => {
  const rag = new RAGEngine();

  await t.test('getStats', () => {
    const stats = rag.getStats();
    assert.ok(stats);
    assert.ok(stats.hasOwnProperty('documents'));
  });
});
