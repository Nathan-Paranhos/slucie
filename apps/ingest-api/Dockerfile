FROM node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json eslint.config.js ./
COPY src ./src
RUN npm run build

FROM build AS verification
COPY test ./test
RUN npm test && npm run lint && npm run typecheck

FROM verification AS production-dependencies
RUN npm prune --omit=dev

FROM node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S sluice && adduser -S -G sluice -u 10001 sluice
COPY --from=production-dependencies --chown=sluice:sluice /app/package.json ./
COPY --from=production-dependencies --chown=sluice:sluice /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=sluice:sluice /app/dist ./dist
USER sluice
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
