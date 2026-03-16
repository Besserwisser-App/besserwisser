// Besserwisser – Deepgram Proxy Server
// Lokal:   node server.js DEIN_API_KEY
// Railway: API Key als Umgebungsvariable DEEPGRAM_API_KEY setzen

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

// Railway setzt PORT automatisch, lokal fallback auf 3000
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.DEEPGRAM_API_KEY || process.argv[2];

if (!API_KEY) {
  console.error('\n❌ Kein API Key gefunden.');
  console.error('Lokal:   node server.js DEIN_KEY');
  console.error('Railway: Umgebungsvariable DEEPGRAM_API_KEY setzen\n');
  process.exit(1);
}

console.log(`✓ API Key geladen (${API_KEY.slice(0,4)}...)`);

// ── HTTP Server ───────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // CORS für lokale Entwicklung
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/index.html' || req.url === '/besserwisser.html') {
    const file = path.join(__dirname, 'besserwisser.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('besserwisser.html nicht gefunden.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/health') {
    // Railway health check
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'besserwisser' }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── WebSocket Proxy ───────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (browserSocket, req) => {
  const url  = new URL(req.url, `http://localhost`);
  const lang = url.searchParams.get('lang') || 'de';
  console.log(`\n🎙  Neue Verbindung — Sprache: ${lang}`);

  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model:           'nova-2',
    language:        lang,
    smart_format:    'true',
    punctuate:       'true',
    interim_results: 'true',
    endpointing:     '300',
    filler_words:    'false',
    encoding:        'opus',
    container:       'webm',
  }).toString();

  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: 'Token ' + API_KEY }
  });

  dgSocket.on('open', () => {
    console.log('✓ Deepgram verbunden');
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify({ type: 'Connected', language: lang }));
    }
  });

  dgSocket.on('message', (data) => {
    const text = data.toString('utf8');
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'Results') {
        const t = msg.channel?.alternatives?.[0]?.transcript;
        if (t) console.log(msg.is_final ? `✅ "${t}"` : `   → "${t}"`);
      }
      if (msg.type === 'Error') console.error('❌ Deepgram Error:', msg);
    } catch(e) {}
    if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(text);
  });

  dgSocket.on('error', (err) => {
    console.error('❌ Deepgram Fehler:', err.message);
    if (browserSocket.readyState === WebSocket.OPEN)
      browserSocket.send(JSON.stringify({ type: 'Error', err_msg: err.message }));
  });

  dgSocket.on('close', (code) => {
    console.log(`Deepgram getrennt: ${code}`);
    if (browserSocket.readyState === WebSocket.OPEN) browserSocket.close();
  });

  let chunks = 0;
  browserSocket.on('message', (data) => {
    chunks++;
    if (chunks % 40 === 0) console.log(`🔊 ${chunks} Audio-Chunks`);
    if (dgSocket.readyState === WebSocket.OPEN) dgSocket.send(data);
  });

  browserSocket.on('close', () => {
    console.log('Browser getrennt');
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
      dgSocket.close();
    }
  });

  browserSocket.on('error', (err) => console.error('Browser Fehler:', err.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n✅ Besserwisser läuft auf Port ${PORT}`);
  if (!process.env.PORT) console.log(`   Lokal: http://localhost:${PORT}`);
  console.log('   Bereit.\n');
});
