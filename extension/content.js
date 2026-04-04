// ============================================
// DirectCast - Content Script
// Detects video content and handles remote control via
// direct video element manipulation (no synthetic keys —
// YouTube/Netflix reject them via isTrusted checks).
// ============================================

const PLATFORM_CONFIG = {
    youtube: { name: 'YouTube', extractMetadata: extractYouTubeMetadata },
    netflix: { name: 'Netflix', extractMetadata: extractNetflixMetadata },
    general: { name: 'Video Player', extractMetadata: extractGeneralMetadata }
};

// ============================================
// INITIALIZE
// ============================================

document.addEventListener('DOMContentLoaded', initializeDirectCast);
window.addEventListener('load', initializeDirectCast);

let _initialized = false;
function initializeDirectCast() {
    if (_initialized) return;
    _initialized = true;
    setupMessageListener();
}

// ============================================
// GET LARGEST VIDEO ELEMENT
// ============================================

function getLargestVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;
    return videos.reduce((largest, v) => {
        return (v.offsetWidth * v.offsetHeight) > (largest.offsetWidth * largest.offsetHeight)
            ? v : largest;
    });
}

// ============================================
// FULLSCREEN BEFORE CAPTURE
// Forces the video element fullscreen so tabCapture gets only the video,
// no YouTube chrome, sidebars, or dark letterbox background.
// Returns a cleanup function that restores the previous state.
// ============================================

async function enterVideoFullscreen() {
    const video = getLargestVideo();
    if (!video) return null;

    // If something is already fullscreen (e.g. user was already in fullscreen),
    // just leave it — we don't want to exit their fullscreen.
    if (document.fullscreenElement) return null;

    try {
        await video.requestFullscreen();
        // Give the browser a frame to actually apply fullscreen
        await new Promise(r => setTimeout(r, 150));
        return () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
        };
    } catch (e) {
        console.warn('[content] Could not enter fullscreen:', e.message);
        return null;
    }
}

async function exitVideoFullscreen() {
    if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
    }
}

// ============================================
// DIRECT VIDEO CONTROLS
// Bypasses isTrusted — works on YouTube, Netflix, and everything else.
// ============================================

function videoTogglePlayPause() {
    const video = getLargestVideo();
    if (!video) return false;
    if (video.paused) {
        video.play().catch(() => {});
    } else {
        video.pause();
    }
    return true;
}

function videoPause() {
    const video = getLargestVideo();
    if (!video) return false;
    if (!video.paused) video.pause();
    return true;
}

function videoResume() {
    const video = getLargestVideo();
    if (!video) return false;
    if (video.paused) video.play().catch(() => {});
    return true;
}

function videoSeekRelative(seconds) {
    const video = getLargestVideo();
    if (!video) return false;
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + seconds));
    return true;
}

function videoSeekTo(time) {
    const video = getLargestVideo();
    if (!video) return false;
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, time));
    return true;
}

function videoSetVolume(vol) {
    const video = getLargestVideo();
    if (!video) return false;
    video.volume = Math.max(0, Math.min(1, vol));
    video.muted  = false;
    return true;
}

// ============================================
// MESSAGE LISTENER
// ============================================

function setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

        if (request.action === 'getDetectedMedia') {
            sendResponse({ media: detectMediaOnPage() });
            return true;
        }

        if (request.action === 'startMirroring') {
            handleStartMirroring(request, sendResponse);
            return true;
        }

        if (request.action === 'getVideoState') {
            const video = getLargestVideo();
            if (!video) { sendResponse(null); return true; }
            sendResponse({
                currentTime: video.currentTime,
                duration:    video.duration,
                paused:      video.paused,
                volume:      video.volume
            });
            return true;
        }

        if (request.action === 'togglePlayPause') {
            sendResponse({ success: videoTogglePlayPause() });
            return true;
        }

        if (request.action === 'pause') {
            sendResponse({ success: videoPause() });
            return true;
        }

        if (request.action === 'resume') {
            sendResponse({ success: videoResume() });
            return true;
        }

        if (request.action === 'seek') {
            sendResponse({ success: videoSeekRelative(request.seconds) });
            return true;
        }

        if (request.action === 'seekTo') {
            sendResponse({ success: videoSeekTo(request.time) });
            return true;
        }

        if (request.action === 'setVolume') {
            sendResponse({ success: videoSetVolume(request.volume) });
            return true;
        }

        // ── NEW: fullscreen before/after capture ──────────────────────────
        // background.js calls 'enterFullscreenForCapture' just before
        // getMediaStreamId so the tab capture sees only the video.
        // It calls 'exitFullscreenAfterCapture' once the WebRTC stream
        // is established and the TV is showing the content.

        if (request.action === 'enterFullscreenForCapture') {
            enterVideoFullscreen().then(cleanup => {
                // Store the cleanup fn so exit can use it
                window._directcastFsCleanup = cleanup;
                sendResponse({ success: true });
            }).catch(() => sendResponse({ success: false }));
            return true; // async
        }

        if (request.action === 'exitFullscreenAfterCapture') {
            exitVideoFullscreen().then(() => {
                window._directcastFsCleanup = null;
                sendResponse({ success: true });
            }).catch(() => sendResponse({ success: false }));
            return true;
        }
    });
}

