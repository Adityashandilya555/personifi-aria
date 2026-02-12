# Aria Travel Guide - Multi-Stage Dockerfile with Playwright
# Stage 1: Build (includes devDependencies for tsc)
# Stage 2: Runtime (production-only deps)

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.48.0-focal AS builder

WORKDIR /app

# Install ALL dependencies (including devDependencies for TypeScript compilation)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.48.0-focal

WORKDIR /app

# Install production-only dependencies
COPY package*.json ./
RUN npm ci --only=production

# Install Playwright browsers
RUN npx playwright install chromium

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist
COPY config ./config

# Runtime
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
