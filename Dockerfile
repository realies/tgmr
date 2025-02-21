FROM node:slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN yarn build

FROM node:slim AS runner

WORKDIR /app

# Install yt-dlp and ffmpeg
RUN apt-get update && \
    apt-get install -y python3 python3-full pipx ffmpeg && \
    # Setup pipx for non-root user
    mkdir -p /home/node/.local/bin && \
    chown -R node:node /home/node/.local && \
    # Switch to non-root user for pipx install
    su node -c "pipx install yt-dlp" && \
    # Verify installations
    su node -c "/home/node/.local/bin/yt-dlp --version" && \
    ffmpeg -version && \
    # Cleanup
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json /app/yarn.lock ./
RUN yarn install --frozen-lockfile --production

# Setup directories and permissions
RUN mkdir -p /tmp/tgmr && \
    chown -R node:node /app /tmp/tgmr

# Switch to non-root user
USER node

# Add local bin to PATH
ENV PATH="/home/node/.local/bin:${PATH}"

# Verify yt-dlp works as non-root user
RUN yt-dlp --version

CMD ["node", "dist/index.js"]
