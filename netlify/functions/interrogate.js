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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON body' }; }

  const { caseId, suspectName, question, detective } = body;
  if (!caseId || !suspectName || !question || !detective) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  try {
    // Get case from Supabase
    const cases = await sbRequest('GET', SB_URL, SB_KEY, `/rest/v1/mystery_cases?id=eq.${caseId}`);
    if (!cases || !cases.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Case not found' }) };
    }
    const cas      = cases[0];
    const data     = cas.case_data;
    const suspect  = (data.suspects || []).find(s => s.name === suspectName);
    if (!suspect) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Suspect not found' }) };
    }

    // Build existing log for context
    const logs        = cas.interrogation_logs || {};
    const suspectLog  = logs[suspectName] || [];
    const historyText = suspectLog.length
      ? suspectLog.map(m => `${m.sender}: ${m.content}`).join('\n')
      : '';

    const systemPrompt = `Eres ${suspect.name}, ${suspect.role}.
Personalidad durante el interrogatorio: ${suspect.personality}
Tu secreto personal: ${suspect.secret}
Tu coartada: ${suspect.alibi}
${suspect.isGuilty
  ? 'ERES EL CULPABLE. Estás nervioso e intentas ocultarlo. Mientes sobre detalles clave pero nunca confiesas directamente. Das respuestas evasivas cuando te presionan.'
  : 'Eres inocente del crimen pero proteges tu secreto personal. Puedes mentir sobre tu secreto pero no sobre el crimen en sí.'}

Contexto del crimen: ${data.description}
${historyText ? `\nConversación anterior:\n${historyText}` : ''}

REGLAS: Responde SIEMPRE en primera persona como ${suspect.name}. Máximo 3 oraciones por respuesta. Mantén coherencia con lo dicho antes. Nunca rompas el personaje. Nunca menciones que eres una IA. Habla de forma natural según tu personalidad.

El Detective ${detective === 'vini' ? 'Vini' : 'Lucy'} te pregunta: "${question}"`;

    const answer = await callGemini(GEMINI_KEY, systemPrompt);

    // Update interrogation log
    const newLog  = [
      ...suspectLog,
      { role: 'detective', content: question,  sender: `Det. ${detective === 'vini' ? 'Vini' : 'Lucy'}` },
      { role: 'suspect',   content: answer,    sender: suspectName }
    ];
    const newLogs = { ...logs, [suspectName]: newLog };

    // Update actions and maybe pass turn
    const actField   = detective === 'vini' ? 'actions_vini' : 'actions_lucy';
    const curActions = cas[actField] || 0;
    const newActions = curActions + 1;
    const maxActions = 10;

    const updateData = {
      interrogation_logs: newLogs,
      [actField]:         newActions
    };
    if (newActions >= maxActions) {
      updateData.current_turn = detective === 'vini' ? 'lucy' : 'vini';
      updateData[actField]    = 0;
    }

    await sbRequest('PATCH', SB_URL, SB_KEY, `/rest/v1/mystery_cases?id=eq.${caseId}`, updateData, 'return=minimal');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ answer, actionsLeft: maxActions - newActions })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function callGemini(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.85, maxOutputTokens: 300 }
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
