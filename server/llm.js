/**
 * Which model answers, and what happens when it cannot.
 *
 * ---------------------------------------------------------------------------
 * The problem this file exists to solve
 *
 * Before this file, four modules each built their own client from one variable:
 *
 *   chat.js L71        new ChatOpenAI({ model: OPENAI_MODEL })   the RAG answer
 *   chat-mcp.js L281   new ChatOpenAI({ model: OPENAI_MODEL })   the search summary
 *   chat-agent.js L205 new ChatOpenAI({ ... useResponsesApi })   the tool caller
 *   chat-agent.js L213 new ChatOpenAI({ ... useResponsesApi })   the forced answer
 *
 * One key, four copies of the decision to use it, and no code anywhere that
 * answers "what if it says no?". When the key was revoked the whole application
 * stopped -- RAG, web search, the agent and the daily assistant -- and the only
 * symptom was `401` buried in a stack trace, because "which provider" was never
 * a concept the code had.
 *
 * Now it is. Every model call goes through a *chain*: an ordered list of
 * providers that all speak the OpenAI wire protocol, so switching between them
 * is a base URL and a model name, not a rewrite.
 *
 * ---------------------------------------------------------------------------
 * Free first, and what "free" means here
 *
 * The user's constraint was explicit: cheap, and if free, then free without a
 * credit card and payable/registerable from inside China. That rules out the
 * obvious answers -- Gemini and Groq need a card or a foreign number -- and
 * leaves three that take a phone number and nothing else:
 *
 *   Zhipu        GLM-4.7-Flash   permanently free, 1 concurrency, 200K context
 *   SiliconFlow  Qwen3-8B        free tier, 30 req/min, no monthly cap
 *   Bailian      qwen-turbo      1M free tokens per model, 90 days, real-name
 *
 * All three are OpenAI-compatible, which is the only reason one file can hold
 * all of them. All three support function calling, which is what the agent in
 * chat-agent.js needs -- and that is *not* a given: a provider that ignores
 * `tools` would turn the agent into a model that never searches, silently.
 * Hence the `tools` flag in the table below and the degradation in runAgent.
 *
 * A fourth option costs nothing and needs no account at all: a local Ollama.
 * It is opt-in because it cannot be detected synchronously -- see resolveChain.
 *
 * ---------------------------------------------------------------------------
 * What the fallback is NOT allowed to do
 *
 *   - Retry the same provider. A revoked key does not un-revoke itself, and a
 *     retry loop is a bill with extra steps. One attempt per provider per call.
 *   - Fall back on a bad request. A 400 means *we* sent something wrong; the
 *     next provider would reject it too, and multiplying one broken request
 *     across five providers makes the bug harder to see, not easier.
 *   - Leave a provider hot. A provider that just failed is put in a cooldown, so
 *     a dead key costs one failed round trip every ten minutes instead of one on
 *     every request. This is the difference between "the app works and one
 *     provider is skipped" and "every request takes +400ms to reach the answer".
 *   - Re-run a tool call. A retry happens per model call, never per round: the
 *     agent pins its provider, and a mid-conversation failure resumes on the
 *     next provider *from the round that failed*. Searches are not replayed --
 *     they cost real money on a 250/month plan.
 */

import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Embeddings } from "@langchain/core/embeddings";

/* ---------------------------------------------------------------------------
 * 1. The table
 *
 * One row per provider. Everything that differs between them is data: the env
 * var holding the key, the base URL, the model id, whether tool calling works,
 * whether it needs the Responses API, and -- for the reader, not the code --
 * what it costs and where to sign up.
 *
 * `baseUrl: null` means the SDK's own default (api.openai.com). Everything else
 * is a drop-in OpenAI-compatible endpoint; that is the whole trick. Every URL is
 * overridable by environment variable, which is not a testing convenience --
 * it is how you point one of these at a company gateway or a local proxy without
 * editing code.
 * ------------------------------------------------------------------------- */
