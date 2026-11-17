'use strict';
const axios = require('axios');

// requests carrying credentials are sent only to the selected HTTPS origin.
// in particular, never replay a token-bearing POST body after a 307/308.
async function authRequest(url, options, transport = axios) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port) throw new Error('Invalid authentication endpoint');
  try {
    const response = await transport.request({ ...options, url: endpoint.href, maxRedirects: 0, timeout: 15000,
      maxContentLength: 1024 * 1024, maxBodyLength: 1024 * 1024 });
    if (response.status >= 300 && response.status < 400) throw new Error('Authentication redirected');
    return response;
  } catch (error) {
    const status = error.response?.status;
    const safe = new Error(Number.isInteger(status) ? `Authentication HTTP ${status}` : 'Authentication request failed');
    if (Number.isInteger(status)) {
      const code = error.response?.data?.XErr;
      safe.response = { status, data: Number.isSafeInteger(code) ? { XErr: code } : {} };
    }
    throw safe;
  }
}
module.exports = { authRequest };
