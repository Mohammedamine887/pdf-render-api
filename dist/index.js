import express from 'express';
import { chromium } from 'playwright';
import cors from 'cors';
import helmet from 'helmet';
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
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
let browser;
// ==========================================
// PLAYWRIGHT BROWSER INITIALIZATION
// ==========================================
async function initBrowser() {
    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    });
    console.log('⚡ Playwright Chromium instance initialized');
}
// ==========================================
// API KEY AUTHENTICATION MIDDLEWARE
// ==========================================
async function verifyApiKey(req, res, next) {
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
        // Attach API key information to request
        req.userId = foundKey.userId;
        req.apiKeyRecord = foundKey;
        next();
    }
    catch (error) {
        console.error('Auth Middleware Error:', error);
        res.status(500).json({
            error: 'Internal Server Error during authentication.'
        });
    }
}
// ==========================================
// SIGNUP / API KEY RECOVERY ENDPOINT
// ==========================================
app.post('/v1/auth/signup', async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        res.status(400).json({
            error: 'Valid email is required.'
        });
        return;
    }
    try {
        // 1. Find or create user
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
        // 2. Check for existing active API key
        let [existingKey] = await db
            .select()
            .from(apiKeysTable)
            .where(and(eq(apiKeysTable.userId, user.id), eq(apiKeysTable.isActive, true)))
            .limit(1);
        if (existingKey) {
            res.status(200).json({
                message: 'Existing API key retrieved successfully!',
                email: user.email,
                apiKey: existingKey.key,
                createdAt: existingKey.createdAt,
                usageCount: existingKey.usageCount,
                monthlyLimit: existingKey.monthlyLimit,
                isNew: false
            });
            return;
        }
        // 3. Generate a new API key
        const rawKey = `pp_live_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
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
            isNew: true
        });
    }
    catch (error) {
        console.error('Signup/Recovery Error:', error);
        res.status(500).json({
            error: 'Failed to process request',
            details: error instanceof Error
                ? error.message
                : 'Unknown error'
        });
    }
});
// ==========================================
// CHECK USAGE STATS ENDPOINT
// ==========================================
app.get('/v1/auth/usage', verifyApiKey, async (req, res) => {
    try {
        const apiKeyRecord = req.apiKeyRecord;
        if (!apiKeyRecord) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        res.status(200).json({
            usageCount: apiKeyRecord.usageCount,
            monthlyLimit: apiKeyRecord.monthlyLimit,
            remaining: Math.max(0, apiKeyRecord.monthlyLimit - apiKeyRecord.usageCount),
            tier: 'Free Tier'
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch usage stats' });
    }
});
// ==========================================
// PROTECTED PDF GENERATION ENDPOINT
// ==========================================
app.post('/v1/render/pdf', verifyApiKey, async (req, res) => {
    const { html, format = 'A4', landscape = false, printBackground = true } = req.body;
    // Validate HTML
    if (!html || typeof html !== 'string') {
        res.status(400).json({
            error: 'Missing required "html" string in request body.'
        });
        return;
    }
    // Retrieve authenticated API key
    const apiKeyRecord = req.apiKeyRecord;
    if (!apiKeyRecord) {
        res.status(401).json({
            error: 'API key authentication required.'
        });
        return;
    }
    // ======================================
    // 1. CHECK MONTHLY API QUOTA
    // ======================================
    if (apiKeyRecord.usageCount >= apiKeyRecord.monthlyLimit) {
        res.status(429).json({
            error: 'Monthly API quota exceeded',
            message: `You have used ${apiKeyRecord.usageCount}/${apiKeyRecord.monthlyLimit} free PDFs this month. Please upgrade your plan to continue.`,
            usageCount: apiKeyRecord.usageCount,
            monthlyLimit: apiKeyRecord.monthlyLimit
        });
        return;
    }
    let context;
    try {
        // ======================================
        // 2. GENERATE PDF USING PLAYWRIGHT
        // ======================================
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
        // ======================================
        // 3. INCREMENT USAGE AFTER SUCCESS
        // ======================================
        await db
            .update(apiKeysTable)
            .set({
            usageCount: apiKeyRecord.usageCount + 1
        })
            .where(eq(apiKeysTable.id, apiKeyRecord.id));
        console.log(`PDF generated successfully. Usage: ${apiKeyRecord.usageCount + 1}/${apiKeyRecord.monthlyLimit}`);
        // ======================================
        // 4. RETURN PDF TO CLIENT
        // ======================================
        res.contentType('application/pdf');
        res.send(pdfBuffer);
    }
    catch (error) {
        console.error('Render Error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'PDF Rendering Failed',
                details: error instanceof Error
                    ? error.message
                    : 'Unknown error'
            });
        }
    }
    finally {
        if (context) {
            await context.close();
        }
    }
});
// ==========================================
// HEALTH CHECK ENDPOINT
// ==========================================
app.get('/health', (_req, res) => {
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
        console.log(`🚀 API Server ready on http://localhost:${PORT}`);
    }
    catch (error) {
        console.error('Failed to initialize Playwright:', error);
        process.exit(1);
    }
});