const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    baseUrl: () => process.env.OPENAI_BASE_URL ?? null,
    model: () => process.env.OPENAI_MODEL ?? "gpt-6-astra",
    embedModel: () => process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small",
    tools: true,
    // gpt-6-astra rejects function tools on /v1/chat/completions ("Function
    // tools with reasoning_effort are not supported... use /v1/responses"), so
    // the *tool-calling* call has to switch wire protocols. The plain answer
    // does not, and must not: the two APIs return different content shapes.
    responsesForTools: true,
    cost: "paid",
    signup: "https://platform.openai.com/api-keys",
  },
  {
    id: "zhipu",
    label: "Zhipu GLM-4.7-Flash",
    keyEnv: "ZHIPU_API_KEY",
    baseUrl: () => process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    model: () => process.env.ZHIPU_MODEL ?? "glm-4.7-flash",
    embedModel: () => process.env.ZHIPU_EMBED_MODEL ?? "embedding-3",
    tools: true,
    responsesForTools: false,
    cost: "free",
    signup: "https://open.bigmodel.cn (phone / WeChat signup, no card)",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    keyEnv: "SILICONFLOW_API_KEY",
    baseUrl: () => process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1",
    model: () => process.env.SILICONFLOW_MODEL ?? "Qwen/Qwen3-8B",
    embedModel: () => process.env.SILICONFLOW_EMBED_MODEL ?? "BAAI/bge-m3",
    tools: true,
    responsesForTools: false,
    cost: "free",
    signup: "https://siliconflow.cn (phone signup, no card)",
  },
  {
    id: "dashscope",
    label: "Alibaba Bailian (Qwen)",
    keyEnv: "DASHSCOPE_API_KEY",
    baseUrl: () => process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: () => process.env.DASHSCOPE_MODEL ?? "qwen-turbo",
    embedModel: () => process.env.DASHSCOPE_EMBED_MODEL ?? "text-embedding-v3",
    tools: true,
    responsesForTools: false,
    // Per-model 1M-token free grant, 90 days, north-China region only.
    cost: "free-quota",
    signup: "https://bailian.console.aliyun.com (Alibaba account, real-name)",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    // No key at all -- and therefore no way to tell whether it is running
    // without asking it, which resolution cannot do synchronously. Opt-in.
    keyEnv: null,
    baseUrl: () => process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    model: () => process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
    embedModel: () => process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
    // Depends on which model was pulled, so it is not promised.
    tools: false,
    responsesForTools: false,
    cost: "free-local",
    signup: "https://ollama.com then `ollama pull qwen2.5:7b`",
  },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

/**
 * Default order: the paid one first, everything free after it.
 *
 * That is literally the behaviour asked for -- "when the ChatGPT API dies, fall
 * back to a cheap or free one" -- and it is the right default for a project that
 * already has an OpenAI key. For "never spend anything", set
 * LLM_PROVIDER_ORDER=zhipu,siliconflow,ollama and OpenAI is not even tried.
 */
const DEFAULT_CHAT_ORDER = ["openai", "zhipu", "siliconflow", "dashscope", "ollama"];

/**
 * Embeddings get their own order because availability differs: the free chat
 * models are not necessarily free embedders. `local` is last and is not a
 * provider at all -- it always works, so this chain can never be empty.
 */
const DEFAULT_EMBED_ORDER = ["openai", "dashscope", "siliconflow", "zhipu", "ollama", "local"];

const orderFromEnv = (envVar, fallback) => {
  const raw = process.env[envVar]?.trim();
  if (!raw) return fallback;

  const requested = raw.split(",").map((id) => id.trim()).filter(Boolean);
  const known = requested.filter((id) => PROVIDER_BY_ID.has(id) || id === "local");
  const unknown = requested.filter((id) => !known.includes(id));
  if (unknown.length) {
    // Warn and continue: a typo in a schedule should not take the server down.
    console.warn(`[llm] ${envVar}: ignoring unknown provider(s): ${unknown.join(", ")}`);
  }
  return known;
};

