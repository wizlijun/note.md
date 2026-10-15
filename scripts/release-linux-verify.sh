#!/usr/bin/env bash
set -euo pipefail

die() { echo "Linux package verification: $*" >&2; exit 1; }
MODE=all
case "${1:-}" in --inspect) MODE=inspect; shift ;; --arch-runtime) MODE=arch-runtime; shift ;; esac
[[ $# -eq 3 ]] || die 'usage: release-linux-verify.sh [--inspect] <deb> <version> <amd64|arm64>'
DEB=$1 VERSION=$2 ARCH=$3
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'invalid version'
case "$ARCH" in
  amd64) MACHINE='Advanced Micro Devices X86-64'; INTERPRETER=/lib64/ld-linux-x86-64.so.2 ;;
  arm64) MACHINE=AArch64; INTERPRETER=/lib/ld-linux-aarch64.so.1 ;;
  *) die 'invalid Debian architecture' ;;
esac
[[ -f "$DEB" && "$(basename "$DEB")" == "note.md_${VERSION}_${ARCH}.deb" ]] || die 'deb filename/version/architecture mismatch'

if [[ "$MODE" == all ]]; then
  command -v docker >/dev/null || die 'docker is required'
  DIR=$(cd "$(dirname "$DEB")" && pwd)
  SCRIPT=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  docker run --rm --platform "linux/$ARCH" \
    --mount "type=bind,src=$DIR,dst=/packages,readonly" \
    --mount "type=bind,src=$SCRIPT,dst=/verify.sh,readonly" \
    -e NOTEMD_VERIFY_CONTAINER=1 --entrypoint bash debian:12 \
    /verify.sh --inspect "/packages/$(basename "$DEB")" "$VERSION" "$ARCH"
  if [[ "$ARCH" == amd64 ]]; then
    docker run --rm --platform linux/amd64 \
      --mount "type=bind,src=$DIR,dst=/packages,readonly" \
      --mount "type=bind,src=$SCRIPT,dst=/verify.sh,readonly" \
      --entrypoint bash archlinux:latest \
      /verify.sh --arch-runtime "/packages/$(basename "$DEB")" "$VERSION" "$ARCH"
  fi
  exit 0
fi

if [[ "$MODE" == arch-runtime ]]; then
  [[ "$ARCH" == amd64 ]] || die 'Arch runtime smoke requires amd64'
  pacman -Syu --noconfirm --needed dpkg binutils webkit2gtk-4.1 gtk3 \
    libayatana-appindicator xdotool git xdg-utils
elif [[ "${NOTEMD_VERIFY_CONTAINER:-}" == 1 ]]; then
  apt-get update
  apt-get install -y --no-install-recommends binutils dpkg
fi
for tool in dpkg-deb readelf; do command -v "$tool" >/dev/null || die "$tool is required"; done
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
[[ "$(dpkg-deb -f "$DEB" Package)" == note-md ]] || die 'wrong package name (expected note-md)'
[[ "$(dpkg-deb -f "$DEB" Version)" == "$VERSION" ]] || die 'wrong package version'
[[ "$(dpkg-deb -f "$DEB" Architecture)" == "$ARCH" ]] || die 'wrong package architecture'
dpkg-deb -x "$DEB" "$ROOT"
BIN="$ROOT/usr/bin/notemd"
[[ -x "$BIN" && ! -L "$BIN" ]] || die 'missing executable /usr/bin/notemd'
HEADER=$(readelf -h "$BIN")
grep -Eq 'Class:[[:space:]]+ELF64' <<< "$HEADER" || die 'expected ELF64'
grep -Eq 'Type:[[:space:]]+(DYN|EXEC)' <<< "$HEADER" || die 'expected executable ELF'
[[ "$(sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p' <<< "$HEADER")" == "$MACHINE" ]] || die 'wrong ELF e_machine'
PROGRAM=$(readelf -l "$BIN")
grep -Fq "[Requesting program interpreter: $INTERPRETER]" <<< "$PROGRAM" || die 'unexpected ELF interpreter'
DYNAMIC=$(readelf -d "$BIN")
grep -Eq '\(NEEDED\).*\[libc\.so\.6\]' <<< "$DYNAMIC" || die 'missing dynamic libc dependency'
if grep -Eq '\(NEEDED\).*\[libssl[^]]*\]' <<< "$DYNAMIC"; then die 'direct libssl dependency is forbidden'; fi
VERSIONS=$(readelf --version-info "$BIN")
MAX_GLIBC=$(grep -oE 'GLIBC_[0-9]+(\.[0-9]+)*' <<< "$VERSIONS" | sed 's/GLIBC_//' | sort -Vu | tail -1)
[[ -n "$MAX_GLIBC" ]] || die 'no GLIBC version evidence'
[[ "$(printf '%s\n' "$MAX_GLIBC" 2.36 | sort -V | tail -1)" == 2.36 ]] || die "GLIBC $MAX_GLIBC exceeds 2.36"
DESKTOP="$ROOT/usr/share/applications/note.md.desktop"
[[ -f "$DESKTOP" ]] || die 'missing desktop entry'
grep -Eq '^Exec=(/usr/bin/)?notemd --gui %U$' "$DESKTOP" || die 'desktop Exec must force GUI'
grep -Fxq 'Icon=notemd' "$DESKTOP" || die 'desktop icon mismatch'
grep -Eq '^MimeType=.*x-scheme-handler/notemd;' "$DESKTOP" || die 'missing desktop deep-link scheme'
[[ -n "$(find "$ROOT/usr/share/icons/hicolor" -type f -path '*/apps/notemd.png' -print -quit 2>/dev/null)" ]] || die 'missing hicolor icons'
[[ -n "$(find "$ROOT/usr/lib/note.md/resources/themes" -type f -name '*.css' -print -quit 2>/dev/null)" ]] || die 'missing bundled themes'
LICENSE="$ROOT/usr/share/doc/note.md/copyright"
[[ -s "$LICENSE" ]] || die 'missing license'
grep -Fq 'Version 2.0, January 2004' "$LICENSE" || die 'missing Apache-2.0 license text'
grep -Fq 'END OF TERMS AND CONDITIONS' "$LICENSE" || die 'incomplete Apache-2.0 license text'
echo "Verified $ARCH package/ELF/layout; maximum GLIBC=$MAX_GLIBC (runtime compatibility still requires symbol/dependency checks)"
if [[ "$MODE" == arch-runtime ]]; then
  RELOCATIONS=$(ldd -r "$BIN" 2>&1) || die "ldd -r failed: $RELOCATIONS"
  printf '%s\n' "$RELOCATIONS"
  if grep -Eiq 'not found|undefined symbol|symbol lookup error' <<< "$RELOCATIONS"; then die 'unresolved runtime dependencies/symbols'; fi
  CLI=$(env -u DISPLAY -u WAYLAND_DISPLAY "$BIN" --cli --version)
  CLI_VERSION=$(sed -n 's/^notemd \([^ ]*\) (plugin API [^)]*)$/\1/p' <<< "$CLI")
  [[ "$CLI_VERSION" == "$VERSION" ]] || die "CLI version mismatch: $CLI"
  echo "Verified Arch amd64 CLI: $CLI"
fi
