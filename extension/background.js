// ============================================
// DirectCast - Background Service Worker
// Owns signalling + state. WebRTC lives in offscreen.js.
// HDMI mode: moves the casting tab to a detected secondary display.
// GPU capability is detected eagerly and passed to offscreen on cast.
// ============================================

const SIGNAL = 'https://direct-play-iota.vercel.app/api/signal';

let castingTabId    = null;
let castingCode     = null;
let connectionState = 'idle'; // idle | capturing | connecting | streaming | disconnected

// HDMI mode state
let hdmiWindowId    = null;
let hdmiPollTimer   = null;
let hdmiScreenCount = 1;
let hdmiMode        = false;

// GPU capability (pre-detected via offscreen, cached here)
let cachedGpuCapability = null;

let keepAliveInterval = null;

let _reconnectTimer   = null;
let _reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// ============================================
// KEEP ALIVE
// ============================================

function startKeepAlive() {
    stopKeepAlive();
    keepAliveInterval = setInterval(() => {
        chrome.storage.local.get('castState', () => {});
    }, 20000);
}

function stopKeepAlive() {
    if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

function broadcastStatus(msg) {
    chrome.runtime.sendMessage({ action: 'castStatus', ...msg }).catch(() => {});
}

async function ensureOffscreen() {
    const existing = await chrome.offscreen.hasDocument().catch(() => false);
    if (existing) {
        const alive = await chrome.runtime.sendMessage({ action: 'offscreen_ping' })
            .catch(() => null);
        if (alive?.alive) return;
        await chrome.offscreen.closeDocument().catch(() => {});
    }
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab stream via getUserMedia for WebRTC casting'
    });
}

async function warmUpGpuDetection() {
    try {
        await ensureOffscreen();
        const cap = await chrome.runtime.sendMessage({ action: 'offscreen_getGpu' });
        if (cap && !cap.error) {
            cachedGpuCapability = cap;
            console.log('[bg] GPU pre-detection:', cap);
        }
    } catch (e) {
        console.warn('[bg] GPU pre-detection failed (will detect on first cast):', e.message);
    }
}

// ============================================
// MESSAGE LISTENER
// ============================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        switch (request.action) {

            case 'getState':
                sendResponse({ connectionState, castingTabId, castingCode, hdmiMode, gpuCapability: cachedGpuCapability });
                break;

            case 'startCast':
                _reconnectAttempt = 0;
                await startCast(request.code, request.tabId);
                sendResponse({ ok: true });
                break;

            case 'stopCast':
                _reconnectAttempt = MAX_RECONNECT_ATTEMPTS;
                clearTimeout(_reconnectTimer);
                await stopCast();
                sendResponse({ ok: true });
                break;

            case 'startHdmi':
                await startHdmiMode(request.tabId);
                sendResponse({ ok: true });
                break;

            case 'stopHdmi':
                await stopHdmiMode();
                sendResponse({ ok: true });
                break;

            case 'getDisplays':
                sendResponse({ screenCount: hdmiScreenCount });
                break;

            case 'getGpuCapability':
                sendResponse({ gpuCapability: cachedGpuCapability });
                break;

            case 'remoteCommand':
                await handleRemoteCommand(request.command);
                sendResponse({ ok: true });
                break;

            case 'rtcStateChange':
                handleRtcStateChange(request.state);
                sendResponse({ ok: true });
                break;

            case 'receiverCommand':
                await handleReceiverCommand(request.command);
                sendResponse({ ok: true });
                break;

            default:
                sendResponse({ error: 'unknown action' });
        }
    })();
    return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === castingTabId) stopCast();
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === hdmiWindowId) {
        hdmiWindowId = null;
        hdmiMode     = false;
        connectionState = 'idle';
        updateIcon('default');
        stopKeepAlive();
        broadcastStatus({ connectionState, status: 'HDMI window closed', hdmiMode: false });
    }
});

// ============================================
// HDMI MODE
// ============================================

