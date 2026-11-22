/* Worker do catálogo AbbaJu Mimos
 * - Serve o site estático (env.ASSETS)
 * - /api/* : login com usuário e senha (KV "USERS") e publicação no GitHub
 *
 * Segredo necessário (Cloudflare → Worker → Settings → Variables and Secrets):
 *   GITHUB_TOKEN  chave fine-grained do GitHub, só no repositório abbaju-catalog,
 *                 permissão Contents: Read and write
 */
const REPO = { owner: "atendimentokairosdigital-bit", repo: "abbaju-catalog", branch: "main" };
const COOKIE = "abbaju_s";
const SESSION_DAYS = 7;
const PBKDF2_ITER = 100000;
const MAX_FAILS = 8;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ erro: e.message }, e.status);
      console.log("erro", e && e.stack || e);
      return json({ erro: "Erro inesperado no servidor. Tente de novo." }, 500);
    }
  }
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

/* ---------------- Rotas ---------------- */
async function api(req, env, url) {
  if (!env.USERS) throw new HttpError(500, "O banco de usuários (KV) não está ligado ao Worker.");
  const m = req.method, p = url.pathname;
  if (m !== "GET") checkOrigin(req, url);

  if (p === "/api/me" && m === "GET") {
    const me = await currentUser(req, env);
    if (me) return json({ usuario: pub(me) });
    return json({ usuario: null, primeiroAcesso: !(await hasUsers(env)) });
  }
  if (p === "/api/setup" && m === "POST") {
    if (await hasUsers(env)) throw new HttpError(403, "O primeiro acesso já foi feito. Entre com seu usuário e senha.");
    const b = await body(req);
    const u = await createUser(env, b.usuario, b.senha, b.nome, "dona");
    return json({ usuario: pub(u) }, 200, { "set-cookie": await sessionCookie(env, u) });
  }
  if (p === "/api/login" && m === "POST") {
    const b = await body(req);
    const user = normUser(b.usuario);
    const failKey = "fail:" + user;
    const fails = +(await env.USERS.get(failKey) || 0);
    if (fails >= MAX_FAILS) throw new HttpError(429, "Muitas tentativas. Espere 15 minutos e tente de novo.");
    const u = user && await getUser(env, user);
    if (!u || !(await verifyPass(String(b.senha || ""), u))) {
      await env.USERS.put(failKey, String(fails + 1), { expirationTtl: 900 });
      throw new HttpError(401, "Usuário ou senha incorretos.");
    }
    await env.USERS.delete(failKey);
    return json({ usuario: pub(u) }, 200, { "set-cookie": await sessionCookie(env, u) });
  }
  if (p === "/api/logout" && m === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  /* ---- a partir daqui: precisa estar logada ---- */
  const me = await currentUser(req, env);
  if (!me) throw new HttpError(401, "Sua sessão expirou. Entre de novo.");

  if (p === "/api/senha" && m === "POST") {
    const b = await body(req);
    if (!(await verifyPass(String(b.atual || ""), me))) throw new HttpError(400, "A senha atual não confere.");
    checkPass(b.nova);
    Object.assign(me, await hashPass(String(b.nova)));
    await env.USERS.put("user:" + me.usuario, JSON.stringify(me));
    return json({ ok: true }, 200, { "set-cookie": await sessionCookie(env, me) });
  }
  if (p === "/api/usuarios" && m === "GET") {
    owner(me);
    const list = await env.USERS.list({ prefix: "user:" });
    const out = [];
    for (const k of list.keys) { const u = JSON.parse(await env.USERS.get(k.name) || "null"); if (u) out.push(pub(u)); }
    return json({ usuarios: out });
  }
  if (p === "/api/usuarios" && m === "POST") {
    owner(me);
    const b = await body(req);
    const u = await createUser(env, b.usuario, b.senha, b.nome, "editora");
    return json({ usuario: pub(u) });
  }
  if (p.startsWith("/api/usuarios/") && m === "DELETE") {
    owner(me);
    const user = normUser(decodeURIComponent(p.slice("/api/usuarios/".length)));
    if (user === me.usuario) throw new HttpError(400, "Você não pode remover o seu próprio acesso.");
    const u = await getUser(env, user);
    if (!u) throw new HttpError(404, "Usuário não encontrado.");
    if (u.papel === "dona") throw new HttpError(400, "O acesso principal não pode ser removido.");
    await env.USERS.delete("user:" + user);
    return json({ ok: true });
  }
  if (p === "/api/senha-usuario" && m === "POST") {
    owner(me);
    const b = await body(req);
    const u = await getUser(env, normUser(b.usuario));
    if (!u) throw new HttpError(404, "Usuário não encontrado.");
    checkPass(b.senha);
    Object.assign(u, await hashPass(String(b.senha)));
    await env.USERS.put("user:" + u.usuario, JSON.stringify(u));
    return json({ ok: true });
  }

  if (p === "/api/dados" && m === "GET") {
    const txt = await gh(env, `/contents/data.json?ref=${REPO.branch}`, { raw: true });
    return new Response(txt, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  if (p === "/api/publicar" && m === "POST") {
    const b = await body(req, 60 * 1024 * 1024);
    return json(await publish(env, b, me));
  }
  throw new HttpError(404, "Rota não encontrada.");
}

/* ---------------- Publicação no GitHub ---------------- */
async function publish(env, b, me) {
  const data = b && b.dados;
  if (!data || !Array.isArray(data.produtos) || !Array.isArray(data.cores) || typeof data.banners !== "object")
    throw new HttpError(400, "Dados inválidos.");
  const imgs = Array.isArray(b.imagens) ? b.imagens : [];
  for (const im of imgs) {
    if (!/^img\/[a-z0-9._-]+\.jpg$/i.test(im.path || "") || typeof im.b64 !== "string") throw new HttpError(400, "Imagem inválida.");
  }
  data.atualizado_em = new Date().toISOString();
  data.atualizado_por = me.usuario;
  const used = usedImgs(data);
  for (const path of used) if (!/^img\/[a-z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(path)) throw new HttpError(400, "Caminho de imagem inválido: " + path);

  const ref = await gh(env, `/git/ref/heads/${REPO.branch}`);
  const head = ref.object.sha;
  const commit = await gh(env, `/git/commits/${head}`);
  const curTree = await gh(env, `/git/trees/${commit.tree.sha}?recursive=1`);
  const exists = new Set(curTree.tree.map(t => t.path));
  let prevUsed = new Set();
  try { prevUsed = usedImgs(JSON.parse(await gh(env, `/contents/data.json?ref=${head}`, { raw: true }))); } catch (_) {}

  const tree = [{ path: "data.json", mode: "100644", type: "blob", content: JSON.stringify(data, null, 2) + "\n" }];
  for (const im of imgs) {
    if (!used.has(im.path)) continue;
    const blob = await gh(env, `/git/blobs`, { method: "POST", body: { content: im.b64, encoding: "base64" } });
    tree.push({ path: im.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const path of prevUsed) {
    if (!used.has(path) && path !== "img/logo.jpg" && path.startsWith("img/") && exists.has(path))
      tree.push({ path, mode: "100644", type: "blob", sha: null });
  }
  for (const path of used) {
    if (!exists.has(path) && !imgs.some(i => i.path === path)) throw new HttpError(400, `A foto ${path} não foi encontrada. Envie a foto de novo.`);
  }
  const nt = await gh(env, `/git/trees`, { method: "POST", body: { base_tree: commit.tree.sha, tree } });
  const nc = await gh(env, `/git/commits`, { method: "POST", body: { message: `Painel (${me.usuario}): atualiza catálogo`, tree: nt.sha, parents: [head] } });
  await gh(env, `/git/refs/heads/${REPO.branch}`, { method: "PATCH", body: { sha: nc.sha } });
  return { ok: true, commit: nc.sha };
}
function usedImgs(d) {
  const s = new Set();
  (d.produtos || []).forEach(p => p && p.img && s.add(p.img));
  ["principal", "natal"].forEach(g => ((d.banners || {})[g] || []).forEach(b => b && b.img && s.add(b.img)));
  return s;
}
async function gh(env, path, opts = {}) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, "Falta configurar a chave do GitHub (GITHUB_TOKEN) na Cloudflare.");
  const base = env.GITHUB_API || "https://api.github.com";
  const r = await fetch(`${base}/repos/${REPO.owner}/${REPO.repo}${path}`, {
    method: opts.method || "GET",
    headers: {
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "accept": opts.raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "abbaju-catalog-worker",
      ...(opts.body ? { "content-type": "application/json" } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!r.ok) {
    if (r.status === 401) throw new HttpError(502, "A chave do GitHub configurada na Cloudflare é inválida ou expirou.");
    if (r.status === 403 || r.status === 404) throw new HttpError(502, "A chave do GitHub não tem permissão de escrita no repositório abbaju-catalog.");
    if (r.status === 409 || r.status === 422) throw new HttpError(409, "O site foi alterado ao mesmo tempo por outro lugar. Tente publicar de novo.");
    throw new HttpError(502, `O GitHub respondeu com erro ${r.status}. Tente de novo em instantes.`);
  }
  return opts.raw ? r.text() : r.json();
}

/* ---------------- Usuários e senhas ---------------- */
const normUser = u => String(u || "").trim().toLowerCase();
const pub = u => ({ usuario: u.usuario, nome: u.nome, papel: u.papel, criado_em: u.criado_em });
function owner(me) { if (me.papel !== "dona") throw new HttpError(403, "Só o acesso principal pode gerenciar usuários."); }
async function hasUsers(env) { return (await env.USERS.list({ prefix: "user:", limit: 1 })).keys.length > 0; }
async function getUser(env, user) { const v = await env.USERS.get("user:" + user); return v ? JSON.parse(v) : null; }
function checkPass(p) { if (typeof p !== "string" || p.length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres."); }
async function createUser(env, usuario, senha, nome, papel) {
  const user = normUser(usuario);
  if (!/^[a-z0-9._-]{3,30}$/.test(user)) throw new HttpError(400, "O usuário precisa ter de 3 a 30 caracteres: letras, números, ponto, hífen ou _ (sem espaço).");
  checkPass(senha);
  if (await getUser(env, user)) throw new HttpError(409, "Esse usuário já existe.");
  const u = { usuario: user, nome: String(nome || user).trim().slice(0, 60) || user, papel, criado_em: new Date().toISOString(), ...(await hashPass(senha)) };
  await env.USERS.put("user:" + user, JSON.stringify(u));
  return u;
}
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function pbkdf2(pass, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
}
async function hashPass(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: b64(await pbkdf2(pass, salt)) };
}
async function verifyPass(pass, u) {
  const h = new Uint8Array(await pbkdf2(pass, unb64(u.salt))), ref = unb64(u.hash);
  if (h.length !== ref.length) return false;
  let d = 0; for (let i = 0; i < h.length; i++) d |= h[i] ^ ref[i];
  return d === 0;
}

/* ---------------- Sessão (cookie assinado) ---------------- */
async function secretKey(env) {
  let s = await env.USERS.get("__segredo_sessao");
  if (!s) { s = b64(crypto.getRandomValues(new Uint8Array(32))); await env.USERS.put("__segredo_sessao", s); }
  return crypto.subtle.importKey("raw", unb64(s), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const b64url = s => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
async function sessionCookie(env, u) {
  const payload = b64url(btoa(JSON.stringify({ u: u.usuario, v: u.hash.slice(0, 12), exp: Date.now() + SESSION_DAYS * 864e5 })));
  const sig = b64url(b64(await crypto.subtle.sign("HMAC", await secretKey(env), enc.encode(payload))));
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}
async function currentUser(req, env) {
  const c = (req.headers.get("cookie") || "").split(/;\s*/).find(x => x.startsWith(COOKIE + "="));
  if (!c) return null;
  const [payload, sig] = c.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await secretKey(env), unb64(unb64url(sig)), enc.encode(payload)); } catch (_) { return null; }
  if (!ok) return null;
  let s; try { s = JSON.parse(atob(unb64url(payload))); } catch (_) { return null; }
  if (!s.exp || s.exp < Date.now()) return null;
  const u = await getUser(env, s.u);
  if (!u || u.hash.slice(0, 12) !== s.v) return null;   // senha trocada ou usuário removido
  return u;
}

/* ---------------- Utilidades ---------------- */
function checkOrigin(req, url) {
  const o = req.headers.get("origin");
  if (o && o !== url.origin) throw new HttpError(403, "Origem não permitida.");
  const ct = req.headers.get("content-type") || "";
  if (req.method === "POST" && !ct.includes("application/json")) throw new HttpError(415, "Formato inválido.");
}
async function body(req, max = 64 * 1024) {
  const len = +(req.headers.get("content-length") || 0);
  if (len > max) throw new HttpError(413, "Envio grande demais. Tente com menos fotos por vez.");
  try { return await req.json(); } catch (_) { throw new HttpError(400, "Dados inválidos."); }
}
