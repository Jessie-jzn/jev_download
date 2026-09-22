import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildNative } from '../scripts/build-native.js';

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function mediaHelperTimeoutMs(env = process.env) {
  const value = Number(env.MEDIA_HELPER_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : TIMEOUT_MS;
}

export async function ensureMediaHelper() {
  return buildNative();
}

export async function inspectMedia(paths, options = {}) {
  // 请求 Swift helper 读取照片/视频元数据，返回前严格校验协议。
  validateAbsolutePaths(paths);
  const response = await invoke({ operation: 'inspect', paths }, options);
  return validateMediaResults(response, paths);
}

export async function reverseGeocode(points, options = {}) {
  // 请求 macOS CoreLocation 将 GPS 坐标解析为国家和城市。
  validatePoints(points);
  const response = await invoke({ operation: 'reverseGeocode', points }, options);
  return validatePlaceResults(response, points);
}

async function invoke(request, { runHelper } = {}) {
  if (runHelper) return runHelper(request);
  return runBinary(await ensureMediaHelper(), request);
}

function runBinary(binary, request) {
  // 通过 stdin/stdout 使用一次性 JSON 协议，并限制超时和输出大小。
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (process.env.NODE_ENV === 'development' && stderr.length > 0) {
        console.error(Buffer.concat(stderr).toString('utf8'));
      }
      if (error) {
        child.stdin.destroy();
        child.kill();
        reject(error);
      } else resolve(value);
    };
    const timeout = setTimeout(() => {
      finish(new Error('media metadata helper timed out'));
    }, mediaHelperTimeoutMs());
    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finish(new Error('media metadata helper output exceeded limit'));
        return;
      }
      chunks.push(chunk);
    };

    child.once('error', () => finish(new Error('media metadata helper failed')));
    // The pipe can fail before process close (for example EPIPE on an early exit).
    // Keep this listener installed through cleanup so late stream errors are safe.
    child.stdin.on('error', () => finish(new Error('media metadata helper failed')));
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error('media metadata helper failed'));
      try {
        const text = Buffer.concat(stdout).toString('utf8');
        finish(null, JSON.parse(text));
      } catch {
        finish(new Error('invalid helper response'));
      }
    });
    try { child.stdin.end(JSON.stringify(request)); }
    catch { finish(new Error('media metadata helper failed')); }
  });
}

function validateAbsolutePaths(paths) {
  if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('media metadata requires absolute paths');
  }
}

function validatePoints(points) {
  if (!Array.isArray(points) || points.some(point => !point || typeof point.key !== 'string'
    || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude))) {
    throw new Error('reverse geocoding requires keyed coordinate points');
  }
}

function validateMediaResults(response, paths) {
  if (!response || !Array.isArray(response.results) || response.results.length !== paths.length) invalidResponse();
  const expected = new Set(paths);
  const seen = new Set();
  for (const result of response.results) {
    if (!result || typeof result.path !== 'string' || !expected.has(result.path) || seen.has(result.path)
      || !['photo', 'video', 'unsupported'].includes(result.kind)
      || !nullableString(result.capturedAt) || !nullableInteger(result.offsetMinutes)
      || !nullableNumber(result.latitude) || !nullableNumber(result.longitude)
      || !nullableString(result.assetIdentifier) || !nullableString(result.error)) invalidResponse();
    seen.add(result.path);
  }
  return response.results;
}

function validatePlaceResults(response, points) {
  if (!response || !Array.isArray(response.results) || response.results.length !== points.length) invalidResponse();
  const expected = new Set(points.map(point => point.key));
  const seen = new Set();
  for (const result of response.results) {
    if (!result || typeof result.key !== 'string' || !expected.has(result.key) || seen.has(result.key)
      || !nullableString(result.country) || !nullableString(result.city)
      || !['resolved', 'unresolved'].includes(result.status)) invalidResponse();
    seen.add(result.key);
  }
  return response.results;
}

function nullableString(value) { return value === null || typeof value === 'string'; }
function nullableNumber(value) { return value === null || Number.isFinite(value); }
function nullableInteger(value) { return value === null || Number.isInteger(value); }
function invalidResponse() { throw new Error('invalid helper response'); }
