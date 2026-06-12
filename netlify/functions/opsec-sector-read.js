// opsec-sector-read.js — read from a sector vault compartment
//
// GET /.netlify/functions/opsec-sector-read?sector=energy
//   → lists all vaulted briefs in that sector (metadata only)
//
// GET /.netlify/functions/opsec-sector-read?sector=energy&id=abc123
//   → returns full brief content for that brief_id

const { isConfigured, getServiceClient, getContainerName, ensureContainer } = require('./_azure-blob');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: 'GET only' };

  if (!isConfigured()) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Azure Blob Storage not configured.' }),
    };
  }

  const { sector, id } = event.queryStringParameters || {};

  if (!sector) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Required query param: sector' }),
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

  try {
    const serviceClient = getServiceClient();
    const containerClient = await ensureContainer(serviceClient, containerName);

    if (id) {
      // Return single brief
      const blobName = `${id}.json`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      const download = await blockBlobClient.download(0);
      const chunks = [];
      for await (const chunk of download.readableStreamBody) chunks.push(chunk);
      const content = JSON.parse(Buffer.concat(chunks).toString());
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      };
    }

    // List all briefs in this sector compartment
    const items = [];
    for await (const blob of containerClient.listBlobsFlat()) {
      items.push({
        brief_id: blob.name.replace('.json', ''),
        name: blob.name,
        last_modified: blob.properties.lastModified,
        size: blob.properties.contentLength,
      });
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sector, container: containerName, count: items.length, items }),
    };
  } catch (e) {
    console.error('[opsec-sector-read]', e.message);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
