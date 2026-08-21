// ════════════════════════════════════════════════════════════════
//  KEEPO — Edge Function : génération d'un pass Apple Wallet (.pkpass)
// ════════════════════════════════════════════════════════════════
//
//  Le client (authentifié) demande sa carte pour un commerçant donné ;
//  on construit pass.json + icônes → manifest.json (SHA-1) → signature
//  PKCS#7 détachée (certificat Pass Type ID + WWDR) → ZIP .pkpass.
//
//  Secrets à définir (Supabase → Edge Functions → Secrets) :
//    APPLE_PASS_CERT_PEM   -- certificat Pass Type ID (PEM)
//    APPLE_PASS_KEY_PEM    -- clé privée correspondante (PEM, non chiffrée)
//    APPLE_WWDR_PEM        -- certificat intermédiaire Apple WWDR (PEM) [recommandé]
//    APPLE_PASS_TYPE_ID    -- ex. pass.com.keepo.loyalty
//    APPLE_TEAM_ID         -- Team Identifier Apple (10 caractères)
//  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sont injectés par la plateforme.)
//
//  Déploiement :
//    supabase functions deploy keepo-apple-pass
//
//  Corps POST attendu : { "merchantId": "<uuid>" }
// ════════════════════════════════════════════════════════════════

// deno-lint-ignore-file
/// <reference lib="deno.ns" />

import forge from 'https://esm.sh/node-forge@1.3.1';
import JSZip from 'https://esm.sh/jszip@3.10.1';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PASS_CERT_PEM    = Deno.env.get('APPLE_PASS_CERT_PEM') ?? '';
const PASS_KEY_PEM     = Deno.env.get('APPLE_PASS_KEY_PEM') ?? '';
const WWDR_PEM         = Deno.env.get('APPLE_WWDR_PEM') ?? '';
const PASS_TYPE_ID     = Deno.env.get('APPLE_PASS_TYPE_ID') ?? 'pass.com.keepo.loyalty';
const TEAM_ID          = Deno.env.get('APPLE_TEAM_ID') ?? '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// PNG 1x1 valide (fallback si le fetch de l'icône échoue).
const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
  c => c.charCodeAt(0),
);

function sha1hex(bytes: Uint8Array): string {
  const md = forge.md.sha1.create();
  md.update(forge.util.binary.raw.encode(bytes));
  return md.digest().toHex();
}

function signManifest(manifestBytes: Uint8Array): Uint8Array {
  const cert = forge.pki.certificateFromPem(PASS_CERT_PEM);
  const key  = forge.pki.privateKeyFromPem(PASS_KEY_PEM);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(forge.util.binary.raw.encode(manifestBytes));
  p7.addCertificate(cert);
  if (WWDR_PEM) p7.addCertificate(forge.pki.certificateFromPem(WWDR_PEM));
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.binary.raw.decode(der);
}

async function fetchImage(url: string): Promise<Uint8Array> {
  try {
    const r = await fetch(url);
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  } catch (_) { /* fallback */ }
  return TINY_PNG;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  if (!PASS_CERT_PEM || !PASS_KEY_PEM || !TEAM_ID) {
    return new Response(JSON.stringify({ error: 'Apple Wallet non configuré (certificat/team manquant)' }), {
      status: 503, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    // ── Auth : identifie le client via son JWT ──
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Authentification requise' }), {
        status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    const clientId = user.id;

    const body = await req.json().catch(() => ({}));
    const merchantId = body?.merchantId;
    if (!/^[0-9a-f-]{36}$/i.test(merchantId || '')) {
      return new Response(JSON.stringify({ error: 'merchantId invalide' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── Données KEEPO (service_role) ──
    const [{ data: bal }, { data: card }, { data: prof }] = await Promise.all([
      supabase.from('loyalty_balances').select('points_balance').eq('client_id', clientId).eq('merchant_id', merchantId).maybeSingle(),
      supabase.from('merchant_cards').select('title,color').eq('merchant_id', merchantId).maybeSingle(),
      supabase.from('profiles').select('name').eq('id', clientId).maybeSingle(),
    ]);
    if (!bal) {
      return new Response(JSON.stringify({ error: "Vous n'avez pas de carte chez ce commerçant" }), {
        status: 404, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const points = bal.points_balance || 0;
    const title  = String(card?.title || 'Commerce').slice(0, 60);
    const hex     = /^#[0-9a-f]{6}$/i.test(card?.color || '') ? card!.color : '#0B0E15';
    const rgb     = `rgb(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)})`;

    const pass = {
      formatVersion: 1,
      passTypeIdentifier: PASS_TYPE_ID,
      teamIdentifier: TEAM_ID,
      serialNumber: `${clientId}-${merchantId}`,
      organizationName: 'KEEPO',
      description: `Carte de fidélité ${title}`,
      logoText: title,
      foregroundColor: 'rgb(255,255,255)',
      backgroundColor: rgb,
      labelColor: 'rgb(210,210,210)',
      storeCard: {
        headerFields:    [{ key: 'points', label: 'POINTS', value: String(points) }],
        primaryFields:   [{ key: 'prog',   label: 'Programme', value: title }],
        secondaryFields: [{ key: 'member', label: 'Membre', value: String(prof?.name || '') }],
      },
      barcodes: [{
        format: 'PKBarcodeFormatQR',
        message: `KEEPO:card:${clientId}:${merchantId}`,
        messageEncoding: 'iso-8859-1',
      }],
    };

    // Images : icône KEEPO + logo du commerçant (fallback si indispo).
    const origin = SUPABASE_URL ? 'https://keepo.eu' : 'https://keepo.eu';
    const [icon, logo] = await Promise.all([
      fetchImage(`${origin}/img/icon-192.png`),
      fetchImage(`${origin}/logo/${merchantId}`),
    ]);

    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = {
      'pass.json':   enc.encode(JSON.stringify(pass)),
      'icon.png':    icon,
      'icon@2x.png': icon,
      'logo.png':    logo,
      'logo@2x.png': logo,
    };

    const manifest: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(files)) manifest[name] = sha1hex(bytes);
    const manifestBytes = enc.encode(JSON.stringify(manifest));
    const signature = signManifest(manifestBytes);

    const zip = new JSZip();
    for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
    zip.file('manifest.json', manifestBytes);
    zip.file('signature', signature);
    const pkpass = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

    return new Response(pkpass, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': 'attachment; filename="keepo.pkpass"',
      },
    });
  } catch (err) {
    console.error('keepo-apple-pass error:', err);
    return new Response(JSON.stringify({ error: 'Erreur de génération du pass', details: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
