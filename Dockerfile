# Zero-dependency build: plain Node, no npm install step.
FROM node:22-alpine AS runtime
RUN addgroup -S eyada && adduser -S eyada -G eyada
WORKDIR /app
COPY server.js booking-page.js package.json index.html ./
COPY notifiers/ ./notifiers/
COPY scripts/ ./scripts/
COPY payments/ ./payments/
COPY _next/ ./_next/
RUN chown -R eyada:eyada /app && mkdir -p /data && chown eyada:eyada /data
USER eyada
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
