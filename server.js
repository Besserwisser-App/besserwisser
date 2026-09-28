// Besserwisser – Server v4.2 (Neustart September 2026)
//
// Railway-Variablen:
//   DEEPGRAM_API_KEY   (Pflicht)
//   ANTHROPIC_API_KEY  (Pflicht)
//   APP_PASSWORD       (empfohlen – schützt deine API-Guthaben vor Fremdnutzung)
//   CLAUDE_MODEL_QUALITY / CLAUDE_MODEL_FAST / DEEPGRAM_HOST (optional)
//
// Lokal: DEEPGRAM_API_KEY=... ANTHROPIC_API_KEY=... node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DG_KEY = process.env.DEEPGRAM_API_KEY || '';
const AN_KEY = process.env.ANTHROPIC_API_KEY || '';
const APP_PW = process.env.APP_PASSWORD || '';
const DG_HOST = process.env.DEEPGRAM_HOST || 'api.deepgram.com';
const MODELS = {
  sonnet: process.env.CLAUDE_MODEL_QUALITY || 'claude-sonnet-5',
  haiku: process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001',
};
// Preise in US-Dollar pro Million Token – bei Preisänderungen per Railway-Variable anpassen
const PRICES = {
  [MODELS.sonnet]: { in: Number(process.env.PRICE_QUALITY_IN) || 2, out: Number(process.env.PRICE_QUALITY_OUT) || 10 },
  [MODELS.haiku]: { in: Number(process.env.PRICE_FAST_IN) || 1, out: Number(process.env.PRICE_FAST_OUT) || 5 },
};
// Deepgram: US-Dollar pro Audiominute (Schätzwert, per Variable anpassbar)
const DG_PRICE_MIN = Number(process.env.DEEPGRAM_PRICE_PER_MIN) || 0.0043;
const MAX_UPLOAD = 300 * 1024 * 1024;
const INDEX_FILE = path.join(__dirname, 'index.html');

const TYPES = {
  podcast: 'Podcast-Aufnahme',
  kunde: 'Kundengespräch',
  meeting: 'Meeting',
  interview: 'Interview',
  vortrag: 'Vortrag oder Konferenz',
  sonstiges: 'Gespräch',
};
const LEVELS = {
  laie: 'Laie – kennt die Fachbegriffe des Themas kaum',
  grund: 'Grundkenntnisse – kennt gängige Begriffe, aber keine Details',
  experte: 'Experte – braucht nur Spezialbegriffe, Namen und Neues',
};
const LANG_NAMES = {
  de: 'Deutsch', en: 'Englisch', es: 'Spanisch', fr: 'Französisch',
  tr: 'Türkisch', pl: 'Polnisch', uk: 'Ukrainisch', ar: 'Arabisch',
};

