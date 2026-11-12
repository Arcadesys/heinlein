# Heinlein Studio direct Mac release

The first paid download is planned for Apple Silicon Macs. The storefront, price, update entitlement, and first paid version are still open. Free Play already has a [Heinlein product page](https://freeplaypublishing.com/heinlein/). The [public 1.10.0 release](https://github.com/Arcadesys/heinlein/releases/tag/v1.10.0) is a separately available build.

## What a buyer gets

A Mac app for writing and organizing a book in local Markdown files. A writer can create a project, write in its first scene, save, quit and return to it. Markdown export is built in. For HTML, EPUB, DOCX or PDF export, install Python 3.11 or newer with the Heinlein publishing dependencies and Pandoc. PDF also requires Google Chrome. The app bundles the publishing code and templates.

Optional editorial tools can send manuscript material to OpenAI after the author chooses to send it. Proposed changes require the author's decision. Optional GitHub features use a separately connected GitHub account. A purchase should describe any separately required AI access.

## Installation text for a buyer's receipt

Download the Heinlein Studio disk image from your purchase page. Open it in Finder and select **Heinlein Studio**. Press Command+C, open the **Applications** shortcut in the same window, then press Command+V. Open Heinlein Studio from Applications. When updating an existing copy, save your work and quit Heinlein before copying the new app.

Open **Projects**, choose **New project…**, name it and select a folder for your writing. Studio opens **First scene**. To get another copy or look for an update later, open **Updates** and choose **Open purchase and download page**.

## Desktop privacy text for review

Your manuscript is saved as Markdown files in the project folder you choose. Heinlein also keeps working data on your Mac, including recovery copies, editorial proposals, question history and unsent question drafts. Signing out of a connected account leaves those local records on your Mac.

If you connect ChatGPT, Studio shows the question and manuscript context for your review. Using **Send to OpenAI** sends the question, the displayed context and included conversation history to OpenAI. An editorial review can also send the writing you choose for that review. You decide whether to apply a suggested change.

If you connect GitHub and share writing, copies go to the repository you select, under that repository's access settings. Account credentials use the operating system's credential store. If you grant a separate AI client access to a project through MCP, that client can use its own cloud services. In the paid build, the purchase-page button opens your browser so you can retrieve downloads from the seller.

Before publishing this text, add the seller's contact, the storefront's handling of purchase records, and verified instructions for deleting stored data.

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

On the release-preparation branch, 1,303 renderer tests and 26 browser smoke tests passed. The paid Updates dialog also passed focused desktop and narrow-window checks at 200% zoom, including keyboard activation, return focus, accessible status announcements and stable manuscript dimensions. The first local rehearsal produced a DMG that mounted read-only and matched its SHA-256 checksum. Each subsequent build records its own commit and checksum in build.json.

The generated inventory covers 37 npm and 368 Rust packages for the Apple Silicon build. Eleven objc2-family packages have an upstream licensing explanation and need further notice review. Five MPL entries include exact covered-source links for the distributor to check.

The remaining distribution tests take a real Developer ID identity and Keychain notary profile, the chosen storefront, and an independent Mac or VM. Use the signed customer artifact for those tests.
