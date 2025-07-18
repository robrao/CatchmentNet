// main.ts
import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder } from 'obsidian';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { assertPresent } from 'typeHelpers';
import { convertHtmltoMarkdown } from 'markdownHelper';

// import * as open from 'open';
import * as http from 'http';
import * as url from 'url';


let server_ = http.createServer()

interface SubstackGmailSettings {
	client_id: string;
	client_secret: string;
	access_token: string;
	substackFolder: string;
	maxEmails: number;
	syncFrequency: number; // in minutes
	scopes: Array<string>;
	redirect_uris: Array<string>;
	refresh_token: string;
	token_type: string;
	refresh_token_expires_in: number;
	expiry_date: number;
	refresh_token_expiry: number;
}

interface GmailTokens {
	access_token: string;
	refresh_token: string;
	token_type: string;
	refresh_token_expires_in: number;
	expiry_date: number;
}

const DEFAULT_SETTINGS: SubstackGmailSettings = {
	client_id: '',
	client_secret: '',
	access_token: '',
	substackFolder: 'Catchment',
	maxEmails: 50,
	syncFrequency: 60,
	scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
	redirect_uris: [],
	refresh_token: '',
	token_type: '',
	refresh_token_expires_in: 0,
	expiry_date: 0,
	refresh_token_expiry: 0
};

interface GmailMessage {
	id: string;
	threadId: string;
	snippet: string;
	payload: {
		headers: Array<{ name: string; value: string }>;
		body?: { data?: string };
		parts?: Array<{ mimeType: string; body: { data?: string } }>;
	};
	labelIds: Array<string>;
}

export default class SubstackGmailPlugin extends Plugin {
	settings: SubstackGmailSettings;
	syncInterval: number | null = null;
	oAuth2Client: OAuth2Client | null = null;
	gmail: any = null;

	async onload() {
		await this.loadSettings();
		this.initializeGoogleAuth();

		// Add ribbon icon
		this.addRibbonIcon('mail', 'Sync Substack Newsletters', (evt: MouseEvent) => {
			this.syncNewsletters();
		});

		// Add command
		this.addCommand({
			id: 'sync-substack-newsletters',
			name: 'Sync Substack newsletters from Gmail',
			callback: () => {
				this.syncNewsletters();
			}
		});

		// Add settings tab
		this.addSettingTab(new SubstackGmailSettingTab(this.app, this));

		// Start automatic sync if configured
		if (this.settings.syncFrequency > 0) {
			this.startAutoSync();
		}
	}

