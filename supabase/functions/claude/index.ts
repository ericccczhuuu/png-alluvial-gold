// Supabase Edge Function：替网站调用 Claude。
// 只有带有效链接密钥或已登录的成员能调用；Anthropic 密钥只存在函数的环境变量里，不会出现在网页中。
// 部署前设置密钥：ANTHROPIC_API_KEY（必填）、CLAUDE_MODEL（可选，默认 claude-sonnet-5-5）。
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-access-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method" });

  // 两种身份：链接密钥（x-access-key），或登录用户（Authorization）。角色由数据库的 my_role() 判断。
  const key = req.headers.get("x-access-key") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const fwd: Record<string, string> = key ? { "x-access-key": key } : auth ? { Authorization: auth } : {};
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: fwd },
  });
  const { data: role } = await sb.rpc("my_role");
  if (!role) return json(403, { error: "not_member" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "json" }); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
  if (!messages.length || messages.some((x: any) => !["user", "assistant"].includes(x?.role) || typeof x?.content !== "string")) {
    return json(400, { error: "messages" });
  }
  if (messages.reduce((n: number, x: any) => n + x.content.length, 0) > 150_000) return json(413, { error: "too_long" });
  for (const im of images) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(im?.media_type) || typeof im?.data !== "string" || im.data.length > 7_000_000) {
      return json(400, { error: "image" });
    }
  }

  // 图片放进最后一条 user 消息，排在文字前面
  const out = messages.map((x: any) => ({ role: x.role, content: x.content as unknown }));
  if (images.length) {
    const last = out.length - 1;
    if (out[last].role !== "user") return json(400, { error: "messages" });
    out[last].content = [
      ...images.map((im: any) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
      { type: "text", text: messages[last].content },
    ];
  }

  const stream = body.stream === true;
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5-5",
      max_tokens: images.length ? 4096 : 2048,
      stream,
      messages: out,
    }),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
});
