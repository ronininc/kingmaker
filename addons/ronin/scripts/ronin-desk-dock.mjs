#!/usr/bin/env node
import { runRoninDeskDock } from '../ronin-desk-dock.mjs';

runRoninDeskDock(process.argv.slice(2)).catch((error) => {
  console.error(`Ronin desk dock: ${error.message}`);
  process.exitCode = 1;
});
