import { spawn } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldWebUiDecl } from 'cortico/core/types.ts';
import { VRC_DEFAULTS, normalizeConfig, vrcConfigGroup, type VrcConfig } from './config.ts';
import { decode, encode, type OscArg } from './osc.ts';
import { VrcLogTailer } from './vrclog.ts';

interface QueuedLine {
  text: string;
  voice: boolean;
}

export class VrcWorld implements World {
  readonly id = 'vrc';

  private cfg: VrcConfig;

  private out: Socket | null = null;

  private in: Socket | null = null;

  private queue: QueuedLine[] = [];

  private pumping = false;

  private lastPumpAt = 0;

  private lastInboundAt = 0;

  private lastInbound: { address: string; value: string } | null = null;

  private avatarId = '';

  private worldId = '';

  private sent = 0;

  private lastVoiceError = '';

  private logTail = new VrcLogTailer();

  constructor(opts: { cfg?: Record<string, unknown> } = {}) {
    this.cfg = normalizeConfig(opts.cfg ?? {});
  }

  async start(): Promise<void> {
    try { this.logTail.start(); } catch {}
    try {
      this.out = createSocket({ type: 'udp4', reuseAddr: true });
      this.out.on('error', () => {});
      this.out.bind(0);
    } catch {
      this.out = null;
    }
    if (this.cfg.inPort > 0) {
      try {
        this.in = createSocket({ type: 'udp4', reuseAddr: true });
        this.in.on('error', () => {});
        this.in.on('message', (buf) => this.onMessage(buf));
        this.in.bind(this.cfg.inPort, this.cfg.host === '0.0.0.0' ? undefined : '0.0.0.0');
      } catch {
        this.in = null;
      }
    }
  }

  async stop(): Promise<void> {
    try { this.logTail.stop(); } catch {}
    for (const s of [this.out, this.in]) {
      try {
        s?.close();
      } catch {
        // 忽略
      }
    }
    this.out = null;
    this.in = null;
  }

  envPromptVars(): Record<string, string> {
    const log = this.logTail.current();
    if (!this.online()) {
      // 离线也可能刚在日志里看到过世界名（比如刚退出），那就不算完全没信息
      return { 'vrc.state': log.worldName ? `VRChat 不在线（日志里最后一次所在世界：${log.worldName}）。` : '' };
    }
    const bits = [`VRChat 在线${this.avatarId ? '（化身 ' + this.avatarId.slice(0, 12) + '）' : ''}`];
    if (log.worldName) bits.push(`世界「${log.worldName}」`);
    if (this.lastInbound) bits.push(`最近收到 ${this.lastInbound.address}`);
    return { 'vrc.state': bits.join('；') + '。' };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    return { label: language === 'zh' ? 'VRChat' : 'VRChat', config: [vrcConfigGroup(language)] };
  }

