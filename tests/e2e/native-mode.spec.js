const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function run(file, sandbox) {
  sandbox.globalThis = sandbox;
  return vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), sandbox);
}

function background(nativeAutoPip = true) {
  const calls = [];
  const record = name => (...args) => { calls.push(name); args.find(a => typeof a === 'function')?.([]); };
  const sandbox = {
    AutoPip: {
      constants: { VIDEO_PLAYING_MESSAGE_THROTTLE_MS: 2000 },
      state: { nativeAutoPip, autoPipOnTabSwitch: true, currentTab: 1, targetTab: 1,
        pipActiveTab: 1, lastVideoPlayingTargetedAtByTab: {} },
      debug: { debugLog() {}, clearNativeAutoPipBlocker() {} },
      urlRules: { isValidTab: () => true, isAutoPipAllowedTab: () => true, isRestrictedUrl: () => false },
      inject: {
        ...Object.fromEntries(['injectCheckVideoScript', 'injectExitPiPScript',
          'injectRequestPlayingPiPScript', 'injectDisableAndExitAutoPiPScript',
          'injectImmediatePiPScript', 'registerTabForAutoPip'].map(name => [name, record(name)])),
        getFrameResultValues: r => r, getFirstObjectResult: r => r[0],
        hasAnyFrameTrue: () => false, hasExitedPiP: () => false
      }
    },
    chrome: { runtime: {}, tabs: {
      get: (id, callback) => callback({ id, active: true, url: 'https://example.com' }),
      query: (query, callback) => callback([{ id: 1, active: true, url: 'https://example.com' }])
    } }, setTimeout: () => 1
  };
  run('background/tab-switch.js', sandbox);
  return { calls, api: sandbox.AutoPip.tabSwitch };
}

test('native mode never registers, opens, or closes PiP on automatic events', () => {
  const { calls, api } = background();
  api.handleTabActivated({ tabId: 2 });
  api.handleTabUpdated(2, { status: 'complete' }, { id: 2, active: true, url: 'https://example.com' });
  api.handleVideoPlayingMessage({ id: 2 });
  api.primeActiveTabForAutoPip();
  api.registerAllowedTabs();
  api.applyBlocklistToOpenTabs();
  expect(calls).toEqual([]);
});

test('native mode still runs the manual toolbar action', () => {
  const { calls, api } = background();
  api.handleToolbarClick({ id: 1, url: 'https://example.com' });
  expect(calls).toEqual(['injectImmediatePiPScript']);
});

test('assisted mode does not make a background tab-leave PiP request', () => {
  const { calls, api } = background(false);
  api.handleTabActivated({ tabId: 2 });
  expect(calls).not.toContain('injectRequestPlayingPiPScript');
});

test('native content bridge leaves site state and Media Session alone', async () => {
  const messages = [];
  const sandbox = {
    window: {
      AutoPipContent: { settings: { getSettings: async () => ({ nativeAutoPip: true }),
        hostname: () => 'youtube.com', isHostBlocked: () => false } },
      postMessage: (...args) => messages.push(args), addEventListener() {}
    }, navigator: {}, location: { href: 'https://youtube.com' }
  };
  const result = await run('scripts/trigger-auto-pip.js', sandbox);
  expect(result.reason).toBe('native_mode');
  expect(messages).toEqual([]);
  expect(sandbox.window.__auto_pip_registered__).toBeUndefined();
});

function settingsFixture(sync = {}, local = {}, offline = false) {
  const calls = [];
  const area = data => ({
    get: async () => ({ ...data }),
    set: async next => Object.assign(data, next),
    remove: async keys => keys.forEach(key => delete data[key])
  });
  const sandbox = {
    AutoPip: { debug: { debugLog() {} },
      urlRules: { normalizeBlocklist: value => Array.isArray(value) ? value.slice() : null },
      tabSwitch: Object.fromEntries(['applyBlocklistToOpenTabs', 'registerAllowedTabs',
        'primeActiveTabForAutoPip', 'cleanupAutoPipOnAllTabs', 'disarmAutoPipOnAllTabs',
        'setTargetTab'].map(name => [name, () => calls.push(name)])) },
    chrome: { storage: { sync: area(sync), local: area(local) } }
  };
  if (offline) sandbox.chrome.storage.sync.get = async () => { throw new Error('offline'); };
  run('background/constants.js', sandbox);
  run('background/settings.js', sandbox);
  return { sandbox, calls, sync, local };
}

