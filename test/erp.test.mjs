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

test('状态落盘：重启后接着演（阶段/句数/场景都在）', async () => {
  const { FileErpStore } = await import('../src/erp.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'erp-state-')), 'state.json');

  const a = new Erp(normalizeErpConfig({ erpEnabled: true }), { store: new FileErpStore(file) });
  a.start('浴室');
  a.setStage(2);
  a.say('第一句');

  const b = new Erp(normalizeErpConfig({ erpEnabled: true }), { store: new FileErpStore(file) });
  const s = b.snapshot();
  assert.equal(s.phase, 'active');
  assert.equal(s.stage, 2);
  assert.equal(s.scene, '浴室');
  assert.equal(s.lines, 1);
});

test('落盘的状态如果已经超时，恢复时直接算 idle', async () => {
  const { FileErpStore, Erp: E } = await import('../src/erp.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'erp-exp-')), 'state.json');

  let clock = 1_000_000;
  const cfg = () => normalizeErpConfig({ erpEnabled: true, erpIdleTimeoutSec: 60 });
  const a = new E(cfg(), { store: new FileErpStore(file), now: () => clock });
  a.start();
  a.say('嗯');

  clock += 61_000;
  const b = new E(cfg(), { store: new FileErpStore(file), now: () => clock });
  assert.equal(b.snapshot().phase, 'idle');
});

test('空闲超时会自己收尾，并把阶段参数关掉', () => {
  let clock = 5_000_000;
  const e = new Erp(
    normalizeErpConfig({ erpEnabled: true, erpIdleTimeoutSec: 10, erpParamEnabled: true, erpParamMap: { '1': 'NSFW1' } }),
    { now: () => clock },
  );
  e.start();
  e.setStage(1);
  assert.ok(e.timeoutInMs() !== null);

  clock += 11_000;
  const emit = e.expireIfIdle();
  assert.ok(emit);
  assert.equal(e.snapshot().phase, 'idle');
  assert.deepEqual(emit.params, [{ name: 'NSFW1', value: false }]);
  assert.match(emit.note, /自动收尾/);

  // 再问一次就没有了
  assert.equal(e.expireIfIdle(), null);
});

test('idleTimeoutSec=0 时永不自动收尾', () => {
  let clock = 1;
  const e = new Erp(normalizeErpConfig({ erpEnabled: true, erpIdleTimeoutSec: 0 }), { now: () => clock });
  e.start();
  clock += 10_000_000;
  assert.equal(e.timeoutInMs(), null);
  assert.equal(e.expireIfIdle(), null);
  assert.equal(e.snapshot().phase, 'active');
});
