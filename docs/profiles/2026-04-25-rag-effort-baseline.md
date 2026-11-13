# RAG Effort Profile — Baseline (2026-04-25)

Profile run on production at commit `a806390` against the E2E test project (after F1/F2/F3 fixes deployed and graph backfill applied). Captures latency + answer-quality across the model and reasoning-effort matrix.

**Purpose:** Establish a baseline so future model swaps (gpt-5.5, etc.) and config changes (default depth, reasoning effort) can be objectively compared.

**To re-run:** `bash scripts/rag-profile.sh [outdir]`. See script header for prerequisites — requires the standard E2E test project + content already populated, plus entity backfill done. Don't edit the pinned questions or configurations without recording it as a new baseline; comparisons depend on the inputs being stable.

---

## Setup

| | |
|--|--|
| Date | 2026-04-25 |
| API commit | `a806390` |
| Endpoint | `https://your-app.your-env.region.azurecontainerapps.io` |
| Project | E2E test project, 7 content items (DOC text, 3 file uploads PDF/IMG/AUDIO, 3 URL ingests YouTube/arXiv/blog) plus 1 root todo + 1 subtask + 1 grandchild |
| Graph state | Backfilled: 110 edges across the project's chunks (DOC=9, PDF=13, IMG=5, AUDIO=4, ARXIV=32, BLOG=38, YT=4, todos=5) |
| Models | `gpt-5.4` (chat completions) for fast, `gpt-5.4-pro` (Responses API, reasoning) for thorough |
| Embeddings | Gemini Embedding 2 (3072d) |
| Entity classifier | Claude Haiku 4.5 |

### Pinned questions

| ID | Question | Type |
|----|----------|------|
| Q1 | What is pgvector? | Single-fact definition |
| Q2 | Compare HNSW and IVFFlat tradeoffs based on what I have saved. | Two-source comparison |
| Q3 | Across all my saved material, summarize the embedding-model vs index-type design choices and their tradeoffs. | Multi-hop synthesis |

### Configs (3 questions × 4 configs = 12 calls planned, 9 succeeded)

| Label | Depth | Reasoning effort | Status |
|-------|-------|------------------|--------|
| fast | fast | n/a (no reasoning) | ✅ runs |
| thorough.low | thorough | low | ❌ **HTTP 400** — gpt-5.4-pro on Foundry rejects effort=low (`"param": "reasoning.effort"`) |
| thorough.medium | thorough | medium (Azure default) | ✅ runs |
| thorough.high | thorough | high | ✅ runs |

`thorough.low` failures are a model limitation, not a code bug. Newer models (gpt-5.5+) may expose more effort levels — re-test once available.

---

## Latency results

| Question | fast (gpt-5.4) | thorough.medium (gpt-5.4-pro) | thorough.high (gpt-5.4-pro) |
|----------|---------------:|------------------------------:|----------------------------:|
| Q1 — definition | **1.9 s** | 41.1 s (×22) | 61.7 s (×33) |
| Q2 — comparison | **5.9 s** | 128.8 s (×22) | 210.1 s (×36) |
| Q3 — multi-hop synth | **15.7 s** | 146.2 s (×9) | 239.7 s (×15) |

`(×N)` = ratio relative to fast.

### Phase breakdown (typical thorough call)

| Phase | Time | Notes |
|-------|-----:|-------|
| classify | 0 ms | Caller forced depth, classifier skipped |
| embed | 200-400 ms | Gemini Embedding 2 |
| db_scan | 5-220 ms | pgvector cosine, sequential scan |
| graph | 5-15 ms | chunk_entities expansion |
| **synthesize** | **40-240 s** | **>99% of total time** — all in the model HTTP call |
| total | matches synth + ~500 ms | retrieval pipeline contributes <1% |

For thorough calls, **53-65% of output tokens are reasoning tokens** (invisible "thinking"). The latency is the model thinking, not our pipeline or network.

---

## Answer length / verbosity

| Question | fast | thorough.medium | thorough.high |
|----------|-----:|---------------:|--------------:|
| Q1 — chars | 187 | 173 | 239 |
| Q2 — chars | 1277 | 1360 | 1178 |
| Q3 — chars | 3537 | 2968 | 2195 |
| Q3 — lines | 71 | 58 | 24 |

