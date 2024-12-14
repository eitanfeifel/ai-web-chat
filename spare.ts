import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import crypto from 'crypto';

// Performance monitoring interface
interface PerformanceMetrics {
  totalTime: number;
  scrapingTime: number;
  analysisTime: number;
  aiResponseTime: number;
}

// Enhanced type definitions
interface ScrapingResult {
  content: string;
  title: string;
  success: boolean;
  error?: string;
  url?: string;
  timestamp?: string;
}

interface ChatEntry {
  userMessage: string;
  aiResponse: string;
  timestamp: string;
}

interface QueryAnalysis {
  needsSearch: boolean;
  reasoning: string;
  suggestedApproach: string;
  searchQuery?: string;
  confidenceScore: number;
}

// Configuration constants
const CACHE_DURATION = 3600;  // 1 hour in seconds
const CACHE_PREFIX = 'cache:';
const SCRAPE_CACHE_PREFIX = `${CACHE_PREFIX}scrape:`;
const AI_CACHE_PREFIX = `${CACHE_PREFIX}ai:`;
const CHAT_HISTORY_PREFIX = `${CACHE_PREFIX}chat:`;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const SCRAPING_TIMEOUT = 5000;
const MAX_WORKERS = 3;

// Browser pool management
class BrowserPool {
  private static instance: BrowserPool;
  private browsers: puppeteer.Browser[] = [];
  private maxBrowsers = MAX_WORKERS;

  private constructor() {}

  static getInstance(): BrowserPool {
    if (!BrowserPool.instance) {
      BrowserPool.instance = new BrowserPool();
    }
    return BrowserPool.instance;
  }

  async getBrowser(): Promise<puppeteer.Browser> {
    try {
      if (this.browsers.length < this.maxBrowsers) {
        const browser = await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        this.browsers.push(browser);
        return browser;
      }
      return this.browsers[Math.floor(Math.random() * this.browsers.length)];
    } catch (error) {
      console.error('Browser launch failed:', error);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.browsers.map(browser => browser.close()));
    this.browsers = [];
  }
}

// Initialize core services
const redis = Redis.fromEnv();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const browserPool = BrowserPool.getInstance();

// Configure rate limiting
const rateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '60 s'),
  prefix: 'ratelimit:ai-chat',
  analytics: true,
});

// Retry mechanism for async operations
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  delay: number = RETRY_DELAY
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }
  
  throw lastError;
}

// URL validation and extraction
function findUrls(message: string): URL[] {
  const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
  const matches = message.match(urlRegex);
  return matches 
    ? matches
        .map(url => {
          try {
            return new URL(url);
          } catch {
            return null;
          }
        })
        .filter((url): url is URL => url !== null)
    : [];
}

// Content validation
function isContentMeaningful(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  
  const wordCount = content.split(/\s+/).length;
  const sentenceCount = content.split(/[.!?]+/).length;
  const averageWordLength = content.length / wordCount;
  
  return (
    wordCount > 100 &&
    sentenceCount > 3 &&
    averageWordLength > 3 &&
    !content.includes('404') &&
    !content.includes('Access Denied') &&
    !content.includes('Please enable JavaScript')
  );
}

// Enhanced scraping with Cheerio
async function scrapeWithCheerio(html: string): Promise<string> {
  const $ = cheerio.load(html);
  
  $(
    'script, style, nav, footer, header, .ads, #cookie-notice, ' +
    '.cookie-banner, .social-share, .comments, .related-posts, .sidebar'
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
    'p'
  ];

  const content = contentSelectors
    .map(selector => $(selector).text().trim())
    .filter(text => text.length > 50)
    .join('\n\n');

  return content;
}

