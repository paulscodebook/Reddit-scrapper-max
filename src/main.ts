import { Actor } from 'apify';
import { log, sleep } from 'crawlee';
import axios from 'axios';
import OpenAI from 'openai';

// --- Types ---
interface InputSchema {
    modes: string[];
    subreddits: string[];
    keywords: string[];
    intentPhrases: string[];
    timeWindow: 'last_24h' | 'last_7d' | 'last_30d' | 'all_available';
    maxItems: number;
    includeComments: boolean;
    minScore: number;
    aiAnalysis: boolean;
    openAiApiKey: string;
    language: string;
    dryRun: boolean;
}

interface NormalizedPost {
    id: string;
    title: string;
    selfText: string;
    url: string;
    subreddit: string;
    author: string;
    createdUtc: number;
    score: number;
    numComments: number;
    upvoteRatio: number;
    flair: string | null;
    isNsfw: boolean;
    locked: boolean;
    permalink: string;
    comments: NormalizedComment[];
}

interface NormalizedComment {
    id: string;
    body: string;
    author: string;
    createdUtc: number;
    score: number;
    parentId: string;
    depth: number;
    permalink: string;
}

// --- Helpers ---
const delay = (ms: number) => sleep(ms);

function cleanText(text: string): string {
    if (!text) return '';
    return text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Basic language detection heuristic. Very crude, but satisfies the requirement.
 * In a real-world scenario we migt use `franc` or `cld3`.
 */
function isTargetLanguage(text: string, lang: string): boolean {
    if (!lang) return true; // no filter
    // For English, a quick heuristic is checking common English stop words.
    // If language is not English, we just bypass for simplicity in this demo.
    if (lang.toLowerCase() === 'en') {
        const engMatches = text.match(/\b(the|and|is|in|it|you|that|to|for|on|with|as)\b/gi);
        // if absolutely no standard english word is found in a long enough text, maybe not english.
        if (text.length > 50 && (!engMatches || engMatches.length === 0)) {
            return false;
        }
    }
    return true;
}

function getTimeFilter(tw: InputSchema['timeWindow']): string {
    switch (tw) {
        case 'last_24h': return 'day';
        case 'last_7d': return 'week';
        case 'last_30d': return 'month';
        case 'all_available': return 'all';
        default: return 'all';
    }
}

// --- Reddit API Fetching ---
async function fetchRedditUrl(url: string, retries = 3): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': 'ApifyActor/1.0 (RedditScraperMax)'
                },
                timeout: 10000
            });
            return res.data;
        } catch (error: any) {
            if (error.response?.status === 429) {
                log.warning('Rate limited by Reddit. Sleeping for 10 seconds...');
                await delay(10000);
            } else {
                log.error(`Request failed: ${url} - ${error.message}`);
                if (i === retries - 1) throw error;
                await delay(2000 * (i + 1));
            }
        }
    }
}

async function fetchPosts(
    subreddit: string,
    input: InputSchema
): Promise<NormalizedPost[]> {
    let posts: NormalizedPost[] = [];
    let after = null;
    let urlBase = '';
    
    const t = getTimeFilter(input.timeWindow);

    if (input.keywords && input.keywords.length > 0) {
        const query = encodeURIComponent(input.keywords.join(' OR '));
        urlBase = `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&restrict_sr=1&sort=top&t=${t}&limit=100`;
    } else {
        urlBase = `https://www.reddit.com/r/${subreddit}/top.json?t=${t}&limit=100`;
    }

    while (posts.length < input.maxItems) {
        const url = `${urlBase}${after ? `&after=${after}` : ''}`;
        log.info(`Fetching posts from r/${subreddit}...`);
        
        const data = await fetchRedditUrl(url);
        const children = data?.data?.children;
        if (!children || children.length === 0) break;

        for (const child of children) {
            if (posts.length >= input.maxItems) break;

            const d = child.data;
            if (input.minScore > 0 && d.score < input.minScore) continue;
            
            const fullText = `${d.title} ${d.selftext}`;
            if (input.language && !isTargetLanguage(fullText, input.language)) continue;

            posts.push({
                id: d.id,
                title: d.title || '',
                selfText: d.selftext || '',
                url: d.url,
                subreddit: d.subreddit,
                author: d.author,
                createdUtc: d.created_utc,
                score: d.score,
                numComments: d.num_comments,
                upvoteRatio: d.upvote_ratio,
                flair: d.link_flair_text || null,
                isNsfw: d.over_18 || false,
                locked: d.locked || false,
                permalink: `https://www.reddit.com${d.permalink}`,
                comments: []
            });
        }

        after = data.data.after;
        if (!after) break;
        await delay(1500); // respect rate limits
    }
    
    return posts;
}

