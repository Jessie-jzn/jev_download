import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';

test('scan, manually categorize, confirm a real move, then undo through the browser', async ({ page }, testInfo) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-browser-'));
  const root = path.join(temp, '待整理');
  let picks = 0;
  const server = createApp({ dataDir: path.join(temp, 'data'), chooseFolder: async () => picks++ ? null : root });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    for (const name of ['摄影入门课程', '夏日旅行照片', '客户网站项目']) await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.writeFile(path.join(root, '摄影入门课程', '第一课.mp4'), 'test fixture');
    await fs.writeFile(path.join(root, '课程安排.pdf'), 'file fixture');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#app-root [data-react-app]')).toBeVisible();
    await expect(page.locator('#scan-button')).toBeEnabled();
    await page.locator('#pick-folder').click();
    await expect(page.locator('#root')).toHaveValue(root);
    await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(4);
    await page.locator('#pick-folder').click();
    await expect(page.locator('#notice')).toContainText('已取消选择');
    await expect(page.locator('#folder-rows tr')).toHaveCount(4);
    const row = page.locator('#folder-rows tr').filter({ hasText: '摄影入门课程' });
    await row.locator('select').selectOption('学习');
    await expect(row.locator('.destination')).toHaveText('学习 / 摄影入门课程');
    const fileRow = page.locator('#folder-rows tr').filter({ hasText: '课程安排.pdf' });
    await expect(fileRow).toContainText('文件 · PDF');
    await fileRow.locator('select').selectOption('学习');
    await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
    await page.locator('#move').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('已移动 2 个');
    expect(await fs.readFile(path.join(root, '学习', '摄影入门课程', '第一课.mp4'), 'utf8')).toBe('test fixture');
    expect(await fs.readFile(path.join(root, '学习', '课程安排.pdf'), 'utf8')).toBe('file fixture');
    await page.locator('#nav-history').click();
    await page.getByRole('button', { name: '撤销此批次' }).click();
    await expect(page.locator('#history-notice')).toContainText('撤销完成');
    expect(await fs.readFile(path.join(root, '摄影入门课程', '第一课.mp4'), 'utf8')).toBe('test fixture');
    expect(await fs.readFile(path.join(root, '课程安排.pdf'), 'utf8')).toBe('file fixture');
    await page.locator('#nav-organize').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('AI retry clears stale errors and requests only items still in the preview (mock provider)', async ({ page }) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-ai-ui-'));
  const root = path.join(temp, 'items');
  const server = createApp({ dataDir: path.join(temp, 'data') });
  try {
    await fs.mkdir(path.join(root, 'A'), { recursive: true });
    await fs.mkdir(path.join(root, 'B'));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.route('**/api/session', async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), aiEnabled: true } });
    });
    let attempt = 0;
    let requestedIds;
    await page.route('**/api/classify', async route => {
      requestedIds = route.request().postDataJSON().itemIds;
      const id = await page.locator('[data-category]').first().getAttribute('data-category');
      attempt++;
      await route.fulfill({ json: [{ id, category: attempt > 1 ? '学习' : null, confidence: attempt === 1 ? null : attempt === 2 ? 0.4 : 0.9, ...(attempt === 1 ? { error: 'AI 分类失败' } : {}) }] });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#app-root [data-react-app]')).toBeVisible();
    await expect(page.locator('#scan-button')).toBeEnabled();
    await page.locator('#root').fill(root); await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(2);
    await page.locator('[data-category]').first().selectOption('工作');
    await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(1);
    await page.locator('#classify').click();
    await expect(page.locator('#folder-rows')).toContainText('AI 分类失败');
    await page.locator('#classify').click();
    await expect(page.locator('[data-category]')).toHaveValue('学习');
    await expect(page.locator('#folder-rows')).not.toContainText('AI 分类失败');
    expect(requestedIds).toHaveLength(1);
    await expect(page.locator('[data-select]')).not.toBeChecked();
    expect((await fs.stat(path.join(root, 'B'))).isDirectory()).toBe(true);
    await page.locator('#auto').check();
    await page.locator('#classify').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(0);
    expect((await fs.stat(path.join(root, '学习', 'B'))).isDirectory()).toBe(true);
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('mixed media consent, structured edits, filters and Live Photo move/undo', async ({ page }, testInfo) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-media-browser-'));
  const root = path.join(temp, 'items');
  let geocodes = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const server = createApp({ dataDir: path.join(temp, 'data'), mediaHelper: async () => '/fixture/helper', scanOptions: {
    inspectMedia: async paths => paths.map(location => ({ path: location, kind: /\.(mov|mp4)$/i.test(location) ? 'video' : 'photo',
      capturedAt: location.endsWith('broken.jpg') ? null : '2026-09-21T14:30:00+08:00', latitude: 31.2304, longitude: 121.4737,
      assetIdentifier: path.basename(location).startsWith('live.') ? 'paired-live' : null,
      error: location.endsWith('broken.jpg') ? 'unreadable metadata' : null })),
    reverseGeocode: async points => { geocodes++; return points.map(point => ({ key: point.key, country: '中国', city: '上海', status: 'resolved' })); }
  } });
  try {
    await fs.mkdir(path.join(root, '课程'), { recursive: true });
    for (const name of ['photo.jpg', 'video.mp4', 'live.heic', 'live.mov', 'document.txt', 'broken.jpg']) await fs.writeFile(path.join(root, name), `fixture ${name}`);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#app-root [data-react-app]')).toBeVisible();
    await expect(page.locator('#scan-button')).toBeEnabled();
    const consent = page.getByLabel('允许 Apple 根据 GPS 查询国家和城市');
    await expect(consent).not.toBeChecked();
    await expect(page.locator('.location-consent')).toContainText('媒体文件留在本机');
    await page.locator('#root').fill(root);
    await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(6);
    expect(geocodes).toBe(0);
    await consent.check();
    expect(geocodes).toBe(0);
    await expect(page.locator('#location-status')).toContainText('重新扫描');
    await page.locator('#scan-button').click();
    await expect(page.getByText('Live Photo · 2 个文件', { exact: true })).toBeVisible();
    expect(geocodes).toBe(1);
    await expect(page.locator('#folder-rows tr').filter({ hasText: 'live.heic' }).locator('.media-target')).toHaveText(['2026 / 09 / 中国 / 上海 / 照片 / live.heic', '2026 / 09 / 中国 / 上海 / 照片 / live.mov']);
    for (const [filter, count] of [['photo', 2], ['video', 1], ['live-photo', 1], ['location-review', 1], ['date-review', 1], ['all', 6]]) {
      await page.locator(`[data-filter="${filter}"]`).click();
      await expect(page.locator(`[data-filter="${filter}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-filter][aria-pressed="true"]')).toHaveCount(1);
      await expect(page.locator('#folder-rows tr')).toHaveCount(count);
    }
    const live = page.locator('#folder-rows tr').filter({ hasText: 'live.heic' });
    await expect(live.locator('[data-field="mediaType"]')).toHaveCount(0);
    await live.getByLabel('城市', { exact: true }).fill('杭州');
    await live.getByLabel('城市', { exact: true }).press('Tab');
    await expect(live.locator('.destination')).toContainText('2026 / 09 / 中国 / 杭州 / 照片');
    await expect(live.locator('[data-select]')).toBeChecked();
    const broken = page.locator('#folder-rows tr').filter({ hasText: 'broken.jpg' });
    await expect(broken.locator('.media-status')).toContainText('读取失败');
    await expect(broken.getByLabel('国家', { exact: true })).toBeEditable();
    await page.screenshot({ path: testInfo.outputPath('media-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('media-mobile.png'), fullPage: true });
    expect(await page.evaluate(() => ({ width: window.innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ width: 390, document: 390 });
    await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('已移动 1 个');
    for (const name of ['live.heic', 'live.mov']) expect(await fs.readFile(path.join(root, '2026/09/中国/杭州/照片', name), 'utf8')).toBe(`fixture ${name}`);
    await page.locator('#nav-history').click();
    await expect(page.locator('#history-list')).toContainText('Live Photo');
    await page.getByRole('button', { name: '撤销此批次' }).click();
    await expect(page.locator('#history-notice')).toContainText('撤销完成');
    for (const name of ['live.heic', 'live.mov']) expect(await fs.readFile(path.join(root, name), 'utf8')).toBe(`fixture ${name}`);
    expect(errors).toEqual([]);
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
