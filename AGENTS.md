# AGENTS.md

## Project purpose

Build a browser-based audio data transfer system with strong engineering discipline.

Current project direction:
- browser frontend
- direct plug / cable path first
- Chrome-first MVP
- half-duplex communication
- reliability before speed
- long-session correctness matters more than peak throughput

This project is not a demo-tone toy. It is a protocol + DSP + browser-runtime system.

---

## Core principles

- Prefer correctness over cleverness.
- Prefer explicit state over hidden behavior.
- Prefer deterministic tests over manual guesswork.
- Prefer conservative defaults over optimistic tuning.
- Prefer boring reliable transport over fragile high-speed transport.
- Fail explicitly. Never silently accept corrupted or ambiguous state.
- Preserve protocol compatibility unless a task explicitly changes the spec.

---

## Source of truth

When working on the project, follow this priority order:

1. `mvp.md` — product and protocol contract for MVP
2. `mvp_roadmap.md` — milestone order and validation shape
3. `todo.md` — current implementation sequence
4. code and tests

If code and docs disagree, do not invent a hybrid. Update code or docs so they match.

---

## Non-negotiable rules

- Treat the documented wire protocol as a contract.
- Do not casually change:
  - frame layouts
  - field meanings
  - CRC semantics
  - ACK bitmap semantics
  - state-machine rules
  - turn ownership rules
  - file completion rules
  - save-after-success-only behavior
- Do not trade reliability for speed without explicit approval.
- Do not expand scope while the current milestone is incomplete.
- Do not add new profiles or advanced modes before the baseline path is proven.
- Do not accept silent corruption under any circumstances.

---

## Engineering style

### Protocol and state
- Use explicit finite-state machines for sender and receiver.
- Encode failure paths deliberately.
- Reject malformed input deterministically.
- Treat duplicates, retries, timeouts, and cancellation as first-class behavior, not edge cases.

### Browser runtime
- Design for real browser constraints, not idealized audio pipelines.
- Inspect actual applied audio settings rather than assuming requested settings were honored.
- Keep audio hot paths small and predictable.
- Keep browser-specific behavior visible in diagnostics.

### DSP and transport
- Separate:
  - browser I/O
  - DSP / modulation / demodulation
  - framing / protocol
  - session control
  - UI / diagnostics
- Do not let transport logic leak into DSP code.
- Do not let UI decisions drive protocol behavior.

### Reliability
- Every integrity or recovery rule must be testable.
- Long sessions matter; drift, retries, and state recovery are part of the real design.
- A slower mode that completes reliably is better than a faster mode that fails unpredictably.

---

## Allowed autonomous decisions

The agent may decide on its own:

- file/module organization
- internal type names
- helper functions and abstractions
- logging structure
- test file structure
- worker/worklet boundaries
- local refactors
- conservative implementation details that do not change the external contract
- cleanup of dead or redundant code

These decisions should improve clarity, maintainability, or testability.

---

## Decisions that require explicit spec updates

The agent must not change these silently:

- wire format
- CRC definition
- session flow
- half-duplex rules
- ACK bitmap meaning
- frame success/failure rules
- file size limits
- output-save rules
- supported browser/runtime assumptions for MVP
- any milestone exit criteria that affect project scope

If such a change becomes necessary, update the relevant `.md` files in the same patch and explain why.

---

## Testing expectations

Always prefer tests that prove behavior over comments that merely describe intent.

### Minimum expectations
- Add or update tests when changing protocol logic.
- Add or update tests when changing state-machine behavior.
- Add or update tests when changing parsing, validation, or CRC logic.
- Keep malformed-input tests.
- Keep duplicate/retry/timeout tests.
- Keep deterministic golden vectors for stable binary formats.

### Good testing priorities
1. pure encode/decode tests
2. state-machine tests
3. simulated transfer-flow tests
4. live-path tests
5. long-session reliability tests

Do not rely on manual browser clicking as the main proof of correctness.

---

## Diagnostics expectations

Diagnostics are part of the product, not optional polish.

Expose enough information to debug real failures, especially:
- actual audio settings
- actual sample rate
- current state
- session ID
- selected profile/mode
- retransmissions
- CRC failures
- timeouts
- elapsed time
- effective throughput
- last failure or cancel reason

Do not hide failure causes behind generic UI messages.

---

## Documentation discipline

When implementation meaningfully changes behavior:
- update the relevant spec doc
- update tests
- keep terminology consistent

Avoid drift between:
- code names
- protocol names
- UI names
- documentation names

If a value is provisional, label it as provisional.

---

## Scope control

When unsure whether something belongs in MVP, bias toward excluding it.

Things that usually do **not** belong in MVP unless explicitly required:
- performance optimization for its own sake
- extra profiles before baseline validation
- advanced visualization
- resume/recovery after page refresh
- broad browser compatibility work
- installability / packaging polish
- speculative abstractions for future transport modes

---

## Preferred workflow

For each task:
1. understand the current milestone
2. make the smallest high-confidence change that moves it forward
3. update tests
4. run relevant checks
5. update docs if behavior changed
6. leave the codebase clearer than before

Do not perform broad refactors while the protocol path is still unstable unless the refactor is required to unblock correctness.

---

## When blocked

If blocked by ambiguity:
- stop
- identify the ambiguity clearly
- do not invent protocol law
- propose the smallest explicit decision needed

If blocked by failing reliability:
- reduce complexity
- return to the simplest reproducible case
- prove one smaller step before expanding scope

---

## Project quality bar

A change is good if it makes the system:
- more correct
- more testable
- more diagnosable
- more deterministic
- easier to reason about

A change is bad if it makes the system:
- more magical
- more implicit
- harder to test
- more coupled
- faster only in theory

---

## Practical bias

This project should behave like an engineered transport system, not an impressive demo.

If forced to choose, prefer:
- one stable mode over three unstable ones
- explicit recovery over optimistic assumptions
- simple protocol behavior over fancy waveform tricks
- measured results over aesthetic confidence


---

## Hard verification gate (mandatory)

Before claiming success on any protocol, runtime, PHY, diagnostics, browser shell, or test-infrastructure change:
1. run the strongest required verification command,
2. inspect failures,
3. fix failures,
4. rerun until green (or explicitly report still-failing commands and why),
5. state what remains unverified on real cable/hardware runtime.

Never report reasoned-but-unrun success.

If a bug class is missing a deterministic test, add the smallest deterministic reproducer before claiming the fix.

## Verification command routing (mandatory)

- Changes under `packages/contract`, `packages/crc`, or `packages/protocol`:
  - run `pnpm verify:protocol`.
- Changes under `packages/phy-safe`, browser audio/runtime plumbing, or session runtime bridge code:
  - run `pnpm verify:runtime`.
- Changes under `apps/*` or any cross-layer runtime + PHY/session path:
  - run `pnpm verify:mvp`.

When unsure, run `pnpm verify:mvp`.

## Required implementation summary shape

Every completion summary must explicitly list:
1. files changed,
2. tests added or updated,
3. exact verification commands run,
4. exact pass/fail status for each command,
5. what remains unverified in real browser/cable runtime.
