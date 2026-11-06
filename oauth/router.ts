import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

export type RawchunksOAuthProvider = 'google' | 'github' | 'discord' | 'x' | 'telegram';

export interface VerifiedOAuthProfile {
  platform: RawchunksOAuthProvider;
  providerId: string;
  providerUserId: string;
  handle: string;
  url: string;
  email?: string | null;
  name?: string | null;
  avatar?: string | null;
  authIdentifier?: string | null;
}

interface OAuthStatePayload {
  provider: RawchunksOAuthProvider;
  clientId: string;
  origin?: string;
  codeVerifier?: string;
  iat: number;
}

const THIRDWEB_IN_APP_BASE_URL = 'https://embedded-wallet.thirdweb.com';
const STATE_TTL_MS = 15 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getOAuthConfig() {
  const apiBaseUrl = requireEnv('API_BASE_URL').replace(/\/+$/, '');

  const googleClientId = requireEnv('OAUTH_GCLOUD_CLIENT_ID');
  const googleClientSecret = requireEnv('OAUTH_GCLOUD_CLIENT_SECRET');

  const githubClientId = requireEnv('OAUTH_GITHUB_CLIENT_ID');
  const githubClientSecret = requireEnv('OAUTH_GITHUB_CLIENT_SECRET');

  const discordApplicationId = requireEnv('OAUTH_DISCORD_APPLICATION_ID');
  const discordPublicKey = requireEnv('OAUTH_DISCORD_PUBLIC_KEY');
  const discordClientId = requireEnv('OAUTH_DISCORD_CLIENT_ID');
  const discordClientSecret = requireEnv('OAUTH_DISCORD_CLIENT_SECRET');

  const xAppId = requireEnv('OAUTH_X_APP_ID');
  const xBearerToken = requireEnv('OAUTH_X_BEARER_TOKEN');
  const xAccessToken = requireEnv('OAUTH_X_ACCESS_TOKEN');
  const xAccessTokenSecret = requireEnv('OAUTH_X_ACCESS_TOKEN_SECRET');
  const xClientId = requireEnv('OAUTH_X_CLIENT_ID');
  const xClientSecret = requireEnv('OAUTH_X_CLIENT_SECRET');

  const telegramAccessToken = requireEnv('OAUTH_TELEGRAM_ACCESS_TOKEN');
  const telegramBotName = requireEnv('OAUTH_TELEGRAM_BOT_NAME');
  const telegramBotId = telegramAccessToken.split(':')[0].trim();

  return {
    apiBaseUrl,
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    },
    github: {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
    },
    discord: {
      applicationId: discordApplicationId,
      publicKey: discordPublicKey,
      clientId: discordClientId,
      clientSecret: discordClientSecret,
    },
    x: {
      appId: xAppId,
      bearerToken: xBearerToken,
      accessToken: xAccessToken,
      accessTokenSecret: xAccessTokenSecret,
      clientId: xClientId,
      clientSecret: xClientSecret,
    },
    telegram: {
      botId: telegramBotId,
      botName: telegramBotName,
      accessToken: telegramAccessToken,
    },
  };
}

function getProviderSecret(provider: RawchunksOAuthProvider): string {
  const config = getOAuthConfig();
  switch (provider) {
    case 'google':
      return config.google.clientSecret;
    case 'github':
      return config.github.clientSecret;
    case 'discord':
      return config.discord.clientSecret;
    case 'x':
      return config.x.clientSecret;
    case 'telegram':
      return config.telegram.accessToken;
  }
}

