// main.ts
import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, Modal, Platform } from 'obsidian';
import { convertHtmltoMarkdown } from 'markdownHelper';
import { NoteModal } from 'noteModal';
import { NostrNIP23Client } from './nostr';

// Conditional imports for desktop-only modules
let http: typeof import('http') | null = null;
let url: typeof import('url') | null = null;
let destroyer: ((server: any) => void) | null = null;
let server_: any = null;

// Only load Node.js modules on desktop
if (!Platform.isMobile) {
	try {
		http = require('http');
		url = require('url');
		destroyer = require('server-destroy');
		server_ = http.createServer();
	} catch (e) {
		console.log('Node.js modules not available, running in mobile mode');
	}
}

export interface NostrAuthor {
	pubkey?: string;
	npub: string;
	created_at?: string;
	name?: string;
	display_name?: string;
	username?: string;
	lastUpdated?: number;
}

interface CatchementSettings {
	client_id: string;
	access_token: string;
	catchementFolder: string;
	maxEmails: number;
	syncFrequency: number; // in minutes
	scopes: Array<string>;
	redirect_uris: Array<string>;
	redirect_uri_mobile: string; // For mobile OAuth via Obsidian URI scheme
	refresh_token: string;
	token_type: string;
	refresh_token_expires_in: number;
	expiry_date: number;
	refresh_token_expiry: number;
	last_refreshed_date: number;
	// PKCE fields
	pkce_verifier?: string;
	pkce_state?: string;
	// Nostr settings
	nostrEnabled: boolean;
	nostrRelays: Array<string>;
	nostrFollowedAuthors: Array<NostrAuthor>;
	nostrSyncFrequency: number; // in minutes
	nostrLastSyncTime?: number; // Unix timestamp in seconds
	maxNostrQuery: number;
	substackIcon: string;
	nostrIcon: string;
	filenameLength: number;
	auth_uri: string;
	token_uri: string;
	auth_provider_x509_cert_url: string;
}

interface GmailTokens {
	access_token: string;
	refresh_token: string;
	token_type: string;
	refresh_token_expires_in: number;
	expiry_date: number;
}

