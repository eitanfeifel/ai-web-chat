import { GoogleGenerativeAI } from '@google/generative-ai';
import { googleSearch, gatherInformation, validateScrapingResults } from '@/app/utils/search';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MIN_CONFIDENCE_SCORE = 0.5;

export type QueryAnalysis = {
  isCasual: boolean;
  needsSearch: boolean;
  reasoning: string;
  suggestedApproach: string;
  searchQuery?: string;
  confidenceScore: number;
  extractedUrls?: string[];
  isFollowUp: boolean;
};

export async function analyzeQueryIntent(
    query: string,
    chatHistory: string[]
  ): Promise<QueryAnalysis> {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const extractedUrls = query.match(urlRegex) || [];
  
    if (extractedUrls.length > 0) {
      return {
        isCasual: false,
        needsSearch: false,
        reasoning: 'User provided URLs directly in the query. Prioritize scraping these URLs for context.',
        suggestedApproach: 'Scrape provided URLs to gather relevant information.',
        searchQuery: null,
        confidenceScore: 1.0,
        extractedUrls,
        isFollowUp: false,
      };
    }
  
    const chatHistoryContext = chatHistory
      .map((message, index) => `Message ${index + 1}: ${message}`)
      .join('\n');
  
    const analyzerPrompt = `
  Analyze the intent of the following user query in the context of the conversation:
  
  Query: "${query}"
  
  Conversation history:
  ${chatHistoryContext}
  
  Provide the following details in a numbered list format. Respond strictly in this format:
  1. Is the query casual? (true/false)
  2. Does the query require additional information from external sources? (true/false)
  3. Reasoning behind your analysis.
  4. Suggested approach for answering the query.
  5. Suggested search query (if applicable, otherwise "null").
  6. Specific content requirements (if applicable, otherwise "none").
  7. Is this query a follow-up to the previous messages? (true/false)
  `;
  
    try {
      const model = await genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(analyzerPrompt);
  
      const rawResponse = result.response.text();
      console.log('Raw LLM response:', rawResponse);
  
      const parsedList = parseListResponse(rawResponse);
      console.log('Parsed list:', parsedList);
  
      if (!parsedList) {
        throw new Error('Invalid LLM response format');
      }
  
      const [isCasual, needsSearch, reasoning, suggestedApproach, searchQuery, specificFocus, isFollowUp] = parsedList;
  
      return {
        isCasual: isCasual === 'true',
        needsSearch: needsSearch === 'true',
        reasoning,
        suggestedApproach,
        searchQuery: searchQuery === 'null' ? null : searchQuery.replace(/^["']|["']$/g, ''), // Remove quotes
        confidenceScore: 1.0,
        extractedUrls,
        isFollowUp: isFollowUp === 'true',
        contentRequirements: {
          needsFullText: false,
          needsFactChecking: false,
          needsMultipleSources: false,
          specificFocus: specificFocus === 'none' ? null : specificFocus,
        },
      };
    } catch (error) {
      console.error('Query analysis failed:', error);
      return createFallbackAnalysis(extractedUrls);
    }
  }
  


/**
 * Parses a list response from the LLM into an array.
 */
function parseListResponse(response: string): string[] | null {
  const listRegex = /^1\. (.+)\n2\. (.+)\n3\. (.+)\n4\. (.+)\n5\. (.+)\n6\. (.+)\n7\. (.+)$/s;
  const match = response.match(listRegex);

  return match ? match.slice(1).map(item => item.trim()) : null;
}

/**
 * Creates a fallback analysis in case of failure.
 */
function createFallbackAnalysis(extractedUrls: string[]): QueryAnalysis {
  return {
    isCasual: true,
    needsSearch: false,
    reasoning: 'Fallback due to analysis failure.',
    suggestedApproach: 'Respond conversationally.',
    confidenceScore: MIN_CONFIDENCE_SCORE,
    extractedUrls,
    isFollowUp: false,
    contentRequirements: {
      needsFullText: false,
      needsFactChecking: false,
      needsMultipleSources: false,
      specificFocus: null,
    },
  };
}

/**
 * Handles different types of query requests and creates the enhanced prompt.
 */
export async function handleQuery(query: string, conversationId: string, chatHistory: string[]): Promise<string> {
  const queryAnalysis = await analyzeQueryIntent(query, chatHistory);

  if (queryAnalysis.extractedUrls?.length > 0) {
    console.log('Processing user-provided URLs:', queryAnalysis.extractedUrls);
    const scrapingResults = await gatherInformation(query, conversationId, queryAnalysis.extractedUrls);
    const validatedResults = validateScrapingResults(scrapingResults);

    if (validatedResults.length > 0) {
      const context = validatedResults.map(result => result.content).join('\n\n');
      return createEnhancedPrompt({
        query,
        context,
        reasoning: queryAnalysis.reasoning,
        isCasual: queryAnalysis.isCasual,
      });
    }
  }

  if (queryAnalysis.needsSearch) {
    console.log('Performing search for:', queryAnalysis.searchQuery || query);
    const searchResults = await googleSearch(queryAnalysis.searchQuery || query, 3);
    const searchUrls = searchResults.map(result => result.url);
    const scrapingResults = await gatherInformation(query, conversationId, searchUrls);
    const validatedResults = validateScrapingResults(scrapingResults);

    if (validatedResults.length > 0) {
      const context = validatedResults.map(result => result.content).join('\n\n');
      return createEnhancedPrompt({
        query,
        context,
        reasoning: queryAnalysis.reasoning,
        isCasual: queryAnalysis.isCasual,
      });
    }
  }

  console.log('No valid context found. Generating a direct response.');
  return createEnhancedPrompt({
    query,
    context: '',
    reasoning: queryAnalysis.reasoning,
    isCasual: queryAnalysis.isCasual,
  });
}

/**
 * Create an enhanced prompt based on the query analysis.
 */
export function createEnhancedPrompt({ query, context, reasoning, isCasual }: {
  query: string;
  context: string;
  reasoning: string;
  isCasual: boolean;
}): string {
  return `
You are a knowledgeable assistant. Always provide a direct and complete response to the user's query. Avoid asking follow-up questions or requesting additional information. Respond concisely, accurately, and in a helpful tone.
Based on the context --- if there are any sources or links be sure to cite them in your responses! 
Do not however, refer directly to the context as 'the provided text' address the user's query directly, as if you collected the context, not as if they provided it.
${context ? `Context:\n${context}\n` : ''}

Query: "${query}"

Response:`;
}

/**
 * Generate a response progressively for better user experience.
 */
export async function generateProgressiveResponse(prompt: string, conversationId: string): Promise<string> {
  try {
    const response = await genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }).generateContent(prompt);
    return response.response.text().trim();
  } catch (error) {
    console.error('Error generating progressive response:', error);
    throw new Error('Failed to generate AI response');
  }
}

/**
 * Summarize content if it exceeds size limits.
 */
export async function summarizeContent(content: string): Promise<string> {
  const MAX_SUMMARY_LENGTH = 15000;

  try {
    const summaryPrompt = `
Summarize the following content. Avoid omitting important information:

${content}

Provide a concise and structured summary.`;
    const response = await genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }).generateContent(summaryPrompt);
    const summary = response.response.text().trim();

    return summary.length > MAX_SUMMARY_LENGTH
      ? summary.substring(0, MAX_SUMMARY_LENGTH) + '...'
      : summary;
  } catch (error) {
    console.error('Content summarization failed:', error);
    throw new Error('Summarization failed. Please refine your input.');
  }
}