async function startHdmiMode(tabId) {
    castingTabId = tabId;
    hdmiMode     = true;
    connectionState = 'capturing';
    updateIcon('capturing');
    startKeepAlive();
    broadcastStatus({ connectionState, status: 'Looking for display…', hdmiMode: true });

    try {
        const displays = await getDisplays();
        const secondaryDisplays = displays.filter(d => !d.isPrimary);

        let targetDisplay = null;
        if (secondaryDisplays.length > 0) {
            targetDisplay = secondaryDisplays.reduce((best, d) => {
                const area     = d.bounds.width * d.bounds.height;
                const bestArea = best.bounds.width * best.bounds.height;
                return area > bestArea ? d : best;
            });
        }

        if (!targetDisplay) {
            broadcastStatus({
                connectionState: 'idle',
                status: '⚠ No secondary display found. Connect your TV via HDMI first.',
                hdmiMode: false
            });
            hdmiMode        = false;
            connectionState = 'idle';
            updateIcon('default');
            stopKeepAlive();
            return;
        }

        const { left, top, width, height } = targetDisplay.bounds;
        const tab = await chrome.tabs.get(tabId);

        const newWindow = await chrome.windows.create({
            url:    tab.url,
            left:   left,
            top:    top,
            width:  width,
            height: height,
            type:   'normal',
            state:  'normal'
        });

        hdmiWindowId = newWindow.id;
        await sleep(400);
        await chrome.windows.update(hdmiWindowId, { state: 'fullscreen' });

        const [newTab] = newWindow.tabs;
        if (newTab) castingTabId = newTab.id;

        connectionState = 'streaming';
        updateIcon('casting');
        broadcastStatus({
            connectionState,
            status: `🖥 Playing on ${targetDisplay.name || 'TV screen'}`,
            hdmiMode: true
        });

        startHdmiDisplayPoll();

    } catch (err) {
        console.error('startHdmiMode error:', err);
        hdmiMode        = false;
        connectionState = 'idle';
        updateIcon('default');
        stopKeepAlive();
        broadcastStatus({
            connectionState: 'idle',
            status: '❌ ' + err.message,
            hdmiMode: false
        });
    }
}

async function stopHdmiMode() {
    stopHdmiDisplayPoll();
    hdmiMode        = false;
    connectionState = 'idle';
    castingTabId    = null;
    updateIcon('default');
    stopKeepAlive();
    broadcastStatus({ connectionState, status: 'Disconnected', hdmiMode: false });

    if (hdmiWindowId) {
        try { await chrome.windows.remove(hdmiWindowId); } catch (e) {}
        hdmiWindowId = null;
    }
}

function startHdmiDisplayPoll() {
    stopHdmiDisplayPoll();
    hdmiPollTimer = setInterval(async () => {
        try {
            const displays = await getDisplays();
            if (displays.length < hdmiScreenCount) {
                console.log('[bg] Display disconnected — stopping HDMI mode');
                broadcastStatus({ connectionState: 'idle', status: '📺 TV disconnected', hdmiMode: false });
                await stopHdmiMode();
            }
            hdmiScreenCount = displays.length;
        } catch (e) {}
    }, 2000);
}

function stopHdmiDisplayPoll() {
    if (hdmiPollTimer) { clearInterval(hdmiPollTimer); hdmiPollTimer = null; }
}

