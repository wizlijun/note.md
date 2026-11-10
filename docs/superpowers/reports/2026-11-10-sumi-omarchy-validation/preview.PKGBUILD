# Local Sumi development preview; never an upstream release artifact.
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
_deb_x86_64="note.md_6.1110.1_amd64.deb"
source_x86_64=("note.md_6.1110.1_amd64.deb")
noextract=("note.md_6.1110.1_amd64.deb")
sha256sums_x86_64=('848e977d88c1bbf1835b24b69cfd98d64ce639e43bdc5562675cf90ac3d64cbf')

package() {
  local deb_var="_deb_${CARCH}"
  mkdir -p "${srcdir}/deb"
  bsdtar -xf "${srcdir}/${!deb_var}" -C "${srcdir}/deb"
  bsdtar --no-same-owner -xf "${srcdir}"/deb/data.tar.* -C "${pkgdir}"
  install -Dm644 "${pkgdir}/usr/share/doc/note.md/copyright" \
    "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"
}
