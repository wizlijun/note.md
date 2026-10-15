# Linux(Omarchy)发行与发版构建 —— 设计

> 类型:设计规格 · 日期:2026-10-15 · 代码基线:`main` @ 66f10b26(v6.1014.3)
> 前置文档:`docs/2026-08-08-pc-port-refactor-plan.md`(§7 Linux 专属工程)、`docs/2026-08-08-windows-port-analysis.md`
> 本文对前置文档 §7 / D2 / D6 中与 Linux 打包、渠道、构建机相关的结论做**取代性修订**(见 §2.3)。

---

## 0 · 一句话

**我们只出 Debian 基线构建的 `.deb`(x86_64 + aarch64),挂在 GitHub Release 上;Omarchy 侧由官方包仓库 `omacom/omarchy-pkgs` 的配方解包重打成 pacman 包,并由其 CI 盯我们的 Release 自动跟版。** 这与 Claude Desktop、ChatGPT/Codex Desktop 进入 Omarchy 的方式完全同构。

---

## 1 · 已拍板的决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 主渠道 | **向 `omacom/omarchy-pkgs` 提 PR**,进 Omarchy 官方 `[omarchy]` pacman 仓库。不自维护 AUR(可作为后续兜底,非本期) |
| D2 | 产物格式 | 只出 `.deb`。不出 AppImage / rpm / Flatpak / 自建 apt 仓库 |
| D3 | 架构 | **x86_64 + aarch64** 同发 |
| D4 | 构建环境 | **Debian 12(bookworm)容器**,在 macOS 发版机上用 Docker 构建 |
| D5 | 更新 | Linux 包**不走应用内更新**,交给 pacman(`omarchy update` / `pacman -Syu`)。`latest.json` 不增加 `linux-*` 键 |
| D6 | 发版时序 | `release.sh` 改为**先建 draft**;macOS / Windows / Linux 三段产物齐了再由新脚本统一 publish |
| D7 | 首发范围 | **Linux beta**:编辑器本体 + vault 能力;带原生二进制的插件不在首发(§3.2) |

---

## 2 · 参考:厂商与 Omarchy 的做法(2026-10 实查)

### 2.1 厂商

| 产品 | 官方 Linux 产物 | 更新机制 | 架构 |
|---|---|---|---|
| Claude Code | 原生安装脚本 + 签名 apt/dnf/apk 仓库(`stable`/`latest` 通道) | 安装脚本装的自更新;**包管理器装的不自更新** | x64 / arm64 |
| Claude Desktop(Linux beta) | **仅 apt 仓库**(Ubuntu 22.04+ / Debian 12+) | 随 `apt upgrade`,无内置 updater | amd64 / arm64 |
| Codex CLI | GitHub Releases 静态 musl 二进制 + npm + Homebrew | 包管理器 | x64 / arm64 |
| ChatGPT / Codex Desktop(preview) | `.deb` + `.rpm`;**官方不支持 Arch** | 包管理器 | x64 / arm64 |

规律:**厂商只出 Debian 系产物,Arch 由下游重打包;包管理器装的不自更新;beta 带明确的功能缺口清单**(Claude Desktop Linux beta 首发即缺 Computer Use、语音、Wayland 热键)。

### 2.2 Omarchy 的收录机制