export function signOAuthState(payload: OAuthStatePayload): string {
  const secret = getProviderSecret(payload.provider);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyOAuthState(
  stateToken: string,
  expectedProvider: RawchunksOAuthProvider
): OAuthStatePayload | null {
  if (!stateToken || !stateToken.includes('.')) return null;
  const [encoded, sig] = stateToken.split('.');
  if (!encoded || !sig) return null;
  const secret = getProviderSecret(expectedProvider);
  const expectedSig = createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload;
    if (!parsed || parsed.provider !== expectedProvider || typeof parsed.iat !== 'number') {
      return null;
    }
    if (Date.now() - parsed.iat > STATE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deriveDeterministicSessionId(
  provider: RawchunksOAuthProvider,
  providerUserId: string
): string {
  const normalizedId = String(providerUserId).trim().toLowerCase();
  if (!normalizedId) {
    throw new Error(`Missing user identifier for ${provider}`);
  }
  const secret = getProviderSecret(provider);
  return createHmac('sha256', secret)
    .update(`rawchunks:oauth:${provider}:${normalizedId}`)
    .digest('hex');
}

export async function mintThirdwebAuthResult(params: {
  provider: RawchunksOAuthProvider;
  providerUserId: string;
  clientId: string;
}): Promise<any> {
  const resolvedClientId = params.clientId.trim();
  const sessionId = deriveDeterministicSessionId(params.provider, params.providerUserId);
  const url = `${THIRDWEB_IN_APP_BASE_URL}/api/2024-05-05/login/guest/callback?clientId=${encodeURIComponent(
    resolvedClientId
  )}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': resolvedClientId,
    },
    body: JSON.stringify({ sessionId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Thirdweb enclave session issuance failed (${res.status}): ${text}`);
  }

  return await res.json();
}

export function verifyTelegramAuthData(
  authData: Record<string, any>,
  botToken: string
): VerifiedOAuthProfile {
  const hash = String(authData.hash || '').trim();
  if (!hash) {
    throw new Error('Missing Telegram authorization hash');
  }

  const checkEntries: string[] = [];
  for (const key of Object.keys(authData).sort()) {
    if (key === 'hash') continue;
    const val = authData[key];
    if (val === undefined || val === null) continue;
    checkEntries.push(`${key}=${val}`);
  }
  const dataCheckString = checkEntries.join('\n');
  const secretKey = createHash('sha256').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(computedHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid Telegram authorization signature');
  }

  const providerUserId = String(authData.id || '').trim();
  if (!providerUserId) {
    throw new Error('Missing Telegram user ID');
  }

  const username = String(authData.username || '').trim();
  const firstName = String(authData.first_name || '').trim();
  const lastName = String(authData.last_name || '').trim();
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || username || providerUserId;
  const handle = username ? `@${username.replace(/^@+/, '')}` : `@${providerUserId}`;
  const url = username
    ? `https://t.me/${encodeURIComponent(username.replace(/^@+/, ''))}`
    : `https://t.me/${encodeURIComponent(providerUserId)}`;

  return {
    platform: 'telegram',
    providerId: `telegram:${providerUserId.toLowerCase()}`,
    providerUserId,
    handle,
    url,
    name: displayName,
    avatar: authData.photo_url ? String(authData.photo_url) : null,
  };
}

async function exchangeGoogleCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<VerifiedOAuthProfile> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
    }),
  });

  const tokenData = (await tokenRes.json()) as any;
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description || tokenData.error || 'Failed to exchange Google OAuth code'
    );
  }

  const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const user = (await userRes.json()) as any;
  if (!userRes.ok || !user.sub) {
    throw new Error('Failed to fetch Google user profile');
  }

  const email = String(user.email || '').trim();
  const providerUserId = String(user.sub).trim();
  const handle = email || user.name || providerUserId;

  return {
    platform: 'google',
    providerId: `google:${(email || providerUserId).toLowerCase()}`,
    providerUserId,
    handle,
    url: email ? `mailto:${email}` : 'https://accounts.google.com',
    email: email || null,
    name: user.name ? String(user.name) : null,
    avatar: user.picture ? String(user.picture) : null,
  };
}

