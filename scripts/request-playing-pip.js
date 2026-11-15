(async () => {
    'use strict';

    const videoLib = window.AutoPipContent && window.AutoPipContent.video;
    const pip = window.AutoPipContent && window.AutoPipContent.pip;
    const path = 'tab_leave_compat';
    const getSelection = () => chrome.runtime.sendMessage({ type: 'auto_pip_tab_selection' }).catch(() => null);

    try {
        if (!videoLib || !pip) {
            return { ok: false, status: 'failed', reason: 'missing_content_lib', path };
        }

        if (window.__auto_pip_disabled__ === true || window.__auto_pip_blocked__ === true) {
            return videoLib.result(false, 'skipped', 'disabled_or_blocked', path, null);
        }

        if (document.pictureInPictureElement) {
            const active = document.pictureInPictureElement;
            const automatic = active.hasAttribute(window.AutoPipContent.markers.compatRequested);
            return videoLib.result(automatic, automatic ? 'already_active' : 'skipped', 'already_active', path, active);
        }

        if (!(await getSelection())?.inactive) {
            return videoLib.result(false, 'skipped', 'tab_active_or_unavailable', path, null);
        }

        const candidates = videoLib.findVideos({
            deep: true,
            minReadyState: 2,
            visibleOnly: false,
            playingFirst: true,
            includeDisabled: true
        }).filter(video =>
            videoLib.isPlaying(video) &&
            typeof video.requestPictureInPicture === 'function'
        );

        const video = candidates[0] || null;
        if (!video) {
            return videoLib.result(false, 'skipped', 'no_playing_video', path, null);
        }

        await pip.request(video, {
            allowDisablePictureInPictureOverride: true,
            ensureAutoPipAttr: true,
            compat: true
        });
        const selection = await getSelection();
        if (selection?.inactive === false && document.pictureInPictureElement === video) {
            await pip.exitOwned();
            return videoLib.result(false, 'skipped', 'tab_returned', path, video);
        }
        return videoLib.result(true, 'success', 'requested_picture_in_picture', path, video);
    } catch (error) {
        return {
            ok: false,
            status: 'failed',
            reason: 'request_failed',
            path,
            message: error && error.message ? error.message : String(error),
            name: error && error.name ? error.name : null,
            video: null
        };
    }
})();
