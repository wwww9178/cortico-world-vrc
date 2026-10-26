/**
 * ERP 状态机单测：node --experimental-strip-types --test test/
 * 只测纯逻辑（不发 OSC、不开 socket、不碰音频）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Erp, ERP_MAX_STAGE, normalizeErpConfig } from '../src/erp.ts';
import { normalizeConfig } from '../src/config.ts';
import { VrcWorld } from '../src/world.ts';

function erp(overrides = {}) {
  return new Erp(normalizeErpConfig({ erpEnabled: true, ...overrides }));
}

test('没开 ERP 时 start/say 都拒绝，且 routed 是 none', () => {
  const e = new Erp(normalizeErpConfig({}));
  const started = e.start('床上');
  assert.equal(started.ok, false);
  assert.deepEqual(started.routed, ['none']);
  const said = e.say('嗯');
  assert.equal(said.ok, false);
  assert.equal(said.chatbox, undefined);
  assert.equal(said.voice, undefined);
});

test('没 start 就 say：不发任何东西', () => {
  const e = erp();
  const r = e.say('嗯');
  assert.equal(r.ok, false);
  assert.deepEqual(r.routed, ['none']);
  assert.equal(r.chatbox, undefined);
});

test('start 之后 say 同时走 chatbox 与语音', () => {
  const e = erp();
  assert.equal(e.start('浴室').ok, true);
  const r = e.say('过来', 'whisper');
  assert.equal(r.ok, true);
  assert.equal(r.chatbox, '过来');
  assert.equal(r.voice.text, '过来');
  assert.equal(r.voice.whisper, true);
  assert.deepEqual(r.routed, ['chatbox', 'voice']);
});

test('chatbox 关掉后只说，不进聊天框（世界里看不见）', () => {
  const e = erp({ erpChatbox: false });
  e.start();
  const r = e.say('小声点');
  assert.equal(r.chatbox, undefined);
  assert.deepEqual(r.routed, ['voice']);
});

test('两个出口都关：routed 是 none，不假装说了', () => {
  const e = erp({ erpChatbox: false, erpVoice: false });
  e.start();
  const r = e.say('嗯');
  assert.equal(r.ok, true);
  assert.equal(r.chatbox, undefined);
  assert.equal(r.voice, undefined);
  assert.deepEqual(r.routed, ['none']);
  assert.match(r.note, /没有发出去/);
});

test('阶段夹在 0..max 之间', () => {
  const e = erp();
  e.start();
  assert.equal(e.setStage(99).ok, true);
  assert.equal(e.snapshot().stage, ERP_MAX_STAGE);
  e.setStage(-5);
  assert.equal(e.snapshot().stage, 0);
});

test('next 每次 +1，到顶不动', () => {
  const e = erp();
  e.start();
  for (let i = 0; i < ERP_MAX_STAGE + 3; i += 1) e.nextStage();
  assert.equal(e.snapshot().stage, ERP_MAX_STAGE);
});

test('stop 之后 say 拒绝，还要重新 start', () => {
  const e = erp();
  e.start();
  e.say('第一次');
  assert.equal(e.stop().ok, true);
  assert.equal(e.snapshot().phase, 'idle');
  const r = e.say('还想说');
  assert.equal(r.ok, false);
  assert.deepEqual(r.routed, ['none']);
});

test('stop 会把打开过的化身参数全部复位', () => {
  const e = erp({ erpParamEnabled: true, erpParamMap: { '1': 'NSFW1', '2': 'NSFW2' } });
  e.start();
  e.setStage(2);
  const r = e.stop();
  assert.equal(r.ok, true);
  const offs = (r.params ?? []).filter((p) => p.value === false).map((p) => p.name).sort();
  assert.deepEqual(offs, ['NSFW1', 'NSFW2']);
});

test('paramEnabled 关着时 stage 不切参数', () => {
  const e = erp({ erpParamEnabled: false, erpParamMap: { '1': 'NSFW1' } });
  e.start();
  const r = e.setStage(1);
  assert.equal(r.params, undefined);
  assert.deepEqual(r.routed, ['none']);
});

test('act 带出当前阶段参数，并包成旁白', () => {
  const e = erp({ erpParamEnabled: true, erpParamMap: { '0': 'ERP_Toggle' } });
  e.start();
  const r = e.act('把发绳解开');
  assert.equal(r.chatbox, '*把发绳解开*');
  assert.deepEqual(r.params, [{ name: 'ERP_Toggle', value: true }]);
  assert.deepEqual(r.routed, ['chatbox', 'param']);
});

test('配置归一化：阶段夹紧、未知阶段键丢掉', () => {
  const cfg = normalizeConfig({ erpEnabled: true, erpStage: 99, erpParamMap: { '2': 'A', '9': 'B', x: 'C' } });
  assert.equal(cfg.erp.enabled, true);
  assert.equal(cfg.erp.stage, ERP_MAX_STAGE);
  assert.deepEqual(cfg.erp.paramMap, { '2': 'A' });
});

test('world 的 vrc_erp 工具在，且环境变量给到 vrc.erp', () => {
  const w = new VrcWorld({ cfg: { erpEnabled: true, erpScene: '卧室' } });
  const names = w.tools().map((t) => t.name);
  assert.ok(names.includes('vrc_erp'));
  const vars = w.envPromptVars();
  assert.match(vars['vrc.erp'], /ERP/);
  assert.match(vars['vrc.erp'], /卧室/);
});

test('ERP 关着时 vrc.erp 是空串，不污染前缀', () => {
  const w = new VrcWorld({ cfg: {} });
  assert.equal(w.envPromptVars()['vrc.erp'], '');
});

test('没有安全词：说「停下」也照常发出去，不会自己中断', () => {
  const e = erp();
  e.start();
  const r = e.say('停下');
  assert.equal(r.ok, true);
  assert.equal(r.chatbox, '停下');
  assert.equal(e.snapshot().phase, 'active');
  assert.equal(e.snapshot().lines, 1);
});

test('只有显式 stop 才结束，中途 stage 推进不打断', () => {
  const e = erp();
  e.start();
  e.say('第一次');
  e.setStage(3);
  e.say('第二次');
  assert.equal(e.snapshot().phase, 'active');
  assert.equal(e.snapshot().lines, 2);
  assert.equal(e.stop().ok, true);
});
