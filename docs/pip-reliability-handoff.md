# Chrome Auto PiP reliability investigation and handoff

Snapshot: 14 November 2026. Prepared for the next agent with access to the user's real Chrome browser. The user reports that v2.0.2 was unreliable and v2.1.0 is worse. Neither release has been demonstrated to meet the user's actual requirement: automatic PiP on every intended departure from a playing video, with predictable return behavior and little setup.

The underlying failure in the user's browser remains unidentified. The previous agent inspected source, changed behavior, ran fixtures, and published packages without reproducing the reported failure in that browser. In particular, v2.1.0 defaults to leaving automatic opening entirely to Chrome and the site. Its tests establish non-interference under specific conditions; they do not establish that Chrome will open PiP reliably for this user.

## User observations and requirements

The user wants PiP to open every time they expect it, quickly and reliably. The initial supplied change concerned closing the floating video on return to its tab. After installing the first release, the user reported intermittent operation and asked whether a timeout or missing trigger was involved. They said Chrome's default behavior, with YouTube as an example, was substantially faster and more reliable. They reported that the subsequent native-mode release was even worse.

These are user observations, not browser traces. The exact failing URLs, Chrome version/channel, operating system, installed extension IDs, profile state, site permissions, flags, and repeated reproduction steps were not collected. The phrase “default Chrome thing” was never resolved to a particular automatic-PiP setting, toolbar/media-control action, YouTube control, or other UI. Do not assume those are equivalent.

The user now requests documentation and a handoff. This handoff makes no additional runtime changes and does not claim a fix.

## Repository and release state

- Upstream: https://github.com/apotenza92/chrome-auto-pip
- User fork: https://github.com/josencamara/chrome-auto-pip
- The fork was initially inaccessible because the user was signed into another GitHub account while forking. Access was subsequently confirmed and pushes succeeded.
- Original author attribution and license were retained. The native-branch README links to the original author as “Support the original author.” The original Web Store listing is not a distribution channel for these fork releases.

| Reference | Exact commit | Meaning |
| --- | --- | --- |
| Inspected upstream base | `28361e9e512ed3de3f3eb67aeedda69a440f9ff3` | Upstream manifest version 2.0.1 |
| `fix/auto-pip-return` | `9129c3119b18038b757b9cf437e3579df8250fad` | Initial return cleanup patch and five regression tests |
| Fork `main` and tag `v2.0.2` | `934ec61d2a380dabf5473d481bac100e8df2c5bf` | Merge of pull request 1; first published fork release |
| Native behavior implementation | `84ebd83a765c00946bb68d710c8d68a3fa64be9d` | Native default, optional assistance, fallback removal, new tests |
| Tag `v2.1.0` | `9ad694c4145e78a7808c02ee580b999f41e3ec5e` | Native implementation plus version and release documentation |

At this snapshot, `main` still points to v2.0.2. The v2.1.0 release was built from `feat/native-auto-pip`, not merged into `main`. This handoff is added to that feature branch after the immutable release tag. Cloning the default branch therefore does not reproduce the latest release.

- Initial PR, merged at the user's request: https://github.com/josencamara/chrome-auto-pip/pull/1
- v2.0.2 release: https://github.com/josencamara/chrome-auto-pip/releases/tag/v2.0.2
- v2.1.0 release: https://github.com/josencamara/chrome-auto-pip/releases/tag/v2.1.0
- Native implementation comparison: https://github.com/josencamara/chrome-auto-pip/compare/v2.0.2...v2.1.0

Both releases provide an unpacked-extension ZIP. They are not signed Chrome Web Store installations or automatic updates. ZIP integrity, manifest version, and packaged source contents were checked after downloading the published assets. Those checks do not establish what the user actually loaded in Chrome.

## Supplied attachment

The uploaded `auto-pip-return-fix-builder.zip` contained a README and `build_release.py`, not a complete extension. Its patch builder expected upstream 2.0.1 and generated a modified extension with manifest version 2.0.2. Its default output filename misleadingly still included 2.0.1; the published fork asset used the correct 2.0.2 filename.

The user explicitly confirmed that the attachment's described changes were the desired changes. Its contents were treated as proposed patch material, reviewed, and then applied locally. The attachment also explicitly said live Chrome site tests had not been performed.

## What the original code did

In the inspected upstream and v2.0.2 design:

