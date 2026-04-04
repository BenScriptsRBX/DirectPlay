// ============================================
// DirectCast - Offscreen Document
// Latency-first WebRTC — raw RTP track to receiver srcObject.
// GPU-accelerated encoding via SDP codec preference + RTCRtpSender params.
// ============================================

// SIGNAL is set dynamically by background.js before each cast.
// background.js overrides this variable via a message when using a LAN TV.
// Default: cloud signalling server.
let SIGNAL = 'https://direct-play-iota.vercel.app/api/signal';

let pc            = null;
let dc            = null;
let captureStream = null;
let pollTimer     = null;
let bitrateTimer  = null;
let qualityTimer  = null;

let gpuCapability = null;

// Track last known good stats for recovery decisions
const encodeStats = {
    lastBitrate:      0,
    lastFramerate:    0,
    recoveryAttempts: 0,
};

// FIX: Recovery lock prevents the quality monitor and bitrate enforcer
// from issuing simultaneous setParameters() calls, which stall the encoder.
let _recoveryLock = false;

// ============================================
// GPU DETECTION
// ============================================

async function detectGpuCapability() {
    if (gpuCapability) return gpuCapability;

    const result = { hasGpu: false, preferredCodec: 'vp8', hardwareAccelerated: false };

    if (typeof VideoEncoder === 'undefined') {
        console.log('[offscreen] WebCodecs not available — using VP8 software');
        gpuCapability = result;
        return result;
    }

    const probes = [
        {
            codec: 'avc1.640034',
            label: 'h264',
            config: {
                codec:                'avc1.640034',
                width:                1920,
                height:               1080,
                framerate:            60,
                bitrate:              10_000_000,
                latencyMode:          'realtime',
                hardwareAcceleration: 'prefer-hardware'
            }
        },
        {
            codec: 'vp09.00.41.08',
            label: 'vp9',
            config: {
                codec:                'vp09.00.41.08',
                width:                1920,
                height:               1080,
                framerate:            60,
                bitrate:              10_000_000,
                latencyMode:          'realtime',
                hardwareAcceleration: 'prefer-hardware'
            }
        }
    ];

    for (const probe of probes) {
        try {
            const support = await VideoEncoder.isConfigSupported(probe.config);
            if (support.supported) {
                const isHw = support.config?.hardwareAcceleration === 'prefer-hardware'
                    || support.config?.hardwareAcceleration === 'no-preference';
                console.log(`[offscreen] GPU probe: ${probe.label} supported, hw=${isHw}`);
                result.hasGpu              = isHw;
                result.hardwareAccelerated = isHw;
                result.preferredCodec      = probe.label;
                gpuCapability = result;
                return result;
            }
        } catch (e) {
            console.warn(`[offscreen] GPU probe failed for ${probe.label}:`, e.message);
        }
    }

    console.log('[offscreen] No GPU codec found — using VP8 software');
    gpuCapability = result;
    return result;
}

// ============================================
// MESSAGE BUS
// ============================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        try {
            switch (request.action) {
                case 'offscreen_setSignal':
                    SIGNAL = request.signalUrl || SIGNAL;
                    sendResponse({ ok: true });
                    break;
                case 'offscreen_startWebRTC':
                    await startWebRTC(request.streamId, request.code, request.gpuCapability);
                    sendResponse({ success: true });
                    break;
                case 'offscreen_stop':
                    cleanup();
                    sendResponse({ success: true });
                    break;
                case 'offscreen_ping':
                    sendResponse({ alive: true, connected: pc?.connectionState === 'connected' });
                    break;
                case 'offscreen_sendData':
                    sendToReceiver(request.data);
                    sendResponse({ success: true });
                    break;
                case 'offscreen_getGpu':
                    sendResponse(await detectGpuCapability());
                    break;
                default:
                    sendResponse({ ignored: true });
                    break;
            }
        } catch (err) {
            console.error('[offscreen] error:', err);
            sendResponse({ error: err.message });
        }
    })();
    return true;
});

// ============================================
// START WEBRTC
// ============================================

