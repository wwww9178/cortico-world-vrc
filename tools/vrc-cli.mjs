/**
 * vrc-cli —— 独立调试工具（不接 Coopanion 也能跑）
 *
 * 用法：
 *   node --experimental-strip-types tools/vrc-cli.mjs listen            监听 9000+9001，打印 VRChat 发来的一切
 *   node --experimental-strip-types tools/vrc-cli.mjs send "要说的话" [端口]
 *
 * 用来验证两件事：VRChat 往哪个端口发、我们往哪个端口发能被它收到。
 */
import { createSocket } from 'node:dgram';
import { decode, encode } from '../src/osc.ts';

const [, , cmd, ...rest] = process.argv;

if (cmd === 'listen') {
  const all = rest.includes('--all');
  const ports = [9001];            // 只监听 VRChat 的输出口（9000 是它的输入口，被它自己占着）
  for (const port of ports) {
    const s = createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => console.log(`  [${port}] 绑定失败: ${e.message}`));
    s.on('message', (buf) => {
      const m = decode(buf);
      if (!m) return;
      // 默认把物理参数刷屏过滤掉，只留有意义的事件
      if (!all && /^\/avatar\/parameters\//.test(m.address)) return;
      const args = m.args.map((a) => (Buffer.isBuffer(a) ? `<blob ${a.length}>` : JSON.stringify(a))).join(' ');
      console.log(`  ← ${m.address}  ${args}`);
    });
    s.bind(port, '0.0.0.0', () => console.log(`监听 ${port}（VRChat 输出口；加 --all 显示物理参数刷屏）`));
  }
  setTimeout(() => process.exit(0), 30000);
} else if (cmd === 'send') {
  const text = rest[0] ?? '鲸鱼娘来啦。';
  const port = Number(rest[1] ?? 9000);
  const s = createSocket('udp4');
  const buf = encode('/chatbox/input', text, true, false);
  s.send(buf, port, '127.0.0.1', () => {
    console.log(`→ 发到 127.0.0.1:${port}  ${buf.length}B  ${JSON.stringify(text)}`);
  });
  setTimeout(() => { s.close(); }, 500);
} else {
  console.log('用法: listen | send "文本" [端口]');
}
