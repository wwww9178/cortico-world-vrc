# 发布手册（仓库由你自己推）

这台机器没有 `gh`、git 没配身份、npm 未登录，所以下面这些**需要你执行**。
所有要提交的文件都已就绪，仓库已经 init + 提交过一次。

## 一、推 GitHub

```bash
cd "C:\Users\MINECRAFTRice\Coopanion\data\local-ext\cortico-world-vrc"

# 1. 配身份（如果全局没配过）
git config user.name  "你的名字"
git config user.email "你的邮箱"

# 2. 建远端仓库（网页上新建空仓库，别勾 README）
#    假设账号 wwww9178，仓库名 cortico-world-vrc
git remote add origin https://github.com/wwww9178/cortico-world-vrc.git
git branch -M main
git push -u origin main
```

推之前建议确认：`package.json` 里的 `repository.url` 和你的仓库地址一致，不一致就改掉。

## 二、发 npm（可选）

```bash
npm login                    # 浏览器授权
npm publish --access public  # 名字没被占用就能直接发
```

包名 `cortico-world-vrc` 目前 npm 上**没有**。如果已被抢注，改成 `@你的scope/cortico-world-vrc`，
同时把 `package.json` 的 `name` 改掉。

发布前自检：

```bash
npm run test          # 30 个单测（OSC / ERP 状态机 / World 出口）
npm pack --dry-run    # 看会打包哪些文件（不该有 node_modules 和 wav）
```

`npm pack --dry-run` 里必须能看到 `ENV_PROMPT.md` 和 `ERP_PROMPT.md` —— 它们不在 `files` 里时
包能装上但跑起来是空的（`webUi().promptDocs` 指向 `../ENV_PROMPT.md`，读不到就整段没前缀）。

## 三、发布时建议一起贴的东西

1. **一段 10 秒录屏**：桌宠说话 → VRChat 聊天框出现同样的字（这是最有说服力的演示）
2. **声卡接线图**（README 里那段 ASCII 图就够）
3. **已知坑**：`Address already in use`（9000 被占）是最高频的问题，放在显眼处

## 四、还没做完、别在 README 里写成已完成的

| 项 | 状态 |
|---|---|
| 肥鱼 TTS 后端 | 只有配置位，没实现（`voiceProvider: feiyu` 时会如实报错） |
| VoiceMeeter 混音 | 只有 `voiceMix` 字段，逻辑未写 |
| OSCQuery 自动发现端口 | 没做，现在靠固定 9000/9001 |
| macOS / Linux | 未测试，`vrclog.ts` 的路径是 Windows 专用 |
| ERP 状态持久化 | 只在内存里；world 重启/应用重启后回到 idle（配置里的 `erpStage` 是起始值） |
| Piper 启动开销 | 每句 spawn 一次 python + 重载 onnx，1~3 秒延迟；ERP 场景下体感明显，未做常驻 worker |
| 世界公开性判定 | 不知道当前世界是不是 private；`erpChatbox` 全靠人看着关 |
