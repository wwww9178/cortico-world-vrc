/**
 * ERP（Erotic Role Play）模式：成人向角色扮演的状态机。
 *
 * 这里只做「状态 + 该发什么」，不碰 socket、不碰音频、不生成正文。
 * 每一句台词、每个动作都由调用方（模型）给，本模块负责：
 *   1. 阶段推进（预热 → 调情 → 前戏 → 深入 → 余韵）
 *   2. 把一句话拆成三路出口：chatbox 文字 / 语音 / 化身参数
 *   3. 记住场景、进度、说了多少句，供 vrc_erp status 回读
 *
 * 出口由 `ErpEmit` 描述，world.ts 拿到后真正发出去；测试只断言 emit，
 * 所以「这句到底进没进 chatbox」是可验证的，不靠自觉。
 */

/** 阶段名。索引即阶段号，0 起。 */
export const ERP_STAGES = ['预热', '调情', '前戏', '深入', '余韵'] as const;

/** 阶段上限（含）。 */
export const ERP_MAX_STAGE = ERP_STAGES.length - 1;

export type ErpPhase = 'idle' | 'active';

export interface ErpConfig {
  /** 总开关。关着时 vrc_erp 拒绝一切动作。 */
  enabled: boolean;
  /** 场景：在哪、什么气氛、谁先开口。空串表示由模型自己起。 */
  scene: string;
  /** 对方在这段里怎么称呼。 */
  partner: string;
  /** 起始阶段（0..4）。 */
  stage: number;
  /** 台词要不要进 chatbox（游戏内聊天气泡）。 */
  chatbox: boolean;
  /** 要不要同时出声。 */
  voice: boolean;
  /** 阶段推进时要不要顺手切化身参数。 */
  paramEnabled: boolean;
  /** 阶段号 → 要打开的 bool 参数名（常见 NSFW1 / NSFW2 / ERP_Toggle）。 */
  paramMap: Record<string, string>;
}

export const ERP_DEFAULTS: ErpConfig = {
  enabled: false,
  scene: '',
  partner: '主人',
  stage: 0,
  chatbox: true,
  voice: true,
  paramEnabled: false,
  paramMap: { '1': 'NSFW1', '2': 'NSFW2', '3': 'NSFW2', '4': '' },
};

function num(v: unknown, lo: number, hi: number, fb: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
}

export function normalizeErpConfig(raw: Record<string, unknown> = {}): ErpConfig {
  const cfg: ErpConfig = { ...ERP_DEFAULTS, paramMap: { ...ERP_DEFAULTS.paramMap } };
  if (typeof raw.erpEnabled === 'boolean') cfg.enabled = raw.erpEnabled;
  if (typeof raw.erpScene === 'string') cfg.scene = raw.erpScene;
  if (typeof raw.erpPartner === 'string' && raw.erpPartner.trim()) cfg.partner = raw.erpPartner.trim();
  if (typeof raw.erpChatbox === 'boolean') cfg.chatbox = raw.erpChatbox;
  if (typeof raw.erpVoice === 'boolean') cfg.voice = raw.erpVoice;
  if (typeof raw.erpParamEnabled === 'boolean') cfg.paramEnabled = raw.erpParamEnabled;
  cfg.stage = Math.round(num(raw.erpStage, 0, ERP_MAX_STAGE, cfg.stage));
  if (raw.erpParamMap && typeof raw.erpParamMap === 'object' && !Array.isArray(raw.erpParamMap)) {
    cfg.paramMap = {};
    for (const [k, v] of Object.entries(raw.erpParamMap as Record<string, unknown>)) {
      const stage = Number(k);
      if (!Number.isInteger(stage) || stage < 0 || stage > ERP_MAX_STAGE) continue;
      if (typeof v === 'string') cfg.paramMap[String(stage)] = v.trim();
    }
  }
  return cfg;
}