test('fresh and upgraded profiles default to native mode without losing old preferences', async () => {
  for (const initial of [{}, { autoPipOnTabSwitch: true }, { autoPipOnTabSwitch: false }]) {
    const f = settingsFixture({ ...initial });
    await f.sandbox.AutoPip.settings.loadSettings();
    expect(f.sandbox.AutoPip.state.nativeAutoPip).toBe(true);
    expect(f.local.nativeAutoPip).toBe(true);
    expect(f.sandbox.AutoPip.state.autoPipOnTabSwitch).toBe(initial.autoPipOnTabSwitch !== false);
  }
});

test('explicit assistance mode survives reload and offline settings reads', async () => {
  const f = settingsFixture({ nativeAutoPip: false });
  await f.sandbox.AutoPip.settings.loadSettings();
  expect(f.sandbox.AutoPip.state.nativeAutoPip).toBe(false);
  const offline = settingsFixture({}, f.local, true);
  await offline.sandbox.AutoPip.settings.loadSettings();
  expect(offline.sandbox.AutoPip.state.nativeAutoPip).toBe(false);
});

test('switching to native mode disarms assistance without exiting PiP', () => {
  const f = settingsFixture();
  f.sandbox.AutoPip.state.nativeAutoPip = false;
  f.sandbox.AutoPip.settings.handleStorageChanged({ nativeAutoPip: { newValue: true } }, 'local');
  expect(f.calls).toEqual(['disarmAutoPipOnAllTabs', 'setTargetTab']);
  f.sandbox.AutoPip.settings.applyAutoPipOnTabSwitchSetting(false);
  expect(f.calls).not.toContain('cleanupAutoPipOnAllTabs');
});

test('native mode is enforced at the page injection boundary', () => {
  const sandbox = { AutoPip: {
    constants: { INJECTION_POLICIES: {} }, debug: { debugLog() {} },
    urlRules: {}, state: { nativeAutoPip: true, autoPipOnTabSwitch: true }
  } };
  run('background/inject.js', sandbox);
  const results = [];
  for (const name of ['registerTabForAutoPip', 'injectPageAutoPiPScript', 'injectTriggerAutoPiP']) {
    sandbox.AutoPip.inject[name](1, value => results.push(value));
  }
  expect(results).toEqual([null, null, null]);
});

test('disarming automation preserves the manual PiP ownership marker', async () => {
  const attrs = new Map([['__pip__', 'true'], ['data-auto-pip-managed', ''],
    ['data-auto-pip-added-autopictureinpicture', ''], ['autopictureinpicture', '']]);
  const video = {
    hasAttribute: name => attrs.has(name), removeAttribute: name => attrs.delete(name),
    setAttribute: (name, value) => attrs.set(name, value)
  };
  let exits = 0;
  const document = {
    pictureInPictureElement: video,
    querySelectorAll: selector => selector === '*' ? [] : [video],
    exitPictureInPicture: async () => { exits += 1; }
  };
  const sandbox = { window: {}, document };
  run('scripts/lib/pip.js', sandbox);
  const pip = sandbox.window.AutoPipContent.pip;
  pip.cleanupOwnedAutoPiP(document, { preserveManual: true });
  expect(exits).toBe(0);
  expect(attrs.has('autopictureinpicture')).toBe(false);
  expect(attrs.has('__pip__')).toBe(true);
  expect((await pip.exitOwned()).exited).toBe(true);
  expect(exits).toBe(1);
});
