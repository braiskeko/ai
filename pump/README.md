# Next

**Next** es un *launchpad* de memecoins al estilo pump.fun: cualquier usuario crea una moneda en segundos (imagen, nombre, ticker, descripción), recibe al instante una **dirección de contrato (CA)** y la moneda empieza a cotizar sobre una **curva de precios (bonding curve)** en la que el resto de usuarios compra y vende con USDC. Cada operación paga una comisión del 2,7 % y el creador se lleva el 10 % de esa comisión de por vida.

- **Crear una moneda** con imagen, nombre, ticker, descripción y enlaces; asignación opcional al creador (0–30 % del suministro) y compra inicial.
- **Bonding curve de producto constante** con reservas virtuales (el modelo de pump.fun): el precio sube con cada compra y baja con cada venta, sin libro de órdenes ni proveedores de liquidez.
- **Gráfico de velas en tiempo real** (1 m, agregable a 5 m / 15 m / 1 h) con los avatares de los traders sobre las velas, panel de compra/venta con cotización en vivo, deslizamiento configurable e impacto en el precio.
- **Feed en directo**: nuevas monedas, operaciones y comentarios llegan por WebSocket (o *polling* donde el hosting no permite WebSockets).
- **King of the Hill** (la moneda abierta con mayor capitalización) y **graduación** al superar los 69 000 $ de capitalización.
- **Comentarios** con imágenes y "me gusta", pestaña de operaciones y ranking de *holders* por moneda.
- **Cartera y perfil**: saldo, posiciones con PnL, monedas creadas, ganancias como creador, historial.
- Inicio de sesión con **wallet del navegador** (MetaMask, Rabby…), **WalletConnect**, **Google**, **Apple** o **correo** (instantáneo en pre-lanzamiento, enlace mágico en producción).
- **Depósitos y retiros de USDC** en Polygon o Base con una dirección de depósito personal por usuario; grifo (*faucet*) en testnet.
- **Panel de administración** para acreditar saldos y consultar usuarios.
- **26 idiomas** en la interfaz (detección automática, selector en la cabecera, soporte RTL).

> **Nota de honestidad — qué es on-chain y qué no.** Las monedas de Next **no son tokens ERC-20 desplegados en una blockchain**. Viven en el **ledger interno de la plataforma**: la "dirección de contrato" es un identificador de 44 caracteres en base58 (termina en `next`) generado por el servidor, y la bonding curve la ejecuta el propio servidor (`server/curve.ts`). Lo único on-chain es la **custodia de USDC**: los depósitos llegan a direcciones reales derivadas de una mnemónica y los retiros se pagan desde una wallet tesorería. Es decir, Next es una plataforma **custodial y centralizada**, como un exchange; los usuarios confían en el operador. Operar con dinero real puede requerir licencias según la jurisdicción: consulta a un profesional legal antes de salir de testnet.

---

## Índice

