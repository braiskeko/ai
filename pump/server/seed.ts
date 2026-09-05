/**
 * Demo data for fresh deployments: bot traders and memecoins with a story.
 *
 * The simulation itself lives in storage.ts (`Storage.seed()`); this module only
 * holds the declarative data plus two small helpers it shares with the seeder:
 * a deterministic PRNG and an inline-SVG image generator (no binary assets).
 */

/** Deterministic seed so a fresh deployment always produces the same demo history. */
export const SEED_PRNG_SEED = 1337;

export interface SeedBot {
  /** username (3-24 chars, [a-zA-Z0-9_]) */
  name: string;
  emoji: string;
  colors: readonly [string, string];
}

export interface SeedCoin {
  name: string;
  ticker: string;
  description: string;
  emoji: string;
  /** gradient stops of the generated logo */
  colors: readonly [string, string];
  website?: string;
  twitter?: string;
  telegram?: string;
  /** fraction of the supply the creator kept at launch (0..0.3) */
  creatorAllocation: number;
  /** how long ago the coin launched */
  ageHours: number;
  /** number of simulated trades, spread over the coin's life (30-120) */
  trades: number;
  /**
   * Where the coin sits right now, on a 0..1 scale from the launch market cap (0) to the
   * market cap at which the bonding curve is completely sold out (1). 1 = sold out, which
   * is "graduated" when the VIRTUAL_* constants put the sell-out cap at or above GRADUATION_MCAP.
   */
  targetProgress: number;
  /** how the price got there */
  shape?: "steady" | "pump" | "early" | "chop" | "dump";
  comments: string[];
}

/** Classic 32-bit linear congruential generator; returns uniform numbers in [0, 1). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A 256x256 rounded-square logo: diagonal gradient background with an emoji on top,
 * returned as a base64 `data:image/svg+xml` URL that works directly in `<img src>`.
 */
export function coinImageDataUrl(emoji: string, colors: readonly [string, string]): string {
  const [from, to] = colors.map(escapeXml);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="256" height="256" rx="56" ry="56" fill="url(#g)"/>` +
    `<circle cx="128" cy="128" r="88" fill="rgba(255,255,255,0.14)"/>` +
    `<text x="128" y="136" font-size="128" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif">${escapeXml(emoji)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export const seedBots: SeedBot[] = [
  { name: "degen_dave", emoji: "🦍", colors: ["#4ade80", "#166534"] },
  { name: "moonboy", emoji: "🚀", colors: ["#a78bfa", "#312e81"] },
  { name: "wagmi_wendy", emoji: "🌈", colors: ["#f472b6", "#7c2d12"] },
  { name: "paperhands_pete", emoji: "📄", colors: ["#fbbf24", "#78350f"] },
  { name: "diamond_dina", emoji: "💎", colors: ["#67e8f9", "#0e7490"] },
  { name: "chad_capital", emoji: "🗿", colors: ["#94a3b8", "#1e293b"] },
  { name: "satoshi_jr", emoji: "🕵️", colors: ["#fb923c", "#7c2d12"] },
  { name: "ser_pump", emoji: "🧨", colors: ["#f43f5e", "#4c0519"] },
];

/**
 * Demo coins. `ageHours` is relative to the seed time; `targetProgress` is where the
 * simulated history ends, relative to the sold-out market cap. With reserves that put
 * the sell-out at ≈$69k, exactly one coin below is graduated (Noxia Cat, progress 1
 * and no creator allocation, since an allocation lowers the sell-out cap) and one is
 * the King of the Hill (Doge Wif Hat, ≈55% ≈ $38k).
 */
