import { runKernelReview } from '../dist/src/kernel-review-runtime.js';
try {
  const result = await runKernelReview(JSON.parse(process.argv[2]));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'blocked') process.exitCode = 1;
} catch (error) {
  // No provider stderr, environment values, auth data, or full prompt in MCP output.
  process.stdout.write(JSON.stringify({ status: 'blocked', reason: error?.code === 'ENOENT' ? 'review_dependency_missing' : 'review_execution_failed', detail: error?.message?.match(/^[a-z_]+$/)?.[0] ?? 'Inspect Kernel review state and existing process; do not retry uncertain execution' }) + '\n');
  process.exitCode = 1;
}
