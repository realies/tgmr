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

# Install yt-dlp, gallery-dl, and ffmpeg
RUN apt-get update && \
    apt-get install -y python3 python3-full pipx ffmpeg && \
    # Setup pipx for non-root user
    mkdir -p /home/node/.local/bin && \
    chown -R node:node /home/node/.local && \
    # Switch to non-root user for pipx install
    su node -c "pipx install yt-dlp" && \
    su node -c "pipx install gallery-dl" && \
    # Verify installations
    su node -c "/home/node/.local/bin/yt-dlp --version" && \
    su node -c "/home/node/.local/bin/gallery-dl --version" && \
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

# Verify tools work as non-root user
RUN yt-dlp --version && gallery-dl --version

CMD ["node", "dist/index.js"]
