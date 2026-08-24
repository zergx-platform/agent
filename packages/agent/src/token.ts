/**
 * Estimated token count — deliberately NOT a real tokenizer. A cheap,
 * deterministic heuristic: CJK chars count as ~1.5 chars/token, everything
 * else ~4 chars/token. Good enough for compaction budget gating.
 */

const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.5) + Math.ceil(other / 4)
}