Counterintuitive: **fast produced longer, more structured Q3 answer** than thorough.high.

---

## Quality assessment (qualitative)

**Q1 — definitional.** All three answers say the same thing in 1-2 sentences with citations. high adds "...has become a common vector store choice" — minor flavor. **No meaningful quality gain from reasoning.**

**Q2 — comparison.** All three cover identical tradeoffs and cite the same chunks. medium adds insertion-cost detail and cites Azure B1ms specifically. high adds Voronoi-cell terminology and is the most condensed. Fast has a strong "practical tradeoff in your setup is..." closing summary that's arguably the best UX of the three. **All three are competent. None is strictly worse.**

**Q3 — multi-hop synth.** fast produced the most detailed structured response (decision matrix, fallback options enumerated, longest of all three). thorough.medium is comparable but tighter, includes one ambiguity flag the others missed. thorough.high is the most concise (24 bullet lines vs 71). **Fast is at least as informative as the reasoning model variants here.** The reasoning model is not visibly synthesizing better than the chat model on the retrieval-grounded tasks.

### Verdict

For our retrieval-grounded RAG use case (where the relevant context is already passed in), the reasoning model pays **22-36× the latency for marginal-to-zero quality gain**. The Haiku auto-routing classifier is making "thorough" recommendations that don't actually need the reasoning tier.

---

## Decision

Apply **fast as the default depth** (was `auto`). Keep `auto` and `thorough` available as opt-in via the body parameter. Keep the depth classifier code intact — it's still used for query-entity extraction (which feeds graph expansion and IS valuable).

When **gpt-5.5 quota lands** (estimated 1-5 days, weekend may delay): re-run this profile with gpt-5.5 added as a 5th, 6th, 7th column (fast / thorough.low / thorough.medium / thorough.high) and decide whether to swap any tier or re-enable `auto` as default.

---

## Verbatim baseline answers

These are the exact responses we captured. Re-runs of the same script may differ slightly due to LLM nondeterminism but should converge on the same content. Significant content drift is signal something changed.

### Q1 — "What is pgvector?"

#### fast (gpt-5.4) — 1.9 s

```
pgvector is a Postgres/PostgreSQL extension that adds vector similarity search to standard PostgreSQL. It supports index types including IVFFlat, HNSW, and exact sequential scan [1] [3].
```

#### thorough.medium (gpt-5.4-pro, effort=medium) — 41.1 s

```
pgvector is a PostgreSQL extension that adds vector similarity search to standard Postgres. It supports index types such as IVFFlat, HNSW, and exact sequential scan [1][3].
```

#### thorough.high (gpt-5.4-pro, effort=high) — 61.7 s

```
pgvector is a PostgreSQL extension that adds vector similarity search to Postgres. It supports index types like IVFFlat, HNSW, and exact sequential scan, and has become a common vector store choice for teams already using Postgres [1][3].
```

### Q2 — "Compare HNSW and IVFFlat tradeoffs based on what I have saved."

#### fast (gpt-5.4) — 5.9 s

```
Based on your saved notes:

- **HNSW** gives **better recall** than IVFFlat, but costs more in **build time** and **memory** [1], [6].
- **IVFFlat** is **faster to build** and generally lighter on memory, but its recall depends heavily on tuning, especially the **`lists`** parameter and **probe count** at query time [6].
- For **3072-dimensional embeddings** like **Gemini Embedding 2** or **OpenAI text-embedding-3-large**, **HNSW initialization may exceed memory limits on small Postgres tiers** [1], [6].
- In your notes, for **DevTrail**, the choice was to **avoid HNSW** and use **sequential scan only**, because the corpus is small enough that latency stays **well below 100ms/query**; adding HNSW would require **upsizing the DB tier or reducing embedding dimensions** [5], [6].
- You also noted that a **graph layer** was added to help recover recall that HNSW might otherwise improve, instead of paying the memory/infrastructure cost at the vector index layer [5], [6].

So the practical tradeoff in your setup is:

- **Choose HNSW** if you want **higher recall** and can afford **more memory and slower index builds**
- **Choose IVFFlat** if you want **lower resource usage and faster builds**, but accept **more tuning sensitivity and lower recall** [1], [6]
```

