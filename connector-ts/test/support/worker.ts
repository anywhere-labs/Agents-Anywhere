/** Options for starting a worker that runs TypeScript sources directly (tests only). */
export const TS_WORKER_EXEC_ARGV = [
  '--experimental-transform-types',
  '--disable-warning=ExperimentalWarning',
  '--import',
  new URL('./ts-resolve.mjs', import.meta.url).href,
]
