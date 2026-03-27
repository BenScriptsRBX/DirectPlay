const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CastFlow Signaling Server');
});

const wss = new WebSocket.Server({ server });

// rooms[ip] = { receiver: ws, caster: ws }
const rooms = {};

wss.on('connection', (ws, req) => {
    let roomIp = null;
    let role = null;

    console.log('New connection');

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            console.error('Invalid JSON:', raw);
            return;
        }

        switch (msg.type) {

            // ── Receiver registers itself by IP ──
            case 'register': {
                roomIp = msg.ip;
                role = 'receiver';

                if (!rooms[roomIp]) rooms[roomIp] = {};
                rooms[roomIp].receiver = ws;

                console.log(`Receiver registered: ${roomIp}`);
                ws.send(JSON.stringify({ type: 'registered', ip: roomIp }));
                break;
            }

            // ── Caster joins by IP ──
            case 'join': {
                roomIp = msg.ip;
                role = 'caster';

                if (!rooms[roomIp]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'No receiver found at that IP' }));
                    return;
                }

                rooms[roomIp].caster = ws;

                console.log(`Caster joined: ${roomIp}`);

                // Tell receiver a caster has joined
                const receiver = rooms[roomIp]?.receiver;
                if (receiver?.readyState === WebSocket.OPEN) {
                    receiver.send(JSON.stringify({ type: 'caster_joined' }));
                }

                ws.send(JSON.stringify({ type: 'joined', ip: roomIp }));
                break;
            }

            // ── WebRTC signaling — relay offer/answer/ICE between peers ──
            case 'offer':
            case 'answer':
            case 'ice': {
                if (!roomIp || !rooms[roomIp]) return;

                const target = role === 'caster'
                    ? rooms[roomIp].receiver
                    : rooms[roomIp].caster;

                if (target?.readyState === WebSocket.OPEN) {
                    target.send(JSON.stringify(msg));
                }
                break;
            }

            // ── Remote control commands — relay to receiver ──
            case 'play':
            case 'pause':
            case 'seek':
            case 'seekRelative':
            case 'volume':
            case 'metadata': {
                if (!roomIp || !rooms[roomIp]) return;

                const receiver = rooms[roomIp]?.receiver;
                if (receiver?.readyState === WebSocket.OPEN) {
                    receiver.send(JSON.stringify(msg));
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        if (!roomIp || !rooms[roomIp]) return;

        console.log(`${role} disconnected from room ${roomIp}`);

        if (role === 'receiver') {
            // Notify caster receiver disconnected
            const caster = rooms[roomIp]?.caster;
            if (caster?.readyState === WebSocket.OPEN) {
                caster.send(JSON.stringify({ type: 'receiver_disconnected' }));
            }
            delete rooms[roomIp];
        } else if (role === 'caster') {
            // Notify receiver caster disconnected
            const receiver = rooms[roomIp]?.receiver;
            if (receiver?.readyState === WebSocket.OPEN) {
                receiver.send(JSON.stringify({ type: 'caster_disconnected' }));
            }
            delete rooms[roomIp].caster;
        }
    });

    ws.on('error', (err) => {
        console.error('WS error:', err);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`CastFlow signaling server running on port ${PORT}`);
});