#### thorough.medium (gpt-5.4-pro, effort=medium) — 128.8 s

```
Based on your saved notes:

- **HNSW** gives **better recall** than IVFFlat, but it costs more in **build time** and **memory** [1][6].
- **IVFFlat** is **faster to build** than HNSW, but its recall depends heavily on the **`lists`** setting and the number of **probes** used at query time [6].
- **Insertions** are also more expensive with **HNSW**, because each new vector has to traverse and update the graph structure [6].
- For **3072-dimensional embeddings** (like Gemini Embedding 2 or OpenAI `text-embedding-3-large`), **HNSW initialization may exceed memory limits on small Postgres tiers**; your notes call out small tiers such as **Azure B1ms 2GB** as an example [1][6].

In your current setup, the practical conclusion seems to be:

- For a **single-user, low-thousands-of-chunks corpus**, **sequential scan** is still **well below 100 ms/query**, so HNSW is not necessary yet [5][6].
- Adding HNSW would likely require either **upsizing the DB tier** or **reducing embedding dimensions**, both of which have tradeoffs [5][6].
- To offset the recall gap from not using HNSW, you added a **graph layer** (`entities` + `chunk_entities`) that expands retrieval along entity edges [5][6].

So the short version is: **HNSW = better recall, higher memory/build cost**; **IVFFlat = cheaper/faster, but weaker and more parameter-sensitive recall** [1][6].
```

#### thorough.high (gpt-5.4-pro, effort=high) — 210.1 s

```
Based on your saved notes:

- **HNSW** gives **better recall** than IVFFlat, but costs more in **build time** and **memory** [1][6].
- It uses a **multi-layer graph**, and **insertions are more expensive** because each new vector has to traverse the graph and update neighbor lists [6].
- With **3072-dimensional embeddings** (e.g. Gemini Embedding 2 or OpenAI text-embedding-3-large), **HNSW initialization may exceed memory limits on small Postgres tiers** [1][6].

- **IVFFlat** is **faster to build** than HNSW [6].
- It works by partitioning vectors into **Voronoi cells** and searching only the closest cells to the query [6].
- Its downside is **lower / more tuning-sensitive recall**: results depend heavily on the **`lists`** setting and **probe count** at query time [6].

**Practical takeaway from your setup:** for DevTrail's current scale (low thousands of chunks), you saved that **sequential scan stays well under 100ms/query**, so adding HNSW was avoided because it would likely require **a bigger DB tier or lower embedding dimensions** [5][6]. To make up for the recall gap, you added a **graph layer** that expands retrieval along entity edges [5][6].
```

### Q3 — "Across all my saved material, summarize the embedding-model vs index-type design choices and their tradeoffs."

#### fast (gpt-5.4) — 15.7 s