function getDisplays() {
    return new Promise((resolve, reject) => {
        chrome.system.display.getInfo({}, (displays) => {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
            hdmiScreenCount = displays.length;
            resolve(displays);
        });
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================
// START CAST (WebRTC mode)
// FIX: Now fullscreens the video element on the source tab before capturing.
// This ensures tabCapture sees only the video — no YouTube chrome, no dark
// sidebar background, no letterbox bars from the page layout. The fullscreen
// is exited automatically once the WebRTC stream is confirmed connected.
// ============================================

async function startCast(code, tabId) {
    castingCode     = code;
    castingTabId    = tabId;
    hdmiMode        = false;
    connectionState = 'capturing';
    broadcastStatus({ connectionState, status: 'Capturing tab…', hdmiMode: false });
    updateIcon('capturing');
    startKeepAlive();

    try {
        // ── Step 1: fullscreen the video element so the capture is clean ──
        broadcastStatus({ connectionState, status: 'Preparing video…', hdmiMode: false });
        await new Promise(resolve => {
            chrome.tabs.sendMessage(tabId, { action: 'enterFullscreenForCapture' }, () => {
                // Ignore errors — if fullscreen fails we still capture (just with bars)
                resolve();
            });
        });

        // Small delay to let the fullscreen transition complete
        await sleep(300);

        // ── Step 2: capture the (now fullscreen) tab ──
        const streamId = await new Promise((resolve, reject) => {
            chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
                if (chrome.runtime.lastError || !id) {
                    reject(new Error(chrome.runtime.lastError?.message || 'getMediaStreamId failed'));
                } else {
                    resolve(id);
                }
            });
        });

        await ensureOffscreen();

        connectionState = 'connecting';
        broadcastStatus({ connectionState, status: 'Contacting TV…', hdmiMode: false });

        const { settings = {} } = await chrome.storage.local.get('settings');
        const quality = settings.quality || '1080p';

        const result = await chrome.runtime.sendMessage({
            action: 'offscreen_startWebRTC',
            streamId,
            code,
            quality,
            gpuCapability: cachedGpuCapability
        });

        if (result?.error) throw new Error(result.error);

        broadcastStatus({ connectionState, status: 'Waiting for TV…', hdmiMode: false });

    } catch (err) {
        console.error('startCast error:', err);

        // Make sure we clean up fullscreen if capture failed
        chrome.tabs.sendMessage(tabId, { action: 'exitFullscreenAfterCapture' }, () => {});

        connectionState = 'idle';
        broadcastStatus({ connectionState, status: '❌ ' + err.message, hdmiMode: false });
        updateIcon('default');
        stopKeepAlive();
    }
}

// ============================================
// STOP CAST (WebRTC mode)
// ============================================

async function stopCast() {
    if (hdmiMode) { await stopHdmiMode(); return; }

    // Exit fullscreen on the source tab if it's still in capture fullscreen
    if (castingTabId) {
        chrome.tabs.sendMessage(castingTabId, { action: 'exitFullscreenAfterCapture' }, () => {});
    }

    connectionState = 'idle';
    castingTabId    = null;
    castingCode     = null;
    updateIcon('default');
    stopVideoStatePush();
    stopKeepAlive();
    broadcastStatus({ connectionState, status: 'Disconnected', hdmiMode: false });

    try {
        const existing = await chrome.offscreen.hasDocument().catch(() => false);
        if (existing) {
            await chrome.runtime.sendMessage({ action: 'offscreen_stop' }).catch(() => {});
            await chrome.offscreen.closeDocument();
        }
    } catch (e) {
        console.warn('stopCast offscreen cleanup:', e);
    }
}

// ============================================
// RTC STATE CHANGES (from offscreen)
// ============================================

let videoStatePollTimer = null;

function startVideoStatePush() {
    clearInterval(videoStatePollTimer);
    videoStatePollTimer = setInterval(() => {
        if (!castingTabId || connectionState !== 'streaming') {
            clearInterval(videoStatePollTimer);
            return;
        }
        chrome.tabs.sendMessage(castingTabId, { action: 'getVideoState' }, (response) => {
            if (chrome.runtime.lastError || !response) return;
            chrome.tabs.get(castingTabId, (tab) => {
                chrome.runtime.sendMessage({
                    action: 'offscreen_sendData',
                    data: {
                        type:        'videoState',
                        currentTime: response.currentTime || 0,
                        duration:    response.duration    || 0,
                        paused:      response.paused      || false,
                        title:       tab?.title           || '',
                    }
                }).catch(() => {});
            });
        });
    }, 1000);
}

function stopVideoStatePush() {
    clearInterval(videoStatePollTimer);
    videoStatePollTimer = null;
}

function handleRtcStateChange(state) {
    console.log('RTC state from offscreen:', state);

    if (state === 'connected') {
        _reconnectAttempt = 0;
        connectionState = 'streaming';
        updateIcon('casting');

        // ── Exit fullscreen now that the TV is showing the stream ──
        // The source tab no longer needs to be fullscreen — the capture
        // stream is already established. User can browse normally.
        if (castingTabId) {
            chrome.tabs.sendMessage(castingTabId, { action: 'exitFullscreenAfterCapture' }, () => {});
        }

        if (castingTabId) {
            chrome.tabs.get(castingTabId, (tab) => {
                chrome.runtime.sendMessage({
                    action: 'offscreen_sendData',
                    data: { type: 'metadata', title: tab?.title || 'DirectCast' }
                }).catch(() => {});
            });
        }
        startVideoStatePush();
        broadcastStatus({ connectionState, status: '🎬 Streaming to TV', hdmiMode: false });
    }

    if (state === 'disconnected' || state === 'failed') {
        connectionState = 'disconnected';
        stopVideoStatePush();
        updateIcon('default');

        // Clean up fullscreen on disconnect too
        if (castingTabId) {
            chrome.tabs.sendMessage(castingTabId, { action: 'exitFullscreenAfterCapture' }, () => {});
        }

        const savedCode   = castingCode;
        const savedTabId  = castingTabId;

        if (savedCode && savedTabId && _reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
            _reconnectAttempt++;
            const delay = Math.pow(2, _reconnectAttempt - 1) * 1000;
            console.log(`[bg] RTC disconnected — reconnect attempt ${_reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
            broadcastStatus({
                connectionState: 'connecting',
                status: `📡 Reconnecting… (${_reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`,
                hdmiMode: false
            });
            clearTimeout(_reconnectTimer);
            _reconnectTimer = setTimeout(async () => {
                await stopCast();
                await startCast(savedCode, savedTabId);
            }, delay);
        } else {
            stopKeepAlive();
            broadcastStatus({ connectionState, status: '📵 Disconnected', hdmiMode: false });
        }
    }
}

// ============================================
// COMMANDS FROM RECEIVER (via data channel)
// ============================================

async function handleReceiverCommand(msg) {
    if (!castingTabId) return;

    switch (msg.type) {
        case 'togglePlayPause':
            chrome.tabs.sendMessage(castingTabId, { action: 'togglePlayPause' });
            break;
        case 'seekRelative':
            chrome.tabs.sendMessage(castingTabId, { action: 'seek', seconds: msg.seconds });
            break;
        case 'volumeUp':
            chrome.tabs.sendMessage(castingTabId, { action: 'getVideoState' }, (r) => {
                if (!r) return;
                chrome.tabs.sendMessage(castingTabId, { action: 'setVolume', volume: Math.min(1, r.volume + 0.1) });
            });
            break;
        case 'volumeDown':
            chrome.tabs.sendMessage(castingTabId, { action: 'getVideoState' }, (r) => {
                if (!r) return;
                chrome.tabs.sendMessage(castingTabId, { action: 'setVolume', volume: Math.max(0, r.volume - 0.1) });
            });
            break;
        case 'bufferEmergency':
            console.warn('[bg] Receiver reports buffer emergency:', msg.delayMs + 'ms');
            break;
    }
}

// ============================================
// COMMANDS FROM POPUP BUTTONS
// ============================================

async function handleRemoteCommand(command) {
    if (!castingTabId) return;

    chrome.tabs.sendMessage(castingTabId, command);

    const map = {
        togglePlayPause: { type: 'togglePlayPause' },
        seek:            { type: 'seekRelative', seconds: command.seconds },
        seekTo:          { type: 'seek', time: command.time },
        setVolume:       { type: 'volume', volume: command.volume },
    };
    const receiverMsg = map[command.action];
    if (receiverMsg && !hdmiMode) {
        chrome.runtime.sendMessage({ action: 'offscreen_sendData', data: receiverMsg }).catch(() => {});
    }
}

// ============================================
// ICON
// ============================================

function updateIcon(state) {
    if (state === 'casting') {
        chrome.action.setTitle({ title: 'DirectCast - Casting…' });
        chrome.action.setBadgeText({ text: '●' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    } else if (state === 'capturing') {
        chrome.action.setTitle({ title: 'DirectCast - Connecting…' });
        chrome.action.setBadgeText({ text: '…' });
        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    } else {
        chrome.action.setTitle({ title: 'DirectCast - Cast to TV' });
        chrome.action.setBadgeText({ text: '' });
    }
}

// ============================================
// INIT
// ============================================

chrome.runtime.onInstalled.addListener(() => {
    console.log('DirectCast installed');
    chrome.storage.local.get(['settings'], (storage) => {
        if (!storage.settings) {
            chrome.storage.local.set({ settings: { autoDetect: true, quality: '1080p' } });
        }
    });
    getDisplays().catch(() => {});
});

getDisplays().catch(() => {});
setInterval(() => getDisplays().catch(() => {}), 5000);
warmUpGpuDetection().catch(() => {});

console.log('DirectCast background service worker ready');