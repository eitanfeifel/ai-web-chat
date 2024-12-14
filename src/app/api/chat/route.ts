import { NextResponse } from 'next/server';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';
import {
  analyzeQueryIntent,
  generateProgressiveResponse,
  createEnhancedPrompt
} from '@/app/utils/GeminiClient';
import { googleSearch, gatherInformation, validateScrapingResults } from '@/app/utils/search';
import { processContentForAI } from '@/app/utils/contentProcessor';
import { getChatHistory, storeChat } from '@/app/utils/cache';

dotenv.config();
export const redis = Redis.fromEnv();

const MAX_SCRAPING_RESULTS = 5;
const MAX_SEARCH_RESULTS = 5;

export async function POST(req: Request) {
  const metrics = {
    startTime: performance.now(),
    analysisTime: 0,
    scrapingTime: 0,
    processingTime: 0,
    responseTime: 0,
    totalTime: 0,
  };

  try {
    const body = await req.json();
    const { message, conversationId } = body;

    if (!conversationId) {
      return NextResponse.json(
        { success: false, message: 'Conversation ID is required' },
        { status: 400 }
      );
    }

    // Fetch chat history
    const chatHistory = (await getChatHistory(conversationId)) || [];
    console.log('Chat history:', chatHistory);

    // Step 1: Analyze the query
    const analysisStartTime = performance.now();
    const queryAnalysis = await analyzeQueryIntent(message, chatHistory); // Pass chat history here
    metrics.analysisTime = performance.now() - analysisStartTime;

    let searchUrls = queryAnalysis.extractedUrls || [];
    let scrapingResults = [];

    console.log('analysis: ', queryAnalysis);

    // Step 2: Content Gathering
    if (searchUrls.length > 0) {
      console.log('Processing user-provided URLs:', searchUrls);
      const gatheredInfo = await gatherInformation(message, conversationId, searchUrls);

      console.log('gatheredinfo: ', gatheredInfo);

      scrapingResults = validateScrapingResults(gatheredInfo.scrapingResults);

      console.log('Scraping Results:', scrapingResults);
      console.log('Type of Scraping Results:', Array.isArray(scrapingResults));
    } else if (queryAnalysis.needsSearch) {
      console.log('Performing search for:', queryAnalysis.searchQuery || message);

      const searchResults = await googleSearch(queryAnalysis.searchQuery || message, MAX_SEARCH_RESULTS);
      if (!searchResults || searchResults.length === 0) {
        console.warn('No search results found. Falling back to direct response.');
      }

      searchUrls = searchResults.map((result) => result.url);
      if (searchUrls.length > 0) {
        console.log('Processing search result URLs:', searchUrls);
        const gatheredInfo = await gatherInformation(message, conversationId, searchUrls);
        scrapingResults = validateScrapingResults(gatheredInfo.scrapingResults);
      }
    }

    // Limit the number of scraping results processed
    scrapingResults = scrapingResults.slice(0, MAX_SCRAPING_RESULTS);
    metrics.scrapingTime = performance.now() - analysisStartTime;

    // Step 3: Content Processing and Prompt Creation
    const processingStartTime = performance.now();
    let enhancedPrompt: string;

    if (scrapingResults.length > 0) {
      const processedContent = processContentForAI(scrapingResults);
      console.log('Content processing complete:', {
        resultCount: scrapingResults.length,
        processedLength: processedContent.content.length,
      });

      enhancedPrompt = createEnhancedPrompt({
        query: message,
        context: processedContent.content,
        reasoning: queryAnalysis.reasoning,
        isCasual: queryAnalysis.isCasual,
      });
    } else {
      console.log('No valid content gathered. Creating a fallback prompt.');
      enhancedPrompt = createEnhancedPrompt({
        query: message,
        context: '',
        reasoning: queryAnalysis.reasoning,
        isCasual: queryAnalysis.isCasual,
      });
    }

    metrics.processingTime = performance.now() - processingStartTime;

    // Step 4: Generate AI Response
    const responseStartTime = performance.now();
    const aiResponse = await generateProgressiveResponse(
      enhancedPrompt,
      conversationId
    );
    metrics.responseTime = performance.now() - responseStartTime;
    metrics.totalTime = performance.now() - metrics.startTime;

    // Step 5: Store conversation history
    await storeChat(conversationId, message, aiResponse);

    // Step 6: Return the response
    return NextResponse.json({
      success: true,
      aiResponse,
      metrics,
      context: scrapingResults.length > 0
        ? {
            scrapingResults: scrapingResults.map((result) => ({
              url: result.url,
              title: result.title,
              contentPreview: result.content.substring(0, 100) + '...',
              scrapeMethod: result.scrapeMethod,
            })),
            analysis: queryAnalysis,
          }
        : null,
    });
  } catch (error) {
    console.error('Request processing error:', error);

    return NextResponse.json(
      {
        success: false,
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error',
        stack:
          process.env.NODE_ENV === 'development'
            ? error instanceof Error
              ? error.stack
              : undefined
            : undefined,
      },
      { status: 500 }
    );
  }
}