async function exchangeGithubCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<VerifiedOAuthProfile> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });

  const tokenData = (await tokenRes.json()) as any;
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description || tokenData.error || 'Failed to exchange GitHub OAuth code'
    );
  }

  const headers = {
    Authorization: `Bearer ${tokenData.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'RawChunks-OAuth',
  };

  const userRes = await fetch('https://api.github.com/user', { headers });
  const user = (await userRes.json()) as any;
  if (!userRes.ok || !user.id) {
    throw new Error('Failed to fetch GitHub user profile');
  }

  let email: string | null = user.email ? String(user.email) : null;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary?: boolean;
        verified?: boolean;
      }>;
      const primary =
        emails.find((e) => e.primary && e.verified) ||
        emails.find((e) => e.verified) ||
        emails[0];
      if (primary?.email) email = primary.email;
    }
  }

  const login = String(user.login || user.id).trim();
  const providerUserId = String(user.id).trim();

  return {
    platform: 'github',
    providerId: `github:${login.toLowerCase()}`,
    providerUserId,
    handle: `@${login.replace(/^@+/, '')}`,
    url: `https://github.com/${encodeURIComponent(login.replace(/^@+/, ''))}`,
    email,
    name: user.name ? String(user.name) : login,
    avatar: user.avatar_url ? String(user.avatar_url) : null,
  };
}

async function exchangeDiscordCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<VerifiedOAuthProfile> {
  const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
    }),
  });

  const tokenData = (await tokenRes.json()) as any;
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description || tokenData.error || 'Failed to exchange Discord OAuth code'
    );
  }

  const userRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const user = (await userRes.json()) as any;
  if (!userRes.ok || !user.id) {
    throw new Error('Failed to fetch Discord user profile');
  }

  const providerUserId = String(user.id).trim();
  const username = String(user.username || providerUserId).trim();
  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${providerUserId}/${user.avatar}.png`
    : null;

  return {
    platform: 'discord',
    providerId: `discord:${providerUserId.toLowerCase()}`,
    providerUserId,
    handle: `@${username.replace(/^@+/, '')}`,
    url: `https://discord.com/users/${encodeURIComponent(providerUserId)}`,
    email: user.email ? String(user.email) : null,
    name: user.global_name ? String(user.global_name) : username,
    avatar: avatarUrl,
  };
}

async function exchangeXCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
}): Promise<VerifiedOAuthProfile> {
  const basicAuth = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      client_id: params.clientId,
      code: params.code,
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  });

  const tokenData = (await tokenRes.json()) as any;
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description || tokenData.error || 'Failed to exchange X OAuth code'
    );
  }

  const userRes = await fetch(
    'https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url',
    {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    }
  );
  const userPayload = (await userRes.json()) as any;
  const user = userPayload?.data;
  if (!userRes.ok || !user?.id) {
    throw new Error('Failed to fetch X user profile');
  }

  const providerUserId = String(user.id).trim();
  const username = String(user.username || providerUserId).trim();

  return {
    platform: 'x',
    providerId: `x:${username.toLowerCase()}`,
    providerUserId,
    handle: `@${username.replace(/^@+/, '')}`,
    url: `https://x.com/${encodeURIComponent(username.replace(/^@+/, ''))}`,
    name: user.name ? String(user.name) : username,
    avatar: user.profile_image_url ? String(user.profile_image_url) : null,
  };
}

function renderPopupResultHtml(params: {
  success: boolean;
  authResult?: any;
  socialProfile?: VerifiedOAuthProfile;
  errorString?: string;
}): string {
  const payloadJson = JSON.stringify({
    source: 'rawchunks-oauth',
    eventType: params.success ? 'oauthSuccessResult' : 'oauthFailureResult',
    authResult: params.authResult,
    socialProfile: params.socialProfile,
    errorString: params.errorString,
  }).replace(/</g, '\\u003c');

  const statusText = params.success
    ? 'CONNECTED TO RAWCHUNKS'
    : `AUTHENTICATION FAILED: ${params.errorString}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RawChunks Authentication</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #06060a;
      color: #f4f4f6;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-align: center;
      padding: 24px;
    }
    .card {
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.03);
      padding: 24px 28px;
      max-width: 360px;
    }
    .brand {
      font-size: 13px;
      letter-spacing: 0.18em;
      color: #00f5d4;
      margin-bottom: 10px;
      font-weight: 700;
    }
    .status {
      font-size: 12px;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.8);
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">RAWCHUNKS</div>
    <div class="status">${statusText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  </div>
  <script>
    (function () {
      var payload = ${payloadJson};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, "*");
        }
      } catch (e) {}
      setTimeout(function () {
        try { window.close(); } catch (e) {}
      }, 150);
    })();
  </script>
</body>
</html>`;
}

