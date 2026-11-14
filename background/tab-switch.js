(function initTabSwitch(root) {
  'use strict';

  const AutoPip = root.AutoPip;
  const { VIDEO_PLAYING_MESSAGE_THROTTLE_MS } = AutoPip.constants;
  const { debugLog, clearNativeAutoPipBlocker } = AutoPip.debug;
  const { isValidTab, isAutoPipAllowedTab, isRestrictedUrl } = AutoPip.urlRules;
  const {
    injectCheckVideoScript,
    injectExitPiPScript,
    injectDisableAndExitAutoPiPScript,
    injectDisableAutoPiPScript,
    injectImmediatePiPScript,
    registerTabForAutoPip,
    getFrameResultValues,
    hasAnyFrameTrue,
    hasExitedPiP
  } = AutoPip.inject;

  function setTargetTab(tabId) {
    AutoPip.state.targetTab = tabId == null ? null : tabId;
  }

  function refreshActiveTabTarget(tabId, eventName) {
    injectCheckVideoScript(tabId, (results) => {
      const hasVideo = hasAnyFrameTrue(results);
      if (hasVideo) setTargetTab(tabId);
      debugLog('background', eventName, { tabId, hasVideo, targetTab: AutoPip.state.targetTab });
    });
  }

  function exitOwnedPiPOnActiveTab(tabId, reason, callback) {
    injectExitPiPScript(tabId, (results) => {
      const frameValues = getFrameResultValues(results);
      const exited = hasExitedPiP(results);
      if (exited || AutoPip.state.pipActiveTab === tabId) {
        AutoPip.state.pipActiveTab = null;
      }
      if (exited) clearNativeAutoPipBlocker(tabId, reason);
      debugLog('background', 'active_tab_exit_checked', {
        tabId,
        reason,
        exited,
        frameValues
      });
      if (callback) callback({ exited, frameValues });
    });
  }

  function registerAllowedTabs() {
    if (AutoPip.state.nativeAutoPip) return;
    if (!AutoPip.state.autoPipOnTabSwitch) return;
    chrome.tabs.query({}, (tabs) => {
      if (!tabs) return;
      tabs.forEach(tab => {
        if (!isValidTab(tab) || !isAutoPipAllowedTab(tab)) return;
        registerTabForAutoPip(tab.id, () => { });
      });
    });
  }

  function disarmAutoPipOnAllTabs() {
    chrome.tabs.query({}, (tabs) => {
      if (!AutoPip.state.nativeAutoPip) return;
      (tabs || []).filter(isValidTab).forEach(tab => {
        injectDisableAutoPiPScript(tab.id, () => {});
      });
    });
  }

  function cleanupAutoPipOnAllTabs() {
    debugLog('background', 'cleanup_all_tabs_start');
    chrome.tabs.query({}, (tabs) => {
      if (!tabs) return;
      tabs.forEach(tab => {
        if (!isValidTab(tab)) return;
        clearNativeAutoPipBlocker(tab.id, 'cleanup_all_tabs');
        injectDisableAndExitAutoPiPScript(tab.id, () => { });
      });
    });
  }

  function cleanupBlockedTabs() {
    if (AutoPip.state.nativeAutoPip) return;
    debugLog('background', 'cleanup_blocked_tabs_start', { blocklist: AutoPip.state.autoPipSiteBlocklist });
    chrome.tabs.query({}, (tabs) => {
      if (!tabs) return;
      tabs.forEach(tab => {
        if (!isValidTab(tab)) return;
        if (isAutoPipAllowedTab(tab)) return;
        clearNativeAutoPipBlocker(tab.id, 'cleanup_blocked_tab');
        injectDisableAndExitAutoPiPScript(tab.id, () => { });
        if (AutoPip.state.targetTab === tab.id) setTargetTab(null);
        if (AutoPip.state.pipActiveTab === tab.id) AutoPip.state.pipActiveTab = null;
      });
    });
  }

  function primeActiveTabForAutoPip() {
    if (AutoPip.state.nativeAutoPip) return;
    debugLog('background', 'prime_active_tab_start');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
      if (!isValidTab(activeTab) || !isAutoPipAllowedTab(activeTab)) return;
      registerTabForAutoPip(activeTab.id, () => { });
      injectCheckVideoScript(activeTab.id, (results) => {
        if (!hasAnyFrameTrue(results)) return;
        setTargetTab(activeTab.id);
        AutoPip.state.currentTab = activeTab.id;
      });
    });
  }

  function applyBlocklistToOpenTabs() {
    cleanupBlockedTabs();
  }

  function handleToolbarClick(tab) {
    if (!tab || isRestrictedUrl(tab.url)) return;
    debugLog('background', 'toolbar_click', { tabId: tab.id, url: tab.url });

    if (AutoPip.state.pipActiveTab && AutoPip.state.pipActiveTab !== tab.id) {
      injectExitPiPScript(AutoPip.state.pipActiveTab, () => {
        AutoPip.state.pipActiveTab = null;
      });
      return;
    }

    injectImmediatePiPScript(tab.id, (pipResults) => {
      const frameValues = getFrameResultValues(pipResults);
      const toggledOff = frameValues.some(value =>
        value === 'toggled_off' ||
        !!(value && value.status === 'toggled_off')
      );
      const activated = frameValues.some(value =>
        value === true ||
        !!(value && value.ok === true && value.status === 'success')
      );

      if (toggledOff) {
        AutoPip.state.pipActiveTab = null;
        clearNativeAutoPipBlocker(tab.id, 'toolbar_toggled_off');
        debugLog('background', 'toolbar_pip_toggled_off', { tabId: tab.id, frameValues });
      } else if (activated) {
        AutoPip.state.pipActiveTab = tab.id;
        clearNativeAutoPipBlocker(tab.id, 'toolbar_pip_activated');
        debugLog('background', 'toolbar_pip_activated', { tabId: tab.id, frameValues });
      }
    });

    if (!AutoPip.state.nativeAutoPip && AutoPip.state.autoPipOnTabSwitch) {
      registerTabForAutoPip(tab.id, (results) => {
        if (hasAnyFrameTrue(results)) setTargetTab(tab.id);
      });
    }
  }

  function handleTabRemoved(tabId) {
    clearNativeAutoPipBlocker(tabId, 'tab_removed');
    if (AutoPip.state.targetTab === tabId) setTargetTab(null);
    if (AutoPip.state.pipActiveTab === tabId) AutoPip.state.pipActiveTab = null;
    if (AutoPip.state.lastVideoPlayingTargetedAtByTab[tabId]) {
      delete AutoPip.state.lastVideoPlayingTargetedAtByTab[tabId];
    }
  }

  function handleTabActivated(tab) {
    const activatedTabId = tab.tabId;
    const previousCurrentTab = AutoPip.state.currentTab;
    AutoPip.state.prevTab = previousCurrentTab;
    AutoPip.state.currentTab = activatedTabId;
    if (AutoPip.state.nativeAutoPip) return;

    chrome.tabs.get(AutoPip.state.currentTab, (activeTab) => {
      if (AutoPip.state.nativeAutoPip || chrome.runtime.lastError || !activeTab) return;
      AutoPip.state.currentTab = activeTab.id;

      if (!isAutoPipAllowedTab(activeTab)) {
        debugLog('background', 'active_tab_blocked', { tabId: AutoPip.state.currentTab, url: activeTab.url });
        if (AutoPip.state.targetTab === AutoPip.state.currentTab) setTargetTab(null);
        if (AutoPip.state.pipActiveTab === AutoPip.state.currentTab) AutoPip.state.pipActiveTab = null;
        clearNativeAutoPipBlocker(AutoPip.state.currentTab, 'active_tab_blocked');
        injectDisableAndExitAutoPiPScript(AutoPip.state.currentTab, () => { });
        return;
      }

      if (!AutoPip.state.autoPipOnTabSwitch) return;

      registerTabForAutoPip(AutoPip.state.currentTab, () => { });

      const activationReason = AutoPip.state.currentTab === AutoPip.state.targetTab ||
        AutoPip.state.pipActiveTab === AutoPip.state.currentTab
        ? 'returned_to_target'
        : 'active_tab_visible';
      exitOwnedPiPOnActiveTab(AutoPip.state.currentTab, activationReason, () => {
        refreshActiveTabTarget(AutoPip.state.currentTab, activationReason === 'returned_to_target'
          ? 'returned_to_target_checked'
          : 'active_tab_checked_for_target');
      });
    });
  }

  function handleTabUpdated(tabId, changeInfo, tab) {
    if (AutoPip.state.nativeAutoPip) return;
    if (!tab || !tab.url || isRestrictedUrl(tab.url)) return;
    if (tab.active && (changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
      debugLog('background', 'active_tab_updated', { tabId, status: changeInfo.status, url: tab.url });
    }

    if (!isAutoPipAllowedTab(tab)) {
      injectDisableAndExitAutoPiPScript(tabId, () => { });
      return;
    }

    if (!tab.active || !AutoPip.state.autoPipOnTabSwitch) return;

    if (changeInfo.status === 'loading') {
      registerTabForAutoPip(tabId, () => { });
      return;
    }

    if (changeInfo.status === 'complete') {
      registerTabForAutoPip(tabId, () => { });
      setTimeout(() => {
        injectCheckVideoScript(tabId, (results) => {
          if (hasAnyFrameTrue(results)) setTargetTab(tabId);
        });
      }, 500);
    }
  }

  function handleVideoPlayingMessage(senderTab) {
    if (AutoPip.state.nativeAutoPip) return;
    const senderTabId = senderTab.id;
    if (!isAutoPipAllowedTab(senderTab) || !AutoPip.state.autoPipOnTabSwitch) return;
    const now = Date.now();
    if ((now - (AutoPip.state.lastVideoPlayingTargetedAtByTab[senderTabId] || 0)) < VIDEO_PLAYING_MESSAGE_THROTTLE_MS) {
      return;
    }
    AutoPip.state.lastVideoPlayingTargetedAtByTab[senderTabId] = now;
    if (senderTabId === AutoPip.state.currentTab || AutoPip.state.targetTab === null) {
      setTargetTab(senderTabId);
      registerTabForAutoPip(senderTabId, () => { });
      debugLog('background', 'video_playing_targeted', {
        tabId: senderTabId,
        currentTab: AutoPip.state.currentTab,
        targetTab: AutoPip.state.targetTab
      });
    }
  }

  function initTabListeners() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    chrome.tabs.onRemoved.addListener(handleTabRemoved);
    chrome.tabs.onActivated.addListener(handleTabActivated);
    chrome.tabs.onUpdated.addListener(handleTabUpdated);
    if (chrome.action) chrome.action.onClicked.addListener(handleToolbarClick);
  }

  AutoPip.tabSwitch = {
    setTargetTab,
    refreshActiveTabTarget,
    exitOwnedPiPOnActiveTab,
    registerAllowedTabs,
    cleanupAutoPipOnAllTabs,
    disarmAutoPipOnAllTabs,
    cleanupBlockedTabs,
    primeActiveTabForAutoPip,
    applyBlocklistToOpenTabs,
    handleToolbarClick,
    handleTabRemoved,
    handleTabActivated,
    handleTabUpdated,
    handleVideoPlayingMessage,
    initTabListeners
  };

  root.setTargetTab = setTargetTab;
  root.refreshActiveTabTarget = refreshActiveTabTarget;
  root.exitOwnedPiPOnActiveTab = exitOwnedPiPOnActiveTab;
  root.registerAllowedTabs = registerAllowedTabs;
  root.cleanupAutoPipOnAllTabs = cleanupAutoPipOnAllTabs;
  root.cleanupBlockedTabs = cleanupBlockedTabs;
  root.primeActiveTabForAutoPip = primeActiveTabForAutoPip;
  root.applyBlocklistToOpenTabs = applyBlocklistToOpenTabs;
})(globalThis);
