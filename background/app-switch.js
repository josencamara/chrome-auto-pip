(function initAppSwitch(root) {
  'use strict';

  const commandName = 'open-pip-after-app-switch';
  const activeTabs = new Map();
  let lastWindow;
  let owner;
  let focusGeneration = 0;
  let requestCount = 0;

  async function rememberWindow(windowId) {
    const entry = {};
    activeTabs.set(windowId, entry);
    const [tab] = await chrome.tabs.query({ active: true, windowId, windowType: 'normal' });
    if (activeTabs.get(windowId) === entry) entry.tab = tab;
  }

  function requestPip(expectedUrl, requestId) {
    const videos = window.AutoPipContent?.video;
    const marker = window.AutoPipContent?.markers?.appSwitch;
    if (!videos || !marker || window.__auto_pip_disabled__ === true ||
        window.__auto_pip_blocked__ === true) return { reason: 'disabled_or_unavailable' };
    if (document.URL !== expectedUrl || document.hidden || document.hasFocus()) {
      return { reason: 'source_changed_or_focused' };
    }
    if (document.pictureInPictureElement || window.__autoPipAppSwitchOpening) {
      return { reason: 'already_open_or_pending' };
    }
    if (!document.pictureInPictureEnabled) return { reason: 'picture_in_picture_unavailable' };
    const video = videos.findVideos({ minReadyState: 2, visibleOnly: true, includeDisabled: false })
      .find(videos.isPlaying);
    if (!video) return { reason: 'no_playing_video' };
    const exit = () => {
      if (window.__autoPipAppSwitchVideo?.requestId !== requestId) return;
      if (document.pictureInPictureElement === video) {
        return document.exitPictureInPicture();
      }
    };
    window.__autoPipAppSwitchOpening = true;
    return video.requestPictureInPicture().then(async () => {
      window.__autoPipAppSwitchVideo = { video, requestId };
      video.setAttribute(marker, '');
      const onFocus = () => { exit()?.catch(() => {}); };
      window.addEventListener('focus', onFocus);
      video.addEventListener('leavepictureinpicture', () => {
        window.removeEventListener('focus', onFocus);
        video.removeAttribute(marker);
        if (window.__autoPipAppSwitchVideo?.requestId === requestId) delete window.__autoPipAppSwitchVideo;
      }, { once: true });
      if (document.hasFocus() || window.__auto_pip_disabled__ === true ||
          window.__auto_pip_blocked__ === true) await exit();
      return { opened: document.pictureInPictureElement === video };
    }).catch(error => ({
      reason: 'request_rejected',
      error: error.name
    })).finally(() => { delete window.__autoPipAppSwitchOpening; });
  }

  function closePip(tab) {
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [tab.requestId],
      func: requestId => {
        const ownership = window.__autoPipAppSwitchVideo;
        if (ownership?.requestId !== requestId || document.pictureInPictureElement !== ownership.video) return;
        return document.exitPictureInPicture();
      }
    }).catch(() => {});
  }

  function handleCommand(command, commandTab) {
    if (command !== commandName || !root.AutoPip.state.autoPipOnTabSwitch) return;
    const generation = focusGeneration;
    function open(tab) {
      const rules = root.AutoPip.urlRules;
      if (generation !== focusGeneration || !root.AutoPip.state.autoPipOnTabSwitch ||
          !tab?.active || !/^https?:\/\//.test(tab.url || '') ||
          !rules.isValidTab(tab) || !rules.isAutoPipAllowedTab(tab)) return;
      const requestId = Date.now() + ':' + ++requestCount;
      const attempt = { id: tab.id, windowId: tab.windowId, requestId };
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: requestPip,
        args: [tab.url, requestId]
      }).then(([frame]) => {
        root.AutoPip.debug.debugLog('app-switch', 'request_result', frame?.result);
        if (!frame?.result?.opened) return;
        if (generation !== focusGeneration) return closePip(attempt);
        owner = attempt;
      }).catch(() => {});
    }
    const selected = activeTabs.get(lastWindow)?.tab || commandTab;
    if (selected) {
      open(selected);
      return;
    }
    // Global shortcuts can wake the worker without an active tab argument.
    // Extension API callbacks carry the command's user activation.
    chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' }, tabs => {
      if (!chrome.runtime.lastError) open(tabs[0]);
    });
  }

  function onFocusChanged(windowId) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      if (lastWindow == null) void rememberLastWindow();
      return;
    }
    focusGeneration++;
    lastWindow = windowId;
    if (owner?.windowId === windowId) {
      const closing = owner;
      owner = undefined;
      void closePip(closing);
    }
    rememberWindow(windowId).catch(() => {});
  }

  chrome.commands.onCommand.addListener(handleCommand);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  chrome.windows.onRemoved.addListener(windowId => {
    activeTabs.delete(windowId);
    if (lastWindow === windowId) lastWindow = undefined;
    if (owner?.windowId === windowId) owner = undefined;
  });
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    rememberWindow(windowId).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
    const entry = activeTabs.get(tab.windowId);
    if (entry?.tab?.id === tabId) entry.tab = tab;
  });
  chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
    if (activeTabs.get(windowId)?.tab?.id === tabId) activeTabs.delete(windowId);
    if (owner?.id === tabId) owner = undefined;
  });
  function rememberLastWindow() {
    return chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' }).then(([tab]) => {
      if (!tab || lastWindow != null) return;
      lastWindow = tab.windowId;
      if (!activeTabs.has(lastWindow)) activeTabs.set(lastWindow, { tab });
    }).catch(() => {});
  }
  void rememberLastWindow();
})(globalThis);
