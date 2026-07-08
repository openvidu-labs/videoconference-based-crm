# Lilac CRM production image.
# Build from the repository root:  docker build -t lilac-crm:latest -f deploy/Dockerfile .
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
