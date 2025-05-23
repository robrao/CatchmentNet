// main.ts
import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, requestUrl } from 'obsidian';

interface SubstackGmailSettings {
	gmailApiKey: string;
	clientId: string;
	clientSecret: string;
	accessToken: string;
	refreshToken: string;
	substackFolder: string;
	maxEmails: number;
	syncFrequency: number; // in minutes
}

const DEFAULT_SETTINGS: SubstackGmailSettings = {
	gmailApiKey: '',
	clientId: '',
	clientSecret: '',
	accessToken: '',
	refreshToken: '',
	substackFolder: 'Substack Newsletters',
	maxEmails: 50,
	syncFrequency: 60
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
}

export default class SubstackGmailPlugin extends Plugin {
	settings: SubstackGmailSettings;
	syncInterval: number | null = null;

	async onload() {
		await this.loadSettings();

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
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
		if (!this.settings.refreshToken || !this.settings.clientId || !this.settings.clientSecret) {
			new Notice('Missing OAuth credentials. Please configure in settings.');
			return false;
		}

		try {
			const response = await requestUrl({
				url: 'https://oauth2.googleapis.com/token',
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: this.settings.refreshToken,
					client_id: this.settings.clientId,
					client_secret: this.settings.clientSecret,
				}).toString(),
			});

			if (response.status === 200) {
				this.settings.accessToken = response.json.access_token;
				await this.saveSettings();
				return true;
			}
		} catch (error) {
			console.error('Failed to refresh access token:', error);
			new Notice('Failed to refresh Gmail access token');
		}
		return false;
	}

	async makeGmailRequest(endpoint: string): Promise<any> {
		if (!this.settings.accessToken) {
			new Notice('No access token available. Please authenticate with Gmail.');
			return null;
		}

		try {
			const response = await requestUrl({
				url: `https://gmail.googleapis.com/gmail/v1/${endpoint}`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json',
				},
			});

			if (response.status === 401) {
				// Token expired, try to refresh
				if (await this.refreshAccessToken()) {
					// Retry with new token
					const retryResponse = await requestUrl({
						url: `https://gmail.googleapis.com/gmail/v1/${endpoint}`,
						method: 'GET',
						headers: {
							'Authorization': `Bearer ${this.settings.accessToken}`,
							'Content-Type': 'application/json',
						},
					});
					return retryResponse.json;
				}
				return null;
			}

			return response.json;
		} catch (error) {
			console.error('Gmail API request failed:', error);
			new Notice('Failed to fetch emails from Gmail');
			return null;
		}
	}

	async syncNewsletters() {
		if (!this.settings.accessToken) {
			new Notice('Please configure Gmail authentication in settings first.');
			return;
		}

		new Notice('Syncing Substack newsletters...');

		try {
			// Search for Substack emails
			const query = 'from:substack.com OR from:*.substack.com';
			const messagesResponse = await this.makeGmailRequest(
				`users/me/messages?q=${encodeURIComponent(query)}&maxResults=${this.settings.maxEmails}`
			);

			if (!messagesResponse || !messagesResponse.messages) {
				new Notice('No Substack newsletters found');
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
					const messageDetails = await this.makeGmailRequest(`users/me/messages/${message.id}`);
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
		const headers = message.payload.headers;
		const subject = headers.find(h => h.name === 'Subject')?.value || 'Untitled';
		const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
		const date = headers.find(h => h.name === 'Date')?.value;

		// Extract publication name from the From header
		const publicationMatch = from.match(/^(.+?)\s*<.*@(.+?)\.substack\.com>/);
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

		// Convert HTML to markdown-friendly text
		if (content.includes('<html>') || content.includes('<div>')) {
			content = this.htmlToMarkdown(content);
		}

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
		containerEl.createEl('p', {
			text: 'To use this plugin, you need to set up Gmail API access. Follow these steps:'
		});

		const instructions = containerEl.createEl('ol');
		instructions.createEl('li', { text: 'Go to the Google Cloud Console' });
		instructions.createEl('li', { text: 'Create a new project or select an existing one' });
		instructions.createEl('li', { text: 'Enable the Gmail API' });
		instructions.createEl('li', { text: 'Create OAuth 2.0 credentials' });
		instructions.createEl('li', { text: 'Use the authorization URL to get access and refresh tokens' });

		// Gmail API Settings
		containerEl.createEl('h3', { text: 'Gmail API Configuration' });

		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('OAuth 2.0 Client ID from Google Cloud Console')
			.addText(text => text
				.setPlaceholder('Enter your Client ID')
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value) => {
					this.plugin.settings.clientId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Client Secret')
			.setDesc('OAuth 2.0 Client Secret from Google Cloud Console')
			.addText(text => text
				.setPlaceholder('Enter your Client Secret')
				.setValue(this.plugin.settings.clientSecret)
				.onChange(async (value) => {
					this.plugin.settings.clientSecret = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Access Token')
			.setDesc('OAuth 2.0 Access Token')
			.addText(text => text
				.setPlaceholder('Enter your Access Token')
				.setValue(this.plugin.settings.accessToken)
				.onChange(async (value) => {
					this.plugin.settings.accessToken = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Refresh Token')
			.setDesc('OAuth 2.0 Refresh Token')
			.addText(text => text
				.setPlaceholder('Enter your Refresh Token')
				.setValue(this.plugin.settings.refreshToken)
				.onChange(async (value) => {
					this.plugin.settings.refreshToken = value;
					await this.plugin.saveSettings();
				}));

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
		containerEl.createEl('h3', { text: 'OAuth Helper' });
		containerEl.createEl('p', {
			text: 'Use this URL for OAuth authorization (replace YOUR_CLIENT_ID):'
		});

		const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=https://www.googleapis.com/auth/gmail.readonly&response_type=code&access_type=offline`;
		
		containerEl.createEl('code', {
			text: authUrl,
			attr: { style: 'word-break: break-all; font-size: 12px;' }
		});
	}
}