// _azure-blob.js — shared Azure Blob Storage client for OPSEC sector vaults
// Env var required: AZURE_STORAGE_CONNECTION_STRING

const { BlobServiceClient } = require('@azure/storage-blob');

// 16 InfraGard Critical Infrastructure Sectors → Azure container names
const SECTORS = {
  'chemical':                   'sector-chemical',
  'commercial-facilities':      'sector-commercial-facilities',
  'communications':             'sector-communications',
  'critical-manufacturing':     'sector-critical-manufacturing',
  'dams':                       'sector-dams',
  'defense-industrial-base':    'sector-defense-industrial-base',
  'emergency-services':         'sector-emergency-services',
  'energy':                     'sector-energy',
  'financial-services':         'sector-financial-services',
  'food-agriculture':           'sector-food-agriculture',
  'government-facilities':      'sector-government-facilities',
  'healthcare':                 'sector-healthcare',
  'information-technology':     'sector-information-technology',
  'nuclear':                    'sector-nuclear',
  'transportation-systems':     'sector-transportation-systems',
  'water-wastewater':           'sector-water-wastewater',
};

function isConfigured() {
  return !!process.env.AZURE_STORAGE_CONNECTION_STRING;
}

function getServiceClient() {
  return BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
}

function getContainerName(sector) {
  return SECTORS[sector] || null;
}

// Creates container if it doesn't exist. Always private (no public access).
async function ensureContainer(serviceClient, containerName) {
  const cc = serviceClient.getContainerClient(containerName);
  await cc.createIfNotExists({ access: 'private' });
  return cc;
}

module.exports = { isConfigured, getServiceClient, getContainerName, ensureContainer, SECTORS };
