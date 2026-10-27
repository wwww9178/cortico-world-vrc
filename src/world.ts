import { spawn } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldWebUiDecl } from 'cortico/core/types.ts';
import { VRC_DEFAULTS, normalizeConfig, vrcConfigGroup, type VrcConfig } from './config.ts';
import { ERP_MAX_STAGE, Erp, FileErpStore, type ErpEmit } from './erp.ts';
import { discoverOscQuery } from './oscquery.ts';
import { decode, encode, type OscArg } from './osc.ts';
import { cleanupTempDir, synthFeiyu, VoiceWorker } from './voice.ts';
import { VrcLogTailer } from './vrclog.ts';

interface QueuedLine {
  text: string;
  voice: boolean;
  /** 这句要不要走 chatbox。语音附带的条目为 false，避免同一句在聊天框里出现两遍。 */
  chatbox?: boolean;
  /** 语音这口气：气声/喘息。 */
  whisper?: boolean;
  breath?: boolean;
}

/** 注入口：换掉 dgram 出口，单测就能断言「到底发出去了什么」。 */
export interface VrcTransport {
  send(address: string, ...args: OscArg[]): void;
}

export class VrcWorld implements World {
  readonly id = 'vrc';

  private cfg: VrcConfig;

  private erp: Erp;

  private transport: VrcTransport | null = null;

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

  /** OSCQuery 发现到的发送端口；null = 用配置里的。 */
  private outPortOverride: number | null = null;

  /** 语音常驻 worker；voiceWorker 关掉时为 null，退回一次性 spawn。 */
  private voiceWorker: VoiceWorker | null = null;

  /** ERP 空闲自动收尾的定时器。 */
  private erpTimer: NodeJS.Timeout | null = null;

  /** ERP_PROMPT.md 的按 mtime 缓存，免得每拼一次前缀都读盘。 */
  private erpPromptCache: { text: string; mtimeMs: number; file: string } | null = null;

  constructor(opts: { cfg?: Record<string, unknown>; transport?: VrcTransport } = {}) {
    this.cfg = normalizeConfig(opts.cfg ?? {});
    this.transport = opts.transport ?? null;
    const store = this.cfg.erpStateFile ? new FileErpStore(this.cfg.erpStateFile) : undefined;
    this.erp = new Erp(this.cfg.erp, { store });
    if (this.cfg.voiceWorker) {
      this.voiceWorker = new VoiceWorker({
        script: join(dirname(fileURLToPath(import.meta.url)), '..', 'voice', 'say.py'),
        onError: (m) => { this.lastVoiceError = m; },
      });
    }
    this.scheduleErpTimer();
  }

  async start(): Promise<void> {
    try { this.logTail.start(); } catch {}
    // OSCQuery：先问一句 VRChat 自己监听哪个端口，问不到就用配置里的
    if (this.cfg.oscQuery) {
      const found = await discoverOscQuery(this.cfg.host, this.cfg.oscQueryPort);
      this.outPortOverride = found ? found.outPort : null;
    }
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
    this.clearErpTimer();
    try { this.voiceWorker?.stop(); } catch {}
    this.voiceWorker = null;
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
    const erp = this.erpPrompt();
    if (!this.online()) {
      // 离线也可能刚在日志里看到过世界名（比如刚退出），那就不算完全没信息
      return {
        'vrc.state': log.worldName ? `VRChat 不在线（日志里最后一次所在世界：${log.worldName}）。` : '',
        'vrc.erp': erp,
      };
    }
    const bits = [`VRChat 在线${this.avatarId ? '（化身 ' + this.avatarId.slice(0, 12) + '）' : ''}`];
    if (log.worldName) bits.push(`世界「${log.worldName}」`);
    if (this.lastInbound) bits.push(`最近收到 ${this.lastInbound.address}`);
    return { 'vrc.state': bits.join('；') + '。', 'vrc.erp': erp };
  }

