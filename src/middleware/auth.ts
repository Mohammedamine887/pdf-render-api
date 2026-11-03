import { Request, Response, NextFunction } from 'express';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { apiKeysTable } from '../db/schema';
import * as dotenv from 'dotenv';

dotenv.config();

const client = postgres(process.env.DATABASE_URL || '');
const db = drizzle(client);

// Extend Express Request type to include user info if needed
export interface AuthenticatedRequest extends Request {
  userId?: string;
}

export async function verifyApiKey(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header.' });
    return;
  }

  const apiKey = authHeader.split(' ')[1];

  try {
    // Query database for the API key
    const [foundKey] = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.key, apiKey))
      .limit(1);

    if (!foundKey || !foundKey.isActive) {
      res.status(403).json({ error: 'Forbidden: Invalid or inactive API key.' });
      return;
    }

    // Attach userId to request and proceed
    req.userId = foundKey.userId;
    next();
  } catch (error: any) {
    console.error('Auth Middleware Error:', error);
    res.status(500).json({ error: 'Internal Server Error during authentication.' });
  }
}