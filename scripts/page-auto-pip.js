// Browser-facing MediaSession Auto-PiP handler. Runs in the page's main world.

(function pageAutoPiP() {
    'use strict';

    if (!('mediaSession' in navigator)) return { ok: false, reason: 'no_media_session' };

    const OWNED_ATTR = 'data-auto-pip-managed';
    const ADDED_AUTOPIP_ATTR = 'data-auto-pip-added-autopictureinpicture';
    const COMPAT_ATTR = 'data-auto-pip-compat-requested';
    const LAST_PLAYING_ATTR = 'data-auto-pip-last-playing-at';
    const NATIVE_MISS_CHECK_MS = 900;
    const LISTENER_VERSION = 7;

    const state = window.__auto_pip_page_state__ || {
        listenersRegistered: false,
        hasPlaying: false,
        observer: null,
        videos: new Set(),
        refreshTimer: null,
        lastRegistrationLog: '',
        nativeMissToken: 0,
        nativeMissTimer: null,
        nativeMissReported: false,
        listenerVersion: 0
    };
    if (!('previousPlaybackState' in state) || window.__auto_pip_page_disabled__ === true) {
        state.previousPlaybackState = navigator.mediaSession.playbackState || 'none';
    }
    window.__auto_pip_page_state__ = state;
    if (!(state.videos instanceof Set)) {
        state.videos = new Set();
    }

    function debugLog(event, details = {}) {
        try {
            window.postMessage({
                source: 'chrome-auto-pip-v2-page',
                event,
                details: {
                    url: location.href,
                    visibilityState: document.visibilityState,
                    ...details
                }
            }, '*');
        } catch (_) { }
    }

    function isDisabled() {
        return window.__auto_pip_page_disabled__ === true;
    }

    function isPlaying(video) {
        return !!video && !video.paused && !video.ended && video.readyState >= 2;
    }

    function getHostname() {
        try {
            return new URL(location.href).hostname.toLowerCase();
        } catch (_) {
            return null;
        }
    }

    function collectVideos(root, videos) {
        if (!root) return;
        try {
            if (root instanceof HTMLVideoElement) videos.add(root);
        } catch (_) { }
        try {
            if (root.querySelectorAll) {
                root.querySelectorAll('video').forEach(video => videos.add(video));
            }
        } catch (_) { }
        try {
            if (!root.querySelectorAll) return;
            root.querySelectorAll('*').forEach((element) => {
                if (element && element.shadowRoot) {
                    collectVideos(element.shadowRoot, videos);
                }
            });
        } catch (_) { }
    }

    function rememberVideo(video) {
        if (!video) return;
        try {
            if (video instanceof HTMLVideoElement) {
                state.videos.add(video);
            }
        } catch (_) { }
    }

    function getVideos() {
        collectVideos(document, state.videos);
        Array.from(state.videos).forEach((video) => {
            try {
                if (!video || !video.isConnected) state.videos.delete(video);
            } catch (_) { }
        });
        return Array.from(state.videos)
            .filter(video => video && video.readyState >= 1)
            .sort((a, b) => Number(isPlaying(b)) - Number(isPlaying(a)));
    }

    function getVideoStats(videos) {
        const stats = {
            videoCount: videos.length,
            hasPlaying: videos.some(isPlaying),
            autoPipAttrCount: 0,
            ownedAttrCount: 0,
            addedAutoPipAttrCount: 0,
            playbackState: null,
            pictureInPictureEnabled: null,
            topFrame: null,
            playingMutedCount: 0,
            playingAudibleCandidateCount: 0
        };

        videos.forEach((video) => {
            try {
                if (video.hasAttribute('autopictureinpicture')) stats.autoPipAttrCount += 1;
                if (video.hasAttribute(OWNED_ATTR)) stats.ownedAttrCount += 1;
                if (video.hasAttribute(ADDED_AUTOPIP_ATTR)) stats.addedAutoPipAttrCount += 1;
                if (isPlaying(video) && video.muted) stats.playingMutedCount += 1;
                if (isPlaying(video) && !video.muted && Number(video.volume) > 0) {
                    stats.playingAudibleCandidateCount += 1;
                }
            } catch (_) { }
        });

        try { stats.playbackState = navigator.mediaSession.playbackState; } catch (_) { }
        try { stats.pictureInPictureEnabled = document.pictureInPictureEnabled === true; } catch (_) { }
        try { stats.topFrame = window.top === window; } catch (_) { }
        return stats;
    }

    function logRegistration(stats, options = {}) {
        const signature = [
            document.visibilityState,
            stats.videoCount,
            stats.hasPlaying,
            stats.autoPipAttrCount,
            stats.ownedAttrCount,
            stats.addedAutoPipAttrCount,
            stats.playbackState,
            stats.playingMutedCount,
            stats.playingAudibleCandidateCount
        ].join('|');

        if (options.force === true || signature !== state.lastRegistrationLog) {
            state.lastRegistrationLog = signature;
            debugLog('page_registration_updated', stats);
        }
    }

    function cleanupVideo(video) {
        if (!video) return;
        try {
            if (video.hasAttribute(ADDED_AUTOPIP_ATTR)) {
                video.removeAttribute('autopictureinpicture');
            }
            video.removeAttribute(ADDED_AUTOPIP_ATTR);
            video.removeAttribute(OWNED_ATTR);
            video.removeAttribute(COMPAT_ATTR);
        } catch (_) { }
    }

    function syncVideo(video) {
        if (!video) return;
        if (isPlaying(video) && !isDisabled()) {
            try { video.setAttribute(LAST_PLAYING_ATTR, String(Date.now())); } catch (_) { }
            try {
                if (!video.hasAttribute('autopictureinpicture')) {
                    video.setAttribute('autopictureinpicture', '');
                    video.setAttribute(ADDED_AUTOPIP_ATTR, '');
                    debugLog('page_autopip_attr_added', {
                        readyState: video.readyState,
                        currentTime: video.currentTime
                    });
                }
                video.setAttribute(OWNED_ATTR, '');
            } catch (_) { }
            return;
        }

        if (video.hasAttribute(OWNED_ATTR) || video.hasAttribute(ADDED_AUTOPIP_ATTR)) {
            cleanupVideo(video);
        }
    }

    async function closeAutoPiPOnReturn() {
        if (document.visibilityState !== 'visible') return false;
        const video = document.pictureInPictureElement;
        if (!video || !video.hasAttribute(COMPAT_ATTR)) return false;
        try {
            await document.exitPictureInPicture();
            video.removeAttribute(COMPAT_ATTR);
            debugLog('page_auto_pip_closed_on_return');
            return true;
        } catch (error) {
            debugLog('page_auto_pip_return_close_failed', {
                message: error && error.message ? error.message : String(error)
            });
            return false;
        }
    }

    function notifyPiPState(inPictureInPicture) {
        debugLog('page_pip_state_changed', {
            inPictureInPicture: inPictureInPicture === true
        });
    }

    function attachPiPStateBridge(video) {
        if (!video || video.__autoPipPageStateBridgeVersion === LISTENER_VERSION) return;
        video.__autoPipPageStateBridgeVersion = LISTENER_VERSION;
        try {
            video.addEventListener('enterpictureinpicture', () => notifyPiPState(true));
            video.addEventListener('leavepictureinpicture', () => {
                notifyPiPState(false);
                video.removeAttribute(COMPAT_ATTR);
            });
        } catch (_) { }
    }

    function updateRegistration(options = {}) {
        if (isDisabled()) {
            getVideos().forEach(cleanupVideo);
            state.registered = false;
            clearNativeMissWatch('disabled');
            return false;
        }

        const videos = getVideos();
        videos.forEach(syncVideo);
        videos.forEach(attachPiPStateBridge);
        const hasPlaying = videos.some(isPlaying);
        try {
            state.assistedPlaybackState = hasPlaying ? 'playing' : 'paused';
            navigator.mediaSession.playbackState = state.assistedPlaybackState;
            if (!state.actionHandlerRegistered) {
                navigator.mediaSession.setActionHandler('enterpictureinpicture', enterPictureInPicture);
                state.actionHandlerRegistered = true;
            }
        } catch (_) { }

        state.hasPlaying = hasPlaying;
        const stats = getVideoStats(videos);
        logRegistration(stats, { force: options.forceLog === true });
        if (!hasPlaying || document.visibilityState === 'visible') {
            clearNativeMissWatch(hasPlaying ? 'visible' : 'not_playing');
        }
        return hasPlaying;
    }

    async function enterPictureInPicture() {
        debugLog('page_enterpictureinpicture_start');
        if (isDisabled()) {
            debugLog('page_enterpictureinpicture_disabled');
            return false;
        }
        if (document.pictureInPictureElement) {
            debugLog('page_enterpictureinpicture_already_active');
            return true;
        }

        const video = getVideos().find(isPlaying);
        if (!video || typeof video.requestPictureInPicture !== 'function') {
            debugLog('page_enterpictureinpicture_no_video');
            return false;
        }

        try {
            syncVideo(video);
            attachPiPStateBridge(video);
            await video.requestPictureInPicture();
            if (isDisabled()) return true;
            // This request came from the automatic MediaSession handler.
            // Record the origin so returning to the tab does not close manual PiP.
            video.setAttribute(COMPAT_ATTR, String(Date.now()));
            if (document.visibilityState === 'visible') {
                // Covers a rapid leave-and-return before the async request finishes.
                await closeAutoPiPOnReturn();
            }
            debugLog('page_enterpictureinpicture_success', {
                readyState: video.readyState,
                currentTime: video.currentTime
            });
            return true;
        } catch (error) {
            debugLog('page_enterpictureinpicture_failed', {
                message: error && error.message ? error.message : String(error),
                userActivation: getUserActivationState()
            });
            return false;
        }
    }

    function clearNativeMissWatch(reason) {
        const shouldLogClear = !!state.nativeMissTimer || state.nativeMissReported === true;
        state.nativeMissToken = (state.nativeMissToken || 0) + 1;
        if (state.nativeMissTimer) {
            try { clearTimeout(state.nativeMissTimer); } catch (_) { }
            state.nativeMissTimer = null;
        }
        if (shouldLogClear) {
            state.nativeMissReported = false;
            debugLog('page_native_auto_pip_clear', { reason });
        }
    }

    function scheduleNativeMissWatch() {
        const videos = getVideos();
        const stats = getVideoStats(videos);
        if (!stats.hasPlaying || document.visibilityState !== 'hidden') return;
        if (document.pictureInPictureElement) {
            clearNativeMissWatch('already_active');
            return;
        }

        const token = (state.nativeMissToken || 0) + 1;
        state.nativeMissToken = token;
        if (state.nativeMissTimer) {
            try { clearTimeout(state.nativeMissTimer); } catch (_) { }
        }

        state.nativeMissTimer = setTimeout(() => {
            state.nativeMissTimer = null;
            if (state.nativeMissToken !== token) return;
            if (document.visibilityState !== 'hidden') return;
            if (document.pictureInPictureElement) {
                clearNativeMissWatch('already_active');
                return;
            }

            const latestVideos = getVideos();
            const latestStats = getVideoStats(latestVideos);
            if (!latestStats.hasPlaying) {
                clearNativeMissWatch('not_playing');
                return;
            }

            state.nativeMissReported = true;
            debugLog('page_native_auto_pip_not_fired', {
                hostname: getHostname(),
                reason: 'native_auto_pip_not_fired',
                likelyReason: 'site_auto_pip_permission_or_media_engagement',
                ...latestStats
            });
        }, NATIVE_MISS_CHECK_MS);
    }

    function getUserActivationState() {
        try {
            if (!navigator.userActivation) {
                return { isActive: false, hasBeenActive: false, available: false };
            }
            return {
                isActive: navigator.userActivation.isActive === true,
                hasBeenActive: navigator.userActivation.hasBeenActive === true,
                available: true
            };
        } catch (_) {
            return { isActive: false, hasBeenActive: false, available: false };
        }
    }

    function scheduleRefresh() {
        if (state.refreshTimer) return;
        state.refreshTimer = setTimeout(() => {
            state.refreshTimer = null;
            updateRegistration();
        }, 100);
    }

    window.__auto_pip_page_disable__ = () => {
        window.__auto_pip_page_disabled__ = true;
        getVideos().forEach(cleanupVideo);
        try {
            if (navigator.mediaSession.playbackState === state.assistedPlaybackState) {
                navigator.mediaSession.playbackState = state.previousPlaybackState;
            }
        } catch (_) { }
        state.registered = false;
        state.hasPlaying = false;
        debugLog('page_disabled');
        return true;
    };

    if (!window.__auto_pip_page_disable_listener__) {
        window.addEventListener('message', (event) => {
            const data = event && event.data;
            if (!data || data.source !== 'chrome-auto-pip-v2-isolated') return;
            if (data.type === 'disable_auto_pip') {
                window.__auto_pip_page_disable__();
            }
        });
        window.__auto_pip_page_disable_listener__ = true;
    }

    window.__auto_pip_page_disabled__ = false;

    if (state.listenerVersion !== LISTENER_VERSION) {
        if (state.observer) {
            try { state.observer.disconnect(); } catch (_) { }
            state.observer = null;
        }

        ['play', 'playing', 'pause', 'volumechange', 'loadedmetadata', 'loadeddata', 'canplay'].forEach((eventName) => {
            document.addEventListener(eventName, (event) => {
                rememberVideo(event.target);
                scheduleRefresh();
            }, true);
        });

        document.addEventListener('visibilitychange', () => {
            debugLog('page_visibility_changed');

            if (document.visibilityState === 'hidden') {
                updateRegistration({ forceLog: true });
                scheduleNativeMissWatch();
            } else {
                // Native PiP normally exits automatically. Explicitly close PiP
                // started by our automatic path if Chromium leaves it floating.
                void closeAutoPiPOnReturn();
                clearNativeMissWatch('visible');
                updateRegistration({ forceLog: true });
            }
        }, true);

        try {
            state.observer = new MutationObserver(scheduleRefresh);
            state.observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true
            });
        } catch (_) { }

        state.listenersRegistered = true;
        state.listenerVersion = LISTENER_VERSION;
        debugLog('page_listeners_registered', { listenerVersion: LISTENER_VERSION });
    }

    return { ok: true, hasPlaying: updateRegistration({ forceLog: true }) };
})();
