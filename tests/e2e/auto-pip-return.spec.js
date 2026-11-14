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
  let requests = 0;
  let registrations = 0;
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
      requests += 1;
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
  const mediaSession = { playbackState: 'paused',
    setActionHandler: (name, handler) => { registrations += 1; action = handler; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../scripts/page-auto-pip.js'), 'utf8'), {
    window, document, navigator: { mediaSession, userActivation: { isActive: true } },
    HTMLVideoElement: Video, location: { href: 'https://example.com/video' }, URL,
    MutationObserver: class { observe() {} }, setTimeout: () => 1, clearTimeout() {},
    Set
  });
  return {
    video, document, action, mediaSession,
    disable: () => window.__auto_pip_page_disable__(),
    get exits() { return exits; },
    complete: () => complete(),
    get requests() { return requests; },
    get registrations() { return registrations; },
    async hidden() {
      document.visibilityState = 'hidden';
      listeners.visibilitychange();
      await Promise.resolve();
    },
    async visible() {
      document.visibilityState = 'visible';
      listeners.visibilitychange();
      await Promise.resolve();
    }
  };
}

test('automatically opened PiP closes when the video tab returns', async () => {
  const f = fixture();
  await f.action();
  expect(f.document.pictureInPictureElement).toBe(f.video);
  await f.visible();
  expect(f.exits).toBe(1);
  expect(f.document.pictureInPictureElement).toBe(null);
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


test('assisted mode never requests PiP on visibility changes, even with active user activation', async () => {
  const f = fixture();
  await f.visible();
  await f.hidden();
  await f.visible();
  await f.hidden();
  expect(f.requests).toBe(0);
  expect(f.registrations).toBe(1);
});

test('return cleanup keeps registration armed without removing and readding video attributes', async () => {
  const f = fixture();
  await f.action();
  await f.visible();
  expect(f.video.hasAttribute('autopictureinpicture')).toBe(true);
  expect(f.video.hasAttribute('data-auto-pip-managed')).toBe(true);
  expect(f.registrations).toBe(1);
});


test('disabling assistance restores its previous playback state', () => {
  const f = fixture();
  expect(f.mediaSession.playbackState).toBe('playing');
  f.disable();
  expect(f.mediaSession.playbackState).toBe('paused');
});

test('disabling assistance preserves a newer site playback state', () => {
  const f = fixture();
  f.mediaSession.playbackState = 'none';
  f.disable();
  expect(f.mediaSession.playbackState).toBe('none');
});

test('a pending callback finishing after assistance is disabled does not close PiP', async () => {
  const f = fixture({ delayed: true });
  const pending = f.action();
  f.disable();
  await f.visible();
  f.complete();
  await pending;
  expect(f.exits).toBe(0);
  expect(f.video.hasAttribute('data-auto-pip-compat-requested')).toBe(false);
});
