export type Focal = {x: number; y: number};

export type ImageScene = {
  kind: 'image';
  id: string;
  image: string;
  natural: {w: number; h: number};
  kicker: string;
  caption: string;
  durationInFrames: number;
  focal: Focal;
  zoomExtra?: number;
};

export type TitleScene = {
  kind: 'title';
  id: string;
  eyebrow?: string;
  heading: string;
  sub: string;
  durationInFrames: number;
};

export type Scene = ImageScene | TitleScene;

// One line per scene. These double as the on-screen subtitles and as the
// narration script — if voice narration is added later (e.g. via ElevenLabs),
// each line here maps 1:1 to one scene's audio cue.
//
// Every image scene shows the full, uncropped screenshot first, then eases
// into a push-in on `focal` (a 0-1 fraction of the image) for the back half
// of the scene — see sceneMotion.ts / KenBurnsImage.tsx.
export const scenes: Scene[] = [
  {
    kind: 'title',
    id: 'intro',
    eyebrow: 'HomeStyle Furniture runs on',
    heading: 'Cadence',
    sub: 'An AI-native CRM, wired straight into Shopify',
    durationInFrames: 90,
  },
  {
    kind: 'image',
    id: 'shopify',
    image: 's_shopify.png',
    natural: {w: 1908, h: 1002},
    kicker: '01 · The purchase',
    caption: 'A customer buys from the Shopify store',
    durationInFrames: 135,
    focal: {x: 0.27, y: 0.34},
    zoomExtra: 1.1,
  },
  {
    kind: 'image',
    id: 'n8n-ingest',
    image: 's_n8n_list.png',
    natural: {w: 1908, h: 1002},
    kicker: '02 · Auto-synced',
    caption: 'n8n picks up the order and upserts the customer',
    durationInFrames: 135,
    focal: {x: 0.15, y: 0.535},
    zoomExtra: 1.12,
  },
  {
    kind: 'image',
    id: 'supabase',
    image: 's_supabase.png',
    natural: {w: 1452, h: 928},
    kicker: '03 · Live database',
    caption: 'Customers, orders and scores land in Postgres in real time',
    durationInFrames: 120,
    focal: {x: 0.46, y: 0.28},
    zoomExtra: 1.1,
  },
  {
    kind: 'image',
    id: 'customer360',
    image: 's_customer360.png',
    natural: {w: 1908, h: 1002},
    kicker: '04 · Customer 360',
    caption: 'Cadence builds a full profile — timeline, LTV, churn risk',
    durationInFrames: 150,
    focal: {x: 0.34, y: 0.52},
    zoomExtra: 1.16,
  },
  {
    kind: 'image',
    id: 'rooms',
    image: 's_rooms.png',
    natural: {w: 404, h: 887},
    kicker: '05 · Rooms',
    caption: 'It even tracks which rooms they’ve furnished — and what’s next',
    durationInFrames: 120,
    focal: {x: 0.5, y: 0.3},
    zoomExtra: 1.08,
  },
  {
    kind: 'image',
    id: 'ask',
    image: 's_ask.png',
    natural: {w: 1908, h: 1002},
    kicker: '06 · Ask a question',
    caption: 'Now the user asks Cadence a question in plain English',
    durationInFrames: 135,
    focal: {x: 0.32, y: 0.42},
    zoomExtra: 1.14,
  },
  {
    kind: 'image',
    id: 'n8n-agent',
    image: 's_n8n_exec.png',
    natural: {w: 1908, h: 1002},
    kicker: '07 · Behind the scenes',
    caption: 'It routes to the n8n AI agent, which runs the SQL and answers',
    durationInFrames: 150,
    focal: {x: 0.55, y: 0.33},
    zoomExtra: 1.18,
  },
  {
    kind: 'image',
    id: 'inbox',
    image: 's_inbox.png',
    natural: {w: 1908, h: 1002},
    kicker: '08 · Inbox',
    caption: 'A customer messages in — Cadence drafts the reply for approval',
    durationInFrames: 150,
    focal: {x: 0.62, y: 0.56},
    zoomExtra: 1.16,
  },
  {
    kind: 'image',
    id: 'dashboard',
    image: 's_dashboard.png',
    natural: {w: 1908, h: 1002},
    kicker: 'Cadence',
    caption: 'Every customer, scored and explained — in one dashboard',
    durationInFrames: 135,
    focal: {x: 0.5, y: 0.18},
    zoomExtra: 1.14,
  },
  {
    kind: 'title',
    id: 'outro',
    heading: 'Cadence',
    sub: 'Next.js · Supabase · n8n · built for Shopify retention',
    durationInFrames: 105,
  },
];

export const TRANSITION_FRAMES = 15;

export const totalDurationInFrames =
  scenes.reduce((sum, s) => sum + s.durationInFrames, 0) -
  TRANSITION_FRAMES * (scenes.length - 1);
