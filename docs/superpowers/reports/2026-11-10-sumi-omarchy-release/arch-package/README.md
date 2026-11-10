# Arch x86_64 package verification

Generated with the existing `prepare.py 6.1110.2 --amd64-only` against the published stable release, then `makepkg --cleanbuild --noconfirm` as the unprivileged user. No installation or upload was performed by this verifier.

All 9 Debian payload files preserve their exact bytes and modes. The only extra files are the complete license copy and `.PKGINFO`, `.BUILDINFO`, `.MTREE`. ELF architecture/interpreter, maximum GLIBC 2.35, resolved `ldd -r`, and exact CLI version passed. The binary remains identical to the final Debian artifact used for host GUI acceptance.

`verification.json` and `SHA256SUMS-omarchy.txt` are exact copies of the frozen delivery assets. `delivery.json` also records hashes of all four assets, including the checksum manifest itself. Their prepublication state is intentional; subsequent upload and anonymous readback belong to separate release records.

`verify-and-stage.py` preserves the exact script executed for this acceptance, including artifact staging in the task directory. It is an execution record, not a read-only public-download verifier. `recipe/` preserves the generated recipe, `.SRCINFO`, and Omarchy metadata included in the recipe archive.