// ---------- Hilfsfunktionen ----------

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(fail(413, `Datei zu groß (max. ${Math.round(limit / 1048576)} MB).`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw fail(400, 'Ungültige Anfrage (kein JSON).');
  }
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const tail = (v, max) => { const s = String(v ?? '').trim(); return s.length > max ? s.slice(-max) : s; };
const list = (arr, max) => (Array.isArray(arr) ? arr : []).slice(0, max).map((x) => str(x, 80)).filter(Boolean);

const ROLES = {
  podcast: 'Der Nutzer ist der Gastgeber des Podcasts und führt das Gespräch. Der Gesprächspartner ist sein Gast.',
  interview: 'Der Nutzer führt das Interview. Der Gesprächspartner ist die interviewte Person.',
  kunde: 'Der Nutzer führt das Gespräch. Der Gesprächspartner ist der Kunde.',
  meeting: 'Der Nutzer nimmt am Meeting teil.',
  vortrag: 'Der Nutzer hört zu. Der Gesprächspartner hält den Vortrag.',
  sonstiges: 'Der Nutzer nimmt am Gespräch teil.',
};

function settingText(s = {}) {
  const lines = [`Situation: ${TYPES[s.type] || TYPES.sonstiges}`, `Rolle des Nutzers: ${ROLES[s.type] || ROLES.sonstiges}`];
  if (s.partner) lines.push(`Gesprächspartner: ${str(s.partner, 300)}`);
  if (s.topic) lines.push(`Thema: ${str(s.topic, 300)}`);
  if (s.goal) lines.push(`Ziel des Nutzers: ${str(s.goal, 400)}`);
  lines.push(`Vorwissen des Nutzers: ${LEVELS[s.level] || LEVELS.grund}`);
  if (s.notes) lines.push(`Weitere Hinweise: ${str(s.notes, 600)}`);
  return lines.join('\n');
}

function extractJson(text) {
  const s = String(text).replace(/```json|```/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function claudeJson({ model, system, user, maxTokens = 1200 }) {
  if (!AN_KEY) throw fail(500, 'ANTHROPIC_API_KEY fehlt auf dem Server.');
  const t0 = Date.now();
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': AN_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw fail(504, `Claude nicht erreichbar (${e.name === 'TimeoutError' ? 'Zeitüberschreitung' : e.message}).`);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `HTTP ${r.status}`;
    console.error('Claude-Fehler:', r.status, msg);
    throw fail(502, `Claude (${model}): ${msg}`);
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const json = extractJson(text);
  if (!json) {
    console.error('Claude-Antwort ohne JSON:', text.slice(0, 300));
    throw fail(502, 'Claude hat kein gültiges JSON geliefert.');
  }
  const inTok = data?.usage?.input_tokens || 0;
  const outTok = data?.usage?.output_tokens || 0;
  const p = PRICES[model] || { in: 0, out: 0 };
  const cost = (inTok * p.in + outTok * p.out) / 1e6;
  return { json, ms: Date.now() - t0, tokens: { in: inTok, out: outTok }, cost };
}

// ---------- Prompts ----------

const PREPARE_SYSTEM = `Du bereitest einen Echtzeit-Wissensassistenten auf ein Gespräch vor. Der Assistent hört mit und zeigt dem Nutzer die Begriffe, die er gerade nachschlagen möchte.

Aufgabe 1 – Vokabelliste für die Spracherkennung:
- 20 bis 40 Fachbegriffe, Abkürzungen und Eigennamen, die in diesem Gespräch wahrscheinlich fallen, jeweils 1 bis 3 Wörter, in korrekter Schreibweise.
- Bevorzuge, was eine Spracherkennung leicht falsch schreibt: Jargon, Anglizismen, Abkürzungen, Firmen-, Produkt- und Personennamen.
- Nimm die im Setting genannten Namen auf. Keine Allerweltswörter.

Aufgabe 2 – Fokus:
- Ein Satz, der beschreibt, welche Art von Begriffen für genau diesen Nutzer in diesem Gespräch nachschlagewürdig ist – abgeleitet aus Thema, Ziel und Vorwissen.

Aufgabe 3 – Themen-Cluster:
- 1 bis 5 kurze Themen (je 1 bis 3 Wörter), nach denen sich die Begriffe des Gesprächs sortieren lassen. Nennt das Setting mehrere Themen, übernimm genau diese als Cluster.

Antworte ausschließlich mit JSON:
{"keyterms": ["…"], "fokus": "…", "cluster": ["…"]}`;

function analyzeSystem(langName) {
  return `Du bist Besserwisser, ein diskreter Wissensassistent. Der Nutzer führt oder verfolgt gerade ein Gespräch. Du liest das Transkript abschnittsweise mit und wählst die wenigen Begriffe aus, die dieser Nutzer jetzt wahrscheinlich nachschlagen möchte.

Auswahl:
- Nur Begriffe aus dem Abschnitt NEU. Der KONTEXT davor dient nur dem Verständnis.
- Geeignet: Fachbegriffe, Abkürzungen und Eigennamen (Personen, Firmen, Organisationen, Produkte, Gesetze, Orte, Ereignisse), die über das Vorwissen des Nutzers hinausgehen und zum FOKUS passen.
- Ungeeignet: Alltagswörter, allgemein bekannte Begriffe, der Gesprächspartner selbst, das Oberthema aus dem Setting und alles aus BEREITS ANGEZEIGT oder IGNORIERT. IGNORIERT zeigt dir außerdem, welche Art von Begriffen der Nutzer nicht sehen will.
- WUNSCHBEGRIFFE hat der Nutzer selbst ergänzt, weil du sie übersehen hast. Sie zeigen, welche Art von Begriffen er zusätzlich sehen will.
- Begriffe, die für dieses Vorwissen leicht sind (schwierigkeit 1), nur aufnehmen, wenn sie für das Gespräch zentral sind.
- Höchstens 3 Begriffe. Kein Begriff ist besser als ein schwacher. Eine leere Liste ist eine gute Antwort.
- Die Spracherkennung macht Fehler. Erkenne falsch transkribierte Begriffe über Kontext und VOKABELLISTE und gib sie in korrekter Schreibweise aus. Wenn du nicht sicher bist, was gemeint war, lass den Begriff weg.

Erklärung, geschrieben auf ${langName} (der Begriff selbst bleibt in Originalschreibweise):
- "was": Was ist das? Höchstens 12 Wörter. Sachlich, ohne den Begriff zu wiederholen, nicht mit "Ist ein" beginnen.
- "bezug": Was bedeutet der Begriff hier, oder warum fällt er gerade? Höchstens 15 Wörter. Nur, was aus dem Transkript ableitbar ist – sonst leerer String.
- Bei Personen, Firmen oder Produkten, die du nicht sicher kennst: nichts erfinden. Beschreibe nur, was aus dem Gespräch hervorgeht, und setze "unsicher": true.

cluster: Ordne jeden Begriff einem Thema aus CLUSTER zu (exakt so geschrieben). Personen und Firmen kommen in das Thema, zu dem sie im Gespräch gehören. Nur wenn ein Begriff wirklich in keines passt, nenne ein neues, kurzes Thema (1 bis 3 Wörter) – das wird dann als neuer Cluster angelegt. Lieber ein bestehendes Thema nutzen.
relevanz: Wie wichtig ist der Begriff für das Gespräch? 3 = zentral, 2 = hilfreich, 1 = Randnotiz.
schwierigkeit: Wie wahrscheinlich kennt dieser Nutzer den Begriff mit seinem Vorwissen NICHT? 3 = kaum bekannt, 2 = vage bekannt, 1 = eher bekannt.
gehoert: das Wort, wie es im Transkript steht (für die Zeitmarke).

Antworte ausschließlich mit JSON:
{"terms":[{"term":"…","kategorie":"Fachbegriff|Abkürzung|Person|Organisation|Produkt|Gesetz|Ort|Ereignis","was":"…","bezug":"…","cluster":"…","relevanz":2,"schwierigkeit":2,"unsicher":false,"gehoert":"…"}]}`;
}

function explainSystem(langName) {
  return `Der Nutzer hat im laufenden Gespräch selbst einen Begriff markiert, den er erklärt haben will. Schreibe auf ${langName}; der Begriff selbst bleibt in Originalschreibweise.

- "term": der Begriff in korrekter Schreibweise. Wenn die Markierung offensichtlich ein Transkriptionsfehler ist, korrigiere sie über den Kontext.
- "kategorie": Fachbegriff, Abkürzung, Person, Organisation, Produkt, Gesetz, Ort oder Ereignis.
- "was": Was ist das? Höchstens 12 Wörter. Sachlich, ohne den Begriff zu wiederholen, nicht mit "Ist ein" beginnen.
- "bezug": Was bedeutet der Begriff hier, oder warum fällt er gerade? Höchstens 15 Wörter. Nur, was aus dem Gespräch ableitbar ist – sonst leerer String.
- "cluster": ein Thema aus CLUSTER (exakt so geschrieben); nur wenn keines passt, ein neues kurzes Thema.
- Wenn du den Begriff nicht sicher kennst: nichts erfinden, nur aus dem Gespräch ableiten und "unsicher": true setzen.

Antworte ausschließlich mit JSON:
{"term":"…","kategorie":"…","cluster":"…","was":"…","bezug":"…","unsicher":false}`;
}

function moreSystem(langName) {
  return `Der Nutzer hat mitten im Gespräch auf einen Begriff getippt und will etwas mehr wissen, ohne viel lesen zu müssen. Schreibe auf ${langName}.

Liefere:
- "punkte": 2 bis 3 Stichpunkte, je höchstens 15 Wörter. Nur, was nicht schon in der Kurzerklärung steht. Wähle, was dem Nutzer für sein Gesprächsziel am meisten nützt.
- "frage": Eine kurze, kluge Anschlussfrage, die der Nutzer seinem Gesprächspartner stellen könnte (höchstens 15 Wörter). Beachte die Rolle des Nutzers: Die Frage richtet sich an den Gesprächspartner, nicht an den Nutzer selbst. Leerer String, wenn es nicht passt.

Nichts erfinden. Wenn du den Begriff nicht sicher kennst, sag das in einem Punkt.

Antworte ausschließlich mit JSON:
{"punkte":["…"],"frage":"…"}`;
}

// ---------- Deepgram ----------

async function transcribe(buf, contentType, lang, keyterms) {
  if (!DG_KEY) throw fail(500, 'DEEPGRAM_API_KEY fehlt auf dem Server.');
  const kt = keyterms.slice(0, 40);
  const attempts = [];
  if (kt.length) attempts.push({ model: 'nova-3', keyterm: kt });
  attempts.push({ model: 'nova-3' });
  if (lang !== 'multi') attempts.push({ model: 'nova-2' });

  let lastError = 'unbekannt';
  for (const a of attempts) {
    const q = new URLSearchParams({
      model: a.model,
      language: lang,
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'true',
    });
    (a.keyterm || []).forEach((k) => q.append('keyterm', k));

    let r;
    try {
      r = await fetch(`https://${DG_HOST}/v1/listen?${q}`, {
        method: 'POST',
        headers: { Authorization: `Token ${DG_KEY}`, 'Content-Type': contentType },
        body: buf,
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch (e) {
      throw fail(504, `Deepgram nicht erreichbar (${e.message}).`);
    }
    const data = await r.json().catch(() => ({}));

    if (r.ok) {
      const alt = data?.results?.channels?.[0]?.alternatives?.[0];
      const words = (alt?.words || []).map((w) => [
        w.punctuated_word || w.word,
        Math.round(w.start * 100) / 100,
        Math.round(w.end * 100) / 100,
        Number.isInteger(w.speaker) ? w.speaker : 0,
      ]);
      console.log(`Transkription ok: ${a.model}${a.keyterm ? ' + Vokabelhilfe' : ''}, ${words.length} Wörter`);
      return {
        model: a.model,
        keyterms: !!a.keyterm,
        duration: data?.metadata?.duration || 0,
        cost: ((data?.metadata?.duration || 0) / 60) * DG_PRICE_MIN,
        words,
      };
    }

    lastError = data?.err_msg || data?.message || `HTTP ${r.status}`;
    console.warn(`Deepgram ${a.model}${a.keyterm ? ' + keyterm' : ''} abgelehnt:`, r.status, lastError);
    if ([401, 402, 403].includes(r.status)) {
      throw fail(502, `Deepgram verweigert den Zugriff (${r.status}): ${lastError}. Key und Guthaben prüfen.`);
    }
  }
  throw fail(502, `Deepgram: ${lastError}`);
}

// ---------- Routen ----------

async function handleApi(req, res, url) {
  if (APP_PW && req.headers['x-app-password'] !== APP_PW) {
    return send(res, 401, { error: 'Passwort erforderlich.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/prepare') {
    const b = await readJson(req);
    const lang = LANG_NAMES[b.setting?.audioLang] || 'Deutsch (oder gemischt)';
    const out = await claudeJson({
      model: MODELS.sonnet,
      system: PREPARE_SYSTEM,
      user: `${settingText(b.setting)}\nGesprochene Sprache: ${lang}`,
      maxTokens: 1200,
    });
    return send(res, 200, {
      keyterms: list(out.json.keyterms, 40),
      fokus: str(out.json.fokus || out.json.focus, 400),
      cluster: list(out.json.cluster || out.json.clusters, 5).map((c) => str(c, 30)),
      ms: out.ms,
      cost: out.cost,
      tokens: out.tokens,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/transcribe') {
    const lang = ['de', 'en', 'multi'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'de';
    let keyterms = [];
    try { keyterms = list(JSON.parse(decodeURIComponent(req.headers['x-keyterms'] || '%5B%5D')), 40); } catch {}
    const buf = await readBody(req, MAX_UPLOAD);
    if (!buf.length) throw fail(400, 'Keine Audiodaten empfangen.');
    const contentType = req.headers['content-type'] || 'audio/mpeg';
    const out = await transcribe(buf, contentType, lang, keyterms);
    return send(res, 200, out);
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    const b = await readJson(req);
    const model = MODELS[b.model] || MODELS.sonnet;
    const langName = LANG_NAMES[b.explainLang] || 'Deutsch';
    const user = [
      'SETTING:',
      settingText(b.setting),
      b.fokus ? `FOKUS: ${str(b.fokus, 400)}` : '',
      `VOKABELLISTE: ${list(b.keyterms, 40).join(', ') || '–'}`,
      `BEREITS ANGEZEIGT: ${list(b.known, 120).join(', ') || '–'}`,
      `IGNORIERT: ${list(b.ignored, 80).join(', ') || '–'}`,
      `WUNSCHBEGRIFFE: ${list(b.wanted, 40).join(', ') || '–'}`,
      `CLUSTER: ${list(b.clusters, 7).join(', ') || '–'}`,
      '',
      'KONTEXT:',
      tail(b.context, 6000) || '–',
      '',
      'NEU:',
      str(b.segment, 5000),
    ].filter((l) => l !== null).join('\n');

    const out = await claudeJson({ model, system: analyzeSystem(langName), user, maxTokens: 1200 });
    const terms = (Array.isArray(out.json.terms) ? out.json.terms : [])
      .filter((t) => t && t.term)
      .slice(0, 3)
      .map((t) => ({
        term: str(t.term, 80),
        kategorie: str(t.kategorie, 30) || 'Fachbegriff',
        cluster: str(t.cluster, 30),
        was: str(t.was, 200),
        bezug: str(t.bezug, 220),
        relevanz: Math.min(3, Math.max(1, parseInt(t.relevanz, 10) || 2)),
        schwierigkeit: Math.min(3, Math.max(1, parseInt(t.schwierigkeit, 10) || 2)),
        unsicher: !!t.unsicher,
        gehoert: str(t.gehoert, 80),
      }));
    return send(res, 200, { terms, ms: out.ms, model, cost: out.cost, tokens: out.tokens });
  }

  if (req.method === 'POST' && url.pathname === '/api/more') {
    const b = await readJson(req);
    const langName = LANG_NAMES[b.explainLang] || 'Deutsch';
    const user = [
      'SETTING:',
      settingText(b.setting),
      '',
      `BEGRIFF: ${str(b.term, 80)}`,
      `KURZERKLÄRUNG: ${str(b.was, 200)}`,
      b.bezug ? `IM GESPRÄCH: ${str(b.bezug, 220)}` : '',
      '',
      'GESPRÄCHSAUSSCHNITT:',
      tail(b.context, 4000) || '–',
    ].join('\n');
    const out = await claudeJson({ model: MODELS.sonnet, system: moreSystem(langName), user, maxTokens: 700 });
    return send(res, 200, {
      punkte: (Array.isArray(out.json.punkte) ? out.json.punkte : []).slice(0, 3).map((p) => str(p, 240)).filter(Boolean),
      frage: str(out.json.frage, 240),
      ms: out.ms,
      cost: out.cost,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/explain') {
    const b = await readJson(req);
    const model = MODELS[b.model] || MODELS.haiku;
    const langName = LANG_NAMES[b.explainLang] || 'Deutsch';
    const term = str(b.term, 80);
    if (!term) throw fail(400, 'Kein Begriff markiert.');
    const user = [
      'SETTING:',
      settingText(b.setting),
      '',
      `MARKIERT: ${term}`,
      `CLUSTER: ${list(b.clusters, 7).join(', ') || '–'}`,
      '',
      'GESPRÄCHSAUSSCHNITT:',
      tail(b.context, 3000) || '–',
    ].join('\n');
    const out = await claudeJson({ model, system: explainSystem(langName), user, maxTokens: 400 });
    const j = out.json;
    return send(res, 200, {
      term: str(j.term, 80) || term,
      kategorie: str(j.kategorie, 30) || 'Fachbegriff',
      cluster: str(j.cluster, 30),
      was: str(j.was, 200),
      bezug: str(j.bezug, 220),
      unsicher: !!j.unsicher,
      cost: out.cost,
    });
  }

  return send(res, 404, { error: 'Unbekannter Endpunkt.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { version: '4.2', deepgram: !!DG_KEY, anthropic: !!AN_KEY, passwort: !!APP_PW, modelle: MODELS, preise: PRICES, deepgramProMinute: DG_PRICE_MIN });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nicht gefunden');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'Serverfehler.' });
  }
});

server.requestTimeout = 20 * 60 * 1000;

server.listen(PORT, () => {
  console.log(`Besserwisser v4.2 läuft auf Port ${PORT}`);
  console.log(`Deepgram: ${DG_KEY ? 'ok' : 'FEHLT'} | Claude: ${AN_KEY ? 'ok' : 'FEHLT'} | Passwort: ${APP_PW ? 'aktiv' : 'aus'}`);
  console.log(`Modelle: ${MODELS.sonnet} / ${MODELS.haiku}`);
});
