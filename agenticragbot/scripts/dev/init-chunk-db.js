import { initChunkSchema } from '../../src/chunk-db.js';
import dotenv from 'dotenv';
dotenv.config();

console.log('[init-chunk-db] Initializing chunk schema...');
initChunkSchema(process.env)
  .then(() => {
    console.log('[init-chunk-db] Done.');
    process.exit(0);
  })
  .catch(err => {
    console.error('[init-chunk-db] Failed:', err);
    process.exit(1);
  });
