//============================
//  Configuration and Setup
//============================

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { scrapeWebContent } from '@/app/utils/scrape';
import { getCachedContent, setCachedContent, SCRAPE_CACHE_PREFIX } from '@/app/utils/cache';

dotenv.config();

//=============================
//   Interfaces
//=============================

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  domain: string;
  searchScore: number;
}

interface ScrapingResult {
  content: string;
  title: string;
  success: boolean;
  error?: string;
  url?: string;
  timestamp?: string;
  scrapeMethod?: string;
  contentStats?: {
    wordCount: number;
    characterCount: number;
    paragraphCount: number;
  };
}

//===================
//   Google Search 
//===================

export async function googleSearch(query: string, numResults: number = 5): Promise<SearchResult[]> {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'your-hardcoded-api-key';
  const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID || 'your-hardcoded-search-engine-id';

  if (!GOOGLE_API_KEY || !SEARCH_ENGINE_ID) {
    console.error('Missing API Key or Search Engine ID. Check your .env file or hardcoded values.');
    return [];
  }

  try {
    console.log('\n=== Starting Google Search ===');
    console.log('Search query:', query);

    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=${numResults}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data: any = await response.json();

    if (data.items && data.items.length > 0) {
      return data.items.map((item: any) => {
        const domain = new URL(item.link).hostname;
        let authorityScore = 0.5;

        if (domain.endsWith('.gov')) authorityScore = 1.0;
        else if (domain.endsWith('.edu')) authorityScore = 0.9;
        else if (domain.endsWith('.org')) authorityScore = 0.8;

        return {
          url: item.link,
          title: item.title,
          snippet: item.snippet,
          domain,
          searchScore: authorityScore,
        };
      });
    } else {
      console.log('No results returned. Check your query and search engine configuration.');
      return [];
    }
  } catch (error) {
    console.error('Error during Google Search:', error.message);
    return [];
  }
}

//==========================
//   Information Gathering
//==========================

export async function gatherInformation(
  query: string,
  conversationId: string,
  urls: string[]
): Promise<{ scrapingResults: ScrapingResult[] }> {
  console.log('\n=== Starting Information Gathering ===');

  if (!urls || urls.length === 0) {
    console.warn('No URLs provided for scraping. Exiting information gathering.');
    return { scrapingResults: [] };
  }

  const results: ScrapingResult[] = [];
  for (const url of urls) {
    const cacheKey = `${SCRAPE_CACHE_PREFIX}${url}`;
    const cachedResult = await getCachedContent(cacheKey);

    if (cachedResult) {
      console.log(`Cache hit for URL: ${url}`);
      results.push(cachedResult);
    } else {
      console.log(`Cache miss for URL: ${url}. Scraping...`);
      try {
        const scrapingResult = await scrapeWebContent(url);
        if (scrapingResult.success) {
          await setCachedContent(cacheKey, scrapingResult);
        }
        results.push(scrapingResult);
      } catch (error) {
        console.error(`Error scraping URL: ${url}`, error);
      }
    }
  }

  console.log('Information gathering complete.');
  return { scrapingResults: results };
}

// Validates the scraping results to ensure they are in the expected format
export function validateScrapingResults(results: any): ScrapingResult[] {
    if (!Array.isArray(results)) {
      console.error('Invalid scraping results: Expected an array.');
      return [];
    }
  
    // Filter out invalid results
    return results.filter((result) => {
      const isValid =
        result &&
        typeof result === 'object' &&
        typeof result.content === 'string' &&
        result.content.trim().length > 0;
  
      if (!isValid) {
        console.warn('Filtered out invalid scraping result:', result);
      }
  
      return isValid;
    });
  }
  