/* ---------------------------------------------------------------------------
 * 2. Availability
 *
 * "Configured" is the only check made at chain-resolution time, and it is
 * deliberately offline: whether the key is *valid* is something only the API can
 * say, and asking would mean a network round trip before every request. Validity
 * is discovered by trying, and remembered by the cooldown below.
 * ------------------------------------------------------------------------- */
const isConfigured = (provider) => {
  if (!provider.keyEnv) return Boolean(process.env.OLLAMA_MODEL);
  return Boolean(process.env[provider.keyEnv]);
};

const apiKeyOf = (provider) => (provider.keyEnv ? process.env[provider.keyEnv] : "ollama");
const baseUrlOf = (provider) =>
  typeof provider.baseUrl === "function" ? provider.baseUrl() : provider.baseUrl;

/* ---------------------------------------------------------------------------
 * 3. Classifying a failure -- the decision the old code never made
 *
 * The distinction that matters is not which error it was but who can fix it:
 *
 *   the provider's fault  -> try the next one          (auth, quota, rate limit,
 *                                                       network, 5xx, bad model)
 *   our fault             -> stop, do not multiply it  (400, 422, unknown)
 *
 * A revoked key and an exhausted free tier are both "this provider is done for
 * now"; a 400 is "this request is wrong" and would be wrong at the next
 * provider too. Getting that backwards is how a fallback chain turns one bug
 * into five failed requests.
 *
 * Message matching comes before status matching because the interesting cases
 * are the ones where HTTP is lying: OpenAI reports an exhausted account as
 * `429 insufficient_quota`, which looks exactly like a rate limit and needs a
 * thirty-minute cooldown rather than a twenty-second one.
 * ------------------------------------------------------------------------- */
const ERROR_KINDS = {
  auth: { retryable: true, cooldownEnv: "LLM_AUTH_COOLDOWN_MS", cooldownMs: 600_000 },
  quota: { retryable: true, cooldownEnv: "LLM_QUOTA_COOLDOWN_MS", cooldownMs: 1_800_000 },
  rate_limit: { retryable: true, cooldownEnv: "LLM_RATE_LIMIT_COOLDOWN_MS", cooldownMs: 20_000 },
  network: { retryable: true, cooldownEnv: "LLM_NETWORK_COOLDOWN_MS", cooldownMs: 30_000 },
  timeout: { retryable: true, cooldownEnv: "LLM_NETWORK_COOLDOWN_MS", cooldownMs: 30_000 },
  server: { retryable: true, cooldownEnv: "LLM_NETWORK_COOLDOWN_MS", cooldownMs: 30_000 },
  model_missing: { retryable: true, cooldownEnv: "LLM_AUTH_COOLDOWN_MS", cooldownMs: 600_000 },
  bad_request: { retryable: false, cooldownEnv: null, cooldownMs: 0 },
  unknown: { retryable: false, cooldownEnv: null, cooldownMs: 0 },
};

const STATUS_KINDS = new Map([
  [400, "bad_request"],
  [401, "auth"],
  [402, "quota"],
  [403, "auth"],
  [404, "model_missing"],
  [408, "timeout"],
  [413, "bad_request"],
  [422, "bad_request"],
  [429, "rate_limit"],
  [500, "server"],
  [501, "server"],
  [502, "server"],
  [503, "server"],
  [504, "timeout"],
]);

/** Dig a status code out of however the SDK decided to wrap it this time. */
const statusOf = (error) => {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.cause?.status,
    error?.error?.status,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value >= 100 && value < 600) return value;
  }
  return null;
};

