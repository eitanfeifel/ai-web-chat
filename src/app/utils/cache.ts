import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { ScrapingResult } from './scrape';

// Configuration
const CACHE_DURATION = 3600; // 1 hour in seconds
const CACHE_PREFIX = 'cache:';
export const SCRAPE_CACHE_PREFIX = `${CACHE_PREFIX}scrape:`;
export const AI_CACHE_PREFIX = `${CACHE_PREFIX}ai:`;
export const CHAT_HISTORY_PREFIX = `${CACHE_PREFIX}chat:`;

// Type definitions for better type safety
interface ChatEntry {
    userMessage: string;
    aiResponse: string;
    timestamp: string;
}

// Initialize Redis
export const redis = Redis.fromEnv();

// Error logging utility with more detailed error information
function logError(context: string, error: unknown) {
    const errorMessage = error instanceof Error ? 
        `${error.message}\n${error.stack}` : 
        String(error);
    console.error(`[Cache Error - ${context}]:`, errorMessage);
}

// Create a cache key with a hash
export function createCacheKey(content: string, prefix: string, conversationId: string): string {
    if (!content || !prefix || !conversationId) {
        throw new Error('Content, prefix, and conversationId must be provided to create a cache key.');
    }
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `${prefix}${conversationId}:${hash}`;
}

// Enhanced type-safe cache retrieval
export async function getCachedContent<T>(key: string): Promise<T | null> {
    try {
        const cachedData = await redis.get(key);
        
        if (!cachedData) {
            return null;
        }

        // Handle case where Redis returns already parsed data
        if (typeof cachedData === 'object') {
            return cachedData as T;
        }

        try {
            // Attempt to parse the cached string data
            return JSON.parse(cachedData) as T;
        } catch (parseError) {
            logError('JSON Parse', parseError);
            return null;
        }
    } catch (error) {
        logError('getCachedContent', error);
        return null;
    }
}

// Enhanced type-safe cache storage
export async function setCachedContent<T>(key: string, content: T): Promise<void> {
    try {
        // Handle null or undefined content
        if (content === null || content === undefined) {
            throw new Error('Cannot cache null or undefined content');
        }

        // Special handling for ScrapingResult to ensure proper serialization
        if (typeof content === 'object' && 'content' in content && 'success' in content) {
            const serializedContent = JSON.stringify(content, (key, value) => {
                // Handle special cases of data that might not serialize well
                if (value instanceof RegExp) return value.toString();
                if (value instanceof Error) return value.message;
                return value;
            });
            await redis.set(key, serializedContent, { ex: CACHE_DURATION });
            return;
        }

        // Regular content serialization
        const serializedContent = JSON.stringify(content);
        await redis.set(key, serializedContent, { ex: CACHE_DURATION });
    } catch (error) {
        logError('setCachedContent', error);
    }
}

// Enhanced chat history storage with better error handling
export async function storeChat(conversationId: string, userMessage: string, aiResponse: string) {
    const chatEntry: ChatEntry = {
        userMessage,
        aiResponse,
        timestamp: new Date().toISOString(),
    };

    try {
        // Serialize the chat entry
        const serializedEntry = JSON.stringify(chatEntry);
        
        // Store in Redis with proper error handling
        await redis.lpush(`${CHAT_HISTORY_PREFIX}${conversationId}`, serializedEntry);
        await redis.ltrim(`${CHAT_HISTORY_PREFIX}${conversationId}`, 0, 49);
    } catch (error) {
        logError('storeChat', error);
        throw new Error('Failed to store chat history');
    }
}

// Enhanced chat history retrieval with proper typing
export async function getChatHistory(conversationId: string, limit: number = 5): Promise<ChatEntry[]> {
    try {
        const rawHistory = await redis.lrange(`${CHAT_HISTORY_PREFIX}${conversationId}`, 0, limit - 1);
        
        return rawHistory.map((entry) => {
            try {
                return JSON.parse(entry) as ChatEntry;
            } catch (parseError) {
                logError('ChatEntry Parse', parseError);
                return null;
            }
        }).filter((entry): entry is ChatEntry => entry !== null);
    } catch (error) {
        logError('getChatHistory', error);
        return [];
    }
}