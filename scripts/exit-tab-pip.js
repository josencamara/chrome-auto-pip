(async () => {
    'use strict';

    const content = window.AutoPipContent;
    const video = document.pictureInPictureElement;
    // The managed marker also appears on armed videos and toolbar PiP.
    if (!video?.hasAttribute(content.markers.compatRequested)) return { exited: false };
    const selection = await chrome.runtime.sendMessage({ type: 'auto_pip_tab_selection' }).catch(() => null);
    if (!selection?.active || document.pictureInPictureElement !== video ||
        !video.hasAttribute(content.markers.compatRequested)) return { exited: false };
    return content.pip.exitOwned();
})();
