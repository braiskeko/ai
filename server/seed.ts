import type { MarketCategory } from "@shared/schema";

export interface SeedMarket {
  question: string;
  description: string;
  rules: string;
  category: MarketCategory;
  emoji: string;
  liquidity: number;
  /** outcome names; two entries Yes/No make a binary market */
  outcomes?: string[];
  startProbabilities: number[];
  currentProbabilities: number[];
  ageDays: number;
  daysLeft: number;
  featured?: boolean;
  comments?: string[];
}

const yn = (p: number) => [p, 1 - p];

/**
 * Demo markets. All dates are relative to the seed date (early September 2026):
 * `ageDays` is how long ago the market was created, `daysLeft` is days until it closes
 * (<= 0 means it has already ended and the seeder auto-resolves it to the leading outcome).
 *
 * Invariants (checked by the validation script, see the task notes):
 *  - every probability array has one entry per outcome (2 for Yes/No) and sums to 1
 *  - outcome names are <= 24 characters, 3-8 outcomes per multi-outcome market
 *  - liquidity 1000-6000, ageDays 5-120, daysLeft 7-500 (except the ended markets)
 */
export const seedMarkets: SeedMarket[] = [
  // ───────────────────────────── Crypto ─────────────────────────────
  {
    question: "Will Bitcoin close above $150,000 on December 31, 2026?",
    description:
      "This market resolves to Yes if the BTC/USD daily close on Coinbase for December 31, 2026 (UTC) is strictly above $150,000.",
    rules:
      "The resolution source is the Coinbase BTC-USD daily candle close at 23:59:59 UTC on December 31, 2026. If Coinbase data is unavailable, the CoinGecko aggregate close will be used. Any price exactly at $150,000.00 resolves No.",
    category: "Crypto",
    emoji: "₿",
    liquidity: 4000,
    startProbabilities: yn(0.35),
    currentProbabilities: yn(0.41),
    ageDays: 35,
    daysLeft: 118,
    featured: true,
    comments: [
      "ETF inflows have been insane this quarter. 41% feels low.",
      "Halving cycle says the peak was already in. Fading this.",
      "Anyone else watching the miner capitulation data? Bullish divergence.",
    ],
  },
  {
    question: "Will Ethereum ETF staking be approved by the SEC before September 2026?",
    description:
      "Resolves Yes if the SEC approves any spot Ethereum ETF that includes staking of the underlying ETH before September 1, 2026.",
    rules:
      "Resolution based on SEC filings and official approval orders published on sec.gov before 00:00 ET on September 1, 2026. An approval order that is later stayed still counts as Yes.",
    category: "Crypto",
    emoji: "Ξ",
    liquidity: 2000,
    startProbabilities: yn(0.3),
    currentProbabilities: yn(0.92),
    ageDays: 90,
    daysLeft: -3,
    comments: ["Called it.", "Resolved Yes, easiest money of the year."],
  },
  {
    question: "Which chain will have the highest DEX volume in December 2026?",
    description:
      "Which blockchain will record the highest total DEX volume for the month of December 2026, per DefiLlama?",
    rules:
      "DefiLlama chain DEX volume dashboards are the resolution source, read on January 3, 2027 (UTC). L2s are counted separately from Ethereum mainnet. 'Other' covers any chain not listed.",
    category: "Crypto",
    emoji: "◎",
    liquidity: 2500,
    outcomes: ["Ethereum", "Solana", "Base", "BNB Chain", "Other"],
    startProbabilities: [0.4, 0.3, 0.15, 0.1, 0.05],
    currentProbabilities: [0.35, 0.36, 0.17, 0.08, 0.04],
    ageDays: 25,
    daysLeft: 118,
    comments: [
      "Solana has been trading places with Ethereum on monthly DEX volume all year.",
      "Base is the sleeper here. 17% is cheap.",
    ],
  },
  {
    question: "Will Ethereum trade above $8,000 before 2027?",
    description:
      "Resolves Yes if the ETH/USD price on Coinbase trades strictly above $8,000 at any point before January 1, 2027, 00:00 UTC.",
    rules:
      "Any single Coinbase ETH-USD trade printed above $8,000.00 before 00:00 UTC on January 1, 2027 resolves Yes; a 1-minute candle high is sufficient evidence. Prints that Coinbase later cancels are excluded. If Coinbase is offline, Kraken ETH/USD is the fallback source.",
    category: "Crypto",
    emoji: "💎",
    liquidity: 3000,
    startProbabilities: yn(0.28),
    currentProbabilities: yn(0.22),
    ageDays: 48,
    daysLeft: 119,
    comments: [
      "ETH/BTC ratio still hasn't broken out. Not yet.",
      "Treasury companies keep buying and exchange supply is at multi-year lows.",
    ],
  },

  // ───────────────────────────── Business ─────────────────────────────
  {
    question: "Fed decision in September?",
    description:
      "What will the Federal Open Market Committee decide about the federal funds target range at its September 15-16, 2026 meeting?",
    rules:
      "Resolves according to the official FOMC statement published on federalreserve.gov after the September 2026 meeting. '50+ bps decrease' includes any cut of 50 basis points or more. If no meeting takes place the market resolves 'No change'.",
    category: "Business",
    emoji: "🏦",
    liquidity: 5000,
    outcomes: ["25 bps decrease", "50+ bps decrease", "No change", "Increase"],
    startProbabilities: [0.45, 0.1, 0.4, 0.05],
    currentProbabilities: [0.62, 0.14, 0.22, 0.02],
    ageDays: 28,
    daysLeft: 13,
    featured: true,
    comments: ["Dot plot basically confirmed 25.", "Labor data was soft again, 50 is live."],
  },
  {
    question: "Will the US unemployment rate exceed 5% in any month of 2026?",
    description:
      "Resolves Yes if the BLS reports a seasonally adjusted U-3 unemployment rate above 5.0% for any month of 2026.",
    rules:
      "Resolution based on the initial BLS Employment Situation release for each month of 2026 (the December 2026 figure is published in early January 2027). Revisions are ignored. A print of exactly 5.0% does not count.",
    category: "Business",
    emoji: "📉",
    liquidity: 2500,
    startProbabilities: yn(0.25),
    currentProbabilities: yn(0.29),
    ageDays: 50,
    daysLeft: 150,
    comments: [
      "Claims are ticking up but 5% is a long way from here.",
      "Every soft landing eventually isn't. 29% is fair.",
    ],
  },
  {
    question: "Will Nvidia's market cap exceed $6 trillion at any close in 2026?",
    description:
      "Resolves Yes if NVDA's market capitalization at any regular-session close in 2026 exceeds $6,000,000,000,000.",
    rules:
      "Market cap computed as the Nasdaq official closing price × shares outstanding per Nvidia's most recent SEC filing. Intraday highs do not count. Any regular session through December 31, 2026 qualifies.",
    category: "Business",
    emoji: "💹",
    liquidity: 3500,
    startProbabilities: yn(0.45),
    currentProbabilities: yn(0.52),
    ageDays: 33,
    daysLeft: 118,
    featured: true,
    comments: [
      "Needs another big leg up from here. Possible, but 52% is about right.",
      "Data center guidance keeps beating. Buying Yes on every dip.",
    ],
  },
  {
    question: "Most valuable public company at the end of 2026?",
    description:
      "Which company will have the largest market capitalization at the close of the last US trading day of 2026?",
    rules:
      "Market cap is computed from the official closing price on December 31, 2026 (or the last US trading day of the year) multiplied by shares outstanding per each company's most recent filing, as reported by Bloomberg. Dual-class companies count all share classes. 'Other' includes any company not listed, including newly listed companies.",
    category: "Business",
    emoji: "🏢",
    liquidity: 3000,
    outcomes: ["Nvidia", "Microsoft", "Apple", "Alphabet", "Amazon", "Other"],
    startProbabilities: [0.5, 0.22, 0.15, 0.07, 0.03, 0.03],
    currentProbabilities: [0.56, 0.18, 0.13, 0.08, 0.02, 0.03],
    ageDays: 42,
    daysLeft: 118,
    comments: [
      "Nvidia's lead is enormous. What's the bear case in four months?",
      "Alphabet at 8% is the value pick here.",
    ],
  },

  // ───────────────────────────── Sports ─────────────────────────────
  {
    question: "2026-27 UEFA Champions League winner?",
    description: "Which club will lift the 2026-27 UEFA Champions League trophy?",
    rules:
      "Resolves to the club that wins the 2026-27 UEFA Champions League final according to UEFA. A win on penalties counts. 'Other' covers any club not listed.",
    category: "Sports",
    emoji: "⚽",
    liquidity: 3500,
    outcomes: ["Real Madrid", "Man City", "Bayern", "PSG", "Barcelona", "Liverpool", "Other"],
    startProbabilities: [0.18, 0.17, 0.12, 0.13, 0.11, 0.1, 0.19],
    currentProbabilities: [0.16, 0.15, 0.11, 0.17, 0.13, 0.09, 0.19],
    ageDays: 20,
    daysLeft: 270,
    featured: true,
    comments: ["PSG squad looks scary this year.", "Never bet against Madrid in Europe."],
  },
  {
    question: "2026 FIFA World Cup winner?",
    description: "Which national team will win the 2026 FIFA World Cup? The final was played on July 19, 2026 in New Jersey.",
    rules:
      "Resolves to the team that wins the final according to FIFA. Penalties count. 'Other' covers any team not listed. Trading closes at kickoff of the final.",
    category: "Sports",
    emoji: "🏆",
    liquidity: 4000,
    outcomes: ["Spain", "France", "Argentina", "Brazil", "England", "Germany", "Other"],
    startProbabilities: [0.13, 0.15, 0.14, 0.12, 0.13, 0.09, 0.24],
    currentProbabilities: [0.52, 0.43, 0.01, 0.01, 0.01, 0.01, 0.01],
    ageDays: 110,
    daysLeft: -47,
    comments: ["Spain's midfield is unreal.", "Called it after the group stage.", "What a final."],
  },
  {
    question: "Super Bowl LXI winner?",
    description:
      "Which team will win Super Bowl LXI, scheduled for February 14, 2027 at SoFi Stadium in Inglewood, California?",
    rules:
      "Resolves to the team declared the winner of Super Bowl LXI by the NFL. If the game is postponed, the market resolves when it is played. 'Other' covers any team not listed.",
    category: "Sports",
    emoji: "🏈",
    liquidity: 5500,
    outcomes: ["Eagles", "Chiefs", "Bills", "Ravens", "Lions", "49ers", "Other"],
    startProbabilities: [0.14, 0.12, 0.13, 0.12, 0.1, 0.09, 0.3],
    currentProbabilities: [0.15, 0.1, 0.14, 0.13, 0.09, 0.08, 0.31],
    ageDays: 30,
    daysLeft: 163,
    featured: true,
    comments: [
      "Bills window is closing. This is the year or never.",
      "The field at 31% is still too cheap in September.",
      "Chiefs at 10% after last season feels disrespectful.",
    ],
  },
  {
    question: "Will Max Verstappen win the 2026 F1 World Drivers' Championship?",
    description:
      "Resolves Yes if Max Verstappen is the FIA Formula One World Drivers' Champion for the 2026 season, the first under the new power unit and chassis regulations.",
    rules:
      "Resolves according to the final FIA classification after the last round of the 2026 season (Abu Dhabi Grand Prix, December 6, 2026) and after any protests or appeals are settled. If the season is abandoned, the driver leading the standings at that point is the champion.",
    category: "Sports",
    emoji: "🏎️",
    liquidity: 2500,
    startProbabilities: yn(0.3),
    currentProbabilities: yn(0.18),
    ageDays: 95,
    daysLeft: 100,
    comments: [
      "New regs shuffled the deck and the Red Bull power unit had a rough start.",
      "He has won titles from worse positions. 18% is a gift.",
    ],
  },

  // ───────────────────────────── Tech ─────────────────────────────
  {
    question: "Will OpenAI release GPT-6 before the end of 2026?",
    description:
      "Resolves Yes if OpenAI makes a model officially named 'GPT-6' generally available (API or ChatGPT) to the public before January 1, 2027.",
    rules:
      "A research preview or limited waitlist does not count. The model must be available to paying customers without an invite before 00:00 UTC on January 1, 2027. Naming must include 'GPT-6' (GPT-6 mini, GPT-6 Turbo etc. count).",
    category: "Tech",
    emoji: "🤖",
    liquidity: 3000,
    startProbabilities: yn(0.5),
    currentProbabilities: yn(0.33),
    ageDays: 45,
    daysLeft: 118,
    comments: ["They said 'this year' at dev day but they always slip.", "NO. Compute is the bottleneck."],
  },
  {
    question: "Will Apple ship a foldable iPhone in 2026?",
    description: "Resolves Yes if Apple begins retail sales of an iPhone with a foldable display before January 1, 2027.",
    rules:
      "Pre-orders do not count. Devices must be delivered to customers in at least one country before January 1, 2027 (local time). Announcement alone is not sufficient.",
    category: "Tech",
    emoji: "📱",
    liquidity: 2000,
    startProbabilities: yn(0.45),
    currentProbabilities: yn(0.38),
    ageDays: 30,
    daysLeft: 118,
    comments: ["Supply chain leaks point to 2027.", "September event will settle this."],
  },
  {
    question: "Will a major AI lab release a 10M+ token context model in 2026?",
    description:
      "Resolves Yes if OpenAI, Anthropic, Google DeepMind, Meta or xAI make a model with a documented 10,000,000+ token context window available via public API in 2026.",
    rules:
      "Must be documented in official API docs and callable by any paying developer before 00:00 UTC on January 1, 2027. Research demos and enterprise-only previews do not count.",
    category: "Tech",
    emoji: "🧠",
    liquidity: 1500,
    startProbabilities: yn(0.35),
    currentProbabilities: yn(0.44),
    ageDays: 18,
    daysLeft: 118,
    comments: [
      "Google showed 10M in research ages ago. Productizing is the hard part.",
      "Nobody needs this yet, so nobody is shipping it.",
    ],
  },
  {
    question: "Will Tesla run driverless robotaxis in 5+ US metros by end of 2026?",
    description:
      "Resolves Yes if Tesla operates a paid, public robotaxi service with no Tesla employee inside the vehicle in at least five distinct US metropolitan areas before January 1, 2027.",
    rules:
      "A metro counts only if members of the general public (not an invite-only tester list) can hail and pay for rides with no safety monitor in the vehicle. Metropolitan areas are defined by US Census MSAs. Resolution based on Tesla official statements plus at least two credible press reports per metro.",
    category: "Tech",
    emoji: "🚕",
    liquidity: 3000,
    startProbabilities: yn(0.4),
    currentProbabilities: yn(0.31),
    ageDays: 65,
    daysLeft: 119,
    comments: [
      "Austin still has a monitor in the passenger seat. Five cities is a stretch.",
      "Never underestimate a Q4 push from Tesla.",
      "Permitting in California alone will take longer than four months.",
    ],
  },

  // ───────────────────────────── Science ─────────────────────────────
  {
    question: "Will Starship complete an orbital flight with booster catch in 2026?",
    description:
      "Resolves Yes if a Starship launch in 2026 reaches orbit (or a planned trans-atmospheric trajectory) AND the Super Heavy booster is caught by the launch tower arms on the same flight.",
    rules:
      "Both conditions must occur on the same flight launched before 00:00 UTC on January 1, 2027. Resolution based on SpaceX official statements and livestream footage.",
    category: "Science",
    emoji: "🚀",
    liquidity: 2500,
    startProbabilities: yn(0.55),
    currentProbabilities: yn(0.68),
    ageDays: 60,
    daysLeft: 118,
    comments: ["Already did the catch, orbit is the easy part now."],
  },
  {
    question: "Will Artemis III land humans on the Moon before 2028?",
    description:
      "Resolves Yes if NASA's Artemis III mission lands astronauts on the lunar surface before January 1, 2028.",
    rules:
      "Based on NASA official confirmation of a crewed lunar landing under the Artemis III designation before 00:00 UTC on January 1, 2028. A crewed lunar flyby or orbit-only mission does not count.",
    category: "Science",
    emoji: "🌕",
    liquidity: 2500,
    startProbabilities: yn(0.3),
    currentProbabilities: yn(0.22),
    ageDays: 80,
    daysLeft: 484,
    comments: ["Lander delays keep piling up. Under 20% by Christmas."],
  },
  {
    question: "Will 2026 be the warmest year on record globally?",
    description:
      "Resolves Yes if NASA GISS reports that 2026's global mean surface temperature anomaly is the highest of any calendar year in its record (1880 to present).",
    rules:
      "Resolution source is NASA's annual global temperature announcement, typically published in mid-January 2027. Ties resolve No. If NASA has not published by March 1, 2027, the Copernicus ERA5 annual ranking will be used instead.",
    category: "Science",
    emoji: "🌡️",
    liquidity: 2000,
    startProbabilities: yn(0.3),
    currentProbabilities: yn(0.24),
    ageDays: 105,
    daysLeft: 138,
    comments: [
      "La Niña conditions through the fall make this hard. No.",
      "Year-to-date is running just behind the record. Would need a huge Q4.",
    ],
  },
  {
    question: "How many named storms in the 2026 Atlantic hurricane season?",
    description:
      "How many named tropical or subtropical storms will form in the Atlantic basin during the 2026 hurricane season (June 1 to November 30)?",
    rules:
      "Resolves based on the National Hurricane Center's final count of named storms for the 2026 season, including any storms named after November 30 and any post-season reclassifications published by January 31, 2027. Unnamed depressions do not count.",
    category: "Science",
    emoji: "🌀",
    liquidity: 1500,
    outcomes: ["11 or fewer", "12-14", "15-17", "18-20", "21 or more"],
    startProbabilities: [0.15, 0.3, 0.3, 0.17, 0.08],
    currentProbabilities: [0.12, 0.34, 0.33, 0.15, 0.06],
    ageDays: 90,
    daysLeft: 90,
    comments: [
      "Storm count is tracking right at the climatological average so far.",
      "Warm main development region plus a quiet August. October could be busy.",
    ],
  },

  // ───────────────────────────── Culture ─────────────────────────────
  {
    question: "Will Taylor Swift announce a new studio album before 2027?",
    description:
      "Resolves Yes if Taylor Swift officially announces a new original studio album (not a re-recording) before January 1, 2027.",
    rules:
      "Announcement must come from Taylor Swift or her label via official channels before 00:00 ET on January 1, 2027. Taylor's Version re-records, live albums and deluxe editions do not count.",
    category: "Culture",
    emoji: "🎤",
    liquidity: 1500,
    startProbabilities: yn(0.4),
    currentProbabilities: yn(0.57),
    ageDays: 15,
    daysLeft: 118,
    comments: [
      "She has been on an album-every-18-months cadence for years. Yes.",
      "Post-tour years are historically quiet for her. Fading this.",
    ],
  },
  {
    question: "Will GTA VI sell more than 30 million copies in its first month?",
    description:
      "Resolves Yes if Take-Two Interactive reports or credible sales trackers confirm 30M+ units sold within 30 days of release.",
    rules:
      "Resolution based on Take-Two investor communications or Circana/GfK data. Units 'sold-in' to retailers count. If release slips beyond 2026 the market resolves No.",
    category: "Culture",
    emoji: "🎮",
    liquidity: 2000,
    startProbabilities: yn(0.5),
    currentProbabilities: yn(0.64),
    ageDays: 40,
    daysLeft: 118,
    comments: ["RDR2 did 17M in 8 days. 30M in a month is very doable."],
  },
  {
    question: "Spotify's most-streamed artist of 2026?",
    description:
      "Which artist will Spotify name the most-streamed artist globally in its 2026 Wrapped year-in-review?",
    rules:
      "Resolves to the artist named global 'Top Artist' in Spotify's official 2026 Wrapped announcement, expected in early December 2026. If Spotify does not publish a global ranking by December 31, 2026, resolves to the artist ranked first for the year on Spotify's global charts per Chartmasters.",
    category: "Culture",
    emoji: "🎧",
    liquidity: 2500,
    outcomes: ["Taylor Swift", "Bad Bunny", "The Weeknd", "Drake", "Bruno Mars", "Billie Eilish", "Other"],
    startProbabilities: [0.3, 0.25, 0.1, 0.08, 0.09, 0.06, 0.12],
    currentProbabilities: [0.27, 0.34, 0.09, 0.06, 0.08, 0.05, 0.11],
    ageDays: 58,
    daysLeft: 92,
    comments: [
      "Bad Bunny had the halftime show bump AND a stadium tour. Easy.",
      "A Q4 Taylor album drop would flip this in a week.",
    ],
  },
  {
    question: "Will 'Avengers: Doomsday' pass $1B worldwide in its first 10 days?",
    description:
      "Resolves Yes if Avengers: Doomsday (scheduled for December 18, 2026) reaches a cumulative worldwide box office of $1,000,000,000 or more within its first 10 days of release, per Box Office Mojo.",
    rules:
      "Day 1 is the first day of wide release in the US (Thursday previews count toward day 1). The worldwide gross reported by Box Office Mojo at the end of day 10 must be at or above $1B. If the release date moves beyond December 31, 2026, the market resolves No.",
    category: "Culture",
    emoji: "🎬",
    liquidity: 2000,
    startProbabilities: yn(0.45),
    currentProbabilities: yn(0.53),
    ageDays: 20,
    daysLeft: 118,
    comments: [
      "Endgame did $1.2B in its opening weekend alone. The Christmas corridor helps too.",
      "Franchise fatigue is real. Infinity War numbers aren't coming back.",
    ],
  },

  // ───────────────────────────── Politics ─────────────────────────────
  {
    question: "Will a US state ban smartphones in all K-12 schools in 2026?",
    description:
      "Resolves Yes if any US state enacts a statewide law requiring bell-to-bell smartphone bans across all public K-12 schools during 2026.",
    rules:
      "Must be signed into law during calendar 2026 (local time). Policies limited to instructional time only, or that leave the decision to individual districts, do not count.",
    category: "Politics",
    emoji: "🏛️",
    liquidity: 1500,
    startProbabilities: yn(0.5),
    currentProbabilities: yn(0.61),
    ageDays: 22,
    daysLeft: 118,
    comments: [
      "Half the states already have partial bans. Bell-to-bell statewide is the bar.",
      "Wording matters here, read the rules before buying Yes.",
    ],
  },
  {
    question: "Who will win the 2026 US midterms House majority?",
    description:
      "Which party will hold the majority in the US House of Representatives after the November 3, 2026 midterm elections?",
    rules:
      "Resolves according to the party with the most seats when the 120th Congress is sworn in on January 3, 2027, per the House Clerk.",
    category: "Politics",
    emoji: "🗳️",
    liquidity: 5000,
    outcomes: ["Democrats", "Republicans"],
    startProbabilities: [0.5, 0.5],
    currentProbabilities: [0.58, 0.42],
    ageDays: 100,
    daysLeft: 60,
    featured: true,
    comments: ["Generic ballot is D+3 right now.", "Redistricting in Texas changes the math."],
  },
  {
    question: "Republican Senate seats after the 2026 midterms?",
    description:
      "How many seats will Republicans hold in the US Senate when the 120th Congress convenes in January 2027?",
    rules:
      "Resolves based on the official party breakdown published by the Senate (senate.gov) when the 120th Congress is sworn in on January 3, 2027, including any runoffs decided by then. Independents are counted with the party they caucus with. Vacancies are not counted for either party.",
    category: "Politics",
    emoji: "🇺🇸",
    liquidity: 4500,
    outcomes: ["48 or fewer", "49-50", "51-52", "53-54", "55 or more"],
    startProbabilities: [0.1, 0.22, 0.35, 0.25, 0.08],
    currentProbabilities: [0.12, 0.28, 0.36, 0.19, 0.05],
    ageDays: 75,
    daysLeft: 121,
    comments: [
      "The map is brutal for Democrats this cycle. 49-50 is the realistic ceiling.",
      "Maine and North Carolina both look like coin flips to me.",
      "Everyone is sleeping on the Ohio special.",
    ],
  },
  {
    question: "Will the US government shut down on October 1, 2026?",
    description:
      "Resolves Yes if a lapse in federal appropriations begins at 12:00 AM ET on October 1, 2026, the start of fiscal year 2027, because Congress has not enacted full-year appropriations or a continuing resolution.",
    rules:
      "Resolves Yes if OMB directs agencies to begin shutdown procedures for a funding lapse starting October 1, 2026 (ET), even if the lapse lasts less than one day. A continuing resolution signed before midnight resolves No. A partial lapse covering any of the 12 appropriations bills counts as Yes.",
    category: "Politics",
    emoji: "⏳",
    liquidity: 3500,
    startProbabilities: yn(0.35),
    currentProbabilities: yn(0.48),
    ageDays: 40,
    daysLeft: 27,
    comments: [
      "CR talks always go to the wire, but they always land.",
      "No appetite for a shutdown five weeks before the midterms. Buying No.",
      "Depends entirely on whether the health care riders get attached.",
    ],
  },

  // ───────────────────────────── World ─────────────────────────────
  {
    question: "Will there be a ceasefire in Ukraine before 2027?",
    description:
      "Resolves Yes if Russia and Ukraine both officially announce a general ceasefire that holds for at least 30 consecutive days before January 1, 2027.",
    rules:
      "Requires public confirmation from both governments. The 30-day holding period must be complete before 00:00 UTC on January 1, 2027. Localized or humanitarian pauses do not count.",
    category: "World",
    emoji: "🕊️",
    liquidity: 3000,
    startProbabilities: yn(0.3),
    currentProbabilities: yn(0.27),
    ageDays: 55,
    daysLeft: 118,
  },
  {
    question: "Will Israel and Saudi Arabia establish diplomatic relations before 2027?",
    description:
      "Resolves Yes if Israel and Saudi Arabia sign a formal normalization agreement or announce the establishment of official diplomatic relations before January 1, 2027.",
    rules:
      "Requires an official announcement by both governments of full diplomatic relations or a signed normalization agreement (for example under the Abraham Accords framework) before 00:00 UTC on January 1, 2027. Statements of intent, frameworks 'in principle', or trade-only arrangements do not count.",
    category: "World",
    emoji: "🤝",
    liquidity: 2000,
    startProbabilities: yn(0.12),
    currentProbabilities: yn(0.08),
    ageDays: 85,
    daysLeft: 119,
    comments: [
      "Riyadh has been clear about its conditions. Not happening this year.",
      "Cheap lottery ticket if the ceasefire framework holds.",
    ],
  },
  {
    question: "Will China report 2026 GDP growth of 5.0% or higher?",
    description:
      "Resolves Yes if China's National Bureau of Statistics reports full-year 2026 real GDP growth of at least 5.0% in its initial annual release, expected in mid-January 2027.",
    rules:
      "Resolution based on the NBS preliminary full-year 2026 GDP growth figure as first published (typically the third week of January 2027, Beijing time). Later revisions are ignored. A published figure of exactly 5.0% resolves Yes.",
    category: "World",
    emoji: "🇨🇳",
    liquidity: 2500,
    startProbabilities: yn(0.55),
    currentProbabilities: yn(0.47),
    ageDays: 70,
    daysLeft: 138,
    comments: [
      "They have hit the target every non-COVID year. The print will be 5.0 on the nose.",
      "Property drag plus tariffs. The summer data was soft.",
    ],
  },
  {
    question: "Who will win the 2027 French presidential election?",
    description:
      "Who will be elected President of France in the 2027 presidential election, scheduled for April 2027 with a likely second round in May?",
    rules:
      "Resolves to the candidate whose election is proclaimed by France's Constitutional Council after the second round (or the first round if a candidate wins outright). If a listed person does not stand, that outcome resolves to zero. 'Other' covers any candidate not listed.",
    category: "World",
    emoji: "🇫🇷",
    liquidity: 3500,
    outcomes: [
      "Jordan Bardella",
      "Édouard Philippe",
      "Marine Le Pen",
      "Gabriel Attal",
      "Jean-Luc Mélenchon",
      "Bruno Retailleau",
      "Other",
    ],
    startProbabilities: [0.3, 0.2, 0.12, 0.08, 0.1, 0.06, 0.14],
    currentProbabilities: [0.34, 0.22, 0.08, 0.06, 0.09, 0.07, 0.14],
    ageDays: 120,
    daysLeft: 250,
    comments: [
      "Second round Bardella vs Philippe is the base case, and Philippe wins it.",
      "The left is fragmented again. Mélenchon can't win a runoff.",
      "Watch for a late center-right consolidation behind Philippe.",
    ],
  },
];
