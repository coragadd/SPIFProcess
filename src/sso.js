'use strict';
// Microsoft Entra ID sign-in (OpenID Connect, authorization code flow with PKCE, confidential client).
// No library: the id_token comes straight from Microsoft's token endpoint over TLS, authenticated
// with our client secret, so (per OIDC Core 3.1.3.7) we validate its claims rather than its signature.
const crypto = require('crypto');

const TENANT = process.env.ENTRA_TENANT_ID || '91fbcd02-2a5d-4efa-9a49-b18e1732e456';
const CLIENT_ID = process.env.ENTRA_CLIENT_ID || process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET || process.env.SECRET_VALUE || '';
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`;

const enabled = () => !!(CLIENT_ID && CLIENT_SECRET);
const b64url = (b) => Buffer.from(b).toString('base64url');

function redirectUri(req) {
  if (process.env.ENTRA_REDIRECT_URI) return process.env.ENTRA_REDIRECT_URI;
  const base = process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`;
  return base + '/auth/microsoft/callback';
}

// Returns the URL to send the browser to, and the values to remember in the session.
function start(req) {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(req),
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { url: `${AUTHORITY}/oauth2/v2.0/authorize?${params}`, sso: { state, nonce, verifier } };
}

// Exchanges the code and returns { oid, email, name }. Throws an Error with a safe message on failure.
async function finish(req, saved) {
  const { code, state } = req.query;
  if (!saved || !code || !state || state !== saved.state) throw new Error('Sign-in session expired. Please try again.');
  const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri(req),
      code_verifier: saved.verifier,
      scope: 'openid profile email',
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) {
    console.error('Entra token exchange failed:', res.status, tok.error, tok.error_description);
    throw new Error('Microsoft sign-in failed. Please try again.');
  }
  const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== `${AUTHORITY}/v2.0` ||
    claims.tid !== TENANT ||
    claims.aud !== CLIENT_ID ||
    claims.nonce !== saved.nonce ||
    !claims.exp ||
    claims.exp < now - 60 ||
    !claims.oid
  ) {
    console.error('Entra id_token failed validation');
    throw new Error('Microsoft sign-in failed. Please try again.');
  }
  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  return { oid: String(claims.oid), email, name: claims.name || '' };
}

module.exports = { enabled, start, finish };
