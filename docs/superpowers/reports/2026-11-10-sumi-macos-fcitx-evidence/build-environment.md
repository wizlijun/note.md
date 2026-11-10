# Fcitx5 macOS 本地隔离构建环境

上游源码：6322853b17aca03ce1f1b694208cc5201944ca69；原始子模块版本见 submodule-baseline.txt。

- Xcode 26.6，Swift 6.3.3，arm64。
- 官方 scripts/install-deps.sh 下载9项预编译依赖到 cache，解压至 build/arm64/usr；哈希见 prebuilt-deps.sha256。
- 官方 scripts/patch.sh 应用两个核心补丁和 WebView Cocoa 补丁；patch 快照见 fcitx5-upstream.patch 与 webview-upstream.patch。
- ECM 6.27 从 download.kde.org 下载源码并安装至 build-tools/local。
- qpdf 12.4.2 从官方 GitHub release 下载源码，仅构建 qpdf target，使用本地静态 libqpdf、现有 jpeg-turbo 和系统 zlib；可执行文件复制至 build-tools/local/bin。
- CMake 独立 Python venv 安装在 build-tools/python；未升级系统 CMake。
- build-tools 和 logs 仅在本 checkout 的 .git/info/exclude 忽略，不修改项目 .gitignore。
- source build-tools/env.sh 后执行构建；不要执行默认 cmake --install，项目默认写 /Library/Input Methods。
- 运行 tests/config-cpp 前必须隔离配置，它会写入 ActiveByDefault 设置。src/fcitx.cpp 还硬编码 /Library 输入法资源路径，基线未改写这些路径。

## 首轮构建与测试结果

- 隔离 CMake 4.4.4 已安装成功。官方依赖完成下载，pnpm 首轮网络超时，使用缓存、300s fetch timeout、4并发重试后成功；依赖锁快照和哈希保存为 webview-pnpm-lock.yaml / webview-lock.sha256。
- 配置命令：`source build-tools/env.sh && cmake -B build/arm64 -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS_RELEASE='-O1 -DNDEBUG' -DCMAKE_Swift_FLAGS_RELEASE='-O' -DCMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH" -DKEY_LOGGING=OFF`。
- 全量构建：`cmake --build build/arm64 --parallel 4`，首轮141步完成；日志 build-app.log。
- 产物：build/arm64/src/Fcitx5.app/Contents/MacOS/Fcitx5，arm64，首轮哈希见 app-first-build.sha256。未安装、未启动、未打包签名。
- 纯函数/Swift 7项上游测试通过；key-release-cpp 上游隔离测试通过；新增 sumi-candidates-cpp 通过。分别见 safe-tests.log、key-release-test.log、sumi-tests.log。
- 未运行依赖系统安装路径的 config-cpp、icon-cpp、layout-cpp；不据此声称全套 ctest 通过。
- 全App首轮构建有 controller.swift MainActor 警告，已交实现agent修正。新增改造源码后续仍须增量重建与复验。
