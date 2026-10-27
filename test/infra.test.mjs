/**
 * 基础设施单测：日志解析、OSCQuery、配置归一化、语音规则文件。
 * 都不碰真机（不起 VRChat、不播声音）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoomAccess } from '../src/vrclog.ts';
import { discoverOscQuery } from '../src/oscquery.ts';
import { normalizeConfig } from '../src/config.ts';
import { VrcWorld } from '../src/world.ts';

test('公开世界：Joining 行没有访问标签', () => {
  const r = parseRoomAccess('[Behaviour] Joining wrld_abc-123:12345~region(us)');
  assert.deepEqual(r, { access: 'public', worldId: 'wrld_abc-123' });
});

test('邀请制 / 好友 / friends+ / 群组 都能认出来', () => {
  assert.equal(parseRoomAccess('Joining wrld_1:1~private(usr_a)~region(us)')?.access, 'invite');
  assert.equal(parseRoomAccess('Joining wrld_1:1~friends(usr_a)~region(us)')?.access, 'friends');
  assert.equal(parseRoomAccess('Joining wrld_1:1~hidden(usr_a)~region(us)')?.access, 'friends+');
  assert.equal(parseRoomAccess('Joining wrld_1:1~group(grp_a)~region(us)')?.access, 'group');
  assert.equal(parseRoomAccess('Joining wrld_1:1~groupPublic(grp_a)~region(us)')?.access, 'group');
});

test('不是 Joining 行就返回 null', () => {
  assert.equal(parseRoomAccess('[Behaviour] Entering Room: 某世界'), null);
  assert.equal(parseRoomAccess(''), null);
});

test('OSCQuery 能读到 OSC_PORT', async () => {
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/?HOST_INFO')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ OSC_IP: '127.0.0.1', OSC_PORT: 9500, OSC_TRANSPORT: 'UDP' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const info = await discoverOscQuery('127.0.0.1', port, 2000);
    assert.equal(info?.outPort, 9500);
  } finally {
    srv.close();
  }
});

test('OSCQuery 连不上就是 null，不抛', async () => {
  const info = await discoverOscQuery('127.0.0.1', 1, 300);
  assert.equal(info, null);
});

test('新配置项都有默认值，且能归一化', () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.oscQuery, true);
  assert.equal(cfg.oscQueryPort, 9001);
  assert.equal(cfg.voiceWorker, true);
  assert.equal(cfg.erpRequirePrivate, false);
  assert.equal(cfg.erp.idleTimeoutSec, 900);
  assert.match(cfg.feiyuUrl, /^http/);
  const custom = normalizeConfig({
    oscQuery: false,
    oscQueryPort: 70000,
    erpIdleTimeoutSec: -5,
    erpRequirePrivate: true,
  });
  assert.equal(custom.oscQuery, false);
  assert.equal(custom.oscQueryPort, 65535, '端口要夹到合法范围');
  assert.equal(custom.erp.idleTimeoutSec, 0, '负数夹到 0');
  assert.equal(custom.erpRequirePrivate, true);
});

test('erpPromptFile 指定了就用它', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrc-erp-'));
  const file = join(dir, 'custom.md');
  writeFileSync(file, '自定义规则：演到底。', 'utf8');
  const w = new VrcWorld({ cfg: { erpEnabled: true, erpPromptFile: file } });
  const body = w.envPromptVars()['vrc.erp'];
  assert.match(body, /自定义规则/);
});

test('voiceMix=voicemeeter 时状态里写的是 VoiceMeeter 设备', () => {
  const w = new VrcWorld({
    cfg: { voiceEnabled: true, voiceProvider: 'piper', voiceMix: 'voicemeeter', voicemeeterDevice: 'VAIO Input' },
  });
  const status = w.tools().find((t) => t.name === 'vrc_status').handler({});
  return Promise.resolve(status).then((text) => {
    assert.match(text, /VoiceMeeter/);
    assert.match(text, /VAIO Input/);
  });
});
