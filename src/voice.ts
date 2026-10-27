/**
 * 语音侧的两个后端。
 *
 * 1. `VoiceWorker` —— 常驻的 `say.py --serve` 子进程。
 *    一次性 spawn 的做法每句都要重载 onnx（1~3 秒），在 ERP 里是致命的；
 *    常驻之后模型只加载一次，第一句之后每句 200~400ms。
 *
 * 2. `speakFeiyu` —— 肥鱼那种 HTTP TTS：POST 文本，拿回 wav，再交给 `say.py --play-wav`。
 *    契约写在 README 里：请求 `{text, style}`，响应 `audio/wav`（16bit 单声道）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface VoiceRequest {
  text: string;
  device: string;
  gain: number;
  whisper?: boolean;
  breath?: boolean;
}

export interface VoiceResult {
  ok: boolean;
  seconds?: number;
  error?: string;
}

export interface VoiceWorkerOptions {
  /** say.py 的绝对路径。 */
  script: string;
  /** 解释器，默认 `python`。 */
  python?: string;
  /** 单句超时，默认 30 秒。 */
  timeoutMs?: number;
  /** 出错时的回调（模型看得见的那种信息由 World 自己记）。 */
  onError?: (message: string) => void;
}

/**
 * 串行的语音 worker：一次只播一句（语音本来也没法并行），
 * 进程崩了下次请求会自动重开。
 */
export class VoiceWorker {
  private child: ChildProcess | null = null;

  private rl: ReturnType<typeof createInterface> | null = null;

  private pending: Array<{
    resolve: (r: VoiceResult) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private readonly opts: VoiceWorkerOptions;

  constructor(opts: VoiceWorkerOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.child !== null;
  }

  async speak(req: VoiceRequest): Promise<VoiceResult> {
    if (!req.text.trim()) return { ok: false, error: 'text 为空' };
    try {
      this.ensure();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const child = this.child;
    if (!child || !child.stdin) return { ok: false, error: 'worker 没起来' };

    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    return new Promise<VoiceResult>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.pending.splice(idx, 1);
        resolve({ ok: false, error: `语音超时（${timeoutMs}ms）` });
      }, timeoutMs);
      this.pending.push({ resolve, timer });
      const line = JSON.stringify({
        text: req.text,
        device: req.device,
        gain: req.gain,
        whisper: Boolean(req.whisper),
        breath: Boolean(req.breath),
      });
      try {
        child.stdin.write(line + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.pop();
        resolve({ ok: false, error: (e as Error).message });
      }
    });
  }

  /** 热重开：比如用户换了设备。 */
  restart(): void {
    this.kill();
  }

  stop(): void {
    this.kill();
  }

  private ensure(): void {
    if (this.child) return;
    const python = this.opts.python ?? 'python';
    const child = spawn(python, [this.opts.script, '--serve'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    this.rl = createInterface({ input: child.stdout! });
    this.rl.on('line', (line) => {
      const item = this.pending.shift();
      if (!item) return;
      clearTimeout(item.timer);
      item.resolve(parseResult(line));
    });

    let stderr = '';
    child.stderr?.on('data', (c) => {
      stderr = (stderr + c.toString()).slice(-500);
    });
    child.on('error', (e) => {
      this.failAll(`worker 启动失败：${e.message}`);
    });
    child.on('close', (code) => {
      if (this.child === child) {
        this.child = null;
        this.rl = null;
      }
      if (code !== 0 && this.pending.length) {
        this.failAll(stderr.trim() || `worker 退出（code ${code}）`);
      } else {
        this.failAll(stderr.trim() || `worker 退出（code ${code}）`);
      }
    });
  }

  private failAll(message: string): void {
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: message });
    }
    this.opts.onError?.(message);
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.rl?.close();
    this.rl = null;
    if (!child) return;
    try {
      child.stdin?.end();
      child.kill();
    } catch {
      // 已经死了
    }
  }
}

function parseResult(line: string): VoiceResult {
  try {
    const json = JSON.parse(line) as { ok?: boolean; seconds?: number; error?: string };
    if (json.ok) return { ok: true, seconds: json.seconds };
    return { ok: false, error: json.error ?? '未知错误' };
  } catch {
    return { ok: false, error: `worker 输出不是 JSON：${line.slice(0, 80)}` };
  }
}

export interface FeiyuOptions {
  /** HTTP 端点，POST JSON，期望 audio/wav。 */
  url: string;
  /** 声线名。 */
  style?: string;
  timeoutMs?: number;
}

/**
 * 肥鱼后端：把文本 POST 出去，把回来的 wav 落到临时文件，再交给 say.py 播。
 * 失败一律返回 error，不抛。
 */
export async function synthFeiyu(text: string, opts: FeiyuOptions): Promise<{ wavPath?: string; dir?: string; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, style: opts.style ?? 'default' }),
      signal: ac.signal,
    });
    if (!res.ok) return { error: `肥鱼返回 HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 44) return { error: '肥鱼回来的不是 wav（太小）' };
    const dir = mkdtempSync(join(tmpdir(), 'cortico-vrc-'));
    const wavPath = join(dir, 'tts.wav');
    writeFileSync(wavPath, buf);
    return { wavPath, dir };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** 清掉临时 wav 目录。 */
export function cleanupTempDir(dir?: string): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清不掉就算了
  }
}