- 系统 `pacman.conf` 自带 `[omarchy]` 仓库:`https://pkgs.omarchy.org/<channel>/$arch`,通道 `edge → rc → stable`。仓库中已有 `claude-desktop`、`openai-codex-desktop`、`claude-code`、`openai-codex-bin`、`typora` 等。
- 菜单安装只是一行:`bin/omarchy-install-ai-claude` → `omarchy-pkg-add claude-desktop`(即 `pacman -S`)。
- 配方在公开仓库 `omacom/omarchy-pkgs` 的 `pkgbuilds/<pkg>/`:`PKGBUILD` + `.omarchy/package.json`。`claude-desktop` / `openai-codex-desktop` / `typora` 的配方都是**下载厂商 `.deb` → `bsdtar` 解 `data.tar` 进 `$pkgdir`** → 视需要替换 `/usr/bin` 启动器。
- `.omarchy/package.json` 的 `upstream.watch`(`github` provider)让其 CI 自动发现新 Release、改写 `pkgver` 与校验和、开 PR、绿了自动合并。**draft 与 prerelease 被忽略**;**任一声明架构的产物缺失,该包本次更新整体失败**。
- `"release_ring": "fast"`:合并即发布到 edge/rc/stable。前提是产物不依赖 Arch 快照(厂商二进制、静态工具),由 `bin/check-fast-ring` 在三个通道上 `ldd -r` 校验依赖与 glibc 版本符号。
- 首次贡献者的 PR 需维护者打 `build-approved` 标签才会构建;一个 PR 只含一个包。

### 2.3 对前置文档的修订

| 前置文档结论 | 本文修订 | 理由 |
|---|---|---|
| D2:AppImage 为主 + deb 次之 | 只出 deb | Omarchy/厂商都走 deb 重打包;AppImage 自带的旧 WebKitGTK 在 Arch/Mesa 上问题最多,且 Omarchy 不需要应用内更新 |
| D6:Ubuntu 22.04 容器 | Debian 12 容器 | 同为老基线(glibc 2.36 ≤ 22.04 的 2.35 之上一点),Debian 12 与 Claude Desktop 的官方支持线一致;`libwebkit2gtk-4.1-0` / `libayatana-appindicator3-1` 均在 bookworm 主仓 |
| §7.5:AppImage 走 `linux-x86_64` 更新键 | 不写任何 `linux-*` 键 | 无 AppImage;包管理器负责更新 |
| 仅 x86_64 | x86_64 + aarch64 | Omarchy 已支持 aarch64(含 Asahi Mac,仓库有 `aarch64-apple` 平台) |
| 托盘依赖 Waybar | Omarchy 现用 Quickshell bar,自带 SNI 托盘组件(`shell/plugins/bar/widgets/Tray.qml`) | 上游已换栈 |

---

## 3 · 范围与功能对齐

### 3.1 功能对齐矩阵(macOS 为基准)

| 能力 | Omarchy beta | 说明 |
|---|---|---|
| 编辑器 / 阅读器 / `.note.md` 批注 / 镜像宿主 | ✅(需实测) | 渲染引擎是 **WebKitGTK**,第三套方言,§8 重点验收 |
| vault、搜索索引、OKF 导出 | ✅ | 纯 Rust / 前端,无平台分支 |
| vault git 同步 | ✅ | 走外部 `git`,包声明依赖 |
| CLI(`notemd …`) | ✅ | 包内 `/usr/bin/notemd` 即在 PATH;「安装 CLI」入口隐藏 |
| MCP socket | ✅ | 已按 `$XDG_RUNTIME_DIR` 分叉(`src-tauri/src/platform.rs:162`) |
| 单实例 / 文件关联 / `notemd://` deep link | ✅(经 §5 P0 修复) | 单实例走 DBus;关联与 scheme 由 `.desktop` 承载 |
| 主题 | ✅ | `theme_reveal` 已走 opener 三端通用 |
| 主题字体一键安装 | ❌ | `themes/fonts.rs` 非 macOS 返回错误;UI 隐藏 |
| 全局快捷键 | ⚠ 降级 | `global-hotkey` 只支持 X11,Hyprland 为纯 Wayland → 跳过注册,提供 Hyprland `bind` 替代入口(§5 P1-6) |
| 托盘 | ⚠ 降级 | 无 tooltip、角标不稳定、左键无事件,仅菜单;Omarchy 托盘默认在折叠区 |
| 应用内自动更新 | ❌(设计如此) | D5 |
| 「设为默认应用」 | ❌ | 由 `.desktop` MimeType + `xdg-mime` 承担,按钮隐藏 |
| 带原生二进制的插件(16 个) | ❌ 首发不含 | 见 §3.2 |
| 纯 UI 插件 | ⚠ 需实测 | `plugin://` 在 webkitgtk 上保持独立 origin(前置文档 §0.2),理论可用 |