/** 一次动作要发出去的东西。world.ts 照着发；测试照着断言。 */
export interface ErpEmit {
  ok: boolean;
  /** 回给模型的一句话，说清这次到底发出去了什么。 */
  note: string;
  /** 进 chatbox 的正文（只有 chatbox 开着且这次是说话才有）。 */
  chatbox?: string;
  /** 出声。whisper=气声，breath=句首带一点喘息停顿。 */
  voice?: { text: string; whisper: boolean; breath: boolean };
  /** 要切的化身参数。 */
  params?: Array<{ name: string; value: boolean }>;
  /** 这句的实际出口（给模型看，也防止它以为进了游戏）。 */
  routed: Array<'chatbox' | 'voice' | 'param' | 'none'>;
}

export interface ErpState {
  phase: ErpPhase;
  stage: number;
  scene: string;
  partner: string;
  startedAt: number;
  lastAt: number;
  lines: number;
  lastLine: string;
}

export interface ErpDeps {
  now?: () => number;
}

/**
 * 成人向 RP 状态机。只有 `active` 时才肯发东西；
 * `stop` 之后必须重新 `start`，不会自己复活。
 */
export class Erp {
  private cfg: ErpConfig;

  private now: () => number;

  private state: ErpState;

  constructor(cfg: ErpConfig, deps: ErpDeps = {}) {
    this.cfg = cfg;
    this.now = deps.now ?? (() => Date.now());
    this.state = {
      phase: 'idle',
      stage: cfg.stage,
      scene: cfg.scene,
      partner: cfg.partner,
      startedAt: 0,
      lastAt: 0,
      lines: 0,
      lastLine: '',
    };
  }

  get config(): ErpConfig {
    return this.cfg;
  }

  snapshot(): ErpState {
    return { ...this.state };
  }

  /** 阶段名。 */
  stageName(stage = this.state.stage): string {
    return ERP_STAGES[stage] ?? ERP_STAGES[0];
  }

  /** 开启（或重开）。scene 给了就用新的，没给沿用配置里的。 */
  start(scene?: string): ErpEmit {
    if (!this.cfg.enabled) {
      return this.fail('ERP 没开（worlds.vrc.erpEnabled=false）。');
    }
    const s = this.state;
    s.phase = 'active';
    s.stage = this.cfg.stage;
    s.scene = (scene ?? this.cfg.scene ?? '').trim();
    s.partner = this.cfg.partner;
    s.startedAt = this.now();
    s.lastAt = s.startedAt;
    s.lines = 0;
    const params = this.stageParams(s.stage);
    return {
      ok: true,
      note: `ERP 开始：阶段「${this.stageName()}」${s.scene ? '，场景：' + s.scene : ''}。`
        + (this.cfg.chatbox ? '台词会进 chatbox。' : '台词不进 chatbox（只出声）。')
        + (this.cfg.voice ? '同时出声。' : '不出声。'),
      params,
      routed: [...(params ? ['param' as const] : [])],
    };
  }

  stop(): ErpEmit {
    const s = this.state;
    if (s.phase !== 'active') return this.fail('本来就没在进行。');
    s.phase = 'idle';
    // 收尾：把所有打开过的阶段参数全关掉
    const params: Array<{ name: string; value: boolean }> = [];
    for (const name of new Set(Object.values(this.cfg.paramMap).filter(Boolean))) {
      params.push({ name, value: false });
    }
    const lines = s.lines;
    s.lastAt = this.now();
    return {
      ok: true,
      note: `结束了（这段一共说了 ${lines} 句）。化身参数已复位。`,
      params: params.length ? params : undefined,
      routed: params.length ? ['param'] : ['none'],
    };
  }

  /** 设阶段（会夹在 0..4）。阶段变化时顺带切化身参数。 */
  setStage(target: number): ErpEmit {
    if (!this.cfg.enabled) return this.fail('ERP 没开。');
    const s = this.state;
    if (s.phase !== 'active') return this.fail('先 vrc_erp start 再推阶段。');
    const next = Math.min(ERP_MAX_STAGE, Math.max(0, Math.round(Number(target) || 0)));
    s.stage = next;
    s.lastAt = this.now();
    const params = this.stageParams(next);
    return {
      ok: true,
      note: `阶段 → ${next}「${this.stageName(next)}」`,
      params,
      routed: params ? ['param'] : ['none'],
    };
  }

