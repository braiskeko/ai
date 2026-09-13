# syntax=docker/dockerfile:1

# =============================================================================
#  Foresight · imagen de producción (multi-stage)
#
#    docker build -t foresight .
#    docker run --rm -p 5000:5000 --env-file .env \
#      -v foresight-data:/app/data foresight
#
#  Etapa "builder": instala todas las dependencias y compila el cliente (Vite →
#  dist/public) y el servidor (esbuild → dist/index.js).
#  Etapa "runner":  imagen limpia con node_modules + dist, usuario sin
#  privilegios, healthcheck y volumen para el estado JSON.
#
#  NOTA sobre node_modules en la etapa final: el servidor se empaqueta con
#  `esbuild --packages=external`, así que todos los paquetes npm se resuelven
#  en tiempo de ejecución desde node_modules. server/vite.ts importa "vite" y
#  "../vite.config" (que a su vez importa @vitejs/plugin-react y
#  @replit/vite-plugin-runtime-error-modal) a NIVEL DE MÓDULO, aunque sólo se
#  usen en desarrollo. Con `npm ci --omit=dev` el proceso moriría al arrancar
#  con "Cannot find package 'vite'". Por eso la etapa final instala también las
#  devDependencies (`--include=dev`), y lo hace de forma explícita porque npm
#  omite las devDependencies automáticamente cuando NODE_ENV=production.
#
#  bufferutil (optionalDependency de ws) trae binarios precompilados para
#  linux-x64, así que no hace falta python3/make/g++ para compilarlo; si no
#  hubiera binario, ws funciona igual con su implementación en JavaScript.
# =============================================================================

# ----------------------------------------------------------------------------
#  1) Builder
# ----------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Primero sólo los manifiestos para aprovechar la caché de capas de Docker.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Código fuente (ver .dockerignore) y compilación.
COPY . .
RUN npm run build

# ----------------------------------------------------------------------------
#  2) Runner
# ----------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV PORT=5000

# Árbol de dependencias completo (ver nota de cabecera) y limpieza de la caché
# de npm para reducir el tamaño de la imagen.
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

# Artefactos compilados: dist/index.js (servidor) y dist/public (cliente).
COPY --from=builder --chown=node:node /app/dist ./dist

# Directorio para DATA_FILE (persistencia JSON cuando no hay DATABASE_URL).
# Con DATABASE_URL definido el directorio simplemente no se usa.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# El proceso corre sin privilegios. node_modules es de root pero legible.
USER node

# NODE_ENV se define DESPUÉS de npm ci para no perder las devDependencies.
ENV NODE_ENV=production

EXPOSE 5000

# /api/config responde sin autenticación y no toca la blockchain: ideal como
# comprobación de vida. wget viene incluido en busybox (alpine).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/config" || exit 1

CMD ["npm", "start"]
