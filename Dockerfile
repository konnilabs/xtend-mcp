FROM node:24.19.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY vendor ./vendor
RUN mkdir /data && chown node:node /data
USER node
ENV XTEND_MCP_BIND=0.0.0.0 XTEND_DATA_DIR=/data PORT=31415
EXPOSE 31415
CMD ["node", "src/main.mjs"]
