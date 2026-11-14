# Chrome Automatic Picture-in-Picture (PiP)

A fork of [apotenza92/chrome-auto-pip](https://github.com/apotenza92/chrome-auto-pip) that defaults to Chrome's native automatic PiP and keeps the manual toolbar button.

## Install

1. Download an extension ZIP from [this fork's releases](https://github.com/josencamara/chrome-auto-pip/releases). Source archives and development branches may contain different changes; v2.0.2 predates native mode.
2. Extract it to a permanent folder.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the folder containing `manifest.json`.
4. Disable other copies of this extension, then reload your video tabs.

For this development branch, download its source ZIP or clone the branch and load the repository folder directly. After updating the files, click **Reload** on the extension card and reload open video tabs. A page reload is needed to remove page handlers left behind by older versions or by assistance mode.

Requires Chrome 134 or later. Enable **Automatic picture-in-picture** in Chrome's site settings where available. Some Chromium versions also require the `auto-picture-in-picture-for-video-playback` flag in `chrome://flags` and a browser restart.

## Native automatic PiP (default)

**Use Chrome's automatic PiP** is on by default, including when upgrading a profile that has not chosen a mode. Chrome and the website control when automatic PiP opens and closes. The extension does not install a Media Session handler, change the site's playback state or video attributes, request PiP on tab leave, or close PiP on return in this mode.

Use this mode for YouTube and other sites whose built-in automatic PiP already works. It preserves their behavior; it does not add automatic PiP to sites that lack support or bypass Chrome's eligibility checks.

## Manual toolbar button

Click the extension icon to open PiP for the current video's playing or paused frame, including supported embedded and open shadow-DOM players. Click again to close PiP opened by the toolbar. The button remains available in native mode and on sites excluded from extension assistance.

## Optional assistance

Right-click the toolbar icon and open **Options**. Turn off **Use Chrome's automatic PiP** to reveal **Assist automatic PiP on other sites** and the disabled-site list.

Assistance is intended for sites without their own automatic PiP handler. It registers one Media Session handler per page and adds an `autopictureinpicture` attribute to playing videos. Chrome decides whether to invoke that handler. There are no tab-leave fallback requests or rearming timers. Return cleanup only closes automatic PiP marked by this helper; native mode has no return cleanup.

Assistance can replace an existing site handler when first enabled. Use native mode on sites with built-in support. Switching back disarms extension registration without closing PiP; reload the page to restore any site handler replaced during assistance.

The disabled-site list applies only to extension assistance. It cannot disable Chrome's or a site's native PiP. Defaults exclude Google Meet, Zoom, Teams, Slack, Discord, and WhatsApp Web. Use `*.` to include subdomains.

## Debugging and tests

**Debug Logs** in Options is opt-in and local. Enable it, reproduce a problem, and click **Download .txt**. In native mode the extension does not instrument the site's automatic PiP, so its log cannot explain every Chrome eligibility decision.

```bash
npm ci
npm run test:local
```

The test suite covers native-mode preservation, settings, optional assistance, and manual PiP. Tests that display PiP windows require a graphical desktop (or Xvfb on Linux). For a machine without a display, use `AUTO_PIP_TEST_HEADLESS=1 npm run test:local`. Headless Chromium checks registration, options, DOM preservation, and manual PiP API behavior; it does not verify Chrome's native OS PiP window or eligibility decisions.

```bash
npm run test:local:static
npm run test:local:cpu
AUTO_PIP_REAL_SITES=1 npm run test:local:sites
```

Real-site checks default to checking native-mode non-interference and record whether PiP was observed. Set `AUTO_PIP_SITE_MODE=assisted` to exercise optional assistance instead. These checks are supplemental; artifacts are written to `tmp/local-test-artifacts/`.

[Changelog](CHANGELOG.md) · [Original Chrome Web Store listing](https://chromewebstore.google.com/detail/automatic-picture-in-pict/dmjccoaplbldlhhljlcldhaciadfhkcj) · [Support the original author](https://buymeacoffee.com/apotenza)
