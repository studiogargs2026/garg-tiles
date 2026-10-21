// First-time sign up: only emails an admin has added to allowed_emails can make an account.
// Accounts are confirmed straight away, so nobody has to open an email link.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const { email, password } = await req.json().catch(() => ({}));
  const addr = String(email ?? "").trim().toLowerCase();
  if (!addr || String(password ?? "").length < 8) return reply({ error: "Enter your email and a password of at least 8 characters." }, 400);

  const { data: allowed } = await db.from("allowed_emails").select("full_name").eq("email", addr).maybeSingle();
  if (!allowed) return reply({ error: "This email has not been added yet. Ask an admin to add you." }, 403);

  const { error } = await db.auth.admin.createUser({
    email: addr, password, email_confirm: true, user_metadata: { full_name: allowed.full_name },
  });
  if (error) {
    const taken = /already|registered|exists/i.test(error.message);
    return reply({ error: taken ? "An account with this email already exists. Use Sign in." : error.message }, taken ? 409 : 500);
  }
  return reply({ ok: true });
});
