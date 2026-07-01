import dotenv from 'dotenv';
import { Client } from '@neondatabase/serverless';

dotenv.config();

async function inspectSchema() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'kb_chunk_memory';");
  console.table(res.rows);
  await client.end();
}

inspectSchema().catch(console.error);