  nextStage(): ErpEmit {
    return this.setStage(this.state.stage + 1);
  }

  /**
   * 说一句。出口按配置走：chatbox 文字 + 语音。
   * `mode` 决定这口气：normal / whisper / moan。
   */
  say(text: string, mode: 'normal' | 'whisper' | 'moan' = 'normal'): ErpEmit {
    if (!this.cfg.enabled) return this.fail('ERP 没开。');
    const s = this.state;
    if (s.phase !== 'active') return this.fail('现在没在进行，先 vrc_erp start。');
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return this.fail('没话可说。');

    const routed: Array<'chatbox' | 'voice' | 'param' | 'none'> = [];
    const emit: ErpEmit = { ok: true, note: '', routed };

    if (this.cfg.chatbox) {
      emit.chatbox = clean;
      routed.push('chatbox');
    }
    if (this.cfg.voice) {
      emit.voice = { text: clean, whisper: mode === 'whisper', breath: mode === 'moan' };
      routed.push('voice');
    }
    if (!routed.length) routed.push('none');

    s.lines += 1;
    s.lastAt = this.now();
    s.lastLine = clean.slice(0, 60);

    emit.note = routed.includes('none')
      ? '两个出口都关着，这句没有发出去。'
      : `说了（${this.stageName()}·第 ${s.lines} 句）：${routed.join(' + ')}`;
    return emit;
  }

  /** 一个动作/旁白。只走文字（没有台词就没有语音），并带出当前阶段参数。 */
  act(action: string): ErpEmit {
    if (!this.cfg.enabled) return this.fail('ERP 没开。');
    const s = this.state;
    if (s.phase !== 'active') return this.fail('现在没在进行，先 vrc_erp start。');
    const clean = String(action ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return this.fail('动作是空的。');
    const line = `*${clean}*`;
    const routed: Array<'chatbox' | 'voice' | 'param' | 'none'> = [];
    const emit: ErpEmit = { ok: true, note: '', routed };
    if (this.cfg.chatbox) {
      emit.chatbox = line;
      routed.push('chatbox');
    }
    const params = this.stageParams(s.stage);
    if (params) {
      emit.params = params;
      routed.push('param');
    }
    if (!routed.length) routed.push('none');
    s.lines += 1;
    s.lastAt = this.now();
    emit.note = `动作：${clean}`;
    return emit;
  }

  status(): string {
    const s = this.state;
    if (!this.cfg.enabled) return 'ERP：关着（worlds.vrc.erpEnabled=false）。';
    if (s.phase !== 'active') return `ERP：待机（上次停在「${this.stageName()}」${s.scene ? '，场景：' + s.scene : ''}）。`;
    const mins = Math.max(0, Math.round((this.now() - s.startedAt) / 60000));
    return [
      `ERP：进行中 ${s.stage}/${ERP_MAX_STAGE}「${this.stageName()}」`,
      s.scene ? `场景：${s.scene}` : '',
      `对方：${s.partner}`,
      `已 ${s.lines} 句｜${mins} 分钟`,
      `出口：${this.cfg.chatbox ? 'chatbox' : ''}${this.cfg.chatbox && this.cfg.voice ? '+' : ''}${this.cfg.voice ? '语音' : ''}${!this.cfg.chatbox && !this.cfg.voice ? '全关' : ''}`,
      s.lastLine ? `上一句：${s.lastLine}` : '',
    ].filter(Boolean).join('｜');
  }

  /** 阶段要切的参数：paramEnabled 关着就返回 undefined。 */
  private stageParams(stage: number): Array<{ name: string; value: boolean }> | undefined {
    if (!this.cfg.paramEnabled) return undefined;
    const name = this.cfg.paramMap[String(stage)];
    if (!name) return undefined;
    return [{ name, value: true }];
  }

  private fail(note: string): ErpEmit {
    return { ok: false, note, routed: ['none'] };
  }
}
