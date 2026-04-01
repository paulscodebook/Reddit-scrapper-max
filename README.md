# Reddit Scraper Max

**Reddit Scraper Max** is an AI-powered Reddit insights and RAG-ready data pipeline designed for founders, researchers, and automation builders.

## What it does
Reddit Scraper Max safely scrapes Reddit via public JSON endpoints and fetches posts along with their comments. It bypasses HTML scraping and natively formats the extracted information. It then optionally enriches the content using OpenAI's GPT models (or falls back to lightweight heuristics) to generate "insights"—such as summaries, intent classification, and lead relevance scoring. In addition, it can export formatted data to a structure perfect for Retrieval-Augmented Generation (RAG) and Semantic Search vector databases via JSONL format.

## Use Cases
- **Indie SaaS Founders**: Monitor subreddits for user pain points, complaints, or lead generation (e.g., users asking for alternative products).
- **Product Teams**: Discover requested features, summarize sentiment, and aggregate product feedback straight from your target communities.
- **ML/RAG Builders**: Quickly build clean, deterministic text chunk pipelines for fine-tuning LLMs or performing Semantic Search, bypassing data cleaning hurdles.

## Output Datasets
Depending on your selected `modes`, the Actor outputs to up to three logically separated datasets:
1. **Default Dataset (Raw)**: Unmodified plain items straight from Reddit (with basic structured normalization for posts and comments).
2. **"insights" Dataset**: AI-analyzed items containing a short summary, intent classification, pain points list, lead relevance score, urgency score, and topic tags.
3. **"rag" Dataset**: RAG-ready documents containing chunked data (title + text + top comments) with complete metadata, easily exportable as JSONL.

## Quick Start Example Input

```json
{
  "modes": ["pain_point_radar", "rag_export"],
  "subreddits": ["SaaS", "Entrepreneur"],
  "keywords": ["CRM", "email marketing"],
  "timeWindow": "last_7d",
  "maxItems": 100,
  "includeComments": true,
  "aiAnalysis": true,
  "openAiApiKey": "sk-proj-YOUR-KEY-HERE"
}
```

> **Note:** Providing an `openAiApiKey` provides the best possible "insights" by using cutting-edge LLMs. If omitted while AI Analysis is toggled on, it will fall back to using simpler rule-based keyword heuristics.
