const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  if (!SB_URL || !SB_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON body' }; }

  const { caseId } = body;
  if (!caseId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing caseId' }) };
  }

  try {
    const cases = await sbRequest('GET', SB_URL, SB_KEY, `/rest/v1/mystery_cases?id=eq.${caseId}`);
    if (!cases || !cases.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Case not found' }) };
    }

    const cas     = cases[0];
    const data    = cas.case_data;
    const culprit = (data.suspects || []).find(s => s.isGuilty);

    const resolution = {
      culprit:      culprit ? culprit.name : 'Desconocido',
      explanation:  `${culprit ? culprit.name : 'El culpable'} cometió el crimen. ${data.culprit_motive} ${data.culprit_method}`,
      vini_correct: cas.accusation_vini === (culprit ? culprit.name : ''),
      lucy_correct: cas.accusation_lucy === (culprit ? culprit.name : '')
    };

    await sbRequest('PATCH', SB_URL, SB_KEY, `/rest/v1/mystery_cases?id=eq.${caseId}`, {
      status:     'solved',
      resolution: resolution
    }, 'return=minimal');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ resolution })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

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
