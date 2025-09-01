function htmlToMarkdown(htmlContent: string): string {

    // TODO: test below
    // Pre-clean the HTML to reduce memory usage
    // const cleanedHtml = htmlContent
    //     // Remove large style blocks and scripts that aren't needed
    //     .replace(/<style[\s\S]*?<\/style>/gi, '')
    //     .replace(/<script[\s\S]*?<\/script>/gi, '')
    //     // Remove tracking images and tiny images early
    //     .replace(/<img[^>]*(?:width="1"|height="1")[^>]*>/gi, '')
    //     .replace(/<img[^>]*src="[^"]*(?:tracking|pixel|beacon)[^"]*"[^>]*>/gi, '')
    //     .replace(/&#8212;/g, '')
    //     // Remove excessive whitespace
    //     .replace(/\s+/g, ' ')
    //     .trim();

    const parser = new DOMParser()
    const doc = parser.parseFromString(htmlContent, 'text/html')
    
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
    
    // Extract content preserving document order and avoiding duplicates
    markdown += extractContentInOrder(contentContainer);
    
    return markdown.trim();
}

function extractContentInOrder(container: Element): string {
    let content = '';
    
    // Get all relevant content elements in document order (including images)
        // Get all relevant content elements in document order (including images)
    const allElements = container.querySelectorAll('h2, h3, h4, h5, h6, p, blockquote, hr, ul, ol, .footnote, img, figure, .captioned-image-container');
    
    // Filter out elements that are descendants of other elements we're processing
    const topLevelElements = Array.from(allElements).filter((element: Element) => {
        // Check if this element is contained within another element in our list
        return !Array.from(allElements).some(otherElement => 
            otherElement !== element && 
            element instanceof Element &&
            otherElement instanceof Element &&
            otherElement.contains(element) &&
            // Only exclude if the parent is a block-level element that processes its own content
            (otherElement.tagName.toLowerCase() === 'blockquote' ||
             otherElement.tagName.toLowerCase() === 'ul' ||
             otherElement.tagName.toLowerCase() === 'ol' ||
             otherElement.classList.contains('footnote') ||
             otherElement.tagName.toLowerCase() === 'figure' ||
             otherElement.classList.contains('captioned-image-container'))
        );
    });
    
    // Process elements in the order they appear in the document
    topLevelElements.forEach(element => {
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
                // Skip paragraphs that are inside blockquotes OR footnotes
                if (element.closest('blockquote') || element.closest('.footnote')) {
                    return;
                }
                
                const paragraphText = processInlineElementsSimple(element);
                if (paragraphText.trim()) {
                    content += `${paragraphText.trim()}\n\n`;
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
                    const itemText = processInlineElementsSimple(li);
                    const prefix = tagName === 'ul' ? '-' : `${index + 1}.`;
                    if (itemText.trim()) {
                        content += `${prefix} ${itemText.trim()}\n`;
                    }
                });
                content += '\n';
                break;
                
            case 'img':
                // Handle standalone images
                if (!element.closest('figure') && !element.closest('.captioned-image-container')) {
                    const imageMarkdown = processImage(element);
                    if (imageMarkdown) {
                        content += `${imageMarkdown}\n\n`;
                    }
                }
                break;
                
            case 'figure':
                // Handle figure elements (which may contain images and captions)
                const figureMarkdown = processFigure(element);
                if (figureMarkdown) {
                    content += `${figureMarkdown}\n\n`;
                }
                break;
                
            case 'div':
                // Handle footnotes when we encounter them in document order
                if (element instanceof Element && element.classList.contains('footnote')) {
                    const footnoteNum = element.querySelector('.footnote-number')?.textContent;
                    const footnoteContent = element.querySelector('.footnote-content')?.textContent;
                    if (footnoteNum && footnoteContent) {
                        content += `[^${footnoteNum}]: ${footnoteContent.trim()}\n\n`;
                    }
                }
                // Handle captioned image containers
                else if (element instanceof Element && element.classList.contains('captioned-image-container')) {
                    const imageMarkdown = processCaptionedImageContainer(element);
                    if (imageMarkdown) {
                        content += `${imageMarkdown}\n\n`;
                    }
                }
                break;
        }
    });
    
    return content;
}

function processImage(img) {
    const src = img.getAttribute('src');
    const alt = img.getAttribute('alt') || '';
    const title = img.getAttribute('title') || '';
    
    // Skip tracking images and tiny images
    if (!src || 
        src.includes('tracking') || 
        img.getAttribute('width') === '1' || 
        img.getAttribute('height') === '1') {
        return '';
    }
    
    // Create markdown image syntax
    let imageMarkdown = `![${alt}](${src})`;
    
    // Add title if present
    if (title) {
        imageMarkdown = `![${alt}](${src} "${title}")`;
    }
    
    return imageMarkdown;
}

