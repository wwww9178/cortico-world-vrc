/**
 * 单元测试：node --experimental-strip-types --test test/
 * 只测纯逻辑（OSC 编解码、文本分条），不碰网络和音频设备。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/osc.ts';

test('OSC 字符串与 4 字节对齐', () => {
  const buf = encode('/chatbox/input', 'hi', true, false);
  // "/chatbox/input"=14+1 → 16；",sTF"=4+1 → 8；"hi"=2+1 → 4
  assert.equal(buf.length, 16 + 8 + 4);
  assert.deepEqual(decode(buf), { address: '/chatbox/input', args: ['hi', true, false] });
});

test('中文文本往返不丢字节', () => {
  const text = '鲸鱼娘来啦，白米饭管够。';
  const m = decode(encode('/chatbox/input', text, true, false));
  assert.equal(m.args[0], text);
});

test('整数用 i、非整数用 f', () => {
  const i = decode(encode('/avatar/parameters/GestureLeft', 3));
  assert.equal(i.args[0], 3);
  const f = decode(encode('/avatar/parameters/MouthOpen', 0.5));
  assert.ok(Math.abs(f.args[0] - 0.5) < 1e-6);
});

test('blob 带长度前缀并补齐', () => {
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const m = decode(encode('/x', payload));
  assert.ok(Buffer.isBuffer(m.args[0]));
  assert.deepEqual([...m.args[0]], [1, 2, 3, 4, 5]);
});

test('非法数据返回 null 而不是抛异常', () => {
  assert.equal(decode(Buffer.from('not osc at all')), null);
  assert.equal(decode(Buffer.alloc(0)), null);
});

test('缺类型标签的报文返回 null', () => {
  const bad = Buffer.concat([
    Buffer.from('/x\0\0', 'utf8'),
    Buffer.from('no-comma\0\0\0\0', 'utf8'),
  ]);
  assert.equal(decode(bad), null);
});

test('地址不以 / 开头视为非法', () => {
  const bad = Buffer.concat([
    Buffer.from('chatbox\0\0\0\0', 'utf8'),
    Buffer.from(',s\0\0', 'utf8'),
    Buffer.from('x\0\0\0', 'utf8'),
  ]);
  assert.equal(decode(bad), null);
});
