// Audio relay for oli's Highrise music bot.
// Bot pushes audio via PUT /stream, listeners (Highrise room radio) pull via GET /stream.
// Serves a continuous audio/mpeg stream — this is what Highrise needs (not a static file).
// NEW: POST /play with {"url": "youtube-url"} — relay downloads from YouTube directly
// (Railway has fast internet, no proxy issues) and streams it.
const http = require('http');
const ytdl = require('ytdl-core');
const { exec } = require('child_process');

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
  // NEW: POST /search — bot sends {"query": "song name"}, relay searches YouTube and returns {title, url, duration}
  if (req.url === '/search' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { query } = JSON.parse(body);
        if (!query) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'No query'}));
          return;
        }
        console.log(`Searching: ${query}`);
        // Use yt-dlp to search (Railway has it via npm, or use python)
        // For now, use ytdl-core with a YouTube search via the oembed API trick:
        // We'll use a simple approach: search via YouTube's API using fetch
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        // Use curl to fetch and parse (simple, no extra deps)
        exec(`curl -s -A "Mozilla/5.0" "${searchUrl}" | grep -o '"videoId":"[^"]*"' | head -1 | cut -d'"' -f4`, 
          {timeout: 15000}, (err, stdout) => {
          if (err || !stdout.trim()) {
            res.writeHead(404, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Not found'}));
            return;
          }
          const videoId = stdout.trim();
          const url = `https://www.youtube.com/watch?v=${videoId}`;
          // Get title and duration via ytdl-core
          ytdl.getInfo(url).then(info => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
              title: info.videoDetails.title,
              url: url,
              duration: parseInt(info.videoDetails.lengthSeconds) || 180
            }));
          }).catch(e => {
            // If getInfo fails, just return the URL
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({title: query, url: url, duration: 180}));
          });
        });
      } catch (e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: e.message}));
      }
    });
    return;
  }

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
