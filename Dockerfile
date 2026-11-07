# One image, two roles: the firm (`node src/server/index.js`) and the second
# firm (`node scripts/firm_worker.mjs`). No build step, no runtime dependencies.

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Only what the running processes need. Contracts are deployed from a dev
# machine, not from the serving image.
COPY package.json ./
COPY src ./src
COPY frontend ./frontend
COPY scripts ./scripts

RUN mkdir -p /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/index.js"]
