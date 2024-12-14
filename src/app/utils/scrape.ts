import puppeteer, { Browser, Page } from 'puppeteer';
import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import { createCacheKey, getCachedContent, setCachedContent } from './cache';

// Configuration constants
const MAX_WORKERS = 3;
const SCRAPING_TIMEOUT = 15000;
const MIN_CONTENT_LENGTH = 100;
const MIN_SENTENCES = 3;
const MIN_WORD_LENGTH = 3;

// Custom error class for scraping-specific errors
export class ScrapingError extends Error {
    constructor(message: string, public url: string, public method: string) {
        super(message);
        this.name = 'ScrapingError';
    }
}

// Enhanced types for better tracking and monitoring
export interface ScrapingMetrics {
    startTime: number;
    cheerioAttemptTime?: number;
    puppeteerAttemptTime?: number;
    totalTime: number;
    success: boolean;
    method: 'cheerio' | 'puppeteer' | 'cache';
}

export interface ScrapingResult {
    content: string;
    title: string;
    success: boolean;
    error?: string;
    url: string; // Made required
    timestamp: string;
    scrapeMethod?: string;
    metrics?: ScrapingMetrics;
    contentStats?: {
        wordCount: number;
        characterCount: number;
        paragraphCount: number;
        averageWordLength: number;
    };
}

// Enhanced browser pool with health checking
export class BrowserPool {
    private static instance: BrowserPool;
    private browsers: Array<{ browser: Browser; lastUsed: number }> = [];
    private maxBrowsers = MAX_WORKERS;
    private healthCheckInterval?: NodeJS.Timeout;

    private constructor() {
        // Start health check interval
        this.healthCheckInterval = setInterval(() => this.checkBrowserHealth(), 60000);
    }

    static getInstance(): BrowserPool {
        if (!BrowserPool.instance) {
            BrowserPool.instance = new BrowserPool();
        }
        return BrowserPool.instance;
    }

    async getBrowser(): Promise<Browser> {
        try {
            // Remove any unhealthy browsers
            await this.checkBrowserHealth();

            if (this.browsers.length < this.maxBrowsers) {
                const browser = await puppeteer.launch({
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                });
                this.browsers.push({ browser, lastUsed: Date.now() });
                return browser;
            }

            // Get least recently used browser
            const leastRecentlyUsed = this.browsers.reduce((prev, curr) => 
                prev.lastUsed < curr.lastUsed ? prev : curr
            );
            leastRecentlyUsed.lastUsed = Date.now();
            return leastRecentlyUsed.browser;
        } catch (error) {
            console.error('Browser launch failed:', error);
            throw new ScrapingError(
                `Failed to launch browser: ${error.message}`,
                'browser-pool',
                'puppeteer'
            );
        }
    }

    private async checkBrowserHealth(): Promise<void> {
        const unhealthyBrowsers = [];
        for (const [index, { browser }] of this.browsers.entries()) {
            try {
                await browser.pages(); // Simple health check
            } catch (error) {
                unhealthyBrowsers.push(index);
            }
        }

        // Remove unhealthy browsers in reverse order
        for (const index of unhealthyBrowsers.reverse()) {
            try {
                await this.browsers[index].browser.close();
            } catch (error) {
                console.error('Error closing unhealthy browser:', error);
            }
            this.browsers.splice(index, 1);
        }
    }

    async cleanup(): Promise<void> {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        await Promise.all(this.browsers.map(({ browser }) => browser.close()));
        this.browsers = [];
    }
}

const browserPool = BrowserPool.getInstance();

// Enhanced content validation
export function isContentMeaningful(content: string): boolean {
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return false;
    }

    const words = content.split(/\s+/);
    const wordCount = words.length;
    if (wordCount === 0) return false;

    const sentenceCount = content.split(/[.!?]+/).length;
    const averageWordLength = content.length / wordCount;

    const hasBlockedPhrases = [
        '404',
        'Access Denied',
        'Please enable JavaScript',
        'Robot Check',
        'Captcha',
    ].some(phrase => content.includes(phrase));

    return (
        wordCount >= MIN_CONTENT_LENGTH &&
        sentenceCount >= MIN_SENTENCES &&
        averageWordLength >= MIN_WORD_LENGTH &&
        !hasBlockedPhrases
    );
}

// Enhanced Cheerio scraping with deduplication
export async function scrapeWithCheerio(html: string): Promise<string> {
    const $ = cheerio.load(html);

    // Remove unwanted elements
    $(
        'script, style, nav, footer, header, .ads, #cookie-notice, ' +
        '.cookie-banner, .social-share, .comments, .related-posts, .sidebar, ' +
        'iframe, noscript, [style*="display: none"], [hidden]'
    ).remove();

    const contentSelectors = [
        'article',
        'main',
        '.content',
        '#content',
        '.post-content',
        '[role="main"]',
        '.article-body',
        '.entry-content',
        'p',
    ];

    // Collect unique content
    const uniqueContent = new Set<string>();
    contentSelectors.forEach(selector => {
        $(selector).each((_, element) => {
            const text = $(element).text().trim();
            if (text.length > 50) {
                uniqueContent.add(text);
            }
        });
    });

    return Array.from(uniqueContent).join('\n\n');
}

