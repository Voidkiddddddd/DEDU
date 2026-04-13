const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SB_URL     = process.env.SUPABASE_URL;
  const SB_KEY     = process.env.SUPABASE_KEY;

  if (!GEMINI_KEY || !SB_URL || !SB_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  const genres = [
    'Noir de los años 40',
    'Misterio victoriano',
    'Thriller psicológico moderno',
    'Horror gótico',
    'Crimen de alta sociedad'
  ];
  const genre = genres[Math.floor(Math.random() * genres.length)];

  const prompt = `Eres el narrador de un juego de misterio interactivo en español. Genera un caso de asesinato completo y original en el género: "${genre}".

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta (sin bloques de código, sin texto adicional, solo el JSON puro):
{
  "title": "Título evocador del caso en máximo 8 palabras",
  "tagline": "Frase de gancho tono oscuro en máximo 20 palabras",
  "genre": "${genre}",
  "description": "Descripción del crimen en 3 o 4 oraciones. Incluye víctima, lugar y circunstancias misteriosas.",
  "culprit": "Nombre exacto del culpable que debe coincidir con uno de los sospechosos",
  "culprit_motive": "El motivo real del culpable explicado en detalle",
  "culprit_method": "Cómo cometió el crimen exactamente",
  "clues": [
    {"title": "Nombre pista 1", "description": "Descripción detallada en 1 o 2 oraciones", "isNew": true},
    {"title": "Nombre pista 2", "description": "Descripción detallada en 1 o 2 oraciones", "isNew": false},
    {"title": "Nombre pista 3", "description": "Descripción detallada en 1 o 2 oraciones", "isNew": true},
    {"title": "Nombre pista 4", "description": "Descripción detallada en 1 o 2 oraciones", "isNew": false}
  ],
  "suspects": [
    {
      "name": "Nombre completo sospechoso 1",
      "role": "Relación con la víctima u ocupación",
      "emoji": "🧑",
      "description": "Descripción breve con algo sospechoso sobre esta persona",
      "personality": "Cómo habla y se comporta en interrogatorios",
      "secret": "Su secreto que puede o no estar relacionado con el crimen",
      "alibi": "Su coartada verdadera o falsa",
      "isGuilty": false
    },
    {
      "name": "Nombre completo sospechoso 2",
      "role": "Relación con la víctima u ocupación",
      "emoji": "👩",
      "description": "Descripción breve con algo sospechoso",
      "personality": "Cómo habla y se comporta en interrogatorios",
      "secret": "Su secreto",
      "alibi": "Su coartada",
      "isGuilty": false
    },
    {
      "name": "Nombre completo sospechoso 3",
      "role": "Relación con la víctima u ocupación",
      "emoji": "👴",
      "description": "Descripción breve con algo sospechoso",
      "personality": "Cómo habla y se comporta en interrogatorios",
      "secret": "Su secreto",
      "alibi": "Su coartada",
      "isGuilty": false
    },
    {
      "name": "Nombre completo culpable",
      "role": "Relación con la víctima u ocupación",
      "emoji": "🕵️",
      "description": "Descripción breve con algo sospechoso",
      "personality": "Cómo habla y se comporta en interrogatorios",
      "secret": "Su secreto real que es el motivo del crimen",
      "alibi": "Su coartada falsa",
      "isGuilty": true
    }
  ]
}

REGLAS: exactamente 4 sospechosos, uno con isGuilty true cuyo name coincide exactamente con culprit, responde SOLO el JSON puro sin ningún texto adicional`;

  try {
    const geminiText = await callGemini(GEMINI_KEY, prompt);

    let caseData;
    try {
      const clean = geminiText.replace(/```json/gi, '').replace(/```/g, '').trim();
      caseData = JSON.parse(clean);
    } catch (parseErr) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'JSON parse error', raw: geminiText.substring(0, 500) })
      };
    }

    const caseRecord = {
      case_data:          caseData,
      status:             'open',
      current_turn:       'vini',
      actions_vini:       0,
      actions_lucy:       0,
      interrogation_logs: {},
      accusation_vini:    null,
      accusation_lucy:    null,
      resolution:         null
    };

    const saved = await sbRequest('POST', SB_URL, SB_KEY, '/rest/v1/mystery_cases', caseRecord, 'return=representation');
    const row   = Array.isArray(saved) ? saved[0] : saved;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ case: row })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function callGemini(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 2048 }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) { reject(new Error('Gemini error: ' + JSON.stringify(p.error))); return; }
          resolve(p.candidates[0].content.parts[0].text);
        } catch (e) {
          reject(new Error('Gemini parse error: ' + data.substring(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sbRequest(method, sbUrl, sbKey, path, body, prefer) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const urlObj  = new URL(sbUrl);
    const headers = {
      'apikey':        sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type':  'application/json'
    };
    if (prefer)  headers['Prefer'] = prefer;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request({
      hostname: urlObj.hostname,
      path:     path,
      method:   method,
      headers:  headers
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : true); }
          catch { resolve(true); }
        } else {
          reject(new Error(`Supabase ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
