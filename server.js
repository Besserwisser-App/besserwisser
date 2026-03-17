// Besserwisser – Server v3
// Lokal:   node server.js DEEPGRAM_KEY ANTHROPIC_KEY
// Railway: Umgebungsvariablen DEEPGRAM_API_KEY + ANTHROPIC_API_KEY

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const WebSocket = require('ws');
const https   = require('https');

const PORT          = process.env.PORT || 3000;
const DEEPGRAM_KEY  = process.env.DEEPGRAM_API_KEY  || process.argv[2];
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.argv[3];
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');

if (!DEEPGRAM_KEY)  { console.error('❌ DEEPGRAM_API_KEY fehlt'); process.exit(1); }
if (!ANTHROPIC_KEY) { console.warn('⚠️  ANTHROPIC_API_KEY fehlt'); }

console.log(`✓ Deepgram: ${DEEPGRAM_KEY.slice(0,6)}...`);
console.log(`✓ Claude:   ${ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0,6)+'...' : 'FEHLT'}`);

// ── ANALYTICS ─────────────────────────────────────────────────────
function loadAnalytics() {
  try { return JSON.parse(fs.readFileSync(ANALYTICS_FILE,'utf8')); }
  catch { return { found:{}, looked_up:{} }; }
}
function saveAnalytics(data) {
  try { fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data,null,2)); } catch(e) {}
}
function logFound(terms) {
  if (!terms?.length) return;
  const a = loadAnalytics();
  terms.forEach(t => { a.found[t] = (a.found[t]||0)+1; });
  saveAnalytics(a);
}
function logLookedUp(term) {
  if (!term) return;
  const a = loadAnalytics();
  a.looked_up[term] = (a.looked_up[term]||0)+1;
  saveAnalytics(a);
}

// ── CLAUDE API ─────────────────────────────────────────────────────
function callClaude(messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages,
    };
    if (systemPrompt) payload.system = systemPrompt;

    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          resolve(parsed);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ── KEYWORD EXTRACTION ─────────────────────────────────────────────
async function extractKeywords(text, language, existingTerms) {
  if (!ANTHROPIC_KEY || !text?.trim()) return [];
  try {
    const existing = existingTerms?.length ? existingTerms.join(', ') : 'keine';
    const result = await callClaude([{
      role: 'user',
      content: `Analysiere diesen Gesprächsabschnitt und extrahiere Begriffe die ein gebildeter Erwachsener möglicherweise nachschlagen würde.

Sprache: ${language}
Text: "${text}"

EINSCHLIESSEN: Fachbegriffe (Technik/Medizin/Recht/Wirtschaft), Abkürzungen (KI/DSGVO/ESG), Namen bedeutender Personen/Unternehmen/Organisationen, wissenschaftliche/geopolitische Konzepte.

AUSSCHLIESSEN: Alltagswörter, normale Eigennamen ohne besondere Bedeutung, bereits bekannt: [${existing}]

Antworte NUR mit JSON-Array, max. 4 Begriffe. Keine Erklärungen.
Beispiel: ["Quantencomputing","DSGVO","BlackRock"]
Wenn keine: []`
    }]);

    const raw = result.content?.[0]?.text?.trim() || '[]';
    console.log('Claude extraction raw:', raw);
    const match = raw.match(/\[[\s\S]*?\]/);
    const terms = match ? JSON.parse(match[0]) : [];
    const valid = Array.isArray(terms) ? terms.filter(t => typeof t==='string' && t.trim().length>1) : [];
    if (valid.length) { logFound(valid); console.log('✓ Extrahiert:', valid); }
    return valid;
  } catch(e) {
    console.error('❌ Claude extraction error:', e.message);
    return [];
  }
}