const MESSAGE_RULES = [
  // An exhausted balance wears a 429, and must not be treated as a burst.
  [/(insufficient_quota|exceeded your current quota|quota exceeded|no credit|balance is insufficient|欠费|余额不足|额度不足)/i, "quota"],
  [/(invalid_api_key|invalid api key|incorrect api key|api key not valid|unauthorized|authentication fails?|invalidated|api key.*(expired|revoked|disabled))/i, "auth"],
  [/(rate limit|rate_limit|too many requests|requests per minute|tpm.*limit)/i, "rate_limit"],
  [/(model.*(not found|does not exist|unsupported|no such)|unknown model|invalid model)/i, "model_missing"],
  [/(econnrefused|enotfound|eai_again|econnreset|epipe|socket hang up|fetch failed|network|proxy)/i, "network"],
  [/(timed? ?out|timeout|aborted|etimedout)/i, "timeout"],
  [/(context length|maximum context|too long|reduce the length)/i, "bad_request"],
];

export const classify = (error) => {
  const message = [
    error?.message ?? "",
    error?.code ?? "",
    error?.name ?? "",
    typeof error?.response?.data === "string" ? error.response.data : JSON.stringify(error?.response?.data ?? ""),
  ].join(" ");

  const byMessage = MESSAGE_RULES.find(([pattern]) => pattern.test(message));
  const status = statusOf(error);
  // The message wins: `429 insufficient_quota` is a quota problem that happens to
  // arrive as a rate-limit status, and the cooldown is what depends on getting
  // this right.
  const kind = byMessage?.[1] ?? STATUS_KINDS.get(status) ?? "unknown";
  const rule = ERROR_KINDS[kind];

  const cooldownMs = rule.cooldownEnv
    ? Number(process.env[rule.cooldownEnv] ?? rule.cooldownMs)
    : 0;

  return { kind, retryable: rule.retryable, cooldownMs, status, message: error?.message ?? String(error) };
};

/* ---------------------------------------------------------------------------
 * 4. Cooldowns -- one per (provider, capability)
 *
 * Process-local and deliberately not persisted: this is a cache of "we just
 * asked and the answer was no", and the honest lifetime of that fact is the
 * lifetime of the process. Restart after fixing a key and the slate is clean.
 *
 * The key is a PAIR, not a provider id, and that is not a detail. A provider is
 * two products with two price lists: Bailian grants its free tokens *per model*,
 * so an exhausted embedding quota sits next to a perfectly healthy chat model.
 * Keying the cache by provider alone meant the first PDF upload to meet an
 * embedding 402 also silenced chat -- and the symptom pointed nowhere, because
 * /llm/providers cheerfully reported the provider as configured while /chat
 * answered "no model provider is available". Found by the verification run,
 * phase C, not by reading this file.
 *
 * What splitting them costs: an account-wide problem is rediscovered once per
 * capability, i.e. at most one extra failed call per cooldown window. What it
 * buys: a per-model quota cannot take down an unrelated feature.
 * ------------------------------------------------------------------------- */
const cooldowns = new Map(); // "<capability>:<providerId>" -> { until, kind, reason }

const cooldownKey = (capability, providerId) => `${capability}:${providerId}`;

/**
 * Mask anything that looks like a credential before it is stored, logged, or
 * returned to a client.
 *
 * Not hypothetical: OpenAI's own 401 body reads "Incorrect API key provided:
 * sk-proj-abc***wxyz". The error message produced by a credential failure IS a
 * partial credential. That message reaches two places that leave this process --
 * the cooldown reason on GET /llm/providers, and console.warn -- and both were
 * written to be helpful, and both would have been helpful to whoever is reading
 * over a shoulder.
 *
 * The verification run caught this the same way it caught the cooldown bug: by
 * asserting on the wire instead of on the code. chat-agent.js had already
 * learned not to forward the raw provider message; the diagnostic route had
 * not.
 *
 * Deliberately simple -- match the shapes that actually occur (sk-..., gsk_...,
 * Bearer ...) rather than trying to be clever. Over-masking a reason still
 * leaves it readable; a leaked key does not come back.
 */
