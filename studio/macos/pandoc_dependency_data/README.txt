Pandoc 3.14 ARM64 dependency source companion

This companion accompanies the official Pandoc ARM64 executable used by Heinlein
Studio. The main Pandoc 3.14 source archive is supplied separately beside it.

Evidence and contents
- CircleCI ARM64 job 6162 printed the complete cabal.project.freeze retained here,
  using GHC 9.10.3 and Hackage index-state 2026-11-12T02:13:17Z.
- Every file-backed Mach-O section of that job's executable matches the official
  release executable. Manifest hashes record this comparison. Zero-fill sections
  contain no file bytes; code-signature metadata is outside these sections.
- Sources include all 264 Hackage package versions in the freeze, conservatively
  including build/test tools. This does not assert that every package is linked.
- The one non-Hackage freeze package, rts 1.0.2, is supplied by GHC 9.10.3 source
  (rts/rts.cabal). The GHC archive includes its boot libraries and bundled GMP
  6.3.0 source, patches and build controls. Complete GMP 6.3.0 source is also given.
- The Homebrew GHC formula and its seven digest-pinned patches are included.
  Its version/rebuild match the ARM64 toolchain job output. On macOS the formula
  uses system libffi and its in-tree GMP. System libraries are provided by macOS.
- Hackage archive bytes are checked against the exact security-index package.json
  target SHA256/length records. Revised .cabal files are selected at the frozen
  index-state and supplied separately. The archive itself retains its original
  .cabal; use the supplied revised file when reconstructing the frozen build.
- Index metadata was retrieved over HTTPS and pinned. No TUF signature-verification
  claim is made: individual package.json records themselves have no signatures.
- Original notice texts are reproduced in Third-party notices.txt; all source
  archive files, embedded notices and nested source archives remain intact.

Reconstruction
Extract the separately supplied main Pandoc source. Install the recorded GHC
9.10.3 toolchain and cabal-install 3.18.2.0, retaining the included source/formula/
patches if rebuilding that toolchain. Supply these local Hackage source archives
and revised .cabal files to Cabal's package repository/cache. Copy the included
freeze into the main source as cabal.project.freeze. The upstream ARM64 release
script used:
  cabal build all -fembed_data_files -fhttp -fserver -flua
The main source contains macos/make_macos_release.sh and other build controls.
The source companion preserves inputs; it is not a demonstrated reproducible
build, a replacement for upstream instructions, or a legal clearance statement.

Distribution
Deliver this complete archive beside the app download, main Pandoc source and
checksums, through the same recipient/storefront download channel. Keep source
companions available whenever supplying their corresponding binary. A source URL
alone does not replace this included source companion. Never describe this
inventory as proof of legal clearance or an exact runtime-only dependency list.

Notice limitations retained for review
The erf 2.0.0.0 Hackage source declares BSD3 in its original Cabal metadata but
contains no standalone copyright/license terms and lists no source repository.
No replacement grant has been fabricated. The complete original source and its
metadata are included; obtain the original terms/copyright attribution from the
upstream maintainer before treating this inventory as complete legal clearance.
happy-lib 2.2 also omits a standalone license file. Its same-version sibling
happy 2.2 source is included with the original Happy license and attribution;
coverage of the library has not been independently established by this inventory.
