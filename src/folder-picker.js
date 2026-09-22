import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const script = `on run argv
  try
    set chosenFolder to choose folder with prompt "选择需要整理的父文件夹" default location (POSIX file (item 1 of argv))
    return POSIX path of chosenFolder
  on error number -128
    return ""
  end try
end run`;

export async function pickFolder(start, { platform = process.platform, run = promisify(execFile) } = {}) {
  // 调用 macOS AppleScript 选择本机目录；非 macOS 返回可理解的降级提示。
  if (platform !== 'darwin') throw new Error('当前系统暂不支持原生选择窗口，请手动输入文件夹绝对路径。');
  let initial = os.homedir();
  if (typeof start === 'string' && path.isAbsolute(start)) {
    try { if ((await fs.stat(start)).isDirectory()) initial = start; } catch { /* Fall back to home. */ }
  }
  let stdout;
  try {
    ({ stdout } = await run('/usr/bin/osascript', ['-e', script, initial], { timeout: 120_000, maxBuffer: 16 * 1024 }));
  } catch {
    throw new Error('文件夹选择窗口未能完成操作，请重试或手动输入路径。');
  }
  const chosen = stdout.replace(/\r?\n$/, '');
  if (!chosen) return null;
  const root = await fs.realpath(chosen);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('请选择一个文件夹。');
  return root;
}
