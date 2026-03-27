const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Get local LAN IP ──────────────────────────────────────────────────────────
function getLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const LOCAL_IP = getLocalIp();
const PORT = process.env.PORT || 3000;

// ── HTTP server — serves receiver.html ────────────────────────────────────────
const server = http.createServer((req, res) => {
    const filePath = path.join(__dirname, 'receiver.html');
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
});

// ── WebSocket signaling ───────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

// rooms[token] = { receiver: ws, caster: ws }
const rooms = {};

wss.on('connection', (ws, req) => {
    let token = null;
    let role = null;

    // Detect the real client IP (works behind proxies too)
    const clientIp =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress ||
        'unknown';

    console.log(`New connection from ${clientIp}`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); }
        catch (e) { console.error('Invalid JSON:', raw); return; }

        switch (msg.type) {

            // ── Receiver registers ──────────────────────────────────────────
            case 'register': {
                // Use server-detected IP as the room token
                token = LOCAL_IP;
                role = 'receiver';

                if (!rooms[token]) rooms[token] = {};
                rooms[token].receiver = ws;

                console.log(`Receiver registered — room: ${token}`);

                // Send back the server's LAN IP so receiver can display it
                ws.send(JSON.stringify({ type: 'registered', ip: LOCAL_IP }));
                break;
            }

            // ── Caster joins ────────────────────────────────────────────────
            case 'join': {
                token = msg.ip;
                role = 'caster';

                if (!rooms[token]?.receiver) {
                    ws.send(JSON.stringify({ type: 'error', message: 'No receiver found at that IP' }));
                    return;
                }

                rooms[token].caster = ws;
                console.log(`Caster joined room: ${token}`);

                const receiver = rooms[token]?.receiver;
                if (receiver?.readyState === WebSocket.OPEN) {
                    receiver.send(JSON.stringify({ type: 'caster_joined' }));
                }

                ws.send(JSON.stringify({ type: 'joined', ip: token }));
                break;
            }

            // ── WebRTC signaling relay ──────────────────────────────────────
            case 'offer':
            case 'answer':
            case 'ice': {
                if (!token || !rooms[token]) return;
                const target = role === 'caster'
                    ? rooms[token].receiver
                    : rooms[token].caster;
                if (target?.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg));
                break;
            }

            // ── Remote control relay → receiver ────────────────────────────
            case 'play':
            case 'pause':
            case 'seek':
            case 'seekRelative':
            case 'volume':
            case 'metadata': {
                if (!token || !rooms[token]) return;
                const receiver = rooms[token]?.receiver;
                if (receiver?.readyState === WebSocket.OPEN) receiver.send(JSON.stringify(msg));
                break;
            }
        }
    });

    ws.on('close', () => {
        if (!token || !rooms[token]) return;
        console.log(`${role} disconnected from room ${token}`);

        if (role === 'receiver') {
            const caster = rooms[token]?.caster;
            if (caster?.readyState === WebSocket.OPEN)
                caster.send(JSON.stringify({ type: 'receiver_disconnected' }));
            delete rooms[token];
        } else if (role === 'caster') {
            const receiver = rooms[token]?.receiver;
            if (receiver?.readyState === WebSocket.OPEN)
                receiver.send(JSON.stringify({ type: 'caster_disconnected' }));
            delete rooms[token].caster;
        }
    });

    ws.on('error', (err) => console.error('WS error:', err));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ╔════════════════════════════════════╗');
    console.log(`  ║   CastFlow running on port ${PORT}    ║`);
    console.log('  ╠════════════════════════════════════╣');
    console.log(`  ║   Open receiver on your TV/PC:     ║`);
    console.log(`  ║   http://${LOCAL_IP}:${PORT}         ║`);
    console.log(`  ║                                    ║`);
    console.log(`  ║   Point extension at:              ║`);
    console.log(`  ║   ${LOCAL_IP}                      ║`);
    console.log('  ╚════════════════════════════════════╝');
    console.log('');
});