async function fetchComments(post: NormalizedPost, input: InputSchema) {
    const url = `${post.permalink}.json?limit=50&depth=2`;
    log.info(`Fetching comments for post ${post.id}`);
    
    try {
        const data = await fetchRedditUrl(url);
        const commentsData = data[1]?.data?.children || [];
        
        for (const child of commentsData) {
            if (child.kind === 't1') {
                const d = child.data;
                post.comments.push({
                    id: d.id,
                    body: d.body || '',
                    author: d.author,
                    createdUtc: d.created_utc,
                    score: d.score,
                    parentId: d.parent_id,
                    depth: d.depth,
                    permalink: `https://www.reddit.com${d.permalink}`
                });
            }
        }
    } catch (e) {
        log.warning(`Could not fetch comments for ${post.id}`);
    }
    
    await delay(1000); // respect rate limits
}


// --- LLM / Heuristics ---

function extractInsightsHeuristic(post: NormalizedPost, input: InputSchema): any {
    const text = (post.title + " " + post.selfText).toLowerCase();
    
    let intent = "other";
    const painWords = ['hate', 'frustrated', 'annoying', 'sucks', 'terrible', 'worst', 'issue', 'bug', 'pain'];
    const hasPain = painWords.some(w => text.includes(w));
    const hasIntent = input.intentPhrases.some(p => text.toLowerCase().includes(p.toLowerCase()));
    
    if (hasIntent) intent = "recommendation_request";
    else if (hasPain) intent = "pain_point";
    else if (text.includes("?")) intent = "question";

    let leadScore = hasIntent ? 0.8 : (hasPain ? 0.5 : 0.1);
    let urgencyScore = hasPain ? 0.8 : 0.3;

    return {
        postId: post.id,
        subreddit: post.subreddit,
        permalink: post.permalink,
        summary: cleanText(post.title), // naive summary
        intent,
        painPoints: hasPain ? ["Potential user friction or problem detected."] : [],
        leadRelevanceScore: leadScore,
        urgencyScore: urgencyScore,
        topicTags: [],
        rawPostRef: post.id
    };
}

async function extractInsightsLLM(post: NormalizedPost, input: InputSchema, openai: OpenAI): Promise<any> {
    const contextComments = post.comments.slice(0, 3).map(c => `Comment: ${c.body}`).join('\n');
    const prompt = `Analyze this Reddit post and comments for B2B/SaaS insights.
Title: ${post.title}
Body: ${post.selfText.slice(0, 1000)}
${contextComments}

Respond with purely a JSON object with these exactly named keys:
{
  "summary": "short summary",
  "intent": "one of: [pain_point, question, recommendation_request, comparison, success_story, other]",
  "painPoints": ["list", "of", "sentences"],
  "leadRelevanceScore": 0.0 to 1.0 float,
  "urgencyScore": 0.0 to 1.0 float,
  "topicTags": ["tag1", "tag2"]
}
`;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0.2
        });
        
        const resultText = response.choices[0].message.content || "{}";
        const parsed = JSON.parse(resultText);

        return {
            postId: post.id,
            subreddit: post.subreddit,
            permalink: post.permalink,
            summary: parsed.summary || post.title,
            intent: parsed.intent || "other",
            painPoints: parsed.painPoints || [],
            leadRelevanceScore: parsed.leadRelevanceScore || 0,
            urgencyScore: parsed.urgencyScore || 0,
            topicTags: parsed.topicTags || [],
            rawPostRef: post.id
        };
    } catch (err: any) {
        log.error(`LLM error for post ${post.id}: ${err.message}`);
        return extractInsightsHeuristic(post, input);
    }
}


