import { App, Modal, Setting, Notice, TFile } from 'obsidian';
import SubstackGmailPlugin from './main';

export class NoteModal extends Modal {
    plugin: SubstackGmailPlugin;
    selectedText: string;
    sourceFile: TFile;
    extractTitle: string = '';
    additionalContext: string = '';
    tags: string = '';
    extractFolder: string = '';

    constructor(app: App, plugin: SubstackGmailPlugin, selectedText: string, sourceFile: TFile, extractFolder: string) {
        super(app);
        this.plugin = plugin;
        this.selectedText = selectedText;
        this.sourceFile = sourceFile;
        this.extractFolder = extractFolder + '/' + sourceFile.basename + ' notes'
        
        // Generate a default title from the first line of selected text
        const firstLine = selectedText.split('\n')[0].trim();
        this.extractTitle = firstLine.substring(0, 50).replace(/[<>:"/\\|?*]/g, '-');
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // Show preview of selected text
        const previewContainer = contentEl.createDiv('extract-preview');
        previewContainer.createEl('h4', { text: 'Selected Text:' });
        const previewEl = previewContainer.createEl('div', {
            cls: 'extract-preview-text',
            attr: { style: 'max-height: 200px; overflow-y: auto; border: 1px solid var(--background-modifier-border); padding: 10px; margin: 10px 0; background: var(--background-secondary);' }
        });
        previewEl.textContent = this.selectedText.substring(0, 500) + (this.selectedText.length > 500 ? '...' : '');

        // Additional context section
        const contextContainer = contentEl.createDiv('context-input-container');
        contextContainer.createEl('h4', { text: 'Additional Context:' });
        contextContainer.createEl('p', { 
            text: 'Add your thoughts, notes, or context about this extract',
            attr: { style: 'margin: 5px 0 10px 0; color: var(--text-muted); font-size: 0.9em;' }
        });
        
        const contextTextArea = contextContainer.createEl('textarea', {
            attr: { 
                style: 'width: 100%; min-height: 120px; border: 1px solid var(--background-modifier-border); padding: 10px; margin: 0; background: var(--background-secondary); color: var(--text-normal); border-radius: 4px; resize: vertical; font-family: var(--font-interface);',
                placeholder: 'Add your context, thoughts, or notes here...'
            }
        });
        contextTextArea.value = this.additionalContext;
        contextTextArea.addEventListener('input', (e) => {
            this.additionalContext = (e.target as HTMLTextAreaElement).value;
        });

        // Tags setting
        new Setting(contentEl)
            .setName('Tags')
            .setDesc('Add tags (comma-separated)')
            .addText(text => text
                .setPlaceholder('tag1, tag2, extract, important')
                .setValue(this.tags)
                .onChange(value => {
                    this.tags = value;
                }));

        // Extract folder setting
        // new Setting(contentEl)
        //     .setName('Extract Folder')
        //     .setDesc('Folder where the extract will be saved')
        //     .addText(text => text
        //         .setPlaceholder('Extracts')
        //         .setValue(this.extractFolder)
        //         .onChange(value => {
        //             this.extractFolder = value;
        //         }));

        // Action buttons
        const buttonContainer = contentEl.createDiv('modal-button-container');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.marginTop = '20px';

        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.onclick = () => this.close();

        const saveButton = buttonContainer.createEl('button', { 
            text: 'Save Extract',
            cls: 'mod-cta'
        });
        saveButton.onclick = () => this.saveExtract();
    }

    async saveExtract() {
        if (!this.extractTitle.trim()) {
            new Notice('Please enter a title for the extract');
            return;
        }

        try {
            // Ensure folder exists
            await this.plugin.ensureFolderExists(this.extractFolder);

            // Create filename
            const sanitizedTitle = this.extractTitle.replace(/[<>:"/\\|?*]/g, '-').trim();
            const filename = `${sanitizedTitle}.md`;
            const filePath = `${this.extractFolder}/${filename}`;

            // Check if file already exists
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile) {
                new Notice('A file with this title already exists');
                return;
            }

            // Parse tags
            const tagArray = this.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
            
            // Create markdown content
            const markdownContent = this.createExtractMarkdown();

            // Create the file
            await this.app.vault.create(filePath, markdownContent);

            new Notice(`Extract saved to ${filePath}`);
            this.close();

        } catch (error) {
            console.error('Failed to save extract:', error);
            new Notice('Failed to save extract');
        }
    }

    createExtractMarkdown(): string {
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toLocaleTimeString();

        // Parse tags for frontmatter
        const tagArray = this.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
        const tagsYaml = tagArray.length > 0 ? `[${tagArray.map(tag => `"${tag}"`).join(', ')}]` : '[]';

        const frontmatter = `---
title: "${this.extractTitle}"
type: extract
source: "[[${this.sourceFile.basename}]]"
extracted_date: "${dateStr}"
extracted_time: "${timeStr}"
tags: ${tagsYaml}
---

`;

        let content = frontmatter;

        // Add the extracted text
        content += `## Extracted Text\n\n`;
        content += `> ${this.selectedText.split('\n').join('\n> ')}\n\n`;

        // Add user context if provided
        if (this.additionalContext.trim()) {
            content += `## My Notes\n\n${this.additionalContext.trim()}\n\n`;
        }

        // Add source reference
        content += `---\n\n`;
        content += `**Source:** [[${this.sourceFile.basename}]]\n`;
        content += `**Extracted:** ${dateStr} at ${timeStr}\n`;

        return content;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}