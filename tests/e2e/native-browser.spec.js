const { test, expect } = require('../fixtures/extension-fixture');
const { startStaticServer } = require('../fixtures/static-server');

// These assertions check site preservation, not the OS PiP window.
test.use({ nativeAutoPip: true, browserHeadless: true });

test('native mode preserves site registration across playback, tab switches, and settings changes', async ({ context, page }) => {
  const { server, baseURL } = await startStaticServer();
  let other;
  try {
    await page.addInitScript(() => {
      const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      window.__testHandlerChanges = 0;
      navigator.mediaSession.setActionHandler = (name, handler) => {
        if (name === 'enterpictureinpicture') window.__testHandlerChanges += 1;
        return original(name, handler);
      };
      navigator.mediaSession.setActionHandler('enterpictureinpicture', () => {});
      navigator.mediaSession.playbackState = 'paused';
    });
    await page.goto(`${baseURL}/site-owned-auto-pip.html`);
    const flags = () => page.evaluate(() => ({
      handlerChanges: window.__testHandlerChanges,
      playbackState: navigator.mediaSession.playbackState,
      pageAgent: !!window.__auto_pip_page_state__,
      siteAttribute: document.querySelector('video').hasAttribute('autopictureinpicture'),
      owned: document.querySelector('video').hasAttribute('data-auto-pip-managed')
    }));
    await expect.poll(flags).toEqual({ handlerChanges: 1, playbackState: 'paused',
      pageAgent: false, siteAttribute: true, owned: false });
    other = await context.newPage();
    await other.goto(`${baseURL}/blank.html`);
    await other.bringToFront();
    await page.bringToFront();
    const worker = context.__autoPipExtensionWorker;
    await worker.evaluate(async () => {
      await chrome.storage.sync.set({ autoPipOnTabSwitch: false, autoPipSiteBlocklist: ['127.0.0.1'] });
    });
    await expect.poll(flags).toEqual({ handlerChanges: 1, playbackState: 'paused',
      pageAgent: false, siteAttribute: true, owned: false });
  } finally {
    if (other) await other.close();
    server.close();
  }
});

test('native mode is the default shown in options', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('#nativeAutoPip')).toBeChecked();
  await expect(page.locator('#assistedAutoPipSetting')).toBeHidden();
  await expect(page.locator('#blockedSitesSetting')).toBeHidden();
  await expect(page.locator('#nativeAutoPip')).toBeEnabled();
  await page.locator('#nativeAutoPip').evaluate(el => {
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#assistedAutoPipSetting')).toBeVisible();
  await page.reload();
  await expect(page.locator('#nativeAutoPip')).not.toBeChecked();
});