### 3.2 插件缺口(必须在外宣中写明)

`scripts/release-plugins.sh:146,501,516,531,615,626,638` 的 triple 循环只有 `aarch64/x86_64-apple-darwin`,市场索引里没有任何 `*-unknown-linux-gnu` 二进制。受影响(`manifest.v2.json` 含 `binary`):agency、apple-notes、assistant-mail、claude-agent、codex-agent、conversation-dictionary、deepseek-agent、ebook-import、habitat、md2pdf、meetings、openclaw、pos-log、roam-import、strata、typst-reader。

- 其中 apple-notes、pos-log、md2pdf、ebook-import **永久 macOS-only**(系统框架绑定)。
- **app 内 agent 面板(claude-agent / codex-agent / deepseek-agent / openclaw)缺席**。与信念 5 的关系:文件层仍成立 —— 外部 Claude Code / Codex(Omarchy 预装)照样经 `AGENTS.md`、CLI、MCP 读写同一 vault;缺的是 app 内 UI。外宣措辞:「app 内 agent 面板稍后提供」,**不得**写「功能对齐」。
- 市场 UI 在 Linux 上必须对无本平台二进制的插件显示「当前平台不可用」,而不是允许点安装再报 `unsupported host arch`(§5 P1-11)。
- 补 Linux 插件构建是后续项目(PC-1.0),不在本期。

### 3.3 非目标

AppImage / rpm / Flatpak / 自建 apt 仓库;自维护 AUR;向 `basecamp/omarchy` 提 PR 加 Install 菜单项;`notemd setup omarchy`(Hyprland 绑定一键写入、主题跟随 Omarchy,参考 `hey setup omarchy` / `omazed`)—— 均为后续项。

---

## 4 · 构建与产物

### 4.1 构建容器

`scripts/docker/linux-build.Dockerfile`:

- `FROM debian:12`;`apt` 装 `build-essential pkg-config curl file libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf`(以 Tauri 2 Linux 前置清单为准,L1 实测收敛)。
- rustup 按 `src-tauri/rust-toolchain.toml`;Node 22 + Corepack(pnpm 版本取 `package.json` 的 `packageManager`)。
- 两个平台各构建一次:`--platform linux/arm64`(Apple Silicon 上原生)与 `--platform linux/amd64`(Rosetta,慢,预计数十分钟,L1 实测记录)。
- cargo registry / git 与 `target/` 用**按架构区分的命名卷**缓存;源码以只读方式挂入、容器内复制后构建,避免 `node_modules` 污染宿主。
- **`@moraya/core` 是 `file:../moraya-core`**:容器必须同时挂入同级的 `moraya-core` 仓库(其 `dist/` 已入库,无需构建),否则 `pnpm install` ENOENT(同 `docs/windows-agent-brief.md` 中「两个仓库要 clone 在同一层目录」的约束)。

### 4.2 `src-tauri/tauri.linux.conf.json`(新建)

Tauri 按平台文件 JSON Merge Patch 合并(数组整体替换)。要点:

- `bundle.targets: ["deb"]`;`bundle.createUpdaterArtifacts: false`(Linux 无 updater 产物,也不需要签名密钥)。
- `bundle.icon`:`icons/32x32.png`、`icons/128x128.png`、`icons/128x128@2x.png`、`icons/icon.png`(hicolor 多尺寸)。
- `bundle.linux.deb.depends`:`libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1`、`git`、`xdg-utils`。
- `bundle.linux.deb.desktopTemplate`:`linux/notemd.desktop.hbs`,`Exec=notemd --gui %U`,`MimeType` 含 `text/markdown;text/plain;x-scheme-handler/notemd;`,`StartupWMClass` 与窗口 app_id 对齐(L1 实测)。
- `bundle.fileAssociations`:补每项的 `mimeType`(Linux `.desktop` 只认 MIME,不认扩展名)。
- `bundle.license: "Apache-2.0"` + `licenseFile`(见 §4.4)。

