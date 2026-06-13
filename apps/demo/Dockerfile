# Stage 1: Build the workspace
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root configs and package definitions for caching
COPY package.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/demo/package.json ./apps/demo/

# Install dependencies for the entire monorepo
RUN npm install

# Copy source code
COPY packages/core ./packages/core
COPY apps/demo ./apps/demo

# Build TypeScript code
RUN npm run build

# Stage 2: Runtime image
FROM node:20-alpine

WORKDIR /app

# Copy built code and dependencies from builder stage
COPY --from=builder /app /app

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# Start the demo app in production mode
CMD ["npm", "start", "-w", "apps/demo"]
