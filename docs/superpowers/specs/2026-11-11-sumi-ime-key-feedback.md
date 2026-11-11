# Linux Sumi 输入法完整按键反馈

## 问题
6.1111.5只在非空preedit改变时补声，漏掉直接提交中文标点、空格/回车确认、删空及不改变文本的候选操作。组字文本不能作为真实按键的替代。

## 协议与实现
在现有受租约约束的Fcitx候选桥接新增SetActiveWithTyping(s,as,b)->b。旧SetActive保持兼容，不擅自启用监控。PreInputMethod只对已绑定且聚焦的确切输入上下文向租约拥有者定向发送TypingKey(s token,t serial,u time,u code,u role)，不传文本/keysym，不改变过滤/提交/候选行为。role为Key/Space/Enter/Delete/Modifier/KeyUp/SpaceUp。释放必须对应本租约已有按下；失焦、撤销与拥有者断连清空状态。

宿主按(time,hardware code,release)跨来源配对，保留最多128条未配对事件；只消费另一来源的同一事件，同来源重复时间戳仍逐次发声，避免Fcitx长按复用timestamp造成漏声。零身份不猜测去重。DBus serial拒绝重复或倒序消息；焦点、表面身份、可见/失败状态仍校验。已协商桥接时禁用preedit补声，本地快捷键/普通输入仍走原入口；旧模块UnknownMethod回退旧行为，不能把它宣称完整修复。

## 验收与交付
先在真实隔离Wayland/Fcitx补回归证明旧版本漏声，再覆盖nihao、中文。，、空格确认、回车确认、退格至空、候选导航、数字选词、英文及各释放；验证只响一次、重复长按、关闭音效、失焦/租约释放、旧协议不发信号。实际新旧包对照录制仅自有私有音频流，静默基线与英文正控齐备。完整修复需要宿主与Fcitx配套模块同时更新；封存源码归档/manifest/包SHA并验证实际安装进程，不能只更新其中一端。