### 4.3 产物与命名(Omarchy 配方依赖这个约定,不得随意改)

- `note.md_<version>_amd64.deb`、`note.md_<version>_arm64.deb`(Tauri 默认 `{productName}_{version}_{arch}`,L1 核实)。
- 包内布局(L1 以 `dpkg-deb -c` 核实并写回本节):`/usr/bin/notemd`、`/usr/lib/note.md/`(resources/themes)、`/usr/share/applications/*.desktop`、`/usr/share/icons/hicolor/*/apps/notemd.png`。
- 附 `SHA256SUMS-linux.txt`。

### 4.4 许可证前置

README 声明 Apache-2.0,但仓库根目录**没有 LICENSE 文件**,GitHub 也识别不到许可证。Omarchy 会再分发二进制,配方需 `license=('Apache-2.0')` 且应随包带许可证文本。**L1 先补根目录 `LICENSE`**(Apache-2.0 全文),deb 由 `bundle.licenseFile` 带入 `/usr/share/doc/`。

---

## 5 · 代码改动

### P0 —— 不修无法发版

1. **GUI 被判成 CLI 模式。** `is_cli_mode`(`src-tauri/src/cli/mod.rs:77`)只认 `.app/Contents/MacOS/` 与 `target/` 为 GUI;Linux 的 `/usr/bin/notemd` 基名为 `notemd` → 进 CLI 打印帮助后退出。修法:
   - `.desktop` 的 `Exec` 带 `--gui`(§4.2);`--gui` 已是首要判据(`mod.rs:81`)。
   - **任一参数以 `notemd:` 开头时判 GUI**:deep-link 运行时注册(`lib.rs:1872` `register_all`)写出的 handler `.desktop` 不带 `--gui`,且浏览器回调同样不经过我们的 `.desktop` 模板;只靠 Exec 不够。
   - 新增 Linux 路径单测:`/usr/bin/notemd --gui`→GUI;`/usr/bin/notemd`→CLI;`/usr/bin/notemd notemd://share/open?...`→GUI。
2. **CLI 安装在 Linux 上调用 `osascript`。** `src-tauri/src/cli/install.rs:64` 起的提权安装分支挂在 `#[cfg(unix)]`(`:112,:144` 调 `osascript`)。收窄为 `cfg(target_os = "macos")`;Linux 上该能力为 false,设置页隐藏「安装命令行工具」。
3. **分发渠道标记,关闭应用内更新。** 构建时注入 `NOTEMD_DIST_CHANNEL=package-manager`(Rust `option_env!`,默认 `direct`),经 Tauri 命令暴露给前端;`src/lib/updater.svelte.ts` 的 `initUpdater`/`runCheck` 在该渠道下不调用 `check()`,设置页更新区改为提示「通过系统包管理器更新(Omarchy:`omarchy update`)」。macOS/Windows 行为逐字节不变。
4. **工具链与配置。** `src-tauri/rust-toolchain.toml` 加 `x86_64-unknown-linux-gnu`、`aarch64-unknown-linux-gnu`;新建 `tauri.linux.conf.json` 与 desktop 模板(§4.2);根目录 `LICENSE`(§4.4)。

### P1 —— Omarchy 体验降级处理