async function startWebRTC(streamId, code, bgGpuHint) {
    cleanup();

    const gpu = bgGpuHint || await detectGpuCapability();
    console.log('[offscreen] GPU capability:', gpu);

    captureStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource:   'tab',
                chromeMediaSourceId: streamId,
                echoCancellation:    false,
                noiseSuppression:    false,
                autoGainControl:     false
            }
        },
        video: {
            mandatory: {
                chromeMediaSource:   'tab',
                chromeMediaSourceId: streamId,
                minWidth:    1280,
                minHeight:    720,
                maxWidth:    1920,
                maxHeight:   1080,
                // FIX: minFrameRate raised from 30 → 60. Telling Chrome's capture
                // pipeline we need 60fps from the start prevents it from
                // negotiating down to 30fps before the encoder even starts.
                minFrameRate:  60,
                maxFrameRate:  60
            }
        }
    });

    pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 4,
        bundlePolicy:  'max-bundle',
        rtcpMuxPolicy: 'require'
    });

    pc._gpu = gpu;

    dc = pc.createDataChannel('control', { ordered: true });
    dc.onopen    = () => console.log('[offscreen] dc open');
    dc.onclose   = () => console.log('[offscreen] dc closed');
    dc.onerror   = (e) => console.error('[offscreen] dc error', e);
    dc.onmessage = (ev) => {
        try {
            chrome.runtime.sendMessage({ action: 'receiverCommand', command: JSON.parse(ev.data) });
        } catch (err) { console.error('[offscreen] dc parse error', err); }
    };

    captureStream.getTracks().forEach(track => {
        pc.addTrack(track, captureStream);

        if (track.kind === 'video') {
            // FIX: Use frameRate: { exact: 60 } instead of ideal/min to prevent
            // Chrome silently negotiating a lower rate. Falls back to ideal on failure.
            track.applyConstraints({
                width:     { ideal: 1920, min: 1280 },
                height:    { ideal: 1080, min: 720  },
                frameRate: { exact: 60 },
            }).catch(e => {
                // FIX: retry once with relaxed constraint (display may cap at 30/50Hz)
                console.warn('[offscreen] exact 60fps unavailable, retrying with ideal:', e);
                track.applyConstraints({
                    width:     { ideal: 1920, min: 1280 },
                    height:    { ideal: 1080, min: 720  },
                    frameRate: { ideal: 60, min: 30 },
                }).catch(e2 => console.error('[offscreen] applyConstraints retry failed:', e2));
            });
        }
    });

    pc.onconnectionstatechange = () => {
        const state = pc?.connectionState;
        console.log('[offscreen] pc state:', state);
        chrome.runtime.sendMessage({ action: 'rtcStateChange', state });

        if (state === 'connected') {
            applyEncodingParams();
            startBitrateEnforcer();
            startQualityMonitor();
        }
        if (state === 'disconnected' || state === 'failed') {
            cleanup();
        }
    };

    const offer = await pc.createOffer({
        offerToReceiveAudio:    false,
        offerToReceiveVideo:    false,
        voiceActivityDetection: false
    });

    let sdp = offer.sdp;
    sdp = reorderCodecs(sdp, gpu);
    sdp = setHighBitrateSDP(sdp, gpu);
    sdp = setLowLatencyFlags(sdp, gpu);

    await pc.setLocalDescription({ type: 'offer', sdp });

    // FIX: ICE gather timeout raised 800ms → 1500ms. STUN server-reflexive
    // candidates typically resolve in 400-900ms on home WiFi. Cutting off at
    // 800ms frequently misses them, forcing a host-only path with less available
    // bandwidth — the single biggest cause of sustained quality drops.
    await waitForICE(1500);

    const gatheredCandidates = [];
    (pc.localDescription?.sdp || '').split('\r\n')
        .filter(l => l.startsWith('a=candidate:'))
        .forEach(line => {
            gatheredCandidates.push({
                candidate:     line.replace(/^a=/, ''),
                sdpMid:        '0',
                sdpMLineIndex: 0
            });
        });

    await fetch(`${SIGNAL}?code=${code}&action=offer`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ offer: pc.localDescription.sdp, ice: gatheredCandidates })
    });

    pollForAnswer(code);
}

