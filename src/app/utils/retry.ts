export const MAX_RETRIES = 3;
export const RETRY_DELAY = 1000;

export async function withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
  ): Promise<T> {
    let lastError: Error | null = null;
  
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
  
        if (error?.message.includes('429 Too Many Requests')) {
          console.error(`Rate limit hit. Retrying in ${delay * attempt}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay * attempt));
        } else {
          break; // Exit on non-rate-limiting errors
        }
      }
    }
  
    throw lastError; // Throw the last encountered error
  }
  
  