```
Across your saved material, the main design choice is: **high-dimensional embeddings (3072-dim) improve representation quality, but they make some vector indexes—especially HNSW—more expensive in memory and build cost** [1] [5].

### Embedding model choices
You reference **3072-dimensional embeddings** from:
- **Gemini Embedding 2**
- **OpenAI `text-embedding-3-large`** [1] [5]

These high-dimensional embeddings are strong candidates for retrieval, but on **small Postgres tiers** they create pressure on indexing, especially for HNSW initialization, which "may exceed memory limits" [1] [5].

### Index type choices
Your material mentions three pgvector retrieval modes:
- **Exact sequential scan**
- **IVFFlat**
- **HNSW** [5]

#### 1. Sequential scan
Used in **DevTrail** with **3072-dim Gemini embeddings** and **no HNSW** [5].
Tradeoff:
- **Pros:** simple, no index memory issue, acceptable at current scale
- **Cons:** less scalable as corpus grows

For your current corpus—"**single user, low thousands of chunks**"—sequential scan is said to fit "**well below 100ms per query**" [3] [5].

#### 2. IVFFlat
Tradeoff:
- **Pros:** faster build than HNSW [5]
- **Cons:** lower recall; recall depends heavily on `lists` and probe count [5]

Your notes explicitly say **HNSW gives better recall than IVFFlat**, but IVFFlat is cheaper operationally [1] [5].

#### 3. HNSW
Tradeoff:
- **Pros:** better recall than IVFFlat [1] [5]
- **Cons:** higher build time and memory use [1] [5]

This is the main reason it was avoided for 3072-dim embeddings on small DB tiers: **HNSW init may exceed memory limits** [1] [5].

### Design decision reflected in DevTrail
Your saved material indicates a clear architecture choice:
- Keep **3072-dim Gemini embeddings**
- Use **pgvector sequential scan only**
- Avoid **HNSW**
- Add a **graph layer** (`entities + chunk_entities`, migration 003) to compensate for the recall gap [3] [5]

The graph layer is described as a deliberate alternative to HNSW: instead of improving recall at the vector index layer, retrieval "**expands seed hits along entity edges**," catching semantic matches that cosine similarity alone may miss [3].

### Explicit tradeoff summary
Your materials suggest this decision matrix:

- **Best recall at vector layer:** HNSW
  - but costly in **memory** and **build time**, especially with **3072-dim embeddings** [1] [5]

- **Cheaper approximate search:** IVFFlat
  - but weaker recall and more tuning-sensitive [5]

- **Simplest current fit:** Sequential scan
  - viable because corpus is still small and latency remains under 100ms [3] [5]

- **Preserve high-dim embeddings without HNSW:**
  - use **graph-based retrieval expansion** instead of paying HNSW's infrastructure cost [3] [5]

### Noted workaround options
For small Postgres tiers, the saved material lists these alternatives:
1. **Sequential scan**
2. **Reduce dimensions via PCA at ingest time**
3. **Use IVFFlat instead of HNSW** [5]

### LLM pairing note
One note says the **Anthropic SDK pairs naturally with these embeddings for downstream RAG synthesis** using **Claude Haiku 4.5** or **Claude Opus 4.7** [1]. That concerns generation/synthesis rather than the embedding-vs-index tradeoff itself, but it's part of the overall stack choice.

In short: **your materials favor keeping strong 3072-dim embeddings and avoiding HNSW on small Postgres tiers, accepting sequential scan plus a graph layer as the practical recall/performance tradeoff** [1] [3] [5].
```

#### thorough.medium (gpt-5.4-pro, effort=medium) — 146.2 s

```
Your saved material points to a fairly consistent design:

- **Embedding models in scope:** the notes focus on **3072-dimensional embeddings** from **Gemini Embedding 2** and **OpenAI `text-embedding-3-large`** [1][5].
- **Core tradeoff:** those 3072-d vectors make **HNSW** attractive for recall, but potentially too memory-heavy on small Postgres tiers. The notes explicitly say HNSW initialization may exceed limits on small instances, with **Azure B1ms (2GB)** given as an example [1][5].

### Index-type tradeoffs

- **HNSW**
  - **Pros:** better recall than IVFFlat [1][5]
  - **Cons:** higher build time, higher memory use, and more expensive inserts because each new vector traverses and updates the graph [1][5]

- **IVFFlat**
  - **Pros:** faster to build than HNSW [5]
  - **Cons:** lower / more tunable recall; quality depends heavily on the `lists` setting and query-time probe count [5]

- **Exact sequential scan**
  - **Pros:** simplest option, no HNSW memory pressure, and your notes say it is still fast enough at current scale [5]
  - **Cons:** no ANN index acceleration; it is only presented as acceptable because the corpus is small [5]

### Current design choice in the notes

For **DevTrail**, the chosen setup is:

- **pgvector**
- **3072-dim Gemini embeddings**
- **no HNSW**
- **sequential scan only** [5]

The stated reason is that the current corpus size—**single user, low thousands of chunks**—still fits **well below 100ms per query**, so HNSW is not worth the memory/tier-cost tradeoff right now [3][5].

### What would need to change to use HNSW

Your material says HNSW would likely require one of these tradeoffs:

1. **Upsize the database tier**
2. **Reduce embedding dimensionality** (for example via **PCA at ingest time**) [3][5]

A third fallback mentioned is to use **IVFFlat instead of HNSW** [5].

### How recall is being handled instead

Rather than paying the HNSW cost, the system adds a **graph layer** using `entities` + `chunk_entities` (**migration 003**) to expand retrieval from seed hits along entity edges. The notes say this is meant to catch semantic matches that **vector cosine alone** can miss [3][5].

### Downstream model pairing

Separately from indexing, the notes say the **Anthropic SDK** pairs naturally with these embeddings for RAG synthesis using **Claude Haiku 4.5** or **Claude Opus 4.7** [1].

### Bottom line

The design choice across your material is basically:

- **Keep high-dimensional embeddings (3072-d)**
- **Avoid HNSW on small Postgres tiers**
- **Use sequential scan at current scale**
- **Use a graph expansion layer to recover recall**
- **Treat IVFFlat or dimension reduction as fallback options if scale grows** [1][3][5]

One small ambiguity: the notes say the graph layer compensates for a recall gap "that HNSW would otherwise close" [3], while elsewhere HNSW is mainly compared against **IVFFlat**, and sequential scan is listed separately as an exact option [5].
```