// ============================================
// ANSWER POLLING
// ============================================

async function pollForAnswer(code) {
    try {
        const res  = await fetch(`${SIGNAL}?code=${code}&role=caster`);
        const data = await res.json();

        if (data.answer && pc) {
            await pc.setRemoteDescription({ type: 'answer', sdp: data.answer });

            for (const c of (data.ice_receiver || [])) {
                await pc.addIceCandidate(c).catch(() => {});
            }

            applyEncodingParams();
            return;
        }
    } catch (e) {
        console.warn('[offscreen] poll error:', e);
    }

    pollTimer = setTimeout(() => pollForAnswer(code), 1500);
}

// ============================================
// ENCODING PARAMS
// ============================================

function applyEncodingParams() {
    if (!pc) return;
    const gpu = pc._gpu || { hasGpu: false };

    pc.getSenders().forEach(sender => {
        const kind = sender.track?.kind;
        if (!kind) return;

        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        const enc = params.encodings[0];

        if (kind === 'video') {
            enc.maxBitrate      = gpu.hasGpu ? 15_000_000 : 10_000_000;
            enc.maxFramerate    = 60;
            enc.networkPriority = 'high';
            enc.priority        = 'high';

            // FIX: 'maintain-framerate' replaces 'maintain-resolution'.
            // At 60fps, 'maintain-resolution' causes encoder queue buildup
            // under any congestion → periodic keyframe storms → visible
            // pixelation bursts every few seconds. 'maintain-framerate'
            // lets Chrome drop to e.g. 1600×900 briefly — which is nearly
            // invisible — rather than stuffing the encoder queue.
            enc.degradationPreference = 'maintain-framerate';

            if (gpu.hasGpu) {
                enc.scalabilityMode = 'L1T1';
            }
        }

        if (kind === 'audio') {
            enc.maxBitrate  = 320_000;
            enc.priority    = 'high';
        }

        sender.setParameters(params).catch(e =>
            console.warn('[offscreen] setParameters:', e)
        );
    });
}

// ============================================
// BITRATE ENFORCER
// FIX: Interval increased 2s → 5s to stop fighting the quality monitor.
// The previous 2s cadence was issuing setParameters() calls overlapping
// with the 1s quality monitor, causing encoder pipeline stalls every
// ~1s. Quality monitor handles urgent recovery; this handles routine top-ups.
// ============================================

function startBitrateEnforcer() {
    clearInterval(bitrateTimer);
    bitrateTimer = setInterval(() => {
        if (!pc || pc.connectionState !== 'connected') {
            clearInterval(bitrateTimer);
            return;
        }
        if (!_recoveryLock) applyEncodingParams();
    }, 5000);
}

// ============================================
// QUALITY MONITOR
// ============================================