5. **Linux 运行时环境开关。** GUI 启动、Tauri 初始化之前读取 `$XDG_CONFIG_HOME/net.notemd.app/linux-env.conf`(`KEY=VALUE`,注释 `#`),只放行白名单键:`WEBKIT_DISABLE_DMABUF_RENDERER`、`WEBKIT_DISABLE_COMPOSITING_MODE`、`GDK_BACKEND`、`GDK_SCALE`、`GDK_DPI_SCALE`。对应 Claude 配方的 `claude-desktop-flags.conf`,但做在我们自己的二进制里,任何发行版都受益;NVIDIA 白屏的逃生阀写进文档,不默认开启。
6. **Wayland 全局快捷键。** `reconcile_global_shortcuts`(`src-tauri/src/lib.rs:114`)在 Linux 且会话为 Wayland(`WAYLAND_DISPLAY` 存在且 `GDK_BACKEND` 非 `x11`)时跳过注册,并把「不可用」状态暴露给设置页。替代入口:`notemd --gui --action smart-search`(以及插件窗口动作)经单实例回调(`lib.rs:1394`)唤起已运行实例;设置页给出可复制的 Hyprland 片段,如 `bind = SUPER CTRL, M, exec, notemd --gui --action smart-search`。
7. **Hyprland 窗口装饰。** 检测 `HYPRLAND_INSTANCE_SIGNATURE` 时默认不画 GTK CSD 标题栏;收敛 7 处 `.decorations(true)`(`lib.rs:546,574,611,662,708`、`preview_window/mod.rs:88`、`plugin_runtime/windows.rs:361`)到一个平台函数,并提供设置项覆盖。是否默认关闭以 L4 实机观感为准。
8. **托盘降级。** Linux 不调用 tooltip/title;状态信息已在菜单首行(status_item 机制)。L4 核实「关窗后应用仍驻留托盘」在 Omarchy 托盘折叠的情况下不会让用户误以为已退出(`should_prevent_exit`,`lib.rs:380`)。
9. **字体栈。** 22 处只含 `Menlo` 的等宽栈(`src/styles/editor-base.css` 等 10 个文件)统一为 `ui-monospace,'SF Mono',Menlo,Consolas,'JetBrains Mono','CaskaydiaMono Nerd Font','DejaVu Sans Mono',monospace`;正文栈补 `'Noto Sans CJK SC'`。
10. **只在 macOS 有意义的入口隐藏。** 主题字体安装、「设为默认应用」(`set_default_app_for_extensions`,`lib.rs:499`)、location 等,按能力判断隐藏,而不是点击后报错。
11. **插件市场平台过滤。** 无当前 triple 二进制的插件显示「当前平台不可用」,不出安装按钮(安装路径在 `src-tauri/src/cli/builtin.rs:1425` 已会报 `unsupported host arch`,但那是失败而不是过滤)。

---

## 6 · 发版流程

### 6.1 `release.sh`:改为 draft 先行

- `gh release create` 恒带 `--draft`(现有 `--draft` 选项变为默认,`DRAFT` 分支删除)。tag 仍在建 Release 前推送(现状),三段脚本都按 tag 定位。
- 副作用(正面):draft 不是 `releases/latest`,macOS/Windows 客户端在 publish 前看不到 `latest.json`,不会出现「macOS 已能更新、Windows 包还没上」的窗口期。
- `scripts/release-windows.ps1` 的 `gh release view/upload/download`(`:193,:293,:303,:311,:318`)需在 draft 上可用 —— gh 对 draft 按 tag 回退查找,L5 实测确认;不可用则改为按 release id 操作。

### 6.2 `scripts/release-linux.sh <tag>`(新建,第三段)

与 Windows 段同构:**不建 Release、不打 tag、不改版本号**。

1. 前置:`docker`、`gh` 已登录;目标 Release 存在且为 draft;版本取自 tag。
2. `git worktree add` 到临时目录检出 `<tag>`(不在主工作区 checkout,规避 Windows 段曾踩的 detached HEAD 问题)。
3. 对 `linux/arm64`、`linux/amd64` 分别在容器内 `pnpm install --frozen-lockfile` → `NOTEMD_DIST_CHANNEL=package-manager pnpm tauri build --target <triple> --bundles deb`。
4. **产物断言(任一失败即停,不上传):**
   - ELF `e_machine` 与目标架构一致(对应 macOS 的 `lipo` 断言)。
   - `dpkg-deb -f`:`Package`、`Version == <version>`、`Architecture ∈ {amd64, arm64}` 正确。
   - `dpkg-deb -c` 含 `usr/bin/notemd`、desktop 文件、hicolor 图标、resources/themes。
   - desktop 文件 `Exec` 含 `--gui`,`MimeType` 含 `x-scheme-handler/notemd`。
   - 二进制所需 glibc 符号版本最高不超过 `GLIBC_2.36`(`objdump -T`),保证 Omarchy fast ring 的 `check-fast-ring` 通过。
   - 不链接 `libssl`(我们用 rustls;防止依赖漂移)。
   - 冒烟:在 `archlinux:latest`(amd64)容器中装好依赖、解包 deb,`ldd -r /usr/bin/notemd` 无未解析符号,`notemd --cli --version` 输出 `<version>`。