  /**
   * ERP 那段环境提示。平时返回空串（不污染前缀）；
   * 正文从 ERP_PROMPT.md 现读（按 mtime 缓存），改文件 + 重载前缀就生效，不用重启。
   */
  private erpPrompt(): string {
    const c = this.cfg.erp;
    if (!c.enabled) return '';
    const st = this.erp.snapshot();
    const head = this.erpPromptBody();
    const state = st.phase === 'active'
      ? `现在是进行中：第 ${st.stage} 阶段「${this.erp.stageName()}」${st.scene ? '，场景：' + st.scene : ''}，已说 ${st.lines} 句，接着演。`
      : `现在待机${c.scene ? '（默认场景：' + c.scene + '）' : ''}；要开始就 vrc_erp start。`;
    return [
      head,
      state,
      `出口：${c.chatbox ? 'chatbox（世界里所有人看得见）' : '不进 chatbox'} + ${c.voice ? '语音' : '不出声'}。`,
    ].join('\n\n');
  }

  /**
   * ERP 演出规则的正文，按优先级找：
   *   1. worlds.vrc.erpPromptFile（部署方自己放的那份）
   *   2. 包内 ERP_PROMPT.md（本地开发时用）
   *   3. examples/ERP_PROMPT.template.md（仓库里只留模板）
   * 找不到就用一句兜底，不让整个环境段炸掉。
   */
  private erpPromptBody(): string {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const candidates = [
      this.cfg.erpPromptFile,
      join(root, 'ERP_PROMPT.md'),
      join(root, 'examples', 'ERP_PROMPT.template.md'),
    ].filter(Boolean);
    for (const file of candidates) {
      try {
        const mtimeMs = statSync(file).mtimeMs;
        if (!this.erpPromptCache || this.erpPromptCache.file !== file || this.erpPromptCache.mtimeMs !== mtimeMs) {
          this.erpPromptCache = { text: readFileSync(file, 'utf8').trim(), mtimeMs, file };
        }
        return this.erpPromptCache.text;
      } catch {
        // 换下一个候选
      }
    }
    return 'VRChat 的 ERP 模式开着（没找到规则文件）：vrc_erp start / say / act / stage / next / stop / status。';
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    // 环境提示词必须走 promptDocs 声明（describe.prompts 那种写法会被忽略，渲染出来是空）
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'ENV_PROMPT.md');
    return {
      label: language === 'zh' ? 'VRChat' : 'VRChat',
      config: [vrcConfigGroup(language)],
      promptDocs: [
        {
          key: 'worlds.vrc.envPrompt',
          title: language === 'zh' ? 'VRChat · 环境提示词' : 'VRChat · env prompt',
          role: 'envPrompt',
          path: envPath,
          vars: [
            { name: 'vrc.state', description: 'VRChat 在线状态、化身、世界名' },
            { name: 'vrc.erp', description: 'ERP 模式状态（关着时为空）' },
          ],
        },
      ],
    } as WorldWebUiDecl;
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

