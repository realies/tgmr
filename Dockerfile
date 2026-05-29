FROM node:slim AS builder

WORKDIR /app

# node:slim no longer bundles Yarn — install the pinned classic line explicitly.
RUN npm install -g yarn@1.22.22

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

# BUILD_DATE busts the pipx install layer cache — pass a fresh value
# (e.g. `--build-arg BUILD_DATE=$(date -u +%Y-%m-%d)`) per rebuild so daily
# CI builds always pull the latest gallery-dl / yt-dlp without manual pin bumps.
ARG BUILD_DATE=unset

# Install yt-dlp, gallery-dl, and ffmpeg
RUN echo "Build date: ${BUILD_DATE}" && \
    apt-get update && \
    apt-get install -y python3 python3-full pipx ffmpeg && \
    # Setup pipx for non-root user
    mkdir -p /home/node/.local/bin && \
    chown -R node:node /home/node/.local && \
    # Pin minimum versions known to handle the Apr-2026 Instagram 429 wave
    # (gallery-dl 1.32 added user-cache + user-strategy; yt-dlp 2026.04 has the
    # current Instagram extractor fixes). BUILD_DATE arg above ensures rebuilds
    # actually fetch the latest patch releases instead of reusing this layer.
    su node -c "pipx install 'gallery-dl>=1.32.0'" && \
    su node -c "pipx install 'yt-dlp>=2026.4.4'" && \
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
RUN npm install -g yarn@1.22.22 && yarn install --frozen-lockfile --production

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
