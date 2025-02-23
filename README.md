# TGMR (Telegram Media Reply)

A Telegram bot that automatically downloads and replies with media content when users share links in messages. Built with TypeScript and powered by yt-dlp and gallery-dl.

## Features

- Automatically processes media links in messages (supports all platforms that yt-dlp and gallery-dl can handle)
- Downloads high-quality images from supported platforms (Instagram, Twitter, etc.)
- Sends audio-only content as voice messages
- Sends videos with thumbnails and proper aspect ratio
- Works in both private chats and groups
- Includes detailed media information in captions (format, quality, size)
- Efficient temporary file management
- Docker support for easy deployment

## Requirements

- Docker (recommended for deployment)
- Telegram Bot Token (get it from [@BotFather](https://t.me/botfather))
- yt-dlp (for video/audio content)
- gallery-dl (for image content)

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
| `COOKIES_FILE` | Default cookies file (fallback) | '' |
| `COOKIES_FILE_*` | Site-specific cookies (e.g., COOKIES_FILE_YOUTUBE) | '' |

### Cookie Configuration

To handle rate limiting and authentication for different platforms, you can configure cookies per site:

1. Create a `cookies` directory in your project:
   ```bash
   mkdir cookies
   ```

2. Add your cookie files for different sites. You can export cookies from your browser using extensions like "Get cookies.txt" or similar:
   ```bash
   cookies/
   ├── youtube.txt     # YouTube cookies
   ├── instagram.txt   # Instagram cookies
   ├── twitter.txt     # Twitter/X cookies
   └── default.txt     # Default fallback cookies
   ```

3. Configure the cookie files in `docker-compose.yml`:
   ```yaml
   environment:
     # Default fallback for all sites
     - COOKIES_FILE=/cookies/default.txt
     # Site-specific cookies
     - COOKIES_FILE_YOUTUBE=/cookies/youtube.txt
     - COOKIES_FILE_INSTAGRAM=/cookies/instagram.txt
     - COOKIES_FILE_TWITTER=/cookies/twitter.txt  # Used for both twitter.com and x.com
   volumes:
     - ./cookies:/cookies  # Yt-dlp updates cookies
   ```

Special cases:
- `COOKIES_FILE_YOUTUBE` works for both youtube.com and youtu.be
- `COOKIES_FILE_TWITTER` works for both twitter.com and x.com
- For other sites, use `COOKIES_FILE_SITENAME` where SITENAME is the domain without the extension
- `COOKIES_FILE` serves as a fallback for sites without specific cookie files

Note: Keep your cookie files secure as they contain sensitive authentication data.

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
