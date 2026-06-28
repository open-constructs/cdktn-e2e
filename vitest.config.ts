import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Human output + a machine report consumed by step-summary.mjs / report-issue.mjs.
    reporters: ["default", ["json", { outputFile: "./reports/ci-report.json" }]],
    // Register termless matchers + serializer once for every test file.
    setupFiles: ["./src/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // PTY spawn + a real `cdktn synth`/`deploy` against terraform is slow.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // PTY tests share a sandbox per CLI_ID; keep them serial to avoid
    // interleaved stdin/stdout across concurrently-spawned children.
    fileParallelism: false,
    // Surface which CLI is under test in the run header.
    name: process.env.CLI_ID ?? "cdktn-next",
  },
})
