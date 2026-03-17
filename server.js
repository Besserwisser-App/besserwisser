// Besserwisser – Server
// Lokal:   node server.js DEEPGRAM_KEY ANTHROPIC_KEY
// Railway: Umgebungsvariablen DEEPGRAM_API_KEY + ANTHROPIC_API_KEY

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');
const https     = require('https');

const PORT          = process.env.PORT || 3000;
const DEEPGRAM_KEY  = process.env.DEEPGRAM_API_KEY  || process.argv[2];
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.argv[3];
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');

if (!DEEPGRAM_KEY)  { console.error('❌ DEEPGRAM_API_KEY fehlt'); process.exit(1); }
if (!ANTHROPIC_KEY) { console.warn('⚠️  ANTHROPIC_API_KEY fehlt — Keyword-Extraktion eingeschränkt'); }

// ── ANALYTICS ────────────────────────────────────────────────────
function loadAnalytics() {
  try { return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')); }
  catch { return { found: {}, looked_up: {} }; }
}
function saveAnalytics(data) {
  try { fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}
function logFound(terms) {
  if (!terms?.length) return;
  const a = loadAnalytics();
  terms.forEach(t => { a.found[t] = (a.found[t] || 0) + 1; });
  saveAnalytics(a);
}
function logLookedUp(term) {
  if (!term) return;
  const a = loadAnalytics();
  a.looked_up[term] = (a.looked_up[term] || 0) + 1;
  saveAnalytics(a);
}

// ── CLAUDE API ────────────────────────────────────────────────────
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function extractKeywords(text, language, existingTerms) {
  if (!ANTHROPIC_KEY) return [];
  try {
    const existing = existingTerms.join(', ') || 'keine';
    const result = await callClaude(
      `Du analysierst einen Gesprächsabschnitt und extrahierst ausschließlich Begriffe, die ein gebildeter Erwachsener möglicherweise nicht sofort kennt und nachschlagen würde.

Sprache des Gesprächs: ${language}
Text: "${text}"

Kriterien für EINSCHLUSS:
- Fachbegriffe (Technik, Medizin, Recht, Wirtschaft, Wissenschaft, Politik)
- Abkürzungen und Akronyme (KI, DSGVO, ESG, IPO usw.)
- Namen bedeutender Personen, Unternehmen, Organisationen, Institutionen
- Wirtschaftliche, wissenschaftliche oder geopolitische Konzepte

Kriterien für AUSSCHLUSS:
- Alltagswörter und gewöhnliche Begriffe
- Bereits bekannte Begriffe: [${existing}]
- Verben, Adjektive, Konjunktionen in normaler Verwendung

Antworte NUR mit einem JSON-Array. Maximal 4 neue Begriffe. Keine Erklärungen.
Beispiel: ["Quantencomputing", "DSGVO", "BlackRock"]
Bei keinen relevanten Begriffen: []`
    );
    const raw = result.content?.[0]?.text || '[]';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\[.*?\]/s);
    const terms = match ? JSON.parse(match[0]) : JSON.parse(cleaned);
    if (Array.isArray(terms)) {
      const valid = terms.filter(t => typeof t === 'string' && t.trim().length > 1);
      logFound(valid);
      return valid;
    }
    return [];
  } catch(e) {
    console.error('Claude extraction error:', e.message);
    return [];
  }
}

async function generateSummary(transcript, language, mode) {
  if (!ANTHROPIC_KEY) return null;
  const isSummary = mode === 'summary';
  const prompt = isSummary
    ? `Erstelle eine strukturierte Zusammenfassung des folgenden Gesprächstranskripts auf ${language === 'de' ? 'Deutsch' : 'Englisch'}.

Format:
# Zusammenfassung
[2-3 Sätze Kernaussage]

## Hauptthemen
[Gliederung der besprochenen Themen]

## Wichtige Begriffe
[Liste der zentralen Fachbegriffe mit kurzer Erklärung]

## Fazit
[Wichtigste Erkenntnisse]

Transkript:
${transcript}`
    : `Bereinige das folgende Transkript auf ${language === 'de' ? 'Deutsch' : 'Englisch'}. Entferne Füllwörter, korrigiere offensichtliche Transkriptionsfehler, behalte aber den originalen Inhalt. Formatiere es als lesbaren Text mit Absätzen.

Transkript:
${transcript}`;

  try {
    const result = await callClaude(prompt);
    return result.content?.[0]?.text || null;
  } catch(e) {
    console.error('Claude summary error:', e.message);
    return null;
  }
}

// ── HTTP SERVER ───────────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);

  // ── Serve main app ──
  if (url.pathname === '/' || url.pathname === '/besserwisser.html' || url.pathname === '/index.html') {
    const file = path.join(__dirname, 'besserwisser.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('besserwisser.html nicht gefunden.'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── Serve analytics dashboard ──
  if (url.pathname === '/analytics') {
    const file = path.join(__dirname, 'analytics.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('analytics.html nicht gefunden.'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── Analytics API ──
  if (url.pathname === '/api/analytics' && req.method === 'GET') {
    const data = loadAnalytics();
    // Sort by count descending
    const found = Object.entries(data.found)
      .sort((a,b) => b[1]-a[1])
      .map(([term, count]) => ({ term, count }));
    const looked_up = Object.entries(data.looked_up)
      .sort((a,b) => b[1]-a[1])
      .map(([term, count]) => ({ term, count }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ found, looked_up, updated: new Date().toISOString() }));
    return;
  }

  // ── Log lookup ──
  if (url.pathname === '/api/lookup' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { const { term } = JSON.parse(body); logLookedUp(term); } catch(e) {}
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  // ── Extract keywords ──
  if (url.pathname === '/api/extract' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text, language, existing } = JSON.parse(body);
        const terms = await extractKeywords(text, language, existing || []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ terms }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ terms: [] }));
      }
    });
    return;
  }

  // ── Export / summarize ──
  if (url.pathname === '/api/export' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { transcript, language, mode } = JSON.parse(body);
        const text = mode === 'raw' ? transcript : await generateSummary(transcript, language, mode);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: text || transcript }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ text: '' }));
      }
    });
    return;
  }

  // ── Health ──
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', deepgram: !!DEEPGRAM_KEY, claude: !!ANTHROPIC_KEY }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WEBSOCKET PROXY ───────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (browserSocket, req) => {
  const url  = new URL(req.url, 'http://localhost');
  const lang = url.searchParams.get('lang') || 'de';
  console.log(`\n🎙  Verbindung — Sprache: ${lang}`);

  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model: 'nova-2', language: lang, smart_format: 'true',
    punctuate: 'true', interim_results: 'true', endpointing: '300',
    filler_words: 'false', encoding: 'opus', container: 'webm',
  }).toString();

  const dgSocket = new WebSocket(dgUrl, { headers: { Authorization: 'Token ' + DEEPGRAM_KEY } });

  dgSocket.on('open', () => {
    console.log('✓ Deepgram verbunden');
    if (browserSocket.readyState === WebSocket.OPEN)
      browserSocket.send(JSON.stringify({ type: 'Connected', language: lang }));
  });

  dgSocket.on('message', (data) => {
    const text = data.toString('utf8');
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'Results') {
        const t = msg.channel?.alternatives?.[0]?.transcript;
        if (t) console.log(msg.is_final ? `✅ "${t}"` : `   → "${t}"`);
      }
      if (msg.type === 'Error') console.error('❌ DG Error:', msg);
    } catch(e) {}
    if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(text);
  });

  dgSocket.on('error', err => {
    console.error('❌ DG Fehler:', err.message);
    if (browserSocket.readyState === WebSocket.OPEN)
      browserSocket.send(JSON.stringify({ type: 'Error', err_msg: err.message }));
  });

  dgSocket.on('close', code => {
    console.log(`DG getrennt: ${code}`);
    if (browserSocket.readyState === WebSocket.OPEN) browserSocket.close();
  });

  let chunks = 0;
  browserSocket.on('message', data => {
    chunks++;
    if (chunks % 40 === 0) console.log(`🔊 ${chunks} Audio-Chunks`);
    if (dgSocket.readyState === WebSocket.OPEN) dgSocket.send(data);
  });

  browserSocket.on('close', () => {
    console.log('Browser getrennt');
    if (dgSocket.readyState === WebSocket.OPEN) {
      try { dgSocket.send(JSON.stringify({ type: 'CloseStream' })); } catch(e) {}
      dgSocket.close();
    }
  });

  browserSocket.on('error', err => console.error('Browser Fehler:', err.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n✅ Besserwisser läuft auf Port ${PORT}`);
  console.log(`   Deepgram: ${DEEPGRAM_KEY ? '✓' : '✗'}`);
  console.log(`   Claude:   ${ANTHROPIC_KEY ? '✓' : '✗'}`);
  if (!process.env.PORT) {
    console.log(`   App:       http://localhost:${PORT}`);
    console.log(`   Analytics: http://localhost:${PORT}/analytics`);
  }
  console.log();
});