5. `gh release upload <tag>` 两个 deb + `SHA256SUMS-linux.txt`;**不碰 `latest.json`**。
6. 清理 worktree。

### 6.3 `scripts/release-publish.sh <tag>`(新建,收口)

- 校验 draft 上的资产齐全:2 dmg、2 `.app.tar.gz` + `.sig`、Windows setup + `.sig`、2 deb + `SHA256SUMS-linux.txt`、`latest.json`。
- 回读 `latest.json`:`version` 一致,含 `darwin-aarch64`、`darwin-x86_64`、`windows-x86_64`,且**不含** `linux-*`。
- 全部通过 → `gh release edit <tag> --draft=false --latest`。
- 允许 `--without windows|linux` 显式缺省某平台(紧急修复场景);缺省会写入终端输出并要求二次确认。缺 Linux 发布时,Omarchy 本次跟版会失败并在下个 tag 自愈 —— 这是可接受的降级,但必须是显式选择。

### 6.4 门禁与文档

- CHANGELOG(中/英)「未发布」区写入 Linux beta 条目,版本节最前写明「Linux 包不在应用内更新」。
- README(中/英)平台段、官网 `website/`、`website/public/llms.txt` / `llms-full.txt` 写 Linux beta 与 §3.1 的缺口(插件、热键、自动更新)。
- `README` 发版段补三段式流程:`release.sh` → `release-windows.ps1` → `release-linux.sh` → `release-publish.sh`。

---

## 7 · Omarchy 配方(PR 到 `omacom/omarchy-pkgs`)

### 7.1 `pkgbuilds/notemd/PKGBUILD`(草案,L6 以 `updpkgsums` 填真实校验和)

```bash
# Maintainer: <待定:维护者姓名与邮箱>

pkgname=notemd
pkgver=6.1015.1
pkgrel=1
pkgdesc="Markdown reader and editor for people and AI agents working on the same files"
arch=('x86_64' 'aarch64')
url="https://notemd.net"
license=('Apache-2.0')
depends=('webkit2gtk-4.1' 'gtk3' 'libayatana-appindicator' 'git' 'xdg-utils' 'hicolor-icon-theme')
makedepends=('libarchive')
options=('!debug' '!strip')

_deb_x86_64="note.md_${pkgver}_amd64.deb"
_deb_aarch64="note.md_${pkgver}_arm64.deb"
_rel="https://github.com/wizlijun/note.md/releases/download/v${pkgver}"
source_x86_64=("${_deb_x86_64}::${_rel}/${_deb_x86_64}")
source_aarch64=("${_deb_aarch64}::${_rel}/${_deb_aarch64}")
noextract=("${_deb_x86_64}" "${_deb_aarch64}")
sha256sums_x86_64=('…')
sha256sums_aarch64=('…')

package() {
  local deb_var="_deb_${CARCH}"
  mkdir -p "${srcdir}/deb"
  bsdtar -xf "${srcdir}/${!deb_var}" -C "${srcdir}/deb"
  bsdtar --no-same-owner -xf "${srcdir}"/deb/data.tar.* -C "${pkgdir}"
  install -Dm644 "${pkgdir}/usr/share/doc/note.md/copyright" \
    "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"   # 路径以 L1 实测布局为准
}
```

