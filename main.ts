// csv-speed's driver: the harness runs `node /bot/main.ts` (Node 22). It reads the cases from /input/cases.json,
// answers each with run() from solve.js, and writes /output/answers.json, one answer per case in the cases' order.
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output outside the grader's container.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// GC tuning for a short run that makes millions of small strings: no incremental marking (the rules allow it, as the
// house baseline does), set before solve.js is loaded so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers = new Array(cases.length);
for (let i = 0; i < cases.length; i += 1) answers[i] = run(cases[i].input);
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