// Enhanced Puppeteer scraping
export async function scrapeWithPuppeteer(url: string): Promise<string> {
    const browser = await browserPool.getBrowser();
    const page = await browser.newPage();

    try {
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': url,
        });

        // Set additional options for better reliability
        await page.setDefaultNavigationTimeout(SCRAPING_TIMEOUT);
        await page.setRequestInterception(true);
        
        // Block unnecessary resources
        page.on('request', request => {
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: SCRAPING_TIMEOUT,
        });

        const content = await page.evaluate(() => {
            // Remove unwanted elements
            document.querySelectorAll(
                'script, style, nav, footer, header, .ads, ' +
                '#cookie-notice, .cookie-banner, .social-share, ' +
                '.comments, .related-posts, .sidebar, iframe, ' +
                'noscript, [style*="display: none"], [hidden]'
            ).forEach(el => el.remove());

            const selectors = [
                'article',
                'main',
                '.content',
                '#content',
                '.post-content',
                '[role="main"]',
                '.article-body',
                '.entry-content',
            ];

            // Try main content selectors first
            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element?.textContent) {
                    return element.textContent.trim();
                }
            }

            // Fallback to paragraphs if no main content found
            const paragraphs = Array.from(document.querySelectorAll('p'))
                .map(p => p.textContent?.trim() || '')
                .filter(text => text && text.length > 50);

            return paragraphs.join('\n\n');
        });

        return content;
    } finally {
        await page.removeAllListeners();
        await page.close();
    }
}
// Main scraping function with enhanced caching and metrics
export async function scrapeWebContent(url: string): Promise<ScrapingResult> {
    console.log(`\n=== Starting Web Scraping for ${url} ===`);
    const metrics: ScrapingMetrics = {
        startTime: performance.now(),
        success: false,
        method: 'cheerio',
        totalTime: 0,
    };

    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        return {
            content: '',
            title: 'Invalid URL',
            success: false,
            error: 'Invalid URL provided',
            url,
            timestamp: new Date().toISOString(),
            metrics,
        };
    }

    const cacheKey = `scrape:${createHash('sha256').update(url).digest('hex')}`;
    
    try {
        // Check cache first
        const cachedContent = await getCachedContent(cacheKey);
        if (cachedContent) {
            console.log(`Cache hit for URL: ${url}`);
            metrics.method = 'cache';
            metrics.totalTime = performance.now() - metrics.startTime;
            return { ...cachedContent, metrics };
        }

        // Try Cheerio first
        console.log('Attempting static scraping with Cheerio...');
        metrics.cheerioAttemptTime = performance.now();
        const response = await fetch(url);
        const html = await response.text();
        const content = await scrapeWithCheerio(html);

        if (isContentMeaningful(content)) {
            console.log('Successfully extracted content with Cheerio');
            metrics.success = true;
            metrics.totalTime = performance.now() - metrics.startTime;

            const result: ScrapingResult = {
                content,
                title: content.split('\n')[0]?.trim() || 'Untitled Content',
                success: true,
                url,
                timestamp: new Date().toISOString(),
                scrapeMethod: 'cheerio',
                metrics,
                contentStats: {
                    wordCount: content.split(/\s+/).length,
                    characterCount: content.length,
                    paragraphCount: content.split('\n\n').length,
                    averageWordLength: content.length / content.split(/\s+/).length,
                },
            };

            await setCachedContent(cacheKey, result);
            return result;
        }

        // Try Puppeteer if Cheerio fails
        console.log('Static scraping insufficient, attempting Puppeteer...');
        metrics.method = 'puppeteer';
        metrics.puppeteerAttemptTime = performance.now();
        
        const dynamicContent = await scrapeWithPuppeteer(url);

        if (isContentMeaningful(dynamicContent)) {
            console.log('Successfully extracted content with Puppeteer');
            metrics.success = true;
            metrics.totalTime = performance.now() - metrics.startTime;

            const result: ScrapingResult = {
                content: dynamicContent,
                title: dynamicContent.split('\n')[0]?.trim() || 'Untitled Content',
                success: true,
                url,
                timestamp: new Date().toISOString(),
                scrapeMethod: 'puppeteer',
                metrics,
                contentStats: {
                    wordCount: dynamicContent.split(/\s+/).length,
                    characterCount: dynamicContent.length,
                    paragraphCount: dynamicContent.split('\n\n').length,
                    averageWordLength: dynamicContent.length / dynamicContent.split(/\s+/).length,
                },
            };

            await setCachedContent(cacheKey, result);
            return result;
        }

        console.log('Failed to extract meaningful content with both methods');
        metrics.totalTime = performance.now() - metrics.startTime;
        
        return {
            content: '',
            title: 'Failed to extract meaningful content',
            success: false,
            error: 'Content validation failed',
            url,
            timestamp: new Date().toISOString(),
            metrics,
        };
    } catch (error) {
        console.error(`Scraping failed for ${url}:`, error);
        metrics.totalTime = performance.now() - metrics.startTime;
        
        return {
            content: '',
            title: 'Scraping Failed',
            success: false,
            error: error instanceof Error ? error.message : String(error),
            url,
            timestamp: new Date().toISOString(),
            metrics,
        };
    }
}