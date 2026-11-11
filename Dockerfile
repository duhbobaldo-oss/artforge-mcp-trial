FROM node:24-bookworm-slim
WORKDIR /app
COPY drawing-tool/package.json drawing-tool/package-lock.json ./drawing-tool/
RUN npm ci --prefix drawing-tool --omit=dev --ignore-scripts && npm cache clean --force
COPY drawing-tool/src ./drawing-tool/src
COPY drawing-tool/fonts ./drawing-tool/fonts
COPY artforge-mcp ./artforge-mcp
COPY docs ./docs
COPY server.js ./server.js
RUN mkdir -p drawing-tool/data artforge-mcp/data/state artforge-mcp/data/artifacts outputs logs \
    && chown node:node drawing-tool/data artforge-mcp/data/state artforge-mcp/data/artifacts outputs logs
USER node
ENV HOST=0.0.0.0 PORT=4273 ARTFORGE_DEMO_TOKEN_FILE=/run/secrets/artforge_demo_token
EXPOSE 4273
CMD ["node", "server.js"]
