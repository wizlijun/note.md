# Sumi 发布产物只读验收

目标宿主 `6.1108.6`、Sumi `0.1.5`。本轮宿主保留原生编辑桥，字体目录及后台交给插件；旧版本证据不回写。本验证器不构建、不启动、不安装、不签名、不发布；DMG仅使用自己创建的只读挂载点。

## 冻结与实际产物

先精确提交源码，再构建宿主、插件UI及当前平台后台。后台必须完成独立Developer ID签名与Apple公证；其签后字节用于冻结和最终插件包。当前manifest只声明arm64，正式冻结和验收明确拒绝Intel。未来若要支持Intel，须先扩展manifest并独立构建、冻结和验收，不能共用包含后台二进制摘要的冻结输入。

```sh
python3 scripts/sumi/verify-release.py --self-test
python3 -m unittest discover -s scripts/sumi -p test_native_release.py
python3 scripts/sumi/verify-release.py --freeze-inputs \
  --arch arm64 --expected-source FULL_COMMIT_SHA \
  --dist dist --plugin-ui plugins-src/write/dist \
  --plugin-binary /absolute/native-aarch64-apple-darwin/notemd-sumi \
  --output /absolute/release/frozen-sumi-inputs.json
```

冻结schema2记录实际host完整JS模块、plugin manifest/UI/签后backend文件摘要，以及宿主关键源码、后台/protocol/write-core全部受控文件和插件10小资源。它不声称单凭摘要证明构建来源；必须保留同源码构建日志。被迁出的七个字体本体仍是ignored开发缓存，缺少缓存不阻止薄包验收；若缓存存在则严格匹配冻结catalog。

```sh
python3 scripts/sumi/verify-release.py \
  --arch arm64 --tag v6.1108.6 --expected-source FULL_COMMIT_SHA \
  --inputs /absolute/release/frozen-sumi-inputs.json \
  --app '/absolute/build/bundle/macos/note.md.app' \
  --depfile /absolute/build/deps/notemd_lib.d --dist dist \
  --dmg /absolute/release/note.md-6.1108.6-aarch64.dmg \
  --updater /absolute/release/note.md-aarch64.app.tar.gz \
  --updater-signature /absolute/release/note.md-aarch64.app.tar.gz.sig \
  --plugin-package /absolute/release/aarch64-apple-darwin.notemdpkg \
  --signature /absolute/release/aarch64-apple-darwin.notemdpkg.minisig \
  --expected-plugin-sha256 EXPECTED_REGISTRY_PACKAGE_SHA256 \
  --native-receipt /absolute/native-aarch64-apple-darwin/receipt.json \
  --native-notary-log /absolute/native-aarch64-apple-darwin/apple-notary-log.json \
  --native-probe-evidence /absolute/release/actual-native-process-probe.json \
  --expected-team-id T5G56DH47L \
  --output /absolute/release/sumi-verification-arm64.json
```

原有App/DMG codesign、spctl、stapler、版本/生产身份、updater minisign、三容器同Mach-O/CodeResources、原生Objective-C类/AppKit/CoreText且无Qt、四类host完整JS恢复检查全部保留。插件包必须与冻结manifest/UI/bin全清单及每个字节一致；minisign公钥取冻结宿主，不信包自带公钥。ZIP路径穿越、重复、软链接、后台缺执行位、错CPU均拒绝。

宿主/App/DMG/updater不得携带Sumi目录或Power素材路径；所有分发容器和插件不得夹带字体本体。`verify-extracted-assets.mjs`从冻结源码取得13GIF、10Sumi metadata及12WAV和音效清单，扫描dist和实际Mach-O的原始/完整base64内容及字体下载URL，并逐一读取实际depfile的全部Tauri codegen Brotli资源、证明压缩字节存在于实际Mach-O后解压检查。缓存资源不在binary、解压失败或缺源码都失败。它不是任意编码检测器，不把资源源字节当作DMG可节省大小。

插件`ui/sumi/`必须精确含manifest和9份许可/来源文件，目录/旧资源/缺失/篡改都拒绝；六组选项、七个字体精确PS、size/SHA/HTTPS和Zhuque ZIP约束继续验证。后台解包后必须与Apple Accepted归档内CDHash/CPU绑定的二进制相同，Developer ID、预期Team/identifier、runtime、secure timestamp和strict签名都必需；公证归档SHA、Apple jobId和最终backend源码摘要同时核对。

## Sumi独立后台公证流程

`scripts/release-plugins.sh sumi`只改变Sumi分支：默认`SUMI_RELEASE_TARGET=aarch64-apple-darwin`，使用既有Cargo/Vite/zip/minisign流程，但必须显式提供匹配Team的`APPLE_SIGNING_IDENTITY`和公证凭据（`SUMI_NOTARY_PROFILE`，或既有Apple环境变量）。不会打印凭据，也不执行市场上传。其它插件流程不变。

`scripts/sumi/native-release.py --sign-and-notarize`在独立证据目录复制并签名后台，上传包含签后后台的ZIP，保存submission ID后只等待同一个任务。模糊提交失败留attempt标记并停止，禁止自动重提；等待超时保留state可续跑；源/二进制/归档变化拒绝续用。只有Apple log中Accepted、statusCode0、归档SHA和ticket CDHash/CPU全部相符才生成receipt。裸CLI/ZIP没有App式stapling步骤，不伪造通过结果。

spctl对裸CLI的返回值和输出原样记录。正式验证只允许两种结果：明确`Notarized Developer ID`；或系统明确报告`the code is valid but does not seem to be an app`，且已有Accepted/CDHash证据和真实独立进程探针。后者报告仍标为**spctl未通过（不是App）**。其它拒绝（包括Unnotarized）、未知非零结果全部阻断，不能拿一次成功spawn替代Gatekeeper拒绝。

真实探针文件必须由隔离验收实际生成，不可手填：`ok:true`、`spawned:true`、`exit_code:0`、`isolated_vault:true`、`binary_sha256`匹配本次公证后台。该字段只证明受审计探针的运行结果；保存其原始测试日志和来源。首次离线执行、IME、队列恢复、关闭窗口继续下载等仍须单独功能验收，不由静态验证器宣称通过。

## 隔离宿主

`acceptance/prepare.py`读取插件资源目录；只有显式benchmark窗口才从ignored开发缓存带入大字体，正式插件不带。manifest声明后台时必须提供`--backend-binary`与`--backend-sha256`，否则拒绝准备。`acceptance/build.sh`构建并按隔离身份签名后台，准备专用App Support，再构建隔离宿主；它不会启动App。该隔离签名不等于正式Developer ID/Apple公证证据。

最终市场仍沿用Wrangler3+Account Token：不可变R2包/签名→匿名完整回读重验→兼容宿主公开→KV索引→公网复核。报告分别列宿主、插件和安装后合计的实际体积。

## 键盘音效资源

插件仅在 `resources/sounds/` 带一份 Typewriter/Thock 的12个WAV及两份清单，不保留重复的 `ui/sounds`。冻结阶段逐文件匹配tag中的资源，实际ZIP必须完全匹配冻结清单；`verify-sounds.py`核角色、SHA、大小和PCM格式。宿主真实Mach-O、Brotli嵌入资源及dist排除这些声音源字节/base64，保持音频引擎与素材在插件后台。签名后台探针从实际插件包解出完整布局，静音初始化两套真实输出，不申请输入监控、不注入键盘。