#### thorough.high (gpt-5.4-pro, effort=high) — 239.7 s

```
Across your saved material, the main design axis is **3072-dimensional embeddings vs. pgvector index cost/recall**:

- **Embedding models mentioned:** **Gemini Embedding 2** and **OpenAI text-embedding-3-large**. Your notes do **not** compare their quality or cost directly; they mainly treat them as similar because both are **3072-dimensional**, which is what drives the indexing tradeoffs.[1][5]

- **Index types available in pgvector:** **sequential scan**, **IVFFlat**, and **HNSW**.[5]

- **HNSW tradeoff:** best recall, but higher **build time**, more expensive **insertions**, and much higher **memory** use. With **3072-dim embeddings**, HNSW initialization may exceed memory limits on small Postgres tiers.[1][5]

- **IVFFlat tradeoff:** faster to build than HNSW, but recall depends heavily on tuning (`lists` and query-time probe count), so it is less reliable for recall unless tuned carefully.[5]

- **Sequential scan tradeoff:** no ANN index overhead, and your notes say it is still fine at current scale: **single user, low thousands of chunks, well below 100ms/query**.[3][5]

- **Actual design choice documented:** **DevTrail** uses **3072-dim Gemini embeddings** with **pgvector sequential scan only**—**no HNSW**. The stated reason is that adding HNSW would require either **upsizing the database tier** or **reducing embedding dimensions**, both of which have tradeoffs.[3][5]

- **How recall is recovered without HNSW:** a **graph layer** (`entities` + `chunk_entities`, migration 003) expands seed hits along entity edges, to catch semantic matches that vector cosine alone can miss.[3][5]

- **Fallback/workaround options explicitly listed:**
  1. stay with **sequential scan** at small scale,
  2. **reduce dimensions via PCA** at ingest, or
  3. use **IVFFlat instead of HNSW**.[5]

- **Downstream model pairing noted:** the **Anthropic SDK** is called out as a natural fit for RAG synthesis on top of these embeddings, using **Claude Haiku 4.5** or **Claude Opus 4.7**.[1]

In short: your notes favor **keeping 3072-dim embeddings** and **avoiding HNSW on small Postgres tiers**, using **sequential scan + graph-based retrieval expansion** instead.[3][5]
```

---

## What to compare against in future runs

When re-running this profile (e.g. on gpt-5.5):

1. **Latency:** total_s and synth_s for each cell of the matrix. Expect the same shape (synth dominates total).
2. **Reasoning tokens:** for thorough configs, check `reasoning_tokens` from the server logs. Lower-effort settings (or newer models) should produce fewer reasoning tokens.
3. **Answer length & structure:** drift from the baseline lengths above is fine; large drift in *content* (different facts cited, different conclusions) is signal.
4. **Citation count and accuracy:** all three baseline answers cite within the same reference space (numbered chunks). New runs should still cite — uncited or hallucinated content is a regression.
5. **Failure modes:** thorough.low currently fails on gpt-5.4-pro. Expect this to *succeed* on gpt-5.5 if Microsoft exposes the lower effort tier. If it fails on gpt-5.5 too, log the same HTTP 400 and skip.

Run the script, diff `results.jsonl` and the `*_*.txt` files against this baseline.
