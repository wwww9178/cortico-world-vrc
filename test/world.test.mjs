/**
 * World 层单测：用注入口把 OSC 出口换成数组，断言「到底发了什么」。
 * 不发 UDP、不开 socket、不跑 python（voiceProvider=off）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VrcWorld } from '../src/world.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWorld(cfg = {}) {
  const sent = [];
  const w = new VrcWorld({
    cfg: { chatboxIntervalMs: 300, voiceProvider: 'off', ...cfg },
    transport: { send: (address, ...args) => sent.push([address, ...args]) },
  });
  const tool = (name) => w.tools().find((t) => t.name === name);
  const call = async (name, args) => tool(name).handler(args);
  return { w, sent, call };
}

const chatboxLines = (sent) => sent.filter(([a]) => a === '/chatbox/input').map((m) => m[1]);

test('ERP 一句只进 chatbox 一次（不会双发）', async () => {
  const { sent, call } = makeWorld({ erpEnabled: true });
  await call('vrc_erp', { action: 'start' });
  await call('vrc_erp', { action: 'say', text: '嗯…过来' });
  await sleep(30);
  const lines = chatboxLines(sent);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '嗯…过来');
});

test('ERP 长台词按 144 字分条，每条都不超限', async () => {
  const { sent, call } = makeWorld({ erpEnabled: true });
  await call('vrc_erp', { action: 'start' });
  const long = '一'.repeat(300);
  await call('vrc_erp', { action: 'say', text: long });
  await sleep(1100);
  const lines = chatboxLines(sent);
  assert.ok(lines.length >= 3, `预期至少 3 条，实际 ${lines.length}`);
  assert.ok(lines.every((l) => l.length <= 144), '有单条超过 144 字');
  assert.equal(lines.join(''), long);
});

test('erpChatbox 关掉时，ERP 台词一条都不进聊天框', async () => {
  const { sent, call } = makeWorld({ erpEnabled: true, erpChatbox: false });
  await call('vrc_erp', { action: 'start' });
  await call('vrc_erp', { action: 'say', text: '悄悄话' });
  await sleep(30);
  assert.deepEqual(chatboxLines(sent), []);
});

test('ERP 动作走旁白，也只发一条', async () => {
  const { sent, call } = makeWorld({ erpEnabled: true });
  await call('vrc_erp', { action: 'start' });
  await call('vrc_erp', { action: 'act', text: '把发绳解开' });
  await sleep(30);
  assert.deepEqual(chatboxLines(sent), ['*把发绳解开*']);
});

test('阶段推进按 paramMap 切化身参数', async () => {
  const { sent, call } = makeWorld({
    erpEnabled: true,
    erpParamEnabled: true,
    erpParamMap: { '1': 'NSFW1', '2': 'NSFW2' },
  });
  await call('vrc_erp', { action: 'start' });
  await call('vrc_erp', { action: 'stage', target: 2 });
  const params = sent.filter(([a]) => a.startsWith('/avatar/parameters/'));
  assert.deepEqual(params.map(([a, v]) => [a, v]), [['/avatar/parameters/NSFW2', true]]);
});

test('vrc_say 仍按老路走：分条 + 限速，不重复', async () => {
  const { sent, call } = makeWorld({});
  await call('vrc_say', { text: '鲸鱼娘来啦' });
  await sleep(30);
  assert.deepEqual(chatboxLines(sent), ['鲸鱼娘来啦']);
});

test('没 start 时 ERP say 不发任何东西', async () => {
  const { sent, call } = makeWorld({ erpEnabled: true });
  const note = await call('vrc_erp', { action: 'say', text: '嗯' });
  await sleep(30);
  assert.deepEqual(sent, []);
  assert.match(note, /没在进行|先 vrc_erp start/);
});
