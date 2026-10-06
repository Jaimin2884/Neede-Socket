const fs = require('fs');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

loadEnv(path.join(__dirname, '.env'));

const port = Number(process.env.PORT || 3001);
const hostArg = process.argv.find((arg) => arg.startsWith('--host='));
const advertisedHost = hostArg ? hostArg.slice('--host='.length) : '0.0.0.0';
const secret = process.env.SOCKET_SECRET || 'neede-socket-local';
const laravelHost = advertisedHost && advertisedHost !== '0.0.0.0' ? advertisedHost : '127.0.0.1';
const laravelUrl = (process.env.LARAVEL_URL || `http://${laravelHost}:8000`).replace(/\/$/, '');
const roles = new Set(['user', 'vendor', 'delivery']);

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/check') {
    sendJson(res, 200, {
      ok: true,
      service: 'neede-socket',
      port,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/emit') {
    readJson(req)
      .then((body) => {
        if (req.headers['x-socket-secret'] !== secret) {
          sendJson(res, 401, { ok: false, message: 'Unauthorized.' });
          return;
        }

        const room = typeof body.room === 'string' ? body.room : '';
        const event = typeof body.event === 'string' ? body.event : '';
        if (!room || !event) {
          sendJson(res, 422, { ok: false, message: 'Room and event are required.' });
          return;
        }

        io.to(room).emit(event, body.data ?? {});
        sendJson(res, 200, { ok: true });
      })
      .catch(() => {
        sendJson(res, 400, { ok: false, message: 'Invalid JSON.' });
      });
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Not found.' });
});

const io = new Server(server, {
  cors: { origin: '*' },
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  const role = socket.handshake.auth?.role;

  if (typeof token !== 'string' || !token || !roles.has(role)) {
    next(new Error('unauthorized'));
    return;
  }

  try {
    const identified = await identify(token, role);
    socket.data.role = identified.role;
    socket.data.id = identified.id;
    next();
  } catch (error) {
    console.error(`Socket identify failed for ${role}: ${error instanceof Error ? error.message : 'unknown error'}`);
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const role = socket.data.role;
  const id = socket.data.id;

  if (role === 'delivery') {
    socket.join('delivery');
    socket.join(`delivery:${id}`);
    return;
  }

  socket.join(`${role}:${id}`);
});

server.listen(port, '0.0.0.0', () => {
  const shownHost = advertisedHost === '0.0.0.0' ? '0.0.0.0' : advertisedHost;
  console.log(`Neede socket listening on ${shownHost}:${port}`);
  console.log(`Laravel identify: ${laravelUrl}`);
});

async function identify(token, role) {
  const response = await fetch(`${laravelUrl}/api/internal/socket/identify`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ role }),
  });

  if (!response.ok) {
    throw new Error(`Laravel identify ${response.status} at ${laravelUrl}`);
  }

  const body = await response.json();
  if (!body || body.ok !== true || !body.id || body.role !== role) {
    throw new Error('unauthorized');
  }

  return { id: body.id, role: body.role };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function loadEnv(file) {
  if (!fs.existsSync(file)) {
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eq = trimmed.indexOf('=');
    if (eq < 1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
