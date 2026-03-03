import * as core from '@actions/core'
import * as github from '@actions/github'

interface RefinedItem {
  problem?: string
  acceptanceCriteria?: string[]
  assumptions?: string[]
  estimate?: string
  priority?: string
  tags?: string[]
}

interface ScoreItem {
  completeness_score?: number
  agent_ready?: boolean
}

interface RefineResponse {
  items: RefinedItem[]
  scores?: ScoreItem[]
}

interface RewriteResponse {
  original?: string
  rewritten?: string
  changes?: string[]
  new_score?: number
  tier?: string
  preview?: string
  upgrade_message?: string
  upgrade_url?: string
}

async function run() {
  const apiKey = core.getInput('api-key', { required: true })
  const threshold = parseInt(core.getInput('threshold') || '70')
  const baseUrl = core.getInput('base-url') || 'https://speclint.ai'

  const context = github.context
  const issue = context.payload.issue

  if (!issue) {
    core.info('No issue found in context, skipping')
    return
  }

  const issueText = `${issue.title}\n\n${issue.body || ''}`

  // ── Step 1: Call Speclint lint API ────────────────────────────────────────
  const response = await fetch(`${baseUrl}/api/lint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-license-key': apiKey,
      'x-source': 'github-action',
    },
    body: JSON.stringify({ items: [issueText] }),
  })

  if (!response.ok) {
    const error = await response.text()
    core.setFailed(`Speclint API error: ${response.status} — ${error}`)
    return
  }

  const data = await response.json() as RefineResponse
  const refined = data.items[0]
  const score = data.scores?.[0]
  const completenessScore = score?.completeness_score ?? 0
  const agentReady = completenessScore >= threshold

  // ── Step 2: Post the lint/score comment (unchanged) ───────────────────────
  const scoreComment = buildScoreComment(refined, score, threshold)
  const octokit = github.getOctokit(process.env.GITHUB_TOKEN!)

  await octokit.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issue.number,
    body: scoreComment,
  })
  core.info(`✅ Score comment posted (${completenessScore}/100)`)

  // ── Step 3: Add labels ────────────────────────────────────────────────────
  const labelToAdd = agentReady ? 'agent_ready' : 'needs-refinement'
  try {
    await octokit.rest.issues.addLabels({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      labels: [labelToAdd],
    })
  } catch {
    core.warning('Could not add label — ensure the label exists in your repo')
  }

  // ── Step 4: Post rewrite diff comment (second comment, paid tiers only) ───
  const assumptions = refined?.assumptions ?? []

  // Only call rewrite if there are gaps to address
  if (assumptions.length > 0) {
    try {
      const diffComment = await buildRewriteDiffComment(
        issueText,
        assumptions,
        completenessScore,
        agentReady,
        apiKey,
        baseUrl
      )

      if (diffComment) {
        await octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: issue.number,
          body: diffComment,
        })
        core.info('✅ Rewrite diff comment posted')
      }
    } catch (err) {
      // Rewrite is best-effort — never block the main flow
      core.warning(`Rewrite step failed (non-fatal): ${(err as Error).message}`)
    }
  } else {
    core.info('ℹ️ No assumptions/gaps found — skipping rewrite suggestion')
  }

  // ── Step 5: Set outputs ───────────────────────────────────────────────────
  core.setOutput('completeness-score', String(completenessScore))
  core.setOutput('agent-ready', String(agentReady))
  core.info(`✅ Speclint complete. Score: ${completenessScore}/100. Agent ready: ${agentReady}`)
}

/**
 * Calls the Speclint /api/rewrite endpoint and returns a formatted diff comment,
 * or null if the rewrite is unavailable (free tier, rate limit, network error).
 */
async function buildRewriteDiffComment(
  originalText: string,
  gaps: string[],
  score: number,
  agentReady: boolean,
  apiKey: string,
  baseUrl: string
): Promise<string | null> {
  let rewriteResponse: Response

  try {
    rewriteResponse = await fetch(`${baseUrl}/api/rewrite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-license-key': apiKey,
        'x-source': 'github-action',
      },
      body: JSON.stringify({ spec: originalText, gaps, score }),
    })
  } catch (err) {
    core.info(`Rewrite API unreachable: ${(err as Error).message} — skipping diff comment`)
    return null
  }

  // Free tier rate limit (429) or unauthorized (403) → skip silently, no error shown to users
  if (rewriteResponse.status === 429 || rewriteResponse.status === 403) {
    core.info(`Rewrite API: ${rewriteResponse.status} response — free tier or rate limit, skipping diff comment`)
    return null
  }

  if (!rewriteResponse.ok) {
    core.warning(`Rewrite API returned ${rewriteResponse.status} — skipping diff comment`)
    return null
  }

  let rewriteData: RewriteResponse
  try {
    rewriteData = await rewriteResponse.json() as RewriteResponse
  } catch {
    core.warning('Rewrite API response could not be parsed — skipping diff comment')
    return null
  }

  // Free tier returns a preview-only response — skip the diff, no error shown
  if (rewriteData.tier === 'free' || !rewriteData.rewritten) {
    core.info('Rewrite API: free tier preview only — skipping diff comment')
    return null
  }

  const { rewritten, changes = [], new_score } = rewriteData

  // Build diff block: original lines prefixed with `-`, rewritten with `+`
  const originalLines = originalText
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.length > 0)

  const rewrittenLines = rewritten
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.length > 0)

  const diffLines: string[] = [
    ...originalLines.map(l => `- ${l}`),
    '',
    ...rewrittenLines.map(l => `+ ${l}`),
  ]

  const statusIcon = agentReady ? '✅ Agent-Ready' : '⚠️ Needs Work'
  const scoreHeader = `🔍 Speclint Score: ${score}/100 ${statusIcon}`
  const newScoreLine = new_score !== undefined
    ? `\n**Score after rewrite:** ${new_score}/100\n`
    : ''
  const changesSection = changes.length > 0
    ? `\n**Changes made:**\n${changes.map((c: string) => `- ${c}`).join('\n')}\n`
    : ''

  return `## ${scoreHeader}

<details>
<summary>📝 Rewrite Suggestion — click to expand</summary>

\`\`\`diff
${diffLines.join('\n')}
\`\`\`
${changesSection}${newScoreLine}
</details>

<sub>Rewrite suggestions powered by [Speclint](https://speclint.ai) — [upgrade for full rewrites](https://speclint.ai/pricing)</sub>`
}