// ── CLAUDE EXPLAIN ─────────────────────────────────────────────────
async function explainTerm(term, infoLanguage) {
  if (!ANTHROPIC_KEY) return null;
  const langMap = { de:'Deutsch', en:'English', fr:'Français', es:'Español', it:'Italiano', nl:'Nederlands', pt:'Português', ja:'日本語', zh:'中文', pl:'Polski' };
  const langName = langMap[infoLanguage] || 'Deutsch';
  try {
    const result = await callClaude([{
      role: 'user',
      content: `Erkläre den Begriff "${term}" auf ${langName}.

Format (exakt einhalten):
KURZ: [1-2 Sätze Kurzerklärung wie Wikipedia-Einleitung]
DETAIL: [2-3 Sätze mit weiteren Details, Kontext, Bedeutung]
KATEGORIE: [ein Wort: Technologie/Wirtschaft/Medizin/Recht/Politik/Person/Organisation/Wissenschaft/Sonstiges]`
    }]);

    const text = result.content?.[0]?.text?.trim() || '';
    const kurz = text.match(/KURZ:\s*(.+?)(?=DETAIL:|$)/s)?.[1]?.trim() || '';
    const detail = text.match(/DETAIL:\s*(.+?)(?=KATEGORIE:|$)/s)?.[1]?.trim() || '';
    const kategorie = text.match(/KATEGORIE:\s*(.+)/)?.[1]?.trim() || '';

    if (!kurz) return null;
    return { kurz, detail, kategorie, source: 'claude', language: infoLanguage };
  } catch(e) {
    console.error('❌ Claude explain error:', e.message);
    return null;
  }
}

// ── EXPORT / SUMMARY ───────────────────────────────────────────────
async function generateExport(transcript, language, mode) {
  if (!ANTHROPIC_KEY) return transcript;
  const langMap = { de:'Deutsch', en:'English', fr:'Français', es:'Español' };
  const langName = langMap[language] || 'Deutsch';

  let prompt;
  if (mode === 'summary') {
    prompt = `Erstelle ein strukturiertes Gesprächsprotokoll auf ${langName} aus diesem Transkript.

Format:
# Gesprächsprotokoll

## Gliederung
[Nummerierte Liste der Hauptthemen in der Reihenfolge des Gesprächs]

## Zusammenfassung
[Für jeden Gliederungspunkt 2-4 Sätze Zusammenfassung]

## Wichtige Begriffe & Konzepte
[Liste der Fachbegriffe die im Gespräch vorkamen, mit je einer Zeile Erklärung]

---

## Vollständiges Transkript (Original)
[Das komplette Originaltranskript]

Transkript:
${transcript}`;
  } else if (mode === 'clean') {
    prompt = `Bereinige dieses Transkript auf ${langName}. Entferne Füllwörter (ähm, äh, ne, also), korrigiere offensichtliche Transkriptionsfehler, gliedere in sinnvolle Absätze. Behalte den originalen Inhalt vollständig.

Transkript:
${transcript}`;
  } else {
    return transcript;
  }

  try {
    const result = await callClaude([{ role:'user', content:prompt }]);
    return result.content?.[0]?.text?.trim() || transcript;
  } catch(e) {
    console.error('❌ Export error:', e.message);
    return transcript;
  }
}

