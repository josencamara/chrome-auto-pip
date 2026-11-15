const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the real page agent with deterministic PiP and visibility events.
function fixture({ delayed = false, rejectExit = false } = {}) {
  const attributes = new Map();
  const listeners = {};
  const videoListeners = {};
  let complete;
  let action;
  let exits = 0;
  let refresh;
  let registrations = 0;
  let requests = 0;
  class Video {
    constructor() {
      Object.assign(this, { paused: false, ended: false, readyState: 4,
        isConnected: true, muted: true, volume: 1, currentTime: 1 });
    }
    hasAttribute(name) { return attributes.has(name); }
    setAttribute(name, value) { attributes.set(name, value); }
    removeAttribute(name) { attributes.delete(name); }
    addEventListener(name, handler) { videoListeners[name] = handler; }
    async requestPictureInPicture() {
      requests++;
      if (delayed) await new Promise(resolve => { complete = resolve; });
      document.pictureInPictureElement = this;
    }
  }
  const video = new Video();
  const document = {
    visibilityState: 'hidden', pictureInPictureElement: null,
    querySelectorAll: selector => selector === 'video' ? [video] : [],
    addEventListener: (name, handler) => { listeners[name] = handler; },
    async exitPictureInPicture() {
      exits += 1;
      if (rejectExit) throw new Error('exit rejected');
      document.pictureInPictureElement = null;
      videoListeners.leavepictureinpicture?.();
    }
  };
  const window = { postMessage() {}, addEventListener() {} };
  window.top = window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../scripts/page-auto-pip.js'), 'utf8'), {
    window, document, navigator: { mediaSession: {
      setActionHandler: (name, handler) => { action = handler; registrations += 1; }
    }, userActivation: { isActive: false } },
    HTMLVideoElement: Video, location: { href: 'https://example.com/video' }, URL,
    MutationObserver: class { observe() {} },
    setTimeout: callback => { refresh = callback; return 1; }, clearTimeout() {},
    Set
  });
  return {
    video, document, action, get exits() { return exits; }, get requests() { return requests; },
    get registrations() { return registrations; },
    hidden() { document.visibilityState = 'hidden'; listeners.visibilitychange(); },
    complete: () => complete(),
    pause() {
      video.paused = true;
      listeners.pause({ target: video });
      refresh();
    },
    async visible() {
      document.visibilityState = 'visible';
      listeners.visibilitychange();
      await Promise.resolve();
    }
  };
}

test('hiding the video preserves the already armed media handler', async () => {
  const f = fixture();
  await f.visible();
  const registeredBeforeSwitch = f.registrations;
  f.hidden();
  expect(f.registrations).toBe(registeredBeforeSwitch);
});

test('automatically opened PiP closes when the video tab returns', async () => {
  const f = fixture();
  await f.action();
  expect(f.document.pictureInPictureElement).toBe(f.video);
  await f.visible();
  expect(f.exits).toBe(1);
  expect(f.document.pictureInPictureElement).toBe(null);
});

test('a native departure arriving before visibility changes keeps PiP open', async () => {
  const f = fixture();
  await f.visible();
  await f.action({ enterPictureInPictureReason: 'contentoccluded' });
  expect(f.document.pictureInPictureElement).toBe(f.video);
  f.hidden();
  expect(f.exits).toBe(0);
  await f.visible();
  expect(f.document.pictureInPictureElement).toBeNull();
});

test('overlapping native and compatibility actions request PiP once', async () => {
  const f = fixture({ delayed: true });
  const entering = f.action();
  await f.action({ enterPictureInPictureReason: 'contentoccluded' });
  expect(f.requests).toBe(1);
  f.complete();
  await entering;
  expect(f.document.pictureInPictureElement).toBe(f.video);
});

test('automatic PiP remains identifiable after playback pauses in the background', async () => {
  const f = fixture();
  await f.action();
  f.pause();
  await f.visible();
  expect(f.exits).toBe(1);
  expect(f.document.pictureInPictureElement).toBe(null);
});

test('pausing a toolbar PiP keeps its ownership while the window is open', () => {
  const f = fixture();
  f.document.pictureInPictureElement = f.video;
  f.video.setAttribute('data-auto-pip-managed', '');
  f.pause();
  expect(f.video.hasAttribute('data-auto-pip-managed')).toBe(true);
});

test('a return while the automatic PiP request is pending closes on completion', async () => {
  const f = fixture({ delayed: true });
  const pending = f.action();
  await f.visible();
  f.complete();
  await pending;
  expect(f.exits).toBe(1);
  expect(f.document.pictureInPictureElement).toBe(null);
});

test('the visibility handler preserves manually opened PiP', async () => {
  const f = fixture();
  f.document.pictureInPictureElement = f.video;
  await f.visible();
  expect(f.exits).toBe(0);
  expect(f.document.pictureInPictureElement).toBe(f.video);
});