function renderTelegramCallbackHtml(state: string): string {
  const safeState = JSON.stringify(state);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RawChunks Telegram Authentication</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #06060a;
      color: #f4f4f6;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .card {
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.03);
      padding: 24px 28px;
      text-align: center;
    }
    .brand {
      font-size: 13px;
      letter-spacing: 0.18em;
      color: #00f5d4;
      margin-bottom: 8px;
      font-weight: 700;
    }
    .status {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.8);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">RAWCHUNKS</div>
    <div class="status" id="status">VERIFYING TELEGRAM ACCOUNT...</div>
  </div>
  <script>
    (function () {
      var state = ${safeState};
      var hash = window.location.hash || "";
      var match = hash.match(/[#?&]tgAuthResult=([A-Za-z0-9\\-_=]+)/);
      var tgAuthResult = match ? match[1] : null;
      if (!tgAuthResult) {
        var params = new URLSearchParams(window.location.search);
        if (params.get("id") && params.get("hash")) {
          var obj = {};
          params.forEach(function (v, k) {
            if (k !== "state") obj[k] = v;
          });
          tgAuthResult = obj;
        }
      }
      if (!tgAuthResult) {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({
            source: "rawchunks-oauth",
            eventType: "oauthFailureResult",
            errorString: "Telegram authentication cancelled"
          }, "*");
        }
        setTimeout(function () { window.close(); }, 200);
        return;
      }
      fetch("/api/oauth/telegram/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: state, tgAuthResult: tgAuthResult })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.data.error || "Telegram verification failed");
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({
              source: "rawchunks-oauth",
              eventType: "oauthSuccessResult",
              authResult: res.data.authResult,
              socialProfile: res.data.socialProfile
            }, "*");
          }
          document.getElementById("status").textContent = "CONNECTED TO RAWCHUNKS";
          setTimeout(function () { window.close(); }, 150);
        })
        .catch(function (err) {
          var msg = err && err.message ? err.message : "Telegram verification failed";
          document.getElementById("status").textContent = msg;
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({
              source: "rawchunks-oauth",
              eventType: "oauthFailureResult",
              errorString: msg
            }, "*");
          }
          setTimeout(function () { window.close(); }, 1200);
        });
    })();
  </script>
