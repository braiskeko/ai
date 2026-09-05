# Desplegar Foresight en un hosting cPanel (Node.js)

Foresight es una aplicación **Node.js** (servidor Express + cliente React compilado).
Solo funciona en hostings cPanel que ofrezcan **"Setup Node.js App"** (CloudLinux
Node.js Selector con Passenger). Si esa opción no aparece en tu cPanel, el hosting
no puede ejecutarla: usa Render (ver `render.yaml`) u otro proveedor con Node.

## 1. Generar el paquete

En tu ordenador (o en este repo) ejecuta:

```bash
npm install
bash scripts/package-cpanel.sh
```

Se crea `foresight-cpanel.zip` con:

- `dist/` (servidor compilado + cliente estático)
- `app.cjs` (arranque para Passenger), `package.json` solo con dependencias de producción
- `.env.example` (documentación de todas las variables)

## 2. Subir y descomprimir

1. cPanel → **File Manager** → entra en tu carpeta home (no en `public_html`).
2. **Upload** → sube `foresight-cpanel.zip`.
3. Selecciona el zip → **Extract**. Queda la carpeta `~/foresight`.
4. Si quieres que el dominio principal sirva la app, **vacía `public_html`**
   (haz copia antes: selecciona todo → Compress → descarga el zip → borra).
   La app no vive en `public_html`; Passenger la enruta desde `~/foresight`.

## 3. Crear la aplicación Node.js

cPanel → **Setup Node.js App** → **Create Application**:

| Campo | Valor |
| --- | --- |
| Node.js version | 20 o superior |
| Application mode | Production |
| Application root | `foresight` |
| Application URL | tu dominio (raíz `/`) |
| Application startup file | `app.cjs` |

Pulsa **Create**. Después, en la misma pantalla:

1. **Environment variables** → añade al menos:
   - `NODE_ENV` = `production`
   - `APP_URL` = `https://tudominio.com`
   - `SESSION_SECRET` = una cadena aleatoria larga
   - `ADMIN_EMAILS` = tu email (serás administrador: publicas sin revisión, apruebas mercados, resuelves, procesas retiros)
   - `CHAIN` = `amoy` (testnet) o `polygon` (mainnet, ver README)
   - Opcionales: `GOOGLE_CLIENT_ID`, `APPLE_CLIENT_ID`, `RESEND_API_KEY`, `EMAIL_FROM`, `DATABASE_URL`, `DEPOSIT_MNEMONIC`, `TREASURY_PRIVATE_KEY`.
2. **Run NPM Install** (instala solo dependencias de producción).
3. **Restart**.

Abre tu dominio: deberías ver la landing. Entra con tu email; sin `RESEND_API_KEY`
la app está en "modo demo" y muestra el enlace de acceso en pantalla.

## 4. Persistencia de datos

Sin `DATABASE_URL` el estado se guarda en `~/foresight/data/state.json`. En cPanel el
disco es persistente, así que sobrevive reinicios. Para mayor robustez crea una base
de datos gratuita en [neon.tech](https://neon.tech) y pon su cadena en `DATABASE_URL`.

## 5. Limitaciones en hosting compartido

- **WebSockets**: Passenger en cPanel normalmente no los enruta. La app lo detecta y
  pasa a modo "polling" (actualiza precios cada 15 s). Todo lo demás funciona igual.
- **Depósitos on-chain**: el vigilante consulta el RPC público cada 20 s. Si el hosting
  bloquea conexiones salientes, pon `DEPOSITS_ENABLED=0` o usa un `RPC_URL` propio.
- **Memoria**: los planes compartidos suelen dar 1 GB por app; la aplicación usa ~150 MB.

## 6. Actualizar

Repite el paso 1, sube el nuevo zip, extrae sobrescribiendo `~/foresight` (no borres
`data/`), y pulsa **Restart** en Setup Node.js App.
