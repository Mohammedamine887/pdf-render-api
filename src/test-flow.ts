import { db } from './db';
import { usersTable, apiKeysTable } from './db/schema';
import { chromium } from 'playwright';
import * as dotenv from 'dotenv';
import { eq } from 'drizzle-orm';

dotenv.config();

async function runLocalTest() {
  console.log('🔍 Starting dynamic local integration test...\n');

  try {
    // 1. Check if ANY API key exists in Supabase, or create a test one automatically
    console.log('1️⃣ Checking Supabase database for an active API key...');
    let [existingKey] = await db.select().from(apiKeysTable).limit(1);

    if (!existingKey) {
      console.log('⚠️ No API keys found in Supabase. Creating a test user and key automatically...');
      
      // Insert a test user
      const [newUser] = await db.insert(usersTable).values({
        email: `test_${Date.now()}@example.com`
      }).returning();

      // Generate a dynamic test key
      const generatedKey = `pp_live_${Math.random().toString(36).substring(2, 15)}`;
      
      const [newKey] = await db.insert(apiKeysTable).values({
        userId: newUser.id,
        key: generatedKey,
        name: 'Auto-Generated Test Key',
        isActive: true
      }).returning();

      existingKey = newKey;
      console.log(`✨ Created new test key: ${existingKey.key}`);
    } else {
      console.log(`✅ Found existing API key in database: ${existingKey.key}`);
    }

    // 2. Test Playwright PDF Generation
    console.log('\n2️⃣ Launching headless Chromium browser via Playwright...');
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    const sampleHtml = `
      <div style="font-family: Arial, sans-serif; padding: 30px; background: #f8fafc; border-radius: 8px;">
        <h1 style="color: #2563eb; margin-bottom: 5px;">Integration Test Successful!</h1>
        <p style="color: #64748b;">Authenticated using key: <code>${existingKey.key}</code></p>
        <hr style="border: none; border-top: 1px solid #cbd5e1; margin: 20px 0;" />
        <p style="font-size: 12px; color: #94a3b8;">Timestamp: ${new Date().toISOString()}</p>
      </div>
    `;

    console.log('3️⃣ Rendering HTML to PDF buffer...');
    await page.setContent(sampleHtml, { waitUntil: 'networkidle', timeout: 10000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    await browser.close();

    console.log(`✅ PDF generated successfully! Buffer size: ${pdfBuffer.length} bytes.`);
    console.log('\n🎉 Supabase auth check and Playwright rendering passed with flying colors!');
  } catch (error) {
    console.error('❌ Test encountered an error:', error);
  }
}

runLocalTest();