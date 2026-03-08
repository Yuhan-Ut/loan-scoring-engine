#!/usr/bin/env node

const axios = require('axios');

function usage() {
  console.log(
    'Usage: node scripts/simulate_disbursement.js --application-id ID --status success|failed --transaction-id TXN [--base-url http://localhost:3000]',
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      result[key] = value;
      i += 1;
    }
  }

  return result;
}

async function main() {
  const { 'application-id': applicationId, status, 'transaction-id': txnId, 'base-url': baseUrl } =
    parseArgs();

  if (!applicationId || !status || !txnId) {
    usage();
    process.exit(1);
  }

  const url = (baseUrl || 'http://localhost:3000') + '/webhook/disbursement';

  const payload = {
    application_id: applicationId,
    status,
    transaction_id: txnId,
    timestamp: new Date().toISOString(),
  };

  console.log('POST', url);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  try {
    const res = await axios.post(url, payload);
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    if (err.response) {
      console.error('Error status:', err.response.status);
      console.error('Error body:', err.response.data);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

main();

