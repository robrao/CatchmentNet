// nostr.ts
import { nip19, SimplePool } from 'nostr-tools'

import { NostrAuthor } from 'main'

export class NostrNIP23Client {
    private relays: string[];
    private connections: Map<string, any>;
    private subscriptions: Map<string, any>;
    private eventHandlers: Map<string, Function[]>;
    private pool: SimplePool

    constructor(relays: string[] = []) {
        this.relays = relays;
        this.connections = new Map();
        this.subscriptions = new Map();
        this.eventHandlers = new Map();

        this.pool = new SimplePool();
    }

    // Add relay URLs
    addRelay(relayUrl: string): void {
        if (!this.relays.includes(relayUrl)) {
            this.relays.push(relayUrl);
        }
    }

    async getNostrData(kind: number, authors: Array<NostrAuthor>, limit: number, processNote: (article) => void, since?: Date) {
        try {
            // Create filter for kind 0 events (user metadata)
            const npubkeys = authors.map(author => author.npub)
            const authorsHex = npubkeys.map(this.npubToHex)
            const filter: any = {
              kinds: [kind], // Kind 0 is user metadata
              authors: authorsHex,
              limit: limit
            };

            if (since) {
                filter.since = Math.floor(since.getTime()/1000)
            }

            // Query relays for the profile
            const events = []
            const nostrPromise = new Promise((resolve, reject) => {
                const sub = this.pool.subscribe(this.relays, filter, {
                    maxWait: 5000, // Wait up to 5 seconds
                    onevent: (event) => {
                      events.push(event);
                    },
                    oneose: () => {
                      sub.close();
                      resolve(events);
                    },
                    onclose: (reasons) => {
                      console.log('Subscription closed:', reasons);
                      resolve(events);
                    }
                });
            })

            await nostrPromise

            if (events.length === 0) {
              return null;
            }

            // Sort by created_at to get the most recent profile
            events.sort((a, b) => b.created_at - a.created_at);

            if (kind == 0) {
                const latestEvent = events[0]

                // Parse the content (JSON string containing profile data)
                const profileData = JSON.parse(latestEvent.content)

                return {
                  pubkey: latestEvent.pubkey,
                  npub: latestEvent.npub,
                  username: profileData.username || profileData.name,
                  display_name: profileData.display_name,
                  lastUpdated: new Date(latestEvent.created_at * 1000)
                };
            } else if (kind == 30023) {
                const longFormContent = events.map(this.parseLongFormEvent)

                longFormContent.map(processNote)
            }
        } catch (error) {
            throw new Error(`Failed to fetch profile: ${error.message}`);
        }
    }

    // Parse NIP-23 long form event structure
    parseLongFormEvent(event: any): any {
        const longForm = {
            id: event.id,
            pubkey: event.pubkey,
            created_at: event.created_at,
            content: event.content,
            tags: event.tags,
            sig: event.sig,
            parsed: {}
        };

        // Parse standard NIP-23 tags
        const tags: any = {};
        event.tags.forEach((tag: string[]) => {
            const [tagName, ...values] = tag;
            switch (tagName) {
                case 'd':
                    tags.identifier = values[0]; // Article identifier
                    break;
                case 'title':
                    tags.title = values[0];
                    break;
                case 'image':
                    tags.image = values[0];
                    break;
                case 'summary':
                    tags.summary = values[0];
                    break;
                case 'published_at':
                    tags.published_at = parseInt(values[0]);
                    break;
                case 't':
                    if (!tags.hashtags) tags.hashtags = [];
                    tags.hashtags.push(values[0]);
                    break;
                case 'p':
                    if (!tags.mentions) tags.mentions = [];
                    tags.mentions.push({
                        pubkey: values[0],
                        relay: values[1],
                        petname: values[2]
                    });
                    break;
                case 'e':
                    if (!tags.eventRefs) tags.eventRefs = [];
                    tags.eventRefs.push({
                        eventId: values[0],
                        relay: values[1],
                        marker: values[2]
                    });
                    break;
                case 'r':
                    if (!tags.references) tags.references = [];
                    tags.references.push(values[0]);
                    break;
            }
        });

        longForm.parsed = tags;
        return longForm;
    }

    // Helper method to convert pubkey formats
    npubToHex(pubkey: string): string {
        try {
            const decoded = nip19.decode(pubkey)
            if (decoded.type !== 'npub') {
                throw new Error('Invalid npub format');
            }
            return decoded.data;
        } catch (error) {
            throw new Error(`Failed to decode npub: ${error.message}`);
        }
    }

    // Close all connections
    disconnect(): void {
        this.connections.forEach((ws, relayUrl) => {
            ws.close();
        });
        this.connections.clear();
        this.subscriptions.clear();
        this.eventHandlers.clear();
    }
}