const scrubSecrets = (text) =>
  String(text ?? "")
    .replace(/\b(sk|gsk|api|key|token)[-_][A-Za-z0-9_*\-]{6,}/gi, "$1-***")
    .replace(/\b(bearer)\s+\S+/gi, "$1 ***");

/** The live entry for one (capability, provider), or null. Expiry is lazy. */
const cooldownFor = (capability, providerId, now = Date.now()) => {
  const key = cooldownKey(capability, providerId);
  const entry = cooldowns.get(key);
  if (!entry) return null;
  if (entry.until <= now) {
    cooldowns.delete(key);
    return null;
  }
  return entry;
};

const inCooldown = (capability, providerId) => cooldownFor(capability, providerId) !== null;

const markCooldown = (capability, providerId, verdict, error) => {
  if (!verdict.cooldownMs) return;
  cooldowns.set(cooldownKey(capability, providerId), {
    until: Date.now() + verdict.cooldownMs,
    kind: verdict.kind,
    reason: scrubSecrets(error?.message).slice(0, 200),
  });
};

/** Cooldown state in a shape a human (or GET /llm/providers) can read. */
export const cooldownReport = (now = Date.now()) =>
  [...cooldowns.entries()]
    .filter(([, entry]) => entry.until > now)
    .map(([key, entry]) => {
      const [capability, provider] = key.split(":");
      return {
        provider,
        capability,
        kind: entry.kind,
        msRemaining: entry.until - now,
        reason: entry.reason,
      };
    });

/** Used by the verification script and by nothing in production. */
export const resetCooldowns = () => cooldowns.clear();

/* ---------------------------------------------------------------------------
 * 5. The chain
 * ------------------------------------------------------------------------- */
const configuredProviders = () =>
  PROVIDERS.filter(isConfigured).filter((provider) => PROVIDER_BY_ID.has(provider.id));

/**
 * The providers this process may try, in order.
 *
 * `needsTools` is a *preference*, not a filter. When the agent asks for tools
 * and no tool-capable provider is configured, returning an empty chain would
 * turn a quality problem ("the search may not work") into an outage ("nothing
 * works"). So it degrades: the chain is handed over whole, and the session
 * reports `toolsUnverified` so the caller can say so out loud.
 */
const resolveChain = ({ needsTools = false, embedding = false } = {}) => {
  const order = orderFromEnv(
    embedding ? "EMBEDDING_PROVIDER_ORDER" : "LLM_PROVIDER_ORDER",
    embedding ? DEFAULT_EMBED_ORDER : DEFAULT_CHAT_ORDER
  );

  const resolved = order
    .map((id) => PROVIDER_BY_ID.get(id))
    .filter((provider) => provider && isConfigured(provider));

  if (!needsTools) return resolved;

  const toolCapable = resolved.filter((provider) => provider.tools);
  return toolCapable.length ? toolCapable : resolved;
};

const buildChatModel = (provider, { tools } = {}) =>
  new ChatOpenAI({
    model: provider.model(),
    apiKey: apiKeyOf(provider),
    ...(baseUrlOf(provider) ? { configuration: { baseURL: baseUrlOf(provider) } } : {}),
    // Only the tool-calling shape needs the Responses API, and only OpenAI does.
    ...(provider.responsesForTools && tools?.length ? { useResponsesApi: true } : {}),
  });

/**
 * Flat text out of a message's content, whichever shape came back.
 *
 * Both shapes are real and the difference is silent:
 *
 *   /v1/chat/completions  content = "17 x 23 = 391."                     string
 *   /v1/responses         content = [{type:"text", text:"17 x 23 = 391."}]
 *
 * `String(content)` on the second gives "[object Object]" -- a plausible-looking
 * value that renders in the UI as `[object Object]` and never throws. Every
 * consumer of a model response has to go through here.
 */
