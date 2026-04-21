#!/usr/bin/env node

// Mock BMAD runner for MVP.
// Emits logs gradually and prints a final JSON output prefixed with [output]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const provider = process.env.BMAD_PROVIDER || "openai";
  const model = process.env.BMAD_MODEL || "gpt-4o-mini";
  const hasKey = Boolean(process.env.BMAD_API_KEY);

  let input = {};
  try {
    input = JSON.parse(process.env.BMAD_INPUT || "{}");
  } catch {
    input = { raw: process.env.BMAD_INPUT };
  }

  console.log(`[bmad] starting workflow`);
  await sleep(250);
  console.log(`[bmad] provider=${provider} model=${model} apiKey=${hasKey ? "present" : "missing"}`);
  await sleep(300);
  console.log(`[bmad] preparing sandbox…`);
  await sleep(400);
  console.log(`[bmad] fetching workflow bundle…`);
  await sleep(500);
  console.log(`[bmad] running steps:`);
  await sleep(300);

  const steps = [
    "validate input",
    "plan",
    "execute",
    "summarize",
    "format output"
  ];

  for (let i = 0; i < steps.length; i++) {
    console.log(`[bmad] step ${i + 1}/${steps.length}: ${steps[i]}…`);
    await sleep(450);
  }

  console.log(`[bmad] done`);

  const output = {
    ok: true,
    provider,
    model,
    receivedInput: input,
    result: {
      message: "BMAD run completed (mock). Replace BMAD_COMMAND to run real BMAD.",
      artifacts: [
        { name: "summary.txt", content: "This is a mock output." }
      ]
    }
  };

  // Important: backend parses lines prefixed with [output]
  console.log(`[output] ${JSON.stringify(output)}`);
}

main().catch((err) => {
  console.error(`[bmad] error: ${String(err?.message || err)}`);
  process.exit(1);
});
