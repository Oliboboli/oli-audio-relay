// Audio relay for oli's Highrise music bot.
// Bot pushes audio via PUT /stream, listeners (Highrise room radio) pull via GET /stream.
// Simple dumb pipe — no YouTube downloading here (bot handles that).
const http = require('http');

const MAX_CHUNKS = 500;
let buffer = [];
let hasStream = false;
let waiters = [];
const listeners = new Set();

function pushChunk(chunk) {
  buffer.push(chunk);
  if (buffer.length > MAX_CHUNKS) buffer.shift();
  for (const res of listeners) {
    try { res.write(chunk); } catch (e) {}
  }
}

function startStream(res) {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  for (const c of buffer) {
    try { res.write(c); } catch (e) {}
  }
  listeners.add(res);
  res.on('close', () => listeners.delete(res));
}

const server = http.createServer((req, res) => {
  if (req.url !== '/stream') {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === 'PUT') {
    hasStream = true;
    const ws = waiters;
    waiters = [];
    for (const w of ws) startStream(w);
    req.on('data', pushChunk);
    const done = () => { hasStream = false; };
    req.on('end', () => { done(); res.writeHead(200); res.end(); });
    req.on('close', done);
    return;
  }

  if (req.method === 'GET') {
    if (hasStream) {
      startStream(res);
    } else {
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== res);
        try { res.writeHead(404); res.end(); } catch (e) {}
      }, 30000);
      waiters.push(res);
      req.on('close', () => {
        clearTimeout(timer);
        waiters = waiters.filter((w) => w !== res);
      });
    }
    return;
  }

  res.writeHead(405);
  res.end();
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`audio relay listening on ${port}`));
