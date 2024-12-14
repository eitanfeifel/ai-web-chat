# AI Answer Engine

An AI-powered answer generation and query analysis engine built to analyze user queries, classify intent, and provide accurate, concise, and actionable responses. This project leverages Google Generative AI and custom logic to create enhanced prompts and analyze complex queries.

---

## 🚀 Features

- **Query Classification**: Automatically identifies query type (e.g., summary, comparison, analysis, casual).
- **Customizable Responses**: Generates detailed or casual responses based on user intent.
- **Content Summarization**: Processes large chunks of text and summarizes key information.
- **Confidence Scoring**: Assigns confidence scores to analysis results.
- **Flexible Prompt Creation**: Creates detailed or casual prompts tailored to the query.
- **Error Handling**: Handles invalid AI responses and provides fallback mechanisms.

---

## 🛠️ Technology Stack

- **Languages**: TypeScript, JavaScript
- **AI Integration**: Google Generative AI (Gemini Model)
- **Utilities**: Custom retry logic, prompt enhancement
- **Version Control**: Git & GitHub

---
## 🧩 Usage

### Query Analysis:
- Input a query to classify its type (e.g., summary, fact-check).
- Generates the best approach for processing the query.

### Content Summarization:
- Input text to summarize into key points with a focus on brevity and accuracy.

### Error Handling:
- Provides meaningful fallback responses when AI results are invalid or incomplete.

---

## 📄 API Endpoints

### `POST /analyze`
Analyzes a query and returns its classification, confidence score, and suggestions.

#### Request Body:
```json
{
  "query": "What is the population density of New York City?",
  "context": "Detailed dataset or text context (optional)"
}


