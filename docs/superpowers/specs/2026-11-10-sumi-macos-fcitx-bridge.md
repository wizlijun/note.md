# Sumi macOS Fcitx5 候选桥实现规格

本实现遵守 `sumi-ime-cross-platform.md`；输入法为固定上游 `fcitx/fcitx5-macos@6322853b17aca03ce1f1b694208cc5201944ca69`。用户已选择该路线并授权源码改造。正式安装与发布不属于本轮。

## 接管身份与通信

Sumi 正文 NSTextView 在创建 inputContext 前生成稳定随机 UUID，并在公开 `validAttributesForMarkedText` 中额外声明 `com.notemd.sumi.candidates.v1.<UUID>` 属性。它只声明此 view 可接受候选展示协议，不代表允许接管，也不向正文写属性或占位字符。普通输入框不声明。Fcitx 通过当前 IMKTextInput 的同名公开接口查找唯一 marker；缺失或多个 marker 均保留默认窗。

两端使用公开 CFMessagePort 的本机异步单向消息构成双向通信，JSON UTF-8、版本 1、单消息不超过 256 KiB。正文 port 名等于完整 marker；输入法 reply port 为 `org.fcitx.Fcitx5.Sumi.<随机UUID>`。SendRequest 使用零等待、无同步 reply；业务确认另发消息，避免 IMK 主线程交叉等待。能力 token 不写日志、不广播，不按 bundle ID 替代握手。

每个消息含 `v:1,type,token,context`。token 为 marker 末尾 UUID，context 为 Fcitx 输入上下文的唯一字符串。hello 另含 reply；宿主确认当前第一响应者恰为正文、key window、App active、可见、可编辑、文档已就绪且无草稿错误后返回 ready，提供 `lease` 随机 UUID、`generation` 字符串。后续所有消息均携带 lease/generation，失焦、隐藏、关闭、换文档及错误撤销租约。端口创建失败只回退，不能影响正常输入。

## 消息与显示所有权

| 方向 | type | 附加字段与语义 |
| --- | --- | --- |
| IME→正文 | hello | reply；请求接管，不隐藏默认窗 |
| 正文→IME | ready | lease, generation；允许发送候选 |
| IME→正文 | snapshot | serial 字符串、candidates 数组 `{index,text,label,comment}`、cursor、hasPrev、hasNext；引擎每次更新递增 serial |
| 正文→IME | prepared | serial；该快照已完成布局但未首次显示 |
| IME→正文 | present | serial；IME 隐藏默认窗后请求显示这一快照 |
| 正文→IME | select | serial,index；保持正文焦点，由原引擎选词 |
| 正文→IME | page | serial,next 布尔；原引擎翻页 |
| IME→正文 | ping | 更新存活时间；每 250ms，仅在连接活跃时 |
| 正文→IME | pong | 更新存活时间；实时检查正文所有权 |
| 任一方向 | release | 撤销租约，清除展示状态；不提交或取消组字 |

握手后 1 秒没有存活确认则双端撤销。宿主每次收到消息和执行点击都验证精确正文焦点及文档 generation；输入法每次执行操作都验证 active controller、marker、Fcitx UUID/焦点、lease 和候选 serial。异步结果不能投到新的文本客户端。失效消息不改正文。旧连接退出/迟到消息不能撤销新连接。

默认候选持续可用直至 prepared；IME 先隐藏默认窗，再发送 present。若发送失败或超时，恢复当前仍有效输入上下文的默认候选。恢复只重新绘制原候选，不重置引擎。两端都不能使用阻塞式 RPC。

## 原生展示

候选作为 AppKit 展示层，不进入 NSTextStorage、CRDT 或撤销历史。继承正文实际字体和回退、字号、颜色、行高，横排和真实度量换行，最多四行，选中细下划线。长词按 composed character 边界省略；本地分页保留原候选索引，按钮仅普通文字。

专注时在当前完整视觉行下一行开始，向下展开，借现有只读 focus 展示层为下方正文留空，不改文本或原生滚动。普通模式固定正文 viewport 底部向上覆盖，背景与正文一致，不缩小 viewport、不改变选区/滚动；覆盖区内独立光标不可穿透。点击不夺第一响应者。字体/尺寸变化重排后仍保留真实 index。

预编辑仅在 Sumi 正文子类归一化为正文样式与细下划线，不等待异步候选握手，以免首次组字保留输入法传入的蓝底；搜索框等普通控件不变。候选断连不提前恢复尚在组字中的选区底色，结束组字后恢复普通选区反馈。自动 emoji 须从引擎生成/真实索引语义解决，不能仅绘制时过滤；没有局部开关的引擎不得默默修改全局配置。

Fcitx 的 CommonCandidateList 增加输入上下文第二层过滤，与引擎原过滤结果取交集，数字键和点击共同读取过滤后的真实列表。只在已握手正文应用 Unicode emoji 过滤，退出接管恢复原列表；引擎替换、删除或过滤候选会先废弃此临时层，避免保留失效候选指针。普通数字、#、* 与纯文本 © 保留；默认 emoji、VS16 与 keycap 等表情候选移除。不支持该列表接口的引擎回退默认窗口。补丁由配套输入法仓库 `patches/sumi-context-candidates.patch` 重放，不修改全局拼音设置。

点选和翻页期间维持精确输入上下文的同步事件状态；在取出 commit/preedit 结果前刷新 Fcitx 延迟 UI 队列。恢复默认候选窗仅重绘窗口，不经全局 controller 重放旧 preedit。

## 验收门槛

先验证本机跨进程 CFMessagePort、真实 IMK marker 转发、正文/搜索隔离、旧serial拒绝与断连回退，再验收真实拼音 nihao 点击/键盘恰好提交一次。真实 IMK 不支持 marker 时保留默认候选并记录不满足项，不退化为应用名接管。布局测试覆盖两模式、0→1→4→0行、窄窗、超长字形、底部光标遮挡、字体/缩放/全屏；数据测试覆盖取消、撤销、保存失败和重开。程序化组件/引擎测试与正式系统输入法实机测试分别记录。