    const erp: ToolDef = {
      name: 'vrc_erp',
      tags: ['speak'],
      barrierAfter: true,
      description:
        `成人向角色扮演（ERP）。action 七选一：`
        + `start 开始（可带 scene）；stop 结束；stage 跳到某阶段（target=0..${ERP_MAX_STAGE}）；`
        + `next 推一阶段；say 说一句（text，可选 mode=normal|whisper|moan）；act 做一个动作/旁白（text）；status 看状态。`
        + `台词按配置决定进不进 chatbox、出不出声。没 start 前 say/act 不发东西。`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'stage', 'next', 'say', 'act', 'status'] },
          scene: { type: 'string', description: 'start 时用：在哪、什么气氛、谁先开口' },
          target: { type: 'integer', description: `stage 时用：目标阶段 0..${ERP_MAX_STAGE}` },
          text: { type: 'string', description: 'say / act 的正文' },
          mode: { type: 'string', enum: ['normal', 'whisper', 'moan'], description: 'say 的口气，默认 normal' },
        },
        required: ['action'],
      },
      handler: async (args) => this.erpAction(String(args.action ?? 'status'), args),
    };

    return [status, say, text, typing, voice, param, erp];
  }

  /** 房间是不是公开的（从 VRChat 日志的 Joining 行读）。 */
  private roomAccess(): string {
    return this.logTail.current().access;
  }

  /** 每动一次就重排一次空闲计时；到点自己收尾。 */
  private scheduleErpTimer(): void {
    this.clearErpTimer();
    const ms = this.erp.timeoutInMs();
    if (ms === null) return;
    this.erpTimer = setTimeout(() => {
      this.erpTimer = null;
      const emit = this.erp.expireIfIdle();
      if (emit) this.applyEmit(emit);
      this.scheduleErpTimer();
    }, Math.max(1000, ms + 50));
    // 定时器不该把进程吊着
    this.erpTimer.unref?.();
  }

  private clearErpTimer(): void {
    if (!this.erpTimer) return;
    clearTimeout(this.erpTimer);
    this.erpTimer = null;
  }

  /** vrc_erp 的入口：把参数翻译成 Erp 的方法，再把 emit 真正发出去。 */
  private erpAction(action: string, args: Record<string, unknown>): string {
    let emit: ErpEmit;
    switch (action) {
      case 'start': {
        const access = this.roomAccess();
        if (this.cfg.erpRequirePrivate && access === 'public') {
          return '当前世界是公开的（日志里 Joining 行没有访问限制），按 erpRequirePrivate 不在公开场合开 ERP。'
            + '换个私人世界，或者把 worlds.vrc.erpRequirePrivate 关掉。';
        }
        emit = this.erp.start(typeof args.scene === 'string' ? args.scene : undefined);
        break;
      }
      case 'stop':
        emit = this.erp.stop();
        break;
      case 'stage':
        emit = this.erp.setStage(Number(args.target ?? 0));
        break;
      case 'next':
        emit = this.erp.nextStage();
        break;
      case 'say':
        emit = this.erp.say(String(args.text ?? ''), (args.mode as 'normal' | 'whisper' | 'moan') ?? 'normal');
        break;
      case 'act':
        emit = this.erp.act(String(args.text ?? ''));
        break;
      case 'status':
        return this.erp.status();
      default:
        return `不认识的 action：${action}`;
    }
    this.applyEmit(emit);
    this.scheduleErpTimer();
    return emit.note;
  }

  /** 照 ErpEmit 发货：台词按 144 字分条进 chatbox，语音单独排队，互不阻塞。 */
  private applyEmit(emit: ErpEmit): void {
    if (!emit.ok) return;
    if (emit.chatbox) {
      for (const line of this.split(emit.chatbox)) {
        this.queue.push({ text: line, voice: false, chatbox: true });
      }
    }
    if (emit.voice) {
      this.queue.push({
        text: emit.voice.text,
        voice: true,
        chatbox: false,
        whisper: emit.voice.whisper,
        breath: emit.voice.breath,
      });
    }
    if (emit.params) {
      for (const p of emit.params) {
        if (!p.name) continue;
        this.send('/avatar/parameters/' + p.name, p.value);
      }
    }
    if (this.queue.length) void this.pump();
  }

  // ---------- 发送 ----------

  private send(address: string, ...args: OscArg[]): void {
    if (this.transport) {
      try {
        this.transport.send(address, ...args);
        this.sent += 1;
      } catch {
        // 注入口抛错不影响主流程
      }
      return;
    }
    if (!this.out) return;
    try {
      const buf = encode(address, ...args);
      this.out.send(buf, this.outPortOverride ?? this.cfg.outPort, this.cfg.host, () => {});
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
    if (!this.out && !this.transport) return 'OSC 发送端没起来（world 可能没 start）。';
    for (const line of lines) {
      this.queue.push({ text: line, voice: voice && this.cfg.voiceEnabled, chatbox: true });
    }
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
    this.queue.push({ text: text.trim(), voice: true, chatbox: false });
    void this.pump();
    return `用语音说：「${text.trim()}」`;
  }

  /**
   * 队列泵：串行发。
   * 只有真正要进 chatbox 的条目前面才等 chatboxIntervalMs ——
   * 纯语音（含 ERP 的台词）不该被聊天框限速拖着走，否则一句要等 1.6 秒才出声。
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        if (!item) break;
        if (item.chatbox) {
          const gap = Date.now() - this.lastPumpAt;
          if (gap < this.cfg.chatboxIntervalMs) {
            await new Promise((r) => setTimeout(r, this.cfg.chatboxIntervalMs - gap));
          }
        }
        this.queue.shift();
        if (item.chatbox) {
          this.chatbox(item.text);
          this.lastPumpAt = Date.now();
        }
        if (item.voice) await this.speak(item.text, { whisper: item.whisper, breath: item.breath });
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 播到哪个设备：solo → Cable A；voicemeeter → VoiceMeeter 的输入。 */
  private voiceDeviceFor(): string {
    return this.cfg.voiceMix === 'voicemeeter' ? this.cfg.voicemeeterDevice : this.cfg.voiceDevice;
  }

  /** 语音：按 provider 合成并播到配置的音频设备。 */
  private async speak(text: string, opts: { whisper?: boolean; breath?: boolean } = {}): Promise<void> {
    const clean = text.trim();
    if (!clean || this.cfg.voiceProvider === 'off') return;
    const device = this.voiceDeviceFor();
    if (this.cfg.voiceProvider === 'feiyu') {
      await this.speakFeiyu(clean, device);
      return;
    }
    if (this.voiceWorker) {
      const r = await this.voiceWorker.speak({
        text: clean,
        device,
        gain: this.cfg.voiceGain,
        whisper: opts.whisper,
        breath: opts.breath,
      });
      this.lastVoiceError = r.ok ? '' : (r.error ?? '未知错误');
      return;
    }
    await this.speakOneShot(clean, opts, device);
  }

  /** 常驻 worker 不可用时的退路：起一个 python 跑一句。 */
  private async speakOneShot(text: string, opts: { whisper?: boolean; breath?: boolean }, device: string): Promise<void> {
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'voice', 'say.py');
    const argv = [script, '--text', text, '--device', device, '--gain', String(this.cfg.voiceGain)];
    if (opts.whisper) argv.push('--whisper');
    if (opts.breath) argv.push('--breath');
    await new Promise<void>((resolve) => {
      try {
        const child = spawn('python', argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

  /** 肥鱼：POST 文本 → 拿 wav → 交给 say.py 播。 */
  private async speakFeiyu(text: string, device: string): Promise<void> {
    const got = await synthFeiyu(text, { url: this.cfg.feiyuUrl, style: this.cfg.voiceStyle });
    if (!got.wavPath) {
      this.lastVoiceError = `肥鱼后端没接上：${got.error ?? '未知错误'}`;
      return;
    }
    try {
      await new Promise<void>((resolve) => {
        const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'voice', 'say.py');
        const child = spawn(
          'python',
          [script, '--play-wav', got.wavPath!, '--device', device, '--gain', String(this.cfg.voiceGain)],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let err = '';
        child.stderr?.on('data', (c) => { err += c.toString(); });
        child.on('error', (e) => { this.lastVoiceError = e.message; resolve(); });
        child.on('close', (code) => {
          this.lastVoiceError = code === 0 ? '' : (err.slice(-200) || `退出码 ${code}`);
          resolve();
        });
      });
    } finally {
      cleanupTempDir(got.dir);
    }
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
    const port = this.outPortOverride ?? this.cfg.outPort;
    const portNote = this.outPortOverride ? `（OSCQuery 发现，配置写的是 ${this.cfg.outPort}）` : '';
    lines.push(`发送：${this.cfg.host}:${port}${portNote} ｜ 已发 ${this.sent} 条 ｜ 队列 ${this.queue.length}`);
    const access = this.roomAccess();
    if (access !== 'unknown') lines.push(`房间开放度：${access}${access === 'public' ? '（chatbox 全大厅可见）' : ''}`);
    if (this.cfg.voiceMix === 'voicemeeter') lines.push(`混音：VoiceMeeter（播到 ${this.cfg.voicemeeterDevice}）`);
    lines.push(`chatbox ${this.cfg.chatboxEnabled ? '开' : '关'}（上限 ${this.cfg.chatboxLimit} 字 / 间隔 ${this.cfg.chatboxIntervalMs}ms）`);
    lines.push(`语音 ${this.cfg.voiceEnabled ? '开' : '关'}（引擎 ${this.cfg.voiceProvider}${this.cfg.voiceEnabled && this.cfg.voiceProvider !== 'off' ? '，设备 ' + this.voiceDeviceFor() : ''}${this.voiceWorker ? '，常驻 worker' : ''}）`);
    if (this.cfg.voiceEnabled && this.lastVoiceError) lines.push(`上次语音失败：${this.lastVoiceError}`);
    lines.push(this.erp.status());
    return lines.join('\n');
  }
}

export { VRC_DEFAULTS };
