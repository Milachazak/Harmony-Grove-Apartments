// Harmony Grove — Webinar Registration Edge Function
// Deploy via: Supabase Dashboard → Edge Functions → New Function → paste this code
//
// Environment variables to set in Supabase Dashboard → Edge Functions → Secrets:
//   ZOOM_ACCOUNT_ID       — from your Zoom Server-to-Server OAuth app
//   ZOOM_CLIENT_ID        — from your Zoom Server-to-Server OAuth app
//   ZOOM_CLIENT_SECRET    — from your Zoom Server-to-Server OAuth app
//   PIPEDRIVE_API_KEY     — 65486fc56e170311f9f8010f5f18c374c51122bc
//   RESEND_API_KEY        — re_Tj4bUWkG_C4cyMNfXqSYiamVEbtnryoYJ
//   RESEND_FROM           — e.g. webinar@milapennchazak.com (must be verified in Resend)
//   PARTNER_3DSSS_EMAIL   — email for 3DSSS Capital Investment LLC
//   PARTNER_EAGLECAP_EMAIL — email for EagleCap Ventures
//   PARTNER_KYNECTIC_EMAIL — email for Kynectic Capital
//   PARTNER_P1_EMAIL      — email for P1 Capital Investment

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WEBINAR_ID = "89370896771"; // Zoom Webinar ID (spaces removed)

// ─── Partner email map ────────────────────────────────────────────────────────
function getPartnerEmails(): Record<string, string> {
  return {
    "3DSSS Capital Investment LLC": Deno.env.get("PARTNER_3DSSS_EMAIL") ?? "",
    "EagleCap Ventures":            Deno.env.get("PARTNER_EAGLECAP_EMAIL") ?? "",
    "Kynectic Capital":             Deno.env.get("PARTNER_KYNECTIC_EMAIL") ?? "",
    "P1 Capital Investment":        Deno.env.get("PARTNER_P1_EMAIL") ?? "",
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
  reg: { first_name: string; last_name: string; email: string; phone: string }
): Promise<{ join_url: string; registrant_id: string }> {
  const res = await fetch(
    `https://api.zoom.us/v2/webinars/${WEBINAR_ID}/registrants`,
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
  });
  return created.data.id;
}

async function getOrCreatePipelineStage(): Promise<{ pipelineId: number; stageId: number }> {
  // Find "Harmony Grove Pipeline"
  const pipelines = await pdFetch("/pipelines");
  let pipeline = pipelines.data?.find((p: any) =>
    p.name.toLowerCase().includes("harmony grove")
  );

  let pipelineId: number;
  if (pipeline) {
    pipelineId = pipeline.id;
  } else {
    const created = await pdFetch("/pipelines", "POST", { name: "Harmony Grove Pipeline", deal_probability: 1 });
    pipelineId = created.data.id;
  }

  // Find "Incoming Leads" stage
  const stages = await pdFetch(`/stages?pipeline_id=${pipelineId}`);
  let stage = stages.data?.find((s: any) => s.name.toLowerCase().includes("incoming"));

  let stageId: number;
  if (stage) {
    stageId = stage.id;
  } else if (stages.data?.length > 0) {
    stageId = stages.data[0].id;
  } else {
    const created = await pdFetch("/stages", "POST", { name: "Incoming Leads", pipeline_id: pipelineId });
    stageId = created.data.id;
  }

  return { pipelineId, stageId };
}

