# Sumi 发布产物只读验收

固定首发宿主 `6.1108.1`、插件 `0.1.0`。脚本不构建、不启动 App、不安装、不签名、不发布；DMG 使用独立只读挂载点，并只卸载本次挂载返回的设备。`artifact_checks.py` 从既有 diagram-transparent 发布验收器提取通用检查，只增加 DMG 资源回调。

先完成源码精确提交，再按同一提交构建宿主与插件 UI。冻结实际输入：

```sh
python3 scripts/sumi/verify-release.py --self-test
python3 scripts/sumi/verify-release.py --freeze-inputs \
  --expected-source FULL_COMMIT_SHA \
  --dist dist --plugin-ui plugins-src/write/dist \
  --output /absolute/release/frozen-sumi-inputs.json
```

`--freeze-inputs` 读取指定提交中的 Sumi 源码和字体清单，以及已构建宿主/插件 UI。它本身不证明构建发生于该提交；发布流程必须保存独立的构建日志与冻结输入。禁止用自测 fixture 代替生产输入。

签名、公证、staple 和打包由既有流程完成后：

```sh
python3 scripts/sumi/verify-release.py \
  --tag v6.1108.1 --expected-source FULL_COMMIT_SHA \
  --inputs /absolute/release/frozen-sumi-inputs.json \
  --app '/absolute/build/bundle/macos/note.md.app' \
  --depfile /absolute/build/deps/notemd_lib.d \
  --dist dist \
  --dmg /absolute/release/note.md-6.1108.1-aarch64.dmg \
  --updater /absolute/release/note.md-aarch64.app.tar.gz \
  --updater-signature /absolute/release/note.md-aarch64.app.tar.gz.sig \
  --plugin-package /absolute/release/universal.notemdpkg \
  --signature /absolute/release/universal.notemdpkg.minisig \
  --expected-plugin-sha256 EXPECTED_REGISTRY_PACKAGE_SHA256 \
  --output /absolute/release/sumi-verification.json
```

生产 binary 与 depfile 必须在本仓库 `src-tauri/target` 中。updater 的 `.sig` 默认取归档旁同名文件，按正式脚本解码 Tauri base64 包装并用冻结配置公钥验签。插件公钥从冻结宿主的 `PLUGIN_REGISTRY_PUBKEY` 获取，不接受包自带公钥。插件包必须与冻结的 manifest/UI 文件集合及每一项 SHA 完全一致；附加文件、缺项、路径穿越、软链接均拒绝。

验证同时覆盖：正式 bundle/version、arm64、codesign/spctl/stapler、App/updater/DMG 的相同 Mach-O 与签名资源清单、三字体及三许可证的精确字节、原生 Objective-C bridge class metadata、AppKit/CoreText 动态链接且无 Qt 动态链接、宿主 NativeFileView/Recovery/source/退出契约所处完整 JS 模块从 Mach-O 内 Brotli 片段恢复一致。不会把 token 检查称为行为测试，也不会把字节包含证明称为 PHF 运行路由验证。

仍需独立保存最终安装包的实机 UI、IME、辅助功能、离线合并和性能验收证据；该脚本不宣称这些已通过。脚本报告只写指定 `--output`，测试文件仅写临时目录。
