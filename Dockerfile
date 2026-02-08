# Aria Travel Guide - Dockerfile with Playwright
# Uses playwright base image for browser automation

FROM mcr.microsoft.com/playwright:v1.48.0-focal

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --only=production

# Install Playwright browsers
RUN npx playwright install chromium

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

# Runtime
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
