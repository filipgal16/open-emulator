# External review of the 60 FPS plan

The plan ([60fps-plan.md](60fps-plan.md)) is to be reviewed by the Cursor CLI running the **Grok 4.7**
model before anything is implemented. If Claude disagrees with any suggestion, a **second, fresh**
Cursor session arbitrates between the two versions.

This couldn't run in the cloud session that wrote the plan. Its network policy denies
`cursor.com`, `downloads.cursor.com`, `api2.cursor.sh` and `api.cursor.com`, and no Cursor key was
configured. It runs from the local Windows session instead.

## Setup (once)

1. Install the Cursor CLI (see cursor.com/cli; on Windows it can also run inside WSL) and sign in,
   or set `CURSOR_API_KEY`.
2. List the models your CLI offers (`cursor-agent models`, or see `cursor-agent --help` if your version
   differs) and note the exact id of the Grok 4.7 entry. Below it's `$MODEL`.
   **If no Grok 4.7 model is listed, stop and tell the user** rather than substituting another one.
3. Run from a clean checkout of the branch holding the plan, so the reviewer reads the same code the
   plan cites.

## Round 1: review and suggestions

```bash
cursor-agent -p --model "$MODEL" --output-format text "$(cat <<'EOF'
You are reviewing an engineering plan. Do not edit, create or delete any files; reply only.

Read docs/60fps-plan.md in this repository, and the code it cites (desktop/src/main/engine/,
desktop/src/renderer/components/GuestSurface.tsx, desktop/src/renderer/hooks/useGuestScreen.ts,
desktop/src/main/engine/window-embed.ts). If the Android SDK is installed, the emulator's own gRPC
definitions are in <sdk>/emulator/lib/emulator_controller.proto.

Goal: the Android guest must be shown in the Electron app at a smooth 60 fps (targets in section 1),
on Windows, on a Ryzen 7 6800H laptop and a 4-core Intel U-series laptop.

1. Verify: list any factual claim in the plan that is wrong or unsupported by the code or the proto,
   quoting the plan's sentence and the evidence.
2. Challenge the decision in section 4 (option B primary, A fallback). Argue for a different choice
   if you think it is better, with reasons specific to this codebase.
3. Suggest concrete changes: missing phases, risks, measurements or simpler routes to the targets.
   Number each suggestion and say how important it is (blocking / important / minor).
Be specific and concise. No general advice.
EOF
)" > review-round1.md
```

## Evaluating round 1 (Claude)

For each numbered suggestion, record **accept**, **accept with changes** or **reject**, each with a
reason grounded in code or a measurement. Put this in a table appended to this file. Update the plan
with the accepted ones and bump its status to "reviewed (round 1)".

## Round 2: arbitration, only if anything was rejected

A **new** session, not `--resume`, so it has no stake in either version:

```bash
cursor-agent -p --model "$MODEL" --output-format text "$(cat <<'EOF'
You are an impartial arbiter. Do not edit any files; reply only.

Two versions of one engineering plan disagree on the points listed in docs/60fps-plan-review.md
under "Disputed points". Version 1 is the plan with the reviewer's suggestions applied as written.
Version 2 is docs/60fps-plan.md as it stands. The reviewer's original text is in review-round1.md.

For each disputed point: say which version is better for reaching a smooth 60 fps on the two
laptops described in section 1 of the plan, and why, citing the code or the emulator proto where
possible. Then give one overall verdict. Keep it under 600 words.
EOF
)" > review-round2.md
```

Apply the verdict. If it sides with Claude, note why and keep it. If it doesn't, adopt Version 1 on
that point. Record the outcome here and set the plan's status to "final".

## Record

| Round | Date | Model id | Outcome |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
