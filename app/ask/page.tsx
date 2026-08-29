// Ask Cadence (PRD-02 §F4). The page itself is a thin server shell; the
// console is a client component because the whole surface is one interactive
// request/response loop. All model and database work happens behind
// POST /api/agent — no key, no DSN and no SQL execution ever reaches the
// browser.
import { AskConsole } from '../../components/agent/ask-console';

export const dynamic = 'force-dynamic';

export default function AskCadencePage() {
  return <AskConsole />;
}
