import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 读 VRChat 自己的日志，拿到 OSC 状态和「当前在哪个世界」。
 *
 * 为什么要读日志：OSC 只能告诉化身和参数的变化，不会告诉你世界名；
 * 而日志里明明白白写着 `Entering Room: xxx`、`OSC enabled: True/False`、
 * `Could not Start OSC: Address already in use`。成熟项目（如 VRCT）都这么干。
 */

export interface VrcLogState {
  worldName: string;
  oscEnabled: boolean | null;
  oscError: string;
  updatedAt: number;
  logPath: string;
}

function logDir(): string {
  // Windows 的 LocalLow 在 %USERPROFILE%\AppData\LocalLow（不是 %LOCALAPPDATA%\Low）
  return join(homedir(), 'AppData', 'LocalLow', 'VRChat', 'VRChat');
}

/** 找最新的一份 output_log_*.txt。 */
export function latestLogFile(): string | null {
  const dir = logDir();
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('output_log_') && f.endsWith('.txt'))
      .sort();
    const last = files[files.length - 1];
    return last ? join(dir, last) : null;
  } catch {
    return null;
  }
}

export class VrcLogTailer {
  private state: VrcLogState = { worldName: '', oscEnabled: null, oscError: '', updatedAt: 0, logPath: '' };

  private offset = 0;

  private timer: NodeJS.Timeout | null = null;

  private path = '';

  start(intervalMs = 3000): void {
    this.path = latestLogFile() ?? '';
    this.state.logPath = this.path;
    this.scanFull();                       // 先整份读一遍，拿到启动时的状态
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): VrcLogState {
    return { ...this.state };
  }

  private scanFull(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const text = readFileSync(this.path, 'utf8');
      this.offset = Buffer.byteLength(text, 'utf8');
      for (const line of text.split('\n')) this.consume(line);
    } catch {
      // 日志被占用/滚动，忽略
    }
  }

  private poll(): void {
    // 日志按会话滚动：换文件了就重头读
    const latest = latestLogFile();
    if (latest && latest !== this.path) {
      this.path = latest;
      this.state.logPath = latest;
      this.offset = 0;
      this.scanFull();
      return;
    }
    if (!this.path || !existsSync(this.path)) return;
    try {
      const size = statSync(this.path).size;
      if (size <= this.offset) return;
      const buf = readFileSync(this.path);
      const chunk = buf.subarray(this.offset).toString('utf8');
      this.offset = size;
      for (const line of chunk.split('\n')) this.consume(line);
    } catch {
      // 忽略瞬时错误
    }
  }

  private consume(line: string): void {
    if (!line) return;
    const room = line.match(/Entering Room:\s*(.+?)\s*$/);
    if (room) {
      this.state.worldName = room[1];
      this.state.updatedAt = Date.now();
      return;
    }
    const osc = line.match(/OSC enabled:\s*(True|False)/i);
    if (osc) {
      this.state.oscEnabled = osc[1].toLowerCase() === 'true';
      if (this.state.oscEnabled) this.state.oscError = '';   // 起来了就把旧报错清掉
      this.state.updatedAt = Date.now();
      return;
    }
    if (line.includes('Could not Start OSC')) {
      this.state.oscError = 'Address already in use（9000 被别的程序占用了）';
      this.state.updatedAt = Date.now();
      return;
    }
    if (line.includes('OSC') && /start/i.test(line) && !this.state.oscError) {
      this.state.oscEnabled = true;
      this.state.updatedAt = Date.now();
    }
  }
}