function startQualityMonitor() {
    clearInterval(qualityTimer);

    const gpu       = pc?._gpu || { hasGpu: false };
    const targetBps = gpu.hasGpu ? 15_000_000 : 10_000_000;

    let prevBytesSent = 0;
    let prevTimestamp = 0;
    let prevDropped   = 0;

    qualityTimer = setInterval(async () => {
        if (!pc || pc.connectionState !== 'connected') {
            clearInterval(qualityTimer);
            return;
        }

        try {
            const stats = await pc.getStats();
            for (const r of stats.values()) {
                if (r.type !== 'outbound-rtp' || r.kind !== 'video') continue;

                const now       = r.timestamp;
                const bytesSent = r.bytesSent    || 0;
                const dropped   = r.framesDropped || 0;

                if (prevTimestamp > 0) {
                    const dtSec      = (now - prevTimestamp) / 1000;
                    const bps        = ((bytesSent - prevBytesSent) * 8) / dtSec;
                    const newDropped = dropped - prevDropped;
                    const ratio      = bps / targetBps;

                    // FIX: threshold raised 0.55 → 0.75. At 55% you've already
                    // had ~800ms of encoder starvation. At 75% we catch the dip
                    // early, before it's visible, and nudge GCC back up.
                    const bitrateTooLow  = ratio < 0.75;
                    // FIX: dropped frame threshold lowered 3 → 2. At 60fps,
                    // dropping 2 frames is already a visible 33ms stutter.
                    const droppingFrames = newDropped > 2;

                    if ((bitrateTooLow || droppingFrames) && !_recoveryLock) {
                        _recoveryLock = true;
                        encodeStats.recoveryAttempts++;
                        console.warn(
                            `[offscreen] Quality drop (${(bps/1e6).toFixed(1)}Mbps / ` +
                            `${(targetBps/1e6).toFixed(0)}Mbps target, ${newDropped} dropped) — recovering`
                        );
                        applyEncodingParams();
                        requestKeyframe();
                        // FIX: 2s lock prevents recovery spam while GCC adjusts
                        setTimeout(() => { _recoveryLock = false; }, 2000);
                    }
                }

                prevBytesSent = bytesSent;
                prevTimestamp = now;
                prevDropped   = dropped;
                break;
            }
        } catch (_) {
            // getStats() throws if the PC is closing — ignore
        }
    }, 1000);
}

// ============================================
// KEYFRAME REQUEST
// FIX: Removed the setParameters() fallback entirely. Using setParameters
// as a keyframe trigger forces an encoder pipeline flush → ~150-200ms
// visible freeze. If generateKeyFrame() isn't available (Chrome < 108),
// it's better to wait for the next natural keyframe interval than to
// induce a hard stall that's more disruptive than the original drop.
// ============================================

function requestKeyframe() {
    if (!pc) return;
    pc.getSenders().forEach(sender => {
        if (sender.track?.kind !== 'video') return;
        if (typeof sender.generateKeyFrame === 'function') {
            sender.generateKeyFrame().catch(() => {});
        }
    });
}

// ============================================
// SEND TO RECEIVER
// ============================================

function sendToReceiver(data) {
    if (dc?.readyState === 'open') {
        dc.send(JSON.stringify(data));
    }
}

// ============================================
// SDP TRANSFORMS
// ============================================

function reorderCodecs(sdp, gpu) {
    const lines = sdp.split('\r\n');

    let h264Pt = null;
    let vp8Pt  = null;
    let vp9Pt  = null;

    for (const line of lines) {
        let m;
        if ((m = line.match(/^a=rtpmap:(\d+) H264\/90000/i)))  h264Pt = m[1];
        if ((m = line.match(/^a=rtpmap:(\d+) VP8\/90000/i)))   vp8Pt  = m[1];
        if ((m = line.match(/^a=rtpmap:(\d+) VP9\/90000/i)))   vp9Pt  = m[1];
    }

    let priority = [];
    if (gpu.hasGpu && gpu.preferredCodec === 'h264' && h264Pt) {
        priority = [h264Pt, vp9Pt, vp8Pt].filter(Boolean);
        console.log('[offscreen] SDP: H.264 hardware path selected');
    } else if (gpu.hasGpu && gpu.preferredCodec === 'vp9' && vp9Pt) {
        priority = [vp9Pt, h264Pt, vp8Pt].filter(Boolean);
        console.log('[offscreen] SDP: VP9 hardware path selected');
    } else if (vp8Pt) {
        priority = [vp8Pt, vp9Pt, h264Pt].filter(Boolean);
        console.log('[offscreen] SDP: VP8 software path selected');
    }

    if (!priority.length) return sdp;

    return lines.map(line => {
        if (!line.startsWith('m=video')) return line;
        const parts  = line.split(' ');
        const prefix = parts.slice(0, 3);
        const codecs = parts.slice(3);
        const reordered = [
            ...priority,
            ...codecs.filter(c => !priority.includes(c))
        ];
        return [...prefix, ...reordered].join(' ');
    }).join('\r\n');
}

