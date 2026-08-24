import { SurfacePlaceholder } from '../../components/shell/placeholder';

export default function AskCadencePage() {
  return (
    <SurfacePlaceholder
      title="Ask Cadence"
      note="Natural-language SQL agent over customer_scores, orders and events — scoped to the read-only AGENT_DATABASE_URL role (PRD-02 §F4.3), never the app's DATABASE_URL."
    />
  );
}