export const contentToText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => typeof block === "string" || block?.type === "text")
    .map((block) => (typeof block === "string" ? block : block.text ?? ""))
    .join("")
    .trim();
};

/**
 * The error thrown when nothing is configured -- written for the person who has
 * to fix it, because the alternative is a 401 from a provider they never chose.
 */
const noProviderError = (attempts) => {
  const detail = attempts.length
    ? ` Tried and failed: ${attempts.map((a) => `${a.provider} (${a.kind})`).join(", ")}.`
    : "";
  return new Error(
    "No model provider is available. Set ZHIPU_API_KEY (free forever, phone " +
      "signup, no credit card, https://open.bigmodel.cn) or SILICONFLOW_API_KEY " +
      "(free tier, https://siliconflow.cn) in server/.env and restart -- a local " +
      "Ollama works too (set OLLAMA_MODEL). See server/.env.example." +
      detail
  );
};

/* ---------------------------------------------------------------------------
 * 6. A session: one conversation, one provider, for as long as it works
 *
 * The agent makes up to three model calls per question. If provider A answers
 * round 1 and then fails, switching to B for round 2 is fine -- the message
 * history is replayed either way. What is NOT fine is restarting the whole
 * conversation on B, because that would re-run the tool calls, and tool calls
 * cost money (SerpApi: 250 free searches a month, total).
 *
 * So the session pins whichever provider answered first and only moves when that
 * provider actually fails. The pin is per session, not global: two concurrent
 * users are not made to agree.
 * ------------------------------------------------------------------------- */
export const chatSession = ({ needsTools = false, label = "chat" } = {}) => {
  const chain = resolveChain({ needsTools });
  const attempts = [];
  let pinnedId = null;

  const ordered = () => {
    const live = chain.filter((provider) => !inCooldown("chat", provider.id));
    if (!pinnedId) return live;
    const index = live.findIndex((provider) => provider.id === pinnedId);
    // Pinned first, everything else in its configured order -- and if the pin is
    // cooling down it is simply absent, which is the intended outcome.
    if (index <= 0) return live;
    return [live[index], ...live.slice(0, index), ...live.slice(index + 1)];
  };

  return {
    label,
    get attempts() {
      return attempts;
    },
    /** Did we forget to check tool support? Reported, not hidden. */
    get toolsUnverified() {
      return needsTools && !chain.some((provider) => provider.tools);
    },
    /** Which provider actually answered last -- for logs and message metadata. */
    get providerId() {
      return pinnedId;
    },

    /**
     * One model call, with fallback.
     *
     * `tools` is passed per call rather than bound once, because the summarizer
     * in chat-agent.js deliberately has no tools -- that is what guarantees the
     * loop ends.
     */
    async invoke(messages, { tools } = {}) {
      const candidates = ordered();
      if (!candidates.length) throw noProviderError(attempts);

      for (const provider of candidates) {
        try {
          const model = buildChatModel(provider, { tools });
          const runnable = tools?.length ? model.bindTools(tools) : model;
          const reply = await runnable.invoke(messages);
          pinnedId = provider.id;
          return reply;
        } catch (error) {
          const verdict = classify(error);
          attempts.push({ provider: provider.id, kind: verdict.kind, message: verdict.message });

          // Not the provider's fault: stop here rather than send the same broken
          // request to everyone else.
          if (!verdict.retryable) throw error;

          markCooldown("chat", provider.id, verdict, error);
          console.warn(
            `[llm] ${label}: ${provider.id} -> ${verdict.kind} (${scrubSecrets(verdict.message).slice(0, 120)}); ` +
              `falling back`
          );
        }
      }

      throw noProviderError(attempts);
    },
  };
};

