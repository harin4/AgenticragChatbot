import { Client } from '@neondatabase/serverless';
import dotenv from 'dotenv';
dotenv.config();

async function testTransaction() {
  console.log("--- NEON CLIENT TRANSACTION TEST ---");
  
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  
  console.log("1. Creating isolated test table...");
  await client.query('CREATE TABLE IF NOT EXISTS test_transaction_rollback (id SERIAL PRIMARY KEY, val TEXT)');
  await client.query('TRUNCATE TABLE test_transaction_rollback');

  try {
    console.log("2. Sending 'BEGIN' request...");
    await client.query('BEGIN');

    console.log("3. Inserting a row...");
    await client.query("INSERT INTO test_transaction_rollback (val) VALUES ('I should be rolled back')");

    console.log("4. Simulating a pipeline crash (e.g., error during chunking)...");
    throw new Error("Simulated Crash");

  } catch (err) {
    console.log(`   Caught error: ${err.message}`);
    
    console.log("5. Sending 'ROLLBACK' request in the catch/finally block...");
    await client.query('ROLLBACK');
  }

  console.log("6. Querying the table to see if the row is still there...");
  const res = await client.query('SELECT * FROM test_transaction_rollback');
  const rows = res.rows;
  
  if (rows.length > 0) {
    console.log(`\n🚨 DANGER CONFIRMED: The row is STILL in the database!`);
    console.log(`   Found row: ${JSON.stringify(rows[0])}`);
  } else {
    console.log(`\n✅ TEST PASSED: The row was rolled back successfully using Client over WebSocket.`);
  }

  console.log("\n7. Cleaning up test table...");
  await client.query('DROP TABLE test_transaction_rollback');
  await client.end();
}

testTransaction().catch(console.error);
