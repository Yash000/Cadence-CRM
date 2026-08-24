import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '..', 'shopify-app', 'cadence-crm');

try {
  const out = execFileSync(
    'shopify',
    ['app', 'execute', '--store', 'rasaya-dev.myshopify.com',
     '--query', 'query { shop { name } }'],
    { cwd: APP_DIR, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  console.log('OK. stdout:\n', out);
} catch (e) {
  console.log('THREW');
  console.log('status :', e.status);
  console.log('message:', e.message?.slice(0, 300));
  console.log('--- stdout ---\n', (e.stdout || '').slice(0, 1200));
  console.log('--- stderr ---\n', (e.stderr || '').slice(0, 1200));
}
