import type { WorldDefinition } from 'cortico/world.ts';
import { VRC_DEFAULTS } from './config.ts';
import { VrcWorld } from './world.ts';

/**
 * 「VRChat」：通过官方 OSC 接口让桌宠在游戏里说话。
 * chatbox 出字、虚拟声卡出声；默认不碰你的化身参数。
 */
export const VRC: WorldDefinition<Record<string, unknown>> = {
  id: 'vrc',
  label: 'VRChat',
  defaults: () => ({ ...VRC_DEFAULTS }),
  describe: {
    tools: [
      {
        name: 'vrc_status', tags: ['read'], summary: 'VRChat 通不通',
        description: '看 VRChat 那边通不通：OSC 有没有动静、当前化身、chatbox 队列里有没有排着的句子。VRChat 没开会说 offline，不是报错。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        name: 'vrc_say', tags: ['speak'], barrierAfter: true, summary: '在 VRChat 里说一句',
        description: '在 VRChat 里说一句话：进游戏聊天框（超长自动分条、按间隔排队），配置开了语音的话同时出声。',
        parameters: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'boolean' } }, required: ['text'] },
      },
      {
        name: 'vrc_text', tags: ['speak'], barrierAfter: true, summary: '只出字',
        description: '只往游戏聊天框发文字，不出声。',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      {
        name: 'vrc_typing', tags: ['read'], summary: '正在输入',
        description: '在 VRChat 里显示/取消「正在输入」。',
        parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
      },
      {
        name: 'vrc_voice', tags: ['speak'], barrierAfter: true, summary: '只出声',
        description: '只出声不出字（小声嘀咕用）。',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      {
        name: 'vrc_param', tags: ['write'], summary: '设化身参数',
        description: '设一个化身参数（只在 paramEnabled 打开时可用）。',
        parameters: { type: 'object', properties: { name: { type: 'string' }, value: {} }, required: ['name', 'value'] },
      },
    ],
    events: [],
    // 环境提示词不在这里声明：它必须走 webUi().promptDocs（带 role:'envPrompt' 和文件路径），
    // 写在这个数组里会被静默忽略，渲染出来是空字符串。
    prompts: [],
  },
  create: (ctx) => new VrcWorld({ cfg: (ctx as { cfg?: Record<string, unknown> }).cfg }),
};
