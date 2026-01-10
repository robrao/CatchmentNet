// main.ts
import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder } from 'obsidian';
import { google  } from 'googleapis';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { assertPresent } from 'typeHelpers';
import { convertHtmltoMarkdown } from 'markdownHelper';
import { NoteModal } from 'noteModal';
import { NostrNIP23Client } from './nostr';

import * as http from 'http';
import * as url from 'url';
import destroyer from 'server-destroy'

let server_ = http.createServer()

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
}

interface GmailTokens {
	access_token: string;
	refresh_token: string;
	token_type: string;
	refresh_token_expires_in: number;
	expiry_date: number;
}

const DEFAULT_SETTINGS: CatchementSettings = {
    client_id: "549575793544-qfhpgtdqvkm4c204u6lln3hbdsnu64fn.apps.googleusercontent.com",
	access_token: '',
	catchementFolder: 'Catchment',
	maxEmails: 50,
	syncFrequency: 120, // NOTE: default to two hours
	scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
	redirect_uris: [],
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
	filenameLength: 59
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

export default class CatchementPlugin extends Plugin {
	settings: CatchementSettings;
	syncInterval: number | null = null;
	nostrSyncInterval: number | null = null;
	oAuth2Client: OAuth2Client | null = null;
	gmail: any = null;
	nostrClient: NostrNIP23Client | null = null;
	// Track ongoing authorization
	authorizationInProgress: boolean = false;
	authorizationPromise: Promise<GmailTokens> | null = null;

	async onload() {
		await this.loadSettings();
		this.initializeGoogleAuth();

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
		server_.close()
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		// XXX: debug
		console.log(`Save Settings...`)
		await this.saveData(this.settings);
		this.initializeGoogleAuth(); // Reinitialize auth when settings change

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
		if (sanitizedTitle.length > this.settings.filenameLength+3) {
			sanitizedTitle = sanitizedTitle.slice(0, this.settings.filenameLength) + '...';
		}

		return sanitizedTitle
	}

	// PKCE helper methods using Web Crypto API
	private generateRandomBytes(length: number): Uint8Array {
		const array = new Uint8Array(length);
		// Use Web Crypto API's getRandomValues
		crypto.getRandomValues(array);
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
		// Generate 64 random bytes and encode as base64url
		const randomBytes = this.generateRandomBytes(64);
		return this.base64URLEncode(randomBytes);
	}

	private async generatePKCEChallenge(verifier: string): Promise<string> {
		// SHA256 hash of verifier, encoded as base64url
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		// Use Web Crypto API's subtle.digest
		const hash = await crypto.subtle.digest('SHA-256', data);
		return this.base64URLEncode(hash);
	}

	private generateState(): string {
		// Random state for CSRF protection
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

			// NOTE; use lasy sync time if available, otherwise query up to limit
			const sinceDate = this.settings.nostrLastSyncTime
				? new Date(this.settings.nostrLastSyncTime * 1000)
				: undefined


			// NOTE: may want to do something like this if a lot of time has passed
			// increase the limit, but this as is doesn't really make sense

			// If we have a last sync time, we might want to increase the limit
			// to ensure we get all new articles
			// const queryLimit = sinceDate ? 50 : 10;
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

			// Show result after a delay to allow processing
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

			// Create a safe filename
			const sanitizedTitle = await this.formatFilename(title)
			const filename = `${sanitizedTitle}`

			// Check if file already exists
			if (existingFiles.has(filename)) {
				return false;
			}

			// Create markdown content
			const markdownContent = this.createNostrMarkdownContent(article);

			// Create the file
			const filePath = `${this.settings.catchementFolder}/${filename}.md`;
			await this.app.vault.create(filePath, markdownContent);

			// Add to existing files set to prevent duplicates in current session
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

		// Add title
		content += `# ${title}\n\n`;

		// Add metadata
		content += `**Author:** ${author.username}\n`;
		content += `**Published:** ${publishedDate}\n`;

		if (summary) {
			content += `**Summary:** ${summary}\n`;
		}

		if (hashtags.length > 0) {
			content += `**Tags:** ${hashtags.join(', ')}\n`;
		}

		content += '\n---\n\n';

		// Add the article content
		content += article.content;

		// Add references if any
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

		// Sync Gmail if configured
		if (this.settings.access_token) {
			promises.push(this.syncNewsletters());
		}

		// Sync Nostr if enabled
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

	// Existing Gmail methods remain the same...
	async getPortFromURI(uri: string): Promise<number> {
		const match = uri.match(/:([0-9]+)/m) || [];
		return Number(match[1])
	}

	async getNewTokens(): Promise<GmailTokens> {
		// Check if authorization is already in progress
		if (this.authorizationInProgress && this.authorizationPromise) {
			console.log('Authorization already in progress, waiting for existing flow to complete');
			return this.authorizationPromise;
		}

		// Set the authorization flag
		this.authorizationInProgress = true;

		// Create the authorization promise with timeout
		const authPromise = this._performAuthorization();
		
		// Create a timeout promise (5 minutes timeout)
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				this.closeOpenAuthTabs();
				reject(new Error('Authorization timeout - user may have closed the window'));
			}, 5 * 60 * 1000); // 5 minutes
		});

		// Race between auth and timeout
		this.authorizationPromise = Promise.race([authPromise, timeoutPromise]);

		try {
			const tokens = await this.authorizationPromise;
			return tokens;
		} catch (error) {
			// If it's a timeout, close the server
			if (error.message.includes('timeout') && server_.listening) {
				console.log('Authorization timed out, closing server');
				server_.close();
			}
			throw error;
		} finally {
			// Reset the authorization state
			this.authorizationInProgress = false;
			this.authorizationPromise = null;
		}
	}

	private async closeOpenAuthTabs() {
		const searchString = "accounts.google.com/v3/signin/accountchooser"
		const workspace = this.app.workspace;

		// 1. Find all existing tabs using the native 'webviewer' type
		const existingLeaves = workspace.getLeavesOfType("webviewer");
		// 2. Filter for leaves where the URL contains your search string
		const matchingLeaves = existingLeaves.filter(leaf => {
			const state = leaf.view.getState();
			const currentUrl = state.url as string;
			return currentUrl && currentUrl.includes(searchString);
		});

		// 3. Close all matching tabs
		matchingLeaves.forEach(leaf => leaf.detach());
	}

	private async _performAuthorization(): Promise<GmailTokens> {
		// close existing authorization tabs before start next auth process
		await this.closeOpenAuthTabs();
		// Generate PKCE values
		const verifier = this.generatePKCEVerifier();
		const challenge = await this.generatePKCEChallenge(verifier);
		const state = this.generateState();

		// Store PKCE values in settings temporarily
		this.settings.pkce_verifier = verifier;
		this.settings.pkce_state = state;
		await this.saveSettings();

		const authUrl = this.oAuth2Client.generateAuthUrl({
			access_type: 'offline',
			scope: this.settings.scopes,
			prompt: 'consent',
			state: state,
			code_challenge: challenge,
			code_challenge_method: CodeChallengeMethod.S256
		})
		const LISTEN_PORT = await this.getPortFromURI(this.settings.redirect_uris[0])

		return new Promise((resolve, reject) => {
			// Track if we've completed to prevent timeout from firing after success
			let completed = false;

			// Set up a timeout that will reject if no response is received
			const authTimeout = setTimeout(() => {
				if (!completed) {
					console.log('Authorization timeout - no response received');
					if (server_.listening) {
						server_.close();
					}
					reject(new Error('Authorization timeout - no response received within 5 minutes'));
				}
			}, 5 * 60 * 1000); // 5 minutes

			// Always close existing server before creating a new one
			if (server_.listening) {
				console.log("Server is listening on port, destroy before creating new one.")
				server_.close()
			}

			server_ = http.createServer(async (req, res) => {
				try {
					if (req.url && req.url.indexOf('/oauth2callback') > -1) {
						// Clear the timeout since we received a response
						clearTimeout(authTimeout);
						completed = true;

						const qs = new url.URL(req.url, this.settings.redirect_uris[0]).searchParams;
						const code = qs.get('code');
						const state = qs.get('state');

						// Verify state to prevent CSRF
						if (state !== this.settings.pkce_state) {
							console.error('State mismatch - possible CSRF attack');
							res.writeHead(400, {'Content-Type': 'text/html'});
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

						// Check for OAuth error response
						const error = qs.get("error");
						if (error) {
							console.log(`OAuth error: ${error}`);
							const errorDescription = qs.get("error_description") || "Unknown error";
						
							// Send error page that auto-closes
							res.writeHead(200, {'Content-Type': 'text/html'});
							res.end(`
								<html>
									<head>
										<style>
											body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
											.error { color: #d73a49; }
										</style>
									</head>
									<body>
										<h1 class="error">Authentication Failed</h1>
										<p>Error: ${error}</p>
										<p>${errorDescription}</p>
										<p>This window will close in 3 seconds...</p>
										<script>
											setTimeout(() => window.close(), 3000);
										</script>
									</body>
								</html>
							`);

							server_.close();
							reject(new Error(`OAuth failed: ${error} - ${errorDescription}`));
							return;
						}

						if (!code) {
							// No code and no error - something went wrong
							res.writeHead(200, {'Content-Type': 'text/html'});
							res.end(`
								<html>
									<body>
										<h1 style="color: #d73a49;">Authentication Failed</h1>
										<p>No authorization code received.</p>
										<p>This window will close in 3 seconds...</p>
										<script>
											setTimeout(() => window.close(), 3000);
										</script>
									</body>
								</html>
							`);
							
							server_.close();
							reject(new Error("No authorization code received"));
							return;
						}
					
							// Success case - get tokens with PKCE verifier
							const { tokens } = await this.oAuth2Client.getToken({
								code: code as string,
								codeVerifier: this.settings.pkce_verifier
							});
							this.oAuth2Client.setCredentials(tokens);

							// Clean up PKCE values
							delete this.settings.pkce_verifier;
							delete this.settings.pkce_state;
							await this.saveSettings();
					
						// Send success page that auto-closes
						res.writeHead(200, {'Content-Type': 'text/html'});
						res.end(`
							<html>
								<head>
									<style>
										body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
										.success { color: #28a745; }
									</style>
								</head>
								<body>
									<h1 class="success">Authentication Successful!</h1>
									<p>You can now use the Gmail sync feature.</p>
									<p>This window will close automatically...</p>
									<script>
										window.close();
										// Fallback if window.close() doesn't work
										setTimeout(() => {
											document.body.innerHTML = '<p>You can now close this window.</p>';
										}, 1000);
									</script>
								</body>
							</html>
						`);
						
						server_.close();
						resolve(tokens as any);
					}
				} catch (err) {
					console.log(`Error in OAuth callback: ${JSON.stringify(err)}`);
				
					// Send error response even for unexpected errors
					try {
						res.writeHead(200, {'Content-Type': 'text/html'});
						res.end(`
							<html>
								<body>
									<h1 style="color: #d73a49;">Authentication Error</h1>
									<p>An unexpected error occurred. Please try again.</p>
									<p>This window will close in 3 seconds...</p>
									<script>
										setTimeout(() => window.close(), 3000);
									</script>
								</body>
							</html>
						`);
					} catch (e) {
						// If we can't even send a response, just log it
						console.error('Failed to send error response:', e);
					}

					reject(err);
				}
			})

			server_.listen(LISTEN_PORT, () => {
				window.open(authUrl, 'catchment-oauth-window')
			})
			destroyer(server_)

			// Clean up on promise settlement
			this.authorizationPromise?.finally(() => {
				clearTimeout(authTimeout);
			});
		})
	}

	async initializeGoogleAuth() {
		const currentDate = Date.now()
		const expiryDate = this.settings.refresh_token_expiry
		const notExpired = expiryDate > currentDate
		const isInitialized = typeof this.oAuth2Client?.credentials?.refresh_token === "string"

		if (isInitialized && notExpired) {
			return true
		}

		if (!notExpired) {
			console.log(`Token is expired: ${expiryDate} < ${currentDate}`)
		}

		if (!this.settings.access_token) {
			try {
				const credentials = await this.loadData()
				const { client_id, redirect_uris, access_token, refresh_token, refresh_token_expiry, expiryDate } = credentials.installed
				this.settings.client_id = client_id
				this.settings.redirect_uris = redirect_uris
				this.settings.access_token = access_token
				this.settings.refresh_token = refresh_token
				this.settings.refresh_token_expiry = refresh_token_expiry
				this.settings.expiry_date = expiryDate
			} catch (error) {
				console.error('Failed to retreive credentials:', error);
				new Notice('Failed to retreieve credentials')
				return false
			}
		}

		if (this.settings.client_id && !this.oAuth2Client) {
			try {
				// Initialize OAuth2Client without client secret for PKCE flow
				this.oAuth2Client = new google.auth.OAuth2(
					this.settings.client_id,
					undefined, // No client secret for public clients using PKCE
					this.settings.redirect_uris[0]
				)
			} catch (error) {
				console.error('Failed to initialize Google Authorization:', error);
				new Notice('Failed to intialize Google Authorization')
				return false
			}
		}

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
			} catch (error) {
				if (error.message.includes('timeout')) {
					console.error('Authorization timed out:', error);
					new Notice('Authorization timed out. Please try syncing again.');
					return false;
				}
				throw error;
			}
		}

		this.oAuth2Client.setCredentials({
			access_token: this.settings.access_token,
			refresh_token: this.settings.refresh_token,
			expiry_date: this.settings.expiry_date,
		});

		this.gmail = google.gmail({ version: 'v1', auth: this.oAuth2Client });
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
		if (!this.oAuth2Client) {
			new Notice('Refresh failed: OAuth client not initialized. Please configure credentials.');
			return false;
		}

		try {
			const { credentials } = await this.oAuth2Client.refreshAccessToken();
			console.log(`DEBUG Credentials refreshed: ${JSON.stringify(credentials)}`)
			if (credentials.access_token) {
				this.settings.access_token = credentials.access_token;
				await this.saveSettings();
				return true;
			}
		} catch (error) {
			console.error('Failed to refresh access token:', error);
			try {
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
			// XXX: debug
			console.log(`listGmailMessages Initializing Gmail`)
			await this.initializeGoogleAuth()
			console.log(`ListingGmail Complete`)
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
				// XXX: debug
				console.log(`ListGmailRefreshToken initiating.`)
				if (await this.refreshAccessToken()) {
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

		// XXX: replace on author still doesn't work!!!
		const markdownContent = this.createMarkdownContent(subject.replace(/"/g, ''), publication.replace(/"/g, ''), from.replace(/" /g, ''), date, content);

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
					this.display(); // Refresh to show/hide Nostr settings
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


			// Nostr Relays
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

			// Add pubkey helper
			containerEl.createEl('div', {
				text: '💡 Tip: You can paste npub1... format or hex pubkeys. The plugin will handle both formats.',
				cls: 'setting-item-description',
				attr: { style: 'margin-top: 8px; font-style: italic; color: var(--text-muted);' }
			});

			// Quick add author section
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
					const metadata = await this.nostrClient.getNostrData(0, [nostrAuthor], 1, () => {})

					this.plugin.settings.nostrFollowedAuthors.push({
						pubkey: metadata.pubkey,
						npub: npub,
						username: metadata.username,
						display_name: metadata.display_name,
						lastUpdated: Date.now(),
					});
					await this.plugin.saveSettings();
					quickAddInput.value = '';
					this.display(); // Refresh to show updated list
					new Notice('Author added successfully!');
				} else if (!npub) {
					new Notice('Please enter a valid npub');
				} else {
					new Notice('Author already in the list');
				}
			};

			// Current followed authors display
			if (this.plugin.settings.nostrFollowedAuthors.length > 0) {
				containerEl.createEl('h5', { text: 'Currently Following:' });
				const followedList = containerEl.createEl('div', { cls: 'nostr-followed-list' });

				this.plugin.settings.nostrFollowedAuthors.forEach((author, index) => {
					const authorItem = followedList.createDiv({ cls: 'nostr-author-item' });
					authorItem.style.cssText = 'display: flex; align-items: center; margin: 4px 0; padding: 8px; background: var(--background-secondary); border-radius: 4px;';

				// Add username display
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

	// Helper method to clean and validate pubkeys
	cleanPubkey(pubkey: string): string {
		if (!pubkey) return '';

		pubkey = pubkey.trim();

		// Handle npub format (bech32)
		if (pubkey.startsWith('npub1')) {
			try {
				// You might want to add bech32 decoding here
				// For now, we'll store the npub format and handle conversion in the Nostr client
				return pubkey;
			} catch (error) {
				console.error('Invalid npub format:', error);
				return '';
			}
		}

		// Handle hex format
		if (/^[a-fA-F0-9]{64}$/.test(pubkey)) {
			return pubkey.toLowerCase();
		}

		// If it's not recognizable format, try to clean it
		const cleaned = pubkey.replace(/[^a-fA-F0-9npub]/g, '');
		if (cleaned.startsWith('npub1') && cleaned.length > 60) {
			return cleaned;
		}
		if (/^[a-fA-F0-9]{64}$/.test(cleaned)) {
			return cleaned.toLowerCase();
		}
		
		return '';
	}

	// Helper method to truncate pubkeys for display
	truncatePubkey(pubkey: string): string {
		if (pubkey.startsWith('npub1')) {
			return pubkey.length > 20 ? `${pubkey.substring(0, 16)}...` : pubkey;
		}
		return pubkey.length > 16 ? `${pubkey.substring(0, 8)}...${pubkey.substring(-8)}` : pubkey;
	}
}