/* ---------------------------------------------------------------------------
 * 7. Embeddings, including one that cannot fail
 *
 * Indexing a PDF embeds every chunk, so this is the expensive half of RAG and
 * the half that made /upload depend on a paid key. Two things follow:
 *
 *   - it has its own chain, because "which providers are free" differs between
 *     chat models and embedders;
 *   - it ends in a local implementation, so a PDF can always be indexed.
 *
 * The local one is lexical, not semantic, and the code says so rather than
 * pretending otherwise: it hashes word and character-bigram tokens into a fixed
 * vector, so cosine similarity measures *shared tokens*. It will find the
 * paragraph that uses the same words as the question. It will not find the
 * paragraph that means the same thing in different words -- which is the entire
 * reason a real embedding model exists. Good enough to keep the app usable with
 * no keys, and labelled in the API response so nobody mistakes it for the real
 * thing.
 * ------------------------------------------------------------------------- */
const HASH_DIMENSIONS = Number(process.env.LOCAL_EMBED_DIMENSIONS ?? 512);

/**
 * Tokens for the hash embedder.
 *
 * Chinese is the reason this is not just `.split(/\W+/)`: that yields one token
 * per whole sentence, so two sentences about the same thing would look
 * unrelated. Individual characters are too fine (every sentence shares "的").
 * Character bigrams are the standard middle ground and cost nothing.
 */
