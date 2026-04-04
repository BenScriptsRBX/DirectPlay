// ============================================
// DirectCast - Popup
// Thin UI layer — all connection logic lives in background.js
// ============================================

let pollInterval = null;
let isSeeking    = false;
let currentState = 'idle';
let isHdmiMode   = false;

document.addEventListener('DOMContentLoaded', async () => {
    loadSavedCode();
    setupEventListeners();
    await syncStateFromBackground();
    await detectMediaOnPage();
    startPolling();
});

// ============================================
// SYNC STATE FROM BACKGROUND ON OPEN
// ============================================

async function syncStateFromBackground() {
    const response = await bgMessage({ action: 'getState' });
    if (!response) return;

    currentState = response.connectionState;
    isHdmiMode   = response.hdmiMode || false;

    if (isHdmiMode) {
        setConnectBtn(true, false);
        setStatus('🖥 HDMI mode active');
        return;
    }

    if (currentState === 'streaming' || currentState === 'connecting' || currentState === 'capturing') {
        setConnectBtn(true, true);
        const statusMap = {
            streaming:  '🎬 Streaming to TV',
            connecting: 'Connecting…',
            capturing:  'Capturing tab…'
        };
        setStatus(statusMap[currentState] || '');
        if (response.castingCode) {
            document.getElementById('peerCodeInput').value = response.castingCode;
        }
    } else {
        setConnectBtn(true, false);
    }
}

// Push updates from background while popup is open
chrome.runtime.onMessage.addListener((request) => {
    if (request.action !== 'castStatus') return;

    currentState = request.connectionState;
    isHdmiMode   = request.hdmiMode || false;
    setStatus(request.status || '');

    if (currentState === 'streaming') {
        setConnectBtn(true, true);
    } else if (currentState === 'idle' || currentState === 'disconnected') {
        setConnectBtn(true, false);
    }
});

// ============================================
// SAVED CODE
// ============================================

function loadSavedCode() {
    chrome.storage.local.get('lastCode', ({ lastCode }) => {
        if (lastCode) document.getElementById('peerCodeInput').value = lastCode;
    });
}

// ============================================
// MEDIA DETECTION
// ============================================

async function detectMediaOnPage() {
    let tab;
    try {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
        displayNoMedia();
        return;
    }

    if (!tab) { displayNoMedia(); return; }

    const MAX_ATTEMPTS = 8;
    const INTERVAL_MS  = 400;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const found = await tryDetect(tab.id);
        if (found) return;
        if (i < MAX_ATTEMPTS - 1) await sleep(INTERVAL_MS);
    }

    displayNoMedia();
}

function tryDetect(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'getDetectedMedia' }, (response) => {
            if (chrome.runtime.lastError || !response?.media?.length) {
                resolve(false);
                return;
            }
            displayMedia(response.media[0]);
            resolve(true);
        });
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function displayMedia(media) {
    const thumb = media.thumbnail
        ? `<img src="${media.thumbnail}" class="detected-thumbnail" onerror="this.style.background='linear-gradient(135deg,#6366f1,#8b5cf6)'">`
        : `<div class="detected-thumbnail" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;">
               <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                   <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
               </svg>
           </div>`;

    document.getElementById('mediaPreview').innerHTML = `
        <div class="detected-media-item">
            ${thumb}
            <div class="detected-info">
                <h3>${media.title}</h3>
                <p>From: ${media.source}</p>
                ${media.duration ? `<p>Duration: ${formatTime(media.duration)}</p>` : ''}
            </div>
        </div>`;

    document.getElementById('controlsSection').style.display = 'block';

    if (currentState === 'idle' || currentState === 'disconnected') {
        setStatus('📺 Ready to cast');
    }
}

function displayNoMedia() {
    document.getElementById('mediaPreview').innerHTML = `
        <div class="empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
            </svg>
            <p>No video content detected</p>
            <small>Open a video on YouTube, Netflix, or any website</small>
        </div>`;
    document.getElementById('controlsSection').style.display = 'none';
}

// ============================================
// CONNECT / DISCONNECT (WebRTC mode)
// ============================================

async function connectToReceiver() {
    const code = document.getElementById('peerCodeInput').value.trim().toUpperCase();
    if (code.length !== 4) { setStatus('⚠ Enter the 4-letter code from your TV'); return; }

    chrome.storage.local.set({ lastCode: code });
    setConnectBtn(false);
    setStatus('Starting…');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await bgMessage({ action: 'startCast', code, tabId: tab.id });
}

async function disconnect() {
    setConnectBtn(false);
    await bgMessage({ action: 'stopCast' });
    setConnectBtn(true, false);
    setStatus('Disconnected');
}

