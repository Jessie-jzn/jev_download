import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFilePromise = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(projectRoot, 'native', 'MediaMetadata', 'main.swift');
const quickTimeIdentifierSource = path.join(projectRoot, 'native', 'MediaMetadata', 'quicktime-identifier.swift');
const binDirectory = path.join(projectRoot, '.data', 'bin');
const moduleCacheDirectory = path.join(projectRoot, '.data', 'swift-module-cache');

export async function buildNative({ platform = process.platform, execFile = execFilePromise } = {}) {
  // 按 Swift 源码哈希缓存编译产物，源码未变时无需重复调用 xcrun。
  if (platform !== 'darwin') throw new Error('媒体元数据功能仅支持 macOS。');

  const sourceBytes = await Promise.all([fs.readFile(source), fs.readFile(quickTimeIdentifierSource)]);
  const hash = createHash('sha256').update(sourceBytes[0]).update(sourceBytes[1]).digest('hex');
  const binary = path.join(binDirectory, `media-metadata-${hash}`);
  try {
    await fs.access(binary);
    return binary;
  } catch {
    await fs.mkdir(binDirectory, { recursive: true });
  }
  await fs.mkdir(moduleCacheDirectory, { recursive: true });

  await execFile('/usr/bin/xcrun', [
    'swiftc', source, quickTimeIdentifierSource,
    '-framework', 'Foundation',
    '-framework', 'ImageIO',
    '-framework', 'AVFoundation',
    '-framework', 'CoreLocation',
    '-module-cache-path', moduleCacheDirectory,
    '-o', binary
  ]);
  return binary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildNative().then(binary => process.stdout.write(`${binary}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
