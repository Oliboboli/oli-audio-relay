// Audio relay for oli's Highrise music bot.
// Bot pushes audio via PUT /stream, listeners (Highrise room radio) pull via GET /stream.
// Serves a continuous audio/mpeg stream — this is what Highrise needs (not a static file).
const http = require('http');

const MAX_CHUNKS = 500;
let buffer = [];            // ring buffer of Buffer chunks
let hasStream = false;
let waiters = [];           // GET responses waiting for the stream to start
const listeners = new Set(); // active GET responses receiving live audio

function pushChunk(chunk) {
  buffer.push(chunk);
  if (buffer.length > MAX_CHUNKS) buffer.shift();
  for (const res of listeners) {
    try { res.write(chunk); } catch (e) { /* client gone */ }
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
    try { res.write(c); } catch (e) { /* client gone */ }
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
    // Bot uploading audio — keep the connection open while it streams.
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
      // Wait up to 30s for the bot to start streaming, else 404.
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