	onunload() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}
		server_.close()
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initializeGoogleAuth(); // Reinitialize auth when settings change
	}

	async getPortFromURI(uri: string): Promise<number> {
		const match = uri.match(/:([0-9]+)/m) || [];

		return Number(match[1])
	}

	async getNewTokens(): Promise<GmailTokens> {
		const authUrl = this.oAuth2Client.generateAuthUrl({
			access_type: 'offline',
			scope: this.settings.scopes,
			prompt: 'consent'
		})
		const LISTEN_PORT = await this.getPortFromURI(this.settings.redirect_uris[0])

		return new Promise((resolve, reject) => {
			if (server_.listening) {
				console.log("Server is listening on port, destroy before creating new one.")
				server_.close()
			}

			server_ = http.createServer(async (req, res) => {
				try {
					// XXX: testing
					console.log(`HERE IN SERVER NOW...`)
					if (req.url && req.url.indexOf('/oauth2callback') > -1) {
						const qs = new url.URL(req.url, this.settings.redirect_uris[0]).searchParams
						
						// Send HTML with auto-close script
						// XXX: the script does not auto close the window
            			res.writeHead(200, { 'Content-Type': 'text/html' });
            			res.end(`
            			    <html>
            			        <head><title>Authorization Complete</title></head>
            			        <body>
            			            <h2>Authorization succeeded!</h2>
            			            <p>This window will close automatically...</p>
            			            <script>
            			                setTimeout(() => {
            			                    window.close();
            			                }, 2000); // Close after 2 seconds
            			            </script>
            			        </body>
            			    </html>
            			`);

						// res.end("Authorization succeeded. You can close this window.")
						// XXX: testing
						console.log(`Closing Server...`)
						server_.close()
						
						const code = qs.get("code")
						assertPresent(code, "Could not get token code.")
						const { tokens } = await this.oAuth2Client.getToken(code)
						this.oAuth2Client.setCredentials(tokens)
						
						resolve(tokens as any)
					} 
				} catch (err) {
					// XXX: testing
					console.log(`Error parsing auth token data: ${JSON.stringify(err)}`)
					reject(err)
				}
			})

			server_.listen(LISTEN_PORT, () => {
				window.open(authUrl)
			})
		})
	}

	async initializeGoogleAuth() {
		const currentDate = Date.now()
		const expiryDate = this.settings.refresh_token_expiry
		const notExpired = expiryDate > currentDate
		const isInitialized = this.oAuth2Client?.credentials?.refresh_token
		// XXX: testing
		console.log(`Initialize Auth...${isInitialized} && ${notExpired}`)
		if (isInitialized && notExpired) {
			// XXX: testing
			console.log(`oAuth2Client already initialized...${JSON.stringify(this.oAuth2Client)}`)
			console.log(`Expired: ${notExpired}`)
			console.log(`Expiry date: ${this.oAuth2Client?.credentials.expiry_date}`)
			console.log(`Current Date: ${currentDate}`)
			console.log(`Refresh Expires: ${this.settings.refresh_token_expires_in}`)
			return
		}

		// XXX: testing
		if (!notExpired) {
			console.log(`Token is expired: ${expiryDate} < ${currentDate}`)
		}

		if (!this.settings.access_token) {
			// XXX: testing
			console.log(`Loading Data...`)
			try {
				const credentials = await this.loadData()
				const { client_secret, client_id, redirect_uris, access_token } = credentials.installed
				this.settings.client_id = client_id
				this.settings.client_secret = client_secret
				this.settings.redirect_uris = redirect_uris
				this.settings.access_token = access_token
			} catch (error) {
				console.error('Failed to retreive credentials:', error);
				new Notice('Failed to retreieve credentials');
			}
		}

		if (this.settings.client_id && this.settings.client_secret) {
			// XXX: testing
			console.log(`Add ID and Secret and URIs to oAuth`)
			try {
				this.oAuth2Client = new google.auth.OAuth2(
					this.settings.client_id,
					this.settings.client_secret,
					this.settings.redirect_uris[0]
				)
			} catch (error) {
				console.error('Failed to initialize Google Authorization:', error);
				new Notice('Failed to intialize Google Authorization');
			}

			if (this.settings.access_token && this.settings.refresh_token && notExpired) {
				this.oAuth2Client.setCredentials({
					access_token: this.settings.access_token,
					refresh_token: this.settings.refresh_token,
					expiry_date: this.settings.expiry_date,
				});

				this.gmail = google.gmail({ version: 'v1', auth: this.oAuth2Client });
				// XXX: testing
				console.log(`Gmail Client Intialized...`)
			} else {
				// XXX: testing
				console.log('Getting new token for initiGoogleAuth...')
				const tokens = await this.getNewTokens()
				// XXX: testing
				console.log(`Got token: ${JSON.stringify(tokens)}`)
				this.settings.access_token = tokens.access_token
				this.settings.refresh_token = tokens.refresh_token
				this.settings.expiry_date = tokens.expiry_date
				this.settings.refresh_token_expires_in = tokens.refresh_token_expires_in
				this.settings.refresh_token_expiry = Date.now() + tokens.refresh_token_expires_in
				await this.saveSettings()
			}

		}
	}

	startAutoSync() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}
		
		if (this.settings.syncFrequency > 0) {
			this.syncInterval = window.setInterval(() => {
				this.syncNewsletters();
			}, this.settings.syncFrequency * 60 * 1000);
		}
	}

	async refreshAccessToken(): Promise<boolean> {
		if (!this.oAuth2Client) {
			new Notice('OAuth client not initialized. Please configure credentials.');
			return false;
		}

		try {
			const { credentials } = await this.oAuth2Client.refreshAccessToken();
			if (credentials.access_token) {
				this.settings.access_token = credentials.access_token;
				await this.saveSettings();
				return true;
			}
		} catch (error) {
			console.error('Failed to refresh access token:', error);
			try {
				// XXX: testing
				console.log(`Reinitizaling...`)
				this.initializeGoogleAuth()
				return true;
			} catch {
				console.error(`Failed to re-Initialize Google Auth`)

				new Notice('Unable to authenticate access with Gmail.')
			}
		}
		return false;
	}

	async listGmailMessages(params: any = {}): Promise<any> {
		if (!this.gmail) {
			new Notice('Gmail client not initialized. Please configure authentication.');
			return null;
		}

		try {
			const response = await this.gmail.users.messages.list({
				userId: 'me',
				...params
			});
			return response.data;
		} catch (error: any) {
			const resp_err = error.response.data.error
			if (resp_err === 'invalid_grant') {
				// Token expired, try to refresh
				if (await this.refreshAccessToken()) {
					// XXX: testing
					console.log(`Refreshing list success...`)
					// Retry with new token
					try {
						const retryResponse = await this.gmail.users.messages.list({
							userId: 'me',
							...params
						});
						return retryResponse.data;
					} catch (retryError) {
						console.error('Retry failed:', retryError);
						return null;
					}
				}
				return null;
			}
			console.error('Gmail API request failed:', error);
			new Notice('Failed to fetch emails from Gmail');
			return null;
		}
	}

	async getGmailMessage(messageId: string): Promise<any> {
		if (!this.gmail) {
			return null;
		}

		try {
			const response = await this.gmail.users.messages.get({
				userId: 'me',
				id: messageId,
				format: 'full'
			});
			return response.data;
		} catch (error: any) {
			if (error.code === 401 && await this.refreshAccessToken()) {
				try {
					const retryResponse = await this.gmail.users.messages.get({
						userId: 'me',
						id: messageId,
						format: 'full'
					});
					return retryResponse.data;
				} catch (retryError) {
					console.error('Retry failed:', retryError);
					return null;
				}
			}
			console.error('Failed to get Gmail message:', error);
			return null;
		}
	}

	async syncNewsletters() {
		if (!this.settings.access_token) {
			new Notice('Please configure Gmail authentication in settings first.');
			return;
		}

		new Notice('Syncing Substack newsletters...');

		try {
			// Search for Substack emails
			const query = 'from:substack.com AND -from:no-reply@substack.com AND -label:CATEGORY_PROMOTION AND -replyto:no-reply@substack.com';
			const messagesResponse = await this.listGmailMessages({
					q: query,
					maxResults: this.settings.maxEmails
				});

			if (!messagesResponse || !messagesResponse.messages) {
				new Notice('No Substack newsletters found');
				// XXX: testing
				console.log(`Message Respone from Gmail: ${JSON.stringify(messagesResponse)}`)
				return;
			}

			let processedCount = 0;
			const existingFiles = new Set<string>();

			// Get existing files in the Substack folder
			const folder = this.app.vault.getAbstractFileByPath(this.settings.substackFolder);
			if (folder && folder instanceof TFolder) {
				folder.children.forEach((file) => {
					if (file instanceof TFile) {
						existingFiles.add(file.basename);
					}
				});
			}

			for (const message of messagesResponse.messages) {
				try {
					const messageDetails = await this.getGmailMessage(message.id);
					if (messageDetails) {
						const processed = await this.processMessage(messageDetails, existingFiles);
						if (processed) processedCount++;
					}
				} catch (error) {
					console.error(`Failed to process message ${message.id}:`, error);
				}
			}

			new Notice(`Synced ${processedCount} new Substack newsletters`);
		} catch (error) {
			console.error('Sync failed:', error);
			new Notice('Failed to sync newsletters');
		}
	}

	async processMessage(message: GmailMessage, existingFiles: Set<string>): Promise<boolean> {
		// XXX: testing
		// console.log(`message structure: ${JSON.stringify(message.payload.headers)}`)
		const headers = message.payload.headers;
		const subject = headers.find(h => h.name === 'Subject')?.value || 'Untitled';
		const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
		const date = headers.find(h => h.name === 'Date')?.value;
		const replyto = headers.find(h => h.name == 'Reply-To')?.value;

		if (!replyto) {
			return false
		}

		// Extract publication name from the From header
		// XXX: currently doesn't work
		const publicationMatch = from.match(/^(.+?)\s*<.*@substack\.com>/);
		const publication = publicationMatch ? publicationMatch[1].trim() : 'Unknown Publication';

		// Create a safe filename
		const sanitizedSubject = subject.replace(/[<>:"/\\|?*]/g, '-').trim();
		const filename = `${sanitizedSubject}`;


		// Check if file already exists
		if (existingFiles.has(filename)) {
			return false;
		}

		// Extract email content
		let content = this.extractEmailContent(message);
		if (!content) {
			content = message.snippet || 'No content available';
		}

		// Create markdown content
		const markdownContent = this.createMarkdownContent(subject, publication, from, date, content);

		// Ensure folder exists
		await this.ensureFolderExists(this.settings.substackFolder);

		// Create the file
		const filePath = `${this.settings.substackFolder}/${filename}.md`;
		await this.app.vault.create(filePath, markdownContent);

		return true;
	}

	extractEmailContent(message: GmailMessage): string {
		// Try to get HTML content first, then plain text
		let content = '';

		if (message.payload.parts) {
			for (const part of message.payload.parts) {
				if (part.mimeType === 'text/html' && part.body?.data) {
					content = this.decodeBase64(part.body.data);
					break;
				} else if (part.mimeType === 'text/plain' && part.body?.data) {
					content = this.decodeBase64(part.body.data);
				}
			}
		} else if (message.payload.body?.data) {
			content = this.decodeBase64(message.payload.body.data);
		}

		// XXX: testing
		// Convert HTML to markdown-friendly text
		// if (content.includes('<html>') || content.includes('<div>')) {
		content = convertHtmltoMarkdown(content);
		// }

		return content;
	}

	decodeBase64(data: string): string {
		try {
			// Gmail uses URL-safe base64
			const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
			return atob(base64);
		} catch (error) {
			console.error('Failed to decode base64:', error);
			return '';
		}
	}

	htmlToMarkdown(html: string): string {
		// Basic HTML to Markdown conversion
		return html
			.replace(/<h([1-6])>/gi, (match, level) => '#'.repeat(parseInt(level)) + ' ')
			.replace(/<\/h[1-6]>/gi, '\n\n')
			.replace(/<p>/gi, '')
			.replace(/<\/p>/gi, '\n\n')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<strong>|<b>/gi, '**')
			.replace(/<\/strong>|<\/b>/gi, '**')
			.replace(/<em>|<i>/gi, '*')
			.replace(/<\/em>|<\/i>/gi, '*')
			.replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)')
			.replace(/<[^>]*>/g, '') // Remove remaining HTML tags
			.replace(/\n\s*\n\s*\n/g, '\n\n') // Clean up multiple newlines
			.trim();
	}

	createMarkdownContent(subject: string, publication: string, from: string, date: string, content: string): string {
		const frontmatter = `---
title: "${subject}"
publication: "${publication}"
author: "${from}"
date: "${date}"
type: substack-newsletter
tags: [newsletter, substack]
---

`;

		return frontmatter + content;
	}

	async ensureFolderExists(folderPath: string) {
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await this.app.vault.createFolder(folderPath);
		}
	}
}