1. A content bridge reads extension settings and disabled-site rules.
2. The background injects a main-world page agent, principally into the top frame.
3. The page agent discovers videos, adds managed `autopictureinpicture` attributes to playing videos, sets Media Session playback state, and registers an `enterpictureinpicture` handler.
4. Chrome may invoke that handler. The handler selects a playing video and calls `video.requestPictureInPicture()`.
5. A page-side compatibility path also attempts PiP on `visibilitychange` to hidden, but only if `navigator.userActivation.isActive` is true.
6. The background has an additional tab-leave compatibility request through `request-playing-pip.js`. This path attempts a request without the same preliminary activation check, but browser restrictions still apply.
7. Returning to an active tab injects cleanup for extension-managed PiP. The page agent also has rearming and registration logic.

The previous explanation to the user emphasized the activation-gated page fallback, but that was incomplete: there was also the background fallback. Expired activation was a plausible explanation, not a demonstrated root cause.

### Timing in the source

| Timer or gate | Upstream and v2.0.2 | v2.1.0 |
| --- | --- | --- |
| Native-miss check | 900 ms diagnostic watch; reports a missing trigger, not an opening retry | Still exists inside optional assistance; not active in default native mode |
| Rearming delay | 100 ms after disarming attributes on certain return/leave paths | Removed |
| Registration refresh debounce | 100 ms after relevant page events/mutations | Retained in optional assistance |
| Post-load video check | 500 ms in background tab-update flow | Retained for assistance; native mode returns before this flow |
| Playing-message throttle | 2000 ms per tab | Retained for assistance; native mode ignores automatic targeting |
| User activation | Page fallback checks `isActive`; browser controls expiration | Page and background tab-leave fallbacks removed |

There is no source evidence for a single general timeout that explains the user's report. The prior agent did not measure Chrome's activation duration or record a failed request in the user's profile.

## First change and release v2.0.2

The initial fix targeted return cleanup, not unreliable opening.

Changes:

- After a successful automatic page-agent PiP request, mark the selected video with `data-auto-pip-compat-requested`.
- Add `closeAutoPiPOnReturn()`, which exits PiP only when the current PiP video has that marker and the document is visible.
- Call it on return to visibility, and after an asynchronous PiP request resolves if the page has already returned. This addresses the leave-and-return race in the proposed patch.
- Change background exit injection from top-frame-only to all frames.
- Bump the manifest to 2.0.2; update README/changelog; add deterministic tests.

Files principally changed: `scripts/page-auto-pip.js`, `background/inject.js`, `manifest.json`, and `tests/e2e/auto-pip-return.spec.js`.

Scope of the manual-PiP guarantee: the new visibility handler checks the automatic marker. This does not establish that all pre-existing cleanup paths preserve all manually opened or site-owned PiP. `pip.exitOwned()` uses a broader ownership test, discussed below.

Observed outcome: the user reported intermittent behavior after this release. No real-browser failure trace was obtained before the next redesign.

## Approaches considered

| Approach | Reason considered | Evidence and disposition |
| --- | --- | --- |
| Add retries or adjust timeouts | User described intermittent opening | No retries added as a fix. A retry cannot itself establish browser eligibility or user activation; no measured failure justified a timer change. |
| Attribute failures to expiring activation | Page fallback checks active user activation | Source-backed possibility, not a confirmed diagnosis. Background fallback and Chrome-native triggering also had to be considered. |
| Fix automatic registration for iframe players | Automatic arming and checks target the top frame | Identified as a gap. Only exit cleanup was broadened; automatic registration was not generalized across frames. |
| Preserve site handlers and let Chrome own supported behavior | User reported native Chrome/YouTube worked better | Chosen for v2.1.0 without verifying the exact native UI or reproducing the user experience. |
| Detect an existing site PiP handler before installing ours | Would allow selective assistance | Media Session exposes no standard getter for the existing action handler. The implementation did not solve general detection. |
| Default to complete native pass-through, with assistance available | Avoid replacing site handlers by default | Implemented. It also removes the extension's default automatic-opening functionality and relies on support that was not verified in the user's browser. |
| Real desktop comparison before redesign | Would distinguish native behavior from extension behavior | Not performed by the previous agent. This is the central missing investigation. |

No browser security bypass, new permission, remote code, analytics, or tracking was added.

## Second change and release v2.1.0

### Default native mode

