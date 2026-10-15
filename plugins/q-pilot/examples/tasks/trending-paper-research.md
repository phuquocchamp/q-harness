/q-pilot task "Survey recent arXiv papers on 'context engineering' and 'agent harness
engineering' (LLM agent scaffolding, tool-use harnesses, context management,
memory/compaction) and report the research landscape to me.

Approach:
- Start at https://arxiv.org/search/?query=%22context+engineering%22&searchtype=all&order=-announced_date_first
  then repeat with: "agent harness", "LLM agent scaffolding", "context window management agents".
- Limit to papers submitted 2025-01-01 or later (use Advanced Search date filter if needed).
- Stop each search when the first page of results is visible. Do not log in or submit anything.

Selecting the top 10 (arXiv has no 'trending' ranking, so be explicit):
- Rank by relevance to the topic + recency; use citation counts only if you actually
  read them from a page (e.g. Semantic Scholar), never guessed.

Truthfulness rules:
- Only list papers you saw on a page in this session. Every entry needs its arXiv ID
  and link. Quote titles exactly. If fewer than 10 relevant papers exist, say so.
- Mark anything inferred (e.g. 'gap', 'trend') as my analysis, not the paper's claim.

Report:
1. Top 10 table: arXiv ID | title | date | one-line contribution | sub-area
2. Clusters/themes (e.g. context compression, memory, tool orchestration, evals)
3. Gaps and under-explored areas = research opportunities, ranked by how crowded each is
4. 2–3 concrete research directions I could start on, each tied to papers above"