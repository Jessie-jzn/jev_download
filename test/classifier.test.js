import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classifier.js';
import { TypeSafeClient } from '@typesafe-ai/sdk';

test('uses SDK choice with metadata only and preserves actual confidence', async () => {
  const client = { systemOne: async request => {
    assert.equal(request.state.item.name, '摄影课');
    assert.equal(request.state.item.path, undefined);
    assert.equal(request.questions.category.type, 'choice');
    return { answers: { category: { choice: '学习', confidence: 0.42 } } };
  } };
  const results = await classify([{ id: '1', name: '摄影课', samples: ['lesson.mp4'], path: '/private' }], client);
  assert.equal(results[0].category, '学习');
  assert.equal(results[0].confidence, 0.42);
});

test('invalid SDK answers and request failures remain unclassified', async () => {
  const results = await classify([{ id: '1', name: 'A', samples: [] }], {
    systemOne: async () => ({ answers: { category: { choice: '../bad', confidence: 1 } } })
  });
  assert.equal(results[0].category, null);
  assert.ok(results[0].error);
});

test('actual SDK serializes a valid request and parses its typed response', async () => {
  const client = new TypeSafeClient({ apiKey: 'test-only', retry: { maxRetries: 0 }, fetch: async (url, init) => {
    assert.ok(url.endsWith('/v1/systemone'));
    const payload = JSON.parse(init.body);
    assert.equal(payload.questions.category.type, 'choice');
    assert.ok(payload.questions.category.criteria['工作']);
    assert.deepEqual(payload.state, { item: { name: '客户项目', type: 'folder', samples: ['合同.pdf'] } });
    return new Response(JSON.stringify({ model: 'jev-latest', answers: { category: {
      type: 'choice', choice: '工作', confidence: 0.95, probabilities: { 工作: 0.98, 其他: 0.02 }
    } }, usage: { input_tokens: 30, output_tokens: 20 } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const [result] = await classify([{ id: '1', name: '客户项目', samples: ['合同.pdf'] }], client);
  assert.equal(result.category, '工作');
  assert.equal(result.confidence, 0.95);
});

test('provider failure never returns a fabricated category or confidence', async () => {
  const [result] = await classify([{ id: '1', name: 'A', samples: [] }], {
    systemOne: async () => { throw new Error('provider failure with private information'); }
  });
  assert.equal(result.category, null);
  assert.equal(result.confidence, null);
  assert.ok(!result.error.includes('private information'));
});

test('file classification sends metadata but never reads or sends file contents', async () => {
  const client = { systemOne: async request => {
    assert.deepEqual(request.state, { item: { name: '客户合同.pdf', type: 'file', samples: [], extension: '.pdf', sizeBytes: 2048 } });
    assert.equal(JSON.stringify(request).includes('secret document contents'), false);
    return { answers: { category: { choice: '工作', confidence: 0.88 } } };
  } };
  const [result] = await classify([{ id: 'file-1', name: '客户合同.pdf', type: 'file', extension: '.pdf', sizeBytes: 2048, samples: [] }], client);
  assert.deepEqual(result, { id: 'file-1', category: '工作', confidence: 0.88 });
});