/**
 * Builds the primary lint/score comment (unchanged from original implementation).
 */
function buildScoreComment(refined: RefinedItem, score: ScoreItem | undefined, threshold: number): string {
  const completenessScore = score?.completeness_score ?? 0
  const agentReady = completenessScore >= threshold
  const filled = Math.round(completenessScore / 10)
  const scoreBar = '█'.repeat(filled) + '░'.repeat(10 - filled)

  const acs = refined?.acceptanceCriteria ?? []
  const assumptions = refined?.assumptions ?? []
  const tags = refined?.tags ?? []

  return `## 🔍 Speclint Analysis

**Completeness Score:** ${completenessScore}/100 ${agentReady ? '✅ Agent Ready' : '⚠️ Needs Refinement'}
\`${scoreBar}\`

---

### 📋 Refined Spec

**Problem:** ${refined?.problem ?? '—'}

**Acceptance Criteria:**
${acs.map((ac: string) => `- [ ] ${ac}`).join('\n')}

${assumptions.length > 0 ? `**Assumptions to Clarify:**\n${assumptions.map((a: string) => `- ❓ ${a}`).join('\n')}\n` : ''}
**Estimate:** ${refined?.estimate ?? '—'} | **Priority:** ${refined?.priority ?? '—'}
**Tags:** ${tags.map((t: string) => `\`${t}\``).join(' ')}

---
<sub>Powered by [Speclint](https://speclint.ai) — lint your specs before agents touch them</sub>`
}

run().catch(core.setFailed)