const DEFAULT_SETTINGS: CatchementSettings = {
	// client_id: "116037380548-ac8rt3r3nb78ehqfj11gkn9i11jiu3eq.apps.googleusercontent.com", // UWP
	client_id: "116037380548-t8au61erg75pc4n1e9h2jrmoo4h5lk0s.apps.googleusercontent.com", // Web
	access_token: null,
	catchementFolder: 'Catchment',
	maxEmails: 50,
	syncFrequency: 120, // NOTE: default to two hours
	scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
	redirect_uris: [
		"http://localhost:9999/oauth2callback"
	],
	// Mobile uses a hosted redirect page that forwards to obsidian:// URI
	// Host oauth-redirect.html on GitHub Pages and update this URL
	// Then register this URL in Google Cloud Console as an authorized redirect URI
	redirect_uri_mobile: "https://robrao.github.io/CatchmentNet/oauth-redirect.html",
	refresh_token: '',
	token_type: '',
	refresh_token_expires_in: 0,
	expiry_date: 0,
	refresh_token_expiry: 0,
	last_refreshed_date: 0,
	// Nostr defaults
	nostrEnabled: false,
	nostrRelays: [
		'wss://relay.damus.io',
		'wss://nos.lol',
		'wss://relay.snort.social',
		'wss://relay.nostr.band'
	],
	nostrFollowedAuthors: [],
	nostrSyncFrequency: 120, // NOTE: default to two hours
	maxNostrQuery: 100,
	substackIcon: '',
	nostrIcon: '',
	filenameLength: 59,
	auth_uri: "https://accounts.google.com/o/oauth2/auth",
	token_uri: "https://oauth2.googleapis.com/token",
	auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
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

// Modal shown while waiting for OAuth callback on mobile (with manual fallback)
class MobileOAuthWaitingModal extends Modal {
	private onCancel: () => void;
	private onManualCode: (code: string) => void;
	private showManualEntry: boolean = false;

	constructor(app: App, onCancel: () => void, onManualCode: (code: string) => void) {
		super(app);
		this.onCancel = onCancel;
		this.onManualCode = onManualCode;
	}

	onOpen() {
		const { contentEl } = this;
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();

		if (!this.showManualEntry) {
			// Waiting state
			contentEl.createEl('h2', { text: 'Authenticating with Google...' });

			contentEl.createEl('p', {
				text: 'A browser window should have opened for Google sign-in.'
			});

			contentEl.createEl('p', {
				text: 'After you grant permission, you should be automatically redirected back to Obsidian.',
				attr: { style: 'color: var(--text-muted);' }
			});

			// Spinner/loading indicator
			const loadingContainer = contentEl.createDiv({
				attr: { style: 'text-align: center; margin: 20px 0;' }
			});
			loadingContainer.createEl('div', {
				text: '⏳ Waiting for authentication...',
				attr: { style: 'font-size: 1.2em;' }
			});

			// Manual entry link
			const manualLink = contentEl.createEl('p', {
				attr: { style: 'margin-top: 20px; text-align: center;' }
			});
			const link = manualLink.createEl('a', {
				text: "Redirect didn't work? Enter code manually",
				attr: { href: '#', style: 'color: var(--text-accent);' }
			});
			link.onclick = (e) => {
				e.preventDefault();
				this.showManualEntry = true;
				this.render();
			};

			// Cancel button
			const cancelButton = contentEl.createEl('button', { 
				text: 'Cancel',
				attr: { style: 'width: 100%; margin-top: 20px;' }
			});
			cancelButton.onclick = () => {
				this.onCancel();
				this.close();
			};
		} else {
			// Manual code entry state
			contentEl.createEl('h2', { text: 'Enter Authorization Code' });

			contentEl.createEl('p', {
				text: 'If the automatic redirect didn\'t work, you can enter the code manually:'
			});

			const steps = contentEl.createEl('ol', {
				attr: { style: 'margin: 16px 0; padding-left: 20px;' }
			});
			steps.createEl('li', { text: 'Complete the Google sign-in in your browser' });
			steps.createEl('li', { text: 'After granting permission, you\'ll see a page with your code' });
			steps.createEl('li', { text: 'Copy the code and paste it below' });

			// Code input
			const inputContainer = contentEl.createDiv({
				attr: { style: 'margin: 16px 0;' }
			});
			const codeInput = inputContainer.createEl('input', {
				type: 'text',
				placeholder: 'Paste authorization code here...',
				attr: { style: 'width: 100%; padding: 12px; font-size: 14px; border-radius: 4px; border: 1px solid var(--background-modifier-border);' }
			});

			// Help text
			contentEl.createEl('p', {
				text: 'The code looks like: 4/0AQSTgQ...',
				attr: { style: 'font-size: 12px; color: var(--text-muted); margin-bottom: 16px;' }
			});

			// Submit button
			const submitButton = contentEl.createEl('button', {
				text: 'Submit Code',
				cls: 'mod-cta',
				attr: { style: 'width: 100%;' }
			});
			submitButton.onclick = () => {
				let code = codeInput.value.trim();
				
				// Try to extract code if user pasted the full URL
				if (code.includes('code=')) {
					const match = code.match(/code=([^&]+)/);
					if (match) {
						code = decodeURIComponent(match[1]);
					}
				}
				
				if (code) {
					this.onManualCode(code);
					this.close();
				} else {
					new Notice('Please enter the authorization code');
				}
			};

			// Back button
			const backButton = contentEl.createEl('button', { 
				text: '← Back to waiting',
				attr: { style: 'width: 100%; margin-top: 8px;' }
			});
			backButton.onclick = () => {
				this.showManualEntry = false;
				this.render();
			};

			// Cancel button
			const cancelButton = contentEl.createEl('button', { 
				text: 'Cancel',
				attr: { style: 'width: 100%; margin-top: 8px;' }
			});
			cancelButton.onclick = () => {
				this.onCancel();
				this.close();
			};
		}
	}

	// Method to switch to manual entry from outside
	showManualEntryView() {
		this.showManualEntry = true;
		this.render();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export default class CatchementPlugin extends Plugin {
	settings: CatchementSettings;
	syncInterval: number | null = null;
	nostrSyncInterval: number | null = null;
	nostrClient: NostrNIP23Client | null = null;
	// Track ongoing authorization
	authorizationInProgress: boolean = false;
	authorizationPromise: Promise<GmailTokens> | null = null;
	// Mobile OAuth promise resolver - called by the protocol handler
	private mobileAuthResolver: ((tokens: GmailTokens) => void) | null = null;
	private mobileAuthRejecter: ((error: Error) => void) | null = null;
	private mobileAuthModal: MobileOAuthWaitingModal | null = null;

	async onload() {
		await this.loadSettings();

		// Register Obsidian protocol handler for OAuth callback (works on mobile)
		this.registerObsidianProtocolHandler('catchment-oauth-callback', async (params) => {
			console.log('OAuth callback received:', params);
			await this.handleOAuthCallback(params);
		});

		if (this.settings.nostrEnabled) {
			this.initializeNostr();
		}

		// Add ribbon icon for Nostr sync
		this.addRibbonIcon('globe', 'Sync Articles', (evt: MouseEvent) => {
			this.syncAllContent()
		});

		// Add commands
		this.addCommand({
			id: 'sync-substack-newsletters',
			name: 'Sync Substack newsletters from Gmail',
			callback: () => {
				this.syncNewsletters();
			}
		});

		this.addCommand({
			id: 'sync-nostr-articles',
			name: 'Sync Nostr long-form articles',
			callback: () => {
				this.syncNostrArticles();
			}
		});

		this.addCommand({
			id: 'sync-all-content',
			name: 'Sync both Gmail and Nostr content',
			callback: () => {
				this.syncAllContent();
			}
		});

		//XXX: Development/Testing command - remove in production
		this.addCommand({
			id: 'testreauth',
			name: 'TestReauth',
			callback: async () => {
				// Force token expiration
				this.settings.expiry_date = Date.now() - 1000;
				this.settings.refresh_token_expiry = Date.now() - 1000;
				await this.saveSettings();

				new Notice('Tokens expired, triggering reauthorization...');

				// Trigger sync which will cause reauth
				setTimeout(() => {
					this.syncNewsletters();
				}, 500);
			}
		});

		// Add settings tab
		this.addSettingTab(new CatchmentSettingTab(this.app, this));

		// Start automatic sync if configured
		if (this.settings.syncFrequency > 0) {
			this.startGmailAutoSync();
		}

		if (this.settings.nostrEnabled && this.settings.nostrSyncFrequency > 0) {
			this.startNostrAutoSync();
		}

		// Add context menu item for note extraction
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				const selection = editor.getSelection();
				if (selection && selection.trim().length > 0) {
					menu.addItem((item) => {
						item
							.setTitle('Take Note')
							.setIcon('quote-glyph')
							.onClick(() => {
								this.createNote(editor, view)
							});
					});
				}
			})
		);
	}

	/**
	 * Handle OAuth callback from Obsidian protocol handler
	 * This is called when Google redirects back to obsidian://catchment-oauth-callback
	 */
	private async handleOAuthCallback(params: any) {
		console.log('Processing OAuth callback...');

		// Close the waiting modal if it's open
		if (this.mobileAuthModal) {
			this.mobileAuthModal.close();
			this.mobileAuthModal = null;
		}

		// Check for errors from Google
		if (params.error) {
			const errorMsg = params.error_description || params.error;
			console.error('OAuth error:', errorMsg);
			new Notice(`Authentication failed: ${errorMsg}`);
			
			if (this.mobileAuthRejecter) {
				this.mobileAuthRejecter(new Error(errorMsg));
				this.mobileAuthRejecter = null;
				this.mobileAuthResolver = null;
			}
			return;
		}

		// Validate state to prevent CSRF
		if (params.state !== this.settings.pkce_state) {
			console.error('State mismatch - possible CSRF attack');
			new Notice('Authentication failed: Security validation failed');
			
			if (this.mobileAuthRejecter) {
				this.mobileAuthRejecter(new Error('State mismatch'));
				this.mobileAuthRejecter = null;
				this.mobileAuthResolver = null;
			}
			return;
		}

		// Check for authorization code
		if (!params.code) {
			console.error('No authorization code received');
			new Notice('Authentication failed: No authorization code received');
			
			if (this.mobileAuthRejecter) {
				this.mobileAuthRejecter(new Error('No authorization code'));
				this.mobileAuthRejecter = null;
				this.mobileAuthResolver = null;
			}
			return;
		}

		try {
			// Exchange code for tokens
			const tokens = await this.exchangeCodeForTokens(params.code, this.settings.pkce_verifier);

			// Clean up PKCE values
			delete this.settings.pkce_verifier;
			delete this.settings.pkce_state;
			await this.saveSettings();

			new Notice('Successfully authenticated with Gmail!');

			// Resolve the pending promise
			if (this.mobileAuthResolver) {
				this.mobileAuthResolver(tokens);
				this.mobileAuthResolver = null;
				this.mobileAuthRejecter = null;
			}
		} catch (error) {
			console.error('Token exchange failed:', error);
			new Notice(`Authentication failed: ${error.message}`);
			
			if (this.mobileAuthRejecter) {
				this.mobileAuthRejecter(error);
				this.mobileAuthRejecter = null;
				this.mobileAuthResolver = null;
			}
		}
	}

	createNote(editor: any, view: any) {
		const selectedText = editor.getSelection();

		if (!selectedText || selectedText.trim().length === 0) {
			new Notice('Please select some text to extract');
			return;
		}

		if (!view.file) {
			new Notice('No active file found');
			return;
		}

		// Open the extraction modal
		const modal = new NoteModal(this.app, this, selectedText.trim(), view.file, this.settings.catchementFolder);
		modal.open();
	}

	onunload() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}
		if (this.nostrSyncInterval) {
			window.clearInterval(this.nostrSyncInterval);
		}
		if (this.nostrClient) {
			this.nostrClient.disconnect();
		}
		// Reset authorization state
		this.authorizationInProgress = false;
		this.authorizationPromise = null;
		this.mobileAuthResolver = null;
		this.mobileAuthRejecter = null;
		if (this.mobileAuthModal) {
			this.mobileAuthModal.close();
			this.mobileAuthModal = null;
		}
		if (server_ && !Platform.isMobile) {
			server_.close();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		console.log(`Save Settings...`)
		await this.saveData(this.settings);

		// Reinitialize Nostr if settings changed
		if (this.settings.nostrEnabled) {
			this.initializeNostr();
		} else if (this.nostrClient) {
			this.nostrClient.disconnect();
			this.nostrClient = null;
		}
	}

	// Nostr initialization and methods
	async initializeNostr() {
		if (this.nostrClient) {
			this.nostrClient.disconnect();
		}

		try {
			this.nostrClient = new NostrNIP23Client(this.settings.nostrRelays);
			console.log('Nostr client initialized successfully');
		} catch (error) {
			console.error('Failed to initialize Nostr client:', error);
			new Notice('Failed to connect to Nostr relays');
		}
	}

	startNostrAutoSync() {
		if (this.nostrSyncInterval) {
			window.clearInterval(this.nostrSyncInterval);
		}

		if (this.settings.nostrSyncFrequency > 0 && this.settings.nostrEnabled) {
			this.nostrSyncInterval = window.setInterval(() => {
				this.syncNostrArticles();
			}, this.settings.nostrSyncFrequency * 60 * 1000);
		}
	}

	async formatFilename(name: string) {
		let sanitizedTitle = name.replace(/[<>:"/\\|?*]/g, '-').trim();

		// NOTE: assuming obsidian filename allows 62 characters
		if (sanitizedTitle.length > this.settings.filenameLength + 3) {
			sanitizedTitle = sanitizedTitle.slice(0, this.settings.filenameLength) + '...';
		}

		return sanitizedTitle
	}

	// PKCE helper methods using Web Crypto API (works on both desktop and mobile)
	// Explicitly use globalThis.crypto to avoid Node.js crypto module being bundled
	private getWebCrypto(): Crypto {
		// Use globalThis.crypto which works in both browser and modern Node.js
		// This avoids any import of the Node.js 'crypto' module
		if (typeof globalThis !== 'undefined' && globalThis.crypto) {
			console.log(`Using globalThis for crypto package`)
			return globalThis.crypto;
		}
		if (typeof window !== 'undefined' && window.crypto) {
			console.log(`Using window.crypto for crypto package`)
			return window.crypto;
		}
		if (typeof self !== 'undefined' && self.crypto) {
			console.log(`Using self.crypto for crypto package`)
			return self.crypto;
		}
		throw new Error('Web Crypto API not available');
	}

	private generateRandomBytes(length: number): Uint8Array {
		const array = new Uint8Array(length);
		this.getWebCrypto().getRandomValues(array);
		return array;
	}

	private base64URLEncode(buffer: ArrayBuffer | Uint8Array): string {
		const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
		let binary = '';
		bytes.forEach(byte => binary += String.fromCharCode(byte));

		return btoa(binary)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=/g, '');
	}

	private generatePKCEVerifier(): string {
		const randomBytes = this.generateRandomBytes(64);
		return this.base64URLEncode(randomBytes);
	}

	private async generatePKCEChallenge(verifier: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const webCrypto = this.getWebCrypto();
		const hash = await webCrypto.subtle.digest('SHA-256', data);
		return this.base64URLEncode(hash);
	}

	private generateState(): string {
		const randomBytes = this.generateRandomBytes(32);
		return this.base64URLEncode(randomBytes);
	}

	async syncNostrArticles() {
		if (!this.settings.nostrEnabled) {
			new Notice('Nostr sync is disabled in settings');
			return;
		}

		if (!this.nostrClient) {
			await this.initializeNostr();
		}

		if (!this.nostrClient) {
			new Notice('Failed to initialize Nostr client');
			return;
		}

		if (this.settings.nostrFollowedAuthors.length === 0) {
			new Notice('No Nostr authors configured. Please add pubkeys in settings.');
			return;
		}

		new Notice('Syncing Nostr long-form articles...');

		try {
			// Ensure folder exists
			await this.ensureFolderExists(this.settings.catchementFolder);

			// Get existing files to avoid duplicates
			const existingFiles = new Set<string>();
			const folder = this.app.vault.getAbstractFileByPath(this.settings.catchementFolder);
			if (folder && folder instanceof TFolder) {
				folder.children.forEach((file) => {
					if (file instanceof TFile) {
						existingFiles.add(file.basename);
					}
				});
			}

			let processedCount = 0;

			const sinceDate = this.settings.nostrLastSyncTime
				? new Date(this.settings.nostrLastSyncTime * 1000)
				: undefined

			const queryLimit = this.settings.maxNostrQuery

			this.nostrClient.getNostrData(30023, this.settings.nostrFollowedAuthors, queryLimit, (article) => {
				this.processNostrArticle(article, existingFiles)
					.then((processed) => {
						if (processed) {
							processedCount++
						}
					})
					.catch((error) => {
						console.error('Failed to process Nostr article:', error)
					})
			}, sinceDate)

			this.settings.nostrLastSyncTime = Math.floor(Date.now() / 1000);
			await this.saveSettings();

			setTimeout(() => {
				new Notice(`Processed ${processedCount} new Nostr articles`);
			}, 7000);

		} catch (error) {
			console.error('Nostr sync failed:', error);
			new Notice('Failed to sync Nostr articles');
		}
	}

	async processNostrArticle(article: any, existingFiles: Set<string>): Promise<boolean> {
		try {
			const title = article.parsed.title || 'Untitled Article';

			const sanitizedTitle = await this.formatFilename(title)
			const filename = `${sanitizedTitle}`

			if (existingFiles.has(filename)) {
				return false;
			}

			const markdownContent = this.createNostrMarkdownContent(article);

			const filePath = `${this.settings.catchementFolder}/${filename}.md`;
			await this.app.vault.create(filePath, markdownContent);

			existingFiles.add(filename);

			return true;
		} catch (error) {
			console.error('Error processing Nostr article:', error);
			return false;
		}
	}

	createNostrMarkdownContent(article: any): string {
		const title = article.parsed.title || 'Untitled Article';
		const author = this.settings.nostrFollowedAuthors.find(author => author.pubkey === article.pubkey)
		const publishedDate = article.parsed.published_at
			? new Date(article.parsed.published_at * 1000).toISOString()
			: new Date(article.created_at * 1000).toISOString();
		const summary = article.parsed.summary || '';
		const hashtags = article.parsed.hashtags || [];
		const references = article.parsed.references || [];

		const frontmatter = `---
title: "${title}"
author: "${author.username}"
pubkey: "${article.pubkey}"
published: "${publishedDate}"
summary: "${summary}"
hashtags: [${hashtags.map(tag => `"${tag}"`).join(', ')}]
nostr_id: "${article.id}"
icon: "${this.settings.nostrIcon}"
type: nostr-article
tags: [nostr, article, longform]
---

`;

		let content = frontmatter;

		content += `# ${title}\n\n`;

		content += `**Author:** ${author.username}\n`;
		content += `**Published:** ${publishedDate}\n`;

		if (summary) {
			content += `**Summary:** ${summary}\n`;
		}

		if (hashtags.length > 0) {
			content += `**Tags:** ${hashtags.join(', ')}\n`;
		}

		content += '\n---\n\n';

		content += article.content;

		if (references.length > 0) {
			content += '\n\n## References\n\n';
			references.forEach((ref: string, index: number) => {
				content += `${index + 1}. ${ref}\n`;
			});
		}

		return content;
	}

	async syncAllContent() {
		new Notice('Syncing all content sources...');

		const promises = [];

		// DEBUG
		// if (this.settings.access_token) {
			promises.push(this.syncNewsletters());
		// }

		if (this.settings.nostrEnabled) {
			promises.push(this.syncNostrArticles());
		}

		try {
			await Promise.all(promises);
			new Notice('All content sources synced successfully');
		} catch (error) {
			console.error('Failed to sync all content:', error);
			new Notice('Some content sources failed to sync');
		}
	}

	// ============================================
	// OAUTH AND GMAIL API - CROSS-PLATFORM IMPLEMENTATION
	// ============================================

	private getRedirectUri(): string {
		// On mobile, use Obsidian URI scheme for seamless callback
		if (Platform.isMobile) {
			return this.settings.redirect_uri_mobile;
		}
		return this.settings.redirect_uris[0];
	}

	private buildAuthUrl(verifier: string, state: string): string {
		const params = new URLSearchParams({
			client_id: this.settings.client_id,
			redirect_uri: this.getRedirectUri(),
			response_type: 'code',
			scope: this.settings.scopes.join(' '),
			access_type: 'offline',
			prompt: 'consent',
			state: state,
			code_challenge: '', // Will be set below
			code_challenge_method: 'S256'
		});

		return `${this.settings.auth_uri}?${params.toString()}`;
	}

	async getNewTokens(): Promise<GmailTokens> {
		// DEBUG
		console.log(`GET TOKENS AUTH`)
		if (this.authorizationInProgress && this.authorizationPromise) {
			console.log('Authorization already in progress, waiting for existing flow to complete');
			return this.authorizationPromise;
		}
		// DEBUG
		console.log(`GET TOKENS AUTH 2`)

		this.authorizationInProgress = true;

		try {
			if (Platform.isMobile) {
				this.authorizationPromise = this._performMobileAuthorization();
			} else {
				this.authorizationPromise = this._performDesktopAuthorization();
			}

			const tokens = await this.authorizationPromise;
			return tokens;
		} finally {
			this.authorizationInProgress = false;
			this.authorizationPromise = null;
		}
	}

	// Mobile authorization flow using hosted redirect page + Obsidian URI scheme
	private async _performMobileAuthorization(): Promise<GmailTokens> {
		const verifier = this.generatePKCEVerifier();
		const challenge = await this.generatePKCEChallenge(verifier);
		const state = this.generateState();

		this.settings.pkce_verifier = verifier;
		this.settings.pkce_state = state;
		await this.saveSettings();

		// Build the auth URL with PKCE challenge
		const params = new URLSearchParams({
			client_id: this.settings.client_id,
			redirect_uri: this.getRedirectUri(),
			response_type: 'code',
			scope: this.settings.scopes.join(' '),
			access_type: 'offline',
			prompt: 'consent',
			state: state,
			code_challenge: challenge,
			code_challenge_method: 'S256'
		});

		const authUrl = `${this.settings.auth_uri}?${params.toString()}`;
		console.log(`GOOGLE AUTH URL MOBILE: ${authUrl}`)

		return new Promise((resolve, reject) => {
			// Store the resolver/rejecter so the protocol handler can use them
			this.mobileAuthResolver = resolve;
			this.mobileAuthRejecter = reject;

			// Set up a timeout
			const authTimeout = setTimeout(() => {
				if (this.mobileAuthResolver) {
					new Notice('Authentication timed out. Please try again.');
					this.mobileAuthRejecter(new Error('Authentication timeout'));
					this.mobileAuthResolver = null;
					this.mobileAuthRejecter = null;
					if (this.mobileAuthModal) {
						this.mobileAuthModal.close();
						this.mobileAuthModal = null;
					}
				}
			}, 5 * 60 * 1000); // 5 minute timeout

			// Clean up timeout when resolved/rejected
			const originalResolve = this.mobileAuthResolver;
			const originalReject = this.mobileAuthRejecter;
			
			this.mobileAuthResolver = (tokens) => {
				clearTimeout(authTimeout);
				originalResolve(tokens);
			};
			
			this.mobileAuthRejecter = (error) => {
				clearTimeout(authTimeout);
				originalReject(error);
			};

			// Handler for manual code entry
			const handleManualCode = async (code: string) => {
				try {
					const tokens = await this.exchangeCodeForTokens(code, verifier);
					
					// Clean up PKCE values
					delete this.settings.pkce_verifier;
					delete this.settings.pkce_state;
					await this.saveSettings();

					new Notice('Successfully authenticated with Gmail!');
					
					if (this.mobileAuthResolver) {
						this.mobileAuthResolver(tokens);
						this.mobileAuthResolver = null;
						this.mobileAuthRejecter = null;
					}
				} catch (error) {
					console.error('Token exchange failed:', error);
					new Notice(`Authentication failed: ${error.message}`);
					
					if (this.mobileAuthRejecter) {
						this.mobileAuthRejecter(error);
						this.mobileAuthResolver = null;
						this.mobileAuthRejecter = null;
					}
				}
			};

			// Show the waiting modal with manual code fallback
			this.mobileAuthModal = new MobileOAuthWaitingModal(
				this.app, 
				() => {
					// User cancelled
					if (this.mobileAuthRejecter) {
						this.mobileAuthRejecter(new Error('User cancelled authentication'));
						this.mobileAuthResolver = null;
						this.mobileAuthRejecter = null;
					}
				},
				handleManualCode
			);
			this.mobileAuthModal.open();

			// Open the auth URL in the system browser
			// On mobile, this will open in Safari/Chrome, then redirect to the hosted page,
			// which will then redirect back to Obsidian via obsidian:// URI
			window.open(authUrl);
		});
	}

	// Desktop authorization flow with local HTTP server
	private async _performDesktopAuthorization(): Promise<GmailTokens> {
		if (!http || !url || !destroyer) {
			throw new Error('Desktop authorization requires Node.js modules');
		}

		await this.closeOpenAuthTabs();

		const verifier = this.generatePKCEVerifier();
		const challenge = await this.generatePKCEChallenge(verifier);
		const state = this.generateState();

		this.settings.pkce_verifier = verifier;
		this.settings.pkce_state = state;
		await this.saveSettings();

		// Build the auth URL with PKCE challenge
		const params = new URLSearchParams({
			client_id: this.settings.client_id,
			redirect_uri: this.getRedirectUri(),
			response_type: 'code',
			scope: this.settings.scopes.join(' '),
			access_type: 'offline',
			prompt: 'consent',
			state: state,
			code_challenge: challenge,
			code_challenge_method: 'S256'
		});

		const authUrl = `${this.settings.auth_uri}?${params.toString()}`;
		const LISTEN_PORT = this.getPortFromURI(this.settings.redirect_uris[0]);

		return new Promise((resolve, reject) => {
			let completed = false;

			const authTimeout = setTimeout(() => {
				if (!completed) {
					console.log('Authorization timeout - no response received');
					if (server_?.listening) {
						server_.close();
					}
					reject(new Error('Authorization timeout - no response received within 5 minutes'));
				}
			}, 5 * 60 * 1000);

			if (server_?.listening) {
				console.log("Server is listening on port, destroy before creating new one.")
				server_.close()
			}

			server_ = http.createServer(async (req, res) => {
				try {
					if (req.url && req.url.indexOf('/oauth2callback') > -1) {
						clearTimeout(authTimeout);
						completed = true;

						const qs = new url.URL(req.url, this.settings.redirect_uris[0]).searchParams;
						const code = qs.get('code');
						const returnedState = qs.get('state');

						if (returnedState !== this.settings.pkce_state) {
							console.error('State mismatch - possible CSRF attack');
							res.writeHead(400, { 'Content-Type': 'text/html' });
							res.end(`
								<html>
									<body>
										<h1>Authentication Failed</h1>
										<p>Invalid state parameter</p>
									</body>
								</html>
							`);
							server_.close();
							reject(new Error("State mismatch"));
							return;
						}

						const error = qs.get("error");
						if (error) {
							const errorDescription = qs.get("error_description") || "Unknown error";
							res.writeHead(200, { 'Content-Type': 'text/html' });
							res.end(`
								<html>
									<body>
										<h1 style="color: #d73a49;">Authentication Failed</h1>
										<p>Error: ${error}</p>
										<p>${errorDescription}</p>
										<script>setTimeout(() => window.close(), 3000);</script>
									</body>
								</html>
							`);
							server_.close();
							reject(new Error(`OAuth failed: ${error} - ${errorDescription}`));
							return;
						}

						if (!code) {
							res.writeHead(200, { 'Content-Type': 'text/html' });
							res.end(`
								<html>
									<body>
										<h1 style="color: #d73a49;">Authentication Failed</h1>
										<p>No authorization code received.</p>
										<script>setTimeout(() => window.close(), 3000);</script>
									</body>
								</html>
							`);
							server_.close();
							reject(new Error("No authorization code received"));
							return;
						}

						try {
							const tokens = await this.exchangeCodeForTokens(code, this.settings.pkce_verifier);

							// Clean up PKCE values
							delete this.settings.pkce_verifier;
							delete this.settings.pkce_state;
							await this.saveSettings();

							res.writeHead(200, { 'Content-Type': 'text/html' });
							res.end(`
								<html>
									<body>
										<h1 style="color: #28a745;">Authentication Successful!</h1>
										<p>You can now use the Gmail sync feature.</p>
										<script>window.close();</script>
									</body>
								</html>
							`);
							server_.close();
							resolve(tokens);
						} catch (tokenError) {
							res.writeHead(200, { 'Content-Type': 'text/html' });
							res.end(`
								<html>
									<body>
										<h1 style="color: #d73a49;">Token Exchange Failed</h1>
										<p>${tokenError.message}</p>
										<script>setTimeout(() => window.close(), 3000);</script>
									</body>
								</html>
							`);
							server_.close();
							reject(tokenError);
						}
					}
				} catch (err) {
					console.log(`Error in OAuth callback: ${JSON.stringify(err)}`);
					reject(err);
				}
			});

			server_.listen(LISTEN_PORT, () => {
				window.open(authUrl, 'catchment-oauth-window');
			});

			if (destroyer) {
				destroyer(server_);
			}
		});
	}

	// Exchange authorization code for tokens using fetch (works on all platforms)
	private async exchangeCodeForTokens(code: string, verifier: string): Promise<GmailTokens> {
		const params = new URLSearchParams({
			client_id: this.settings.client_id,
			code: code,
			code_verifier: verifier,
			grant_type: 'authorization_code',
			redirect_uri: this.getRedirectUri()
		});

		const response = await fetch(this.settings.token_uri, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: params.toString()
		});

		if (!response.ok) {
			const errorData = await response.json();
			throw new Error(`Token exchange failed: ${errorData.error_description || errorData.error}`);
		}

		const tokenData = await response.json();

		return {
			access_token: tokenData.access_token,
			refresh_token: tokenData.refresh_token,
			token_type: tokenData.token_type,
			refresh_token_expires_in: tokenData.expires_in || 3600,
			expiry_date: Date.now() + (tokenData.expires_in || 3600) * 1000
		};
	}

	private getPortFromURI(uri: string): number {
		const match = uri.match(/:([0-9]+)/m) || [];
		return Number(match[1])
	}

	private async closeOpenAuthTabs() {
		if (Platform.isMobile) return;

		const searchString = "accounts.google.com/v3/signin/accountchooser"
		const workspace = this.app.workspace;

		const existingLeaves = workspace.getLeavesOfType("webviewer");
		const matchingLeaves = existingLeaves.filter(leaf => {
			const state = leaf.view.getState();
			const currentUrl = state.url as string;
			return currentUrl && currentUrl.includes(searchString);
		});

		matchingLeaves.forEach(leaf => leaf.detach());
	}

	async initializeGoogleAuth(): Promise<boolean> {
		const currentDate = Date.now()
		const expiryDate = this.settings.refresh_token_expiry
		const notExpired = expiryDate > currentDate
		const hasValidToken = this.settings.access_token && this.settings.refresh_token && notExpired

		if (hasValidToken) {
			return true
		}

		if (!notExpired && this.settings.refresh_token) {
			console.log(`Token is expired: ${expiryDate} < ${currentDate}`)
			// Try to refresh the token
			const refreshed = await this.refreshAccessToken();
			if (refreshed) {
				return true;
			}
		}

		// Need to get new tokens
		if (!this.settings.access_token || !this.settings.refresh_token || !notExpired) {
			try {
				const tokens = await this.getNewTokens()
				this.settings.access_token = tokens.access_token
				this.settings.refresh_token = tokens.refresh_token
				this.settings.expiry_date = tokens.expiry_date
				this.settings.refresh_token_expires_in = tokens.refresh_token_expires_in * 1000
				this.settings.last_refreshed_date = Date.now()
				this.settings.refresh_token_expiry = this.settings.last_refreshed_date + this.settings.refresh_token_expires_in
				await this.saveSettings()
				return true
			} catch (error) {
				if (error.message.includes('timeout')) {
					console.error('Authorization timed out:', error);
					new Notice('Authorization timed out. Please try syncing again.');
					return false;
				}
				if (error.message.includes('cancelled')) {
					console.log('Authorization cancelled by user');
					return false;
				}
				console.error('Failed to get tokens:', error);
				new Notice('Failed to authenticate with Google');
				return false;
			}
		}

		return true
	}

	startGmailAutoSync() {
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
		console.log(`Refreshing Token...`)

		if (!this.settings.refresh_token) {
			new Notice('No refresh token available. Please re-authenticate.');
			return false;
		}

		try {
			const params = new URLSearchParams({
				client_id: this.settings.client_id,
				refresh_token: this.settings.refresh_token,
				grant_type: 'refresh_token'
			});

			const response = await fetch(this.settings.token_uri, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: params.toString()
			});

			if (!response.ok) {
				const errorData = await response.json();
				console.error('Token refresh failed:', errorData);
				// If refresh token is invalid, clear it and require re-auth
				if (errorData.error === 'invalid_grant') {
					this.settings.refresh_token = '';
					this.settings.access_token = '';
					await this.saveSettings();
					new Notice('Session expired. Please re-authenticate.');
				}
				return false;
			}

			const tokenData = await response.json();
			this.settings.access_token = tokenData.access_token;
			this.settings.expiry_date = Date.now() + (tokenData.expires_in || 3600) * 1000;
			await this.saveSettings();

			console.log('Token refreshed successfully');
			return true;
		} catch (error) {
			console.error('Failed to refresh access token:', error);
			return false;
		}
	}

	// Gmail API methods using fetch (cross-platform)
	async listGmailMessages(params: any = {}): Promise<any> {
		// DEBUG
		console.log(`LIST GMAIL MESSAGES INIT AUTH NEXT`)
		const authInitialized = await this.initializeGoogleAuth();
		// DEBUG
		console.log(`LIST GMAIL MESSAGES INIT AUTH DONE`)
		if (!authInitialized) {
			return null;
		}

		try {
			return await this._fetchGmailMessages(params);
		} catch (error: any) {
			if (error.status === 401) {
				console.log('Token expired, refreshing...');
				if (await this.refreshAccessToken()) {
					return await this._fetchGmailMessages(params);
				}
			}
			console.error('Gmail API request failed:', error);
			new Notice('Failed to fetch emails from Gmail');
			return null;
		}
	}

	private async _fetchGmailMessages(params: any = {}): Promise<any> {
		const queryParams = new URLSearchParams();
		if (params.q) queryParams.set('q', params.q);
		if (params.maxResults) queryParams.set('maxResults', params.maxResults.toString());
		if (params.pageToken) queryParams.set('pageToken', params.pageToken);

		const response = await fetch(
			`https://gmail.googleapis.com/gmail/v1/users/me/messages?${queryParams.toString()}`,
			{
				headers: {
					'Authorization': `Bearer ${this.settings.access_token}`,
					'Accept': 'application/json'
				}
			}
		);

		if (!response.ok) {
			const error = new Error(`Gmail API error: ${response.status}`);
			(error as any).status = response.status;
			throw error;
		}

		return await response.json();
	}

	async getGmailMessage(messageId: string): Promise<any> {
		if (!this.settings.access_token) {
			return null;
		}

		try {
			return await this._fetchGmailMessage(messageId);
		} catch (error: any) {
			if (error.status === 401) {
				if (await this.refreshAccessToken()) {
					return await this._fetchGmailMessage(messageId);
				}
			}
			console.error('Failed to get Gmail message:', error);
			return null;
		}
	}

	private async _fetchGmailMessage(messageId: string): Promise<any> {
		const response = await fetch(
			`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
			{
				headers: {
					'Authorization': `Bearer ${this.settings.access_token}`,
					'Accept': 'application/json'
				}
			}
		);

		if (!response.ok) {
			const error = new Error(`Gmail API error: ${response.status}`);
			(error as any).status = response.status;
			throw error;
		}

		return await response.json();
	}

	async syncNewsletters() {
		// // DEBUG
		// console.log(`Sync Newletters`)
		// if (!this.settings.access_token && !this.settings.refresh_token) {
		// 	new Notice('Please configure Gmail authentication in settings first.');
		// 	return;
		// }

		// // DEBUG
		// console.log(`Second Sync Newletters`)
		new Notice('Syncing Substack newsletters...');

		try {
			const query = 'from:substack.com AND -from:no-reply@substack.com AND -label:CATEGORY_PROMOTION AND -replyto:no-reply@substack.com';
			const messagesResponse = await this.listGmailMessages({
				q: query,
				maxResults: this.settings.maxEmails
			});

			if (!messagesResponse || !messagesResponse.messages) {
				new Notice('No Substack newsletters found');
				console.log(`Message Response from Gmail: ${JSON.stringify(messagesResponse)}`)
				return;
			}

			let processedCount = 0;
			const existingFiles = new Set<string>();

			const folder = this.app.vault.getAbstractFileByPath(this.settings.catchementFolder);
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
		const headers = message.payload.headers;
		const subject = headers.find(h => h.name === 'Subject')?.value || 'Untitled';
		const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
		const date = headers.find(h => h.name === 'Date')?.value;
		const replyto = headers.find(h => h.name == 'Reply-To')?.value;

		if (!replyto) {
			return false
		}

		const publicationMatch = from.match(/^(.+?)\s*<.*@substack\.com>/);
		const publication = publicationMatch ? publicationMatch[1].trim() : 'Unknown Publication';

		const sanitizedSubject = await this.formatFilename(subject)
		const filename = `${sanitizedSubject}`;

		if (existingFiles.has(filename)) {
			return false;
		}

		let content = this.extractEmailContent(message);
		if (!content) {
			content = message.snippet || 'No content available';
		}

		const markdownContent = this.createMarkdownContent(
			subject.replace(/"/g, ''),
			publication.replace(/"/g, ''),
			from.replace(/" /g, ''),
			date,
			content
		);

		await this.ensureFolderExists(this.settings.catchementFolder);

		const filePath = `${this.settings.catchementFolder}/${filename}.md`;
		await this.app.vault.create(filePath, markdownContent);

		return true;
	}

	extractEmailContent(message: GmailMessage): string {
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

		content = convertHtmltoMarkdown(content);
		return content;
	}

	decodeBase64(data: string): string {
		try {
			const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
			return atob(base64);
		} catch (error) {
			console.error('Failed to decode base64:', error);
			return '';
		}
	}

	createMarkdownContent(subject: string, publication: string, from: string, date: string, content: string): string {
		const frontmatter = `---
title: "${subject}"
publication: "${publication}"
author: "${from}"
date: "${date}"
type: substack-newsletter
icon: "${this.settings.substackIcon}"
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

class CatchmentSettingTab extends PluginSettingTab {
	plugin: CatchementPlugin;

	nostrClient = new NostrNIP23Client([
		"wss://relay.damus.io",
		"wss://nos.lol",
		"wss://relay.snort.social"
	])

	constructor(app: App, plugin: CatchementPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Content Sync Settings' });

		// Show platform info
		if (Platform.isMobile) {
			containerEl.createEl('div', {
				text: '📱 Running on mobile - using Obsidian URI scheme for seamless authentication',
				attr: { style: 'background: var(--background-secondary); padding: 8px; border-radius: 4px; margin-bottom: 16px;' }
			});
		}

		// Gmail Sync Settings
		containerEl.createEl('h3', { text: 'Aggregation Configuration' });
		new Setting(containerEl)
			.setName('Articles Folder')
			.setDesc('Folder where substack and nostr articles will be saved')
			.addText(text => text
				.setPlaceholder('Substack Newsletters')
				.setValue(this.plugin.settings.catchementFolder)
				.onChange(async (value) => {
					this.plugin.settings.catchementFolder = value;
					await this.plugin.saveSettings();
				}));

		// Gmail Authentication Status
		containerEl.createEl('h3', { text: 'Gmail Authentication' });

		const authStatus = this.plugin.settings.access_token ? 'Connected' : 'Not connected';
		const authStatusEl = containerEl.createEl('div', {
			text: `Status: ${authStatus}`,
			attr: { style: 'margin-bottom: 8px;' }
		});

		if (this.plugin.settings.access_token) {
			authStatusEl.style.color = 'var(--text-success)';
		} else {
			authStatusEl.style.color = 'var(--text-error)';
		}

		new Setting(containerEl)
			.setName('Authenticate with Gmail')
			.setDesc('Connect your Gmail account to sync Substack newsletters')
			.addButton(button => button
				.setButtonText(this.plugin.settings.access_token ? 'Re-authenticate' : 'Connect Gmail')
				.setCta()
				.onClick(async () => {
					try {
						await this.plugin.initializeGoogleAuth();
						this.display(); // Refresh to show updated status
					} catch (error) {
						console.error('Authentication failed:', error);
						new Notice('Authentication failed. Please try again.');
					}
				}));

		// Gmail Sync Settings
		containerEl.createEl('h3', { text: 'Sync Configuration' });

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
			.setName('Gmail Auto-sync Frequency')
			.setDesc('How often to automatically sync Gmail (in minutes, 0 to disable)')
			.addSlider(slider => slider
				.setLimits(0, 1440, 0)
				.setValue(this.plugin.settings.syncFrequency)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.syncFrequency = value;
					await this.plugin.saveSettings();
					this.plugin.startGmailAutoSync();
				}));

		new Setting(containerEl)
			.setName('Substack Articles Icon Name')
			.setDesc('Name of Icon to display beside substack articles.')
			.addText(text => text
				.setPlaceholder('Icon Name')
				.setValue(this.plugin.settings.substackIcon)
				.onChange(async (value) => {
					this.plugin.settings.substackIcon = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable Nostr Sync')
			.setDesc('Enable syncing of long-form articles from Nostr')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.nostrEnabled)
				.onChange(async (value) => {
					this.plugin.settings.nostrEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.nostrEnabled) {
			new Setting(containerEl)
				.setName('Nostr Auto-sync Frequency')
				.setDesc('How often to automatically sync Nostr articles (in minutes, 0 to disable)')
				.addSlider(slider => slider
					.setLimits(0, 1440, 30)
					.setValue(this.plugin.settings.nostrSyncFrequency)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.nostrSyncFrequency = value;
						await this.plugin.saveSettings();
						this.plugin.startNostrAutoSync();
					}));
			new Setting(containerEl)
				.setName('Nostr Articles Icon Name')
				.setDesc('Name of Icon to display beside nostr articles.')
				.addText(text => text
					.setPlaceholder('Icon Name')
					.setValue(this.plugin.settings.nostrIcon)
					.onChange(async (value) => {
						this.plugin.settings.nostrIcon = value;
						await this.plugin.saveSettings();
					}));

			containerEl.createEl('h4', { text: 'Nostr Relays' });
			containerEl.createEl('p', {
				text: 'Add or remove Nostr relays (one per line). These are the servers that will be queried for articles.',
				cls: 'setting-item-description'
			});

			new Setting(containerEl)
				.setName('Nostr Relays')
				.setDesc('List of Nostr relays to connect to')
				.addTextArea(text => {
					text.inputEl.rows = 6;
					text.inputEl.cols = 50;
					return text
						.setPlaceholder('wss://relay.damus.io\nwss://nos.lol\nwss://relay.snort.social')
						.setValue(this.plugin.settings.nostrRelays.join('\n'))
						.onChange(async (value) => {
							this.plugin.settings.nostrRelays = value
								.split('\n')
								.map(relay => relay.trim())
								.filter(relay => relay.length > 0);
							await this.plugin.saveSettings();
						});
				});

			containerEl.createEl('div', {
				text: '💡 Tip: You can paste npub1... format or hex pubkeys. The plugin will handle both formats.',
				cls: 'setting-item-description',
				attr: { style: 'margin-top: 8px; font-style: italic; color: var(--text-muted);' }
			});

			const quickAddContainer = containerEl.createDiv({ cls: 'setting-item' });
			quickAddContainer.createEl('div', {
				text: 'Quick Add Author',
				cls: 'setting-item-name'
			});
			quickAddContainer.createEl('div', {
				text: 'Paste a pubkey here to quickly add it to your followed authors',
				cls: 'setting-item-description'
			});

			const inputContainer = quickAddContainer.createDiv({ cls: 'setting-item-control' });
			const quickAddInput = inputContainer.createEl('input', {
				type: 'text',
				placeholder: 'npub1... or hex pubkey',
				attr: { style: 'width: 300px; margin-right: 8px;' }
			});

			const addButton = inputContainer.createEl('button', {
				text: 'Add Author',
				cls: 'mod-cta'
			});

			addButton.onclick = async () => {
				const npub = this.cleanPubkey(quickAddInput.value);
				const nostrFollowedPubkeys = this.plugin.settings.nostrFollowedAuthors.map(x => x.npub)
				if (npub && !nostrFollowedPubkeys.includes(npub)) {

					const nostrAuthor = {
						npub: npub,
					}
					const metadata = await this.nostrClient.getNostrData(0, [nostrAuthor], 1, () => { })

					this.plugin.settings.nostrFollowedAuthors.push({
						pubkey: metadata.pubkey,
						npub: npub,
						username: metadata.username,
						display_name: metadata.display_name,
						lastUpdated: Date.now(),
					});
					await this.plugin.saveSettings();
					quickAddInput.value = '';
					this.display();
					new Notice('Author added successfully!');
				} else if (!npub) {
					new Notice('Please enter a valid npub');
				} else {
					new Notice('Author already in the list');
				}
			};

			if (this.plugin.settings.nostrFollowedAuthors.length > 0) {
				containerEl.createEl('h5', { text: 'Currently Following:' });
				const followedList = containerEl.createEl('div', { cls: 'nostr-followed-list' });

				this.plugin.settings.nostrFollowedAuthors.forEach((author, index) => {
					const authorItem = followedList.createDiv({ cls: 'nostr-author-item' });
					authorItem.style.cssText = 'display: flex; align-items: center; margin: 4px 0; padding: 8px; background: var(--background-secondary); border-radius: 4px;';

					const usernameSpan = authorItem.createSpan({
						text: author.username || author.display_name || 'Unknown',
						attr: { style: 'flex: 1; font-size: 14px; color: var(--text-normal);' }
					});
					const npubSpan = authorItem.createSpan({
						text: this.truncatePubkey(author.npub),
						attr: { style: 'flex: 0 0 auto; font-family: monospace; font-size: 12px; margin-right: 8px;' }
					});
					const removeButton = authorItem.createEl('button', {
						text: 'x',
						attr: {
							style: 'margin-left: 8px; padding: 2px 6px; background: var(--interactive-accent); color: white; border: none; border-radius: 2px; cursor: pointer;',
							title: 'Remove this author'
						}
					});

					removeButton.onclick = async () => {
						this.plugin.settings.nostrFollowedAuthors.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
						new Notice('Author removed');
					};
				});
			}
		}

		// Manual sync buttons
		containerEl.createEl('h3', { text: 'Manual Sync' });

		new Setting(containerEl)
			.setName('Sync Gmail Newsletters')
			.setDesc('Manually sync Substack newsletters from Gmail')
			.addButton(button => button
				.setButtonText('Sync Gmail')
				.setCta()
				.onClick(() => {
					this.plugin.syncNewsletters();
				}));

		if (this.plugin.settings.nostrEnabled) {
			new Setting(containerEl)
				.setName('Sync Nostr Articles')
				.setDesc('Manually sync long-form articles from Nostr')
				.addButton(button => button
					.setButtonText('Sync Nostr')
					.setCta()
					.onClick(() => {
						this.plugin.syncNostrArticles();
					}));
		}

		new Setting(containerEl)
			.setName('Sync All Sources')
			.setDesc('Sync content from all enabled sources')
			.addButton(button => button
				.setButtonText('Sync All')
				.setClass('mod-warning')
				.onClick(() => {
					this.plugin.syncAllContent();
				}));
	}

	cleanPubkey(pubkey: string): string {
		if (!pubkey) return '';

		pubkey = pubkey.trim();

		if (pubkey.startsWith('npub1')) {
			try {
				return pubkey;
			} catch (error) {
				console.error('Invalid npub format:', error);
				return '';
			}
		}

		if (/^[a-fA-F0-9]{64}$/.test(pubkey)) {
			return pubkey.toLowerCase();
		}

		const cleaned = pubkey.replace(/[^a-fA-F0-9npub]/g, '');
		if (cleaned.startsWith('npub1') && cleaned.length > 60) {
			return cleaned;
		}
		if (/^[a-fA-F0-9]{64}$/.test(cleaned)) {
			return cleaned.toLowerCase();
		}

		return '';
	}

	truncatePubkey(pubkey: string): string {
		if (pubkey.startsWith('npub1')) {
			return pubkey.length > 20 ? `${pubkey.substring(0, 16)}...` : pubkey;
		}
		return pubkey.length > 16 ? `${pubkey.substring(0, 8)}...${pubkey.substring(-8)}` : pubkey;
	}
}