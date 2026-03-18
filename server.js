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
      model: 'claude-haiku-4-5-20251001',
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

// ── LOCAL FALLBACK EXTRACTION ─────────────────────────────────────
// Used when Claude is unavailable or slow
const STOP_DE = new Set('der die das ein eine einen einem einer des dem den und oder aber auch nicht noch als wie wenn dann ich du er sie es wir ihr mit von zu in auf für ist sind war haben hat wird wurde werden an bei aus nach über unter durch vor seit so dass damit dabei doch sehr schon jetzt immer mehr alle hier kann dieser diese dieses kein keine keinen mich mir dich dir ihn ihm ihnen uns sich selbst man jeden jeder jedes eigentlich einfach natürlich irgendwie halt eben mal gerade quasi beim vom zur ins ans ums sein seine gewesen machen macht gemacht wäre würde hätte könnte sollte viel viele vielleicht etwas nichts alles beide ja nein okay gut ähm äh ne jo klar nämlich wobei jedoch allerdings trotzdem daher danach the and for that this with from have been will has are was were would could should may about into which when also but not'.split(' '));
const STARTERS_DE = new Set(['Aber','Auch','Dann','Doch','Sehr','Noch','Mehr','Alle','Wir','Ich','Das','Die','Der','Ein','Eine','Und','Oder','Wenn','Also','Schon','Bereits','Jetzt','Weil','Denn','Obwohl','Während','Seit','So','Was','Wie','Wo','Wer','Nun']);
const KNOWN_TERMS = new Set([
  // Business & Finance
  'KI','AI','API','CEO','CFO','CTO','CMO','COO','IPO','ESG','KPI','ROI','B2B','B2C','SaaS','CRM','ERP','SQL','NFT','LLM','GPT','NLP','OCR','DSGVO','GDPR','VC','EBIT','EBITDA','DAX','ETF',
  // Apple ecosystem
  'MacBook','MacBook Air','MacBook Pro','Mac mini','iMac','iPhone','iPad','Apple Watch','AirPods','HomePod',
  'Touch ID','Face ID','Apple Pay','Apple Intelligence','Siri','iCloud','App Store',
  'Force Touch','Multi Touch','Retina','M1','M2','M3','M4','A17','A18','A18 Pro',
  'Apple Silicon','Neural Engine','macOS','iOS','iPadOS','watchOS',
  'Thunderbolt','MagSafe','Lightning','USB-C',
  // PC & Tech
  'RAM','SSD','GPU','CPU','HDMI','USB','Bluetooth','Wi-Fi','WLAN','NFC',
  'Gigabyte','Terabyte','Megabyte','Speicherbandbreite','Prozessor','Chip',
  'Windows','Android','Linux','Chrome OS',
  'Intel','AMD','Qualcomm','ARM','NVIDIA','Samsung','Sony','Dell','HP','Lenovo','Asus',
  // Companies & Platforms
  'Google','Meta','Amazon','Microsoft','OpenAI','DeepMind','SpaceX','Tesla','Netflix','Spotify',
  'YouTube','TikTok','Instagram','WhatsApp','Telegram',
  'ChatGPT','Gemini','Copilot','Alexa',
  // Medical & Science
  'COVID','RNA','DNA','MRT','CT','HIV','KI-Modell',
  // Finance & Economy
  'EZB','FED','IMF','WHO','NATO','EU','UN','Bundestag','Bundesrat','Bundesregierung',
  // Crypto & Web3
  'Blockchain','Bitcoin','Ethereum','Web3','NFT',
]);;

function localExtract(text, existingSet) {
  // Strict fallback: only extract known acronyms/terms, nothing else
  // Heuristics cause too many false positives
  const found = new Set();
  const tokens = text.trim().split(/\s+/);
  tokens.forEach(raw => {
    const c = raw.replace(/[.,!?;:"""'„"()\[\]–—]/g,'').trim();
    if (c.length < 2) return;
    if (KNOWN_TERMS.has(c) && !existingSet.has(c)) found.add(c);
    else if (KNOWN_TERMS.has(c.toUpperCase()) && !existingSet.has(c.toUpperCase())) found.add(c.toUpperCase());
  });
  return [...found].slice(0, 3);
}

// ── KEYWORD EXTRACTION ─────────────────────────────────────────────
async function extractKeywords(text, language, existingTerms) {
  if (!text?.trim()) return [];
  const existingSet = new Set(existingTerms || []);

  // Always run local extraction as immediate fallback
  const localTerms = localExtract(text, existingSet);

  if (!ANTHROPIC_KEY) {
    console.log('⚠️  Kein Claude Key — nutze lokale Extraktion:', localTerms);
    if (localTerms.length) logFound(localTerms);
    return localTerms;
  }

  try {
    const existing = existingTerms?.length ? existingTerms.join(', ') : 'keine';
    console.log('→ Claude Anfrage für:', text.slice(0,80));
    const result = await callClaude([{
      role: 'user',
      content: `Extrahiere Fachbegriffe aus diesem Text die jemand nachschlagen würde.

Sprache: ${language}
Text: "${text}"

Einschließen: Fachbegriffe, Abkürzungen (KI/ESG/DSGVO), bedeutende Personen/Unternehmen/Organisationen, wissenschaftliche Konzepte.
Ausschließen: Alltagswörter, bereits bekannt: [${existing}]

Nur JSON-Array zurückgeben, max 4 Begriffe, keine Erklärungen.
Beispiele: ["Quantencomputing","DSGVO","BlackRock"] oder []`
    }]);

    const raw = result.content?.[0]?.text?.trim() || '[]';
    console.log('← Claude Antwort:', raw);
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) {
      console.log('Kein JSON-Array gefunden, nutze lokale Extraktion');
      if (localTerms.length) logFound(localTerms);
      return localTerms;
    }
    const terms = JSON.parse(match[0]);
    const valid = Array.isArray(terms) ? terms.filter(t => typeof t==='string' && t.trim().length>1) : [];
    if (valid.length) { logFound(valid); console.log('✓ Claude extrahiert:', valid); return valid; }
    // Claude returned empty — use local fallback
    if (localTerms.length) { logFound(localTerms); console.log('✓ Lokal extrahiert:', localTerms); }
    return localTerms;
  } catch(e) {
    console.error('❌ Claude Fehler:', e.message, '— nutze lokale Extraktion');
    if (localTerms.length) logFound(localTerms);
    return localTerms;
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

  console.log('→ Export Claude Anfrage, Modus:', mode, 'Länge:', transcript.length);
  try {
    const payload = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role:'user', content:prompt }],
    };
    const body = JSON.stringify(payload);
    const result = await new Promise((resolve, reject) => {
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
            console.log('← Export Claude Status:', parsed.type, parsed.error?.message || '');
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
    const text = result.content?.[0]?.text?.trim();
    console.log('✓ Export fertig, Länge:', text?.length || 0);
    return text || transcript;
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