  tools(): ToolDef[] {
    const status: ToolDef = {
      name: 'vrc_status',
      tags: ['read'],
      description: '看 VRChat 那边通不通：OSC 有没有动静、当前化身、chatbox 队列里有没有排着的句子。VRChat 没开会说 offline，不是报错。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => this.describeStatus(),
    };

    const say: ToolDef = {
      name: 'vrc_say',
      tags: ['speak'],
      barrierAfter: true,
      description:
        '在 VRChat 里说一句话：进游戏聊天框（超长自动分条、按间隔排队），配置开了语音的话同时出声。'
        + '一次别塞太长，像聊天那样一句一句说。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的话' },
          voice: { type: 'boolean', description: '要不要同时也出声（默认跟着配置走）' },
        },
        required: ['text'],
      },
      handler: async (args) => this.enqueue(String(args.text ?? ''), args.voice !== false),
    };

    const text: ToolDef = {
      name: 'vrc_text',
      tags: ['speak'],
      barrierAfter: true,
      description: '只往游戏聊天框发文字，不出声。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: async (args) => this.enqueue(String(args.text ?? ''), false),
    };

    const typing: ToolDef = {
      name: 'vrc_typing',
      tags: ['read'],
      description: '在 VRChat 里显示/取消「正在输入」。你开始想事情时打上，说完取消。',
      parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
      handler: async (args) => {
        if (!this.cfg.typingIndicator) return '配置里关掉了「正在输入」显示。';
        this.send('/chatbox/typing', Boolean(args.on));
        return args.on ? '已显示「正在输入」。' : '已取消「正在输入」。';
      },
    };

    const voice: ToolDef = {
      name: 'vrc_voice',
      tags: ['speak'],
      barrierAfter: true,
      description: '只出声不出字（小声嘀咕用）。引擎没配好会直接说没配，不会装作说了。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: async (args) => this.enqueueVoiceOnly(String(args.text ?? '')),
    };

    const param: ToolDef = {
      name: 'vrc_param',
      tags: ['write'],
      description: '设一个化身参数（只在 paramEnabled 打开时可用）。名字要和模型里的参数完全一致。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '参数名，如 MouthOpen' },
          value: { description: 'true / false / 数字' },
        },
        required: ['name', 'value'],
      },
      handler: async (args) => {
        if (!this.cfg.paramEnabled) return '化身参数驱动是关着的（worlds.vrc.paramEnabled=false）。';
        const name = String(args.name ?? '');
        if (!name) return '参数名为空。';
        const v = args.value;
        const oscArg: OscArg = typeof v === 'boolean' ? v : Number.isInteger(Number(v)) ? Number(v) : Number(v);
        this.send('/avatar/parameters/' + name, oscArg);
        return `已发送 /avatar/parameters/${name} = ${String(v)}`;
      },
    };

    return [status, say, text, typing, voice, param];
  }

  // ---------- 发送 ----------

  private send(address: string, ...args: OscArg[]): void {
    if (!this.out) return;
    try {
      const buf = encode(address, ...args);
      this.out.send(buf, this.cfg.outPort, this.cfg.host, () => {});
      this.sent += 1;
    } catch {
      // 发不出去就算了，状态里能看到
    }
  }

  private chatbox(line: string): void {
    if (!this.cfg.chatboxEnabled) return;
    this.send('/chatbox/input', line, true, this.cfg.notifySound);
  }

  private split(text: string): string[] {
    const limit = this.cfg.chatboxLimit;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= limit) return clean ? [clean] : [];
    // 优先在标点处断
    const out: string[] = [];
    let rest = clean;
    const punct = /[。！？；，、,.!?;]/;
    while (rest.length > limit) {
      let cut = -1;
      for (let i = limit; i > Math.floor(limit / 2); i -= 1) {
        if (punct.test(rest[i - 1] ?? '')) { cut = i; break; }
      }
      if (cut < 0) cut = limit;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
  }

  private async enqueue(text: string, voice: boolean): Promise<string> {
    const lines = this.split(text);
    if (!lines.length) return '没话可说。';
    if (!this.out) return 'OSC 发送端没起来（world 可能没 start）。';
    for (const line of lines) this.queue.push({ text: line, voice: voice && this.cfg.voiceEnabled });
    void this.pump();
    const voiceNote = voice && this.cfg.voiceEnabled ? '（含语音）' : '';
    return lines.length > 1
      ? `排了 ${lines.length} 条进 chatbox${voiceNote}：${lines.map((l) => '「' + l + '」').join(' ')}`
      : `发到 chatbox${voiceNote}：「${lines[0]}」`;
  }

  private async enqueueVoiceOnly(text: string): Promise<string> {
    if (!this.cfg.voiceEnabled || this.cfg.voiceProvider === 'off') {
      return '语音没开（worlds.vrc.voiceEnabled / voiceProvider 还是关着的）。';
    }
    this.queue.push({ text: text.trim(), voice: true });
    void this.pump();
    return `用语音说：「${text.trim()}」`;
  }

  /** 队列泵：按 chatboxIntervalMs 限速，串行发。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const gap = Date.now() - this.lastPumpAt;
        if (gap < this.cfg.chatboxIntervalMs) {
          await new Promise((r) => setTimeout(r, this.cfg.chatboxIntervalMs - gap));
        }
        const item = this.queue.shift();
        if (!item) break;
        this.chatbox(item.text);
        this.lastPumpAt = Date.now();
        if (item.voice) await this.speak(item.text);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 语音：按 provider 合成并播到配置的音频设备。 */
  private async speak(text: string): Promise<void> {
    if (this.cfg.voiceProvider === 'off' || !text.trim()) return;
    if (this.cfg.voiceProvider === 'feiyu') {
      this.lastVoiceError = '肥鱼声音服务还没接（HTTP 后端待装）';
      return;
    }
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'voice', 'say.py');
    await new Promise<void>((resolve) => {
      try {
        const child = spawn(
          'python',
          [script, '--text', text, '--device', this.cfg.voiceDevice, '--gain', String(this.cfg.voiceGain)],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let err = '';
        child.stdout?.on('data', () => {});
        child.stderr?.on('data', (c) => { err += c.toString(); });
        child.on('error', (e) => { this.lastVoiceError = e.message; resolve(); });
        child.on('close', (code) => {
          this.lastVoiceError = code === 0 ? '' : (err.slice(-200) || `退出码 ${code}`);
          resolve();
        });
      } catch (e) {
        this.lastVoiceError = (e as Error).message;
        resolve();
      }
    });
  }

  // ---------- 接收 ----------

  private onMessage(buf: Buffer): void {
    const msg = decode(buf);
    if (!msg) return;
    // 收到包就说明 VRChat 活着（它每帧推的物理参数正好当心跳用）
    this.lastInboundAt = Date.now();
    // 但只把有信息量的记下来：化身/世界变更、chatbox、头显状态。
    // /avatar/parameters/* 每秒几十条，全记会把日志和上下文刷爆。
    const meaningful = msg.address === '/avatar/change'
      || msg.address === '/world/change'
      || msg.address.startsWith('/chatbox/')
      || msg.address === '/tracking/vrsystem/headset/active';
    if (!meaningful) return;
    this.lastInbound = { address: msg.address, value: String(msg.args[0] ?? '') };
    if (msg.address === '/avatar/change') this.avatarId = String(msg.args[0] ?? '');
    if (msg.address === '/world/change') this.worldId = String(msg.args[0] ?? '');
  }

  private online(): boolean {
    return this.lastInboundAt > 0 && Date.now() - this.lastInboundAt < this.cfg.activeWithinSec * 1000;
  }

  private describeStatus(): string {
    const lines: string[] = [];
    const log = this.logTail.current();
    if (log.worldName) lines.push(`所在世界：${log.worldName}`);
    if (log.oscError) lines.push(`OSC 启动失败：${log.oscError}`);
    else if (log.oscEnabled === false) lines.push('OSC：日志里显示未开启');
    lines.push(this.online() ? 'VRChat：在线（OSC 有动静）' : 'VRChat：offline（没收到过 OSC，游戏可能没开或没开 OSC）');
    if (this.avatarId) lines.push(`当前化身：${this.avatarId}`);
    if (this.worldId) lines.push(`当前世界：${this.worldId}`);
    if (this.lastInbound) {
      const sec = Math.round((Date.now() - this.lastInboundAt) / 1000);
      lines.push(`最近一条：${this.lastInbound.address} = ${this.lastInbound.value.slice(0, 40)}（${sec}s 前）`);
    }
    lines.push(`发送：${this.cfg.host}:${this.cfg.outPort} ｜ 已发 ${this.sent} 条 ｜ 队列 ${this.queue.length}`);
    lines.push(`chatbox ${this.cfg.chatboxEnabled ? '开' : '关'}（上限 ${this.cfg.chatboxLimit} 字 / 间隔 ${this.cfg.chatboxIntervalMs}ms）`);
    lines.push(`语音 ${this.cfg.voiceEnabled ? '开' : '关'}（引擎 ${this.cfg.voiceProvider}${this.cfg.voiceEnabled && this.cfg.voiceProvider === 'piper' ? '，设备 ' + this.cfg.voiceDevice : ''}）`);
    if (this.cfg.voiceEnabled && this.lastVoiceError) lines.push(`上次语音失败：${this.lastVoiceError}`);
    return lines.join('\n');
  }
}

export { VRC_DEFAULTS };
