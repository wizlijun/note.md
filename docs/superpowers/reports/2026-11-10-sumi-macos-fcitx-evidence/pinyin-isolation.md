# 真实拼音引擎隔离依赖

官方安装路径来源：src/config/installer.swift 的 pluginBaseAddress/getPluginFileName，以及官方插件仓库 fcitx-contrib/fcitx5-plugins macos-latest release。

已下载 chinese-addons-arm64.tar.bz2、chinese-addons-any.tar.bz2、meta-arm64.json；文件长度及SHA256均与GitHub Release API的digest核对通过，冻结清单在 build/pinyin-isolation/download-manifest.json。压缩包只解包到 build/pinyin-isolation/prefix，并先检查无绝对路径或目录穿越。

- 插件二进制：prefix/lib/fcitx5/libpinyin.so（arm64，依赖当前core5.1.23）。
- 配套addon配置：prefix/share/fcitx5/addon；引擎5.1.15，必需依赖punctuation。
- 词典：prefix/share/libime/sc.dict。
- 模型：prefix/lib/libime/zh_CN.lm及预测模型。
- prefix不在用户配置/系统输入法目录，不使用真实个人词典。

可运行独立加载验证：`build/pinyin-isolation/probe build/pinyin-isolation/prefix`，源码和可执行文件均在隔离build目录。

probe 使用裸 fcitx::Instance + 最小测试InputContext，避免调用src/fcitx.cpp中的 Fcitx::shared/setupEnv，因此无需修改硬编码安装路径。加载SharedLibrary时调用addonManager.registerDefaultLoader(nullptr)。只启用pinyin,punctuation，关闭其他全部addon（包括cloudpinyin）。

probe内实际环境配置：
- SKIP_FCITX_PATH=1
- SKIP_FCITX_USER_PATH=1（禁止用户数据读写路径，学习不落盘）
- XDG_DATA_DIRS=prefix/share
- FCITX_DATA_DIRS=prefix/share/fcitx5
- FCITX_ADDON_DIRS=prefix/lib/fcitx5
- LIBIME_MODEL_DIRS=prefix/lib/libime
- XDG_CONFIG_DIRS与FCITX_CONFIG_DIRS=prefix/empty-config
- XDG_CACHE_HOME=prefix/cache

不能直接使用setupTestingEnvironmentPath：该工具将SkipSystemPath置位，也跳过Generic Data目录，导致sc.dict加载失败。本次失败原因及修正由实际引擎加载验证，不靠更改生产路径绕过。

结果：真实输入nihao，候选为0你好、1👋、2拟好、3你、4拟、5泥、6逆；选择“你好”后恰好提交一次完整文字。日志 logs/pinyin-probe.log 有 REAL_PINYIN_OK。该测试证明真实引擎可加载与选词，不证明IMK跨进程/实际屏幕候选接管。

默认emoji候选确实存在，后续实现需要引擎局部选项处理，不能仅隐藏界面词条。未运行系统输入法安装，也未更改当前输入源。