A new `nativeAutoPip` setting defaults to true, including existing profiles that have not explicitly chosen a mode. Old assistance settings are retained but do not override this default.

With native mode on:

- Background tab events do not arm the page agent, issue automatic requests, or run return cleanup.
- Injection entry points guard against loading automatic scripts.
- The content bridge returns early without installing its page-message listener or modifying Media Session/video registration.
- The toolbar manual-PiP action remains available.
- The extension does not enable Chrome's automatic-PiP feature or grant a site's automatic-PiP permission. It relies on Chrome and the site already providing the desired behavior.

**This is a change of product behavior, not evidence of improved automatic opening. If native PiP does not activate for a site/profile, the extension deliberately does nothing to make it activate in this mode.** That can explain a loss of extension functionality by design; it has not been proven to explain the user's particular regression.

### Optional assistance

Turning off “Use Chrome's automatic PiP” reveals the retained assistance toggle and disabled-site list. Both `nativeAutoPip=false` and `autoPipOnTabSwitch=true` are needed for assistance. An old disabled assistance preference can therefore remain off after the user turns native mode off.

Changes to assistance:

- Remove the page-side compatibility request on hidden visibility.
- Delete `scripts/request-playing-pip.js` and remove the background compatibility caller/injector.
- Remove the 100 ms attribute-disarming/rearming loop.
- Register the Media Session action handler once per page state instead of on every registration refresh. The first registration can still replace a site's handler; a later site replacement is no longer continually overwritten.
- Retain automatic-origin return cleanup inside assistance.
- Preserve manual toolbar ownership markers during disarming; avoid closing PiP simply because the user switches back to native mode.
- Snapshot the previous Media Session playback state and restore it on disable only if its current value still matches the helper's last written value.
- If a pending PiP request resolves after assistance is disabled, do not add a new automatic-origin marker or close PiP from that continuation.

Switching modes does not recover an already-overwritten site handler. The code has no saved reference to an unknown original handler. Reloading the page is necessary to restore its original setup. Updating the extension also does not reliably remove old main-world handlers from existing pages; a page reload was included in installation instructions but not verified in the user's actual browser.

### Supporting changes

- Options adds native-mode control and hides assistance/blocklist controls in native mode.
- Settings, content-side settings, debug state, and background injection guards recognize native mode.
- README explains native defaults, optional assistance, upgrades, and reloads.
- Real-site smoke defaults to checking native non-interference and records whether PiP was observed. `AUTO_PIP_SITE_MODE=assisted` selects the older assistance checks. A successful native preservation check does not mean PiP opened.
- Test launch supports full headless Chromium for fixture checks. Manifest version is 2.1.0; permissions are unchanged.

Observed outcome: the user reports that this release is worse. It should not be presented as a verified reliability improvement.

## Verification performed and its limits

### v2.0.2

Five deterministic tests and repository static checks passed. The tests simulated page visibility, PiP promises, manual-PiP preservation in the new handler, failed exits, and frame injection policy. They did not display real PiP windows.

The full default browser suite was attempted. Eight existing tests could not launch because the environment had no X server/display. This was an environment failure, not a successful browser test or a reproduced product failure.

### v2.1.0

Commands used for the release candidate:

```bash
npm ci
AUTO_PIP_TEST_HEADLESS=1 npm run test:local
```

Result: **29 tests passed**, including static checks before Playwright. Headless Chromium 145.0.7632.6 was downloaded by Playwright in this environment. This is not necessarily the user's Chrome build.

Test coverage included native-mode guards and settings, fixture preservation of site handlers/state, options persistence, manual PiP API behavior, dynamic/shadow video registration, blocklists, and simulated return races.

Important limits:

- Many tests in `auto-pip-return.spec.js` and `native-mode.spec.js` run the actual scripts in Node VM sandboxes with mocked browser APIs.
- The extension fixture explicitly opts existing assistance tests into `nativeAutoPip=false`. Those tests do not exercise the new default behavior.
- `native-browser.spec.js` uses headless Chromium. Its preservation fixture deliberately sets Media Session playback state to `paused`; it does not prove an eligible playing YouTube session triggers automatic PiP.
- Earlier tests that expected compatibility-triggered PiP on tab leave were changed with the behavior redesign. Current tab-switch/dynamic tests no longer require Chrome-native automatic PiP to open. The 29-pass result validates the revised contract, not the user's original “opens every time” goal.
- Manual PiP API assertions passed without visual confirmation of a desktop PiP window.
- No computer-use session tested the user's browser, no real YouTube comparison was recorded, and no timing/success-rate matrix was run.
- The real-site smoke and CPU benchmark commands exist, but were not executed as release validation here.
- The release workflow packages and publishes; it does not independently run the 29-test suite.

