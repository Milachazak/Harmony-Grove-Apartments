// Harmony Grove — Webinar Registration Edge Function
// Deploy via: Supabase Dashboard → Edge Functions → New Function → paste this code
//
// Environment variables to set in Supabase Dashboard → Edge Functions → Secrets:
//   ZOOM_ACCOUNT_ID        — from your Zoom Server-to-Server OAuth app
//   ZOOM_CLIENT_ID         — from your Zoom Server-to-Server OAuth app
//   ZOOM_CLIENT_SECRET     — from your Zoom Server-to-Server OAuth app
//   PIPEDRIVE_API_KEY      — 65486fc56e170311f9f8010f5f18c374c51122bc
//   RESEND_API_KEY         — re_Tj4bUWkG_C4cyMNfXqSYiamVEbtnryoYJ
//   RESEND_FROM            — e.g. webinar@milapennchazak.com (must be verified in Resend)
//   (All partner emails are now hardcoded in getPartnerEmails() below)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WEBINAR_ID = "82375789024"; // Zoom Webinar ID 823 7578 9024 (spaces removed) — standard /harmonygrove flow
const WEBINAR_ID_ANPA = "81291983940"; // Zoom Webinar ID 812 9198 3940 — ANPA-exclusive webinar, June 20 2026 12:30 PM ET
const WEBINAR_ID_TAX = "85774551628"; // Zoom Webinar ID 857 7455 1628, Tax Strategy briefing, June 29 2026 6:30 PM ET (/tax-strategy)
// Post-close celebration webinar (/celebrate). Tuesday, July 21, 2026, 6:30 PM ET, Zoom 849 4880 5806.
const WEBINAR_ID_CELEBRATE = "84948805806";

// ─── Partner email map ────────────────────────────────────────────────────────
function getPartnerEmails(): Record<string, string> {
  return {
    "EagleCap Ventures (Fedna Morency)":       "fedna@eaglecapventures.com",
    "Kynectic Capital (Anita Akpunku)":        "anita@kynecticcap.com",
    "Priority 1 Capital (Leah & Jeremy)":      "lkrebs@p1capitalinvestment.com",
    "Dr. Stanley A. Okoro":                    "drokoro@georgiaplastic.com",
    "Medval Capital (Edwin Valverde)":         "edwinv@medvalcapital.com",
    "FaithBridge Capital (Dr. Ntiense Robin)": "robin@faithbridgecap.com",
    "Vanguard Consultants LLC (Blaise Nzeda)": "bnzeda@gmail.com",
  };
}

