// LCSO Connect — "notify" Edge Function (v0.6)
// Sends phone/desktop notifications (web push) for new messages, and removes
// attachment files older than ATTACHMENT_DAYS (message text is kept).
// Deploy in Supabase > Edge Functions with the name: notify
//
// Actions (POST JSON):
//   { action: "key" }                 -> returns the public key devices use to subscribe
//   { action: "send", message_id: N } -> notifies the group (caller must be the sender);
//                                        also runs the attachment cleanup
//   { action: "test" }                -> sends a test notification to the caller's own devices
//   { action: "cleanup" }             -> admins only: run the attachment cleanup now
//
// The signing keys are created automatically on first use and stored in the
// server-only push_config table. No secret needs to be typed or pasted anywhere.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Server key is provided automatically by Supabase (never stored in code)
function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
  try { const o = JSON.parse(raw); return (o.default || Object.values(o)[0]) as string; } catch { return raw; }
}
const SERVICE_KEY = serverKey();
const SITE_URL = "https://lcema36.github.io/lcso-connect/";
const CONTACT = "mailto:EMAPIO@lafayettecoms.com";
const RANK = { routine: 0, priority: 1, urgent: 2 } as Record<string, number>;
const LEVEL = { all: 0, priority: 1, urgent: 2 } as Record<string, number>;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---- Attachment retention ----
const ATTACHMENT_DAYS = 7;

// Deletes files attached to messages older than ATTACHMENT_DAYS. The message
// stays; attachment_path is cleared and attachment_name is kept so the app can
// show "removed after 7 days".
async function cleanupAttachments() {
  const cutoff = new Date(Date.now() - ATTACHMENT_DAYS * 86400000).toISOString();
  const { data: old, error } = await db.from("messages")
    .select("id, attachment_path")
    .not("attachment_path", "is", null)
    .lt("created_at", cutoff)
    .limit(500);
  if (error) { console.error("cleanup query", error.message); return { removed: 0, error: error.message }; }
  let removed = 0;
  for (let i = 0; i < (old || []).length; i += 100) {
    const batch = old!.slice(i, i + 100);
    const { error: rmErr } = await db.storage.from("attachments").remove(batch.map((m) => m.attachment_path as string));
    if (rmErr) { console.error("cleanup remove", rmErr.message); continue; }
    await db.from("messages").update({ attachment_path: null }).in("id", batch.map((m) => m.id));
    removed += batch.length;
  }
  return { removed };
}

async function vapid() {
  let { data } = await db.from("push_config").select("public_key, private_key").eq("id", 1).maybeSingle();
  if (!data) {
    const k = webpush.generateVAPIDKeys();
    await db.from("push_config").upsert({ id: 1, public_key: k.publicKey, private_key: k.privateKey }, { onConflict: "id", ignoreDuplicates: true });
    ({ data } = await db.from("push_config").select("public_key, private_key").eq("id", 1).single());
  }
  webpush.setVapidDetails(CONTACT, data!.public_key, data!.private_key);
  return data!.public_key as string;
}

type Sub = { id: number; endpoint: string; p256dh: string; auth: string };

async function pushAll(subs: Sub[], payload: Record<string, unknown>, urgent: boolean) {
  let sent = 0, removed = 0, failed = 0;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: urgent ? 86400 : 43200, urgency: urgent ? "high" : "normal" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await db.from("push_subscriptions").delete().eq("id", s.id); removed++; }
      else { failed++; console.error("push failed", code, (e as Error).message); }
    }
  }));
  return { sent, removed, failed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Who is calling?
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await db.auth.getUser(token);
  const uid = who?.user?.id;
  if (!uid) return json({ error: "Not signed in" }, 401);
  const { data: me } = await db.from("profiles").select("id, full_name, rank, active").eq("id", uid).single();
  if (!me?.active) return json({ error: "Account inactive" }, 403);

  let input: { action?: string; message_id?: number } = {};
  try { input = await req.json(); } catch { /* empty body */ }
  const publicKey = await vapid();

  if (input.action === "key") return json({ publicKey });

  if (input.action === "test") {
    const { data: subs } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", uid);
    const r = await pushAll(subs || [], {
      title: "LCSO Connect", body: "Alerts are working on this device.", tag: "lcso-test", url: SITE_URL,
    }, false);
    return json({ ok: true, devices: (subs || []).length, ...r });
  }

  if (input.action === "cleanup") {
    const { data: admin } = await db.from("profiles").select("is_admin").eq("id", uid).single();
    if (!admin?.is_admin) return json({ error: "Admins only" }, 403);
    return json({ ok: true, days: ATTACHMENT_DAYS, ...(await cleanupAttachments()) });
  }

  if (input.action === "send") {
    // Housekeeping first, so it runs whenever the app is in use
    const cleanup = await cleanupAttachments().catch((e) => ({ removed: 0, error: String(e) }));
    const id = Number(input.message_id);
    const { data: msg } = await db.from("messages").select("*").eq("id", id).single();
    if (!msg) return json({ error: "Message not found" }, 404);
    if (msg.sender_id !== uid) return json({ error: "Only the sender can trigger notifications" }, 403);

    // Claim the message so it is only ever notified once
    const { data: claimed } = await db.from("messages")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", id).is("notified_at", null).select("id");
    if (!claimed?.length) return json({ ok: true, skipped: "already notified" });

    const { data: group } = await db.from("groups").select("name").eq("id", msg.group_id).single();
    const { data: members } = await db.from("group_members").select("user_id").eq("group_id", msg.group_id);
    const ids = (members || []).map((m) => m.user_id).filter((u) => u !== uid);
    if (!ids.length) return json({ ok: true, sent: 0, cleanup });

    const { data: people } = await db.from("profiles").select("id, active, notify_level").in("id", ids);
    const want = (people || []).filter((p) => p.active && RANK[msg.priority] >= (LEVEL[p.notify_level] ?? 0)).map((p) => p.id);
    if (!want.length) return json({ ok: true, sent: 0, cleanup });

    const { data: subs } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", want);
    const label = msg.priority === "urgent" ? "URGENT — " : msg.priority === "priority" ? "PRIORITY — " : "";
    const text = String(msg.body);
    const r = await pushAll(subs || [], {
      title: `${label}${group?.name || "LCSO Connect"}`,
      body: `${me.full_name}: ${text.length > 180 ? text.slice(0, 177) + "…" : text}${msg.attachment_name ? " 📎" : ""}`,
      tag: `lcso-${msg.id}`,
      url: `${SITE_URL}?group=${msg.group_id}`,
      urgent: msg.priority === "urgent",
    }, msg.priority === "urgent");
    return json({ ok: true, recipients: want.length, devices: (subs || []).length, ...r, cleanup });
  }

  return json({ error: "Unknown action" }, 400);
});