test('a user request from browser media controls stays open on the visible tab', async () => {
  const f = fixture();
  await f.visible();
  await f.action({ enterPictureInPictureReason: 'useraction' });
  expect(f.exits).toBe(0);
  expect(f.document.pictureInPictureElement).toBe(f.video);
  expect(f.video.hasAttribute('data-auto-pip-compat-requested')).toBe(false);
});

test('return cleanup failure is handled and can be retried', async () => {
  const f = fixture({ rejectExit: true });
  await f.action();
  await f.visible();
  expect(f.exits).toBe(1);
  expect(f.video.hasAttribute('data-auto-pip-compat-requested')).toBe(true);
  await f.visible();
  expect(f.exits).toBe(2);
});


test('return cleanup injects into all frames in the page world', () => {
  const injections = [];
  const sandbox = {
    AutoPip: {
      constants: { INJECTION_POLICIES: { allFrames: 'allFrames', topFrameOnly: 'topFrameOnly' } },
      debug: { debugLog() {} },
      urlRules: { isRestrictedUrl: () => false }, state: {}
    },
    chrome: {
      runtime: {}, tabs: { get: (id, callback) => callback({ id, url: 'https://example.com' }) },
      scripting: { executeScript: (options, callback) => {
        injections.push(options);
        callback([{ frameId: 2, result: { exited: true } }]);
      } }
    }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../background/inject.js'), 'utf8'), sandbox);
  sandbox.AutoPip.inject.injectExitPiPScript(42, () => {});
  expect(injections[0].target).toEqual({ tabId: 42, allFrames: true });
  expect(injections[0].world).toBe('MAIN');
  expect(injections[0].files).toContain('./scripts/exit-pip.js');
});

test('a stale tab lookup cannot take over after a second activation', () => {
  const queries = new Map();
  const registered = [];
  const state = { currentTab: null, targetTab: null, autoPipOnTabSwitch: true };
  const sandbox = {
    AutoPip: {
      state, constants: {}, debug: { debugLog() {} },
      urlRules: { isAutoPipAllowedTab: () => true },
      inject: {
        registerTabForAutoPip: (id, callback) => registered.push(id),
        injectExitPiPScript() {},
        injectExitTabPiPScript() {}
      }
    },
    chrome: { runtime: {}, tabs: { get: (id, callback) => queries.set(id, callback) } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../background/tab-switch.js'), 'utf8'), sandbox);
  sandbox.AutoPip.tabSwitch.handleTabActivated({ tabId: 1 });
  sandbox.AutoPip.tabSwitch.handleTabActivated({ tabId: 2 });
  queries.get(2)({ id: 2 });
  const registrationsAfterLatestReply = [...registered];
  queries.get(1)({ id: 1 });
  expect(state.currentTab).toBe(2);
  expect(registered).toEqual(registrationsAfterLatestReply);
});

test('a pending departure skips its compatibility request after returning', () => {
  const registrations = [];
  const requests = [];
  const state = { currentTab: 1, targetTab: 1, autoPipOnTabSwitch: true };
  const sandbox = {
    AutoPip: {
      state, constants: {}, debug: { debugLog() {} }, urlRules: {},
      inject: {
        registerTabForAutoPip: (id, callback) => registrations.push({ id, callback }),
        injectRequestPlayingPiPScript: id => requests.push(id)
      }
    },
    chrome: { tabs: { get() {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../background/tab-switch.js'), 'utf8'), sandbox);
  sandbox.AutoPip.tabSwitch.handleTabActivated({ tabId: 1, windowId: 10 });
  sandbox.AutoPip.tabSwitch.handleTabActivated({ tabId: 3, windowId: 11 });
  expect(registrations).toEqual([]);
  sandbox.AutoPip.tabSwitch.handleTabActivated({ tabId: 2, windowId: 10 });
  expect(registrations[0].id).toBe(1);
  sandbox.AutoPip.tabSwitch.handleTabActivated({ tabId: 1, windowId: 10 });
  registrations[0].callback();
  expect(requests).toEqual([]);
});

test('playback arms the active source in another window without replacing the current target', () => {
  const registrations = [];
  const state = {
    currentTab: 1, targetTab: 1, autoPipOnTabSwitch: true, lastVideoPlayingTargetedAtByTab: {}
  };
  const sandbox = {
    AutoPip: {
      state, constants: { VIDEO_PLAYING_MESSAGE_THROTTLE_MS: 1000 }, debug: { debugLog() {} },
      urlRules: { isAutoPipAllowedTab: () => true },
      inject: { registerTabForAutoPip: id => registrations.push(id) }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../background/tab-switch.js'), 'utf8'), sandbox);
  const onPlaying = sandbox.AutoPip.tabSwitch.handleVideoPlayingMessage;
  onPlaying({ id: 2, windowId: 10, active: true });
  onPlaying({ id: 2, windowId: 10, active: true });
  onPlaying({ id: 3, windowId: 10, active: false });
  expect(registrations).toEqual([2]);
  expect(state.targetTab).toBe(1);
});

test('compatibility PiP uses browser tab selection when page visibility is stale', async () => {
  const video = {};
  const document = { visibilityState: 'visible', pictureInPictureElement: null };
  let requests = 0;
  let inactive = false;
  let returnOnRequest = false;
  let loseReplyOnRequest = false;
  let lostReply = false;
  const sandbox = {
    document,
    chrome: { runtime: { async sendMessage() {
      if (lostReply) throw Error('Worker unavailable');
      return { inactive };
    } } },
    window: { AutoPipContent: {
      video: {
        result: (ok, status, reason) => ({ ok, status, reason }),
        findVideos: () => [video],
        isPlaying: () => true
      },
      pip: {
        async request() {
          requests++;
          if (returnOnRequest) inactive = false;
          if (loseReplyOnRequest) lostReply = true;
          document.pictureInPictureElement = video;
        },
        async exitOwned() { document.pictureInPictureElement = null; }
      }
    } }
  };
  video.requestPictureInPicture = () => {};
  const script = fs.readFileSync(path.join(__dirname, '../../scripts/request-playing-pip.js'), 'utf8');
  expect(await vm.runInNewContext(script, sandbox)).toMatchObject({ reason: 'tab_active_or_unavailable' });
  expect(requests).toBe(0);

  inactive = true;
  expect(await vm.runInNewContext(script, sandbox)).toMatchObject({ status: 'success' });
  expect(document.pictureInPictureElement).toBe(video);
  document.pictureInPictureElement = null;

  returnOnRequest = true;
  expect(await vm.runInNewContext(script, sandbox)).toMatchObject({ reason: 'tab_returned' });
  expect(requests).toBe(2);
  expect(document.pictureInPictureElement).toBe(null);

  returnOnRequest = false;
  inactive = true;
  loseReplyOnRequest = true;
  expect(await vm.runInNewContext(script, sandbox)).toMatchObject({ status: 'success' });
  expect(document.pictureInPictureElement).toBe(video);
});

test('a tab return closes only automatic PiP and ignores stale selection', async () => {
  const marker = 'data-auto-pip-compat-requested';
  let automatic = false;
  let active = true;
  let closes = 0;
  const video = { hasAttribute: name => automatic && name === marker };
  const sandbox = {
    document: { pictureInPictureElement: video },
    chrome: { runtime: { async sendMessage() { return { active }; } } },
    window: { AutoPipContent: {
      markers: { compatRequested: marker },
      pip: { async exitOwned() { closes++; return { exited: true }; } }
    } }
  };
  const run = () => vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../../scripts/exit-tab-pip.js'), 'utf8'), sandbox
  );
  expect(await run()).toMatchObject({ exited: false });
  automatic = true;
  active = false;
  expect(await run()).toMatchObject({ exited: false });
  active = true;
  expect(await run()).toMatchObject({ exited: true });
  expect(closes).toBe(1);
});

test('disabling PiP invalidates a pending read of older settings', async () => {
  let finishSettingsRead;
  const window = {
    AutoPipContent: { settings: {
      getSettings: () => new Promise(resolve => { finishSettingsRead = resolve; }),
      hostname: () => 'video.example',
      isHostBlocked: () => false
    } },
    addEventListener() {},
    postMessage() {}
  };
  const context = vm.createContext({ window, navigator: { mediaSession: {} }, document: { addEventListener() {} } });
  const bridge = fs.readFileSync(path.join(__dirname, '../../scripts/trigger-auto-pip.js'), 'utf8');
  const disable = fs.readFileSync(path.join(__dirname, '../../scripts/disable-auto-pip.js'), 'utf8');
  const pendingRegistration = vm.runInContext(bridge, context);
  vm.runInContext(disable, context);

  finishSettingsRead({ autoPipOnTabSwitch: true, autoPipSiteBlocklist: [] });
  expect(await pendingRegistration).toMatchObject({ reason: 'settings_superseded' });
  expect(window.__auto_pip_disabled__).toBe(true);
  expect(window.__auto_pip_registered__).toBe(false);
});

test('the bridge notifies the background when autoplay started before registration', async () => {
  const outbound = [];
  const window = {
    AutoPipContent: {
      settings: {
        async getSettings() { return { autoPipOnTabSwitch: true, autoPipSiteBlocklist: [] }; },
        hostname: () => 'video.example',
        isHostBlocked: () => false
      },
      video: { findVideos: () => [{}], isPlaying: () => true }
    },
    addEventListener() {}
  };
  const bridge = fs.readFileSync(path.join(__dirname, '../../scripts/trigger-auto-pip.js'), 'utf8');
  const context = vm.createContext({
    window,
    navigator: { mediaSession: {} },
    document: { hidden: false, addEventListener() {} },
    chrome: { runtime: { sendMessage: message => outbound.push(message) } }
  });
  expect(await vm.runInContext(bridge, context)).toMatchObject({ ok: true });
  expect(outbound.filter(message => message.type === 'auto_pip_video_playing')).toHaveLength(1);
});