// ─── ZOOM ─────────────────────────────────────────────────────────────────────
async function getZoomToken(): Promise<string> {
  const accountId    = Deno.env.get("ZOOM_ACCOUNT_ID")!;
  const clientId     = Deno.env.get("ZOOM_CLIENT_ID")!;
  const clientSecret = Deno.env.get("ZOOM_CLIENT_SECRET")!;

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    {
      method: "POST",
      headers: { "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
    }
  );
  if (!res.ok) throw new Error(`Zoom token failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function registerOnZoom(
  token: string,
  reg: { first_name: string; last_name: string; email: string; phone: string },
  webinarId: string = WEBINAR_ID
): Promise<{ join_url: string; registrant_id: string }> {
  const res = await fetch(
    `https://api.zoom.us/v2/webinars/${webinarId}/registrants`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email:      reg.email,
        first_name: reg.first_name,
        last_name:  reg.last_name,
        phone:      reg.phone,
        auto_approve: true,
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Zoom registration failed: ${JSON.stringify(data)}`);
  return { join_url: data.join_url ?? "", registrant_id: data.registrant_id ?? "" };
}

// ─── PIPEDRIVE ────────────────────────────────────────────────────────────────
const PD_BASE = "https://api.pipedrive.com/v1";

async function pdFetch(path: string, method = "GET", body?: unknown) {
  const apiKey = Deno.env.get("PIPEDRIVE_API_KEY")!;
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${PD_BASE}${path}${sep}api_token=${apiKey}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function findOrCreatePerson(data: {
  first_name: string; last_name: string; email: string; phone: string;
}): Promise<number> {
  const search = await pdFetch(`/persons/search?term=${encodeURIComponent(data.email)}&fields=email`);
  if (search.data?.items?.length > 0) return search.data.items[0].item.id;

  const created = await pdFetch("/persons", "POST", {
    name:  `${data.first_name} ${data.last_name}`,
    email: [{ value: data.email, primary: true, label: "work" }],
    phone: [{ value: data.phone, primary: true }],
    "30c24af921cf3c01b4fb20e21708f6f73cbb4cfc": data.referral_source,
    "b32ba4545fe0461a49928960b2045183b98d1d80": data.partner_referral,
  });
  if (!created?.data?.id) throw new Error(`Pipedrive person create failed: ${JSON.stringify(created)}`);
  return created.data.id;
}

async function getPipelineAndStage(): Promise<{ pipelineId: number | null; stageId: number | null }> {
  // Fetch all pipelines — find "Harmony Grove" or fall back to first
  const pipelines = await pdFetch("/pipelines");
  if (!pipelines.data?.length) return { pipelineId: null, stageId: null };

  const pipeline = pipelines.data.find((p: any) =>
    p.name.toLowerCase().includes("harmony grove")
  ) ?? pipelines.data[0];

  const pipelineId = pipeline.id;

  // Fetch stages — find "incoming" or fall back to first
  const stages = await pdFetch(`/stages?pipeline_id=${pipelineId}`);
  if (!stages.data?.length) return { pipelineId, stageId: null };

  const stage = stages.data.find((s: any) =>
    s.name.toLowerCase().includes("incoming")
  ) ?? stages.data[0];

  return { pipelineId, stageId: stage.id };
}

async function createPipedriveDeal(data: {
  first_name: string; last_name: string; email: string; phone: string;
  referral_source: string; partner_referral: string;
}): Promise<number> {
  const [personId, { pipelineId, stageId }] = await Promise.all([
    findOrCreatePerson(data),
    getPipelineAndStage(),
  ]);

  const deal = await pdFetch("/deals", "POST", {
    title:       "Harmony Grove",
    person_id:   personId,
    pipeline_id: pipelineId,
    stage_id:    stageId,
    status:      "open",
  });
  return deal.data.id;
}

// ─── RESEND EMAILS ────────────────────────────────────────────────────────────
// Strip any non-ASCII chars that could break HTTP headers (common copy-paste issue)
function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "");
}

async function sendEmail(opts: {
  to: string; subject: string; html: string; scheduledAt?: string; fromName?: string;
}) {
  // ascii() strips any invisible/non-ASCII chars that would break HTTP headers
  const key      = ascii(Deno.env.get("RESEND_API_KEY") ?? "");
  const mailbox  = Deno.env.get("RESEND_FROM") ?? "invest@milapennchazak.com";
  const fromName = opts.fromName ?? "Kirk, Rosanmi & Claude - Mila Penn Chazak";
  const from     = ascii(`${fromName} <${mailbox}>`);

  const body: Record<string, unknown> = {
    from, to: [opts.to], subject: opts.subject, html: opts.html,
  };
  if (opts.scheduledAt) body.scheduled_at = opts.scheduledAt;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── EMAIL TEMPLATES ──────────────────────────────────────────────────────────
function wrap(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#F0F4FC;font-family:Arial,Helvetica,sans-serif;color:#0A1628}
  .wrap{max-width:580px;margin:0 auto;padding:36px 16px}
  .brand{text-align:center;margin-bottom:28px;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#8899AA}
  .card{background:#fff;border-radius:16px;padding:48px 44px;box-shadow:0 4px 28px rgba(10,22,40,.07)}
  h1{font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:normal;line-height:1.3;margin-bottom:20px;color:#0A1628}
  p{font-size:15px;color:#4A5568;line-height:1.78;margin-bottom:14px}
  .btn-wrap{text-align:center;margin:28px 0}
  a.btn{display:inline-block;padding:14px 40px;background:#1244F5;color:#fff!important;text-decoration:none;border-radius:50px;font-size:15px;font-weight:700;letter-spacing:.01em}
  .box{background:#050E1F;border-radius:12px;padding:22px 26px;margin:22px 0}
  .box-row{display:flex;gap:10px;margin-bottom:8px;font-size:14px}
  .box-row:last-child{margin-bottom:0}
  .box-icon{width:22px;flex-shrink:0;margin-top:1px}
  .box-val{color:rgba(255,255,255,.82);line-height:1.5}
  .box-val strong{color:#fff}
  .sig{margin-top:30px;padding-top:22px;border-top:1px solid #E8EEF8}
  .sig-name{font-size:15px;font-weight:700;color:#0A1628;margin-bottom:2px}
  .sig-co{font-size:13px;color:#8899AA}
  .footer{text-align:center;margin-top:22px;font-size:12px;color:#AAB8CC;line-height:1.65}
  @media(max-width:600px){.card{padding:32px 22px}h1{font-size:23px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">Mila Penn Chazak</div>
  <div class="card">${content}</div>
  <div class="footer">
    Harmony Grove Apartments &nbsp;·&nbsp; Private Offering &nbsp;·&nbsp; Accredited Investors Only<br>
    You're receiving this because you registered for the Harmony Grove Investor Webinar.
  </div>
</div>
</body>
</html>`;
}

function emailWelcome(name: string, joinUrl: string): string {
  return wrap(`
    <h1>You're in, ${name}.</h1>
    <p>We're really glad you're here. The Harmony Grove webinar is set for <strong>Monday, June 15th at 6:30 PM ET</strong>, and we've put a lot of care into making sure it's worth your time.</p>
    <p>This is a real conversation — not a pitch deck read out loud. We'll walk through the property, the numbers, the market, and how the deal is structured. You'll have plenty of time to ask us anything.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Monday, June 15, 2026</strong></span></div>
      <div class="box-row"><span class="box-icon">🕕</span><span class="box-val"><strong>6:30 PM ET</strong> &nbsp;·&nbsp; approximately 75 minutes</span></div>
      <div class="box-row"><span class="box-icon">💻</span><span class="box-val">Live on Zoom &nbsp;·&nbsp; your personal link is below</span></div>
      <div class="box-row"><span class="box-icon">🏠</span><span class="box-val">Harmony Grove Apartments &nbsp;·&nbsp; Marietta, GA &nbsp;·&nbsp; 75 Units</span></div>
    </div>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join the Webinar →</a></div>
    <p>Save that link somewhere easy to find. We'll remind you Friday and again the morning of — you don't need to do anything else.</p>
    <p>If a question comes to mind before Monday, just reply here. We read every email.</p>
    <div class="sig">
      <div class="sig-name">Kirk, Rosanmi & Claude</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>
  `);
}

function email3Day(name: string, joinUrl: string): string {
  return wrap(`
    <h1>Three days, ${name}.</h1>
    <p>Just a heads up — the Harmony Grove webinar is this <strong>Monday at 6:30 PM ET</strong>.</p>
    <p>We'll be walking through the full picture: the asset, the numbers, the renovation plan, and how this deal is structured for investors like you. Bring your questions — we'll save real time for them.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Monday, June 15, 2026 &nbsp;·&nbsp; 6:30 PM ET</strong></span></div>
      <div class="box-row"><span class="box-icon">⏱</span><span class="box-val">Approximately 75 minutes</span></div>
    </div>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Your Zoom Link →</a></div>
    <p>See you Monday.</p>
    <div class="sig">
      <div class="sig-name">Kirk, Rosanmi & Claude</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>
  `);
}

function emailDayOf(name: string, joinUrl: string): string {
  return wrap(`
    <h1>Today's the day, ${name}.</h1>
    <p>The Harmony Grove webinar is <strong>tonight at 6:30 PM ET</strong>. We're looking forward to it.</p>
    <p>Grab a quiet room, a good chair, and your questions. This is the real conversation — no fluff, no rehearsed script. Just the deal, the market, and honest answers.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Tonight at 6:30 PM ET →</a></div>
    <p>If something comes up and you can't make it, reply to this email and we'll make sure you get the recording.</p>
    <div class="sig">
      <div class="sig-name">Kirk, Rosanmi & Claude</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>
  `);
}

function email30Min(name: string, joinUrl: string): string {
  return wrap(`
    <h1>We start in 30 minutes.</h1>
    <p>${name}, the room is open. Jump in whenever you're ready — you can join a few minutes early and we'll be there.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Now →</a></div>
    <p>See you in a few.</p>
    <div class="sig">
      <div class="sig-name">Kirk, Rosanmi & Claude</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>
  `);
}

// ─── ANPA-EXCLUSIVE WEBINAR (June 20, 2026 · 12:30 PM ET) ─────────────────────
const ANPA_SIG = `
    <div class="sig">
      <div class="sig-name">Dr. Kirk A. Campbell &amp; J. Claude Mouaffi</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>`;

function emailAnpaWelcome(name: string, joinUrl: string): string {
  return wrap(`
    <h1>You're registered, ${name}.</h1>
    <p>Thank you for registering for our <strong>ANPA-exclusive investor webinar</strong> on Harmony Grove Apartments. We're glad you'll be joining us, and we've reserved your spot.</p>
    <p>This is a real conversation, built for fellow physicians and high-income professionals &mdash; not a pitch deck read out loud. We'll walk through the property, the numbers, the market, and how the deal is structured, with plenty of time to ask us anything.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Saturday, June 20, 2026</strong></span></div>
      <div class="box-row"><span class="box-icon">🕧</span><span class="box-val"><strong>12:30 PM ET</strong> &nbsp;·&nbsp; approximately 75 minutes</span></div>
      <div class="box-row"><span class="box-icon">💻</span><span class="box-val">Live on Zoom &nbsp;·&nbsp; your personal link is below</span></div>
      <div class="box-row"><span class="box-icon">🏠</span><span class="box-val">Harmony Grove Apartments &nbsp;·&nbsp; Marietta, GA &nbsp;·&nbsp; 75 Units</span></div>
    </div>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join the Webinar →</a></div>
    <p>Save that link somewhere easy to find. We'll send you a couple of reminders as the date approaches &mdash; you don't need to do anything else.</p>
    <p>If a question comes to mind beforehand, just reply here. We read every email.</p>
    ${ANPA_SIG}
  `);
}

function emailAnpa3Day(name: string, joinUrl: string): string {
  return wrap(`
    <h1>A few days away, ${name}.</h1>
    <p>Just a heads up &mdash; our ANPA-exclusive Harmony Grove webinar is this <strong>Saturday, June 20 at 12:30 PM ET</strong>.</p>
    <p>We'll walk through the full picture: the asset, the numbers, the renovation plan, and how this deal is structured for investors like you. Bring your questions &mdash; we'll save real time for them.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Saturday, June 20, 2026 &nbsp;·&nbsp; 12:30 PM ET</strong></span></div>
      <div class="box-row"><span class="box-icon">⏱</span><span class="box-val">Approximately 75 minutes</span></div>
    </div>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Your Zoom Link →</a></div>
    <p>See you Saturday.</p>
    ${ANPA_SIG}
  `);
}

function emailAnpaDayOf(name: string, joinUrl: string): string {
  return wrap(`
    <h1>Today's the day, ${name}.</h1>
    <p>Our ANPA-exclusive Harmony Grove webinar is <strong>today at 12:30 PM ET</strong>. We're looking forward to it.</p>
    <p>Grab a quiet room, a good chair, and your questions. This is the real conversation &mdash; no fluff, no rehearsed script. Just the deal, the market, and honest answers.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Today at 12:30 PM ET →</a></div>
    <p>If something comes up and you can't make it, reply to this email and we'll make sure you get the recording.</p>
    ${ANPA_SIG}
  `);
}

function emailAnpa30Min(name: string, joinUrl: string): string {
  return wrap(`
    <h1>We start in 30 minutes.</h1>
    <p>${name}, the room is open. Jump in whenever you're ready &mdash; you can join a few minutes early and we'll be there.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Now →</a></div>
    <p>See you in a few.</p>
    ${ANPA_SIG}
  `);
}

// ─── TAX STRATEGY BRIEFING (June 29, 2026 · 6:30 PM ET · with Kim Hopkins, EA) ──
const TAX_SIG = `
    <div class="sig">
      <div class="sig-name">Kirk, Rosanmi &amp; Claude</div>
      <div class="sig-co">Mila Penn Chazak &nbsp;·&nbsp; featuring Kim Hopkins, EA</div>
    </div>`;

function emailTaxWelcome(name: string, joinUrl: string): string {
  return wrap(`
    <h1>Your seat is reserved, ${name}.</h1>
    <p>Thank you for registering for our members-only <strong>2026 Tax Strategy Briefing</strong>. This is our way of bringing the community more than a deal, real, actionable strategy for keeping more of what you earn.</p>
    <p>Your speaker is <strong>Kim Hopkins, EA</strong>, Director of Tax Planning at Doc Wealth | Physician Taxes. She will walk through depreciation, cost segregation, and the lesser-known moves high earners use to lower their tax bill, in plain English, with real numbers. There will be plenty of time for live Q&amp;A.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Monday, June 29, 2026</strong></span></div>
      <div class="box-row"><span class="box-icon">🕡</span><span class="box-val"><strong>6:30 PM ET</strong> &nbsp;·&nbsp; 60 minutes</span></div>
      <div class="box-row"><span class="box-icon">💻</span><span class="box-val">Live on Zoom &nbsp;·&nbsp; your personal link is below</span></div>
      <div class="box-row"><span class="box-icon">🎙️</span><span class="box-val">Kim Hopkins, EA &nbsp;·&nbsp; Doc Wealth | Physician Taxes</span></div>
    </div>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join the Briefing →</a></div>
    <p>Save that link somewhere easy to find. We will send you a couple of reminders as the date approaches, you do not need to do anything else.</p>
    <p>If a question comes to mind beforehand, just reply here. We read every email.</p>
    ${TAX_SIG}
  `);
}

function emailTax3Day(name: string, joinUrl: string): string {
  return wrap(`
    <h1>A few days away, ${name}.</h1>
    <p>Just a heads up, our members-only <strong>2026 Tax Strategy Briefing</strong> is this <strong>Monday, June 29 at 6:30 PM ET</strong>.</p>
    <p>Kim Hopkins, EA will cover how to legally lower your tax bill through depreciation, cost segregation, and smart structuring. Bring your questions, we will save real time for them.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Monday, June 29, 2026 &nbsp;·&nbsp; 6:30 PM ET</strong></span></div>
      <div class="box-row"><span class="box-icon">⏱</span><span class="box-val">60 minutes &nbsp;·&nbsp; live Q&amp;A included</span></div>
    </div>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Your Zoom Link →</a></div>
    <p>See you Monday.</p>
    ${TAX_SIG}
  `);
}

function emailTaxDayOf(name: string, joinUrl: string): string {
  return wrap(`
    <h1>Today's the day, ${name}.</h1>
    <p>Our <strong>2026 Tax Strategy Briefing</strong> with Kim Hopkins, EA is <strong>tonight at 6:30 PM ET</strong>. We are looking forward to it.</p>
    <p>Grab a quiet room, a notepad, and your questions. This is a high-signal hour on keeping more of what you earn, no fluff, just strategy and honest answers.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Tonight at 6:30 PM ET →</a></div>
    <p>If something comes up and you cannot make it, reply to this email and we will make sure you get the recording.</p>
    ${TAX_SIG}
  `);
}

function emailTax30Min(name: string, joinUrl: string): string {
  return wrap(`
    <h1>We start in 30 minutes.</h1>
    <p>${name}, the room is open. Jump in whenever you are ready, you can join a few minutes early and we will be there.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Now →</a></div>
    <p>See you in a few.</p>
    ${TAX_SIG}
  `);
}

function emailTaxPartnerNotify(
  partnerName: string,
  reg: { first_name: string; last_name: string; email: string; phone: string }
): string {
  return wrap(`
    <h1>A registration from your network.</h1>
    <p>Hi ${partnerName},</p>
    <p>Someone registered for the Mila Penn Chazak 2026 Tax Strategy Briefing and indicated they are working with you. We wanted to make sure you had their details.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">👤</span><span class="box-val"><strong>${reg.first_name} ${reg.last_name}</strong></span></div>
      <div class="box-row"><span class="box-icon">📧</span><span class="box-val">${reg.email}</span></div>
      <div class="box-row"><span class="box-icon">📞</span><span class="box-val">${reg.phone}</span></div>
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val">Registered for Monday, June 29, 2026 · 6:30 PM ET</span></div>
    </div>
    <p>We will take care of them on the webinar side. Feel free to reach out to them directly in the meantime, they are expecting to hear from you.</p>
    <p>Thank you for the introduction. We are grateful for this partnership.</p>
    <div class="sig">
      <div class="sig-name">Kirk, Rosanmi &amp; Claude</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>
  `);
}

function emailPartnerNotify(
  partnerName: string,
  reg: { first_name: string; last_name: string; email: string; phone: string }
): string {
  return wrap(`
    <h1>A registration from your network.</h1>
    <p>Hi ${partnerName},</p>
    <p>Someone registered for the Harmony Grove investor webinar and indicated they're working with you. We wanted to make sure you had their details.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">👤</span><span class="box-val"><strong>${reg.first_name} ${reg.last_name}</strong></span></div>
      <div class="box-row"><span class="box-icon">📧</span><span class="box-val">${reg.email}</span></div>
      <div class="box-row"><span class="box-icon">📞</span><span class="box-val">${reg.phone}</span></div>
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val">Registered for Monday, June 15, 2026 · 6:30 PM ET</span></div>
    </div>
    <p>We'll take care of them on the webinar side. Feel free to reach out to them directly in the meantime — they're expecting to hear from you.</p>
    <p>Thank you for the introduction. We're grateful for this partnership.</p>
    <div class="sig">
      <div class="sig-name">Kirk, Rosanmi & Claude</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>
  `);
}

// ─── WAITLIST (raise is fully subscribed) ─────────────────────────────────────
const RAISE_SIG = `
    <div class="sig">
      <div class="sig-name">Dr. Kirk A. Campbell, Rosanmi Campbell &amp; J. Claude Mouaffi</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>`;

function emailWaitlistWelcome(name: string): string {
  return wrap(`
    <h1>You're on the list, ${name}.</h1>
    <p>Thank you for your interest in Harmony Grove. The current allocation is fully subscribed, and you are now on our priority waitlist.</p>
    <p>Here is what that means. If a slot opens before we close, or as we bring the next opportunity forward, a member of our team will reach out to you personally by phone. You do not need to do anything else. Your place is held.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">✅</span><span class="box-val"><strong>Your waitlist spot is confirmed</strong></span></div>
      <div class="box-row"><span class="box-icon">📞</span><span class="box-val">We will call you the moment a slot becomes available</span></div>
      <div class="box-row"><span class="box-icon">🏠</span><span class="box-val">Harmony Grove Apartments &nbsp;·&nbsp; Marietta, GA &nbsp;·&nbsp; 75 Units</span></div>
    </div>
    <p>We are grateful for the trust our community has shown in this raise. If you would like to talk in the meantime, just reply here. We read every email.</p>
    ${RAISE_SIG}
  `);
}

function emailWaitlistPartnerNotify(
  partnerName: string,
  reg: { first_name: string; last_name: string; email: string; phone: string }
): string {
  return wrap(`
    <h1>A waitlist signup from your network.</h1>
    <p>Hi ${partnerName},</p>
    <p>Someone joined the Harmony Grove waitlist and indicated they are working with you. We wanted to make sure you had their details.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">👤</span><span class="box-val"><strong>${reg.first_name} ${reg.last_name}</strong></span></div>
      <div class="box-row"><span class="box-icon">📧</span><span class="box-val">${reg.email}</span></div>
      <div class="box-row"><span class="box-icon">📞</span><span class="box-val">${reg.phone}</span></div>
      <div class="box-row"><span class="box-icon">📝</span><span class="box-val">Joined the Harmony Grove priority waitlist</span></div>
    </div>
    <p>Feel free to reach out to them directly. We will keep you posted as slots open up.</p>
    <p>Thank you for the introduction. We are grateful for this partnership.</p>
    ${RAISE_SIG}
  `);
}

// ─── CELEBRATION WEBINAR (post-close · date + Zoom ID TBD) ─────────────────────
function emailCelebrateWelcome(name: string, joinUrl: string): string {
  const joinBlock = joinUrl
    ? `<div class="btn-wrap"><a href="${joinUrl}" class="btn">Save Your Zoom Link →</a></div>
       <p>Save that link somewhere easy to find. We will send a reminder as the date approaches.</p>`
    : `<p>The exact date and time are being finalized now. As soon as they are set, we will email you the Zoom link and everything you need. Your spot is saved.</p>`;
  return wrap(`
    <h1>You're in, ${name}.</h1>
    <p>Thank you for joining us to celebrate the closing of Harmony Grove Apartments. This is a milestone for our whole community, and it would not have happened without people like you.</p>
    <p>This is not a pitch. It is a thank-you. We will share the story of the raise, what comes next, and raise a glass together, whether you invested this time or simply cheered us on.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">🎉</span><span class="box-val"><strong>Harmony Grove Closing Celebration</strong></span></div>
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Tuesday, July 21, 2026</strong></span></div>
      <div class="box-row"><span class="box-icon">🕡</span><span class="box-val"><strong>6:30 PM ET</strong> &nbsp;·&nbsp; live on Zoom</span></div>
      <div class="box-row"><span class="box-icon">💻</span><span class="box-val">Open to the whole community</span></div>
      <div class="box-row"><span class="box-icon">🏠</span><span class="box-val">Harmony Grove Apartments &nbsp;·&nbsp; Marietta, GA &nbsp;·&nbsp; 75 Units</span></div>
    </div>
    ${joinBlock}
    <p>If a question comes to mind beforehand, just reply here. We read every email.</p>
    ${RAISE_SIG}
  `);
}

function emailCelebratePartnerNotify(
  partnerName: string,
  reg: { first_name: string; last_name: string; email: string; phone: string }
): string {
  return wrap(`
    <h1>A celebration signup from your network.</h1>
    <p>Hi ${partnerName},</p>
    <p>Someone signed up for the Harmony Grove closing celebration and indicated they are working with you. We wanted to make sure you had their details.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">👤</span><span class="box-val"><strong>${reg.first_name} ${reg.last_name}</strong></span></div>
      <div class="box-row"><span class="box-icon">📧</span><span class="box-val">${reg.email}</span></div>
      <div class="box-row"><span class="box-icon">📞</span><span class="box-val">${reg.phone}</span></div>
      <div class="box-row"><span class="box-icon">🎉</span><span class="box-val">Signed up for the Harmony Grove closing celebration</span></div>
    </div>
    <p>Feel free to reach out to them directly and celebrate together. We are glad they will be with us.</p>
    <p>Thank you for everything you have done to make this raise a success.</p>
    ${RAISE_SIG}
  `);
}

function emailCelebrate3Day(name: string, joinUrl: string): string {
  return wrap(`
    <h1>A few days away, ${name}.</h1>
    <p>Our Harmony Grove closing celebration is this <strong>Tuesday, July 21 at 6:30 PM ET</strong>. We would love to have you there.</p>
    <p>This is a relaxed hour to mark the milestone together, share the story of the raise, and look at what comes next. Come as you are.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Tuesday, July 21, 2026 &nbsp;·&nbsp; 6:30 PM ET</strong></span></div>
      <div class="box-row"><span class="box-icon">💻</span><span class="box-val">Live on Zoom</span></div>
    </div>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Your Zoom Link →</a></div>
    <p>See you Tuesday.</p>
    ${RAISE_SIG}
  `);
}

function emailCelebrateDayOf(name: string, joinUrl: string): string {
  return wrap(`
    <h1>Today's the day, ${name}.</h1>
    <p>Our Harmony Grove closing celebration is <strong>tonight at 6:30 PM ET</strong>. We are looking forward to raising a glass with you.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Tonight at 6:30 PM ET →</a></div>
    <p>If something comes up and you cannot make it, no worries at all. We are grateful you are part of this community.</p>
    ${RAISE_SIG}
  `);
}

function emailCelebrate30Min(name: string, joinUrl: string): string {
  return wrap(`
    <h1>We start in 30 minutes.</h1>
    <p>${name}, the room is open. Jump in whenever you are ready, you can join a few minutes early and we will be there.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Now →</a></div>
    <p>See you in a few.</p>
    ${RAISE_SIG}
  `);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { first_name, last_name, email, phone, referral_source, partner_referral, sms_consent } =
      await req.json();

    // 10DLC SMS opt-in: normalize the checkbox value to a boolean for the consent log
    const smsConsent = sms_consent === true || sms_consent === "yes" || sms_consent === "true";

    if (!first_name || !last_name || !email || !phone) {
      return new Response(
        JSON.stringify({ success: false, error: "All fields are required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── Flow detection ───────────────────────────────────────────────────────
    //   "anpa"      → ANPA-exclusive June 20 webinar
    //   "tax"       → 2026 Tax Strategy briefing, June 29 (/tax-strategy)
    //   "waitlist"  → raise fully subscribed, priority waitlist (/ and /harmonygrove), no Zoom, no reminders
    //   "celebrate" → post-close celebration webinar (/celebrate), Zoom TBD, no reminders yet
    //   else        → standard /harmonygrove flow
    const src        = (referral_source || "").trim().toLowerCase();
    const isAnpa     = src === "anpa";
    const isTax      = src === "tax";
    const isWaitlist = src === "waitlist";
    const isCelebrate = src === "celebrate";

    let joinUrl = "";
    let zoomRegistrantId = "";

    // 1. Zoom registration — each flow registers on its own webinar.
    //    Waitlist has no event; celebration has no Zoom ID until scheduled. Both skip Zoom.
    const celebrateHasZoom = isCelebrate && WEBINAR_ID_CELEBRATE !== "";
    const skipZoom = isWaitlist || (isCelebrate && !celebrateHasZoom);
    if (!skipZoom) {
      try {
        const token = await getZoomToken();
        const zoom  = await registerOnZoom(
          token,
          { first_name, last_name, email, phone },
          isAnpa ? WEBINAR_ID_ANPA
            : isTax ? WEBINAR_ID_TAX
            : isCelebrate ? WEBINAR_ID_CELEBRATE
            : WEBINAR_ID
        );
        joinUrl          = zoom.join_url;
        zoomRegistrantId = zoom.registrant_id;
      } catch (err) {
        console.error("Zoom error:", err);
      }
    }

    // 2. Save to Supabase (always). 10DLC: SMS consent is upgrade-only (once true, stays true),
    //    so a later registration without the checkbox never erases a prior opt-in.
    let priorConsent = false;
    try {
      const { data: existing } = await supabase
        .from("webinar_registrants").select("sms_consent").eq("email", email).maybeSingle();
      priorConsent = existing?.sms_consent === true;
    } catch (_) { /* first-time registrant or read error: treat as no prior consent */ }

    await supabase.from("webinar_registrants").upsert(
      { first_name, last_name, email, phone, referral_source, partner_referral,
        sms_consent: smsConsent || priorConsent,
        zoom_join_url: joinUrl, zoom_registrant_id: zoomRegistrantId },
      { onConflict: "email" }
    );

    // 3. Pipedrive deal (always — including ANPA, tagged via referral_source)
    try {
      await createPipedriveDeal({ first_name, last_name, email, phone, referral_source, partner_referral });
    } catch (err) {
      console.error("Pipedrive error:", err);
    }

    const emailErrors: string[] = [];

    if (isAnpa) {
      const ANPA_FROM = "Dr. Kirk A. Campbell & J. Claude Mouaffi - Mila Penn Chazak";

      // 4a. ANPA confirmation email (immediate) — from Kirk & Claude, with the Zoom join link
      try {
        const r = await sendEmail({
          to: email,
          fromName: ANPA_FROM,
          subject: `You're registered, ${first_name} — Harmony Grove webinar, June 20`,
          html: emailAnpaWelcome(first_name, joinUrl),
        });
        if (r.statusCode >= 400 || r.error) emailErrors.push(`ANPA welcome email: ${JSON.stringify(r)}`);
      } catch (err) {
        emailErrors.push(`ANPA welcome email threw: ${err}`);
      }

      // 5a. ANPA reminders (only if still in the future). Webinar: June 20, 2026, 12:30 PM ET.
      const nowA = Date.now();
      const anpaReminders = [
        { at: "2026-06-17T14:00:00.000Z", subject: `A few days away, ${first_name} — Harmony Grove webinar Saturday`, html: emailAnpa3Day(first_name, joinUrl) },
        { at: "2026-06-20T13:00:00.000Z", subject: `Today's the day, ${first_name} — Harmony Grove webinar at 12:30 PM ET`, html: emailAnpaDayOf(first_name, joinUrl) },
        { at: "2026-06-20T16:00:00.000Z", subject: `${first_name} — we start in 30 minutes`, html: emailAnpa30Min(first_name, joinUrl) },
      ];
      for (const r of anpaReminders) {
        if (new Date(r.at).getTime() > nowA) {
          try {
            await sendEmail({ to: email, fromName: ANPA_FROM, subject: r.subject, html: r.html, scheduledAt: r.at });
          } catch (err) {
            emailErrors.push(`ANPA reminder (${r.at}) threw: ${err}`);
          }
        }
      }
    } else if (isTax) {
      // ─── TAX STRATEGY BRIEFING (June 29, 2026 · 6:30 PM ET) ───────────────────

      // 4b. Confirmation email (immediate) with the Zoom join link
      try {
        const r = await sendEmail({
          to: email,
          subject: `Your seat is reserved, ${first_name}. 2026 Tax Strategy Briefing, June 29`,
          html: emailTaxWelcome(first_name, joinUrl),
        });
        if (r.statusCode >= 400 || r.error) emailErrors.push(`Tax welcome email: ${JSON.stringify(r)}`);
      } catch (err) {
        emailErrors.push(`Tax welcome email threw: ${err}`);
      }

      // 5b. Reminders (only if still in the future). Briefing: June 29, 2026, 6:30 PM ET (EDT = UTC-4).
      const nowT = Date.now();
      const taxReminders = [
        { at: "2026-06-26T14:00:00.000Z", subject: `A few days away, ${first_name}. Tax Strategy Briefing Monday`, html: emailTax3Day(first_name, joinUrl) },
        { at: "2026-06-29T13:00:00.000Z", subject: `Today's the day, ${first_name}. Tax Strategy Briefing at 6:30 PM ET`, html: emailTaxDayOf(first_name, joinUrl) },
        { at: "2026-06-29T22:00:00.000Z", subject: `${first_name}, we start in 30 minutes`, html: emailTax30Min(first_name, joinUrl) },
      ];
      for (const r of taxReminders) {
        if (new Date(r.at).getTime() > nowT) {
          try {
            await sendEmail({ to: email, subject: r.subject, html: r.html, scheduledAt: r.at });
          } catch (err) {
            emailErrors.push(`Tax reminder (${r.at}) threw: ${err}`);
          }
        }
      }

      // 6b. Partner notification (if a referring partner was selected)
      if (partner_referral && partner_referral !== "No") {
        const partnerEmail = getPartnerEmails()[partner_referral];
        if (partnerEmail) {
          try {
            await sendEmail({
              to: partnerEmail,
              subject: `New Tax Briefing registration from your network: ${first_name} ${last_name}`,
              html: emailTaxPartnerNotify(partner_referral, { first_name, last_name, email, phone }),
            });
          } catch (err) {
            emailErrors.push(`Tax partner email threw: ${err}`);
          }
        }
      }
    } else if (isWaitlist) {
      // ─── WAITLIST (raise fully subscribed), no Zoom, no reminders ─────────────

      // 4c. Waitlist confirmation email (immediate)
      try {
        const r = await sendEmail({
          to: email,
          subject: `You're on the Harmony Grove waitlist, ${first_name}`,
          html: emailWaitlistWelcome(first_name),
        });
        if (r.statusCode >= 400 || r.error) emailErrors.push(`Waitlist email: ${JSON.stringify(r)}`);
      } catch (err) {
        emailErrors.push(`Waitlist email threw: ${err}`);
      }

      // 5c. Partner notification (if a referring partner was selected)
      if (partner_referral && partner_referral !== "No") {
        const partnerEmail = getPartnerEmails()[partner_referral];
        if (partnerEmail) {
          try {
            await sendEmail({
              to: partnerEmail,
              subject: `New waitlist signup from your network: ${first_name} ${last_name}`,
              html: emailWaitlistPartnerNotify(partner_referral, { first_name, last_name, email, phone }),
            });
          } catch (err) {
            emailErrors.push(`Waitlist partner email threw: ${err}`);
          }
        }
      }
    } else if (isCelebrate) {
      // ─── CELEBRATION WEBINAR (post-close · date + Zoom ID TBD) ─────────────────

      // 4d. Confirmation email (immediate). joinUrl is "" until a Zoom ID is set.
      try {
        const r = await sendEmail({
          to: email,
          subject: `You're in, ${first_name}. Harmony Grove closing celebration`,
          html: emailCelebrateWelcome(first_name, joinUrl),
        });
        if (r.statusCode >= 400 || r.error) emailErrors.push(`Celebrate email: ${JSON.stringify(r)}`);
      } catch (err) {
        emailErrors.push(`Celebrate email threw: ${err}`);
      }

      // 5d. Reminders (only if still in the future). Celebration: July 21, 2026, 6:30 PM ET (EDT = UTC-4).
      const nowC = Date.now();
      const celebrateReminders = [
        { at: "2026-07-18T14:00:00.000Z", subject: `A few days away, ${first_name}. Harmony Grove celebration Tuesday`, html: emailCelebrate3Day(first_name, joinUrl) },
        { at: "2026-07-21T13:00:00.000Z", subject: `Today's the day, ${first_name}. Harmony Grove celebration at 6:30 PM ET`, html: emailCelebrateDayOf(first_name, joinUrl) },
        { at: "2026-07-21T22:00:00.000Z", subject: `${first_name}, we start in 30 minutes`, html: emailCelebrate30Min(first_name, joinUrl) },
      ];
      for (const rem of celebrateReminders) {
        if (new Date(rem.at).getTime() > nowC) {
          try {
            await sendEmail({ to: email, subject: rem.subject, html: rem.html, scheduledAt: rem.at, fromName: "Dr. Kirk A. Campbell, Rosanmi Campbell & J. Claude Mouaffi - Mila Penn Chazak" });
          } catch (err) {
            emailErrors.push(`Celebrate reminder (${rem.at}) threw: ${err}`);
          }
        }
      }

      // 6d. Partner notification (if a referring partner was selected)
      if (partner_referral && partner_referral !== "No") {
        const partnerEmail = getPartnerEmails()[partner_referral];
        if (partnerEmail) {
          try {
            await sendEmail({
              to: partnerEmail,
              subject: `New celebration signup from your network: ${first_name} ${last_name}`,
              html: emailCelebratePartnerNotify(partner_referral, { first_name, last_name, email, phone }),
            });
          } catch (err) {
            emailErrors.push(`Celebrate partner email threw: ${err}`);
          }
        }
      }
    } else {
      // 4. Welcome email (immediate)
      try {
        const r = await sendEmail({
          to: email,
          subject: `You're in, ${first_name} — see you Monday`,
          html: emailWelcome(first_name, joinUrl),
        });
        if (r.statusCode >= 400 || r.error) emailErrors.push(`Welcome email: ${JSON.stringify(r)}`);
      } catch (err) {
        emailErrors.push(`Welcome email threw: ${err}`);
      }

      // 5. Scheduled reminders (only if still in the future)
      const now = Date.now();
      const reminders = [
        { at: "2026-06-12T14:00:00.000Z", subject: `Three days away, ${first_name} — Harmony Grove Webinar`,   html: email3Day(first_name, joinUrl) },
        { at: "2026-06-15T13:00:00.000Z", subject: `Today's the day, ${first_name} — Harmony Grove is tonight`, html: emailDayOf(first_name, joinUrl) },
        { at: "2026-06-15T22:00:00.000Z", subject: `${first_name} — we start in 30 minutes`,                    html: email30Min(first_name, joinUrl) },
      ];
      for (const r of reminders) {
        if (new Date(r.at).getTime() > now) {
          try {
            await sendEmail({ to: email, subject: r.subject, html: r.html, scheduledAt: r.at });
          } catch (err) {
            emailErrors.push(`Reminder (${r.at}) threw: ${err}`);
          }
        }
      }

      // 6. Partner notification
      if (partner_referral && partner_referral !== "No") {
        const partnerEmails = getPartnerEmails();
        const partnerEmail  = partnerEmails[partner_referral];
        if (partnerEmail) {
          try {
            await sendEmail({
              to: partnerEmail,
              subject: `New Harmony Grove registration from your network: ${first_name} ${last_name}`,
              html: emailPartnerNotify(partner_referral, { first_name, last_name, email, phone }),
            });
          } catch (err) {
            emailErrors.push(`Partner email threw: ${err}`);
          }
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, join_url: joinUrl, email_errors: emailErrors }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Registration error:", msg);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