// --- Main Actor Logc ---

Actor.main(async () => {
    const input = await Actor.getInput<InputSchema>();
    if (!input) throw new Error('Missing input');
    
    if (!input.subreddits || input.subreddits.length === 0) {
        throw new Error('At least one subreddit must be provided.');
    }

    const modes = input.modes && input.modes.length > 0 ? input.modes : ["pain_point_radar", "rag_export"];
    const doInsights = input.aiAnalysis && (modes.includes("pain_point_radar") || modes.includes("lead_gen"));
    const doRag = modes.includes("rag_export");

    let openai: OpenAI | null = null;
    if (doInsights && input.openAiApiKey) {
        openai = new OpenAI({ apiKey: input.openAiApiKey });
    }

    let insightsDataset = null;
    let ragDataset = null;

    if (!input.dryRun) {
        if (doInsights) insightsDataset = await Actor.openDataset('insights');
        if (doRag) ragDataset = await Actor.openDataset('rag');
    }

    for (const sub of input.subreddits) {
        const cleanSub = sub.replace(/^r\//, '');
        const posts = await fetchPosts(cleanSub, input);
        log.info(`Fetched ${posts.length} posts from r/${cleanSub}.`);

        for (const post of posts) {
            if (input.includeComments) {
                await fetchComments(post, input);
            }

            // 1. Raw Data Push
            if (!input.dryRun) {
                await Actor.pushData(post);
            }
            
            // 2. Insights Layer
            if (doInsights) {
                let insightObj;
                if (openai) {
                    insightObj = await extractInsightsLLM(post, input, openai);
                } else {
                    insightObj = extractInsightsHeuristic(post, input);
                }
                if (!input.dryRun && insightsDataset) {
                    await insightsDataset.pushData(insightObj);
                }
            }

            // 3. RAG Documents Layer
            if (doRag) {
                const docText = `Title: ${post.title}\nBody: ${post.selfText}\n${post.comments.slice(0, 5).map(c => `Comment: ${c.body}`).join('\n')}`;
                
                const ragItem = {
                    id: `post_${post.id}`,
                    text: cleanText(docText),
                    metadata: {
                        subreddit: post.subreddit,
                        postId: post.id,
                        permalink: post.permalink,
                        author: post.author,
                        createdAt: new Date(post.createdUtc * 1000).toISOString(),
                        score: post.score,
                        upvoteRatio: post.upvoteRatio,
                        numComments: post.numComments,
                        mode: post.comments.length > 0 ? "post+comments" : "post"
                    }
                };
                
                if (!input.dryRun && ragDataset) {
                    await ragDataset.pushData(ragItem);
                }
                
                // Optional: Fine-grained comment chunks
                if (post.comments.length > 0) {
                    for (const c of post.comments) {
                        const commentRagItem = {
                            id: `comment_${c.id}`,
                            text: cleanText(c.body),
                            metadata: {
                                subreddit: post.subreddit,
                                postId: post.id,
                                commentId: c.id,
                                permalink: c.permalink,
                                author: c.author,
                                createdAt: new Date(c.createdUtc * 1000).toISOString(),
                                score: c.score,
                                mode: "comment"
                            }
                        };
                        if (!input.dryRun && ragDataset) {
                            await ragDataset.pushData(commentRagItem);
                        }
                    }
                }
            }
        }
        log.info(`Finished processing r/${cleanSub}.`);
    }
    
    log.info('Actor run finished successfully.');
});
