import express, { Request, Response, NextFunction } from 'express';
import { chromium, Browser } from 'playwright';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from './db/index.js';
import { apiKeysTable, usersTable } from './db/schema.js';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();

app.use(helmet());

app.use(cors({
  origin: [
    'http://localhost:8081',
    'http://localhost:4321',
    'https://page-to-paper-api.lovable.app'
  ],
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature']
}));

// ==========================================
// LEMON SQUEEZY WEBHOOK ENDPOINT
// IMPORTANT: Register BEFORE express.json()
// ==========================================

app.post(
  '/v1/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response): Promise<void> => {
    const signatureHeader = req.headers['x-signature'];
    const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;

    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;

    if (!signature || !secret) {
      res.status(400).json({
        error: 'Missing signature or webhook secret.'
      });
      return;
    }

    try {
      const rawBody = req.body;

      if (!Buffer.isBuffer(rawBody)) {
        res.status(400).json({
          error: 'Expected a raw JSON request body.'
        });
        return;
      }

      // 1. Verify HMAC SHA-256 signature.
      if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
        res.status(401).json({
          error: 'Invalid signature.'
        });
        return;
      }

      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest();

      const receivedSignature = Buffer.from(signature, 'hex');

      if (
        receivedSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(expectedSignature, receivedSignature)
      ) {
        res.status(401).json({
          error: 'Invalid signature.'
        });
        return;
      }

      // 2. Parse verified payload.
      const event = JSON.parse(rawBody.toString('utf8'));

      const eventName = event.meta?.event_name;
      const customData = event.meta?.custom_data;
      const attributes = event.data?.attributes;

      console.log(`Lemon Squeezy event received: ${eventName}`);

      // 3. Subscription created, updated, or resumed.
      if (
        eventName === 'subscription_created' ||
        eventName === 'subscription_updated' ||
        eventName === 'subscription_resumed'
      ) {
        const apiKey = customData?.api_key;
        const variantId = attributes?.variant_id?.toString();
        const status = attributes?.status;
        const subscriptionId = event.data?.id?.toString();
        const customerId = attributes?.customer_id?.toString();

        if (!apiKey || !variantId || !subscriptionId) {
          res.status(400).json({
            error: 'Missing API key, variant ID, or subscription ID.'
          });
          return;
        }

        if (status === 'active') {
          const proVariantId = process.env.LEMON_PRO_VARIANT_ID;
          const scaleVariantId = process.env.LEMON_SCALE_VARIANT_ID;

          let tier: 'pro' | 'scale';
          let monthlyLimit: number;

          if (proVariantId && variantId === proVariantId) {
            tier = 'pro';
            monthlyLimit = 5000;
          } else if (scaleVariantId && variantId === scaleVariantId) {
            tier = 'scale';
            monthlyLimit = 25000;
          } else {
            console.warn(`Unknown Lemon Squeezy variant: ${variantId}`);

            res.status(400).json({
              error: 'Unrecognized subscription variant.'
            });
            return;
          }

          const updatedKeys = await db
            .update(apiKeysTable)
            .set({
              tier,
              monthlyLimit,
              lemonCustomerId: customerId ?? null,
              lemonSubscriptionId: subscriptionId
            })
            .where(eq(apiKeysTable.key, apiKey))
            .returning({ id: apiKeysTable.id });

          if (updatedKeys.length === 0) {
            res.status(404).json({
              error: 'API key not found.'
            });
            return;
          }

          console.log(
            `API key upgraded to ${tier.toUpperCase()} (${monthlyLimit} PDFs/month).`
          );
        }
      }

      // 4. Subscription cancelled or expired.
      if (
        eventName === 'subscription_cancelled' ||
        eventName === 'subscription_expired'
      ) {
        const subscriptionId = event.data?.id?.toString();

        if (subscriptionId) {
          await db
            .update(apiKeysTable)
            .set({
              tier: 'free',
              monthlyLimit: 100,
              lemonSubscriptionId: null
            })
            .where(
              eq(apiKeysTable.lemonSubscriptionId, subscriptionId)
            );

          console.log(
            `Subscription ${subscriptionId} ended. API key returned to Free tier.`
          );
        }
      }

      res.status(200).json({
        received: true
      });

    } catch (error: unknown) {
      console.error('Lemon Squeezy webhook error:', error);

      res.status(500).json({
        error: 'Webhook processing failed.'
      });
    }
  }
);

// ==========================================
// NORMAL JSON BODY MIDDLEWARE
// Must come AFTER the webhook route
// ==========================================

app.use(express.json({ limit: '10mb' }));

// ==========================================
// PLAYWRIGHT BROWSER INITIALIZATION
// ==========================================

let browser: Browser;

async function initBrowser(): Promise<void> {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  console.log('Playwright Chromium instance initialized');
}

// ==========================================
// AUTHENTICATION TYPES
// userId is a UUID string
// ==========================================

export interface AuthenticatedRequest extends Request {
  userId?: string;
  apiKeyRecord?: typeof apiKeysTable.$inferSelect;
}

// ==========================================
// API KEY AUTHENTICATION MIDDLEWARE
// ==========================================

async function verifyApiKey(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized: Missing or malformed Authorization header.'
    });
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
      res.status(403).json({
        error: 'Forbidden: Invalid or inactive API key.'
      });
      return;
    }

    req.userId = foundKey.userId;
    req.apiKeyRecord = foundKey;

    next();

  } catch (error: unknown) {
    console.error('Auth Middleware Error:', error);

    res.status(500).json({
      error: 'Internal Server Error during authentication.'
    });
  }
}

