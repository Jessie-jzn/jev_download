import * as fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const STAT_KEYS = ['dev', 'ino', 'birthtimeMs', 'type'];

// 持久化收件箱待处理项目；建议和源文件身份一起保存，重启后仍可安全审核。
export class PendingStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.queue = Promise.resolve();
  }

  list(inboxId) {
    return this.enqueue(async () => {
      const items = (await this.read()).items;
      return inboxId === undefined ? items : items.filter(item => item.inboxId === inboxId);
    });
  }

  upsert(input) {
    return this.enqueue(async () => {
      const data = await this.read();
      const item = normalizeItem(input);
      const index = data.items.findIndex(existing => existing.id === item.id && existing.inboxId === item.inboxId);
      const next = index === -1 ? item : { ...data.items[index], ...item, updatedAt: new Date().toISOString() };
      if (index === -1) data.items.push(next);
      else data.items[index] = next;
      await this.write(data);
      return next;
    });
  }

  update(id, changes) {
    return this.enqueue(async () => {
      const data = await this.read();
      const index = data.items.findIndex(item => item.id === id);
      if (index === -1) throw new Error('待处理项目不存在。');
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('待处理更新无效。');
      const next = { ...data.items[index], ...changes, id: data.items[index].id,
        inboxId: data.items[index].inboxId, updatedAt: new Date().toISOString() };
      data.items[index] = next;
      await this.write(data);
      return next;
    });
  }

  remove(ids) {
    return this.enqueue(async () => {
      const removeSet = new Set(Array.isArray(ids) ? ids : [ids]);
      const data = await this.read();
      data.items = data.items.filter(item => !removeSet.has(item.id));
      await this.write(data);
    });
  }

  invalidate(inboxId, currentItems) {
    return this.enqueue(async () => {
      const data = await this.read();
      const current = new Map((Array.isArray(currentItems) ? currentItems : []).map(item => [item.id, item.identity]));
      let changed = false;
      for (const item of data.items) {
        if (item.inboxId !== inboxId || item.status === 'stale' || item.status === 'moved') continue;
        if (!sameIdentity(item.identity, current.get(item.id))) {
          item.status = 'stale';
          item.error = '源文件已删除、移动或发生变化，请重新扫描。';
          item.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) await this.write(data);
      return data.items.filter(item => item.inboxId === inboxId);
    });
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed?.version !== VERSION || !Array.isArray(parsed.items)) throw new Error('待处理配置无效。');
      return { version: VERSION, items: parsed.items };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: VERSION, items: [] };
      if (error.name === 'SyntaxError') throw new Error('待处理配置损坏，请检查配置文件。');
      throw error;
    }
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600);
  }
}

function normalizeItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.id !== 'string' || typeof input.inboxId !== 'string'
      || typeof input.source !== 'string' || !input.identity || typeof input.identity !== 'object') {
    throw new Error('待处理项目无效。');
  }
  return {
    ...input,
    status: input.status ?? 'pending',
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  return STAT_KEYS.every(key => (left[key] ?? null) === (right[key] ?? null));
}
