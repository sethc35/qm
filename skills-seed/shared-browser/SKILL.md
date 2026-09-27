---
name: shared-browser
description: Run two or more QM swarm agents concurrently inside one shared browser session, with distinct agent identities and DOM-scoped actions. Use when someone asks multiple agents to co-browse, share one browser, work on the same page, fill different parts of one form at once, or collaborate through computer use. Browserbase is the initial managed-browser provider, with Kernel also supported.
---

# Shared browser

Use this skill when parallel agents must operate one browser, not separate browser sessions.
The coordinator creates one managed browser. Every worker reconnects to that exact Browserbase
session from its own sandbox using only the session id and its injected credential. The bundled extension turns each worker's request
into an actor-scoped DOM operation, so filling different inputs does not depend on one global
mouse or keyboard focus.

Read `skills/browse/SKILL.md` and the selected Browserbase or Kernel provider file first. Their credential,
profile, sign-in, spending, and cleanup rules still apply. This skill changes browser sharing
and input dispatch, not those boundaries.

## Contract

- One prompt may create one shared browser and a swarm of workers.
- All workers reconnect to the same Browserbase session id and resolve its current `connectUrl`
  locally with their injected `BROWSERBASE_API_KEY`.
- The session id may be sent in worker tasks. Never put the CDP URL, provider key, profile name,
  or live-view URL in swarm context or mail.
- Give each worker a stable actor id and disjoint page responsibility.
- Use semantic `fill`, `append`, `click`, `check`, `uncheck`, and `select` actions. These avoid
  global focus and can safely target different elements during overlapping worker turns.
- Actions against one element are deterministic but not simultaneous. Concurrent edits to the
  same text field are last-write-wins; partition that field to one worker.
- Navigation and form submission are single-owner operations. Workers fill; the coordinator
  verifies the combined state and submits only when the user's request authorizes submission.
- A shared session is DM-only when it uses a personal browser profile or signed-in account.

## Start one shared browser

The skill is materialized under `skills/shared-browser`. Start one Browserbase Chromium session:

```bash
mkdir -p /tmp/qm-shared-browser
python3 -c 'import playwright' 2>/dev/null || pip install --quiet playwright
python3 skills/shared-browser/scripts/launch.py start \
  --url '<target URL>' \
  --session /tmp/qm-shared-browser/session.json
```

Add `--use-profile` only in a DM after following the browse skill's profile rules. The command
creates one non-headless browser and writes its secret connection data to a mode-0600 session
file. The actor client injects the bundled Multi runtime into the page and registers it for
future navigations. Kernel is used instead when only `KERNEL_API_KEY` is available; on Kernel,
the same runtime is also loaded as a packaged extension.

Check the shared page before delegation:

```bash
python3 skills/shared-browser/scripts/multi_agent.py \
  --session /tmp/qm-shared-browser/session.json --actor coordinator observe
```

## Spawn workers

Create a swarm with one worker per independent page region. A
request for two agents means `count: 2`; the coordinator is not one of those two workers.
The workers must be real QM swarm sessions created through `/v1/swarm`. Running multiple
shell subprocesses in the coordinator is not agent delegation and does not satisfy the request.
Never substitute subprocesses when a worker has trouble; fix the worker task or report failure.
Each worker task must include:

- an instruction to load this skill before running commands;
- the Browserbase session id printed by `launch.py start`;
- its stable actor id, such as `form-agent-1`;
- the fields or page region it owns;
- an instruction to observe first, act only on its assignment, verify its values, and report.

Each worker resolves the shared session into its own mode-0600 descriptor without receiving a
CDP URL or secret from the coordinator:

```bash
mkdir -p /tmp/qm-shared-browser
python3 -c 'import playwright' 2>/dev/null || pip install --quiet playwright
python3 skills/shared-browser/scripts/launch.py attach \
  --session-id '<shared browser session id>' \
  --session /tmp/qm-shared-browser/session.json
```

Spawn both workers in one call so QM schedules their turns concurrently. Build the request from
the coordinator's session file and give each worker its actor identity and disjoint assignment
through swarm context:

```bash
python3 - <<'PY' | curl -fsS -X POST "$AGENT_API_URL/v1/swarm" \
  -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H 'content-type: application/json' --data-binary @-
import json
import uuid

session = json.load(open('/tmp/qm-shared-browser/session.json'))
task = f'''Load the shared-browser skill before running commands. You are one of exactly two
real QM worker agents collaborating in Browserbase session {session["browserSessionId"]}.
Read your actorId and assignment from your swarm context. Attach to that session with
launch.py attach, observe first, perform only your assigned DOM actions with multi_agent.py,
verify them, and reply to your parent through POST /v1/swarm. Do not navigate, submit, close
the browser, or delegate to shell subprocesses.'''
print(json.dumps({
    'action': 'spawn',
    'requestId': str(uuid.uuid4()),
    'text': task,
    'count': 2,
    'contexts': [
        {'actorId': 'form-agent-1', 'assignment': '<first page region>'},
        {'actorId': 'form-agent-2', 'assignment': '<second page region>'},
    ],
}))
PY
```

Do not perform either worker's assigned actions in the coordinator. Read worker replies with
bounded waits, advancing `after` to the greatest message sequence already seen:

```bash
curl -fsS -H "x-agent-capability: $AGENT_API_TOKEN" \
  "$AGENT_API_URL/v1/swarm?read=1&after=0&waitMs=10000"
```

Inspect `GET /v1/swarm` when a worker needs diagnosis. Success requires two ready worker peers,
two completion replies, and DOM audit records bearing the actor ids assigned in their contexts.

Workers use:

```bash
python3 skills/shared-browser/scripts/multi_agent.py \
  --session /tmp/qm-shared-browser/session.json --actor '<actor id>' observe

python3 skills/shared-browser/scripts/multi_agent.py \
  --session /tmp/qm-shared-browser/session.json --actor '<actor id>' \
  act --ref '<ref from observe>' --kind fill --value '<value>'
```

Supported action kinds are `fill`, `append`, `click`, `check`, `uncheck`, `select`, and
`scroll`. `select` takes the option value. `scroll` ignores `--value`.

Spawn all workers before waiting so their turns overlap. Read both swarm replies, then observe
as `coordinator` and compare every requested value with the live shared DOM. Do not trust worker
claims without this combined verification.

## Google Form release gate

The capability is not accepted until a live QA run passes this scenario:

1. Start one browser on a disposable Google Form containing at least four editable questions.
2. Spawn exactly two workers and give both the same Browserbase session id.
3. Assign disjoint questions to each worker and let both turns run concurrently.
4. Observe the final form from the coordinator and verify all four values together.
5. Verify the live session audit reports action records from both actor ids against one browser
   session id.
6. Submit only if the disposable form was created for this QA or the user explicitly authorized
   submission; otherwise stop with the correctly filled form visible.

A pass requires one browser session, exactly two real QM worker sessions, two distinct actors,
overlapping worker turns, and the correct combined live form state. Coordinator subprocesses,
two separate browsers, sequential worker turns, mocked DOM, or unit tests alone do not pass.

## Audit and cleanup

Inspect the actor audit stored beside the session:

```bash
python3 skills/shared-browser/scripts/multi_agent.py \
  --session /tmp/qm-shared-browser/session.json audit
```

Always delete the managed browser when work and QA are finished:

```bash
python3 skills/shared-browser/scripts/launch.py close \
  --session /tmp/qm-shared-browser/session.json
```
