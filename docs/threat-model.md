# Threat model

SquadFlow ships as a **local-first, single-operator** application. The default
profile binds to `127.0.0.1` and has no authentication layer: `server/middleware/auth-stub.ts`
returns a fixed local administrator and the role guards are pass-throughs. That is a
deliberate scope decision, not an incomplete implementation — see
"Deploying beyond localhost" below before exposing the service to a network.

## Threat 1 — Indirect prompt injection through retrieved content

Repository files and RAG chunks are untrusted input that reaches the model as
reference material. The defense is layered.

**Structural boundary (primary).** `server/services/retrieval-guardrail.ts` wraps every
retrieved chunk in a `<retrieved_document>` envelope and states the instruction
hierarchy `system > user > retrieved-data`, so recovered content is data and never a
command. Applied in `server/services/refinement-rag.ts` and
`server/services/context-builder.ts`.

**Pattern screening.** `screenChunk()` runs a deterministic detector over each chunk
before injection and marks anything suspicious so the model is told to ignore it.

**Semantic classification.** `server/services/semantic-injection-classifier.ts` adds a
model-based second opinion for what patterns miss. It fails open by design: a
classifier outage must not block legitimate work.

**Blast radius.** Most registered agent tools are read-only. The tools that write —
including `register_tech_debt_item`, which writes to the filesystem — are gated by
`AGENT_TOOLS_ENABLED` and the per-agent flags, with a global kill switch in
`server/services/agent-tools-registry.ts`. An injection that survives every layer
distorts a generated document rather than performing a privileged action.

**Regression gate.** `server/evaluation/evaluate-guardrails.ts` runs in CI against a
fixed corpus and fails when detection regresses below the recorded floor.

## Threat 2 — Exposing the local profile to a network

The auth stub grants administrative access to every request. Bound to loopback that is
irrelevant; reachable from a network it means anyone who reaches the port is an operator.

Two controls exist, and both matter only for non-loopback binds:

- `server/middleware/admin-fail-closed.ts` requires `ADMIN_API_KEY` on administrative
  prefixes and fails closed before the listening callback resolves.
- `server/middleware/rate-limiter.ts` applies a per-IP window to the endpoints that
  trigger model calls, limiting cost amplification.

Neither control substitutes for a real perimeter. They reduce the damage of an
accidental exposure; they are not an authorization model.

## Deploying beyond localhost

`npm start` sets `NODE_ENV=production`, and the default host in that mode is `0.0.0.0`.
Set `HOST=127.0.0.1` explicitly, or place the service behind an authenticating proxy.

Before any non-loopback bind:

1. Replace every secret in `.env` with a generated value. The values shipped in
   `.env.example` are rejected at startup precisely because they are published here.
2. Put an authenticating proxy in front of the service, or accept that any client
   that reaches the port acts as the operator.
3. Review which routes you actually need to expose. `/metrics` and `/api-docs` are
   served without a gate.

## Deliberately out of scope

| Item                   | Reason                             | Revisit when                   |
| ---------------------- | ---------------------------------- | ------------------------------ |
| Full RBAC              | No tenants; one operator           | The product becomes multi-user |
| Tenant isolation       | No tenants                         | The product becomes multi-user |
| Content moderation     | No public user-generated content   | Public input is accepted       |
| Per-tool authorization | Per-agent flags cover one operator | Multiple operators exist       |

## Reporting

Report suspected vulnerabilities through the process in [`SECURITY.md`](../SECURITY.md).
Do not open a public issue containing exploit details.
