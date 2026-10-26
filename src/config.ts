import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

export interface VrcConfig {
  host: string;
  outPort: number;
  inPort: number;
  chatboxEnabled: boolean;
  chatboxLimit: number;
  chatboxIntervalMs: number;
  notifySound: boolean;
  typingIndicator: boolean;
  voiceEnabled: boolean;
  voiceProvider: 'off' | 'piper' | 'feiyu';
  voiceStyle: string;
  voiceDevice: string;
  voiceGain: number;
  voiceMix: 'solo' | 'voicemeeter';
  paramEnabled: boolean;
  activeWithinSec: number;
}

export const VRC_DEFAULTS: VrcConfig = {
  host: '127.0.0.1',
  outPort: 9000,   // VRChat 在 9000 上「听」我们的指令（它自己绑定这个端口）
  inPort: 9001,    // VRChat 从 9001 往外发状态
  chatboxEnabled: true,
  chatboxLimit: 144,
  chatboxIntervalMs: 1600,
  notifySound: false,
  typingIndicator: true,
  voiceEnabled: false,
  voiceProvider: 'off',
  voiceStyle: 'cute',
  voiceDevice: '虚拟扬声器 (VB-Audio Cable A)',
  voiceGain: 1,
  voiceMix: 'solo',
  paramEnabled: false,
  activeWithinSec: 120,
};

export function normalizeConfig(raw: Record<string, unknown>): VrcConfig {
  const cfg: VrcConfig = { ...VRC_DEFAULTS };
  const num = (v: unknown, lo: number, hi: number, fb: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
  };
  if (typeof raw.host === 'string' && raw.host.trim()) cfg.host = raw.host.trim();
  if (typeof raw.voiceDevice === 'string') cfg.voiceDevice = raw.voiceDevice;
  if (typeof raw.voiceStyle === 'string') cfg.voiceStyle = raw.voiceStyle;
  if (raw.voiceProvider === 'piper' || raw.voiceProvider === 'feiyu' || raw.voiceProvider === 'off') {
    cfg.voiceProvider = raw.voiceProvider;
  }
  if (raw.voiceMix === 'voicemeeter' || raw.voiceMix === 'solo') cfg.voiceMix = raw.voiceMix;
  for (const key of ['chatboxEnabled', 'notifySound', 'typingIndicator', 'voiceEnabled', 'paramEnabled'] as const) {
    if (typeof raw[key] === 'boolean') cfg[key] = raw[key] as boolean;
  }
  cfg.outPort = Math.round(num(raw.outPort, 1, 65535, cfg.outPort));
  cfg.inPort = Math.round(num(raw.inPort, 0, 65535, cfg.inPort));
  cfg.chatboxLimit = Math.round(num(raw.chatboxLimit, 32, 144, cfg.chatboxLimit));
  cfg.chatboxIntervalMs = Math.round(num(raw.chatboxIntervalMs, 300, 10000, cfg.chatboxIntervalMs));
  cfg.voiceGain = num(raw.voiceGain, 0, 2, cfg.voiceGain);
  cfg.activeWithinSec = Math.round(num(raw.activeWithinSec, 10, 3600, cfg.activeWithinSec));
  return cfg;
}

export function vrcConfigGroup(language: Language = 'zh'): ConfigGroup {
  const zh = language === 'zh';
  const t = (cn: string, en: string) => (zh ? cn : en);
  return {
    id: 'world:vrc',
    owner: 'world:vrc',
    schema: {
      type: 'object',
      title: t('VRChat 接入', 'VRChat bridge'),
      description: t(
        '通过 OSC 让桌宠在 VRChat 里说话（chatbox + 语音）。VRChat 要在 Action Menu → Options 里打开 OSC。',
        'Let the pet speak inside VRChat over OSC (chatbox + voice). Enable OSC in VRChat Action Menu.',
      ),
      properties: {
        'worlds.vrc.host': { type: 'string', title: t('OSC 目标地址', 'OSC host'), 'x-hot': false, default: VRC_DEFAULTS.host },
        'worlds.vrc.outPort': { type: 'integer', title: t('发送端口', 'Out port'), minimum: 1, maximum: 65535, 'x-hot': false, default: VRC_DEFAULTS.outPort },
        'worlds.vrc.inPort': { type: 'integer', title: t('接收端口（0=不听）', 'In port (0 = off)'), minimum: 0, maximum: 65535, 'x-hot': false, default: VRC_DEFAULTS.inPort },
        'worlds.vrc.chatboxEnabled': { type: 'boolean', title: t('把话送进游戏聊天框', 'Send to chatbox'), 'x-hot': true, default: true },
        'worlds.vrc.chatboxLimit': { type: 'integer', title: t('单条字数上限', 'Chatbox char limit'), minimum: 32, maximum: 144, 'x-hot': true, default: VRC_DEFAULTS.chatboxLimit },
        'worlds.vrc.chatboxIntervalMs': { type: 'integer', title: t('两条之间最小间隔（毫秒）', 'Min gap (ms)'), minimum: 300, maximum: 10000, 'x-hot': true, default: VRC_DEFAULTS.chatboxIntervalMs },
        'worlds.vrc.notifySound': { type: 'boolean', title: t('chatbox 播提示音', 'Chatbox sound'), 'x-hot': true, default: VRC_DEFAULTS.notifySound },
        'worlds.vrc.typingIndicator': { type: 'boolean', title: t('显示「正在输入」', 'Typing indicator'), 'x-hot': true, default: true },
        'worlds.vrc.voiceEnabled': { type: 'boolean', title: t('出声说话（走虚拟声卡）', 'Speak aloud (virtual cable)'), 'x-hot': true, default: false },
        'worlds.vrc.voiceProvider': {
          type: 'string', enum: ['off', 'piper', 'feiyu'], title: t('语音引擎', 'Voice engine'), 'x-hot': true, default: 'off',
          description: t('off=不出声；piper=本机 Piper（先跑通链路）；feiyu=肥鱼声音服务（好听，需另装）', 'off / piper / feiyu'),
        },
        'worlds.vrc.voiceStyle': { type: 'string', title: t('声线（fatfish 用）', 'Voice style'), 'x-hot': true, default: 'cute' },
        'worlds.vrc.voiceDevice': { type: 'string', title: t('播到哪个音频设备', 'Playback device'), 'x-hot': true, default: VRC_DEFAULTS.voiceDevice },
        'worlds.vrc.voiceGain': { type: 'number', title: t('音量', 'Gain'), minimum: 0, maximum: 2, 'x-hot': true, default: 1 },
        'worlds.vrc.voiceMix': { type: 'string', enum: ['solo', 'voicemeeter'], title: t('混音方式', 'Mix mode'), 'x-hot': true, default: 'solo' },
        'worlds.vrc.paramEnabled': { type: 'boolean', title: t('驱动化身参数（默认关闭）', 'Drive avatar params'), 'x-hot': true, default: false },
        'worlds.vrc.activeWithinSec': { type: 'integer', title: t('多久内有 OSC 动静算在线（秒）', 'Online window (s)'), minimum: 10, maximum: 3600, 'x-hot': true, default: 120 },
      },
    },
  } as ConfigGroup;
}
