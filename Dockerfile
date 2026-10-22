# Render/edit server: Node 22 + FFmpeg (with libass for caption burn-in) + fonts for Hindi.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fonts-noto-core fonts-noto-ui-core fontconfig ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