不替换 `/usr/bin/notemd`:它同时是 CLI 入口,且环境开关已在二进制内(§5 P1-5)。

### 7.2 `pkgbuilds/notemd/.omarchy/package.json`

```json
{
  "source": "local",
  "release_ring": "fast",
  "upstream": {
    "watch": {
      "github": "wizlijun/note.md",
      "pattern": "v(?P<version>[0-9]+(?:\\.[0-9]+)*)"
    }
  }
}
```

- 版本:我们的日期版本(`6.1015.1`)单调递增,pacman `vercmp` 排序正确,tag 形如 `v6.1015.1` 与 pattern 全匹配。
- `release_ring: fast` 的依据:Debian 12 基线构建的二进制,不随 Arch 快照重建;由其 CI `check-fast-ring` 实际验证。
- `auto_merge` 不在首个 PR 中申请,由维护者决定是否放进无人值守通道。

### 7.3 PR 流程

1. fork → `bin/add-package notemd --local --scaffold` → 写入 §7.1/§7.2。
2. `python helpers/upstream-watch.py check pkgbuilds/notemd` 输出 `already current`。
3. `bin/build --package notemd`(x86_64,本地 Docker)→ 在 Omarchy 真机 `pacman -U` 安装验证;aarch64 交给其 CI 原生构建。
4. PR 说明:是什么、怎么测的、为何申请 fast ring、§3.1 已知缺口。
5. 首个 PR 需维护者打 `build-approved` 标签。**开 PR 是对外动作,以用户本人 GitHub 账号提交,提交前由用户确认。**

---

## 8 · 验收清单(Omarchy 实机,用户执行)

按优先级:

1. **输入法**:fcitx5 中文拼音 —— 候选框位置、组合输入中回车/退格、选区内输入、长段落连续输入不丢字、撤销粒度。
2. 编辑基本盘:打字、选区、Ctrl+A/C/V/Z、表格、代码块、数学、mermaid、图片拖入。
3. 保存与外部修改检测(另开 Claude Code 改同一文件)、`.note.md` 批注与镜像。
4. vault git 同步一轮(含冲突)、大 vault 的 inotify 上限提示。
5. `.desktop` 启动、`xdg-open foo.md`、浏览器触发 `notemd://share/open`、已运行时二次启动走单实例。
6. 终端 `notemd search …`、`notemd foo.md` 拉起 GUI。
7. 托盘菜单可见可用;关窗语义。
8. Hyprland:装饰、平铺/浮动、`bind` 唤起 smart search、HiDPI 缩放(1.5/2.0)。
9. 设置页:更新区显示「由包管理器更新」、无「安装 CLI」、无字体安装、插件市场对二进制插件显示「当前平台不可用」。
10. aarch64:若有 Asahi 设备则跑 1–6;否则以 CI 构建通过 + 容器冒烟为准,并在外宣中标注「aarch64 未经实机验证」。

---

## 9 · 风险台账

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| WebKitGTK 上 ProseMirror / fcitx5 IME 行为差异(连 Chromium 系的 ChatGPT 在 Hyprland 上都有 fcitx5 问题) | 高 | 高 | §8 第 1 项最先测;问题按严重度决定是否阻断 beta |
| Debian 12 构建的二进制在滚动更新的 Arch 上运行时 ABI 问题(webkit2gtk-4.1 soname 稳定,但内部行为随版本变) | 中 | 中 | §6.2 Arch 容器冒烟 + Omarchy `check-fast-ring` 双保险 |
| Omarchy 维护者不收录 / 迟迟不批 build | 中 | 高(主渠道) | PR 写清价值与已测范围;不批时退回自维护 AUR(本期不做,但 deb 产物无需改动即可复用) |
| draft 先行流程改坏 macOS/Windows 现有发版 | 低-中 | 高 | L5 先用 `--prerelease` 小版本完整演练一次三段式 |
| Rosetta 下 amd64 Rust LTO 构建过慢 | 高 | 低 | 命名卷缓存;必要时 amd64 改到远端 x86 机,脚本只认 Docker context |
| `moraya-core` 未随 tag 固定(三平台共有的既存问题) | 中 | 中 | `release-linux.sh` 记录所用 `moraya-core` commit 到构建日志;根治另立项 |
| 无 LICENSE 文件导致再分发合规性不清 | 确定 | 中 | L1 补 `LICENSE` |
| 外宣写成「功能对齐」 | 中 | 中 | §3.2 措辞约束;§6.4 文档同步列入 L7 |

