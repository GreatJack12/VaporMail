/**
 * ════════════════════════════════════════════════════════════════════
 *  VAPORMAIL — Cloudflare Email Worker  (the free "backend")
 * ════════════════════════════════════════════════════════════════════
 *  GitHub Pages can't run server code, so this Worker is the entire
 *  processing layer. Cloudflare Email Routing hands it every message
 *  sent to your domain; it parses the raw MIME and writes clean JSON
 *  into a Supabase table that the static frontend polls via REST.
 *
 *  Flow:   someone@anywhere ──SMTP──▶ Cloudflare Email Routing
 *          ──▶ this Worker (parse MIME ➜ JSON)
 *          ──▶ POST https://<project>.supabase.co/rest/v1/emails
 *          ──▶ index.html polls that table every 5 s with the anon key
 *
 *  ── DEPLOY (one-time, ~5 minutes) ─────────────────────────────────
 *  1.  npm create cloudflare@latest vapormail-worker   (choose "Hello World" Worker)
 *      cd vapormail-worker && npm i postal-mime
 *  2.  Replace src/index.js with this file.
 *  3.  wrangler.toml needs only:
 *          name = "vapormail-worker"
 *          main = "src/index.js"
 *          compatibility_date = "2025-01-01"
 *  4.  Secrets (NEVER put the service_role key in the frontend):
 *          npx wrangler secret put SUPABASE_URL
 *            → https://YOUR_PROJECT_REF.supabase.co
 *          npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
 *            → the service_role key from Supabase → Settings → API
 *  5.  npx wrangler deploy
 *  6.  Cloudflare dashboard → your domain → Email → Email Routing:
 *        - Enable Email Routing (Cloudflare auto-creates the MX records)
 *        - Routing rules → "Catch-all address" → Action: "Send to Worker"
 *          → pick vapormail-worker → Save
 *      Catch-all is what makes EVERY random prefix the frontend
 *      generates (dx9f2j@yourdomain.com, …) land here with zero setup.
 * ────────────────────────────────────────────────────────────────────
 */

import PostalMime from 'postal-mime'; // battle-tested MIME parser, runs natively in Workers

// Safety caps so a hostile 50 MB email can't blow up the DB row.
const MAX_BODY_CHARS = 500_000;  // per body field (~0.5 MB of text/HTML)
const clip = (s) => (typeof s === 'string' && s.length > MAX_BODY_CHARS)
  ? s.slice(0, MAX_BODY_CHARS) + '\n\n[… truncated by vapormail worker …]'
  : (s ?? null);

export default {
  /**
   * Email Workers entry point. `message` is a ForwardableEmailMessage:
   *   message.from  → SMTP envelope sender
   *   message.to    → the temp address it was sent to  (our DB key)
   *   message.raw   → ReadableStream of the raw RFC 822 / MIME source
   */
  async email(message, env, ctx) {
    try {
      /* ── 1. Read + parse the raw multipart MIME into clean fields ── */
      const rawBuffer = await new Response(message.raw).arrayBuffer();
      const parsed = await new PostalMime().parse(rawBuffer);

      /* ── 2. Shape the JSON payload (matches the Supabase schema) ── */
      const payload = {
        recipient:   (message.to || '').toLowerCase().trim(), // what the frontend filters on
        sender:      parsed.from?.address || message.from || 'unknown',
        sender_name: parsed.from?.name || null,
        subject:     parsed.subject || '(no subject)',
        html_body:   clip(parsed.html),                       // sanitized client-side via sandboxed iframe
        text_body:   clip(parsed.text),
        received_at: new Date().toISOString(),
      };

      /* ── 3. Write straight into Supabase via PostgREST ──
         Uses the service_role key (a Worker secret) which bypasses RLS,
         so the table needs NO insert policy for the public anon role.  */
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/emails`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // Log and swallow: rejecting here would make the sender's MTA retry forever.
        console.error(`Supabase insert failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error('vapormail worker error:', err?.stack || err);
      // Intentionally do not message.setReject(): a parse failure on one
      // weird email shouldn't bounce mail or trigger redelivery storms.
    }
  },
};
