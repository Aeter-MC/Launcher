/**
 * jvm-flags.js
 * Garbage collector and tuning flags for the game, chosen by a preset:
 *   auto - by memory and Java: ZGC on Java 21+ with 8 GB or more, otherwise G1 with Aikar's flags
 *   g1   - G1 with Aikar's flags (the usual choice for Minecraft, works from Java 8)
 *   zgc  - ZGC (generational on Java 21+); on older Java G1 is used instead
 *   none - nothing: only the user's own arguments
 * A GC chosen in the user's own arguments (-XX:+UseXxxGC) wins: two collectors make the JVM refuse to start.
 */

const PRESETS = ['auto', 'g1', 'zgc', 'none'];

// The old default of "Аргументы JVM": now the preset does this, so it is cleared on load (settings-manager.js)
const LEGACY_DEFAULT_ARGS = '-XX:+UseG1GC -Dsun.rmi.dgc.server.gcInterval=2147483646';

/** Aikar's G1 flags (docs.papermc.io/paper/aikars-flags), the large-heap variant from 12 GB. */
function g1Flags(maxRamGb) {
  const big = maxRamGb >= 12;
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${big ? '16M' : '8M'}`,
    `-XX:G1ReservePercent=${big ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1'
  ];
}

function zgcFlags(javaMajor) {
  const flags = ['-XX:+UseZGC', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch'];
  // generational ZGC: opt-in on 21-22, the only mode from 23 (where the flag is deprecated)
  if (javaMajor === 21 || javaMajor === 22) flags.push('-XX:+ZGenerational');
  return flags;
}

/** True when the user's own arguments already pick a collector. */
function hasOwnGc(args) {
  return args.some(a => /^-XX:\+Use\w*GC$/.test(a));
}

/**
 * Flags for a launch. javaMajor: 0 when unknown. Returns { args, gc, note }:
 * gc is 'G1' | 'ZGC' | null for the console line, note explains a fallback.
 */
function gcArgs({ preset = 'auto', javaMajor = 0, maxRamGb = 4, customArgs = [] }) {
  if (!PRESETS.includes(preset)) preset = 'auto';
  if (preset === 'none') return { args: [], gc: null, note: null };
  if (hasOwnGc(customArgs)) return { args: [], gc: null, note: 'own-gc' };

  let pick = preset;
  let note = null;
  if (preset === 'auto') {
    pick = javaMajor >= 21 && maxRamGb >= 8 ? 'zgc' : 'g1';
  } else if (preset === 'zgc' && javaMajor > 0 && javaMajor < 17) {
    // ZGC is production-ready from 15 and stable on Windows from 17; Java 8 has none
    pick = 'g1';
    note = 'zgc-old-java';
  }
  return pick === 'zgc'
    ? { args: zgcFlags(javaMajor), gc: 'ZGC', note }
    : { args: g1Flags(maxRamGb), gc: 'G1', note };
}

module.exports = { PRESETS, LEGACY_DEFAULT_ARGS, gcArgs, g1Flags, zgcFlags };