function processFigure(figure) {
    // Look for image within the figure
    const img = figure.querySelector('img');
    if (!img) return '';
    
    const imageMarkdown = processImage(img);
    if (!imageMarkdown) return '';
    
    // Look for caption
    const caption = figure.querySelector('figcaption, .image-caption, .caption');
    
    if (caption) {
        const captionText = caption.textContent.trim();
        // Return image with caption as italic text below
        return `${imageMarkdown}\n*${captionText}*`;
    }
    
    return imageMarkdown;
}

function processCaptionedImageContainer(container) {
    // Look for image within the container
    const img = container.querySelector('img');
    if (!img) return '';
    
    const imageMarkdown = processImage(img);
    if (!imageMarkdown) return '';
    
    // Look for caption in various possible locations
    const caption = container.querySelector('.image-caption, .caption, figcaption, .subtitle') ||
                   container.nextElementSibling?.classList.contains('caption') ? container.nextElementSibling : null;
    
    if (caption) {
        const captionText = caption.textContent.trim();
        // Return image with caption as italic text below
        return `${imageMarkdown}\n*${captionText}*`;
    }
    
    return imageMarkdown;
}

function handleEmphasisFormatting(content: string, marker: string): string {
    // First, handle leading whitespace
    const leadingWhitespace = content.match(/^\s*/)[0];
    let remaining = content.slice(leadingWhitespace.length);
    
    // Handle trailing whitespace and punctuation (including em dash, en dash, etc.)
    const trailingMatch = remaining.match(/^(.+?)(\s+|[.,!?;:\-—–]+\s*|\s*[.,!?;:\-—–]+|\s+[.,!?;:\-—–]+\s*)$/);
    
    let coreContent = remaining;
    let trailingContent = '';
    
    if (trailingMatch) {
        coreContent = trailingMatch[1];
        trailingContent = trailingMatch[2];
    }
    
    // Trim the core content
    coreContent = coreContent.trim();
    
    // If core content is empty or just punctuation/dashes, don't emphasize
    if (!coreContent || /^[.,!?;:\-—–\s]*$/.test(coreContent)) {
        return content; // Return original content without emphasis
    }
    
    // Return properly formatted emphasis
    return leadingWhitespace + marker + coreContent + marker + trailingContent;
}

function processInlineElementsSimple(element) {
    let text = '';
    
    // Simple recursive approach
    function processNode(node) {
        if (node.nodeType === 3) { // TEXT_NODE
            return node.textContent;
        } else if (node.nodeType === 1) { // ELEMENT_NODE
            const tagName = node.tagName.toLowerCase();
            let result = '';
            
            switch (tagName) {
                case 'strong':
                case 'b':
                    // Process children recursively
                    for (const child of node.childNodes) {
                        result += processNode(child);
                    }
                    return `**${result}**`;

                case 'em':
                case 'i':
                    // Process children recursively
                    for (const child of node.childNodes) {
                        result += processNode(child);
                    }

                    // If content is only whitespace, return it as-is (don't emphasize spaces)
                    if (/^\s*$/.test(result)) {
                        return result;
                    }

                    // Don't wrap empty content after trimming
                    if (!result.trim()) {
                        return '';
                    }

                    // Handle punctuation and spacing issues
                    result = handleEmphasisFormatting(result, '*');
                    return result;

                case 'code':
                    return `\`${node.textContent}\``;
                    
                case 'img':
                    // Handle inline images
                    const inlineImageMarkdown = processImage(node);
                    return inlineImageMarkdown || '';
                    
                case 'a':
                    const href = node.getAttribute('href');
                    const linkText = node.textContent;
                    if (href && !href.includes('unsubscribe')) {
                        // Filter out internal app actions only
                        const isInternalAppAction = href.includes('substack.com/app-link') && 
                                                   !href.includes('redirect=app-store') &&
                                                   (href.includes('action=like') || 
                                                    href.includes('action=share') || 
                                                    href.includes('action=comment') ||
                                                    href.includes('submitLike=true'));
                        
                        if (isInternalAppAction) {
                            return linkText; // Just text, no link
                        } else {
                            return `[${linkText}](${href})`; // Preserve the link
                        }
                    } else {
                        return linkText;
                    }
                    
                case 'span':
                    // Handle footnote anchors
                    if (node.classList && node.classList.contains('footnote-anchor-email')) {
                        return `[^${node.textContent}]`;
                    } else {
                        // Process children recursively
                        for (const child of node.childNodes) {
                            result += processNode(child);
                        }
                        return result;
                    }
                    
                case 'br':
                    return '\n';
                    
                default:
                    // Process children recursively for any other element
                    for (const child of node.childNodes) {
                        result += processNode(child);
                    }
                    return result;
            }
        }
        return '';
    }
    
    // Process all child nodes
    for (const child of element.childNodes) {
        text += processNode(child);
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
