from pathlib import Path
import hashlib, shutil
repo=Path(__file__).resolve().parents[3]
dest=Path(__file__).resolve().parent
deb=repo/'src-tauri/target/debug/bundle/deb/note.md_6.1110.1_amd64.deb'
shutil.copy2(deb,dest/deb.name)
sha=hashlib.sha256(deb.read_bytes()).hexdigest()
recipe=(repo/'packaging/omarchy/notemd/PKGBUILD').read_text()
package=recipe[recipe.index('package() {'):]
(dest/'PKGBUILD').write_text(f'''# Local Sumi development preview; never an upstream release artifact.
pkgname=notemd-sumi-preview
pkgver=6.1110.1.dev20261110
pkgrel=1
pkgdesc="note.md with the Sumi Omarchy native integration (local development preview)"
arch=('x86_64')
url="https://notemd.net"
license=('Apache-2.0')
depends=('webkit2gtk-4.1' 'gtk3' 'libsecret' 'libpulse' 'fontconfig' 'libayatana-appindicator' 'git' 'xdg-utils' 'hicolor-icon-theme')
makedepends=('libarchive')
provides=('notemd=6.1110.1')
conflicts=('notemd')
options=('!debug' 'strip')
_deb_x86_64="{deb.name}"
source_x86_64=("{deb.name}")
noextract=("{deb.name}")
sha256sums_x86_64=('{sha}')

'''+package)
