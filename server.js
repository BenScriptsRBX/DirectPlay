const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Local IP detection ────────────────────────────────────────────────────────
// Prefers Ethernet interfaces (eth*, en*, eno*, enp*) over Wi-Fi so that when
// a direct cable is plugged in, the crossover/link-local address is shown first.
function getLocalIps() {
    const ifaces = os.networkInterfaces();
    const results = { ethernet: [], wifi: [], other: [] };

    for (const [name, addrs] of Object.entries(ifaces)) {
        for (const iface of addrs) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            const isEth = /^(eth|en[op]|eno|ethernet)/i.test(name);
            const isWifi = /^(wlan|wi|wlp|wireless)/i.test(name);
            if (isEth)        results.ethernet.push({ name, address: iface.address });
            else if (isWifi)  results.wifi.push({ name, address: iface.address });
            else              results.other.push({ name, address: iface.address });
        }
    }

    return results;
}

function getPrimaryIp() {
    const ips = getLocalIps();
    // Prefer Ethernet, then link-local on any interface, then Wi-Fi, then anything
    const all = [...ips.ethernet, ...ips.wifi, ...ips.other];
    if (all.length === 0) return '127.0.0.1';

    // Prefer non-link-local first (static / DHCP addresses are more reliable)
    const nonLinkLocal = all.filter(i => !i.address.startsWith('169.254.'));
    if (nonLinkLocal.length > 0) return nonLinkLocal[0].address;

    // Fall back to link-local (auto-assigned when cable is plugged in directly)
    return all[0].address;
}

const PORT     = process.env.PORT || 3000;
const LOCAL_IP = getPrimaryIp();

// ── HTML ──────────────────────────────────────────────────────────────────────
// Injects the server's own IP into the receiver page so the user knows
// what to type into the DirectCast extension on the PC side.
function buildHtml(localIp, port) {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

    // Inject IP banner just before </body>
    const banner = `
<div id="ipBanner" style="
    position:fixed;bottom:0;left:0;right:0;
    background:rgba(0,0,0,0.85);
    backdrop-filter:blur(12px);
    border-top:1px solid rgba(255,255,255,0.08);
    padding:14px 32px;
    display:flex;align-items:center;justify-content:space-between;
    z-index:200;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
">
  <div style="display:flex;align-items:center;gap:16px;">
    <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4);">
      This TV's IP
    </span>
    <span id="ipDisplay" style="
        font-family:'Courier New',monospace;
        font-size:22px;font-weight:500;
        color:#ffffff;letter-spacing:2px;
    ">${localIp}</span>
  </div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;">
    <span style="font-size:11px;color:rgba(255,255,255,0.4);">
      Enter this in DirectCast on your PC
    </span>
    <span style="font-size:11px;color:rgba(255,255,255,0.25);">
      Port ${port} · Direct Ethernet
    </span>
  </div>
</div>`;

    html = html.replace('</body>', banner + '\n</body>');
    return html;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ── /ping — used by the extension to check reachability before casting ──
    if (url.pathname === '/ping') {
        res.writeHead(200, {
            'Content-Type':  'text/plain',
            'Access-Control-Allow-Origin': '*',
        });
        res.end('pong');
        return;
    }

    // ── /api/signal — HTTP-based WebRTC signalling (replaces Vercel in Ethernet mode) ──
    if (url.pathname === '/api/signal') {
        handleSignal(req, res, url);
        return;
    }

    // ── / — serve the receiver page ──
    try {
        const html = buildHtml(LOCAL_IP, PORT);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    } catch (err) {
        res.writeHead(500);
        res.end('Could not load index.html: ' + err.message);
    }
});

// ── In-memory signal store ────────────────────────────────────────────────────
// Same structure as the Vercel handler so the extension's existing fetch()
// calls work unchanged — just pointed at this server instead.
const _rooms = {};

function getRoom(code) {
    if (!_rooms[code]) _rooms[code] = { ts: Date.now(), ice_caster: [], ice_receiver: [] };
    return _rooms[code];
}

// Clean rooms older than 5 minutes
setInterval(() => {
    const cutoff = Date.now() - 300_000;
    for (const code of Object.keys(_rooms)) {
        if (_rooms[code].ts < cutoff) delete _rooms[code];
    }
}, 60_000);