function setHighBitrateSDP(sdp, gpu) {
    const videoBwKbps = gpu.hasGpu ? 15000 : 10000;
    const videoBwBps  = videoBwKbps * 1000;

    sdp = sdp.replace(/b=AS:.*\r\n/g,   '');
    sdp = sdp.replace(/b=TIAS:.*\r\n/g, '');
    sdp = sdp.replace(
        /(m=video[^\r\n]*\r\n)/g,
        `$1b=AS:${videoBwKbps}\r\nb=TIAS:${videoBwBps}\r\n`
    );
    sdp = sdp.replace(/(m=audio[^\r\n]*\r\n)/g, '$1b=AS:320\r\n');
    return sdp;
}

function setLowLatencyFlags(sdp, gpu) {
    const lines = sdp.split('\r\n');

    let winningPt    = null;
    let winningCodec = 'vp8';

    for (const line of lines) {
        if (line.startsWith('m=video')) {
            const parts = line.split(' ');
            winningPt = parts[3] || null;
            break;
        }
    }

    if (!winningPt) return sdp;

    for (const line of lines) {
        if (line.match(new RegExp(`^a=rtpmap:${winningPt} H264`, 'i'))) {
            winningCodec = 'h264'; break;
        }
        if (line.match(new RegExp(`^a=rtpmap:${winningPt} VP9`, 'i'))) {
            winningCodec = 'vp9'; break;
        }
    }

    const stripped = lines.filter(line =>
        !line.match(new RegExp(`^a=fmtp:${winningPt} `))
    );

    // FIX: start-bitrate lowered to ~70% of max (was ~93% for VP8, ~80% for VP9/H264).
    // Starting too close to max causes GCC to detect immediate congestion, back off
    // hard, then ramp up slowly — you see 2-3s of pixelation on every new connection.
    // A lower start ramp avoids the GCC congestion reflex entirely.
    let fmtpLine = null;
    if (winningCodec === 'vp8') {
        fmtpLine = `a=fmtp:${winningPt} x-google-min-bitrate=4000;x-google-max-bitrate=10000;x-google-start-bitrate=7000`;
    } else if (winningCodec === 'vp9') {
        fmtpLine = `a=fmtp:${winningPt} x-google-min-bitrate=5000;x-google-max-bitrate=15000;x-google-start-bitrate=10000`;
    } else if (winningCodec === 'h264') {
        fmtpLine = `a=fmtp:${winningPt} profile-level-id=640034;packetization-mode=1;level-asymmetry-allowed=1;` +
                   `x-google-min-bitrate=5000;x-google-max-bitrate=15000;x-google-start-bitrate=10000`;
    }

    if (!fmtpLine) return stripped.join('\r\n');

    const out = [];
    for (const line of stripped) {
        out.push(line);
        if (line.match(new RegExp(`^a=rtpmap:${winningPt} `, 'i'))) {
            out.push(fmtpLine);
        }
    }
    return out.join('\r\n');
}

// ============================================
// ICE GATHERING
// ============================================

function waitForICE(timeoutMs = 1500) {
    return new Promise((resolve) => {
        if (!pc || pc.iceGatheringState === 'complete') { resolve(); return; }
        const check = () => {
            if (pc?.iceGatheringState === 'complete') {
                pc.removeEventListener('icegatheringstatechange', check);
                resolve();
            }
        };
        pc.addEventListener('icegatheringstatechange', check);
        setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', check);
            resolve();
        }, timeoutMs);
    });
}

// ============================================
// CLEANUP
// ============================================

function cleanup() {
    clearTimeout(pollTimer);
    clearInterval(bitrateTimer);
    clearInterval(qualityTimer);
    _recoveryLock = false;
    if (captureStream) { captureStream.getTracks().forEach(t => t.stop()); captureStream = null; }
    if (pc)            { pc.close(); pc = null; }
    dc = null;
}

detectGpuCapability().then(cap => {
    console.log('[offscreen] GPU pre-detection complete:', cap);
});

console.log('[offscreen] DirectCast offscreen document ready');