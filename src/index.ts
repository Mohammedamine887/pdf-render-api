import express, { Request, Response, NextFunction } from 'express';
import { chromium, Browser } from 'playwright';
import cors from 'cors';
import helmet from 'helmet';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { apiKeysTable } from './db/schema';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors({
  origin: ['http://localhost:8081', 'https://page-to-paper-api.lovable.app'],
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

let browser: Browser;

// Global browser instance initialization
async function initBrowser() {
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  console.log('⚡ Playwright Chromium instance initialized');
}

// Extended Request type for Authentication
export interface AuthenticatedRequest extends Request {
  userId?: string;
}

// Authentication Middleware (Checks Bearer token against Supabase PostgreSQL)
async function verifyApiKey(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header.' });
    return;
  }

  const apiKey = authHeader.split(' ')[1];

  try {
    const [foundKey] = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.key, apiKey))
      .limit(1);

    if (!foundKey || !foundKey.isActive) {
      res.status(403).json({ error: 'Forbidden: Invalid or inactive API key.' });
      return;
    }

    req.userId = foundKey.userId;
    next();
  } catch (error: any) {
    console.error('Auth Middleware Error:', error);
    res.status(500).json({ error: 'Internal Server Error during authentication.' });
  }
}

// Protected PDF Generation Endpoint
app.post('/v1/render/pdf', verifyApiKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { html, format = 'A4', printBackground = true } = req.body;

  if (!html) {
    res.status(400).json({ error: 'Missing required "html" string in request body.' });
    return;
  }

  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();

    await page.setContent(html, { waitUntil: 'networkidle', timeout: 10000 });

    const pdfBuffer = await page.pdf({
      format,
      printBackground,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    res.contentType('application/pdf');
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error('Render Error:', error);
    res.status(500).json({ error: 'PDF Rendering Failed', details: error.message });
  } finally {
    if (context) await context.close();
  }
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initBrowser();
  console.log(`🚀 API Server ready on http://localhost:${PORT}`);
});