// ── HTTP SERVER ────────────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  const url = new URL(req.url, `http://localhost`);

  // Serve HTML files
  if (url.pathname==='/' || url.pathname==='/index.html' || url.pathname==='/besserwisser.html') {
    serveFile(res, path.join(__dirname,'besserwisser.html'), 'text/html'); return;
  }
  if (url.pathname==='/analytics') {
    serveFile(res, path.join(__dirname,'analytics.html'), 'text/html'); return;
  }

  // API: extract keywords
  if (url.pathname==='/api/extract' && req.method==='POST') {
    const body = await readBody(req);
    try {
      const { text, language, existing } = JSON.parse(body);
      const terms = await extractKeywords(text, language, existing||[]);
      json(res, { terms });
    } catch(e) {
      console.error('Extract error:', e.message);
      json(res, { terms:[], error: e.message });
    }
    return;
  }

  // API: explain term with Claude
  if (url.pathname==='/api/explain' && req.method==='POST') {
    const body = await readBody(req);
    try {
      const { term, infoLanguage } = JSON.parse(body);
      logLookedUp(term);
      const result = await explainTerm(term, infoLanguage||'de');
      json(res, result || { error: 'Keine Erklärung verfügbar' });
    } catch(e) {
      json(res, { error: e.message });
    }
    return;
  }

  // API: log lookup
  if (url.pathname==='/api/lookup' && req.method==='POST') {
    const body = await readBody(req);
    try { const {term}=JSON.parse(body); logLookedUp(term); } catch(e){}
    res.writeHead(200); res.end('ok'); return;
  }

  // API: export
  if (url.pathname==='/api/export' && req.method==='POST') {
    const body = await readBody(req);
    try {
      const { transcript, language, mode } = JSON.parse(body);
      const text = await generateExport(transcript, language, mode);
      json(res, { text });
    } catch(e) {
      json(res, { text:'', error:e.message });
    }
    return;
  }

  // API: analytics
  if (url.pathname==='/api/analytics' && req.method==='GET') {
    const data = loadAnalytics();
    const found = Object.entries(data.found).sort((a,b)=>b[1]-a[1]).map(([term,count])=>({term,count}));
    const looked_up = Object.entries(data.looked_up).sort((a,b)=>b[1]-a[1]).map(([term,count])=>({term,count}));
    json(res, { found, looked_up, updated: new Date().toISOString() });
    return;
  }

  // Health
  if (url.pathname==='/health') {
    json(res, { status:'ok', deepgram:!!DEEPGRAM_KEY, claude:!!ANTHROPIC_KEY });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('File not found: '+filePath); return; }
    res.writeHead(200, {'Content-Type': contentType+'; charset=utf-8'});
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve,reject) => {
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>resolve(body));
    req.on('error',reject);
  });
}
function json(res, data) {
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(data));
}

// ── WEBSOCKET PROXY ────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (browserSocket, req) => {
  const url  = new URL(req.url, 'http://localhost');
  const lang = url.searchParams.get('lang') || 'de';
  console.log(`\n🎙  Verbindung — Sprache: ${lang}`);

  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model:'nova-2', language:lang, smart_format:'true',
    punctuate:'true', interim_results:'true', endpointing:'300',
    filler_words:'false', encoding:'opus', container:'webm',
  }).toString();

  const dgSocket = new WebSocket(dgUrl, { headers:{ Authorization:'Token '+DEEPGRAM_KEY } });

  dgSocket.on('open', () => {
    console.log('✓ Deepgram verbunden');
    if (browserSocket.readyState===WebSocket.OPEN)
      browserSocket.send(JSON.stringify({ type:'Connected', language:lang }));
  });
  dgSocket.on('message', data => {
    const text = data.toString('utf8');
    try {
      const msg = JSON.parse(text);
      if (msg.type==='Results') {
        const t = msg.channel?.alternatives?.[0]?.transcript;
        if (t) console.log(msg.is_final?`✅ "${t}"`:` → "${t}"`);
      }
      if (msg.type==='Error') console.error('❌ DG Error:',msg);
    } catch(e) {}
    if (browserSocket.readyState===WebSocket.OPEN) browserSocket.send(text);
  });
  dgSocket.on('error', err => {
    console.error('❌ DG Fehler:',err.message);
    if (browserSocket.readyState===WebSocket.OPEN)
      browserSocket.send(JSON.stringify({type:'Error',err_msg:err.message}));
  });
  dgSocket.on('close', code => {
    console.log(`DG getrennt: ${code}`);
    if (browserSocket.readyState===WebSocket.OPEN) browserSocket.close();
  });

  let chunks=0;
  browserSocket.on('message', data => {
    chunks++;
    if (chunks%40===0) console.log(`🔊 ${chunks} Audio-Chunks`);
    if (dgSocket.readyState===WebSocket.OPEN) dgSocket.send(data);
  });
  browserSocket.on('close', () => {
    console.log('Browser getrennt');
    if (dgSocket.readyState===WebSocket.OPEN) { try{dgSocket.send(JSON.stringify({type:'CloseStream'}));}catch(e){} dgSocket.close(); }
  });
  browserSocket.on('error', err => console.error('Browser Fehler:',err.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n✅ Besserwisser Server läuft auf Port ${PORT}`);
  if (!process.env.PORT) {
    console.log(`   App:       http://localhost:${PORT}`);
    console.log(`   Analytics: http://localhost:${PORT}/analytics`);
  }
  console.log();
});
