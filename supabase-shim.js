/* Supabase 适配层：在 claude.ai 之外提供 window.claude.use("db" | "assets" | "user" | "sample")，
   让 index.html 在 GitHub Pages 上也能录入数据、传照片、识别照片、问 Claude。
   未配置 config.js、或在 claude.ai 里打开时，本文件什么都不做。 */
(function () {
  "use strict";
  if (window.claude) return;
  var cfg = window.PNG_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase || !window.supabase.createClient) return;

  var BUCKET = "assets";
  var MAX_FILE = 20 * 1024 * 1024;
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true }
  });

  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function mapDbErr(e) {
    var m = (e && e.message) || "";
    var code = (e && e.code === "42501") || /row-level security/i.test(m) ? "invalid_argument"
      : /quota|exceeded the maximum/i.test(m) ? "quota_exceeded" : "error";
    return err(code, m);
  }
  function clean(o) { return JSON.parse(JSON.stringify(o)); }

  var sessionP = sb.auth.getSession().then(function (r) { return (r.data && r.data.session) || null; });
  var roleP = sessionP.then(function (s) {
    if (!s) return null;
    return sb.from("members").select("role").eq("user_id", s.user.id).maybeSingle()
      .then(function (r) { return r.data ? r.data.role : null; });
  });

  /* ---------- db ---------- */
  var listeners = {};
  function poke(c) { (listeners[c] || []).forEach(function (f) { f(); }); }

  function makeDb() {
    function fetchCol(c) {
      return sb.from("docs").select("id,data").eq("collection", c).order("created_at", { ascending: true })
        .then(function (r) { if (r.error) throw mapDbErr(r.error); return r.data || []; });
    }
    return {
      collection: function (c) {
        return {
          add: function (data) {
            return sb.from("docs").insert({ collection: c, data: clean(data) }).select("id").single().then(function (r) {
              if (r.error) throw mapDbErr(r.error);
              poke(c); return { id: r.data.id };
            });
          },
          onSnapshot: function (ok, bad) {
            var alive = true, timer = null;
            function load() {
              fetchCol(c).then(function (rows) {
                if (!alive) return;
                ok({ docs: rows.map(function (r) { return { id: r.id, data: function () { return r.data; } }; }) });
              }).catch(function (e) { if (alive && bad) bad(e); });
            }
            function sched() { clearTimeout(timer); timer = setTimeout(load, 120); }
            (listeners[c] = listeners[c] || []).push(sched);
            load();
            var ch = sb.channel("docs-" + c + "-" + Math.random().toString(36).slice(2))
              .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "collection=eq." + c }, sched)
              .subscribe();
            return function () {
              alive = false; clearTimeout(timer);
              listeners[c] = (listeners[c] || []).filter(function (f) { return f !== sched; });
              sb.removeChannel(ch);
            };
          }
        };
      },
      doc: function (path) {
        var i = path.indexOf("/"), c = path.slice(0, i), id = path.slice(i + 1);
        return {
          set: function (data) {
            return sb.from("docs").upsert({ id: id, collection: c, data: clean(data) }, { onConflict: "id" }).then(function (r) {
              if (r.error) throw mapDbErr(r.error); poke(c);
            });
          },
          update: function (patch) {
            return sb.rpc("docs_patch", { p_id: id, p_patch: clean(patch) }).then(function (r) {
              if (r.error) throw mapDbErr(r.error); poke(c);
            });
          },
          delete: function () {
            return sb.from("docs").delete().eq("id", id).eq("collection", c).then(function (r) {
              if (r.error) throw mapDbErr(r.error); poke(c);
            });
          }
        };
      }
    };
  }

  /* ---------- assets（私有存储桶 + 签名链接） ---------- */
  var urlCache = {};
  function signed(id) {
    var hit = urlCache[id];
    if (hit && Date.now() - hit.t < 50 * 60 * 1000) return hit.p;
    var p = sb.storage.from(BUCKET).createSignedUrl(id, 3600).then(function (r) {
      if (r.error) throw r.error; return r.data.signedUrl;
    });
    urlCache[id] = { t: Date.now(), p: p };
    return p;
  }
  function fixBlobs() {
    document.querySelectorAll('img[src^="/_blob/"],a[href^="/_blob/"]').forEach(function (el) {
      var attr = el.tagName === "IMG" ? "src" : "href";
      var id = el.getAttribute(attr).slice(7);
      signed(id).then(function (u) { el.setAttribute(attr, u); }).catch(function () {});
    });
  }
  var blobObserver = null;
  function makeAssets() {
    if (!blobObserver) {
      var pending = false;
      blobObserver = new MutationObserver(function () {
        if (pending) return; pending = true;
        setTimeout(function () { pending = false; fixBlobs(); }, 0);
      });
      blobObserver.observe(document.body, { childList: true, subtree: true });
      fixBlobs();
    }
    return {
      upload: function (file) {
        if (file.size > MAX_FILE) return Promise.reject(err("too_large"));
        var type = file.type || "application/octet-stream";
        if (!/^(image\/|application\/pdf$|text\/)/.test(type)) return Promise.reject(err("unsupported_type"));
        var id = (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2));
        return sb.storage.from(BUCKET).upload(id, file, { contentType: type, upsert: false }).then(function (r) {
          if (r.error) throw mapDbErr(r.error);
          return { id: id, contentType: type };
        });
      }
    };
  }

  /* ---------- sample（经 Supabase Edge Function 调用 Claude） ---------- */
  function toImage(file) {
    return createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
      var k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      var cv = document.createElement("canvas");
      cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
      return { media_type: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.85).split(",")[1] };
    }, function () { throw err("image_rejected"); });
  }

  async function callClaude(messages, images, opts) {
    var sess = (await sb.auth.getSession()).data.session;
    if (!sess) throw err("not_granted");
    var stream = !!opts.stream;
    var resp;
    try {
      resp = await fetch(cfg.supabaseUrl + "/functions/v1/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + sess.access_token, apikey: cfg.supabaseKey },
        body: JSON.stringify({ messages: messages, images: images, stream: stream }),
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") { var c = err("cancelled"); c.text = ""; throw c; }
      throw err("error");
    }
    if (!resp.ok) {
      throw err(resp.status === 401 || resp.status === 403 ? "not_granted"
        : resp.status === 429 ? "rate_limited"
        : (resp.status === 400 || resp.status === 413) && images.length ? "image_rejected" : "error");
    }
    if (!stream) {
      var j = await resp.json();
      var t = (j.content || []).map(function (b) { return b.text || ""; }).join("");
      return { text: t, truncated: j.stop_reason === "max_tokens" };
    }
    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = "", text = "", truncated = false;
    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        var lines = buf.split("\n"); buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var ln = lines[i];
          if (ln.indexOf("data:") !== 0) continue;
          var ev; try { ev = JSON.parse(ln.slice(5)); } catch (e) { continue; }
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
            text += ev.delta.text;
            if (opts.onText) opts.onText({ text: text });
          } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason === "max_tokens") {
            truncated = true;
          } else if (ev.type === "error") {
            var ee = err("error"); ee.text = text; throw ee;
          }
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") { var c2 = err("cancelled"); c2.text = text; throw c2; }
      throw e;
    }
    return { text: text, truncated: truncated };
  }

  function parseJson(text) {
    var s = text.replace(/```(?:json)?/gi, "").trim();
    var a = s.search(/[\[{]/); if (a < 0) throw err("error");
    var close = s[a] === "[" ? "]" : "}";
    var b = s.lastIndexOf(close); if (b < a) throw err("error");
    return JSON.parse(s.slice(a, b + 1));
  }

  function makeSample() {
    var sample = function (input, opts) {
      opts = opts || {};
      var msgs = typeof input === "string" ? [{ role: "user", content: input }] : input;
      return callClaude(msgs, [], { stream: true, signal: opts.signal, onText: opts.onText });
    };
    sample.json = async function (prompt, opts) {
      opts = opts || {};
      var imgs = [];
      var files = Array.prototype.slice.call(opts.images || [], 0, 4);
      for (var i = 0; i < files.length; i++) imgs.push(await toImage(files[i]));
      var r = await callClaude([{ role: "user", content: prompt }], imgs, { stream: false, signal: opts.signal });
      return parseJson(r.text);
    };
    sample.limits = function () { return Promise.resolve({ images: true }); };
    return sample;
  }

  /* ---------- window.claude ---------- */
  window.claude = {
    use: async function (name) {
      var sess = await sessionP, role = await roleP;
      if (name === "user") return { can: function () { return Promise.resolve(role === "editor"); } };
      if (!sess || !role) return null;
      if (name === "db") return makeDb();
      if (name === "assets") return role === "editor" ? makeAssets() : null;
      if (name === "sample") return makeSample();
      return null;
    }
  };

  /* ---------- 登录 / 退出按钮 ---------- */
  function mountAuth() {
    var conn = document.getElementById("conn");
    if (!conn || document.getElementById("auth-btn")) return;
    var btn = document.createElement("button");
    btn.id = "auth-btn"; btn.type = "button"; btn.className = "ghost";
    btn.style.cssText = "margin-left:10px;border:1px solid var(--line)";
    conn.insertAdjacentElement("afterend", btn);

    var dlg = document.createElement("dialog");
    dlg.style.cssText = "border:1px solid var(--line);border-radius:var(--r);background:var(--surface);color:var(--ink);padding:18px;max-width:340px;width:calc(100% - 32px)";
    dlg.innerHTML = '<form method="dialog" id="auth-form" style="display:grid;gap:10px">' +
      '<b>登录项目台</b><div class="small muted" style="font-size:13px;color:var(--muted)">只有被邀请的邮箱能登录。我们会发一封带登录链接的邮件，请在<b>当前这个浏览器</b>里打开它。</div>' +
      '<input id="auth-email" type="email" required placeholder="邮箱" autocomplete="email">' +
      '<div id="auth-msg" style="font-size:13px;min-height:1.2em"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="ghost" id="auth-cancel">取消</button><button type="submit" id="auth-send">发送登录链接</button></div></form>';
    document.body.appendChild(dlg);
    var msg = dlg.querySelector("#auth-msg");
    dlg.querySelector("#auth-cancel").onclick = function () { dlg.close(); };
    dlg.querySelector("#auth-form").onsubmit = async function (e) {
      e.preventDefault();
      var send = dlg.querySelector("#auth-send"); send.disabled = true; msg.textContent = "发送中…";
      var r = await sb.auth.signInWithOtp({
        email: dlg.querySelector("#auth-email").value.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname }
      });
      send.disabled = false;
      if (r.error) msg.textContent = /not allowed|not found|signups/i.test(r.error.message) ? "这个邮箱没有被邀请。" :
        /rate/i.test(r.error.message) ? "发得太频繁，请过几分钟再试。" : "发送失败：" + r.error.message;
      else msg.textContent = "已发送，请查收邮件并点击链接。";
    };

    sessionP.then(function (s) {
      if (s) {
        btn.textContent = "退出 · " + s.user.email;
        btn.onclick = async function () { await sb.auth.signOut(); location.reload(); };
      } else {
        btn.textContent = "登录";
        btn.onclick = function () { msg.textContent = ""; dlg.showModal(); };
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAuth);
  else mountAuth();
})();
