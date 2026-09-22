import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;

// 持久化收件箱定义：每个收件箱拥有根目录、分类树和后续规则配置。
export class InboxStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.queue = Promise.resolve();
  }

  list() {
    return this.enqueue(async () => {
      const data = await this.read();
      return data.inboxes;
    });
  }

  get(id) {
    return this.enqueue(async () => {
      const inbox = (await this.read()).inboxes.find(item => item.id === id);
      if (!inbox) throw new Error('收件箱不存在。');
      return inbox;
    });
  }

  save(input) {
    return this.enqueue(async () => {
      const data = await this.read();
      const existing = typeof input?.id === 'string' ? data.inboxes.find(item => item.id === input.id) : null;
      const inbox = normalizeInbox(input, existing);
      const index = data.inboxes.findIndex(item => item.id === inbox.id);
      if (index === -1) data.inboxes.push(inbox);
      else data.inboxes[index] = inbox;
      await this.write(data);
      return inbox;
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
      if (parsed?.version !== VERSION || !Array.isArray(parsed.inboxes)) throw new Error('收件箱配置无效。');
      return { version: VERSION, inboxes: parsed.inboxes };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: VERSION, inboxes: [] };
      if (error.name === 'SyntaxError') throw new Error('收件箱配置损坏，请检查配置文件。');
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

function normalizeInbox(input, existing) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('收件箱配置无效。');
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('收件箱名称不能为空。');
  if (typeof input.root !== 'string' || !path.isAbsolute(input.root)) throw new Error('收件箱根目录必须是绝对路径。');
  if (!Array.isArray(input.taxonomy)) throw new Error('收件箱分类体系无效。');
  const taxonomy = normalizeNodes(input.taxonomy, '', 1);
  return {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: input.name.trim(),
    root: path.resolve(input.root),
    taxonomy,
    createdAt: existing?.createdAt ?? input.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function normalizeNodes(nodes, parentPath, depth) {
  if (depth > 3) throw new Error('分类体系最多三级。');
  const names = new Set();
  return nodes.map(node => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.name !== 'string') {
      throw new Error('分类节点无效。');
    }
    const name = node.name.trim();
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('分类名称无效。');
    if (names.has(name)) throw new Error('同级分类不能重名。');
    names.add(name);
    const nodePath = parentPath ? `${parentPath}/${name}` : name;
    const children = node.children === undefined ? [] : node.children;
    if (!Array.isArray(children)) throw new Error('分类子节点无效。');
    return {
      id: typeof node.id === 'string' ? node.id : randomUUID(),
      name,
      path: nodePath,
      ...(node.destination === undefined ? {} : { destination: normalizeDestination(node.destination) }),
      children: normalizeNodes(children, nodePath, depth + 1)
    };
  });
}

function normalizeDestination(value) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || value.split(/[\\/]/).some(part => part === '..')) {
    throw new Error('分类目标目录必须是收件箱内的相对路径。');
  }
  return value.trim().split(/[\\/]+/).filter(Boolean).join('/');
}
