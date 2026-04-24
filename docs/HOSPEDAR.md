# Hospedar o atualizador web no GitHub Pages

O site é **estático** (HTML + CSS + JS). Não precisas de servidor próprio.

## Requisitos

- Conta no [GitHub](https://github.com)
- Browser **Chrome** ou **Edge** (Web Serial) para quem for actualizar o hardware
- O teu repositório pode ser **público** (recomendado para GitHub Pages gratuito) ou privado com GitHub Pro/Team conforme a tua conta

## Método simples: pasta `docs` no mesmo repositório

1. Na raiz do repositório (onde está `guerrilhabox_updater.py` ou não), cria a pasta **`docs`**.

2. **Copia** o conteúdo da pasta `atualizador-web` para dentro de `docs`:
   - `index.html` → `docs/index.html`
   - `css/`, `js/` e `assets/` (incluindo a imagem do logo) com os mesmos ficheiros
   - Na raiz de `docs`, cria um ficheiro vazio com o nome **`.nojekyll`** (o GitHub Pages assim não trata a página com Jekyll, evitando problemas com ficheiros que começam por `_`).

3. Faz **commit** e **push** para a branch (por exemplo `main`).

4. No repositório no GitHub: **Settings** (Definições) → **Pages** (Páginas).

5. Em **Build and deployment** → **Source**:
   - **Deploy from a branch**
   - Branch: `main` (ou a tua)
   - Folder: **`/ (root)`** NÃO — escolhe **`/docs`**

6. **Save**. Em cerca de 1–2 minutos o endereço fica ativo, normalmente:
   - `https://O_TEU_UTILIZADOR.github.io/NOME_DO_REPO/`
   - Se o repositório se chama `user.github.io`, a URL pode ser `https://O_TEU_UTILIZADOR.github.io/`

7. A página **só** funciona com **HTTPS** (o GitHub dá isso de graça) — o Web Serial exige contexto seguro, por isso é o ideal.

## Se preferires a raiz do repositório só com o site

1. Torna o ficheiro `index.html` na **raiz** do repositório (e `css/`, `js/` ao lado).

2. Em **Pages** → **Source** → Branch **main** e pasta **`/ (root)`**.

(Assim misturas o projecto Python com o site na mesma raiz, pode ser confuso; por isso o método **`/docs`** costuma ser melhor para este repositório.)

## Importante

- A página carrega a biblioteca [esptool-js](https://github.com/espressif/esptool-js) a partir de **esm.sh** (Internet necessária na primeira carga, como qualquer site com CDN). Os teus ficheiros `.bin` **não** saem do teu computador.

- Se quiseres **só o site** noutro repositório, cria um repo vazio, mete aí o conteúdo de `atualizador-web` na **raiz** ou em **`docs`**, e activa Pages como em cima.

- **Domínio próprio** (opcional): em **Settings → Pages** → **Custom domain** podes mapear um domínio teu; segue a documentação do GitHub para DNS (registo A ou CNAME).

## A página fica a carregar / «Não deu a carregar o esptool.js»

- A página **precisa** de Internet na primeira carga: ela puxa o pacote [esptool-js](https://github.com/espressif/esptool-js) a partir de CDNs (jsdelivr, depois reservas). Sem rede ou com bloqueio (corporate proxy, uBlock, Pi-hole) pode falhar.
- Abre a **Consola** do browser (F12  Consola) e vê o erro: “Failed to fetch”, “CORS” ou 404 = rede/CDN.
- Tenta: **janela anónima**, desactivar bloqueio de anúncios **só** para o teu `*.github.io`, outra rede.
- Só **Chrome** / **Edge** (Chromium) com Web Serial.
- Se **liga** a biblioteca mas **não liga** ao dispositivo: reduz o **baud** (p.ex. 115200) e desliga/religa o cabo. O site usa ligação USB a bordo (padrão deste projecto).

## Testar no computador, sem publicar

### Isto NÃO dá: abrir o `index.html` com duplo clique

O browser acede como `file://...`. Módulos JavaScript (`<script type="module">` e o carregamento do **esptool** a partir de CDNs) **falha** nesse modo (restrição de seguranção / módulo). Tens de usar endereço **`http://`**, não ficheiro.

### Forma fácil (recomendado)

- **Windows:** deixa a pasta do projecto, entra em `atualizador-web` e faz **duplo clique** em **`servir-local.bat`**. Isto abre o browser em `http://127.0.0.1:8765/`. (É preciso **Python 3** instalado.)
- **Mac (ou Linux):** no Terminal, na pasta `atualizador-web`:
  - `chmod +x servir-local.sh`
  - `./servir-local.sh`
  - Abre o Chrome/Edge em `http://127.0.0.1:8765/`

### Manual, com Python 3

```bash
cd atualizador-web
python3 -m http.server 8765
```

No PC abre: **`http://127.0.0.1:8765`** (ou `http://localhost:8765`) no **Chrome** ou **Edge** — nunca ficheiro no Explorador.

O Web Serial a funcionar com `http://localhost` depende do browser (Chrome costuma sim). Com **problema no Mac e Serial**, o GitHub Pages com **HTTPS** costuma ser mais fiável; localmente, experimenta a mesma página em `localhost` e confirma nas definições de privacidade do browser se a porta é permitida.

---

Se algo falhar, confirma que vês a pasta `docs` com `index.html` no GitHub (interface web) e que em Pages está mesmo escolhido **Branch + /docs**.
