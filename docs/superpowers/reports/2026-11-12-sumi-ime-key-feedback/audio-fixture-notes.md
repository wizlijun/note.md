# Linux Sumi 完整输入法按键音效实包对照

通过。有效旧包轮为 baseline2/，有效新包轮为 verified/；comparison.json 汇总24阶段实际PCM与GTK状态，并记录原始证据字节SHA。

旧版6.1111.5+r3：拼音过程有声，但Space选词、中文。与，、Return确认、退格删空、Left/Right组字导航、数字1选词这8个阶段峰值均0。新版6.1112.1+r4全部24阶段均有非零PCM（0.4894745），同一原签Sumi0.1.12后台与同一真实时间戳键盘helper；每阶段正文和preedit与旧版完全一致，未改变输入语义。两版静默基线均0、英文x正控均非零。新包23个阶段间录音间隙逐项验证峰值均0，未将前一键拖尾误计入后一键。

只在私有Sway/Fcitx、私有PipeWire/pipewire-pulse及WirePlumber policy profile下运行；录制实际签名Sumi后台PID的单独sink-input，唯一输出为null sink。未连接用户音频会话、未修改音量、未打开硬件音频设备或正式文档。所有宿主/后台/音频服务与fixture均已清理。新实际包截图 committed.png已打开审阅。

新包verification记录实际addon D-Bus包含SetActiveWithTyping/TypingKey、实际映射模块SHA，以及冻结标签中的keyboard.c与真实helper源码一致。新宿主SHA为6630c8b73d30767074c2e43acf72cdab3fed29b7e6757e975768cfce761b426b。

根目录 fixture/evidence 为首轮新包诊断，不计入通过：首次pinyin懒加载约750ms，固定等待过早读取GTK导致断言失败；该轮首键PCM实际上非零。最终verified轮改为等待真正GTK主循环新采样与预期正文/preedit就绪，不放宽音频断言或修改产品，使用同一冻结Deb与r4包。baseline/是早期参数变量名冲突的harness失败，baseline2才是完整旧包证据。所有失败轮也已清理。

复跑时复制脚本和input-tools/到新的目录，run-audio.py接受--version/--deb/--source-commit/--addon/--addon-sha/--addon-commit/--expect old或new；拒绝覆盖已有fixture。PCM为48kHz单声道float32le，完整文件本地保留，comparison.json记哈希。
