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
    origin: ['http://localhost:8081', 'https://page-to-paper-api.lovable.app'],
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
let browser;
// Global browser instance initialization
async function initBrowser() {
    browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('⚡ Playwright Chromium instance initialized');
}
// Authentication Middleware (Checks Bearer token against Supabase PostgreSQL)
async function verifyApiKey(req, res, next) {
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
    }
    catch (error) {
        console.error('Auth Middleware Error:', error);
        res.status(500).json({ error: 'Internal Server Error during authentication.' });
    }
}
// Smart Signup / Key Recovery Endpoint
app.post('/v1/auth/signup', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
        res.status(400).json({ error: 'Valid email is required.' });
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
        // 2. Check if an active API key already exists for this user
        let [existingKey] = await db
            .select()
            .from(apiKeysTable)
            .where(and(eq(apiKeysTable.userId, user.id), eq(apiKeysTable.isActive, true)))
            .limit(1);
        if (existingKey) {
            // Returning user: safely return their existing key
            res.status(200).json({
                message: 'Existing API key retrieved successfully!',
                email: user.email,
                apiKey: existingKey.key,
                createdAt: existingKey.createdAt,
                isNew: false
            });
            return;
        }
        // 3. New user: generate a fresh live API key
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
            isNew: true
        });
    }
    catch (error) {
        console.error('Signup/Recovery Error:', error);
        res.status(500).json({ error: 'Failed to process request', details: error.message });
    }
});
// Protected PDF Generation Endpoint
app.post('/v1/render/pdf', verifyApiKey, async (req, res) => {
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
    }
    catch (error) {
        console.error('Render Error:', error);
        res.status(500).json({ error: 'PDF Rendering Failed', details: error.message });
    }
    finally {
        if (context)
            await context.close();
    }
});
// Health check endpoint
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initBrowser();
    console.log(`🚀 API Server ready on http://localhost:${PORT}`);
});