function handleSignal(req, res, url) {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, headers); res.end('{}'); return;
    }

    const code   = url.searchParams.get('code')?.toUpperCase();
    const action = url.searchParams.get('action');
    const role   = url.searchParams.get('role');

    if (!code) {
        res.writeHead(400, headers); res.end(JSON.stringify({ error: 'Missing code' })); return;
    }

    if (req.method === 'GET') {
        const room = _rooms[code] || {};

        if (role === 'receiver') {
            // Receiver polls for the caster's offer
            res.writeHead(200, headers);
            res.end(JSON.stringify(
                room.offer
                    ? { offer: room.offer, ice_caster: room.ice_caster || [] }
                    : {}
            ));
        } else if (role === 'caster') {
            // Caster polls for the receiver's answer
            res.writeHead(200, headers);
            res.end(JSON.stringify(
                room.answer
                    ? { answer: room.answer, ice_receiver: room.ice_receiver || [] }
                    : {}
            ));
        } else {
            res.writeHead(400, headers);
            res.end(JSON.stringify({ error: 'Invalid role' }));
        }
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let data = {};
            try { data = JSON.parse(body); } catch (_) {}

            const room = getRoom(code);

            if (action === 'offer') {
                room.offer      = data.offer;
                room.ice_caster = data.ice || [];
                room.ts         = Date.now();
                res.writeHead(200, headers);
                res.end(JSON.stringify({ ok: true }));

            } else if (action === 'answer') {
                room.answer       = data.answer;
                room.ice_receiver = data.ice || [];
                res.writeHead(200, headers);
                res.end(JSON.stringify({ ok: true }));

            } else if (action === 'clear') {
                delete _rooms[code];
                res.writeHead(200, headers);
                res.end(JSON.stringify({ ok: true }));

            } else {
                res.writeHead(400, headers);
                res.end(JSON.stringify({ error: 'Unknown action' }));
            }
        });
        return;
    }

    res.writeHead(405, headers);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

// ── WebSocket (unchanged — used by original relay logic if present) ───────────
const wss = new WebSocket.Server({ server });
const rooms = {};

function wsGetRoom(code) {
    if (!rooms[code]) rooms[code] = { caster: null, receiver: null };
    return rooms[code];
}

function relay(target, data, isBinary) {
    if (target?.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
}

wss.on('connection', (ws, req) => {
    const url  = new URL(req.url, `http://${req.headers.host}`);
    const code = url.searchParams.get('code')?.toUpperCase();
    const role = url.searchParams.get('role');

    if (!code || !role) { ws.close(1008, 'Missing code or role'); return; }

    const room = wsGetRoom(code);

    if (role === 'caster') {
        if (room.caster && room.caster !== ws) room.caster.close(1001, 'Replaced');
        room.caster = ws;
        relay(room.receiver, JSON.stringify({ type: 'caster_connected' }), false);
    } else if (role === 'receiver') {
        if (room.receiver && room.receiver !== ws) room.receiver.close(1001, 'Replaced');
        room.receiver = ws;
        relay(room.caster, JSON.stringify({ type: 'receiver_ready' }), false);
        ws.send(JSON.stringify({ type: 'receiver_ready' }));
    }

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            relay(role === 'caster' ? room.receiver : room.caster, data, true);
        } else {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }
            if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
            relay(role === 'caster' ? room.receiver : room.caster, data, false);
        }
    });

    ws.on('close', () => {
        if (role === 'caster')   { room.caster   = null; relay(room.receiver, JSON.stringify({ type: 'caster_disconnected' }),   false); }
        else                     { room.receiver  = null; relay(room.caster,   JSON.stringify({ type: 'receiver_disconnected' }), false); }
        if (!room.caster && !room.receiver) delete rooms[code];
    });

    ws.on('error', (err) => console.error(`[${code}] WS error:`, err));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    const allIps = getLocalIps();
    const ethList  = allIps.ethernet.map(i => `${i.name}: ${i.address}`).join(', ') || 'none detected';
    const wifiList = allIps.wifi.map(i => `${i.name}: ${i.address}`).join(', ')     || 'none detected';

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log(`  ║   DirectCast receiver  ·  port ${PORT}            ║`);
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log(`  ║   Primary IP  :  ${LOCAL_IP.padEnd(28)}║`);
    console.log(`  ║   Ethernet    :  ${ethList.substring(0, 28).padEnd(28)}║`);
    console.log(`  ║   Wi-Fi       :  ${wifiList.substring(0, 28).padEnd(28)}║`);
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log(`  ║   Open on TV  :  http://${LOCAL_IP}:${PORT}`.padEnd(49) + '║');
    console.log(`  ║   Then enter  :  ${LOCAL_IP} in DirectCast`.padEnd(49) + '║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
});