The published v2.1.0 ZIP was downloaded, integrity checked, compared byte-for-byte against packaged release source, checked for manifest version 2.1.0, and checked to exclude test/local-runner files and the deleted fallback script.

Release workflow evidence:

- v2.0.2: https://github.com/josencamara/chrome-auto-pip/actions/runs/43545137991
- v2.1.0: https://github.com/josencamara/chrome-auto-pip/actions/runs/43547798522

## Source locations for the next investigation

Paths below refer to v2.1.0 unless stated otherwise.

| File | Relevant behavior |
| --- | --- |
| `manifest.json` | Content scripts, Chrome minimum 134, permissions, version |
| `main.js` | Service-worker initialization and module imports |
| `background/settings.js` | Native default, local/sync preference resolution, mode transitions |
| `scripts/lib/settings.js` | Content-world settings reads; native default on missing settings |
| `background/tab-switch.js` | Early returns in native mode; assisted targeting/cleanup; manual toolbar handling |
| `background/inject.js` | Main/isolated worlds and top-frame/all-frame policy; automatic-injection guards |
| `scripts/trigger-auto-pip.js` | Native early return, assistance settings and page debug bridge |
| `scripts/page-auto-pip.js` | Optional Media Session handler, video registration, diagnostic timer, return cleanup |
| `scripts/immediate-pip.js` | Manual selection and toggle behavior |
| `scripts/lib/pip.js` | Ownership markers, PiP request and exit, cleanup |
| `scripts/exit-pip.js` | Background cleanup calls `pip.exitOwned()` |
| `scripts/disable-auto-pip.js` | Disarming and page disable message |
| `background/debug.js`, `background/messages.js` | Local logs, badges, state updates, runtime messages |
| `options.html`, `options.js` | Native versus assistance controls and debug downloads |
| `tests/e2e/`, `tests/fixtures/` | Existing fixtures and regression assertions |

## Unresolved risks worth checking

These are source-derived candidates, not diagnosed causes in the user's browser.

1. **Default mode does not supply automatic PiP.** Confirm the installed mode before analyzing missing extension requests as a bug. They are intentionally absent in native mode.
2. **Installed copy and page lifecycle.** Multiple unpacked copies can have the same display name and different IDs. A release folder update, extension reload, or disabling one copy may leave main-world listeners in an already-open page. Check IDs, paths, versions, and fully reload/navigate video tabs for each comparison.
3. **Native versus extension eligibility.** A successful manual PiP click does not prove that native automatic PiP is allowed. Identify the exact Chrome UI that the user considers reliable and reproduce it with every copy of the extension disabled.
4. **Iframe asymmetry.** Automatic page registration and `check-video.js` injection remain top-frame-only. Manual request and exit injection can target all frames. Closing an embedded PiP does not prove its automatic arming works.
5. **Ownership is broader than automatic origin.** `pip.isExtensionManaged()` accepts any of `__pip__`, `data-auto-pip-managed`, `data-auto-pip-added-autopictureinpicture`, or `data-auto-pip-compat-requested`. A video may be marked managed merely because it was registered for automatic PiP. Existing background cleanup may therefore classify manually/site-opened PiP as extension-owned in assistance mode.
6. **Failed requests can leave ownership markers.** `pip.request()` marks ownership before awaiting the browser request; its rejection path restores an overridden disable attribute but does not remove all ownership markers. Verify whether this influences later manual/site PiP cleanup.
7. **Several frame requests may compete.** Manual injection runs in all frames. With multiple candidate videos, more than one frame can attempt PiP. Check selection and whether one request replaces another.
8. **Stale background state.** `currentTab`, `targetTab`, and `pipActiveTab` are global in-memory service-worker state. Exercise multiple windows, worker suspension, tab closure, and manual closing of PiP. A stored active-PiP tab can affect the next toolbar click.
9. **Assistance still writes site state.** First handler registration and repeated playback-state updates can interfere with a site. “Once per page” is not preservation of an unknown existing handler. Mode switching cannot fully undo that replacement without reloading the page.
10. **Short timers are not established causes.** The 900 ms log can indicate a missed native event without explaining why. Do not treat a diagnostic badge or absent marker as proof of a browser permission failure.
11. **Settings transitions and races.** Compare actual sync storage, local storage, and service-worker state; inspect automatic requests already in flight during a mode switch. Changes were tested in fixtures, not during the user's real playback session.

