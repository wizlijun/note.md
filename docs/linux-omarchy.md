# Linux / Omarchy beta

Linux beta targets x86_64 and aarch64 with Debian 12 (bookworm) `.deb` builds
and WebKitGTK. Download the latest published package for your architecture:
[amd64](https://notemd.net/download?os=linux&arch=x86_64) ·
[arm64](https://notemd.net/download?os=linux&arch=aarch64) ·
[GitHub releases and checksums](https://github.com/wizlijun/note.md/releases).
Each platform's download entry keeps its most recent available package when a
newer release omits that platform. Linux packages update through the package
manager. **aarch64 has not been verified on a native desktop machine.**
A successful container build is not desktop acceptance.

Linux beta 使用 Debian 12 基线的 x86_64 / aarch64 `.deb`，下载入口分别保留
对应架构最后一个实际已发布的包，不随缺少 Linux 包的新版本失效。
**aarch64 未经桌面实机验证。** Omarchy 下游仓库尚未收录；没有 AppImage、rpm、
Flatpak 或 apt 仓库。

## Install a published Linux package

Choose an explicitly published release containing both
`note.md_<version>_amd64.deb`, `note.md_<version>_arm64.deb` and
`SHA256SUMS-linux.txt`. Download the checksum file and both debs from the same
GitHub release and run `sha256sum -c SHA256SUMS-linux.txt` before installation.
On Debian 12, install the matching local package:

```bash
# Replace <version> with a release that actually contains Linux packages.
sudo apt install ./note.md_<version>_amd64.deb
# ARM64 instead:
sudo apt install ./note.md_<version>_arm64.deb
```

Omarchy uses an Arch package generated from these debs; do not use `dpkg` to
install a deb on Arch. Release [6.1022.1](https://github.com/wizlijun/note.md/releases/tag/v6.1022.1)
includes a verified x86_64 Arch package. Download
[`notemd-6.1022.1-1-x86_64.pkg.tar.zst`](https://github.com/wizlijun/note.md/releases/download/v6.1022.1/notemd-6.1022.1-1-x86_64.pkg.tar.zst)
and [`SHA256SUMS-omarchy.txt`](https://github.com/wizlijun/note.md/releases/download/v6.1022.1/SHA256SUMS-omarchy.txt)
into the same directory, then verify and install:

```bash
sha256sum -c SHA256SUMS-omarchy.txt
sudo pacman -U ./notemd-6.1022.1-1-x86_64.pkg.tar.zst
```

The package was built with the generated recipe and verified through an actual
Arch container installation, file integrity checks and CLI execution. Omarchy's
Hyprland/fcitx5/tray/HiDPI desktop acceptance is still pending; there is no
prebuilt aarch64 Arch package. `pacman -S notemd` is only applicable after
downstream repository inclusion; this work has not submitted that entry.

Omarchy x86_64 可下载同一发行页的 Arch 包和校验文件，校验后用上面的
`pacman -U` 命令安装。已验证 Arch 容器实际安装及 CLI，尚未完成 Omarchy
桌面实机验收，也未收录到下游仓库；目前不能用 `pacman -S notemd` 安装。

Linux bundles are built with `NOTEMD_DIST_CHANNEL=package-manager`. Settings
show “Updated by your package manager”; the app does not check, download or
install its own updates. Use apt to install a newer downloaded deb or the
Omarchy package manager once included. Linux is deliberately absent from
`latest.json`; existing macOS and Windows updater behavior is preserved.

Linux 包由包管理器更新，应用内不检查、下载或安装更新。Debian 用 apt 安装
后续 deb；Omarchy 收录后使用包管理器。不能把尚未收录的 `pacman -S notemd`
当作现在可用的安装命令。

## CLI, desktop and links

The package installs the same binary as `/usr/bin/notemd`; no “Install CLI” step
is needed. CLI subcommands stay in the terminal without initializing GTK:

```bash
notemd --version
notemd search 'meeting'
notemd ~/notes/example.md
notemd --gui
```

The shipped `/usr/share/applications/note.md.desktop` runs
`notemd --gui %U`, uses the `notemd` icon and advertises Markdown/plain text/JSON
and `x-scheme-handler/notemd`. Select note.md through your desktop's preferred
application settings if desired; Linux has no app-internal “Set as default”
button. Verify `xdg-open foo.md`, a browser opening `notemd://share/open` with a
valid share link, and delivery to an already running instance on the real
machine. An empty share route alone is not a valid share payload.

## Hyprland and display configuration

Wayland global shortcuts are owned by the compositor. Add, for example, to
your Hyprland configuration:

```ini
bind = SUPER CTRL, M, exec, notemd --gui --action smart-search
# Replace the plugin id and window id with an installed, compatible plugin:
bind = SUPER CTRL, N, exec, notemd --gui --action plugin:com.example:capture
```

Actions reach the existing instance through single-instance dispatch. Settings
also provide copyable bindings. Under Hyprland, window decorations default off;
the saved title-bar preference can override this. Verify tiled/floating windows
and fractional HiDPI on the actual compositor.

Before GTK initialization, GUI startup reads
`$XDG_CONFIG_HOME/net.notemd.app/linux-env.conf`, or
`~/.config/net.notemd.app/linux-env.conf` when `XDG_CONFIG_HOME` is unset/empty.
The only accepted keys are:

- `WEBKIT_DISABLE_DMABUF_RENDERER`
- `WEBKIT_DISABLE_COMPOSITING_MODE`
- `GDK_BACKEND`
- `GDK_SCALE`
- `GDK_DPI_SCALE`

Use literal `KEY=VALUE`, blank lines and full-line `#` comments. Do not use
`export`, quoting, shell variables, command substitution or inline comments.
Malformed input rejects the configuration file, with a line-number diagnostic.
The file is not a shell script. Changes take effect after fully quitting and
relaunching the GUI, not through terminal CLI commands.

For an NVIDIA/WebKit white window, opt in to a workaround only when necessary:

```ini
# ~/.config/net.notemd.app/linux-env.conf
WEBKIT_DISABLE_DMABUF_RENDERER=1
# If needed, test this separately:
# WEBKIT_DISABLE_COMPOSITING_MODE=1
```

No GPU workaround is enabled by default. `GDK_BACKEND=x11` is an optional
XWayland fallback; scale overrides should be chosen for the local display.
NVIDIA 白屏开关必须自行按需启用；不默认开启，也不执行配置中的 shell 表达式。

Closing the last window keeps note.md running in the tray. Omarchy may fold
tray icons: expand the tray to reopen the app, or run `notemd --gui`. Choose
Quit from the tray to exit fully. Linux does not rely on tooltip/title support;
status is shown in the tray menu. Real Omarchy tray behavior remains to be
verified. 关闭窗口仍驻留托盘，托盘图标可能折叠；真正退出请用托盘 Quit。

For a large vault, inspect `sysctl fs.inotify.max_user_watches` and
`sysctl fs.inotify.max_user_instances` if watching reports exhaustion. Raise
limits through the distribution's documented sysctl configuration when needed;
this package does not silently change system-wide limits.

## Beta limitations

Native-binary plugins require a matching Linux host triple
(`x86_64-unknown-linux-gnu` or `aarch64-unknown-linux-gnu`); unsupported packages
show “Unavailable on this platform”. Pure UI plugins remain available when
packaged for Linux. App-internal agent panels are excluded from Linux beta;
use external agents with the same files/CLI. Theme font installation, location
and app-internal default-app selection are unavailable on Linux. fcitx5 input,
Hyprland decorations, tray behavior, browser deep links and HiDPI still require
real-machine acceptance. aarch64 has not been verified on a native desktop.

已知限制：缺少对应 Linux triple 的原生二进制插件不可安装；为 Linux 打包的纯
UI 插件仍可用。Linux beta 不包含应用内 Agent 面板，可使用外部 Agent 与 CLI。
主题字体安装、定位和应用内默认应用设置不可用。fcitx5、Hyprland、托盘、浏览器
深链接与 HiDPI 待实机验收；aarch64 未经实机验证。

## Prepare the unsubmitted Omarchy recipe

The checked-in `packaging/omarchy/notemd/PKGBUILD` deliberately refuses to load
until generated. There is no invented hash, checksum bypass or maintainer
identity. With `gh` authenticated for read access and Python 3 installed:

```bash
python3 packaging/omarchy/prepare.py <published-version-without-v> \
  --output /tmp/notemd-omarchy-ready
bash -n /tmp/notemd-omarchy-ready/PKGBUILD
python3 -m json.tool /tmp/notemd-omarchy-ready/.omarchy/package.json
```

The helper rejects draft/prerelease tags, wrong versions, missing architecture
assets, incomplete/duplicate checksum entries, mismatched actual bytes and
non-ar downloads before writing a recipe. It downloads both debs and
`SHA256SUMS-linux.txt` from that exact GitHub release and generates deterministic
`pkgver` and architecture checksums. This verifies integrity against the
release manifest, not an independent signature or full package runtime.

The recipe uses `bsdtar` from `libarchive` to unpack `data.tar.*`, preserves
`/usr/bin/notemd` and installs the shipped Apache-2.0 copyright into Arch's
license directory. In the downstream fork, scaffold with
`bin/add-package notemd --local --scaffold`, copy the generated recipe and
watcher into `pkgbuilds/notemd/`, then run:

```bash
python helpers/upstream-watch.py check pkgbuilds/notemd
bin/build --package notemd
```

The watcher ignores draft and prerelease tags. Both architectures must exist
for an update. `release_ring: fast` requests CI validation of the Debian 12
binary baseline; it does not claim CI approval. Do not request `auto_merge` in
the first PR. Validate x86_64 via downstream build and real Omarchy installation;
aarch64 also needs downstream native CI. The first PR needs the maintainer's
`build-approved` label. Opening that PR is an external action requiring the
user's final confirmation; no PR has been opened here.

## Maintainer build and publication order

All three platform builds attach to the same draft/tag; publication is a
separate final gate:

```bash
scripts/release.sh
# Windows: scripts/release-windows.ps1 <tag>
scripts/release-linux.sh <tag>
scripts/release-publish.sh <tag>
```

Run the Windows command on Windows before Linux/final publication. Linux uses
Debian 12 containers for both architectures, verifies package layout/ELF/CLI
and Arch compatibility, then uploads both debs plus their checksums. Keep the
sibling `moraya-core` source available read-only as required by the build.
The publish script validates the exact draft and complete platform asset set,
then publishes immediately; the normal command has no confirmation prompt.
Only `--without windows|linux` permits a missing platform and requires typing
the exact tag/omitted-platform confirmation in an interactive terminal. Never
fabricate an asset or add a Linux updater entry. A real three-platform prerelease
rehearsal (L5) remains pending; these local scripts/tests are not that rehearsal.

## Omarchy real-machine acceptance (spec §8, exact checklist)

All items below remain pending unless a separately recorded real-machine
result closes them. 按优先级:

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
