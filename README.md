# Catchment Net

A plugin that automatically pulls your Substack newsletters (from Gmail) and Nostr long form content into markdown notes.

## Features

- 🔄 Automatic syncing of Substack newsletters from Gmail and Nostr longform content
- 📝 Converts HTML newsletters to clean Markdown
- 🏷️ Adds structured frontmatter with metadata
- ⏰ Configurable auto-sync intervals
- 📁 Organizes newsletters in designated folders

## Installation

### Prerequisites

1. **Google Cloud Console Setup**:
   - Create a project in [Google Cloud Console](https://console.cloud.google.com/)
   - Enable the Gmail API
   - Create OAuth 2.0 credentials (Desktop application)
   - Note your Client ID and Client Secret

2. **OAuth Token Generation**:
   - Use the authorization URL in plugin settings
   - Grant necessary permissions
   - Exchange authorization code for access/refresh tokens

### Plugin Installation

#### Method 1: Manual Installation

1. Download the latest release files
2. Create folder: `VaultFolder/.obsidian/plugins/substack-gmail-sync/`
3. Copy `main.js`, `manifest.json`, and `styles.css` to the folder
4. Enable the plugin in Obsidian Settings → Community Plugins

#### Method 2: Development Installation

1. Clone this repository
2. Run `npm install`
3. Run `npm run build`
4. Copy built files to your vault's plugin directory

## Configuration

1. **Gmail API Setup**:
   - Enter your Client ID and Client Secret
   - Add your Access Token and Refresh Token
   
2. **Sync Settings**:
   - Set target folder for newsletters
   - Configure maximum emails per sync
   - Set auto-sync frequency

## Usage

- **Manual Sync**: Click the ribbon icon or use the command palette
- **Auto Sync**: Configure automatic syncing in settings
- **Command**: Use "Sync Substack newsletters from Gmail" command

## Gmail Scopes Required

- `https://www.googleapis.com/auth/gmail.readonly`

## Troubleshooting

### Common Issues

1. **Authentication Errors**:
   - Verify OAuth credentials are correct
   - Check if access token has expired
   - Ensure Gmail API is enabled in Google Cloud Console

2. **No Emails Found**:
   - Check Gmail search query parameters
   - Verify Substack emails exist in your inbox
   - Increase max emails limit in settings

3. **Import Issues**:
   - Check folder permissions
   - Verify folder path exists
   - Look for duplicate filename conflicts

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

If you find this plugin helpful, consider:
- ⭐ Starring the repository
- 🐛 Reporting bugs
- 💡 Suggesting features

<p align="center">
  <a href="https://www.buymeacoffee.com/prolixor" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png"
         alt="Buy Me A Coffee"
         style="height: 60px !important;width: 217px !important;" />
  </a>
</p>
