// opsec-sector-write.js — vault a brief into its sector compartment
// Called after a submission clears the Gauntlet evaluation threshold.
//
// POST /.netlify/functions/opsec-sector-write
// Body: { sector, brief_id, title, score, summary, classification, submitter_id, evaluated_at }
// Returns: { container, blob, sector, brief_id }

const { isConfigured, getServiceClient, getContainerName, ensureContainer } = require('./_azure-blob');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };

  if (!isConfigured()) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Azure Blob Storage not configured.' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }

  const { sector, brief_id, title, score, summary, classification, submitter_id, evaluated_at } = body;

  if (!sector || !brief_id || !title || score === undefined) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Required: sector, brief_id, title, score.' }),
    };
  }

  const containerName = getContainerName(sector);
  if (!containerName) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Unknown sector: ${sector}` }),
    };
  }

  const brief = {
    brief_id,
    sector,
    title,
    score,
    summary: summary || '',
    classification: classification || 'UNCLASSIFIED',
    submitter_id: submitter_id || null,
    evaluated_at: evaluated_at || new Date().toISOString(),
    vaulted_at: new Date().toISOString(),
  };

  try {
    const serviceClient = getServiceClient();
    const containerClient = await ensureContainer(serviceClient, containerName);
    const blobName = `${brief_id}.json`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    const content = JSON.stringify(brief, null, 2);
    await blockBlobClient.upload(content, Buffer.byteLength(content), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: containerName, blob: blobName, sector, brief_id }),
    };
  } catch (e) {
    console.error('[opsec-sector-write]', e.message);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
