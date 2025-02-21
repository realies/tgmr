# TGMR (Telegram Media Reply)

A Telegram bot that automatically downloads and replies with media content when users share links in messages. Built with TypeScript and powered by yt-dlp.

## Features

- Automatically processes media links in messages (supports all platforms that yt-dlp can handle)
- Sends audio-only content as voice messages
- Sends videos with thumbnails and proper aspect ratio
- Works in both private chats and groups
- Includes detailed media information in captions (format, quality, size)
- Efficient temporary file management
- Docker support for easy deployment

## Requirements

- Docker (recommended for deployment)
- Telegram Bot Token (get it from [@BotFather](https://t.me/botfather))

## Quick Start

1. Set your bot token:
   ```bash
   # Edit docker-compose.yml and replace 'your_telegram_bot_token_here' with your token
   ```

2. Start the bot:
   ```bash
   docker compose up -d
   ```

## Configuration

Environment variables in `docker-compose.yml`:

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_TOKEN` | Telegram Bot API token | Required |
| `MAX_FILE_SIZE` | Maximum file size in bytes | 50000000 (50MB) |
| `DOWNLOAD_TIMEOUT` | Download timeout in seconds | 300 |
| `RATE_LIMIT` | Maximum requests per minute | 10 |
| `COOLDOWN` | Cooldown between requests in seconds | 60 |
| `TMP_DIR` | Temporary directory for downloads | /tmp/tgmr |
| `SUPPORTED_DOMAINS` | Comma-separated list of domains | youtube.com,youtu.be,... |

## Usage

1. Add the bot to a group or start a private chat
2. Send a media link
3. The bot will reply with:
   - A voice message for audio-only content
   - A video file for video content
   - Caption including title and technical details

### Commands

- `/start` - Introduction message
- `/help` - Usage instructions

## Development

```bash
yarn install
yarn build
yarn dev
```

### Project Structure

```
tgmr/
├── src/
│   ├── bot/        # Bot initialization and core logic
│   ├── config/     # Configuration management
│   ├── handlers/   # Message and command handlers
│   ├── services/   # Media download and processing
│   ├── types/      # TypeScript type definitions
│   └── utils/      # Helper functions
└── dist/           # Compiled JavaScript
```

## Security

- File size restrictions prevent abuse
- Rate limiting protects against spam
- Temporary files are automatically cleaned up
- Docker container runs as non-root user
- Input validation for all URLs

## License

MIT License
