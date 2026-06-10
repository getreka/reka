/**
 * Confluence Service - Fetch and index Atlassian Confluence documentation
 *
 * Required env vars:
 * - CONFLUENCE_URL: https://your-domain.atlassian.net
 * - CONFLUENCE_EMAIL: your-email@example.com
 * - CONFLUENCE_API_TOKEN: your-api-token (from id.atlassian.com)
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { vectorStore, VectorPoint } from './vector-store';
import { embeddingService } from './embedding';

export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  spaceName?: string;
  content: string;
  url: string;
  lastModified: string;
  version: number;
  ancestors?: { id: string; title: string }[];
  labels?: string[];
}

export interface ConfluenceSpace {
  key: string;
  name: string;
  type: string;
  status: string;
}

export interface IndexConfluenceOptions {
  projectName: string;
  spaceKeys?: string[]; // Specific spaces to index, or all if empty
  pageIds?: string[]; // Specific pages to index
  labels?: string[]; // Filter by labels
  maxPages?: number; // Limit number of pages
  force?: boolean; // Re-index even if already indexed
}

export interface ConfluenceIndexStats {
  spaces: number;
  pages: number;
  chunks: number;
  errors: number;
  duration: number;
}

class ConfluenceService {
  private client: AxiosInstance | null = null;
  private baseUrl: string = '';

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const url = process.env.CONFLUENCE_URL;
    const email = process.env.CONFLUENCE_EMAIL;
    const token = process.env.CONFLUENCE_API_TOKEN;

    if (!url || !email || !token) {
      logger.warn(
        'Confluence not configured. Set CONFLUENCE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN'
      );
      return;
    }

    this.baseUrl = url.replace(/\/$/, '');
    const auth = Buffer.from(`${email}:${token}`).toString('base64');

    this.client = axios.create({
      baseURL: `${this.baseUrl}/wiki/api/v2`,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    logger.info('Confluence client initialized', { url: this.baseUrl });
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Get all spaces
   */
  async getSpaces(): Promise<ConfluenceSpace[]> {
    if (!this.client) throw new Error('Confluence not configured');

    const spaces: ConfluenceSpace[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.get('/spaces', {
        params: {
          limit: 100,
          cursor,
          status: 'current',
        },
      });

      for (const space of response.data.results) {
        spaces.push({
          key: space.key,
          name: space.name,
          type: space.type,
          status: space.status,
        });
      }

      cursor = response.data._links?.next
        ? this.extractCursor(response.data._links.next)
        : undefined;
    } while (cursor);

    return spaces;
  }

  /**
   * Get pages from a space
   */
  async getSpacePages(spaceKey: string, limit: number = 1000): Promise<ConfluencePage[]> {
    if (!this.client) throw new Error('Confluence not configured');

    const pages: ConfluencePage[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.get('/pages', {
        params: {
          'space-id': await this.getSpaceId(spaceKey),
          limit: Math.min(100, limit - pages.length),
          cursor,
          status: 'current',
          'body-format': 'storage',
        },
      });

      for (const page of response.data.results) {
        const content = await this.getPageContent(page.id);
        pages.push({
          id: page.id,
          title: page.title,
          spaceKey,
          content,
          url: `${this.baseUrl}/wiki${page._links?.webui || `/spaces/${spaceKey}/pages/${page.id}`}`,
          lastModified: page.version?.createdAt || new Date().toISOString(),
          version: page.version?.number || 1,
        });

        if (pages.length >= limit) break;
      }

      cursor = response.data._links?.next
        ? this.extractCursor(response.data._links.next)
        : undefined;
    } while (cursor && pages.length < limit);

    return pages;
  }

  /**
   * Get page content by ID
   */
  async getPageContent(pageId: string): Promise<string> {
    if (!this.client) throw new Error('Confluence not configured');

    try {
      const response = await this.client.get(`/pages/${pageId}`, {
        params: {
          'body-format': 'storage',
        },
      });

      const storageContent = response.data.body?.storage?.value || '';
      return this.htmlToText(storageContent);
    } catch (error: any) {
      logger.warn(`Failed to get content for page ${pageId}`, { error: error.message });
      return '';
    }
  }

  /**
   * Search pages by CQL
   */
  async searchPages(cql: string, limit: number = 100): Promise<ConfluencePage[]> {
    if (!this.client) throw new Error('Confluence not configured');

    // Use v1 API for CQL search
    const v1Client = axios.create({
      baseURL: `${this.baseUrl}/wiki/rest/api`,
      headers: this.client.defaults.headers as any,
      timeout: 30000,
    });

    const response = await v1Client.get('/content/search', {
      params: {
        cql,
        limit,
        expand: 'body.storage,space,version,ancestors',
      },
    });

    return response.data.results.map((page: any) => ({
      id: page.id,
      title: page.title,
      spaceKey: page.space?.key || '',
      spaceName: page.space?.name,
      content: this.htmlToText(page.body?.storage?.value || ''),
      url: `${this.baseUrl}/wiki${page._links?.webui || ''}`,
      lastModified: page.version?.when || new Date().toISOString(),
      version: page.version?.number || 1,
      ancestors: page.ancestors?.map((a: any) => ({ id: a.id, title: a.title })),
    }));
  }

  /**
   * Index Confluence into vector store
   */
  async indexConfluence(options: IndexConfluenceOptions): Promise<ConfluenceIndexStats> {
    if (!this.client) throw new Error('Confluence not configured');

    const { projectName, spaceKeys, pageIds, labels, maxPages = 1000, force = false } = options;
    const collectionName = `${projectName}_confluence`;
    const startTime = Date.now();

    const stats: ConfluenceIndexStats = {
      spaces: 0,
      pages: 0,
      chunks: 0,
      errors: 0,
      duration: 0,
    };

    logger.info(`Starting Confluence indexing for ${projectName}`, { spaceKeys, maxPages });

    try {
      // Clear existing if force
      if (force) {
        await vectorStore.clearCollection(collectionName);
      }

      let pages: ConfluencePage[] = [];

      // Get pages by specific IDs
      if (pageIds && pageIds.length > 0) {
        for (const pageId of pageIds) {
          try {
            const content = await this.getPageContent(pageId);
            const response = await this.client.get(`/pages/${pageId}`);
            pages.push({
              id: pageId,
              title: response.data.title,
              spaceKey: response.data.spaceId,
              content,
              url: `${this.baseUrl}/wiki${response.data._links?.webui || ''}`,
              lastModified: response.data.version?.createdAt || new Date().toISOString(),
              version: response.data.version?.number || 1,
            });
          } catch (error) {
            stats.errors++;
          }
        }
      }
      // Get pages by labels
      else if (labels && labels.length > 0) {
        const labelQuery = labels.map((l) => `label = "${l}"`).join(' OR ');
        pages = await this.searchPages(labelQuery, maxPages);
      }
      // Get pages from spaces
      else {
        const spacesToIndex = spaceKeys || (await this.getSpaces()).map((s) => s.key);
        stats.spaces = spacesToIndex.length;

        for (const spaceKey of spacesToIndex) {
          try {
            const spacePages = await this.getSpacePages(
              spaceKey,
              Math.ceil(maxPages / spacesToIndex.length)
            );
            pages.push(...spacePages);

            if (pages.length >= maxPages) break;
          } catch (error: any) {
            logger.warn(`Failed to get pages from space ${spaceKey}`, { error: error.message });
            stats.errors++;
          }
        }
      }

      logger.info(`Found ${pages.length} pages to index`);

      // Index pages
      for (const page of pages.slice(0, maxPages)) {
        if (!page.content || page.content.trim().length < 50) {
          continue;
        }

        try {
          const chunks = this.chunkContent(page.content, page.title);
          const points: VectorPoint[] = [];

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const embedding = await embeddingService.embed(chunk);

            points.push({
              vector: embedding,
              payload: {
                pageId: page.id,
                title: page.title,
                spaceKey: page.spaceKey,
                content: chunk,
                url: page.url,
                chunkIndex: i,
                totalChunks: chunks.length,
                lastModified: page.lastModified,
                type: 'confluence',
                project: projectName,
              },
            });

            stats.chunks++;
          }

          if (points.length > 0) {
            await vectorStore.upsert(collectionName, points);
          }

          stats.pages++;
        } catch (error: any) {
          logger.warn(`Failed to index page ${page.id}`, { error: error.message });
          stats.errors++;
        }
      }

      stats.duration = Date.now() - startTime;
      logger.info(`Confluence indexing completed for ${projectName}`, { ...stats });

      return stats;
    } catch (error: any) {
      logger.error(`Confluence indexing failed for ${projectName}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get space ID from key
   */
  private async getSpaceId(spaceKey: string): Promise<string> {
    if (!this.client) throw new Error('Confluence not configured');

    const response = await this.client.get('/spaces', {
      params: { keys: spaceKey },
    });

    if (response.data.results.length === 0) {
      throw new Error(`Space not found: ${spaceKey}`);
    }

    return response.data.results[0].id;
  }

  /**
   * Extract cursor from next link
   */
  private extractCursor(nextLink: string): string | undefined {
    const match = nextLink.match(/cursor=([^&]+)/);
    return match ? match[1] : undefined;
  }

  /**
   * Convert HTML/storage format to plain text
   */
  private htmlToText(html: string): string {
    return (
      html
        // Remove CDATA
        .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
        // Convert headers to markdown-like
        .replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_, level, text) => {
          return '\n' + '#'.repeat(parseInt(level)) + ' ' + text.replace(/<[^>]+>/g, '') + '\n';
        })
        // Convert lists
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '• $1\n')
        // Convert paragraphs
        .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
        // Convert line breaks
        .replace(/<br\s*\/?>/gi, '\n')
        // Convert code blocks
        .replace(
          /<ac:structured-macro[^>]*ac:name="code"[^>]*>.*?<ac:plain-text-body>(.*?)<\/ac:plain-text-body>.*?<\/ac:structured-macro>/gs,
          '\n```\n$1\n```\n'
        )
        // Remove all remaining HTML tags
        .replace(/<[^>]+>/g, ' ')
        // Decode HTML entities
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
        // Clean up whitespace
        .replace(/\s+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }

  /**
   * Chunk content for embedding
   */
  private chunkContent(content: string, title: string): string[] {
    const maxChunkSize = 1000;
    const chunks: string[] = [];

    // Add title to first chunk for context
    const titlePrefix = `# ${title}\n\n`;

    const paragraphs = content.split(/\n\n+/);
    let currentChunk = titlePrefix;

    for (const para of paragraphs) {
      if (currentChunk.length + para.length > maxChunkSize) {
        if (currentChunk.trim().length > 50) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = para;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }

    if (currentChunk.trim().length > 50) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}

export const confluenceService = new ConfluenceService();
export default confluenceService;
