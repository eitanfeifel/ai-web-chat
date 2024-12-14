import { ScrapingResult } from './scrape';

/**
 * Represents the processed and sanitized content ready for AI processing
 */
interface ProcessedContent {
    /** The sanitized and formatted content */
    content: string;
    /** Indicates if any content filtering was applied */
    wasFiltered: boolean;
    /** Optional reason for content filtering */
    filterReason?: string;
}

/**
 * Processes scraped content to make it suitable for AI processing.
 * This includes combining multiple sources, sanitizing content,
 * and enforcing length limits.
 * 
 * @param scrapingResults - Array of scraping results to process
 * @returns ProcessedContent object with sanitized content
 */
export function processContentForAI(scrapingResults: ScrapingResult[]): ProcessedContent {
    // Combine all content with proper attribution
    let combinedContent = scrapingResults
        .map(result => {
            const source = result.url ? `Source: ${result.url}\n` : '';
            return `${source}${result.content}`;
        })
        .join('\n\n---\n\n');

    // Basic content sanitization
    combinedContent = sanitizeContent(combinedContent);

    // Content length limits
    if (combinedContent.length > 30000) {
        combinedContent = combinedContent.substring(0, 30000) + '... (content truncated for length)';
    }

    return {
        content: combinedContent,
        wasFiltered: false
    };
}

export function sanitizeContent(content: string): string {
    return content
        // Remove Markdown-style code fences
        .replace(/```json|```/g, '')
        // Remove HTML tags
        .replace(/<[^>]*>/g, '')
        // Remove excessive whitespace
        .replace(/\s+/g, ' ')
        // Remove repeated punctuation
        .replace(/([!?,.]){2,}/g, '$1')
        // Normalize quotes (optional: ensure JSON-compatible quotes)
        .replace(/['“”]/g, '"')
        // Remove non-printable characters
        .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
        .trim();
}


// Export the interface so it can be used by other modules
export type { ProcessedContent };
