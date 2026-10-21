// Upload door for the update scripts. Callers prove themselves with a token whose
// sha256 is stored in public.upload_tokens; the function then writes with the service key.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// table -> [upsert key (none = plain insert), columns returned]
const TABLES: Record<string, [string | undefined, string]> = {
  tiles: ["brand,name", "id,brand,name"],
  offers: [undefined, "id,tile_id"],
  offer_costs: ["offer_id", "offer_id"],
};

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const token = req.headers.get("x-upload-token");
  if (!token) return reply({ error: "no token" }, 401);
  const { data: ok } = await db.from("upload_tokens").select("hash").eq("hash", await sha256(token)).maybeSingle();
  if (!ok) return reply({ error: "bad token" }, 401);

  const url = new URL(req.url);
  const op = url.searchParams.get("op");

  if (op === "file") {
    const path = url.searchParams.get("path")!;
    const { error } = await db.storage.from("tiles").upload(path, await req.arrayBuffer(), {
      contentType: req.headers.get("content-type") ?? "image/jpeg",
      upsert: true,
    });
    return error ? reply({ error: error.message }, 500) : reply({ path });
  }

  if (op === "rows") {
    const table = url.searchParams.get("table")!;
    if (!(table in TABLES)) return reply({ error: "unknown table" }, 400);
    const rows = await req.json();
    const [key, columns] = TABLES[table];
    const q = key ? db.from(table).upsert(rows, { onConflict: key }) : db.from(table).insert(rows);
    const { data, error } = await q.select(columns);
    return error ? reply({ error: error.message }, 500) : reply({ rows: data });
  }

  if (op === "clear_offers") {
    const ids: number[] = await req.json();
    const { error } = await db.from("offers").delete().in("tile_id", ids);
    return error ? reply({ error: error.message }, 500) : reply({ cleared: ids.length });
  }

  return reply({ error: "unknown op" }, 400);
});