</body>
</html>`;
}

export async function oauthRouter(app: FastifyInstance) {
  app.get('/:provider/start', async (req: FastifyRequest, reply: FastifyReply) => {
    const { provider } = req.params as { provider: string };
    const query = (req.query || {}) as { clientId?: string; origin?: string };
    const normalized = provider.toLowerCase() as RawchunksOAuthProvider;
    const config = getOAuthConfig();
    const clientId = (query.clientId ?? '').trim();
    if (!clientId) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          renderPopupResultHtml({
            success: false,
            errorString: 'Missing clientId',
          })
        );
    }

    if (normalized === 'google') {
      const state = signOAuthState({
        provider: 'google',
        clientId,
        origin: query.origin,
        iat: Date.now(),
      });
      const redirectUri = `${config.apiBaseUrl}/api/oauth/google/callback`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', config.google.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('prompt', 'select_account');
      authUrl.searchParams.set('state', state);
      return reply.redirect(authUrl.toString());
    }

    if (normalized === 'github') {
      const state = signOAuthState({
        provider: 'github',
        clientId,
        origin: query.origin,
        iat: Date.now(),
      });
      const redirectUri = `${config.apiBaseUrl}/api/oauth/github/callback`;
      const authUrl = new URL('https://github.com/login/oauth/authorize');
      authUrl.searchParams.set('client_id', config.github.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'read:user user:email');
      authUrl.searchParams.set('state', state);
      return reply.redirect(authUrl.toString());
    }

    if (normalized === 'discord') {
      const state = signOAuthState({
        provider: 'discord',
        clientId,
        origin: query.origin,
        iat: Date.now(),
      });
      const redirectUri = `${config.apiBaseUrl}/api/oauth/discord/callback`;
      const authUrl = new URL('https://discord.com/oauth2/authorize');
      authUrl.searchParams.set('client_id', config.discord.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'identify email');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('state', state);
      return reply.redirect(authUrl.toString());
    }

    if (normalized === 'x') {
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      const state = signOAuthState({
        provider: 'x',
        clientId,
        origin: query.origin,
        codeVerifier,
        iat: Date.now(),
      });
      const redirectUri = `${config.apiBaseUrl}/api/oauth/x/callback`;
      const authUrl = new URL('https://x.com/i/oauth2/authorize');
      authUrl.searchParams.set('client_id', config.x.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'tweet.read users.read offline.access');
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);
      return reply.redirect(authUrl.toString());
    }

    if (normalized === 'telegram') {
      const state = signOAuthState({
        provider: 'telegram',
        clientId,
        origin: query.origin,
        iat: Date.now(),
      });
      const returnTo = `${config.apiBaseUrl}/api/oauth/telegram/callback?state=${encodeURIComponent(state)}`;
      const authUrl = new URL('https://oauth.telegram.org/auth');
      authUrl.searchParams.set('bot_id', config.telegram.botId);
      authUrl.searchParams.set('origin', config.apiBaseUrl);
      authUrl.searchParams.set('embed', '1');
      authUrl.searchParams.set('request_access', 'write');
      authUrl.searchParams.set('return_to', returnTo);
      return reply.redirect(authUrl.toString());
    }

    return reply
      .code(400)
      .type('text/html; charset=utf-8')
      .send(
        renderPopupResultHtml({
          success: false,
          errorString: `Unsupported OAuth provider: ${provider}`,
        })
      );
  });

  app.get('/:provider/callback', async (req: FastifyRequest, reply: FastifyReply) => {
    const { provider } = req.params as { provider: string };
    const query = (req.query || {}) as Record<string, string | undefined>;
    const normalized = provider.toLowerCase() as RawchunksOAuthProvider;
    const config = getOAuthConfig();

    if (query.error) {
      return reply
        .type('text/html; charset=utf-8')
        .send(
          renderPopupResultHtml({
            success: false,
            errorString: query.error_description || query.error,
          })
        );
    }

    const statePayload = query.state ? verifyOAuthState(query.state, normalized) : null;
    if (!statePayload) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          renderPopupResultHtml({
            success: false,
            errorString: 'Invalid or expired OAuth state',
          })
        );
    }

    if (normalized === 'telegram') {
      if (query.id && query.hash) {
        try {
          const socialProfile = verifyTelegramAuthData(query, config.telegram.accessToken);
          const authResult = await mintThirdwebAuthResult({
            provider: 'telegram',
            providerUserId: socialProfile.providerUserId,
            clientId: statePayload.clientId,
          });
          socialProfile.authIdentifier =
            authResult?.storedToken?.authDetails?.authIdentifier || null;
          return reply
            .type('text/html; charset=utf-8')
            .send(renderPopupResultHtml({ success: true, authResult, socialProfile }));
        } catch (err: any) {
          return reply
            .code(400)
            .type('text/html; charset=utf-8')
            .send(
              renderPopupResultHtml({
                success: false,
                errorString: err instanceof Error ? err.message : 'Telegram authentication failed',
              })
            );
        }
      }
      return reply.type('text/html; charset=utf-8').send(renderTelegramCallbackHtml(query.state!));
    }

    const code = (query.code || '').trim();
    if (!code) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          renderPopupResultHtml({
            success: false,
            errorString: 'Missing authorization code',
          })
        );
    }

    try {
      const redirectUri = `${config.apiBaseUrl}/api/oauth/${normalized}/callback`;
      let socialProfile: VerifiedOAuthProfile;

      if (normalized === 'google') {
        socialProfile = await exchangeGoogleCode({
          code,
          redirectUri,
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
        });
      } else if (normalized === 'github') {
        socialProfile = await exchangeGithubCode({
          code,
          redirectUri,
          clientId: config.github.clientId,
          clientSecret: config.github.clientSecret,
        });
      } else if (normalized === 'discord') {
        socialProfile = await exchangeDiscordCode({
          code,
          redirectUri,
          clientId: config.discord.clientId,
          clientSecret: config.discord.clientSecret,
        });
      } else if (normalized === 'x') {
        if (!statePayload.codeVerifier) {
          throw new Error('Missing PKCE verifier for X OAuth');
        }
        socialProfile = await exchangeXCode({
          code,
          redirectUri,
          clientId: config.x.clientId,
          clientSecret: config.x.clientSecret,
          codeVerifier: statePayload.codeVerifier,
        });
      } else {
        throw new Error(`Unsupported OAuth callback provider: ${normalized}`);
      }

      const authResult = await mintThirdwebAuthResult({
        provider: normalized,
        providerUserId: socialProfile.providerUserId,
        clientId: statePayload.clientId,
      });
      socialProfile.authIdentifier = authResult?.storedToken?.authDetails?.authIdentifier || null;

      return reply
        .type('text/html; charset=utf-8')
        .send(renderPopupResultHtml({ success: true, authResult, socialProfile }));
    } catch (err: any) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          renderPopupResultHtml({
            success: false,
            errorString: err instanceof Error ? err.message : 'OAuth exchange failed',
          })
        );
    }
  });

  app.post('/google/exchange', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body || {}) as {
      code?: string;
      redirectUri?: string;
      clientId?: string;
    };
    const config = getOAuthConfig();
    const code = (body.code || '').trim();
    if (!code) {
      return reply.code(400).send({ error: 'Missing Google authorization code' });
    }
    const redirectUri = (body.redirectUri || '').trim();
    if (!redirectUri) {
      return reply.code(400).send({ error: 'Missing redirectUri' });
    }
    try {
      const socialProfile = await exchangeGoogleCode({
        code,
        redirectUri,
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
      });
      const clientId = (body.clientId ?? '').trim();
      if (!clientId) {
        return reply.code(400).send({ error: 'Missing clientId' });
      }
      const authResult = await mintThirdwebAuthResult({
        provider: 'google',
        providerUserId: socialProfile.providerUserId,
        clientId,
      });
      socialProfile.authIdentifier = authResult?.storedToken?.authDetails?.authIdentifier ?? null;
      return { authResult, socialProfile };
    } catch (err: any) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : 'Google OAuth exchange failed' });
    }
  });

  app.post('/telegram/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body || {}) as {
      state?: string;
      tgAuthResult?: string | Record<string, any>;
      clientId?: string;
    };
    const config = getOAuthConfig();

    let resolvedClientId = (body.clientId ?? '').trim();
    if (body.state) {
      const statePayload = verifyOAuthState(body.state, 'telegram');
      if (!statePayload) {
        return reply.code(400).send({ error: 'Invalid or expired Telegram OAuth state' });
      }
      resolvedClientId = statePayload.clientId;
    }
    if (!resolvedClientId) {
      return reply.code(400).send({ error: 'Missing clientId' });
    }

    let authData: Record<string, any> | null = null;
    if (typeof body.tgAuthResult === 'string' && body.tgAuthResult.trim()) {
      try {
        const parsed = JSON.parse(
          Buffer.from(body.tgAuthResult.trim(), 'base64url').toString('utf8')
        );
        if (parsed && typeof parsed === 'object') authData = parsed;
      } catch {
        return reply.code(400).send({ error: 'Malformed tgAuthResult payload' });
      }
    } else if (body.tgAuthResult && typeof body.tgAuthResult === 'object') {
      authData = body.tgAuthResult;
    }

    if (!authData) {
      return reply.code(400).send({ error: 'Missing Telegram authorization data' });
    }

    try {
      const socialProfile = verifyTelegramAuthData(authData, config.telegram.accessToken);
      const authResult = await mintThirdwebAuthResult({
        provider: 'telegram',
        providerUserId: socialProfile.providerUserId,
        clientId: resolvedClientId,
      });
      socialProfile.authIdentifier = authResult?.storedToken?.authDetails?.authIdentifier || null;
      return { authResult, socialProfile };
    } catch (err: any) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : 'Telegram verification failed' });
    }
  });
}
