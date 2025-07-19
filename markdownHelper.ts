function htmlToMarkdown(htmlContent) {
    // Create a temporary DOM element to parse HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');
    
    let markdown = '';
    
    // Extract title
    const title = doc.querySelector('h1, .post-title');
    if (title) {
        markdown += `# ${title.textContent.trim()}\n\n`;
    }
    
    // Extract subtitle
    const subtitle = doc.querySelector('h3.subtitle, .subtitle');
    if (subtitle) {
        markdown += `*${subtitle.textContent.trim()}*\n\n`;
    }
    
    // Extract author and date
    const author = doc.querySelector('.meta-EgzBVA a, [data-component-name*="author"]');
    const date = doc.querySelector('time');
    if (author || date) {
        markdown += `**Author:** ${author ? author.textContent.trim() : 'Unknown'}`;
        if (date) {
            markdown += ` | **Date:** ${date.textContent.trim()}`;
        }
        markdown += '\n\n';
    }
    
    // Look for "Read in App" link and add it early
    let readInAppLink = doc.querySelector('a[href*="redirect=app-store"]');
    if (!readInAppLink) {
        // Fallback: find links with "READ IN APP" text
        const allLinks = doc.querySelectorAll('a');
        for (const link of Array.from(allLinks)) {
            if (link.textContent.toUpperCase().includes('READ IN APP')) {
                readInAppLink = link;
                break;
            }
        }
    }
    if (readInAppLink) {
        const href = readInAppLink.getAttribute('href');
        const text = readInAppLink.textContent.trim();
        markdown += `📱 [${text}](${href})\n\n`;
    }
    
    markdown += '---\n\n';
    
    // Find the main content container
    const contentSelectors = [
        '.body.markup',           // Main article content
        '.post.typography .body', // Nested body in post
        '.markup',               // General markup content
        'body'                   // Fallback to body
    ];
    
    let contentContainer = null;
    for (const selector of contentSelectors) {
        contentContainer = doc.querySelector(selector);
        if (contentContainer && contentContainer.textContent.trim()) {
            break;
        }
    }
    
    if (!contentContainer) {
        contentContainer = doc.body;
    }
    
    // Extract content preserving document order
    markdown += extractContentInOrder(contentContainer);
    
    return markdown.trim();
}

function extractContentInOrder(container) {
    let content = '';
    
    // Get all relevant content elements in document order
    const contentElements = container.querySelectorAll('h2, h3, h4, h5, h6, p, blockquote, hr, ul, ol, .footnote');
    
    // Process elements in the order they appear in the document
    contentElements.forEach(element => {
        const tagName = element.tagName.toLowerCase();
        
        switch (tagName) {
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6':
                const level = '#'.repeat(parseInt(tagName[1]));
                const headingText = element.textContent.trim();
                if (headingText) {
                    content += `${level} ${headingText}\n\n`;
                }
                break;
                
            case 'p':
                // Skip paragraphs that are inside blockquotes (they'll be processed with the blockquote)
                if (!element.closest('blockquote')) {
                    const paragraphText = processInlineElements(element);
                    if (paragraphText.trim()) {
                        content += `${paragraphText.trim()}\n\n`;
                    }
                }
                break;
                
            case 'blockquote':
                const quoteText = element.textContent.trim();
                if (quoteText) {
                    // Process line by line to maintain blockquote formatting
                    const lines = quoteText.split('\n').map(line => line.trim()).filter(line => line);
                    content += lines.map(line => `> ${line}`).join('\n') + '\n\n';
                }
                break;
                
            case 'hr':
                content += '---\n\n';
                break;
                
            case 'ul':
            case 'ol':
                const items = element.querySelectorAll('li');
                items.forEach((li, index) => {
                    const itemText = processInlineElements(li);
                    const prefix = tagName === 'ul' ? '-' : `${index + 1}.`;
                    if (itemText.trim()) {
                        content += `${prefix} ${itemText.trim()}\n`;
                    }
                });
                content += '\n';
                break;
        }
    });
    
    // Handle footnotes separately (they usually appear at the end)
    const footnotes = container.querySelectorAll('.footnote');
    footnotes.forEach(footnote => {
        const footnoteNum = footnote.querySelector('.footnote-number')?.textContent;
        const footnoteContent = footnote.querySelector('.footnote-content')?.textContent;
        if (footnoteNum && footnoteContent) {
            content += `[^${footnoteNum}]: ${footnoteContent.trim()}\n\n`;
        }
    });
    
    return content;
}

function processInlineElements(element) {
    let text = '';
    
    // Process child nodes to handle inline formatting
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            
            switch (tagName) {
                case 'strong':
                case 'b':
                    // Recursively process content inside strong tags to preserve nested links
                    const strongContent = processInlineElements(node);
                    text += `**${strongContent}**`;
                    break;
                case 'em':
                case 'i':
                    // Recursively process content inside em tags to preserve nested links
                    const emContent = processInlineElements(node);
                    text += `*${emContent}*`;
                    break;
                case 'code':
                    text += `\`${node.textContent}\``;
                    break;
                case 'a':
                    const href = node.getAttribute('href');
                    const linkText = node.textContent;
                    if (href && !href.includes('unsubscribe')) {
                        // More specific filtering: only filter out internal app functionality
                        // Preserve all redirect URLs and external links
                        const isInternalAppAction = href.includes('substack.com/app-link') && 
                                                   !href.includes('redirect=app-store') &&
                                                   (href.includes('action=like') || 
                                                    href.includes('action=share') || 
                                                    href.includes('action=comment') ||
                                                    href.includes('submitLike=true'));
        
                        if (isInternalAppAction) {
                            text += linkText; // Just text, no link
                        } else {
                            text += `[${linkText}](${href})`; // Preserve the link
                        }
                    } else {
                        text += linkText;
                    }
                    break;
                case 'span':
                    // Handle footnote anchors
                    if (node.classList && node.classList.contains('footnote-anchor-email')) {
                        text += `[^${node.textContent}]`;
                    } else {
                        // Recursively process spans in case they contain nested formatting
                        text += processInlineElements(node);
                    }
                    break;
                case 'br':
                    text += '\n';
                    break;
                default:
                    // For any other nested elements, recursively process to preserve formatting
                    text += processInlineElements(node);
            }
        }
    }
    
    return text;
}

// Clean up function to remove extra whitespace and normalize formatting
function cleanMarkdown(markdown) {
    return markdown
        // Remove excessive newlines
        .replace(/\n{3,}/g, '\n\n')
        // Clean up spaces around punctuation
        .replace(/\s+([,.!?;:])/g, '$1')
        // Remove trailing spaces
        .replace(/[ \t]+$/gm, '')
        // Normalize quote formatting
        .replace(/^>\s*$/gm, '>')
        // Clean up list formatting
        .replace(/^(\s*[-*+]\s*)\s+/gm, '$1')
        .trim();
}

export function convertHtmltoMarkdown(htmlContent: string): string {
    const markdown = htmlToMarkdown(htmlContent);
    const cleanedMarkdown = cleanMarkdown(markdown);

    return cleanedMarkdown;
}
