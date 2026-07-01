import { Pool } from '@neondatabase/serverless';
import dotenv from 'dotenv';
dotenv.config();

async function testPool() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const res = await pool.query('SELECT 1 as val');
    console.log('Pool success:', res.rows[0].val);
  } catch (err) {
    console.error('Pool error:', err.message);
  } finally {
    await pool.end();
  }
}
testPool();