export const seedCoins: SeedCoin[] = [
  {
    name: "Noxia Cat",
    ticker: "NCAT",
    description:
      "The first cat on Noxia. She graduated, she is not selling, and she judges your portfolio from the top of the fridge. Meow to the moon.",
    emoji: "🐱",
    colors: ["#4ade80", "#065f46"],
    website: "https://noxia.cat",
    twitter: "https://x.com/noxiacat",
    telegram: "https://t.me/noxiacat",
    creatorAllocation: 0,
    ageHours: 72,
    trades: 120,
    targetProgress: 1,
    shape: "early",
    comments: [
      "first coin to graduate on noxia, history was made here 🎓",
      "dev has been in vc every night, actually based",
      "bought at 5k mcap. not selling. cat is life.",
      "the chart looks like a staircase to heaven",
      "when CEX?",
    ],
  },
  {
    name: "Doge Wif Hat",
    ticker: "DWH",
    description: "Just a dog. Wif a hat. That is the whole thesis and honestly it has never failed. King of the Hill material.",
    emoji: "🐶",
    colors: ["#fbbf24", "#92400e"],
    twitter: "https://x.com/dogewifhat",
    creatorAllocation: 0.1,
    ageHours: 36,
    trades: 95,
    targetProgress: 0.55,
    shape: "steady",
    comments: [
      "the hat stays on 🎩",
      "king of the hill and it's not even close",
      "sent it to my mom, she asked what a hat is",
      "graduation loading... 55%",
    ],
  },
  {
    name: "Pepe Prime",
    ticker: "PRIME",
    description: "Rare pepe, prime edition. Limited to one billion. Feels good man.",
    emoji: "🐸",
    colors: ["#22c55e", "#14532d"],
    telegram: "https://t.me/pepeprime",
    creatorAllocation: 0.02,
    ageHours: 20,
    trades: 80,
    targetProgress: 0.3,
    shape: "chop",
    comments: ["feels good man", "every dip gets bought instantly, who is this whale", "ribbit"],
  },
  {
    name: "Moon Lambo",
    ticker: "LAMBO",
    description: "Wen lambo? Now lambo. Each token is a fraction of a hypothetical lamborghini that may or may not exist.",
    emoji: "🏎️",
    colors: ["#f43f5e", "#881337"],
    creatorAllocation: 0,
    ageHours: 6,
    trades: 45,
    targetProgress: 0.14,
    shape: "pump",
    comments: ["this thing just went vertical", "dev with 0% allocation, respect", "lambo or food stamps"],
  },
  {
    name: "Rug Insurance",
    ticker: "RUG",
    description: "The only coin that pays out when everything else gets rugged. Terms and conditions: there are none.",
    emoji: "🧯",
    colors: ["#f97316", "#7c2d12"],
    website: "https://ruginsurance.lol",
    creatorAllocation: 0.15,
    ageHours: 10,
    trades: 40,
    targetProgress: 0.07,
    shape: "dump",
    comments: ["ironic if this one rugs", "dev holds 15%, keeping an eye on him 👀", "bought the top, need insurance for my insurance"],
  },
  {
    name: "Giga Chad",
    ticker: "GIGA",
    description: "Jawline of steel, hands of diamond. Stares at red candles until they turn green.",
    emoji: "🗿",
    colors: ["#94a3b8", "#0f172a"],
    twitter: "https://x.com/gigachadcoin",
    creatorAllocation: 0.03,
    ageHours: 48,
    trades: 70,
    targetProgress: 0.2,
    shape: "steady",
    comments: ["average GIGA enjoyer", "slow and steady, exactly how I like it", "chad chart"],
  },
  {
    name: "Toast Token",
    ticker: "TOAST",
    description: "Bread, but better. Crispy on the outside, deflationary on the inside. Butter not included.",
    emoji: "🍞",
    colors: ["#fcd34d", "#b45309"],
    creatorAllocation: 0.05,
    ageHours: 4,
    trades: 35,
    targetProgress: 0.09,
    shape: "early",
    comments: ["fresh out of the oven 🔥", "is this the bread coin from the thread?"],
  },
  {
    name: "Quantum Banana",
    ticker: "QBAN",
    description: "It is both ripe and not ripe until you observe your bag. Schrödinger's fruit stand.",
    emoji: "🍌",
    colors: ["#fde047", "#4d7c0f"],
    website: "https://quantumbanana.xyz",
    telegram: "https://t.me/quantumbanana",
    creatorAllocation: 0.08,
    ageHours: 30,
    trades: 60,
    targetProgress: 0.18,
    shape: "chop",
    comments: ["potassium is the new gold", "the volatility on this thing is a physics lecture", "🍌🍌🍌"],
  },
  {
    name: "Sleepy Sloth",
    ticker: "SLOTH",
    description: "Slowest coin on the platform, by design. We will get there. Eventually. After a nap.",
    emoji: "🦥",
    colors: ["#a3e635", "#3f6212"],
    creatorAllocation: 0.1,
    ageHours: 90,
    trades: 32,
    targetProgress: 0.075,
    shape: "steady",
    comments: ["comfy hold", "checked back after 3 days, up 2%. perfect."],
  },
  {
    name: "Vibe Check",
    ticker: "VIBE",
    description: "Passing the vibe check is the only utility. Immaculate vibes only, no rug energy allowed.",
    emoji: "✨",
    colors: ["#c084fc", "#4c1d95"],
    twitter: "https://x.com/vibecheckcoin",
    creatorAllocation: 0.04,
    ageHours: 15,
    trades: 75,
    targetProgress: 0.25,
    shape: "pump",
    comments: ["vibes: immaculate ✨", "someone just market bought 2k, chart is flying", "next king?"],
  },
  {
    name: "Based Bear",
    ticker: "BEAR",
    description: "For those who bought the top and are now emotionally prepared for anything. Hibernation is a strategy.",
    emoji: "🐻",
    colors: ["#a16207", "#292524"],
    creatorAllocation: 0.06,
    ageHours: 26,
    trades: 55,
    targetProgress: 0.11,
    shape: "dump",
    comments: ["took profits at the top, thanks bear", "hibernating in this one till spring", "it will come back, it always does"],
  },
  {
    name: "Wen Airdrop",
    ticker: "WEN",
    description: "Wen? Soon. The airdrop is always two weeks away. Hold and ask again.",
    emoji: "⏳",
    colors: ["#38bdf8", "#0c4a6e"],
    telegram: "https://t.me/wenairdrop",
    creatorAllocation: 0.12,
    ageHours: 2,
    trades: 30,
    targetProgress: 0.06,
    shape: "chop",
    comments: ["wen", "soon™"],
  },
  {
    name: "Pixel Pirate",
    ticker: "ARRR",
    description: "8-bit buccaneers plundering the bonding curve. Yo ho ho and a bottle of USDC.",
    emoji: "🏴‍☠️",
    colors: ["#1e293b", "#7f1d1d"],
    website: "https://pixelpirate.gg",
    creatorAllocation: 0.07,
    ageHours: 60,
    trades: 88,
    targetProgress: 0.16,
    shape: "early",
    comments: ["arrr matey 🏴‍☠️", "the treasure is the fees we made along the way", "shiver me timbers this dipped hard yesterday"],
  },
  {
    name: "Space Hamster",
    ticker: "HAMS",
    description: "One small hamster, one giant wheel. Powering the bonding curve with pure cardio since launch.",
    emoji: "🐹",
    colors: ["#fb7185", "#4a044e"],
    twitter: "https://x.com/spacehamster",
    telegram: "https://t.me/spacehamster",
    creatorAllocation: 0.05,
    ageHours: 12,
    trades: 110,
    targetProgress: 0.37,
    shape: "steady",
    comments: ["the wheel never stops 🐹", "most traded coin today, insane volume", "hamster to king of the hill, calling it now", "run little guy run"],
  },
];