const tokenize = (text) => {
  const tokens = [];
  const lowered = String(text).toLowerCase();
  const latin = lowered.match(/[a-z0-9]+/g) ?? [];
  tokens.push(...latin);

  for (const run of lowered.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
};

/** FNV-1a, 32-bit. Any cheap string hash works; this one is short and stable. */
const hashToken = (token) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const hashVector = (text, dimensions) => {
  const vector = new Array(dimensions).fill(0);
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  for (const [token, count] of counts) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    // The top bit picks a sign. Without it every token only ever adds, and
    // unrelated documents pile up in the same corner of the space.
    const sign = (hash >>> 31) === 0 ? 1 : -1;
    // 1 + log(tf): a word repeated five times is more relevant than once, but
    // not five times more.
    vector[index] += sign * (1 + Math.log(count));
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
};

class LocalHashEmbeddings extends Embeddings {
  constructor(dimensions = HASH_DIMENSIONS) {
    super({});
    this.dimensions = dimensions;
  }
  async embedDocuments(documents) {
    return documents.map((document) => hashVector(document, this.dimensions));
  }
  async embedQuery(document) {
    return hashVector(document, this.dimensions);
  }
}

export const LOCAL_EMBEDDER = { id: "local", label: "local hash (lexical, no key, always available)" };

const buildEmbeddings = (provider) =>
  new OpenAIEmbeddings({
    model: provider.embedModel(),
    apiKey: apiKeyOf(provider),
    ...(baseUrlOf(provider) ? { configuration: { baseURL: baseUrlOf(provider) } } : {}),
  });

/**
 * The embedder for one index: chosen on the first batch, then locked.
 *
 * The shape here -- an object exposing embedDocuments / embedQuery rather than a
 * function returning vectors -- is dictated by MemoryVectorStore, which holds an
 * embedder and calls those two methods (memory.js L137, L192). The *sticky*
 * part is not a convenience. A store holds one set of vectors, and searching it
 * with a different embedding model compares numbers that live in different
 * spaces: no error, no warning, just retrieval returning the wrong passages with
 * all the confidence of the right ones. So the choice is made once, inside
 * embedDocuments, and embedQuery is bound to it afterwards.
 *
 * The choice may still fail over, but only on the document call: whichever
 * provider first successfully embeds the batch owns the index. Whole-batch
 * rather than per-chunk, because half a PDF embedded by OpenAI and half by the
 * local hash is not a degraded index, it is a corrupt one.
 *
 * Why the fallback wraps the *call* and not the construction: building an
 * OpenAIEmbeddings client does not touch the network, so a client that
 * constructs fine can still fail on its first request -- which is exactly the
 * dead-key case this whole file is about. Only the batch call proves anything.
 */
export const createStickyEmbedder = () => {
  let chosen = null;
  const attempts = [];
  const candidates = () =>
    resolveChain({ embedding: true }).filter((provider) => !inCooldown("embed", provider.id));

  return {
    get id() {
      return chosen?.id ?? null;
    },
    get label() {
      return chosen?.label ?? null;
    },
    get isLocal() {
      return chosen?.id === "local";
    },
    get attempts() {
      return attempts;
    },
    /** What it would try, in order, right now. */
    get plannedOrder() {
      return [...candidates().map((provider) => provider.id), "local"];
    },

    async embedDocuments(documents) {
      if (chosen) return chosen.embedder.embedDocuments(documents);

      for (const provider of candidates()) {
        try {
          const embedder = buildEmbeddings(provider);
          const vectors = await embedder.embedDocuments(documents);
          chosen = { id: provider.id, label: provider.label, embedder };
          return vectors;
        } catch (error) {
          const verdict = classify(error);
          attempts.push({ provider: provider.id, kind: verdict.kind, message: verdict.message });
          // A malformed request would be malformed everywhere; only provider-side
          // failures are worth walking past.
          if (!verdict.retryable) throw error;
          markCooldown("embed", provider.id, verdict, error);
          console.warn(`[llm] embeddings: ${provider.id} -> ${verdict.kind}; falling back`);
        }
      }

      const embedder = new LocalHashEmbeddings();
      chosen = { id: "local", label: LOCAL_EMBEDDER.label, embedder };
      return embedder.embedDocuments(documents);
    },

    async embedQuery(query) {
      if (!chosen) {
        throw new Error("embedQuery was called before embedDocuments: this index has no embedder.");
      }
      if (chosen.id === "local") return chosen.embedder.embedQuery(query);

      try {
        return await chosen.embedder.embedQuery(query);
      } catch (error) {
        // Deliberately no fallback here, and this is the one place where "keep
        // going" would be worse than "stop". Falling back to the local hash
        // would compare the question against vectors from a *different* model --
        // returning wrong passages instead of an error, which is the only
        // outcome worse than a failed request.
        const verdict = classify(error);
        throw new Error(
          `The embedder that built this index (${chosen.id}) failed (${verdict.kind}): ` +
            `${verdict.message}. Re-upload the document to rebuild the index.`
        );
      }
    },
  };
};

/* ---------------------------------------------------------------------------
 * 8. What the fallback chain looks like right now
 *
 * Read-only, offline, and the only way to answer "why did my question go to
 * GLM?" without reading the logs. No key values, only whether one is present.
 * ------------------------------------------------------------------------- */
export const describeProviders = () => ({
  chatOrder: resolveChain().map((provider) => provider.id),
  configuredOrder: orderFromEnv("LLM_PROVIDER_ORDER", DEFAULT_CHAT_ORDER),
  embeddingOrder: [...resolveChain({ embedding: true }).map((p) => p.id), "local"],
  coolingDown: cooldownReport(),
  providers: PROVIDERS.map((provider) => {
    const configured = isConfigured(provider);
    const describe = (entry) =>
      entry
        ? { kind: entry.kind, msRemaining: entry.until - Date.now(), reason: entry.reason }
        : null;
    // Reported per capability, because the two fail independently -- see 3/4.
    const chatCooldown = cooldownFor("chat", provider.id);

    return {
      id: provider.id,
      label: provider.label,
      model: provider.model(),
      embedModel: provider.embedModel(),
      cost: provider.cost,
      signup: provider.signup,
      keyEnv: provider.keyEnv,
      configured,
      // "usable" is what a caller actually wants to know, and it is still a
      // guess: configured, and not cooling down for chat. Only a real call can
      // prove the rest.
      usable: configured && !chatCooldown,
      tools: provider.tools,
      useResponsesApiForTools: provider.responsesForTools,
      chatCooldown: describe(chatCooldown),
      embedCooldown: describe(cooldownFor("embed", provider.id)),
    };
  }),
});

export { PROVIDERS };
