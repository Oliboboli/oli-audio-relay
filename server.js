// Audio relay for oli's Highrise music bot.
// Bot pushes audio via PUT /stream, listeners (Highrise room radio) pull via GET /stream.
// Serves a continuous audio/mpeg stream — this is what Highrise needs (not a static file).
// NEW: POST /play with {"url": "youtube-url"} — relay downloads from YouTube directly
// (Railway has fast internet, no proxy issues) and streams it.
const http = require('http');
const ytdl = require('ytdl-core');

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
  // NEW: POST /play — bot sends {"url": "youtube-url"}, relay downloads and streams it
  if (req.url === '/play' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { url } = JSON.parse(body);
        if (!url || !ytdl.validateURL(url)) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'Invalid YouTube URL'}));
          return;
        }
        console.log(`Downloading: ${url}`);
        // Clear buffer for new song
        buffer = [];
        hasStream = true;
        const ws = waiters;
        waiters = [];
        for (const w of ws) startStream(w);
        // Stream audio from YouTube directly (Railway has fast internet)
        const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
        stream.on('data', pushChunk);
        stream.on('end', () => {
          console.log('Download complete');
          hasStream = false;
        });
        stream.on('error', (e) => {
          console.error('Download error:', e.message);
          hasStream = false;
        });
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({status: 'playing'}));
      } catch (e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: e.message}));
      }
    });
    return;
  }

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