// ==========================================
// SIGNUP / API KEY RECOVERY ENDPOINT
// ==========================================

app.post(
  '/v1/auth/signup',
  async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({
        error: 'Valid email is required.'
      });
      return;
    }

    try {
      // 1. Find or create user.
      let [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);

      if (!user) {
        const [newUser] = await db
          .insert(usersTable)
          .values({ email })
          .returning();

        user = newUser;
      }

      // 2. Find existing active API key.
      let [existingKey] = await db
        .select()
        .from(apiKeysTable)
        .where(
          and(
            eq(apiKeysTable.userId, user.id),
            eq(apiKeysTable.isActive, true)
          )
        )
        .limit(1);

      if (existingKey) {
        res.status(200).json({
          message: 'Existing API key retrieved successfully!',
          email: user.email,
          apiKey: existingKey.key,
          createdAt: existingKey.createdAt,
          usageCount: existingKey.usageCount,
          monthlyLimit: existingKey.monthlyLimit,
          tier: existingKey.tier,
          isNew: false
        });

        return;
      }

      // 3. Generate a new API key.
      const rawKey = `pp_live_${crypto.randomBytes(24).toString('hex')}`;

      const [newApiKey] = await db
        .insert(apiKeysTable)
        .values({
          userId: user.id,
          key: rawKey,
          name: 'Default Live Key',
          isActive: true
        })
        .returning();

      res.status(201).json({
        message: 'New API key generated successfully!',
        email: user.email,
        apiKey: newApiKey.key,
        createdAt: newApiKey.createdAt,
        usageCount: newApiKey.usageCount,
        monthlyLimit: newApiKey.monthlyLimit,
        tier: newApiKey.tier,
        isNew: true
      });

    } catch (error: unknown) {
      console.error('Signup/Recovery Error:', error);

      res.status(500).json({
        error: 'Failed to process request',
        details: error instanceof Error
          ? error.message
          : 'Unknown error'
      });
    }
  }
);

// ==========================================
// CHECK USAGE STATS ENDPOINT
// ==========================================

app.get(
  '/v1/auth/usage',
  verifyApiKey,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const apiKeyRecord = req.apiKeyRecord;

      if (!apiKeyRecord) {
        res.status(401).json({
          error: 'Unauthorized'
        });
        return;
      }

      res.status(200).json({
        usageCount: apiKeyRecord.usageCount,
        monthlyLimit: apiKeyRecord.monthlyLimit,
        remaining: Math.max(
          0,
          apiKeyRecord.monthlyLimit - apiKeyRecord.usageCount
        ),
        tier: apiKeyRecord.tier
      });

    } catch (error: unknown) {
      console.error('Usage Error:', error);

      res.status(500).json({
        error: 'Failed to fetch usage stats'
      });
    }
  }
);

// ==========================================
// PROTECTED PDF GENERATION ENDPOINT
// ==========================================

app.post(
  '/v1/render/pdf',
  verifyApiKey,
  async (
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> => {
    const {
      html,
      format = 'A4',
      landscape = false,
      printBackground = true
    } = req.body;

    // Validate HTML.
    if (!html || typeof html !== 'string') {
      res.status(400).json({
        error: 'Missing required "html" string in request body.'
      });
      return;
    }

    const apiKeyRecord = req.apiKeyRecord;

    if (!apiKeyRecord) {
      res.status(401).json({
        error: 'API key authentication required.'
      });
      return;
    }

    // 1. Check monthly API quota.
    if (apiKeyRecord.usageCount >= apiKeyRecord.monthlyLimit) {
      res.status(429).json({
        error: 'Monthly API quota exceeded',
        message: `You have used ${apiKeyRecord.usageCount}/${apiKeyRecord.monthlyLimit} PDFs this month. Please upgrade your plan to continue.`,
        usageCount: apiKeyRecord.usageCount,
        monthlyLimit: apiKeyRecord.monthlyLimit,
        tier: apiKeyRecord.tier
      });

      return;
    }

    let context;

    try {
      // 2. Generate PDF using Playwright.
      context = await browser.newContext();

      const page = await context.newPage();

      await page.setContent(html, {
        waitUntil: 'networkidle',
        timeout: 10000
      });

      const pdfBuffer = await page.pdf({
        format,
        landscape,
        printBackground,
        margin: {
          top: '20px',
          right: '20px',
          bottom: '20px',
          left: '20px'
        }
      });

      // 3. Increment usage after successful generation.
      await db
        .update(apiKeysTable)
        .set({
          usageCount: apiKeyRecord.usageCount + 1
        })
        .where(eq(apiKeysTable.id, apiKeyRecord.id));

      console.log(
        `PDF generated successfully. Usage: ${apiKeyRecord.usageCount + 1}/${apiKeyRecord.monthlyLimit}`
      );

      // 4. Return PDF to client.
      res.contentType('application/pdf');
      res.send(pdfBuffer);

    } catch (error: unknown) {
      console.error('Render Error:', error);

      if (!res.headersSent) {
        res.status(500).json({
          error: 'PDF Rendering Failed',
          details: error instanceof Error
            ? error.message
            : 'Unknown error'
        });
      }

    } finally {
      if (context) {
        await context.close();
      }
    }
  }
);

// ==========================================
// HEALTH CHECK ENDPOINT
// ==========================================

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// SERVER STARTUP
// ==========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  try {
    await initBrowser();

    console.log(
      `API Server ready on http://localhost:${PORT}`
    );

  } catch (error) {
    console.error('Failed to initialize Playwright:', error);
    process.exit(1);
  }
});