// ============================================
// DETECT VIDEO ELEMENTS
// ============================================

function detectMediaOnPage() {
    const videos = Array.from(document.querySelectorAll('video'));
    const detectedMedia = [];

    videos.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));

    videos.forEach((video) => {
        if (video.offsetWidth < 100 || video.offsetHeight < 75) return;
        const hasData = video.readyState >= 1 || video.duration > 0 || video.currentTime > 0;
        if (!hasData) return;
        const metadata = extractMediaMetadata(video);
        if (!detectedMedia.some(m => m.title === metadata.title)) {
            detectedMedia.push(metadata);
        }
    });

    return detectedMedia;
}

// ============================================
// METADATA EXTRACTION
// ============================================

function extractMediaMetadata(video) {
    const host = window.location.hostname;
    let platform = 'general';
    if (host.includes('youtube')) platform = 'youtube';
    else if (host.includes('netflix')) platform = 'netflix';
    return PLATFORM_CONFIG[platform]?.extractMetadata?.(video) || extractGeneralMetadata(video);
}

function extractGeneralMetadata(video) {
    let title = document.title || 'Video';
    if (title.includes(' - ')) title = title.split(' - ')[0];
    return {
        title:     title.substring(0, 100),
        source:    window.location.hostname,
        duration:  video.duration || 0,
        thumbnail: extractThumbnail(),
        url:       window.location.href
    };
}

function extractYouTubeMetadata(video) {
    const titleEl =
        document.querySelector('h1 yt-formatted-string') ||
        document.querySelector('h1.title') ||
        document.querySelector('[class*="title"]');
    const title = titleEl?.textContent?.trim() || document.title;

    let thumbnail = null;
    const thumbImg =
        document.querySelector('img.style-scope.yt-img-shadow') ||
        document.querySelector('[src*="maxresdefault.jpg"]') ||
        document.querySelector('[src*="sddefault.jpg"]');
    if (thumbImg) thumbnail = thumbImg.src;
    if (!thumbnail) thumbnail = document.querySelector('[property="og:image"]')?.content;

    return {
        title:    title.substring(0, 100),
        source:   'YouTube',
        duration: video.duration || 0,
        thumbnail,
        videoId:  new URL(window.location.href).searchParams.get('v') || '',
        url:      window.location.href
    };
}

function extractNetflixMetadata(video) {
    const titleEl =
        document.querySelector('h1') ||
        document.querySelector('[data-ui-id*="title"]');
    const title = titleEl?.textContent?.trim() || document.title;

    const thumbnail =
        document.querySelector('[data-uia*="player-image"]')?.src ||
        document.querySelector('img.boxart-image')?.src ||
        document.querySelector('[property="og:image"]')?.content;

    return {
        title:    title.substring(0, 100),
        source:   'Netflix',
        duration: video.duration || 0,
        thumbnail,
        url:      window.location.href
    };
}

function extractThumbnail() {
    for (const tag of ['og:image', 'twitter:image', 'image_src']) {
        const content = document.querySelector(
            `meta[property="${tag}"], meta[name="${tag}"]`
        )?.content;
        if (content) return content;
    }
    return null;
}

// ============================================
// HANDLE MIRRORING
// ============================================

function handleStartMirroring(request, sendResponse) {
    const { media, device } = request;
    try {
        chrome.runtime.sendMessage({
            action: 'startCasting',
            device,
            media,
            tabUrl: window.location.href
        }, () => { sendResponse({ success: true }); });
    } catch (err) {
        sendResponse({ success: false, error: err.message });
    }
}

console.log('DirectCast content script loaded');