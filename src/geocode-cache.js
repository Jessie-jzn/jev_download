import * as fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERSION = 1;
const UNRESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
const fileQueues = new Map();

export const coordinateKey = ({ latitude, longitude }) => {
  if (!validCoordinates(latitude, longitude)) throw new Error('invalid coordinates');
  return `${roundedCoordinate(latitude)},${roundedCoordinate(longitude)}`;
};

export class GeocodeCache {
  constructor(file, { now = () => new Date(), env = process.env } = {}) {
    this.file = path.resolve(file);
    this.now = now;
    const hours = Number(env.MEDIA_GEOCODE_CACHE_TTL_HOURS);
    this.unresolvedTtlMs = Number.isSafeInteger(hours) && hours > 0 && Number.isSafeInteger(hours * 3600000)
      ? hours * 3600000 : UNRESOLVED_TTL_MS;
    this.entries = null;
    this.queue = Promise.resolve();
  }

  resolve(points, geocoder) {
    // 查询并缓存坐标对应的国家/城市；文件级队列避免多个请求互相覆盖缓存。
    if (!Array.isArray(points) || typeof geocoder !== 'function') {
      return Promise.reject(new Error('points and geocoder are required'));
    }
    return this.enqueue(() => enqueueFile(this.file, () => this.resolveQueued(points, geocoder)));
  }

  async resolveQueued(points, geocoder) {
    const requested = new Map();
    for (const point of points) {
      const key = coordinateKey(point);
      requested.set(key, { key, latitude: point.latitude, longitude: point.longitude });
    }
    await this.reload();
    const now = this.now().getTime();
    const unresolved = [...requested.values()].filter(point => this.needsLookup(this.entries[point.key], now));
    if (unresolved.length) {
      const results = await geocode(unresolved, geocoder);
      for (const point of unresolved) {
        this.entries[point.key] = normalizePlace(results.get(point.key), now);
      }
      await this.persist();
    }

    return new Map([...requested.keys()].map(key => [key, publicPlace(this.entries[key])]));
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async reload() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.entries = parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object'
        ? Object.fromEntries(Object.entries(parsed.entries).filter(([key, entry]) => validEntry(key, entry))) : {};
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      this.entries = {};
    }
  }

  needsLookup(entry, now) {
    return !entry || entry.status === 'unresolved' && Date.parse(entry.updatedAt) + this.unresolvedTtlMs <= now;
  }

  async persist() {
    // 私有权限保存缓存，先写临时文件再原子替换，避免留下半份 JSON。
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const contents = JSON.stringify({ version: CACHE_VERSION, entries: this.entries }) + '\n';
    await fs.writeFile(temporary, contents, { mode: 0o600 });
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600);
  }
}

async function geocode(points, geocoder) {
  try {
    const raw = await geocoder(points);
    const results = raw instanceof Map ? [...raw.values()] : raw;
    if (!Array.isArray(results)) return new Map();
    return new Map(results.filter(place => place && typeof place.key === 'string').map(place => [place.key, place]));
  } catch {
    return new Map();
  }
}

function normalizePlace(place, now) {
  if (place?.status === 'resolved' && typeof place.country === 'string' && typeof place.city === 'string') {
    return { country: place.country, city: place.city, status: 'resolved', updatedAt: new Date(now).toISOString() };
  }
  return { country: null, city: null, status: 'unresolved', updatedAt: new Date(now).toISOString() };
}

function publicPlace(entry) {
  return { country: entry.country, city: entry.city, status: entry.status };
}

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function roundedCoordinate(value) {
  const rounded = value.toFixed(2);
  return rounded === '-0.00' ? '0.00' : rounded;
}

function enqueueFile(file, operation) {
  const previous = fileQueues.get(file) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.catch(() => undefined);
  fileQueues.set(file, settled);
  settled.finally(() => {
    if (fileQueues.get(file) === settled) fileQueues.delete(file);
  });
  return result;
}

function validEntry(key, entry) {
  return typeof key === 'string' && entry && (entry.status === 'resolved' || entry.status === 'unresolved')
    && typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt))
    && (entry.status === 'unresolved' || typeof entry.country === 'string' && typeof entry.city === 'string');
}