---

## 10 · 里程碑

```
L1  可编译出 deb:Dockerfile、toolchain、tauri.linux.conf.json、desktop 模板、
    LICENSE;实测记录 deb 布局与构建时长,回写 §4.3                     1–2d
L2  P0 代码改动(§5 1–4)+ 单测                                          1–2d
L3  P1 Omarchy 适配(§5 5–11)                                          2–3d
L4  Omarchy 实机验收(§8)                                              1–2d
L5  release.sh draft 化、release-linux.sh、release-publish.sh;
    用一个 prerelease 版本完整演练三段式                                 1–2d
L6  omacom/omarchy-pkgs PR(经用户确认后提交)                          0.5–1d
L7  CHANGELOG / README / 官网 / llms.txt                                0.5d
──────────────────────────────────────────────────────────────
合计约 7–12 人日(不含 Linux 插件构建)
```

依赖:L2 阻塞 L4;L5 可与 L3 并行;L6 依赖首个含 deb 的正式 Release 已 publish。

---

## 11 · 待实测核实的事实(写进对应里程碑,核实后回写本文)

- Tauri 2.11 deb 的文件名、`Package` 字段、`/usr/lib/<productName>/` 资源路径、desktop 文件名(L1)。
- `bundle.linux.deb.desktopTemplate` 与 deep-link scheme 写入 MimeType 的实际行为(L1)。
- tauri-plugin-deep-link 2.4 在 Linux 上 `register_all` 生成的 handler `.desktop` 路径与 Exec(L2)。
- Hyprland 下 `decorations(true)` 的实际呈现(L4)。
- gh 对 draft Release 的 `view/upload/download` 按 tag 定位(L5)。
- amd64 / arm64 容器构建时长(L1)。

### 2026-10-15 实现观察（不是 L4/L5/L6 验收）

- source snapshot `640778d3` 的原生 arm64 Debian 12 容器构建 exit 0；实际产物
  `note.md_6.1015.1_arm64.deb`，SHA256
  `9780e6ec8de83a57290278dea8faefe7aa19577fe71e2bbc8076480469fd4fa0`。
  `Package: note-md`；实际布局含 `/usr/bin/notemd`、
  `/usr/lib/note.md/resources/themes`、`/usr/share/applications/note.md.desktop`、
  `hicolor` 的 `notemd` 图标和 `/usr/share/doc/note.md/copyright`。
  ARM ELF64、最大 GLIBC 2.35、直接 NEEDED 无 libssl；Debian 容器 CLI 版本检查 exit 0。
  这些结论属于该冻结源码快照，不证明最终提交或未来 release tag 已构建。
- 该 arm64 包通过最终 Task5 静态 verifier（exit 0）；不代表 Arch 运行、浏览器
  deep link、Hyprland/fcitx5/托盘或 aarch64 实机 UI 通过。amd64 与最终快照结果由
  控制器补录，未观察到完成之前保持待验。
- 本轮只读 release audit：公开 `v6.1015.1` 有七个 macOS 资产，没有 Windows/Linux
  资产。Omarchy 模板尚未提交，准备 helper 必须对明确已发布稳定 tag 下载的两种
  deb 核真实 SHA256 后生成配方；没有对外发布或 PR。
- 耐久证据归档位置：`tasks/linux-omarchy-evidence/2026-10-15/`，由控制器在 SDD
  清理前归档；当前文档不能把待归档日志或源码观察当作实机/真实发布证据。