class SubstackGmailSettingTab extends PluginSettingTab {
	plugin: SubstackGmailPlugin;

	constructor(app: App, plugin: SubstackGmailPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Substack Gmail Sync Settings' });

		// Instructions
		// containerEl.createEl('p', {
		// 	text: 'To use this plugin, you need to set up Gmail API access. Follow these steps:'
		// });

		// // XXX: might not need this since data all in credentials.json?
		// const instructions = containerEl.createEl('ol');
		// instructions.createEl('li', { text: 'Go to the Google Cloud Console' });
		// instructions.createEl('li', { text: 'Create a new project or select an existing one' });
		// instructions.createEl('li', { text: 'Enable the Gmail API' });
		// instructions.createEl('li', { text: 'Create OAuth 2.0 credentials' });
		// instructions.createEl('li', { text: 'Use the authorization URL to get access and refresh tokens' });

		// // Gmail API Settings
		// containerEl.createEl('h3', { text: 'Gmail API Configuration' });

		// new Setting(containerEl)
		// 	.setName('Client ID')
		// 	.setDesc('OAuth 2.0 Client ID from Google Cloud Console')
		// 	.addText(text => text
		// 		.setPlaceholder('Enter your Client ID')
		// 		.setValue(this.plugin.settings.client_id)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.client_id = value;
		// 			await this.plugin.saveSettings();
		// 		}));

		// new Setting(containerEl)
		// 	.setName('Client Secret')
		// 	.setDesc('OAuth 2.0 Client Secret from Google Cloud Console')
		// 	.addText(text => text
		// 		.setPlaceholder('Enter your Client Secret')
		// 		.setValue(this.plugin.settings.client_secret)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.client_secret = value;
		// 			await this.plugin.saveSettings();
		// 		}));

		// new Setting(containerEl)
		// 	.setName('Access Token')
		// 	.setDesc('OAuth 2.0 Access Token')
		// 	.addText(text => text
		// 		.setPlaceholder('Enter your Access Token')
		// 		.setValue(this.plugin.settings.access_token)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.access_token = value;
		// 			await this.plugin.saveSettings();
		// 		}));

		// new Setting(containerEl)
		// 	.setName('Refresh Token')
		// 	.setDesc('OAuth 2.0 Refresh Token')
		// 	.addText(text => text
		// 		.setPlaceholder('Enter your Refresh Token')
		// 		.setValue(this.plugin.settings.refreshToken)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.refreshToken = value;
		// 			await this.plugin.saveSettings();
		// 		}));

		// Sync Settings
		containerEl.createEl('h3', { text: 'Sync Configuration' });

		new Setting(containerEl)
			.setName('Substack Folder')
			.setDesc('Folder where newsletters will be saved')
			.addText(text => text
				.setPlaceholder('Substack Newsletters')
				.setValue(this.plugin.settings.substackFolder)
				.onChange(async (value) => {
					this.plugin.settings.substackFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max Emails')
			.setDesc('Maximum number of emails to fetch per sync')
			.addSlider(slider => slider
				.setLimits(10, 200, 10)
				.setValue(this.plugin.settings.maxEmails)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxEmails = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-sync Frequency')
			.setDesc('How often to automatically sync (in minutes, 0 to disable)')
			.addSlider(slider => slider
				.setLimits(0, 1440, 30)
				.setValue(this.plugin.settings.syncFrequency)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.syncFrequency = value;
					await this.plugin.saveSettings();
					this.plugin.startAutoSync();
				}));

		// Manual sync button
		new Setting(containerEl)
			.setName('Manual Sync')
			.setDesc('Manually sync newsletters now')
			.addButton(button => button
				.setButtonText('Sync Now')
				.setCta()
				.onClick(() => {
					this.plugin.syncNewsletters();
				}));

		// OAuth Helper
		// containerEl.createEl('h3', { text: 'OAuth Helper' });
		// containerEl.createEl('p', {
		// 	text: 'Use this URL for OAuth authorization (replace YOUR_CLIENT_ID):'
		// });

		// const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=https://www.googleapis.com/auth/gmail.readonly&response_type=code&access_type=offline`;
		
		// containerEl.createEl('code', {
		// 	text: authUrl,
		// 	attr: { style: 'word-break: break-all; font-size: 12px;' }
		// });
	}
}