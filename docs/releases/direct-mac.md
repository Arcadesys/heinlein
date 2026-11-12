# Heinlein Studio direct Mac release

The first paid download is planned for Apple Silicon Macs. The storefront, price, update entitlement, and first paid version are still open. Free Play already has a [Heinlein product page](https://freeplaypublishing.com/heinlein/). The [public 1.10.0 release](https://github.com/Arcadesys/heinlein/releases/tag/v1.10.0) is a separately available build.

## What a buyer gets

A Mac app for writing and organizing a book in local Markdown files. A writer can create a project, write in its first scene, save, quit and return to it. Markdown export is built in. For HTML, EPUB, DOCX or PDF export, install Python 3.11 or newer with the Heinlein publishing dependencies and Pandoc. PDF also requires Google Chrome. The app bundles the publishing code and templates.

Optional editorial tools can send manuscript material to OpenAI after the author chooses to send it. Proposed changes require the author's decision. Optional GitHub features use a separately connected GitHub account. A purchase should describe any separately required AI access.

## Build the installer

Use an Apple Silicon build Mac with Python 3.12+, Node/npm, Rust, Apple command line tools and a working `xcrun notarytool` and `stapler`. The packaging script exports the current commit into a fresh directory and installs the locked dependencies. Commit the chosen candidate first, including any new source files it requires. Allow room for a Rust release build. The output argument is a new directory inside an existing parent.

For a local rehearsal, choose a public HTTPS page. The example uses Free Play's existing product page. Its current purpose is to describe Heinlein. Change the address to the approved customer download page for the paid build.

```sh
python3 studio/macos/package_direct.py \
  --rehearsal \
  --downloads-page https://freeplaypublishing.com/heinlein/ \
  --output ../heinlein-mac-rehearsal
```

For a customer build, use the signing identity's exact **Developer ID Application** name and an existing Apple notarytool Keychain profile. The page URL goes into every copy of the app. Supply a public portal or purchase-recovery page that handles access after it opens. Keep individual receipt links and customer tokens out of the URL.

```sh
python3 studio/macos/package_direct.py \
  --identity "$HEINLEIN_SIGNING_IDENTITY" \
  --notary-profile "$HEINLEIN_NOTARY_PROFILE" \
  --downloads-page "$HEINLEIN_CUSTOMER_PAGE" \
  --output ../heinlein-mac-customer
```

The customer path signs the app with hardened runtime and a timestamp, signs the disk image, submits the image to Apple, checks acceptance, and staples the ticket. It assesses the image and the enclosed app with Gatekeeper and verifies the installer contents on a read-only mount. Completed artifacts include the DMG, SHA256SUMS and build.json with source commit, checksum and Apple submission ID. Keep that record with the sold version. The rehearsal produces a separately named ad-hoc DMG and exercises packaging and mounting. [Apple's packaging guide](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution) and [notarization guide](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

## Deliver and support the purchase

1. Choose the supported macOS floor after running the actual installer on that version. The current app declares 11.0. Runtime and WebKit behavior at that floor still need a device or VM test.
2. Set the price and currency, what updates the price includes, refund terms, and a monitored support contact. Decide which current writing features will ship in the first paid version and assign it a distinct version. The local history, illustration, and other working-copy changes need their own integration and acceptance if selected.
3. Configure the chosen storefront in test mode. Put the verified DMG behind the intended delivery flow. Give a returning buyer a stable place to retrieve their purchase. Configure that public page in the paid build. Customers reach it manually in **Updates → Open purchase and download page**. The public GitHub release and managed source installations have separate update paths.
4. Review the software's license and the four Sound Sketchbook recordings. The Python package declares MIT and includes a root LICENSE in its packaging list. That file is absent. The starter recordings have a provenance note but no recorded commercial redistribution grant. Record the applicable permissions or choose cleared assets before selling. Review the third-party notices in the built app, including any components marked for review.
5. Publish the product's privacy information with the actual seller and support contact. Cover local manuscript and recovery files, conversation history and unsent drafts stored on the Mac, optional OpenAI and GitHub transfers, local MCP client access if enabled, and the selected storefront's purchase records. The OpenAI request sets `store:false`. Align any retention statement with the actual services used. Document how buyers can remove local history and what survives sign-out.
6. Test a purchase, receipt, repeat download and support request with a test buyer. On a clean Mac, download in a browser, open the quarantined DMG, copy the app into Applications and launch normally. With VoiceOver, create a project, save and reopen a scene, export, then follow the purchase-page button. For an update, replace the closed app and reopen the same project. Test any advertised AI workflow with an eligible account. Record the candidate version, Mac model and macOS version.

## Evidence from November 12, 2026

The public ZIP and DMG matched their published SHA-256 hashes. The DMG mounted read-only and its app matched the ZIP copy. Both contain arm64 version 1.10.0 with identifier `me.thearcades.heinlein.studio`. Deep signature integrity verification passed. Gatekeeper rejected the ad-hoc public app. The build Mac reported zero usable Developer ID Application identities.

On the 1.10.0 source, 63 renderer, 28 browser, 5 export adapter and 24 native persistence/project checks passed. Tests covered keyboard project creation, save/reload, narrow reflow, and native disk restart. Actual HTML, EPUB, DOCX and PDF exports preserved the synthetic source on a configured Mac. These checks did not exercise a quarantined paid installation, spoken VoiceOver, the oldest supported macOS, a storefront transaction, or live provider access.
