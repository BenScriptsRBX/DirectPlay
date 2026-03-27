from http.server import BaseHTTPRequestHandler
import json
import time

# In-memory store — persists within a single warm instance
# For production use Vercel KV, but this works fine for signaling
_rooms = {}

def clean_old_rooms():
    """Remove rooms older than 5 minutes"""
    now = time.time()
    for code in list(_rooms.keys()):
        if now - _rooms[code].get('ts', 0) > 300:
            del _rooms[code]

class handler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # Suppress default logging

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json({})

    def do_GET(self):
        """Receiver/caster polls for signaling messages"""
        clean_old_rooms()

        # Parse path: /api/signal?code=ABCD&role=receiver
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        code = params.get('code', [None])[0]
        role = params.get('role', [None])[0]

        if not code or not role:
            self.send_json({'error': 'Missing code or role'}, 400)
            return

        room = _rooms.get(code, {})

        if role == 'receiver':
            # Receiver polls for offer from caster
            if 'offer' in room:
                self.send_json({ 'offer': room['offer'] })
            else:
                self.send_json({})

        elif role == 'caster':
            # Caster polls for answer from receiver
            if 'answer' in room:
                self.send_json({
                    'answer': room['answer'],
                    'ice_receiver': room.get('ice_receiver', [])
                })
            else:
                self.send_json({})

        else:
            self.send_json({'error': 'Invalid role'}, 400)

    def do_POST(self):
        """Store signaling data"""
        clean_old_rooms()

        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        code = params.get('code', [None])[0]
        action = params.get('action', [None])[0]

        if not code:
            self.send_json({'error': 'Missing code'}, 400)
            return

        if code not in _rooms:
            _rooms[code] = {'ts': time.time(), 'ice_caster': [], 'ice_receiver': []}

        room = _rooms[code]

        if action == 'offer':
            room['offer'] = body.get('offer')
            room['ice_caster'] = body.get('ice', [])
            room['ts'] = time.time()
            self.send_json({'ok': True})

        elif action == 'answer':
            room['answer'] = body.get('answer')
            room['ice_receiver'] = body.get('ice', [])
            self.send_json({'ok': True})

        elif action == 'clear':
            if code in _rooms:
                del _rooms[code]
            self.send_json({'ok': True})

        else:
            self.send_json({'error': 'Unknown action'}, 400)
