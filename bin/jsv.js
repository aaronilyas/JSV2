#!/usr/bin/env node
import { main } from "../dist/cli.js";

Promise.resolve(main(process.argv.slice(2))).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
);
