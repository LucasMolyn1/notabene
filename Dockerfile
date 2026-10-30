# syntax=docker/dockerfile:1.7

# ---- Build : dépendances complètes, compilation du front (Vite) et du serveur (tsc)
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- Exécution : image minimale, utilisateur non root, système de fichiers en lecture seule (compose)
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0
# Commit transmis à la construction (voir README, « Versions et releases ») : affiché dans Paramètres, Instance.
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/CHANGELOG.md ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# npm et yarn ne servent pas à l'exécution : on les retire (moins de surface, et leurs dépendances
# embarquées ne sont plus signalées par les scanners d'image).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/index.js"]
