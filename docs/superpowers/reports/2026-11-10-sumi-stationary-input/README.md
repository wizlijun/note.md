# 非聚焦输入位置修正

用户最新要求替代此前“正文输入行也固定底部”：非聚焦模式保持原光标行和滚动位置，只将候选固定在底部。候选最多四行向上展开，不再改变正文 viewport 或边距；专注模式仍在输入下一行显示候选。

实现删除 bottom_anchor 及相关正文布局路径。候选 refresh/arrange 只修改自身布局，不再调用正文 appearance/position/defer_center。独立光标与候选相交时只停止绘制光标，使用 translate_coordinates 统一到 overlay 坐标，不改变输入选区或正文滚动。

回归包含真实 Fcitx 拼音、HeaderBar 和非零 bounds 原点 `(12,18)`。旧实现开始组字后将输入 Y 从33移到581，新增回归明确失败；修复后的测试要求：

- 空白文档开始组字时 caret Y/scroll 不变，正文 allocation 高度仍650。
- 40行文档在非零滚动位置、selection=100的中部输入；候选1→4→0行时，caret Y、scroll、allocation与selection全部保持一致。
- 同一中部位置实际输入nihao、选择你好，正文在原位置精确插入中文；输入行Y及scroll保持不变。
- 光标处于底部候选覆盖区时不穿透绘制，scroll保持不变。
- 专注下一行、富文本投影、普通输入框隔离、Fcitx重连与保存失败草稿均沿用真实回归。

测试使用独立Sway/D-Bus，不修改用户正文；隔离拼音配置关闭SymbolsEnabled，与用户不显示emoji的偏好一致。四行样本用于排版回归，不声称引擎产生了这些样本。未改系统已安装宿主，最终版本及包内GUI由发布任务整合后验收。

构建使用已有stable工具链与独立target缓存。一次并行链接被SIGKILL终止；后续仅对本次test构建使用单线程lld链接，未修改项目构建配置：

```sh
RUSTUP_TOOLCHAIN=stable CARGO_BUILD_JOBS=1 \
CARGO_TARGET_DIR=/home/bruce/git/note.md/tasks/sumi-fcitx/target \
cargo rustc --manifest-path tauri-plugin-native-editor/Cargo.toml \
  --profile test --lib --offline -- -C link-arg=-Wl,--threads=1
```

测试二进制为 `tauri_plugin_native_editor-fba2ee55b31a1a11`；普通测试直接运行，显示测试用 `scripts/sumi/fcitx-candidates/run-native.sh`，4倍设置 `SUMI_CANDIDATE_SCALE=4`。完整运行结果、源码/二进制哈希及截图见本目录证据。

高负载4倍运行在61.64秒的普通Entry检查得到原始组字串（保留 `keyboard-expiry-4x.log`）。检查到fixture两处常驻虚拟键盘都只保活60秒，短于runner允许的90秒；设备消失会清除键盘焦点并reset组字。已把保活延长至120秒以覆盖完整测试期限，仅改变测试环境，不改产品输入语义。最终4倍结果另存，不能用先前失败充当通过。

最终结果：26项普通测试、1倍/4倍真实候选回归、字形光标、编辑事务、重绘/800→400换行均通过。4倍最终运行65.83秒，超过旧键盘60秒寿命仍完整通过（包含普通Entry与草稿失败）。1倍及三个原生基础回归在修改测试键盘寿命前已通过，产品实现没有变化；最终测试二进制的普通测试重新确认26项通过。

[中部真实组字截图](nonfocus-middle-preedit.png)、[非聚焦四行](nonfocus-four-rows.png)、[专注四行](focus-four-rows.png)、[机器可读验收记录](verification.json)。仅实现与隔离回归已完成，未安装或发布到用户运行中的宿主。
