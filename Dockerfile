# Aria Travel Guide - Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

# Runtime
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
