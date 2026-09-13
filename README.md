# Foresight

[![CI](https://github.com/braiskeko/ai/actions/workflows/ci.yml/badge.svg)](https://github.com/braiskeko/ai/actions/workflows/ci.yml)

**Foresight** es una plataforma de **mercados de predicción** al estilo Polymarket: los usuarios compran y venden acciones sobre el resultado de eventos reales y el precio de cada acción refleja la probabilidad que el mercado asigna a ese resultado.

- Mercados **Sí/No** y **multi‑opción** (hasta 8 resultados).
- Precios en **céntimos** (`41¢` = 41 % de probabilidad) fijados por un creador de mercado automático **LMSR**; cada acción paga **1 USDC** si su resultado gana.
- **Gráficos en tiempo real** por WebSocket, actividad en directo, ranking de traders y cartera con PnL.
- **Comentarios** por mercado con hilos, "me gusta" y la posición del comentarista.
- **Mercados creados por los usuarios** con revisión previa de moderadores; los administradores publican al instante.
- Inicio de sesión con **Google**, **Apple** o **enlace mágico** por correo (sin contraseñas).
- **Depósitos y retiros de USDC** en Polygon o Base, con una **dirección de depósito personal por usuario**; grifo de prueba en testnet.
- **Panel de administración**: revisar mercados, resolverlos y procesar retiros.

> Aviso: los mercados de predicción con dinero real pueden estar regulados (apuestas, derivados, protección del consumidor) según la jurisdicción. Este proyecto es una base técnica; antes de operar con fondos reales consulta a un profesional legal.

---

## Índice

1. [Arquitectura](#arquitectura)
2. [Cómo funciona un mercado](#cómo-funciona-un-mercado)
3. [Roles](#roles)
4. [Ejecutar en local](#ejecutar-en-local)
5. [Variables de entorno](#variables-de-entorno)
6. [Despliegue gratuito en 10 minutos](#despliegue-gratuito-en-10-minutos)
7. [Despliegue con Docker](#despliegue-con-docker)
8. [Pasar a mainnet (dinero real)](#pasar-a-mainnet-dinero-real)
9. [API REST](#api-rest)
10. [WebSocket](#websocket)
11. [Checklist de seguridad](#checklist-de-seguridad)
12. [Estructura del proyecto](#estructura-del-proyecto)
13. [Scripts](#scripts)

---

## Arquitectura

```
┌────────────────────────────┐        ┌──────────────────────────────────────┐
│  Cliente (React 18 + Vite) │  HTTP  │  Servidor (Express, Node 20)         │
│  Tailwind · shadcn/ui      │◀──────▶│  · API REST /api/*                   │
│  wouter · react-query      │   WS   │  · WebSocket /ws (eventos en vivo)   │
│  recharts · framer-motion  │◀──────▶│  · AMM LMSR (server/lmsr.ts)         │
└────────────────────────────┘        │  · Ledger interno de saldos (USDC)   │
                                      │  · Observador de depósitos on-chain  │
                                      │  · Pago de retiros (tesorería)       │
                                      └──────────┬───────────────┬───────────┘
                                                 │ snapshot JSON │ ethers v6 (JSON-RPC)
                                                 ▼               ▼
                                   ┌──────────────────┐   ┌──────────────────────┐
                                   │ Postgres (Neon)  │   │ Polygon / Base       │
                                   │  o archivo JSON  │   │ contrato USDC (ERC20)│
                                   └──────────────────┘   └──────────────────────┘
```

**Stack.** Express + React 18 + Vite + TypeScript estricto + Tailwind + shadcn/ui + wouter + @tanstack/react-query v5 + recharts + framer-motion + lucide-react + date-fns v3 + zod + ws + jose + ethers v6. Los tipos de dominio y los esquemas zod compartidos entre cliente y servidor viven en `shared/schema.ts`.

**Persistencia por snapshot.** Todo el estado (usuarios, mercados, operaciones, posiciones, comentarios, depósitos, retiros) es un único documento JSON que se guarda de forma debounced tras cada mutación (`server/persistence.ts`):

- con `DATABASE_URL` → una fila JSONB en Postgres (el plan gratuito de Neon basta; la tabla `app_state` se crea sola);
- sin `DATABASE_URL` → el archivo `DATA_FILE` (por defecto `data/state.json`).

Los volúmenes de un MVP de mercados de predicción son pequeños, así que este modelo es más simple y robusto que un ORM completo y sobrevive a reinicios y redespliegues.

**Dinero: qué es on‑chain y qué no.** Seamos claros:

| Componente | Dónde vive |
| --- | --- |
| Custodia de USDC (depósitos de los usuarios) | **On‑chain**, en direcciones derivadas de `DEPOSIT_MNEMONIC` (una por usuario) |
| Pago de retiros | **On‑chain**, transferencia de USDC desde la wallet tesorería (`TREASURY_PRIVATE_KEY`) |
| Saldos de los usuarios | **Ledger interno** del servidor, respaldado por la custodia anterior |
| Mercados, precios, posiciones, resolución | **Off‑chain**: el AMM LMSR corre en el servidor y la resolución la decide un administrador |

Es decir, Foresight es una plataforma **custodial**: el operador controla los fondos y decide los resultados. No es un protocolo descentralizado ni *trustless*. Los usuarios deben confiar en el operador exactamente igual que en un exchange centralizado.

## Cómo funciona un mercado

- Cada mercado tiene `outcomes[]` (id = índice, nombre, color). Un mercado `binary` tiene exactamente dos resultados, "Yes" y "No".
- Los precios `prices[]` los fija el **LMSR** (*Logarithmic Market Scoring Rule*) con parámetro de liquidez `b`:
  `p_i = e^(q_i/b) / Σ_j e^(q_j/b)`. Siempre suman 1 y equivalen a la probabilidad implícita.
- Comprar mueve el precio al alza; vender, a la baja. El coste exacto se calcula con la función de coste `C(q) = b · ln Σ e^(q_i/b)`.
- **Cada acción paga 1 USDC** si su resultado gana y 0 en caso contrario. Comprar a `41¢` y acertar rinde `59¢` por acción.
- La pérdida máxima del creador de mercado está acotada por `b · ln(N)`; el creador del mercado elige la liquidez inicial (100 – 100 000 USDC) y, opcionalmente, las probabilidades iniciales.
- Ciclo de vida: `pending` → (`open` | `rejected`) → `closed` (fecha de fin alcanzada) → `resolved` (un administrador elige el resultado ganador y se pagan las posiciones).

## Roles

| Rol | Cómo se obtiene | Puede |
| --- | --- | --- |
| Usuario | Iniciar sesión (Google, Apple o enlace mágico) | Operar, crear mercados (quedan en revisión), comentar, depositar y retirar |
| Administrador | Su correo está en `ADMIN_EMAILS` | Todo lo anterior y además: publicar mercados al instante, aprobar/rechazar/destacar mercados de otros, resolver mercados y procesar retiros |

## Ejecutar en local

Requisitos: Node.js 20 o superior y npm.

```bash
npm install
cp .env.example .env      # opcional: sin .env todo funciona en modo demo
npm run dev
```

Abre <http://localhost:5000>. En desarrollo:

- Vite sirve el cliente con recarga en caliente a través del propio servidor Express.
- Sin `RESEND_API_KEY`, el inicio de sesión por correo está en **modo demo**: el enlace mágico se muestra en pantalla en lugar de enviarse.
- Sin `DATABASE_URL`, el estado se guarda en `data/state.json` (ignorado por git).
- La red por defecto es **Polygon Amoy (testnet)**: desde la cartera puedes usar el grifo para acreditar 1000 USDC de prueba y operar sin fondos reales.
- Pon tu correo en `ADMIN_EMAILS` para ver el panel de administración.

Compilación de producción en local:

```bash
npm run build     # cliente → dist/public, servidor → dist/index.js
npm start         # NODE_ENV=production node dist/index.js
```

## Variables de entorno

Todas están documentadas con detalle en [`.env.example`](./.env.example). Resumen:

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `APP_NAME` | No | Nombre visible (por defecto `Foresight`). |
| `APP_URL` | **Producción** | URL pública con `https://`; se usa en los enlaces mágicos y en las cookies. |
| `PORT` | No | Puerto HTTP (por defecto `5000`; Render lo inyecta). |
| `SESSION_SECRET` | **Producción** | 32+ bytes aleatorios para firmar las sesiones. Si falta, cada reinicio cierra todas las sesiones. |
| `ADMIN_EMAILS` | **Sí** | Correos administradores separados por comas. |
| `GOOGLE_CLIENT_ID` | No | Client ID de Google Identity Services. |
| `APPLE_CLIENT_ID` | No | Services ID de Sign in with Apple. |
| `RESEND_API_KEY` | No | Clave de resend.com para enviar enlaces mágicos. Sin ella: modo demo. |
| `EMAIL_FROM` | No | Remitente de los correos. |
| `CHAIN` | No | `polygon` \| `amoy` (defecto) \| `base` \| `base-sepolia`. |
| `RPC_URL` | Recomendada | Nodo RPC propio (Alchemy/Infura…); el público tiene límites. |
| `DEPOSIT_MNEMONIC` | **Producción** | Frase BIP‑39 que controla todas las direcciones de depósito. |
| `TREASURY_PRIVATE_KEY` | No | Wallet que paga retiros. Vacía → retiros manuales desde el panel. |
| `DEPOSITS_ENABLED` | No | `1` (defecto) vigila la cadena; `0` desactiva el observador. |
| `DATABASE_URL` | **Producción** | Postgres (Neon). Sin ella se usa `DATA_FILE`. |
| `DATA_FILE` | No | Ruta del JSON de estado (por defecto `data/state.json`). |

## Despliegue gratuito en 10 minutos

Usaremos **Neon** (Postgres gratuito) + **Render** (hosting gratuito con TLS y WebSockets). El repositorio ya incluye un [`render.yaml`](./render.yaml) que describe el servicio y sus variables.

### 1. Base de datos en Neon

1. Crea una cuenta en <https://neon.tech> y un proyecto nuevo (elige la región más cercana a Frankfurt, donde correrá el servidor).
2. En el panel del proyecto pulsa **Connect** y copia la *connection string* (`postgresql://…neon.tech/neondb?sslmode=require`). Sirve tanto la directa como la *pooled*.
3. Guárdala: será tu `DATABASE_URL`. No hay que crear tablas: la app crea `app_state` al arrancar.

### 2. Servicio web en Render

1. Sube el repositorio a GitHub.
2. Entra en <https://dashboard.render.com> → **New +** → **Blueprint** → conecta GitHub y selecciona el repositorio. Render lee `render.yaml` y muestra el servicio `foresight`.
3. Rellena las variables que pide:
   - `APP_URL`: la URL que Render asignará, `https://<nombre-del-servicio>.onrender.com` (con el Blueprint por defecto, `https://foresight.onrender.com`; si el nombre está ocupado Render añade un sufijo: despliega, copia la URL real y actualiza la variable).
   - `ADMIN_EMAILS`: tu correo.
   - `DATABASE_URL`: la cadena de Neon del paso 1.
   - Deja vacías por ahora `GOOGLE_CLIENT_ID`, `APPLE_CLIENT_ID`, `RESEND_API_KEY`, `DEPOSIT_MNEMONIC` y `TREASURY_PRIVATE_KEY`.
4. Pulsa **Apply**. El primer despliegue tarda 3–5 minutos (`npm ci --include=dev && npm run build` → `npm start`). `SESSION_SECRET` lo genera Render automáticamente y lo conserva entre despliegues.

### 3. Primer inicio de sesión

Abre la URL del servicio y pulsa **Entrar** → introduce tu correo. Como aún no hay `RESEND_API_KEY`, la app está en **modo demo** y muestra el enlace de acceso directamente en pantalla: haz clic y entrarás como administrador. Ya puedes crear mercados (se publican al instante) y probar la plataforma con el grifo de USDC de prueba de Amoy.

Para enviar los enlaces por correo de verdad: crea una cuenta en <https://resend.com>, genera una API key y añádela como `RESEND_API_KEY` en Render (Dashboard → foresight → Environment). Con el remitente por defecto `onboarding@resend.dev` sólo podrás enviarte correos a ti mismo; para el resto de usuarios verifica tu dominio en Resend y pon `EMAIL_FROM=Foresight <login@tudominio.com>`.

### 4. Activar Google y Apple

**Google (gratis, 5 minutos)**

1. <https://console.cloud.google.com> → crea o elige un proyecto.
2. **APIs y servicios → Pantalla de consentimiento de OAuth**: tipo *Externo*, nombre de la app, correo de soporte. Mientras esté en "Pruebas" sólo entran los usuarios de prueba que añadas; pulsa *Publicar* para abrirlo a todo el mundo.
3. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth** → tipo **Aplicación web**.
4. En **Orígenes de JavaScript autorizados** añade `APP_URL` (p. ej. `https://foresight.onrender.com`) y, para desarrollo, `http://localhost:5000`. No hace falta URI de redirección: se usa el flujo de ID token de Google Identity Services.
5. Copia el **ID de cliente** (`…apps.googleusercontent.com`) y ponlo en `GOOGLE_CLIENT_ID`. El botón de Google aparece automáticamente en la pantalla de acceso.

**Apple (requiere Apple Developer Program, 99 $/año)**

1. <https://developer.apple.com/account> → **Certificates, Identifiers & Profiles → Identifiers**.
2. Crea un **App ID** (tipo App) con la capacidad **Sign in with Apple** activada.
3. Crea un **Services ID** (p. ej. `com.tudominio.foresight.web`), activa **Sign in with Apple** → **Configure**: elige el App ID anterior como *Primary App ID*, en **Domains and Subdomains** pon el dominio de `APP_URL` sin `https://` (p. ej. `foresight.onrender.com`) y en **Return URLs** pon `APP_URL` completo.
4. Copia el identificador del Services ID y ponlo en `APPLE_CLIENT_ID`. Apple exige `https`, así que no funciona en `localhost`.

### 5. Comprobaciones finales

- `https://<tu-app>/api/config` responde JSON (es también el *health check* de Render).
- El plan gratuito de Render **duerme la instancia tras 15 minutos sin tráfico** y tarda ~1 minuto en despertar. Mientras duerme no se vigilan depósitos ni se pagan retiros automáticamente. Para un servicio real, usa un plan de pago (siempre encendido).
- El disco de Render es efímero: si por error quitas `DATABASE_URL`, el estado se perderá en el siguiente despliegue.

## Despliegue con Docker

La imagen es multi‑stage sobre `node:20-alpine`, corre como usuario `node`, expone el puerto 5000 y declara un `HEALTHCHECK` contra `/api/config`.

```bash
docker build -t foresight .
docker run --rm -p 5000:5000 --env-file .env \
  -v foresight-data:/app/data foresight
```

El volumen `/app/data` sólo se usa cuando no hay `DATABASE_URL`. La imagen final instala también las devDependencies porque `server/vite.ts` importa `vite` a nivel de módulo (ver comentario en el [`Dockerfile`](./Dockerfile)).

## Pasar a mainnet (dinero real)

Por defecto la app opera en **Polygon Amoy (testnet)**. Para aceptar USDC real:

1. **Genera la mnemónica de depósitos una sola vez**, en una máquina de confianza:

   ```bash
   node -e "console.log(require('ethers').Wallet.createRandom().mnemonic.phrase)"
   ```

   Guárdala en un gestor de secretos y haz una copia en papel. Ponla en `DEPOSIT_MNEMONIC`.

2. **Crea la wallet tesorería** (una cuenta EVM nueva y dedicada), exporta su clave privada a `TREASURY_PRIVATE_KEY` y fóndala con **USDC** (para pagar retiros) y **moneda nativa para el gas** (POL en Polygon, ETH en Base). Mantén ahí sólo el saldo operativo. Si prefieres no tener una clave caliente en el servidor, deja la variable vacía: los retiros quedarán *pendientes* y los pagarás a mano desde cualquier wallet, marcándolos como enviados con el hash de la transacción en el panel de administración.

3. **Configura la red** en Render (Environment) o en `.env`:

   ```
   CHAIN=polygon                # o "base"
   RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/TU_CLAVE
   DEPOSIT_MNEMONIC=doce palabras ...
   TREASURY_PRIVATE_KEY=0x...
   DEPOSITS_ENABLED=1
   ```

   El RPC público funciona pero se limita con facilidad; el plan gratuito de Alchemy o Infura es más que suficiente.

4. **Redespliega** y comprueba en la cartera que la red mostrada es Polygon (mainnet) y que el enlace al explorador apunta a polygonscan.com.

**Advertencias de seguridad y custodia — léelas:**

- **Las direcciones de depósito están controladas por la mnemónica.** Quien tenga `DEPOSIT_MNEMONIC` controla todos los fondos depositados por todos los usuarios. Si la cambias, cambian las direcciones y los fondos de las antiguas sólo son recuperables con la mnemónica anterior. Si no la defines, el servidor genera una y la guarda con el estado: **perder el estado = perder los depósitos**.
- **Los fondos no se barren automáticamente.** Los USDC quedan repartidos en la dirección de depósito de cada usuario. Para consolidarlos (por ejemplo en almacenamiento frío o para reponer la tesorería) tendrás que moverlos tú, importando la mnemónica en una wallet compatible o con un script con ethers, y pagando el gas de cada dirección.
- **Los retiros los paga la tesorería, no la dirección de depósito.** La tesorería es una wallet caliente: si el servidor se ve comprometido, esos fondos están en riesgo. Mantén el saldo mínimo, recárgala con frecuencia y vigila sus movimientos.
- **Los depósitos se acreditan tras N confirmaciones** (30 en Polygon, 12 en Base) al saldo interno. Los saldos internos son una promesa del operador respaldada por la custodia; asegúrate de que la suma de saldos nunca supere lo que realmente custodias (depósitos − retiros pagados).
- **Ley.** Operar con dinero real puede requerir licencias (juego, derivados, KYC/AML). Infórmate antes.

## API REST

Todas las rutas devuelven JSON. La autenticación es una cookie de sesión `httpOnly`; las rutas protegidas devuelven `401 {message}` sin sesión y las de administración `403` sin rol.

| Método | Ruta | Auth | Descripción / respuesta |
| --- | --- | --- | --- |
| `GET` | `/api/config` | — | `AppConfig` (nombre, proveedores de login, red, modo demo). Health check. |
| `GET` | `/api/me` | Usuario | `SafeUser` (`401` si no hay sesión). |
| `PATCH` | `/api/me` | Usuario | `{username}` → `SafeUser`. |
| `POST` | `/api/auth/magic` | — | `{email}` → `{ok:true, devLink?}` (`devLink` sólo en modo demo). |
| `GET` | `/api/auth/verify?token=…` | — | Crea la sesión y redirige a `/markets?welcome=1` o a `/?auth_error=invalid_link`. |
| `POST` | `/api/auth/google` | — | `{credential: idToken}` → `SafeUser`. |
| `POST` | `/api/auth/apple` | — | `{credential: idToken}` → `SafeUser`. |
| `POST` | `/api/auth/logout` | Usuario | `{ok:true}`. |
| `GET` | `/api/stats` | — | `PlatformStats` (volumen, traders, mercados abiertos, operaciones). |
| `GET` | `/api/markets` | — | `MarketSummary[]`. Query: `category`, `status` (`open` por defecto \| `closed` \| `resolved` \| `all`), `search`, `sort` (`volume` \| `newest` \| `ending` \| `trending`). Nunca devuelve `pending`/`rejected`. |
| `GET` | `/api/me/markets` | Usuario | `MarketSummary[]` creados por mí (incluye `pending`/`rejected`). |
| `GET` | `/api/markets/:slug` | — | `MarketDetail` (`404`; los `pending` sólo los ve su creador o un admin). |
| `POST` | `/api/markets` | Usuario | `CreateMarketInput` → `MarketSummary` (`pending`, u `open` si el autor es admin). |
| `POST` | `/api/markets/:id/quote` | Usuario | `{outcomeId, side, amount}` → `TradeQuote`. |
| `POST` | `/api/markets/:id/trade` | Usuario | `{outcomeId, side, amount}` → `{trade, market, user}`. |
| `POST` | `/api/markets/:id/comments` | Usuario | `{body, parentId?}` → `CommentView`. |
| `POST` | `/api/comments/:id/like` | Usuario | Alterna "me gusta" → `CommentView`. |
| `GET` | `/api/portfolio` | Usuario | `Portfolio` (saldo, posiciones, PnL, historial). |
| `GET` | `/api/wallet` | Usuario | `WalletView` (dirección de depósito, depósitos, retiros, red). |
| `POST` | `/api/wallet/withdraw` | Usuario | `{toAddress, amount}` → `Withdrawal`. |
| `POST` | `/api/wallet/faucet` | Usuario | Sólo testnet: acredita 1000 USDC de prueba → `SafeUser` (`403` en mainnet). |
| `GET` | `/api/leaderboard` | — | `LeaderboardEntry[]`. |
| `GET` | `/api/activity?limit=40` | — | `ActivityItem[]`. |
| `GET` | `/api/admin/markets?status=pending\|open\|closed` | Admin | `MarketSummary[]`. |
| `POST` | `/api/admin/markets/:id/review` | Admin | `{action:"approve"\|"reject", reason?, featured?}` → `MarketSummary`. |
| `POST` | `/api/admin/markets/:id/resolve` | Admin | `{outcomeId}` → `MarketSummary`. |
| `GET` | `/api/admin/withdrawals` | Admin | `Withdrawal[]`. |
| `POST` | `/api/admin/withdrawals/:id` | Admin | `{status:"sent"\|"failed", txHash?}` → `Withdrawal`. |

En `amount`, para `buy` es el USDC a gastar y para `sell` el número de acciones a vender. Los tipos (`MarketSummary`, `MarketDetail`, `TradeQuote`, `Portfolio`, …) están definidos en [`shared/schema.ts`](./shared/schema.ts).

## WebSocket

Conexión en `ws(s)://<host>/ws`. El servidor envía frames JSON `{event, payload}`:

| `event` | `payload` |
| --- | --- |
| `market:updated` | `{market: MarketSummary, trade: Trade & {user: PublicUser}}` — tras cada operación |
| `market:created` | `MarketSummary` |
| `market:reviewed` | `MarketSummary` — aprobado/rechazado por un admin |
| `market:resolved` | `MarketSummary` |
| `comment:created` | `CommentView` |
| `comment:updated` | `CommentView` — p. ej. cambio de "me gusta" |
| `deposit` | `{userId: number, deposit: Deposit}` — depósito on‑chain acreditado |

El cliente usa estos eventos para actualizar precios, gráficos, actividad y saldos sin recargar.

## Checklist de seguridad

Antes de abrir la plataforma al público:

- [ ] `SESSION_SECRET` fijo y aleatorio (32+ bytes); nunca el generado por defecto en cada arranque.
- [ ] `APP_URL` con `https://` (Render provee TLS). Cookies seguras dependen de ello.
- [ ] `ADMIN_EMAILS` sólo con cuentas de confianza, protegidas con 2FA en su proveedor (Google/Apple). Un admin puede resolver mercados y aprobar retiros.
- [ ] `RESEND_API_KEY` configurada: en modo demo cualquier persona puede entrar con cualquier correo (el enlace se muestra en pantalla).
- [ ] `DATABASE_URL` con `sslmode=require`; activa las copias de seguridad / *point‑in‑time restore* de Neon.
- [ ] `DEPOSIT_MNEMONIC` generada fuera de línea, guardada en un gestor de secretos y con copia de seguridad física. Nunca en git ni en logs.
- [ ] `TREASURY_PRIVATE_KEY` de una wallet dedicada con saldo mínimo; o vacía y retiros manuales desde una hardware wallet.
- [ ] `RPC_URL` de un proveedor propio (con clave) en lugar del RPC público.
- [ ] `.env` fuera del repositorio (ya está en `.gitignore`); secretos sólo en el panel del host.
- [ ] Barrido periódico de las direcciones de depósito hacia almacenamiento frío y conciliación: suma de saldos internos ≤ USDC custodiado.
- [ ] Revisión de dependencias (`npm audit`) y despliegue desde la CI (`npm run check` + `npm run build` + smoke test).
- [ ] Monitorización del health check `/api/config` y de los logs del servidor; alertas si la tesorería baja de un umbral.
- [ ] Plan de pago (instancia siempre encendida) si hay dinero real: la instancia gratuita duerme y deja de vigilar depósitos.
- [ ] Rotación inmediata de cualquier clave (Resend, Google, RPC, tesorería) ante una posible filtración.

## Estructura del proyecto

```
client/               Aplicación React (Vite)
  index.html
  src/
    components/       MarketCard, PriceChart, TradePanel, Navbar, UserAvatar, ui/ (shadcn)
    hooks/            use-toast, …
    lib/              format.ts, queryClient.ts, useLive.ts (WebSocket)
    pages/            rutas (wouter)
server/
  index.ts            Arranque de Express, logging, Vite en dev / estáticos en prod
  routes.ts           API REST + servidor WebSocket (/ws)
  storage.ts          Estado en memoria, lógica de negocio, snapshot
  lmsr.ts             Creador de mercado LMSR (precios, cotizaciones)
  persistence.ts      Backend Postgres (Neon) o archivo JSON, escritura debounced
  config.ts           Lectura de variables de entorno y redes soportadas
  email.ts            Envío de enlaces mágicos (Resend) / modo demo
  seed.ts             Datos de ejemplo
  vite.ts             Integración con Vite en desarrollo y servidor de estáticos
shared/
  schema.ts           Tipos de dominio, esquemas zod y modelos de la API
Dockerfile            Imagen de producción multi-stage
render.yaml           Blueprint de Render
.env.example          Documentación de todas las variables de entorno
.github/workflows/    CI (tipos, build, smoke test)
```

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo con Vite y recarga en caliente en <http://localhost:5000>. |
| `npm run check` | Comprobación de tipos con `tsc` (cliente, servidor y shared). |
| `npm run build` | Compila el cliente a `dist/public` y el servidor a `dist/index.js`. |
| `npm start` | Arranca el bundle de producción (`NODE_ENV=production`). |

## Licencia

MIT.
