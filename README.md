# csv-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/GamerJagdish/csv-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/GamerJagdish/csv-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0 that returns exactly the same {columns, rows, errors} for every input, broken rows and all. `fast.js` is a pure-JavaScript byte transducer: it reads cases.json as raw bytes and writes answers.json as raw bytes, never decoding the CSV text into strings, since in the JSON-escaped text only a comma, a backslash escape and the closing quote matter to a CSV reader. A short warm-up gives V8 type feedback for every path before the real input. `solve.js` keeps the same reader over decoded strings, `run(input)`, and answers any case whose text escapes CSV syntax in an unexpected way.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rasj4mqe&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
