# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a code change does not reinstall ws on every build.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# Inside a container the hub must listen on every interface, not just
# loopback, or nothing outside the container can reach it.
ENV HOST=0.0.0.0
ENV PORT=8090
EXPOSE 8090

# node:alpine ships an unprivileged `node` user; run as it, not root.
USER node

# Exec form, so the process is PID 1 and gets SIGTERM directly - the hub
# closes its upstream session on the way out instead of being killed.
CMD ["node", "src/index.mjs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
