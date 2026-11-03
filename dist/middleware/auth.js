import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { apiKeysTable } from '../db/schema.js';
import * as dotenv from 'dotenv';
dotenv.config();
const client = postgres(process.env.DATABASE_URL || '', { ssl: 'require', max: 1 });
const db = drizzle(client);
export async function verifyApiKey(req, res, next) {
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
