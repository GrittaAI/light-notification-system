// One-time OAuth flow for the ops Gmail. Run: npm run auth
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (from a "Desktop app" OAuth client).
// Prints a refresh token to paste into .env as GOOGLE_REFRESH_TOKEN.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CALENDAR_SCOPE, createOAuthClient } from './google.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const server = createServer();

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;
  const oauth = createOAuthClient(clientId, clientSecret, redirectUri);

  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token, even on re-auth
    scope: [CALENDAR_SCOPE],
    state,
  });
  console.log('\nOpen this URL in a browser and sign in as the OPS Gmail:\n');
  console.log(url, '\n');
  console.log(`Waiting for Google to redirect to ${redirectUri} ...`);

  server.on('request', async (req, res) => {
    const params = new URL(req.url ?? '/', redirectUri).searchParams;
    const code = params.get('code');
    if (!code && !params.get('error')) {
      res.writeHead(404).end(); // e.g. /favicon.ico
      return;
    }
    const finish = (status: number, text: string, exitCode: number) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
      server.close();
      process.exitCode = exitCode;
    };
    if (params.get('error')) return finish(400, `Authorization failed: ${params.get('error')}`, 1);
    if (params.get('state') !== state) return finish(400, 'State mismatch; please retry.', 1);

    try {
      const { tokens } = await oauth.getToken(code!);
      if (!tokens.refresh_token) {
        console.error('\nNo refresh token returned. Remove the app at https://myaccount.google.com/permissions and retry.');
        return finish(500, 'No refresh token returned; see terminal.', 1);
      }
      if (!tokens.scope?.includes(CALENDAR_SCOPE)) {
        console.error(`\nWarning: granted scopes were "${tokens.scope}" — calendar access was not ticked.`);
      }
      console.log('\nSuccess. Add this line to .env:\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
      finish(200, 'Done. You can close this tab and return to the terminal.', 0);
    } catch (err) {
      console.error('\nToken exchange failed:', (err as Error).message);
      finish(500, 'Token exchange failed; see terminal.', 1);
    }
  });
});