async function createPipedriveDeal(data: {
  first_name: string; last_name: string; email: string; phone: string;
  referral_source: string; partner_referral: string;
}): Promise<number> {
  const [personId, { pipelineId, stageId }] = await Promise.all([
    findOrCreatePerson(data),
    getOrCreatePipelineStage(),
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
const FROM = `Kirk, Rosanmi & Claude - Mila Penn Chazak <${Deno.env.get("RESEND_FROM") ?? "invest@milapennchazak.com"}>`;

async function sendEmail(opts: {
  to: string; subject: string; html: string; scheduledAt?: string;
}) {
  const key  = Deno.env.get("RESEND_API_KEY")!;
  const body: Record<string, unknown> = {
    from: FROM, to: [opts.to], subject: opts.subject, html: opts.html,
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
    <p>We're really glad you're here. The Harmony Grove webinar is set for <strong>Monday, May 4th at 6:30 PM EST</strong>, and we've put a lot of care into making sure it's worth your time.</p>
    <p>This is a real conversation — not a pitch deck read out loud. We'll walk through the property, the numbers, the market, and how the deal is structured. You'll have plenty of time to ask us anything.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Monday, May 4, 2026</strong></span></div>
      <div class="box-row"><span class="box-icon">🕕</span><span class="box-val"><strong>6:30 PM EST</strong> &nbsp;·&nbsp; approximately 75 minutes</span></div>
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
    <p>Just a heads up — the Harmony Grove webinar is this <strong>Monday at 6:30 PM EST</strong>.</p>
    <p>We'll be walking through the full picture: the asset, the numbers, the renovation plan, and how this deal is structured for investors like you. Bring your questions — we'll save real time for them.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val"><strong>Monday, May 4, 2026 &nbsp;·&nbsp; 6:30 PM EST</strong></span></div>
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
    <p>The Harmony Grove webinar is <strong>tonight at 6:30 PM EST</strong>. We're looking forward to it.</p>
    <p>Grab a quiet room, a good chair, and your questions. This is the real conversation — no fluff, no rehearsed script. Just the deal, the market, and honest answers.</p>
    <div class="btn-wrap"><a href="${joinUrl}" class="btn">Join Tonight at 6:30 PM EST →</a></div>
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

function emailPartnerNotify(
  partnerName: string,
  reg: { first_name: string; last_name: string; email: string; phone: string }
): string {
  return wrap(`
    <h1>A registration from your network.</h1>
    <p>Hi ${partnerName} team,</p>
    <p>Someone registered for the Harmony Grove investor webinar and indicated they're working with you. We wanted to make sure you had their details.</p>
    <div class="box">
      <div class="box-row"><span class="box-icon">👤</span><span class="box-val"><strong>${reg.first_name} ${reg.last_name}</strong></span></div>
      <div class="box-row"><span class="box-icon">📧</span><span class="box-val">${reg.email}</span></div>
      <div class="box-row"><span class="box-icon">📞</span><span class="box-val">${reg.phone}</span></div>
      <div class="box-row"><span class="box-icon">📅</span><span class="box-val">Registered for Monday, May 4, 2026 · 6:30 PM EST</span></div>
    </div>
    <p>We'll take care of them on the webinar side. Feel free to reach out to them directly in the meantime — they're expecting to hear from you.</p>
    <p>Thank you for the introduction. We're grateful for this partnership.</p>
    <div class="sig">
      <div class="sig-name">Kirk, Rosanmi & Claude</div>
      <div class="sig-co">Mila Penn Chazak</div>
    </div>
  `);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { first_name, last_name, email, phone, referral_source, partner_referral } =
      await req.json();

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

    // 1. Zoom registration
    let joinUrl = "";
    let zoomRegistrantId = "";
    try {
      const token = await getZoomToken();
      const zoom  = await registerOnZoom(token, { first_name, last_name, email, phone });
      joinUrl         = zoom.join_url;
      zoomRegistrantId = zoom.registrant_id;
    } catch (err) {
      console.error("Zoom error:", err);
      // Non-fatal — continue registration without Zoom link
    }

    // 2. Save to Supabase
    await supabase.from("webinar_registrants").upsert(
      { first_name, last_name, email, phone, referral_source, partner_referral,
        zoom_join_url: joinUrl, zoom_registrant_id: zoomRegistrantId },
      { onConflict: "email" }
    );

    // 3. Pipedrive deal
    try {
      await createPipedriveDeal({ first_name, last_name, email, phone, referral_source, partner_referral });
    } catch (err) {
      console.error("Pipedrive error:", err);
    }

    const emailErrors: string[] = [];

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
      { at: "2026-05-01T14:00:00.000Z", subject: `Three days away, ${first_name} — Harmony Grove Webinar`,   html: email3Day(first_name, joinUrl) },
      { at: "2026-05-04T13:00:00.000Z", subject: `Today's the day, ${first_name} — Harmony Grove is tonight`, html: emailDayOf(first_name, joinUrl) },
      { at: "2026-05-04T22:00:00.000Z", subject: `${first_name} — we start in 30 minutes`,                    html: email30Min(first_name, joinUrl) },
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
            subject: `New Harmony Grove registration from your network — ${first_name} ${last_name}`,
            html: emailPartnerNotify(partner_referral, { first_name, last_name, email, phone }),
          });
        } catch (err) {
          emailErrors.push(`Partner email threw: ${err}`);
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