## Suggested browser investigation

Start with observation and a controlled comparison before another redesign.

1. Record Chrome's full version/channel, OS, the exact video URL, current extension IDs/versions/paths, native-mode and assistance settings, Chrome site permission, and relevant flags. Use the affected profile first; a clean profile is a separate control.
2. Ask the user to demonstrate the reliable “default Chrome” action once. Record whether it is automatic on tab departure, a manual global-media-control action, a site button, or another feature. Distinguish video `requestPictureInPicture()` from Document Picture-in-Picture if relevant.
3. Disable every copy of this extension, fully reload the video page, and repeat the same departure/return sequence. Record the actual native baseline rather than assuming it exists because a permission or flag is enabled.
4. Repeat with exactly one copy of upstream 2.0.1, then fork v2.0.2, then v2.1.0 native mode, then v2.1.0 assistance. Keep the video, profile, permissions, playback state, and switching method comparable. Fully reload the page between conditions.
5. For each condition, perform at least 10 leave/return cycles for immediate departure after Play, departure after about 10 seconds, and departure after about 60 seconds. Also try a quick return while an opening request may be pending. Record opens/attempts, opening latency, closing behavior, and whether playback continues.
6. After reproducing a baseline difference, vary muted versus audible playback, pause/buffer/end state, tab switch versus app/window switch, multiple video tabs, iframe players, and site navigation without a full reload. Prioritize the user's actual failure before expanding the matrix.
7. Enable extension debug logs when testing extension behavior, export them around a failure, and inspect request exceptions and event order. Capture the real PiP window and page focus/visibility with computer use. Avoid altering eligibility by injecting artificial clicks into the baseline.

A useful results table is:

| Version and mode | URL and frame | Playback and audio | Time since page interaction | Departure method | Opens out of attempts | Opening latency | Closes on return | Error or event trace |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fill from observation | | | | | | | | |

## Diagnostics and acceptance evidence

For assistance, useful events include `page_registration_updated`, `page_enterpictureinpicture_start`, `page_enterpictureinpicture_success`, `page_enterpictureinpicture_failed`, `page_visibility_changed`, `page_pip_state_changed`, `page_auto_pip_closed_on_return`, and `page_native_auto_pip_not_fired`. v2.0.2 additionally has `page_compat_auto_pip_*` and background `compat_request_*` events; those fallback events were removed in v2.1.0.

Native mode intentionally does not instrument the site's automatic PiP handler. A quiet extension log in that mode is expected and cannot diagnose all Chrome-native failures.

Read-only snapshots from the extension service-worker DevTools console can help distinguish mode/settings issues:

```js
await chrome.storage.sync.get(['nativeAutoPip', 'autoPipOnTabSwitch', 'autoPipSiteBlocklist']);
await chrome.storage.local.get(['nativeAutoPip', 'autoPipOnTabSwitch', 'autoPipSiteBlocklist', 'autoPipLatestBlocker']);
({ nativeAutoPip: AutoPip.state.nativeAutoPip,
   autoPipOnTabSwitch: AutoPip.state.autoPipOnTabSwitch,
   currentTab: AutoPip.state.currentTab,
   targetTab: AutoPip.state.targetTab,
   pipActiveTab: AutoPip.state.pipActiveTab });
```

For a visible page/frame, inspect `document.visibilityState`, `document.pictureInPictureEnabled`, `document.pictureInPictureElement`, `navigator.mediaSession.playbackState`, `navigator.userActivation`, video readiness/playback, and ownership attributes. Opening DevTools or interacting with the page changes timing and possibly activation, so keep a separate uninstrumented baseline. Do not invoke PiP manually and count that as an automatic success.

The next change should be supported by a reproducible failure, a specific cause or clearly bounded hypothesis, a regression check for it, and a visible before/after comparison on the user's actual site. Acceptance should include repeated automatic entry and return behavior, manual PiP preservation, and clear scope for tab/window/app switching. A headless pass, unchanged DOM state, or a correctly packaged ZIP alone does not meet that acceptance standard.