// Dynamic scraping with Puppeteer
async function scrapeWithPuppeteer(url: string): Promise<string> {
  const browser = await browserPool.getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    );
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: SCRAPING_TIMEOUT
    });

    const content = await page.evaluate(() => {
      document.querySelectorAll(
        'script, style, nav, footer, header, .ads, ' +
        '#cookie-notice, .cookie-banner, .social-share, ' +
        '.comments, .related-posts, .sidebar'
      ).forEach(el => el.remove());

      const selectors = [
        'article',
        'main',
        '.content',
        '#content',
        '.post-content',
        '[role="main"]',
        '.article-body',
        '.entry-content'
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element?.textContent) {
          return element.textContent.trim();
        }
      }

      const paragraphs = Array.from(document.querySelectorAll('p'))
        .map(p => p.textContent.trim())
        .filter(text => text && text.length > 50);

      return paragraphs.join('\n\n');
    });

    return content;
  } finally {
    await page.close();
  }
}

// Google search implementation
async function googleSearch(query: string, numResults: number = 3): Promise<string[]> {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;
  
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=${numResults}`;
    const response = await fetch(url);
    const data = await response.json();
    
    return data.items?.map(item => item.link) || [];
  } catch (error) {
    console.error('Google search failed:', error);
    return [];
  }
}

// Query analysis with error handling
async function analyzeQueryIntent(query: string): Promise<QueryAnalysis> {
  const analyzerPrompt = `As an AI assistant, analyze this query to determine the best approach for providing an accurate and helpful response.

Query: "${query}"

Consider:
1. Does this query require current or specific factual information?
2. Would external information significantly improve the answer?
3. Is this a conceptual, opinion-based, or general knowledge question?
4. What specific type of information would be most relevant?

Respond in JSON format:
{
  "needsSearch": boolean,
  "reasoning": "Brief explanation of your decision",
  "suggestedApproach": "Step-by-step plan for answering",
  "searchQuery": "Optimized search query if search is needed",
  "confidenceScore": number
}`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await model.generateContent(analyzerPrompt);
    const analysis = JSON.parse(result.response.text());
    
    if (!analysis.needsSearch || !analysis.reasoning || !analysis.suggestedApproach) {
      throw new Error('Invalid analyzer response format');
    }
    
    return analysis;
  } catch (error) {
    console.error('Query analysis failed:', error);
    return {
      needsSearch: true,
      reasoning: "Analysis failed, defaulting to search",
      suggestedApproach: "Perform search to ensure accuracy",
      confidenceScore: 0.5
    };
  }
}

// Cache management
function createCacheKey(content: string, prefix: string): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return `${prefix}${hash}`;
}

async function getCachedContent(key: string): Promise<any | null> {
  try {
    return await redis.get(key);
  } catch (error) {
    console.error('Cache retrieval error:', error);
    return null;
  }
}

async function setCachedContent(key: string, content: any): Promise<void> {
  try {
    await redis.set(key, content, { ex: CACHE_DURATION });
  } catch (error) {
    console.error('Cache storage error:', error);
  }
}

// Chat history management
async function storeChat(conversationId: string, userMessage: string, aiResponse: string) {
  const chatEntry = {
    userMessage,
    aiResponse,
    timestamp: new Date().toISOString(),
  };
  
  try {
    await redis.lpush(`${CHAT_HISTORY_PREFIX}${conversationId}`, chatEntry);
    await redis.ltrim(`${CHAT_HISTORY_PREFIX}${conversationId}`, 0, 49);
  } catch (error) {
    console.error('Failed to store chat history:', error);
  }
}

async function getChatHistory(conversationId: string, limit: number = 5): Promise<ChatEntry[]> {
  try {
    return await redis.lrange(`${CHAT_HISTORY_PREFIX}${conversationId}`, 0, limit - 1);
  } catch (error) {
    console.error('Error retrieving chat history:', error);
    return [];
  }
}

// Enhanced web scraping with improved error handling
async function scrapeWebContent(url: string): Promise<ScrapingResult> {
  const cacheKey = `${SCRAPE_CACHE_PREFIX}${url}`;
  
  try {
    const cachedContent = await getCachedContent(cacheKey);
    if (cachedContent) {
      console.log(`Cache hit for URL: ${url}`);
      return cachedContent;
    }
    
    const response = await fetch(url);
    const html = await response.text();
    let content = await scrapeWithCheerio(html);
    
    if (isContentMeaningful(content)) {
      const result: ScrapingResult = {
        content,
        title: content.split('\n')[0]?.trim() || 'Untitled Content',
        success: true,
        url,
        timestamp: new Date().toISOString()
      };
      await setCachedContent(cacheKey, result);
      return result;
    }
    
    content = await scrapeWithPuppeteer(url);
    
    if (isContentMeaningful(content)) {
      const result: ScrapingResult = {
        content,
        title: content.split('\n')[0]?.trim() || 'Untitled Content',
        success: true,
        url,
        timestamp: new Date().toISOString()
      };
      await setCachedContent(cacheKey, result);
      return result;
    }
    
    return {
      content: '',
      title: 'Failed to extract meaningful content',
      success: false,
      error: 'Content validation failed',
      url
    };
    
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error);
    return {
      content: '',
      title: 'Scraping Failed',
      success: false,
      error: error.message,
      url
    };
  }
}

// Information gathering with parallel processing
async function gatherInformation(query: string, conversationId: string, urls: string[]) {
    const metrics = {
      startTime: performance.now(),
      scrapingTime: 0,
      analysisTime: 0,
      totalTime: 0
    };
  
    const [chatHistoryPromise, scrapingPromise, analysisPromise] = await Promise.allSettled([
      getChatHistory(conversationId),
      
      // Scraping operation with worker pool
      (async () => {
        const scrapingStartTime = performance.now();
        if (urls.length === 0) return [];
        
        const workerPool = new Set();
        const results = [];
        
        for (let i = 0; i < urls.length; i += MAX_WORKERS) {
          const batch = urls.slice(i, i + MAX_WORKERS);
          const batchPromises = batch.map(url => {
            const worker = scrapeWebContent(url);
            workerPool.add(worker);
            return worker;
          });
          
          try {
            const batchResults = await Promise.race([
              Promise.all(batchPromises),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Batch timeout')), SCRAPING_TIMEOUT)
              )
            ]);
            
            results.push(...batchResults.filter(result => result.success));
          } catch (error) {
            console.error('Batch scraping failed:', error);
          } finally {
            batchPromises.forEach(worker => workerPool.delete(worker));
          }
        }
        
        metrics.scrapingTime = performance.now() - scrapingStartTime;
        return results;
      })(),
      
      // Query analysis with timing
      (async () => {
        const analysisStartTime = performance.now();
        const analysis = await analyzeQueryIntent(query);
        metrics.analysisTime = performance.now() - analysisStartTime;
        return analysis;
      })()
    ]);
  
    metrics.totalTime = performance.now() - metrics.startTime;
    console.log('Gathering information metrics:', metrics);
  
    return {
      chatHistory: chatHistoryPromise.status === 'fulfilled' ? chatHistoryPromise.value : [],
      scrapingResults: scrapingPromise.status === 'fulfilled' ? scrapingPromise.value : [],
      analysis: analysisPromise.status === 'fulfilled' ? analysisPromise.value : null,
      metrics
    };
  }
  
  // Enhanced prompt creation with improved context handling
  function createEnhancedPrompt(params: PromptParams): string {
    const { query, context, chatHistory, analysisReasoning, approach } = params;
  
    const historySection = chatHistory.length > 0
      ? `Previous conversation context:
  ${chatHistory.map(entry => `
  User: ${entry.userMessage}
  Assistant: ${entry.aiResponse}`).join('\n')}
  `
      : '';
  
    const contextSection = context
      ? `Relevant information:
  ${context}
  `
      : '';
  
    const analysisSection = analysisReasoning && approach
      ? `Analysis:
  Reasoning: ${analysisReasoning}
  Approach: ${approach}
  `
      : '';
  
    return `${historySection}
  ${contextSection}
  ${analysisSection}
  Current query: ${query}
  
  Please provide a response that:
  1. Maintains conversation continuity
  2. Directly addresses the current query
  3. Integrates relevant context when available
  4. Follows the suggested approach
  5. Maintains accuracy and clarity
  6. Cites sources when referencing specific information`;
  }
  
  // Response validation function
  function validateAIResponse(response: string): boolean {
    if (!response || typeof response !== 'string') return false;
    
    const invalidPatterns = [
      '[object Object]',
      'undefined',
      'null',
      'error',
      'Error:',
      'function',
      '<!DOCTYPE'
    ];
  
    return (
      response.length > 0 &&
      response.length < 100000 &&
      !invalidPatterns.some(pattern => response.includes(pattern))
    );
  }
  
  // Enhanced progressive response generation
  async function generateProgressiveResponse(prompt: string, conversationId: string): Promise<string> {
    const startTime = performance.now();
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    
    try {
      const result = await withRetry(async () => {
        const response = await model.generateContent(prompt);
        const text = response.response.text();
        
        if (!validateAIResponse(text)) {
          throw new Error('Invalid AI response generated');
        }
        
        return text;
      });
  
      console.log(`Response generation took ${performance.now() - startTime}ms`);
      return result;
    } catch (error) {
      console.error('Response generation failed:', error);
      throw error;
    }
  }
  
  // Main route handler
  export async function POST(req: Request) {
    const metrics = {
      startTime: performance.now(),
      analysisTime: 0,
      scrapingTime: 0,
      responseTime: 0,
      totalTime: 0
    };
  
    try {
      const { message, conversationId } = await req.json();
      
      // Rate limit check
      const { success: rateLimitSuccess } = await rateLimiter.limit(conversationId);
      if (!rateLimitSuccess) {
        return NextResponse.json({
          success: false,
          message: 'Rate limit exceeded. Please try again later.',
        }, { status: 429 });
      }
      
      // URL processing
      const urls = findUrls(message);
      let searchUrls: string[] = [];
      
      if (urls.length === 0) {
        const analysisStart = performance.now();
        const quickAnalysis = await analyzeQueryIntent(message);
        metrics.analysisTime = performance.now() - analysisStart;
        
        if (quickAnalysis.needsSearch && quickAnalysis.confidenceScore > 0.6) {
          searchUrls = await googleSearch(quickAnalysis.searchQuery || message);
        }
      }
      
      // Gather information
      const { chatHistory, scrapingResults, analysis, metrics: gatheringMetrics } = 
        await gatherInformation(message, conversationId, [...urls, ...searchUrls]);
      
      Object.assign(metrics, gatheringMetrics);
      
      // Generate response
      const responseStartTime = performance.now();
      const prompt = createEnhancedPrompt({
        query: message,
        context: scrapingResults
          .filter(result => result.success)
          .map(result => result.content)
          .join('\n\n'),
        chatHistory,
        analysisReasoning: analysis?.reasoning || '',
        approach: analysis?.suggestedApproach || ''
      });
      
      const aiResponse = await generateProgressiveResponse(prompt, conversationId);
      metrics.responseTime = performance.now() - responseStartTime;
      
      // Asynchronously store chat history
      storeChat(conversationId, message, aiResponse).catch(error => 
        console.error('Failed to store chat history:', error)
      );
      
      metrics.totalTime = performance.now() - metrics.startTime;
      console.log('Request processing metrics:', metrics);
      
      return NextResponse.json({
        success: true,
        aiResponse,
        metrics,
        context: scrapingResults.length > 0 ? {
          scrapingResults,
          analysis: analysis || undefined,
          summary: {
            totalUrls: urls.length + searchUrls.length,
            successfulScrapes: scrapingResults.filter(r => r.success).length,
            failedScrapes: scrapingResults.filter(r => !r.success).length,
          }
        } : null
      });
      
    } catch (error) {
      console.error('Request processing error:', error);
      return NextResponse.json({
        success: false,
        message: 'Internal server error',
        error: error.message,
      }, { status: 500 });
    } finally {
      // Cleanup resources
      try {
        await browserPool.cleanup();
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }
  }
  
  // Cleanup handlers
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Performing cleanup...');
    await browserPool.cleanup();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    console.log('SIGINT received. Performing cleanup...');
    await browserPool.cleanup();
    process.exit(0);
  });