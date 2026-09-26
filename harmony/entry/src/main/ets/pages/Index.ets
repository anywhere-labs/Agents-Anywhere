import { AgentsAnywhereApp } from '../app/AgentsAnywhereApp';

/**
 * The single page of the entry ability.
 *
 * Everything above this file is composition; the shell draws itself from the
 * current destination, so this page stays a one-line mount point wrapped in a
 * container, which an `@Entry` build method requires.
 */
@Entry
@Component
struct Index {
  build() {
    Column() {
      AgentsAnywhereApp()
    }
    .width('100%')
    .height('100%')
  }
}
