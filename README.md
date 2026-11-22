# Catálogo AbbaJu Mimos

Site estático do catálogo da loja AbbaJu Mimos (Shopee: https://shopee.com.br/joyce20171).

- `index.html` — página completa (catálogo, Coleção de Natal, como comprar e página de encomenda).
- `img/` — logo e fotos dos produtos.

Publicado automaticamente pela Cloudflare Pages a cada commit na branch `main`.
- `data.json` — produtos, banners e cores do “Quero personalizar”. **Não edite à mão:** use o painel.
- `admin.html` — painel de administração (abrir em `/admin`), com login por usuário e senha.
- `worker.js` — Worker da Cloudflare: serve o site e a API do painel (`/api/*`). Usuários ficam no KV `USERS` (senhas com PBKDF2); a publicação faz um commit no GitHub usando o segredo `GITHUB_TOKEN` configurado na Cloudflare (Settings → Variables and Secrets).
- O primeiro acesso ao `/admin` cria o acesso principal; ele pode criar outros acessos na aba “Acessos”.

Pedidos são enviados pelo WhatsApp.
