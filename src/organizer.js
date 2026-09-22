import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { categoryNames } from './categories.js';
import { GeocodeCache } from './geocode-cache.js';
import { inspectMedia, reverseGeocode } from './media-native.js';
import { scanMedia, toPublicScan } from './media-scanner.js';
import { buildMediaSegments } from './media-rules.js';
import { validateMediaOverrides } from '../public/media-paths.js';

const ignored = new Set(['node_modules', '.git', ...categoryNames]);
// 文件系统安全基础函数：只接受真实文件/目录，并记录身份防止扫描后被替换。
const kind = stat => stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : null;
const identity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, type: kind(stat) });
// Older journal entries lack type and were always directories.
const same = (stat, id) => stat && kind(stat) === (id.type || 'folder') && !stat.isSymbolicLink() &&
  stat.dev === id.dev && stat.ino === id.ino && stat.birthtimeMs === id.birthtimeMs;
async function statOrNull(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function checkDirectory(file, id) {
  const stat = await statOrNull(file);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || (id && !same(stat, id)) || await fs.realpath(file) !== file) {
    throw new Error('目录已变化、不存在或包含符号链接，请重新扫描。');
  }
  return stat;
}
async function checkItem(file, id) {
  const stat = await statOrNull(file);
  if (!stat || !kind(stat) || stat.isSymbolicLink() || (id && !same(stat, id)) || await fs.realpath(file) !== file) {
    throw new Error('文件或文件夹已变化、不存在或包含符号链接，请重新扫描。');
  }
  return stat;
}
async function samplesFor(root) {
  // 只读取目录名和最多两层、40 条样本，供分类模型判断；不读取文件内容。
  const samples = [];
  const queue = [{ relative: '', depth: 0 }];
  while (queue.length && samples.length < 40) {
    const { relative, depth } = queue.shift();
    const location = path.join(root, relative);
    await checkDirectory(location);
    const directory = await fs.opendir(location);
    for await (const entry of directory) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const name = path.join(relative, entry.name);
      samples.push(name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory() && depth < 1) queue.push({ relative: name, depth: depth + 1 });
      if (samples.length >= 40) break;
    }
  }
  return samples;
}

export class Organizer {
  constructor(dataDir, options = {}) {
    this.dataDir = path.resolve(dataDir);
    this.scans = new Map();
    this.queue = Promise.resolve();
    this.inspectMedia = options.inspectMedia ?? inspectMedia;
    this.reverseGeocode = options.reverseGeocode ?? reverseGeocode;
    this.geocodeCache = options.geocodeCache ?? new GeocodeCache(path.join(this.dataDir, 'geocode-cache.json'));
    this.timeZone = options.timeZone;
    this.rename = options.rename ?? fs.rename;
  }