1. [Arquitectura](#arquitectura)
2. [Cómo funciona una moneda](#cómo-funciona-una-moneda)
3. [Ejecutar en local](#ejecutar-en-local)
4. [Variables de entorno](#variables-de-entorno)
5. [Despliegue en app.noxia.work (cPanel)](#despliegue-en-appnextwork-cpanel)
6. [Limitaciones en hosting compartido](#limitaciones-en-hosting-compartido)
7. [API REST y WebSocket](#api-rest-y-websocket)
8. [Estructura del proyecto](#estructura-del-proyecto)
9. [Scripts](#scripts)

---

## Arquitectura

Next vive en `pump/` dentro del monorepo y es un proyecto **autónomo** (su propio `package.json`, `node_modules`, `tsconfig.json`). Comparte stack, convenciones y pipeline de despliegue con Foresight (la raíz del repositorio).

```
┌──────────────────────────────────┐        ┌──────────────────────────────────────────┐
│  Cliente (React 18 + Vite)       │  HTTP  │  Servidor (Express 4, Node 20)           │
│  Tailwind · shadcn/ui · wouter   │◀──────▶│  · API REST /api/*                       │
│  react-query · lightweight-charts│   WS   │  · WebSocket /ws (monedas, trades,       │
│  framer-motion · i18n (26 idiomas)│◀──────▶│    comentarios, saldos)                  │
└──────────────────────────────────┘        │  · Bonding curve (server/curve.ts)       │
                                            │  · CA base58 (server/ca.ts)              │
                                            │  · Ledger interno de saldos (USDC)       │
                                            │  · Imágenes → WebP (sharp) en data/uploads│
                                            │  · Observador de depósitos on-chain      │
                                            │  · Pago de retiros (tesorería)           │
                                            └──────────┬───────────────┬───────────────┘
                                                       │ snapshot JSON │ ethers v6 (JSON-RPC)
                                                       ▼               ▼
                                         ┌──────────────────┐   ┌──────────────────────┐
                                         │ Postgres (Neon)  │   │ Polygon / Base       │
                                         │  o data/state.json│   │ contrato USDC (ERC20)│
                                         └──────────────────┘   └──────────────────────┘
```

**Stack.** Express 4 + TypeScript estricto (ESM) + ws + zod + jose + ethers v6 + sharp + bs58 en el servidor; React 18 + Vite + Tailwind + shadcn/ui + wouter + @tanstack/react-query v5 + lightweight-charts v4 + framer-motion + lucide-react + date-fns v3 + react-hook-form en el cliente. Tipos, esquemas zod y constantes económicas compartidos en `shared/schema.ts`.

**Persistencia por snapshot.** Todo el estado (usuarios, monedas, operaciones, posiciones, velas, comentarios, depósitos, retiros) es un único documento JSON guardado de forma *debounced* tras cada mutación (`server/persistence.ts`): con `DATABASE_URL` en una fila JSONB de Postgres; sin ella en `DATA_FILE` (por defecto `data/state.json`). Las imágenes subidas (logos de monedas, adjuntos de comentarios, avatares) se normalizan a WebP con sharp y se guardan en `UPLOADS_DIR` (por defecto `data/uploads/{coins,comments,avatars}`), servidas en `/uploads/...`. En el despliegue cPanel la carpeta `data/` se conserva íntegra entre versiones.

**Dinero.**

| Componente | Dónde vive |
| --- | --- |
| Custodia de USDC (depósitos) | **On-chain**, direcciones derivadas de `DEPOSIT_MNEMONIC` (una por usuario) |
| Pago de retiros | **On-chain**, transferencia de USDC desde la tesorería (`TREASURY_PRIVATE_KEY`) |
| Saldos de los usuarios | **Ledger interno** del servidor, respaldado por la custodia anterior |
| Monedas, precios, posiciones, comisiones | **Off-chain**: la bonding curve corre en el servidor |

## Cómo funciona una moneda

Constantes en `shared/schema.ts`; matemáticas en `server/curve.ts`.

- Suministro total fijo: `TOTAL_SUPPLY = 1 000 000 000` tokens. El creador recibe `creatorAllocation` (0–30 %) al lanzar; el resto queda dentro de la curva.
- Curva de producto constante con reservas virtuales: `(U + vU) · (T + vT) = k`, donde `U` son los USDC reales de la curva, `T` los tokens que aún contiene, `vU = 4 000` y `vT = 1 073 000 000`.
- Precio *spot* = `(U + vU) / (T + vT)` USDC por token; capitalización = precio × suministro total. Una moneda recién lanzada vale ≈ 3 700 $ de capitalización.
- Cada compra y cada venta paga `SWAP_FEE = 2,7 %`. El 10 % de la comisión (`CREATOR_FEE_SHARE`) se acredita al instante al creador; el 90 % es ingreso de la plataforma.
- **King of the Hill**: la moneda abierta con mayor capitalización ≥ 30 000 $ (`KING_MCAP`). **Graduada**: capitalización ≥ 69 000 $ (`GRADUATION_MCAP`); es un hito visual, la moneda sigue cotizando en la curva.
- Velas de 1 minuto derivadas de las operaciones (`CANDLE_INTERVAL_MS`), con una vela sintética inicial al precio de lanzamiento; el cliente las agrega a 5 m / 15 m / 1 h.
- La **CA** se genera al crear la moneda (`server/ca.ts`): 44 caracteres base58 que terminan en `next`, únicos en la plataforma. La página de la moneda es `/{ca}`.

## Ejecutar en local

Requisitos: Node.js 20 o superior y npm. Todos los comandos se ejecutan **dentro de `pump/`**.

```bash
cd pump
npm install
npm run dev
```

Abre <http://localhost:5000>. En desarrollo:

- Vite sirve el cliente con recarga en caliente a través del propio servidor Express.
- Sin variables de entorno todo funciona en modo demo: el acceso por correo es instantáneo (`INSTANT_EMAIL_LOGIN=1`), el estado se guarda en `data/state.json` y las imágenes en `data/uploads/` (ambos ignorados por git).
- La red por defecto es **Polygon Amoy (testnet)**: desde la cartera puedes usar el grifo para acreditar USDC de prueba y comprar monedas sin fondos reales.
- El primer usuario que se registra en un despliegue vacío es administrador; también lo son los correos de `ADMIN_EMAILS`.
- Arranca con datos de ejemplo (bots, ~14 monedas con historial, comentarios, una moneda "King" y una graduada) para que la home no esté vacía.

Comprobaciones y compilación de producción:

```bash
npm run check     # tsc --noEmit (cliente, servidor y shared)
npm test          # tests del servidor (curva, CA, storage)
npm run build     # cliente → dist/public, servidor → dist/index.js
npm start         # NODE_ENV=production node dist/index.js
```

## Variables de entorno

El servidor las lee de `process.env` al arrancar (`server/config.ts`). Todas tienen valores por defecto válidos para desarrollo local.

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `APP_NAME` | No | Nombre visible (por defecto `Next`). Aparece también en el mensaje que firma la wallet al iniciar sesión. |
| `APP_URL` | **Producción** | URL pública con `https://` (`https://app.noxia.work`); se usa en los enlaces mágicos y en las cookies. |
| `PORT` | No | Puerto HTTP (por defecto `5000`; Passenger/cPanel lo inyecta). |
| `SESSION_SECRET` | **Producción** | 32+ bytes aleatorios para firmar las sesiones. Si falta se genera uno en cada arranque y todos los usuarios pierden la sesión al reiniciar. |
| `ADMIN_EMAILS` | Recomendada | Correos administradores separados por comas (acreditan saldos, ven el panel de administración). |
| `INSTANT_EMAIL_LOGIN` | No | `1` (defecto): escribir el correo crea la cuenta y la sesión al instante, sin verificación. Pon `0` para exigir el enlace mágico antes de salir a producción. |
| `GOOGLE_CLIENT_ID` | No | Client ID de Google Identity Services (tipo *Aplicación web*, con `APP_URL` en orígenes autorizados). |
| `APPLE_CLIENT_ID` | No | Services ID de Sign in with Apple (requiere https). |
| `WALLETCONNECT_PROJECT_ID` | No | Project ID de Reown/WalletConnect Cloud (gratis en <https://cloud.reown.com>). Activa el botón **WalletConnect** para wallets móviles. Sin él, el botón aparece deshabilitado; las **wallets del navegador** (MetaMask, Rabby, Coinbase Wallet…) funcionan siempre. |
| `RESEND_API_KEY` | No | Clave de <https://resend.com> para enviar enlaces mágicos. Sin ella la app está en modo demo y muestra el enlace en pantalla. |
| `EMAIL_FROM` | No | Remitente de los correos (por defecto `Next <onboarding@resend.dev>`). |
| `CHAIN` | No | `amoy` (defecto, testnet) \| `polygon` \| `base` \| `base-sepolia`. |
| `RPC_URL` | Recomendada | Nodo RPC propio (Alchemy, Infura…); el público tiene límites de peticiones. |
| `DEPOSIT_MNEMONIC` | **Producción** | Frase BIP-39 de la que se derivan todas las direcciones de depósito. Si falta se genera una y se guarda con el estado: perder el estado = perder los depósitos. |
| `TREASURY_PRIVATE_KEY` | No | Wallet que paga los retiros. Vacía → los retiros quedan pendientes para pagarlos a mano. |
| `DEPOSITS_ENABLED` | No | `1` (defecto) vigila la cadena y acredita depósitos; `0` desactiva el observador. |
| `INITIAL_CREDITS` | No | Créditos de saldo únicos aplicados al arrancar, p. ej. `alice:1000,bob:250` (cada entrada se aplica una sola vez). |
| `DATABASE_URL` | No | Postgres (Neon). Sin ella se usa `DATA_FILE`; en cPanel el disco es persistente y el archivo JSON es suficiente. |
| `DATA_FILE` | No | Ruta del JSON de estado (por defecto `data/state.json`). |
| `UPLOADS_DIR` | No | Carpeta de imágenes subidas (por defecto `data/uploads`). Se sirve en `/uploads/...`. |
| `NODE_ENV` | No | `production` sirve el cliente compilado y activa cookies seguras. `npm start` y `app.cjs` lo definen solos. |

## Despliegue en app.noxia.work (cPanel)

Next se despliega en el mismo hosting cPanel que Foresight, en el **subdominio `app.noxia.work`**, con el mismo mecanismo probado: se empaqueta un zip, se sube por la **API HTTP de cPanel** (sin SSH) y un cron de un solo uso ejecuta `deploy.sh` dentro de la cuenta, que registra la app en **Setup Node.js App** (CloudLinux Node.js Selector / Passenger). Ambas apps conviven en la cuenta sin pisarse: Next usa la carpeta `~/noxia-pump`, el conf `~/noxia-pump-deploy.conf` y los archivos `~/noxia-pump-deploy.{log,status}`.

### Opción A — GitHub Actions (recomendada)

Workflow: [`.github/workflows/deploy-pump.yml`](../.github/workflows/deploy-pump.yml).

1. En el repositorio, **Settings → Secrets and variables → Actions** crea los secretos `CPANEL_HOST` (p. ej. `next.work`), `CPANEL_USER` y `CPANEL_TOKEN` (cPanel → *Manage API Tokens*). Son los mismos que usa el despliegue de Foresight. Opcionales: `SESSION_SECRET` (mantiene las sesiones entre despliegues) y `WALLETCONNECT_PROJECT_ID`.
2. **Actions → "Deploy Next (pump) to cPanel" → Run workflow**. Los valores por defecto ya apuntan a `app.noxia.work`:

   | Input | Por defecto | Qué es |
   | --- | --- | --- |
   | `app_root` | `noxia-pump` | Carpeta de la app en el home de cPanel (*Application root*). |
   | `domain` | `app.noxia.work` | Dominio que sirve la app. **Si no existe, el workflow crea el subdominio** y solicita el certificado AutoSSL. |
   | `app_url` | `https://app.noxia.work` | `APP_URL` de la app. |
   | `admin_emails` | `braiskeko@gmail.com` | Administradores. |
   | `chain` | `amoy` | Red de USDC. |
   | `initial_credits` | — | Créditos únicos, p. ej. `alice:1000`. |
   | `wipe_public_html` | `false` | Sólo para el dominio principal; un subdominio no lo necesita. |

   También se dispara automáticamente al hacer *push* de cambios al propio archivo del workflow en la rama `claude/polymarket-platform-w64s54`.

3. El job hace `npm ci` → `npm run build` → `scripts/package-cpanel.sh` (genera `pump/noxia-pump-cpanel.zip`) → `node pump/scripts/cpanel-remote-deploy.mjs`, que:
   - sube el zip y el `noxia-pump-deploy.conf` al home de la cuenta (UAPI `Fileman/upload_files`);
   - consulta los dominios de la cuenta (UAPI `DomainInfo/list_domains`) y, si `app.noxia.work` no existe, lo crea con UAPI `SubDomain/addsubdomain` (raíz de documentos `public_html/app`; *fallback* API2 `SubDomain::addsubdomain`) y pide un certificado con UAPI `SSL/start_autossl_check`;
   - programa el cron de un solo uso (API2 `Cron::add_line`) que extrae `deploy.sh` del zip y lo ejecuta;
   - sigue el log remoto hasta que aparece `OK` o `FAILED_<motivo>` en `~/noxia-pump-deploy.status`, borra el cron y verifica `https://app.noxia.work/api/config`.

   **Sobre el certificado.** En un subdominio recién creado AutoSSL puede tardar unos minutos. La verificación prueba primero `https`; si falla por TLS comprueba la app sin validar el certificado y, si hace falta, por `http`. Si la app responde, el despliegue se da por bueno y se imprime una nota clara: revisa **cPanel → SSL/TLS Status → Run AutoSSL** si `https` sigue fallando pasados ~15 minutos.

4. `deploy.sh` (dentro de la cuenta) desempaqueta la versión en `~/noxia-pump`, **conserva `data/` completa** (`state.json` y `data/uploads/` con logos, adjuntos y avatares), reutiliza `node_modules` de la versión anterior, (re)crea la aplicación en el Node.js Selector (`--domain app.noxia.work --startup-file app.cjs` con las variables de entorno), instala dependencias de producción y reinicia.

### Opción B — a mano desde tu ordenador

```bash
cd pump
npm ci
bash scripts/package-cpanel.sh        # → noxia-pump-cpanel.zip

CPANEL_HOST=next.work CPANEL_USER=usuario CPANEL_TOKEN=token \
DOMAIN=app.noxia.work APP_URL=https://app.noxia.work ADMIN_EMAILS=tu@correo.com \
node scripts/cpanel-remote-deploy.mjs
```

Variables del script: `CPANEL_HOST`, `CPANEL_USER`, `CPANEL_TOKEN` (obligatorias); `APP_ROOT` (`noxia-pump`), `ZIP_PATH` (`noxia-pump-cpanel.zip`), `DOMAIN` (`app.noxia.work`), `APP_URL` (`https://DOMAIN`), `ADMIN_EMAILS`, `CHAIN` (`amoy`), `SESSION_SECRET` (aleatorio si falta), `INITIAL_CREDITS`, `WALLETCONNECT_PROJECT_ID`, `WIPE_PUBLIC_HTML` (`0`), `CPANEL_PORT` (`2083`), `DEPLOY_TIMEOUT_MIN` (`20`).

### Opción C — sin API, sólo con el panel de cPanel

1. Genera el zip como arriba y súbelo al **home** (no a `public_html`) con **File Manager**; extráelo: queda `~/noxia-pump`.
2. **Domains → Create A New Domain**: `app.noxia.work` con raíz de documentos `public_html/app` (si todavía no existe). Espera al certificado AutoSSL (**SSL/TLS Status**).
3. **Setup Node.js App → Create Application**: Node.js 20+, modo *Production*, *Application root* `noxia-pump`, *Application URL* `app.noxia.work` (`/`), *startup file* `app.cjs`.
4. Añade las variables de entorno (`NODE_ENV=production`, `APP_URL`, `SESSION_SECRET`, `ADMIN_EMAILS`, `CHAIN`…), pulsa **Run NPM Install** y **Restart**.
5. Para actualizar: sube el nuevo zip, extrae sobre `~/noxia-pump` **sin borrar `data/`** y pulsa **Restart**.

### Qué contiene el zip

`scripts/package-cpanel.sh` construye `noxia-pump-cpanel.zip` con la carpeta `noxia-pump/`:

- `dist/` (servidor compilado + cliente estático), `app.cjs` (arranque para Passenger: `import("./dist/index.js")`),
- `package.json` sólo con dependencias de producción (`engines.node >= 20`), `package-lock.json`,
- `deploy.sh` (el script que corre en la cuenta), `LEEME.md` (este archivo),
- `data/uploads/{coins,comments,avatars}/` vacíos para la primera versión.

Env del script: `APP_ROOT` (nombre de la carpeta/zip, por defecto `noxia-pump`) y `SKIP_BUILD=1` para reutilizar un `dist/` ya compilado (lo usa el workflow).

## Limitaciones en hosting compartido

- **WebSockets**: Passenger en cPanel normalmente no los enruta. El cliente lo detecta y pasa a *polling* cada 10 s: las monedas nuevas, operaciones y comentarios siguen llegando, sólo con algo más de latencia.
- **Depósitos on-chain**: el observador consulta el RPC cada pocos segundos. Si el hosting bloquea conexiones salientes pon `DEPOSITS_ENABLED=0` o usa un `RPC_URL` propio.
- **Imágenes**: sharp incluye binarios nativos (`libvips`); el `npm install` del Node.js Selector los descarga precompilados para Linux x64. Si fallara, revisa `~/noxia-pump-deploy.log`.
- **Memoria**: la app usa ~150–200 MB; los planes compartidos suelen dar 1 GB por aplicación.

## API REST y WebSocket

Todas las rutas devuelven JSON; la sesión es una cookie `httpOnly` (`nx_session`). Resumen (detalle en `server/routes.ts`):

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| `GET` | `/api/config` | — | Configuración pública (proveedores de login, red, WalletConnect). *Health check*. |
| `GET` `PATCH` | `/api/me` | Usuario | Perfil propio; `POST /api/me/avatar` sube el avatar. |
| `POST` | `/api/auth/{google,apple,email,magic,logout}` | — | Inicio y cierre de sesión. `GET /api/auth/verify?token=` valida el enlace mágico. |
| `GET` `POST` | `/api/auth/wallet/nonce`, `/api/auth/wallet` | — | Login con wallet: nonce + mensaje a firmar → firma verificada con ethers. |
| `GET` | `/api/stats`, `/api/activity` | — | Estadísticas de la plataforma y feed de actividad. |
| `GET` | `/api/coins?sort=&search=&limit=` | — | Lista de monedas (`new` \| `trending` \| `mcap` \| `volume` \| `graduated`). `GET /api/coins/king`. |
| `POST` | `/api/coins` | Usuario | Crear moneda (`CreateCoinInput`, imagen como data URL). Máx. 5 por hora. |
| `GET` | `/api/coins/:ca`, `/api/coins/:ca/candles` | — | Detalle (velas, operaciones, comentarios, holders) y velas. |
| `POST` | `/api/coins/:ca/quote`, `/api/coins/:ca/trade` | Usuario | Cotizar y ejecutar compra/venta (`minOut` para el deslizamiento). |
| `POST` | `/api/coins/:ca/comments`, `/api/comments/:id/like` | Usuario | Comentar (con imagen opcional) y "me gusta". |
| `GET` | `/api/portfolio`, `/api/wallet` | Usuario | Posiciones/PnL y cartera (dirección de depósito, retiros). `POST /api/wallet/withdraw`, `POST /api/wallet/faucet` (testnet). |
| `GET` | `/api/users/:username` | — | Perfil público. |
| `GET` `POST` | `/api/admin/users`, `/api/admin/users/credit` | Admin | Listar usuarios y acreditar saldo. |

WebSocket en `/ws`, frames `{event, payload}`: `coin:created`, `trade`, `comment:created`, `comment:updated`, `deposit`, `withdrawal:updated`, `balance:updated`.

## Estructura del proyecto

```
pump/
├── client/               React + Vite (rutas: / · /create · /portfolio · /wallet · /activity · /admin · /u/:username · /:ca)
│   └── src/
│       ├── components/   Navbar, CoinCard, CandleChart, TradePanel, Comments, LiveTicker, AuthModal, ui/ (shadcn)
│       ├── hooks/        useAuth, useWalletLogin, useConfig, use-toast…
│       ├── i18n/         I18nProvider, useT, LanguageSwitcher y locales/*.json (en.json es la fuente de verdad)
│       ├── lib/          queryClient, format (compactUsd, priceUsd, shortCa…), useLive
│       └── pages/
├── server/               Express: routes, storage (estado + snapshot), curve, ca, auth, walletAuth, chain, uploads, seed
├── shared/schema.ts      Tipos, esquemas zod y constantes económicas compartidos
├── deploy/deploy.sh      Script que corre dentro de la cuenta cPanel
├── scripts/
│   ├── package-cpanel.sh         Construye noxia-pump-cpanel.zip
│   └── cpanel-remote-deploy.mjs  Despliega el zip por la API de cPanel
└── data/                 Estado local (state.json) e imágenes subidas — no se versiona
```

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo con Vite y recarga en caliente en <http://localhost:5000>. |
| `npm run check` | Comprobación de tipos con `tsc` (cliente, servidor y shared). |
| `npm test` | Tests del servidor (`server/**/*.test.ts`). |
| `npm run build` | Compila el cliente a `dist/public` y el servidor a `dist/index.js`. |
| `npm start` | Arranca el bundle de producción (`NODE_ENV=production`). |
| `bash scripts/package-cpanel.sh` | Compila y genera `noxia-pump-cpanel.zip` para cPanel. |
| `node scripts/cpanel-remote-deploy.mjs` | Despliega el zip en cPanel por API (ver variables arriba). |

## Licencia

MIT.
