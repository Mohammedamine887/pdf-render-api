import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import * as dotenv from 'dotenv';
dotenv.config();
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error('DATABASE_URL is not set in the environment variables.');
}
// Setup connection for Drizzle
const client = postgres(connectionString, { ssl: 'require', max: 1 });
export const db = drizzle(client, { schema });
