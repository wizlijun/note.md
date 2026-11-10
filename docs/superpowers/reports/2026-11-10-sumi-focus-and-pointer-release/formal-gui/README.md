# 正式 6.1110.6 GUI 与旧客户端更新验收

正式冻结源 024d81814b4076def2456428150a4a2cd84095de；Deb SHA 8f11cc89f73832b3ab2106552408c8289ac0fe87aaff47a02d81a9d8f48927d8。verification.json 与 matrix.json 为核心门禁，全部通过。真实 body click/drag/wheel、focus/nonfocus 候选鼠标提交、240 行中段滚动、scale 2/3 与奇偶高度、20 次连续输入均验证。只读 GTK 模块未修改正式进程行为，未加载 v5 诊断 mutation 模块。

frames 原始日志区分 after-paint frame 和 timer poll；matrix 明确取样时间窗及原文件 SHA。最早两个 stable 文件包含窗外后续记录，严格结论仅对应 matrix 所列连续静态 2 秒窗口，不冒充后续全程。正式 v6 的模式往返曾有限重排约 4.06/4.15 秒，不承诺瞬时全屏切换；固定布局不存在持续 1px 往返。v5 未发布失败与诊断 A/B 单独保存在 tasks/sumi-focus-v5/review，不将诊断成功当作正式包成功。

旧正式 6.1110.4 用全新私有缓存经真实 native HTTP 发现公开 6.1110.6。old4-evidence/verification.json 包含启动/手动时间与 canonical 下载链接；仅最后外部浏览器 opener 使用私有 URL sink，版本、HTTP、native capability/triple 均未 mock。没有安装/替换程序，三签包字节不变。新旧私有 fixture 均已停止；未操作用户桌面或配置。

clipboard-observation.json 记录范围外、待确认的取值编码观察；原始命令/MIME 未保存在证据，不将 debug/escaped 文件据为生产 Unicode 复制缺陷，也不宣称 Unicode clipboard 已通过。

所有正式二进制/包/签名不复制进此集合；artifacts 和来源记录包含路径与 SHA。inventory.json 为此集合逐文件哈希。此目录是待主代理精确归档提交的证据，未自行提交。
