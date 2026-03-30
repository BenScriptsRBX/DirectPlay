const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Local IP ──────────────────────────────────────────────────────────────────
function getLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

const LOCAL_IP = getLocalIp();
const PORT = process.env.PORT || 3000;

// ── HTTP ──────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

/**
 * rooms[code] = { caster: ws | null, receiver: ws | null }
 *
 * Binary frames (video chunks) are relayed straight through.
 * JSON frames are parsed for room management, then relayed if needed.
 */
const rooms = {};

function getRoom(code) {
    if (!rooms[code]) rooms[code] = { caster: null, receiver: null };
    return rooms[code];
}

function relay(target, data, isBinary) {
    if (target?.readyState === WebSocket.OPEN) {
        target.send(data, { binary: isBinary });
    }
}

wss.on('connection', (ws, req) => {
    const url    = new URL(req.url, `http://${req.headers.host}`);
    const code   = url.searchParams.get('code')?.toUpperCase();
    const role   = url.searchParams.get('role'); // 'caster' | 'receiver'

    if (!code || !role) {
        ws.close(1008, 'Missing code or role');
        return;
    }

    const room = getRoom(code);

    if (role === 'caster') {
        if (room.caster && room.caster !== ws) {
            room.caster.close(1001, 'Replaced by new caster');
        }
        room.caster = ws;
        console.log(`[${code}] caster connected`);
        relay(room.receiver, JSON.stringify({ type: 'caster_connected' }), false);

    } else if (role === 'receiver') {
        if (room.receiver && room.receiver !== ws) {
            room.receiver.close(1001, 'Replaced by new receiver');
        }
        room.receiver = ws;
        console.log(`[${code}] receiver connected`);
        relay(room.caster, JSON.stringify({ type: 'receiver_ready' }), false);
        ws.send(JSON.stringify({ type: 'receiver_ready' }));
    }

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            const target = role === 'caster' ? room.receiver : room.caster;
            relay(target, data, true);
        } else {
            let msg;
            try { msg = JSON.parse(data); }
            catch (e) { console.warn(`[${code}] bad JSON`, e); return; }

            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            const target = role === 'caster' ? room.receiver : room.caster;
            relay(target, data, false);
        }
    });

    ws.on('close', () => {
        console.log(`[${code}] ${role} disconnected`);

        if (role === 'caster') {
            room.caster = null;
            relay(room.receiver, JSON.stringify({ type: 'caster_disconnected' }), false);
        } else {
            room.receiver = null;
            relay(room.caster, JSON.stringify({ type: 'receiver_disconnected' }), false);
        }

        if (!room.caster && !room.receiver) {
            delete rooms[code];
            console.log(`[${code}] room removed`);
        }
    });

    ws.on('error', (err) => console.error(`[${code}] WS error:`, err));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ╔════════════════════════════════════╗');
    console.log(`  ║   CastFlow running on port ${PORT}    ║`);
    console.log('  ╠════════════════════════════════════╣');
    console.log(`  ║   Receiver:  http://${LOCAL_IP}:${PORT}  ║`);
    console.log(`  ║   Extension: point at ${LOCAL_IP}    ║`);
    console.log('  ╚════════════════════════════════════╝');
    console.log('');
});