  exclusive(fn) {
    // 将扫描、移动、撤销和日志恢复串行化，避免同时改动同一目录。
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  scan(input, options = {}) {
    return this.exclusive(() => this.#scanUnlocked(input, options));
  }

  async #scanUnlocked(input, options = {}) {
    // 扫描直属项目，识别媒体并保存带私有路径的内存快照供后续移动使用。
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('请输入父目录的绝对路径。');
    const root = await fs.realpath(input);
    assertRecoveredRoot(root, await this.#recoverJournalsUnlocked());
    if ([path.resolve(input), root].some(location => location.split(path.sep).some(segment => segment.toLowerCase().endsWith('.photoslibrary')))) {
      throw new Error('不能整理照片图库或图库内部目录，请先导出到普通文件夹。');
    }
    const rootIdentity = identity(await checkDirectory(root));
    // Never let the organizer move its own journal or runtime directory.
    if (root === path.parse(root).root || this.dataDir === root || this.dataDir.startsWith(root + path.sep)) {
      throw new Error('请选择具体的待整理目录，不能扫描根目录或包含本工具运行数据的目录。');
    }
    const ordinaryItems = [], fileCandidates = [], skipped = [];
    const directory = await fs.opendir(root);
    for await (const entry of directory) {
      if ((!entry.isDirectory() && !entry.isFile()) || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') || (entry.isDirectory() && (ignored.has(entry.name) || entry.name.toLowerCase().endsWith('.photoslibrary')))) {
        skipped.push(entry.name); continue;
      }
      const location = path.join(root, entry.name);
      try {
        const stat = await checkItem(location);
        const type = kind(stat);
        let samples = [], warning = null;
        if (type === 'folder') {
          try { samples = await samplesFor(location); } catch { warning = '部分内部目录无法读取，分类仅使用可获得的信息。'; }
        }
        const item = { id: randomUUID(), name: entry.name, type, extension: type === 'file' ? path.extname(entry.name).toLowerCase() : '',
          sizeBytes: type === 'file' ? stat.size : null, samples, warning, identity: identity(stat) };
        if (type === 'file') fileCandidates.push({ ...item, path: location, birthtime: stat.birthtime });
        else ordinaryItems.push(item);
      } catch { skipped.push(entry.name); }
    }
    const scannedMedia = await scanMedia(fileCandidates, {
      inspectMedia: this.inspectMedia,
      reverseGeocode: this.reverseGeocode,
      geocodeCache: this.geocodeCache,
      resolveLocations: options.resolveLocations === true,
      timeZone: options.timeZone ?? this.timeZone
    });
    const ordinaryFiles = scannedMedia.ordinaryPaths.map(({ path: privatePath, birthtime, ...item }) => item);
    const items = [...ordinaryItems, ...ordinaryFiles, ...scannedMedia.mediaItems];
    if (items.length > 500) throw new Error('直属文件和文件夹超过 500 项，请分批选择更小的父目录。');
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const scan = { id: randomUUID(), root, rootIdentity, items, skipped,
      allowedCategories: Array.isArray(options.categories) && options.categories.length ? [...options.categories] : [...categoryNames] };
    this.scans.set(scan.id, scan);
    if (this.scans.size > 20) this.scans.delete(this.scans.keys().next().value);
    return toPublicScan(scan, { exposeCoordinates: options.resolveLocations === true });
  }

  getScan(id) {
    const scan = this.scans.get(id);
    if (!scan) throw new Error('扫描已失效，请重新扫描。');
    return scan;
  }

  async save(batch) {
    // 以临时文件 + rename 写入操作日志，保证中断后可恢复。
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.dataDir, `${batch.id}.json`);
    const temp = target + '.tmp';
    const handle = await fs.open(temp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(batch, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, target);
    const directory = await fs.open(this.dataDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async readBatch(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('操作记录无效。');
    return JSON.parse(await fs.readFile(path.join(this.dataDir, `${id}.json`), 'utf8'));
  }

  async recoverEntry(entry, batch) {
    // 根据成员实际位置推断中断操作的结果，必要时补偿性恢复。
    const interrupted = entry.status;
    try {
      const locations = await locateMembers(batch, entry);
      if (locations.every(location => location === 'source')) {
        setEntryStatus(entry, interrupted === 'undoing' ? 'undone' : 'skipped', 'source');
      } else if (locations.every(location => location === 'target')) {
        setEntryStatus(entry, 'moved', 'target');
      } else {
        // Undo failures restore the pre-undo state; move failures restore the sources.
        const destination = interrupted === 'undoing' ? 'target' : 'source';
        await this.restoreEntry(batch, entry, destination);
        setEntryStatus(entry, destination === 'target' ? 'moved' : 'skipped', destination);
      }
    } catch (error) {
      entry.status = 'uncertain';
      entry.error = `中断后状态不确定，请按记录手动核对。${error.message}`;
    }
  }

  async recover(batch) {
    let changed = false;
    for (const entry of batch.entries) {
      if (!['pending', 'undoing'].includes(entry.status)) continue;
      await this.recoverEntry(entry, batch);
      changed = true;
    }
    // Reading an ordinary legacy journal must not migrate or rewrite its schema.
    if (changed) await this.save(batch);
    return batch;
  }

  // Call only while holding exclusive: recovery itself performs filesystem renames.
  async #recoverJournalsUnlocked() {
    let names;
    try { names = await fs.readdir(this.dataDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const batches = [];
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      batches.push(await this.recover(await this.readBatch(name.slice(0, -5))));
    }
    return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  history() {
    return this.exclusive(() => this.#recoverJournalsUnlocked());
  }

  async restoreEntry(batch, entry, destination) {
    // Prove every member has exactly one safe location before compensating any rename.
    await locateMembers(batch, entry);
    const members = orderedMembers(entry);
    if (destination === 'source') members.reverse();
    for (const member of members) {
      const locations = await locateMembers(batch, entry);
      if (locations[entryMembers(entry).indexOf(member)] === destination) continue;
      const origin = destination === 'source' ? 'target' : 'source';
      await this.rename(member[origin], member[destination]);
      member.status = destination === 'source' ? 'undone' : 'moved';
    }
    const finalLocations = await locateMembers(batch, entry);
    if (!finalLocations.every(location => location === destination)) throw new Error('成员位置不一致。');
  }

  move(scanId, selections) {
    // 预检所有项目后逐个移动；任何失败都写入日志并尝试回滚。
    return this.exclusive(async () => {
      const scan = this.getScan(scanId);
      assertRecoveredRoot(scan.root, await this.#recoverJournalsUnlocked());
      if (!Array.isArray(selections) || !selections.length || selections.length > 500) throw new Error('请选择需要整理的文件或文件夹。');
      const seen = new Set();
      const entries = selections.map(selection => {
        if (seen.has(selection?.id)) throw new Error('分类选择无效，请重新扫描。');
        seen.add(selection?.id);
        return prepareSelection(scan, selection);
      });
      checkSelectionIndependence(scan, entries);
      await checkDirectory(scan.root, scan.rootIdentity);
      const batch = { id: randomUUID(), root: scan.root, rootIdentity: scan.rootIdentity, createdAt: new Date().toISOString(), entries };
      await this.save(batch);
      for (const entry of entries) {
        try {
          await checkDirectory(batch.root, batch.rootIdentity);
          for (const member of entry.members) await checkItem(member.source, member.identity);
          entry.containers = await createContainers(batch, entry);
          // Retain the old convenience fields for existing history consumers.
          entry.containerIdentity = entry.containers.at(-1).identity;
          await preflight(batch, entry, 'source');
        } catch (error) {
          entry.status = 'skipped'; entry.error = error.message;
          await this.save(batch); continue;
        }
        entry.status = 'pending';
        await this.save(batch); // Write-ahead: never rename before the complete group is durable.
        try {
          await preflight(batch, entry, 'source');
          for (const member of orderedMembers(entry)) {
            await checkEntryDirectories(batch, entry);
            await checkItem(member.source, member.identity);
            if (await statOrNull(member.target)) throw new Error('目标已存在，已跳过，未覆盖。');
            await this.rename(member.source, member.target);
            member.status = 'moved';
          }
          setEntryStatus(entry, 'moved', 'target');
        } catch (error) {
          entry.error = error.message;
          try {
            await this.restoreEntry(batch, entry, 'source');
            setEntryStatus(entry, 'skipped', 'source');
          } catch (rollbackError) {
            entry.status = 'uncertain'; entry.error += ` 回滚状态不确定：${rollbackError.message}`;
          }
        }
        // Keep completion-save failures outside compensation: durable pending enables recovery.
        await this.save(batch);
      }
      return batch;
    });
  }

  undo(id) {
    return this.exclusive(async () => {
      const batch = await this.recover(await this.readBatch(id));
      for (const entry of [...batch.entries].reverse()) {
        if (entry.status !== 'moved') continue;
        try {
          await preflight(batch, entry, 'target');
        } catch (error) { entry.error = error.message; await this.save(batch); continue; }
        entry.status = 'undoing'; await this.save(batch);
        try {
          await preflight(batch, entry, 'target');
          for (const member of orderedMembers(entry).reverse()) {
            await checkEntryDirectories(batch, entry);
            await checkItem(member.target, member.identity);
            if (await statOrNull(member.source)) throw new Error('原位置已存在同名项目，未覆盖。');
            await this.rename(member.target, member.source);
            member.status = 'undone';
          }
          setEntryStatus(entry, 'undone', 'source'); delete entry.error;
        } catch (error) {
          entry.error = error.message;
          try {
            await this.restoreEntry(batch, entry, 'target');
            setEntryStatus(entry, 'moved', 'target');
          } catch (rollbackError) {
            entry.status = 'uncertain'; entry.error += ` 撤销恢复状态不确定：${rollbackError.message}`;
          }
        }
        await this.save(batch);
      }
      return batch;
    });
  }
}

function assertRecoveredRoot(root, batches) {
  const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  for (const batch of batches) {
    if (batch.entries.some(entry => ['pending', 'undoing', 'uncertain'].includes(entry.status))
        && (contains(root, batch.root) || contains(batch.root, root))) {
      throw new Error('此目录存在中断后状态不确定的操作，请先在操作记录中手动核对，暂不能继续扫描或整理。');
    }
  }
}

function safeSegment(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error('路径段无效。');
  }
  return value;
}

function contained(root, location) {
  const relative = path.relative(root, location);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || path.resolve(location) !== location) throw new Error('路径必须位于扫描目录内。');
}

function prepareSelection(scan, selection) {
  // 把公开选择转换为带真实源路径、目标路径和身份快照的日志条目。
  const item = scan.items.find(candidate => candidate.id === selection?.id);
  if (!item) throw new Error('分类选择无效，请重新扫描。');
  let segments, originals;
  if (item.type === 'media') {
    if (!selection.media || typeof selection.media !== 'object' || Array.isArray(selection.media)) throw new Error('媒体选择无效。');
    const overrides = validateMediaOverrides(selection.media);
    if (item.mediaType === 'live-photo') overrides.mediaType = 'live-photo';
    else if (overrides.mediaType !== undefined && !['photo', 'video'].includes(overrides.mediaType)) throw new Error('媒体类型无效。');
    segments = buildMediaSegments(item.facts, overrides).map(safeSegment);
    originals = item.members;
  } else {
    const allowedCategories = scan.allowedCategories ?? categoryNames;
    if (!allowedCategories.includes(selection.category)) throw new Error('分类选择无效，请重新扫描。');
    segments = [selection.category];
    originals = [{ name: item.name, identity: item.identity }];
  }
  const members = originals.map(original => {
    // A basename from the retained scan is not a client-supplied directory segment.
    if (typeof original.name !== 'string' || path.basename(original.name) !== original.name
        || original.name === '.' || original.name === '..' || original.name.includes('\0')) throw new Error('源文件名无效。');
    const source = path.join(scan.root, original.name), target = path.join(scan.root, ...segments, original.name);
    contained(scan.root, source); contained(scan.root, target);
    return { name: original.name, source, target, identity: original.identity, status: 'ready' };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (!members.length || new Set(members.map(member => member.name)).size !== members.length) throw new Error('媒体成员无效。');
  return { name: item.name, type: item.type, kind: members.length > 1 ? 'group' : 'single',
    ...(item.type === 'media' ? { mediaType: item.mediaType, targetSegments: segments } : { category: selection.category }),
    source: members[0].source, target: members[0].target, identity: members[0].identity, members, status: 'ready' };
}

// Old journals are one-member views, without adding members to their persisted schema.
const entryMembers = entry => entry.members ?? [entry];
const orderedMembers = entry => [...entryMembers(entry)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
function setEntryStatus(entry, status, location) {
  entry.status = status;
  if (entry.members) for (const member of entry.members) member.status = location === 'target' ? 'moved' : status;
}

function containerPaths(batch, entry) {
  const members = entryMembers(entry);
  if (!members.length) throw new Error('操作记录缺少成员。');
  const directories = [];
  const sources = new Set(), targets = new Set();
  for (const member of members) {
    contained(batch.root, member.source); contained(batch.root, member.target);
    if (path.dirname(member.source) !== batch.root || path.basename(member.source) !== member.name
        || path.basename(member.target) !== member.name || !member.identity
        || sources.has(member.source) || targets.has(member.target)) throw new Error('操作记录路径无效。');
    sources.add(member.source); targets.add(member.target);
    let current = batch.root;
    for (const segment of path.relative(batch.root, path.dirname(member.target)).split(path.sep)) {
      current = path.join(current, safeSegment(segment));
      if (!directories.includes(current)) directories.push(current);
    }
  }
  return directories;
}

function checkSelectionIndependence(scan, entries) {
  const members = entries.flatMap(entryMembers);
  const containers = [...new Set(entries.flatMap(entry => containerPaths(scan, entry)))];
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  const overlaps = (left, right) => contains(left, right) || contains(right, left);
  const reject = () => { throw new Error('所选项目路径存在冲突，请分批整理。'); };
  for (let i = 0; i < members.length; i++) {
    const left = members[i];
    // A selected source must never be reused or recreated as any destination container.
    if (containers.some(container => overlaps(left.source, container))) reject();
    for (let j = i; j < members.length; j++) {
      const right = members[j];
      if (overlaps(left.source, right.target) || overlaps(left.target, right.source)
          || (i !== j && (overlaps(left.source, right.source) || overlaps(left.target, right.target)))) reject();
    }
  }
}

async function createContainers(batch, entry) {
  const containers = [];
  for (const directory of containerPaths(batch, entry)) {
    await checkDirectory(batch.root, batch.rootIdentity);
    for (const container of containers) await checkDirectory(container.path, container.identity);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    containers.push({ path: directory, identity: identity(await checkDirectory(directory)) });
  }
  return containers;
}

async function checkEntryDirectories(batch, entry) {
  await checkDirectory(batch.root, batch.rootIdentity);
  const paths = containerPaths(batch, entry);
  for (const directory of paths) {
    const recorded = entry.containers?.find(container => container.path === directory);
    if (entry.members && !recorded?.identity) throw new Error('操作记录缺少目录身份。');
    await checkDirectory(directory, recorded?.identity ?? (directory === path.dirname(entry.target) ? entry.containerIdentity : undefined));
  }
}

async function preflight(batch, entry, origin) {
  await checkEntryDirectories(batch, entry);
  for (const member of entryMembers(entry)) {
    await checkItem(member[origin], member.identity);
    if (await statOrNull(member[origin === 'source' ? 'target' : 'source'])) {
      throw new Error(origin === 'source' ? '目标已存在，已跳过，未覆盖。' : '原位置已存在同名项目，未覆盖，可解决冲突后再次撤销。');
    }
  }
}

async function locateMembers(batch, entry) {
  await checkEntryDirectories(batch, entry);
  const locations = [];
  for (const member of entryMembers(entry)) {
    const source = await statOrNull(member.source), target = await statOrNull(member.target);
    if (same(source, member.identity) && !target) locations.push('source');
    else if (same(target, member.identity) && !source) locations.push('target');
    else throw new Error('成员身份或位置不能安全确认。');
  }
  return locations;
}