// ============================================
// REMOTE CONTROLS
// ============================================

function setupControls() {
    document.getElementById('playPauseBtn').addEventListener('click', () => {
        bgMessage({ action: 'remoteCommand', command: { action: 'togglePlayPause' } });
    });

    document.getElementById('backBtn').addEventListener('click', () => {
        bgMessage({ action: 'remoteCommand', command: { action: 'seek', seconds: -5 } });
    });

    document.getElementById('forwardBtn').addEventListener('click', () => {
        bgMessage({ action: 'remoteCommand', command: { action: 'seek', seconds: 5 } });
    });

    document.getElementById('seekBar').addEventListener('mousedown', () => { isSeeking = true; });
    document.getElementById('seekBar').addEventListener('mouseup', (e) => {
        isSeeking = false;
        bgMessage({ action: 'remoteCommand', command: { action: 'seekTo', time: parseFloat(e.target.value) } });
    });
    document.getElementById('seekBar').addEventListener('touchend', (e) => {
        isSeeking = false;
        bgMessage({ action: 'remoteCommand', command: { action: 'seekTo', time: parseFloat(e.target.value) } });
    });

    document.getElementById('volumeBar').addEventListener('input', (e) => {
        const vol = parseFloat(e.target.value) / 100;
        document.getElementById('volumeLabel').textContent = e.target.value + '%';
        bgMessage({ action: 'remoteCommand', command: { action: 'setVolume', volume: vol } });
    });
}

// ============================================
// POLL VIDEO STATE FOR UI UPDATE
// ============================================

function startPolling() {
    clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            chrome.tabs.sendMessage(tab.id, { action: 'getVideoState' }, (response) => {
                if (chrome.runtime.lastError || !response) return;
                const { currentTime, duration, paused, volume } = response;

                document.getElementById('playPauseBtn').textContent = paused ? '▶ Play' : '⏸ Pause';

                if (!isSeeking && duration) {
                    document.getElementById('seekBar').max   = duration;
                    document.getElementById('seekBar').value = currentTime;
                }

                document.getElementById('currentTimeLabel').textContent = formatTime(currentTime);
                document.getElementById('durationLabel').textContent    = formatTime(duration);

                const volPct = Math.round(volume * 100);
                document.getElementById('volumeBar').value         = volPct;
                document.getElementById('volumeLabel').textContent = volPct + '%';
            });
        } catch { clearInterval(pollInterval); }
    }, 1000);
}

window.addEventListener('unload', () => { clearInterval(pollInterval); });

// ============================================
// EVENT LISTENERS
// ============================================

function setupEventListeners() {
    setupControls();

    const btn = document.getElementById('connectBtn');
    if (btn) btn.onclick = connectToReceiver;

    document.getElementById('peerCodeInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') connectToReceiver();
    });

    document.getElementById('peerCodeInput').addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
    });

    document.getElementById('settingsBtn').addEventListener('click', () => {
        clearInterval(pollInterval);
        document.querySelectorAll('.content-section, #controlsSection').forEach(el => el.style.display = 'none');
        document.getElementById('settingsView').style.display = 'block';
        loadSettings();
    });

    document.getElementById('backBtn2').addEventListener('click', () => location.reload());
}

async function loadSettings() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    document.getElementById('autoDetect').checked = settings.autoDetect !== false;
    document.getElementById('quality').value       = settings.quality || '1080p';
    document.getElementById('autoDetect').addEventListener('change', saveSettings);
    document.getElementById('quality').addEventListener('change', saveSettings);
}

async function saveSettings() {
    await chrome.storage.local.set({
        settings: {
            autoDetect: document.getElementById('autoDetect').checked,
            quality:    document.getElementById('quality').value
        }
    });
}

// ============================================
// UI HELPERS
// ============================================

function setStatus(msg) {
    const el = document.getElementById('statusBar');
    if (el) el.textContent = msg;
}

function setConnectBtn(enabled, connected) {
    const btn = document.getElementById('connectBtn');
    if (!btn) return;
    btn.disabled = !enabled;

    if (connected === true) {
        btn.textContent      = '✕ Stop';
        btn.style.background = '#ef4444';
        btn.onclick          = disconnect;
    } else {
        btn.textContent      = '▶ Cast';
        btn.style.background = '';
        btn.onclick          = connectToReceiver;
    }
}

// ============================================
// HELPERS
// ============================================

function bgMessage(msg) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            resolve(response);
        });
    });
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m}:${s.toString().padStart(2,'0')}`;
}